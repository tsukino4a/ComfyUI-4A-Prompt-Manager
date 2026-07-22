import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { configureComfyI18n, pm4aFetch, t } from "./i18n.js?v=3";
import { ADD_PROMPT_ICON, openPromptLibraryModal } from "./prompt_library_modal.js";
import { attachAutocompletePlus } from "./autocomplete_plus_attach.js?v=1";
import { withSyncedDomWidth } from "./dom_widget_layout.js";
import {
  TARGET_LORA_PROPERTY,
  findLoraLoaderTarget,
  loraLoaderNodes,
  mergeLoraAppendText,
  readLoraLoaderText,
  writeLoraLoaderText,
} from "./meta_apply_core.js?v=1";

const NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)";
const TRACK_INPUT_PREFIX = "pm4a_track_";
const INTERNAL_INPUT_NAMES = new Set(["config_json", "execution_index", "run_id"]);
const INTERNAL_INPUT_TYPE = "PM4A_INTERNAL";
const TRACK_INPUT_TEXTAREA_X_OFFSET = 1;
const TRACK_INPUT_TEXTAREA_Y_OFFSET = 1;
const WEB_SLOTS = new Set(["quality", "character", "action", "scene", "negative"]);
const uid = () => globalThis.crypto?.randomUUID?.() || `track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const FIXED_TRACK_NAMES = Object.freeze({
  quality: "质量",
  character: "角色",
  action: "动作",
  scene: "场景",
});
const MODE_ICONS = Object.freeze({
  sequence: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h13l-2.5-2.5M17 7l-2.5 2.5M20 17H7l2.5 2.5M7 17l2.5-2.5"/></svg>',
  random: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3c4.5 0 5.5 10 10 10h3M17 14l3 3-3 3M4 17h3c1.7 0 2.8-1.4 3.8-3.2M13.2 10.2C14.2 8.4 15.3 7 17 7h3M17 4l3 3-3 3"/></svg>',
});
const COLLAPSE_ICONS = Object.freeze({
  expanded: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg>',
  collapsed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 5 5-5 5"/></svg>',
});
const BYPASS_ICONS = Object.freeze({
  enabled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h11M5 17h8"/></svg>',
  bypassed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h11M5 17h8M4 4l16 16"/></svg>',
});

function trackInputName(trackId) {
  const bytes = new TextEncoder().encode(String(trackId));
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return `${TRACK_INPUT_PREFIX}${encoded}`;
}

function defaultTrack(id, name) {
  return {
    id,
    name,
    enabled: true,
    text: "",
    mode: "sequence",
    collapsed: false,
    ui_height: null,
  };
}

function defaultConfig() {
  return {
    start_index: 0,
    task_count: 1,
    negative: "",
    negative_collapsed: false,
    lora_append: false,
    lora_group_same: false,
    tracks: [
      defaultTrack("quality", "质量"),
      defaultTrack("character", "角色"),
      defaultTrack("action", "动作"),
      defaultTrack("scene", "场景"),
    ],
  };
}

function normalizeConfig(value) {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw || "{}");
    } catch (_) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object") raw = {};
  const fallback = defaultConfig();
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : fallback.tracks;
  const normalizedTracks = tracks.map((track, index) => {
    const id = String(track?.id || uid());
    const text = typeof track?.text === "string" ? track.text : "";
    return {
      id,
      name: FIXED_TRACK_NAMES[id] || String(track?.name || `栏目 ${index + 1}`),
      enabled: track?.enabled !== false,
      text,
      mode: track?.mode === "random" || track?.mode === "shuffle" ? "random" : "sequence",
      collapsed: Boolean(track?.collapsed),
      ui_height: Number.isFinite(Number(track?.ui_height))
        ? Math.max(54, Math.min(1200, Math.round(Number(track.ui_height))))
        : null,
    };
  });
  for (const [id, name] of Object.entries(FIXED_TRACK_NAMES)) {
    if (!normalizedTracks.some((track) => track.id === id)) normalizedTracks.push(defaultTrack(id, name));
  }
  return {
    start_index: Math.max(0, Number.parseInt(raw.start_index ?? 0, 10) || 0),
    task_count: Math.max(1, Number.parseInt(raw.task_count ?? 1, 10) || 1),
    negative: typeof raw.negative === "string" ? raw.negative : "",
    negative_collapsed: Boolean(raw.negative_collapsed),
    negative_ui_height: Number.isFinite(Number(raw.negative_ui_height))
      ? Math.max(58, Math.min(1200, Math.round(Number(raw.negative_ui_height))))
      : null,
    lora_append: Boolean(raw.lora_append),
    lora_group_same: Boolean(raw.lora_group_same),
    tracks: normalizedTracks,
  };
}

function seedWidgetValue(node) {
  const widget = node.widgets?.find((candidate) => candidate?.name === "seed");
  const value = Number(widget?.value);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Prefer the live seed from a linked upstream node; fall back to the local widget. */
function resolveSchedulerSeed(node) {
  const graph = node?.graph || app.graph;
  const seedInput = node?.inputs?.find((input) => input?.name === "seed");
  const linkId = seedInput?.link;
  if (linkId !== null && linkId !== undefined && graph) {
    const link = graph.links?.[linkId] || graph._links?.[linkId];
    const originId = link?.origin_id;
    const origin = originId == null
      ? null
      : graph.getNodeById?.(originId) || graph.getNodeById?.(Number(originId));
    if (origin) {
      const outputName = origin.outputs?.[link.origin_slot]?.name;
      const widget = origin.widgets?.find((candidate) => candidate?.name === "seed")
        || (outputName
          ? origin.widgets?.find((candidate) => candidate?.name === outputName)
          : null);
      const value = Number(widget?.value);
      if (Number.isFinite(value)) return Math.trunc(value);
    }
  }
  return seedWidgetValue(node);
}

function findSchedulerNodes() {
  const results = [];
  const visit = (graph) => {
    for (const node of graph?._nodes || graph?.nodes || []) {
      if (!node) continue;
      if (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS) results.push(node);
      if (node.subgraph) visit(node.subgraph);
    }
  };
  visit(app.graph);
  return results;
}

function pickTargetNodes(payload) {
  const explicit = payload?.node_ids;
  const all = findSchedulerNodes();
  if (Array.isArray(explicit) && explicit.length) {
    const wanted = new Set(explicit.map((entry) => String(entry?.node_id ?? entry)));
    return all.filter((node) => wanted.has(String(node.id)));
  }
  if (!all.length) return [];
  const selectedSource = app.canvas?.selected_nodes;
  const selected = (selectedSource instanceof Map
    ? [...selectedSource.values()]
    : Object.values(selectedSource || {})
  ).filter((node) => node && (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS));
  if (selected.length) return selected;
  if (all.length === 1) return all;
  return [all.reduce((left, right) => Number(left.id) >= Number(right.id) ? left : right)];
}

function injectStyles() {
  if (document.getElementById("pm4a-scheduler-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-scheduler-styles";
  style.textContent = `
    .pm4a-scheduler { position:relative; width:100%; height:100%; min-height:0; display:flex; flex-direction:column; gap:8px; padding:0 4px 2px; box-sizing:border-box; overflow:hidden; color:#e8e8e8; background:transparent; border:0; border-radius:0; font:12px/1.35 system-ui,sans-serif; }
    .pm4a-scheduler * { box-sizing:border-box; }
    .pm4a-scheduler input, .pm4a-scheduler textarea, .pm4a-scheduler select { width:100%; color:#eee; background:#151719; border:1px solid #4b4f55; border-radius:4px; padding:5px 7px; font:inherit; }
    .pm4a-scheduler textarea { min-height:58px; resize:vertical; }
    .pm4a-scheduler button { color:#eee; background:#34383d; border:1px solid #555b62; border-radius:4px; padding:5px 8px; cursor:pointer; font:inherit; }
    .pm4a-scheduler button:hover { filter:brightness(1.15); }
    .pm4a-scheduler button:disabled { opacity:.5; cursor:not-allowed; }
    .pm4a-scheduler-controls { display:grid; grid-template-columns:104px 104px auto auto; gap:8px; align-items:end; justify-content:start; }
    .pm4a-scheduler-controls .pm4a-scheduler-field { min-width:0; }
    .pm4a-scheduler-controls input, .pm4a-scheduler-controls button { height:32px; min-height:32px; }
    .pm4a-scheduler-field { display:flex; flex-direction:column; gap:3px; color:#aeb4bb; }
    .pm4a-scheduler-run { background:#285f38 !important; border-color:#4b9a61 !important; font-weight:700 !important; }
    .pm4a-scheduler-lora-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-top:2px; }
    .pm4a-scheduler-lora-toggle { display:inline-flex; align-items:center; gap:6px; color:#aeb4bb; cursor:pointer; user-select:none; }
    .pm4a-scheduler-lora-toggle input { width:auto; margin:0; }
    .pm4a-scheduler-lora-toggle.disabled { opacity:.45; cursor:not-allowed; text-decoration:line-through; }
    .pm4a-scheduler-lora-toggle.disabled input { cursor:not-allowed; }
    .pm4a-scheduler-lora-target { flex:1; min-width:140px; max-width:260px; height:28px; }
    .pm4a-track-list { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:7px; padding-right:3px; scrollbar-width:thin; }
    .pm4a-track { flex:0 0 auto; border:1px solid #486b48; border-radius:6px; background:#353; overflow:hidden; }
    .pm4a-track-header { display:flex; align-items:center; gap:2px; min-height:28px; padding:2px 4px; background:#232; }
    .pm4a-track-title { flex:1; min-width:60px; display:flex; align-items:center; gap:2px; padding-left:0; }
    .pm4a-track-title-text { min-width:0; overflow:hidden; color:#c5d2c5; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    .pm4a-track-title-editor { height:24px; min-width:80px; padding:2px 5px !important; }
    .pm4a-track-edit-name { width:18px; height:20px; padding:0 !important; border:0 !important; background:transparent !important; color:#aeb4bb !important; font-size:14px !important; line-height:1; }
    .pm4a-collapse-button { width:20px; height:20px; flex:0 0 20px; padding:0 !important; display:grid; place-items:center; border:0 !important; background:transparent !important; color:#b9bec4 !important; }
    .pm4a-collapse-button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .pm4a-track-mode-button { width:22px; height:22px; flex:0 0 22px; padding:0 !important; display:grid; place-items:center; border:0 !important; background:transparent !important; }
    .pm4a-track-mode-button:hover { background:#3b4046 !important; }
    .pm4a-track-library-button { width:22px; height:22px; flex:0 0 22px; padding:0 !important; display:grid; place-items:center; border:0 !important; background:transparent !important; color:#c5c9ce !important; }
    .pm4a-track-library-button:hover { background:#3b4046 !important; }
    .pm4a-track-bypass-button { width:22px; height:22px; flex:0 0 22px; padding:0 !important; display:grid; place-items:center; border:0 !important; background:transparent !important; color:#b9c8b9 !important; }
    .pm4a-track-bypass-button:hover { background:#3c523c !important; }
    .pm4a-track-bypass-button.bypassed { color:#d2d5da !important; background:transparent !important; }
    .pm4a-track-bypass-button.bypassed:hover { background:#3b4046 !important; }
    .pm4a-track-mode-button svg, .pm4a-track-library-button svg, .pm4a-track-bypass-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .pm4a-track-mode-button.random { color:#7fdb9a; }
    .pm4a-track-actions { display:flex; align-items:center; gap:1px; }
    .pm4a-track-icon-button { width:22px; height:22px; padding:0 !important; display:grid; place-items:center; border:0 !important; background:transparent !important; }
    .pm4a-track-icon-button:hover { background:#3b4046 !important; }
    .pm4a-track-body { padding:7px; border-top:1px solid #496649; }
    .pm4a-track-prompt { position:relative; z-index:31; min-height:54px !important; resize:vertical; border-color:#4a684c !important; }
    .pm4a-track.bypassed { border-color:#656a72; background:#303237; }
    .pm4a-track.bypassed .pm4a-track-header { background:#24262a; }
    .pm4a-track.bypassed .pm4a-track-title-text { color:#a8adb5; text-decoration:line-through; }
    .pm4a-track.bypassed .pm4a-track-body { border-top-color:#464a51; }
    .pm4a-track.bypassed .pm4a-track-prompt { color:#92979f; border-color:#4b4f56 !important; }
    .pm4a-negative { flex:0 0 auto; border:1px solid #704848; border-radius:6px; overflow:hidden; background:#533; }
    .pm4a-negative-title { min-height:28px; padding:2px 4px; display:flex; align-items:center; gap:2px; color:#dbc3c3; font-weight:700; background:#322; }
    .pm4a-negative textarea { position:relative; z-index:31; margin:8px; width:calc(100% - 16px); min-height:52px; border-color:#704949 !important; }
    .pm4a-add-track { flex:0 0 auto; border-style:dashed !important; }
    .pm4a-track-input-socket { position:absolute; z-index:30; width:8px; height:8px; padding:0; box-sizing:border-box; border:1.25px solid #020402; border-radius:50%; background:transparent; box-shadow:inset 0 0 1px .5px rgba(75,255,103,.72), 0 0 1px .5px rgba(70,245,96,.58); transform:translate(-50%,-50%); cursor:crosshair; touch-action:none; }
    .pm4a-track-input-socket.connected { border-color:#78f28a; background:#78f28a; box-shadow:0 0 1px rgba(70,245,96,.45); }
  `;
  document.head.appendChild(style);
}

async function requestJson(path, { method = "GET", body } = {}) {
  const options = {
    method,
    cache: "no-store",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await pm4aFetch(path, options);
  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error(`服务器返回空响应（HTTP ${response.status}），请重启 ComfyUI 后重试`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(`服务器返回的不是有效 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function fetchJson(path, body) {
  return requestJson(path, { method: "POST", body });
}

function hideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  widget.computeSize = () => [0, -4];
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.PromptScheduler",

  setup() {
    api.addEventListener("pm4a_widget_update", (event) => {
      const payload = event?.detail || {};
      const slot = String(payload.slot || payload.widget_name || "");
      const value = payload.value;
      const mode = payload.mode === "replace" ? "replace" : "append";
      if (!WEB_SLOTS.has(slot) || typeof value !== "string") return;
      const targets = pickTargetNodes(payload);
      if (!targets.length) {
        console.warn("[4A-PM] no Prompt Scheduler node found on canvas");
        return;
      }
      for (const node of targets) {
        node.__pm4aSchedulerReceiveSlot?.(slot, value, mode);
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      original?.apply(this, arguments);
      configureComfyI18n(app);
      injectStyles();
      const node = this;
      const getConfigWidget = () => node.widgets?.find((widget) => widget.name === "config_json");
      let configWidget = getConfigWidget();
      const indexWidget = node.widgets?.find((widget) => widget.name === "execution_index");
      const runWidget = node.widgets?.find((widget) => widget.name === "run_id");
      if (!configWidget || !indexWidget || !runWidget) return;
      hideWidget(configWidget);
      hideWidget(indexWidget);
      hideWidget(runWidget);

      let config = normalizeConfig(configWidget.value);
      let batchState = null;
      let schedulerWidget = null;
      let inputLayoutFrame = 0;
      const trackSocketMarkers = new Map();

      const lockInternalInputTypes = () => {
        for (const input of node.inputs || []) {
          if (INTERNAL_INPUT_NAMES.has(input?.name)) input.type = INTERNAL_INPUT_TYPE;
        }
      };
      lockInternalInputTypes();

      const originalOnConnectInput = node.onConnectInput?.bind(node);
      node.onConnectInput = function (inputIndex) {
        if (INTERNAL_INPUT_NAMES.has(this.inputs?.[inputIndex]?.name)) return false;
        return originalOnConnectInput
          ? originalOnConnectInput(...arguments)
          : true;
      };

      // Positioned track sockets belong visually to the DOM fields. Exclude
      // them from LiteGraph's slot bounds, otherwise their position pushes the
      // DOM widget down and creates a self-reinforcing layout loop.
      const originalMeasureSlots = node._measureSlots?.bind(node);
      if (originalMeasureSlots) {
        node._measureSlots = function () {
          const allInputs = this._concreteInputs;
          if (!Array.isArray(allInputs)) return originalMeasureSlots();
          const positioned = [];
          this._concreteInputs = allInputs.filter((input, index) => {
            if (!input?.name?.startsWith(TRACK_INPUT_PREFIX)) return true;
            positioned.push({ input, index });
            return false;
          });
          let bounds;
          try {
            bounds = originalMeasureSlots();
          } finally {
            this._concreteInputs = allInputs;
          }
          for (const { input, index } of positioned) {
            this._measureSlot?.(input, index, true);
          }
          return bounds;
        };
      }

      // The DOM marker is the visible and interactive socket. Keep the real
      // LiteGraph input for links and workflow serialization, but do not draw
      // a second copy at the node's default top-left slot position.
      const originalDrawSlots = node.drawSlots?.bind(node);
      if (originalDrawSlots) {
        node.drawSlots = function () {
          const allInputs = this._concreteInputs;
          if (!Array.isArray(allInputs)) return originalDrawSlots(...arguments);
          this._concreteInputs = allInputs.filter(
            (input) => !input?.name?.startsWith(TRACK_INPUT_PREFIX)
              && !INTERNAL_INPUT_NAMES.has(input?.name),
          );
          try {
            return originalDrawSlots(...arguments);
          } finally {
            this._concreteInputs = allInputs;
          }
        };
      }

      const main = document.createElement("div");
      main.className = "pm4a-scheduler";
      main.addEventListener("pointerdown", (event) => event.stopPropagation());
      main.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

      const controls = document.createElement("div");
      controls.className = "pm4a-scheduler-controls";
      const makeNumberField = (label, key, min) => {
        const wrap = document.createElement("label");
        wrap.className = "pm4a-scheduler-field";
        wrap.textContent = label;
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(min);
        input.step = "1";
        input.value = String(config[key]);
        input.addEventListener("change", () => {
          config[key] = Math.max(min, Number.parseInt(input.value, 10) || min);
          input.value = String(config[key]);
          persist();
        });
        wrap.appendChild(input);
        controls.appendChild(wrap);
        return input;
      };
      const startInput = makeNumberField(t("起始位置"), "start_index", 0);
      const taskInput = makeNumberField(t("任务数量"), "task_count", 1);
      const oneRoundButton = document.createElement("button");
      oneRoundButton.textContent = t("统计数量");
      oneRoundButton.title = t("按顺序栏目的最长文件夹统计任务数量");
      const runButton = document.createElement("button");
      runButton.className = "pm4a-scheduler-run";
      runButton.textContent = t("批量运行");
      controls.append(oneRoundButton, runButton);

      const loraRow = document.createElement("div");
      loraRow.className = "pm4a-scheduler-lora-row";
      const loraToggle = document.createElement("label");
      loraToggle.className = "pm4a-scheduler-lora-toggle";
      const loraCheckbox = document.createElement("input");
      loraCheckbox.type = "checkbox";
      loraCheckbox.checked = Boolean(config.lora_append);
      const loraToggleText = document.createElement("span");
      loraToggleText.textContent = t("自动嵌入 Wildcard LoRA");
      loraToggle.title = t("仅当栏目通过 Wildcard 语法（如 __路径__）引用带 LoRA 的词条时，入队前自动追加到 Lora Loader（已有同名跳过）");
      loraToggle.append(loraCheckbox, loraToggleText);
      const loraGroupToggle = document.createElement("label");
      loraGroupToggle.className = "pm4a-scheduler-lora-toggle";
      const loraGroupCheckbox = document.createElement("input");
      loraGroupCheckbox.type = "checkbox";
      loraGroupCheckbox.checked = Boolean(config.lora_group_same);
      const loraGroupToggleText = document.createElement("span");
      loraGroupToggleText.textContent = t("相同 LoRA 连跑");
      loraGroupToggle.title = t("批量运行时把相同 LoRA 的任务排在一起，减少换 LoRA 导致的模型重载");
      loraGroupToggle.append(loraGroupCheckbox, loraGroupToggleText);
      const loraTarget = document.createElement("select");
      loraTarget.className = "pm4a-scheduler-lora-target";
      loraTarget.title = t("选择 LoRA Loader");
      const syncLoraGroupToggle = () => {
        const enabled = Boolean(config.lora_append);
        loraGroupCheckbox.disabled = !enabled;
        loraGroupToggle.classList.toggle("disabled", !enabled);
        loraGroupCheckbox.checked = Boolean(config.lora_group_same);
      };
      const refreshLoraTargets = () => {
        const targets = loraLoaderNodes(node.graph || app.graph);
        const previous = String(node.properties?.[TARGET_LORA_PROPERTY] || "");
        loraTarget.replaceChildren();
        if (targets.length > 1) {
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = t("选择 LoRA Loader");
          loraTarget.appendChild(placeholder);
        }
        for (const target of targets) {
          const option = document.createElement("option");
          option.value = String(target.id);
          option.textContent = target.title || `LoRA Loader #${target.id}`;
          loraTarget.appendChild(option);
        }
        const remembered = targets.find((target) => String(target.id) === previous);
        if (remembered) loraTarget.value = previous;
        else if (targets.length === 1) loraTarget.value = String(targets[0].id);
        else loraTarget.value = "";
        loraTarget.hidden = !config.lora_append || targets.length < 2;
        syncLoraGroupToggle();
      };
      loraCheckbox.addEventListener("change", () => {
        config.lora_append = loraCheckbox.checked;
        refreshLoraTargets();
        persist();
      });
      loraGroupCheckbox.addEventListener("change", () => {
        if (!config.lora_append) {
          loraGroupCheckbox.checked = Boolean(config.lora_group_same);
          return;
        }
        config.lora_group_same = loraGroupCheckbox.checked;
        persist();
      });
      loraTarget.addEventListener("change", () => {
        node.properties = node.properties || {};
        node.properties[TARGET_LORA_PROPERTY] = loraTarget.value;
      });
      refreshLoraTargets();
      loraRow.append(loraToggle, loraGroupToggle, loraTarget);

      const trackList = document.createElement("div");
      trackList.className = "pm4a-track-list";
      const addButton = document.createElement("button");
      addButton.className = "pm4a-add-track";
      addButton.textContent = t("+ 新增栏目");
      const negative = document.createElement("div");
      negative.className = "pm4a-negative";
      const negativeTitle = document.createElement("div");
      negativeTitle.className = "pm4a-negative-title";
      const negativeTitleText = document.createElement("span");
      negativeTitleText.textContent = t("负面");
      const negativeCollapse = document.createElement("button");
      negativeCollapse.type = "button";
      negativeCollapse.className = "pm4a-collapse-button";
      const negativeInput = document.createElement("textarea");
      negativeInput.spellcheck = false;
      negativeInput.placeholder = t("固定负面提示词");
      negativeInput.value = config.negative;
      negativeInput.addEventListener("input", () => {
        config.negative = negativeInput.value;
        schedulePersist();
      });
      void attachAutocompletePlus(negativeInput, {
        nodeType: node.comfyClass || NODE_CLASS,
        inputName: "negative",
      });
      negativeTitle.append(negativeCollapse, negativeTitleText);
      negative.append(negativeTitle, negativeInput);
      main.append(loraRow, controls, trackList, addButton, negative);

      let disconnectingInternalInputs = false;
      const disconnectInternalInputs = () => {
        if (disconnectingInternalInputs) return;
        disconnectingInternalInputs = true;
        try {
          lockInternalInputTypes();
          for (let index = (node.inputs?.length || 0) - 1; index >= 0; index--) {
            const input = node.inputs[index];
            if (!INTERNAL_INPUT_NAMES.has(input?.name)) continue;
            if (input.link !== null && input.link !== undefined) node.disconnectInput(index);
          }
        } finally {
          disconnectingInternalInputs = false;
        }
      };

      const scheduleTrackInputLayout = () => {
        if (inputLayoutFrame) cancelAnimationFrame(inputLayoutFrame);
        inputLayoutFrame = requestAnimationFrame(() => {
          inputLayoutFrame = 0;
          const mainRect = main.getBoundingClientRect();
          if (!mainRect.height) return;
          const scale = Math.max(0.01, Number(app.canvas?.ds?.scale) || 1);
          const measuredTop = Number(schedulerWidget?.last_y);
          const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0 ? measuredTop : 55;
          let socketMoved = false;
          for (const input of node.inputs || []) {
            if (!input?.name?.startsWith(TRACK_INPUT_PREFIX)) continue;
            const trackId = input.__pm4aTrackId;
            const anchor = trackId === "negative"
              ? (negativeInput.hidden ? negativeTitle : negativeInput)
              : trackList.querySelector(`[data-track-id="${CSS.escape(String(trackId))}"] .pm4a-track-prompt`)
                || trackList.querySelector(`[data-track-id="${CSS.escape(String(trackId))}"] .pm4a-track-header`);
            if (!anchor) continue;
            const rect = anchor.getBoundingClientRect();
            const isTextarea = anchor.matches("textarea");
            const x = isTextarea
              ? (rect.left - mainRect.left + TRACK_INPUT_TEXTAREA_X_OFFSET) / scale
              : 0;
            const offset = isTextarea
              ? TRACK_INPUT_TEXTAREA_Y_OFFSET
              : rect.height / 2;
            const localTop = (rect.top - mainRect.top + offset) / scale;
            const nextY = widgetTop + localTop;
            if (!input.pos || input.pos[0] !== x || input.pos[1] !== nextY) {
              input.pos = [x, nextY];
              socketMoved = true;
            }
            const marker = trackSocketMarkers.get(input.name);
            if (marker) {
              marker.style.left = `${x}px`;
              marker.style.top = `${localTop}px`;
              marker.classList.toggle(
                "connected",
                input.link !== null && input.link !== undefined,
              );
            }
          }
          if (socketMoved) node.setDirtyCanvas?.(true, true);
        });
      };

      const createTrackSocketMarker = (inputName) => {
        const marker = document.createElement("span");
        marker.className = "pm4a-track-input-socket";
        marker.dataset.inputName = inputName;
        marker.setAttribute("aria-hidden", "true");
        const forward = (method, event) => {
          event.preventDefault();
          event.stopPropagation();
          app.canvas?.[method]?.(event);
        };
        marker.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          marker.setPointerCapture?.(event.pointerId);
          forward("processMouseDown", event);
        });
        marker.addEventListener("pointermove", (event) => {
          if (!marker.hasPointerCapture?.(event.pointerId)) return;
          forward("processMouseMove", event);
        });
        const finish = (event) => {
          if (!marker.hasPointerCapture?.(event.pointerId)) return;
          forward("processMouseUp", event);
          marker.releasePointerCapture?.(event.pointerId);
          requestAnimationFrame(scheduleTrackInputLayout);
        };
        marker.addEventListener("pointerup", finish);
        marker.addEventListener("pointercancel", finish);
        main.appendChild(marker);
        return marker;
      };

      const syncTrackInputs = ({ removeStale = true } = {}) => {
        const desired = new Map([
          ...config.tracks.map((track) => [trackInputName(track.id), track.id]),
          [trackInputName("negative"), "negative"],
        ]);
        for (let index = (node.inputs?.length || 0) - 1; index >= 0; index--) {
          const input = node.inputs[index];
          if (removeStale && input?.name?.startsWith(TRACK_INPUT_PREFIX) && !desired.has(input.name)) {
            trackSocketMarkers.get(input.name)?.remove();
            trackSocketMarkers.delete(input.name);
            node.removeInput(index);
          }
        }
        for (const [name, trackId] of desired) {
          let input = node.inputs?.find((candidate) => candidate.name === name);
          if (!input) input = node.addInput(name, "STRING", { label: " " });
          if (!input) continue;
          input.type = "STRING";
          input.label = " ";
          input.__pm4aTrackId = trackId;
          if (!trackSocketMarkers.has(name)) {
            trackSocketMarkers.set(name, createTrackSocketMarker(name));
          }
        }
        scheduleTrackInputLayout();
      };

      function persist() {
        configWidget.value = JSON.stringify(config);
        if (Array.isArray(node.widgets_values)) {
          const index = node.widgets.indexOf(configWidget);
          if (index >= 0) node.widgets_values[index] = configWidget.value;
        }
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
      }

      let persistTimer = null;
      const schedulePersist = () => {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persist, 120);
      };
      const scheduleResizePersist = schedulePersist;
      const rememberHeight = (element, track = null) => {
        if (!element || element.hidden || !element.isConnected) return false;
        const trackId = element.dataset.trackId;
        if (trackId && !track) return false;
        const minimum = track ? 54 : 58;
        // offsetHeight is in unscaled CSS pixels. getBoundingClientRect() includes
        // the canvas zoom transform and caused the saved height to shrink again
        // after every DOM rebuild whenever the workflow was viewed below 100%.
        const height = Math.max(minimum, Math.min(1200, Math.round(element.offsetHeight)));
        const key = track ? "ui_height" : "negative_ui_height";
        const owner = track || config;
        if (owner[key] === height) return false;
        owner[key] = height;
        return true;
      };
      const resizeObserver = new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const trackId = entry.target.dataset.trackId;
          const track = trackId
            ? config.tracks.find((candidate) => candidate.id === trackId)
            : null;
          changed = rememberHeight(entry.target, track) || changed;
        }
        if (changed) scheduleResizePersist();
        scheduleTrackInputLayout();
      });
      resizeObserver.observe(negativeInput);

      function loadFromWidget({ restoring = false } = {}) {
        configWidget = getConfigWidget() || configWidget;
        for (const prompt of trackList.querySelectorAll(".pm4a-track-prompt")) {
          resizeObserver.unobserve(prompt);
        }
        trackList.innerHTML = "";
        config = normalizeConfig(configWidget.value);
        startInput.value = String(config.start_index);
        taskInput.value = String(config.task_count);
        negativeInput.value = config.negative;
        negativeInput.style.height = config.negative_ui_height
          ? `${config.negative_ui_height}px`
          : "";
        loraCheckbox.checked = Boolean(config.lora_append);
        loraGroupCheckbox.checked = Boolean(config.lora_group_same);
        refreshLoraTargets();
        if (!restoring) persist();
        renderNegative();
        renderTracks({ removeStaleInputs: !restoring });
        lockInternalInputTypes();
        disconnectInternalInputs();
      }

      function resolveLoraLoaderForAppend() {
        if (loraTarget.value) {
          node.properties = node.properties || {};
          node.properties[TARGET_LORA_PROPERTY] = loraTarget.value;
        }
        return findLoraLoaderTarget(node);
      }

      function applyLoraAppendText(loader, baseText, appendText) {
        const next = mergeLoraAppendText(baseText, appendText);
        if (next === baseText) return false;
        return writeLoraLoaderText(loader, next);
      }

      function renderNegative() {
        negativeInput.hidden = config.negative_collapsed;
        negativeCollapse.innerHTML = COLLAPSE_ICONS[config.negative_collapsed ? "collapsed" : "expanded"];
        negativeCollapse.title = config.negative_collapsed ? t("展开负面栏目") : t("收起负面栏目");
        negativeCollapse.setAttribute("aria-label", negativeCollapse.title);
        negativeCollapse.setAttribute("aria-expanded", String(!config.negative_collapsed));
        scheduleTrackInputLayout();
      }

      negativeCollapse.onclick = () => {
        config.negative_collapsed = !config.negative_collapsed;
        persist();
        renderNegative();
      };

      function renderTracks({ removeStaleInputs = true } = {}) {
        let capturedHeight = false;
        for (const card of trackList.children) {
          const track = config.tracks.find((candidate) => candidate.id === card.dataset.trackId);
          const prompt = card.querySelector?.(".pm4a-track-prompt");
          if (prompt) {
            capturedHeight = rememberHeight(prompt, track) || capturedHeight;
            resizeObserver.unobserve(prompt);
          }
        }
        if (capturedHeight) scheduleResizePersist();
        trackList.innerHTML = "";
        for (const track of config.tracks) {
          const card = document.createElement("section");
          card.className = "pm4a-track";
          card.dataset.trackId = track.id;
          const header = document.createElement("div");
          header.className = "pm4a-track-header";
          const collapse = document.createElement("button");
          collapse.type = "button";
          collapse.className = "pm4a-collapse-button";
          const renderCollapse = () => {
            collapse.innerHTML = COLLAPSE_ICONS[track.collapsed ? "collapsed" : "expanded"];
            collapse.title = track.collapsed ? t("展开栏目") : t("收起栏目");
            collapse.setAttribute("aria-label", collapse.title);
            collapse.setAttribute("aria-expanded", String(!track.collapsed));
          };
          collapse.onclick = () => {
            track.collapsed = !track.collapsed;
            persist();
            renderTracks();
          };
          renderCollapse();
          const fixedName = FIXED_TRACK_NAMES[track.id];
          const title = document.createElement("div");
          title.className = "pm4a-track-title";
          const titleText = document.createElement("span");
          titleText.className = "pm4a-track-title-text";
          titleText.textContent = fixedName ? t(fixedName) : track.name;
          title.appendChild(titleText);
          if (!fixedName) {
            const editName = document.createElement("button");
            editName.type = "button";
            editName.className = "pm4a-track-edit-name";
            editName.textContent = "✎";
            editName.title = t("编辑栏目名称");
            editName.setAttribute("aria-label", t("编辑栏目名称"));
            editName.onclick = () => {
              const editor = document.createElement("input");
              editor.className = "pm4a-track-title-editor";
              editor.value = track.name;
              let finished = false;
              const finish = (save) => {
                if (finished) return;
                finished = true;
                if (save) track.name = editor.value.trim() || t("未命名栏目");
                persist();
                renderTracks();
              };
              editor.addEventListener("blur", () => finish(true));
              editor.addEventListener("keydown", (event) => {
                if (event.key === "Enter") editor.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  finish(false);
                }
              });
              title.replaceChildren(editor);
              editor.focus();
              editor.select();
            };
            title.appendChild(editName);
          }
          const mode = document.createElement("button");
          mode.type = "button";
          mode.className = "pm4a-track-mode-button";
          const renderMode = () => {
            const random = track.mode === "random";
            mode.innerHTML = MODE_ICONS[random ? "random" : "sequence"];
            mode.classList.toggle("random", random);
            mode.title = random ? t("当前：随机；点击切换为顺序") : t("当前：顺序；点击切换为随机");
            mode.setAttribute("aria-label", mode.title);
            mode.setAttribute("aria-pressed", String(random));
          };
          mode.onclick = () => {
            track.mode = track.mode === "random" ? "sequence" : "random";
            persist();
            renderMode();
          };
          renderMode();
          const bypass = document.createElement("button");
          bypass.type = "button";
          bypass.className = "pm4a-track-bypass-button";
          const renderBypass = () => {
            const bypassed = !track.enabled;
            card.classList.toggle("bypassed", bypassed);
            bypass.classList.toggle("bypassed", bypassed);
            bypass.innerHTML = BYPASS_ICONS[bypassed ? "bypassed" : "enabled"];
            bypass.title = bypassed
              ? t("当前已停用，推理会忽略此栏目；点击重新启用")
              : t("当前已启用；点击停用此栏目");
            bypass.setAttribute("aria-label", bypass.title);
            bypass.setAttribute("aria-pressed", String(bypassed));
          };
          bypass.onclick = () => {
            track.enabled = !track.enabled;
            persist();
            renderBypass();
          };
          renderBypass();
          title.appendChild(bypass);
          header.append(collapse, title);
          const libraryLabel = fixedName || track.name;
          const libraryButton = document.createElement("button");
          libraryButton.type = "button";
          libraryButton.className = "pm4a-track-library-button";
          libraryButton.innerHTML = ADD_PROMPT_ICON;
          libraryButton.disabled = !track.text.trim();
          libraryButton.title = t("将“{label}”添加到提示词库", { label: libraryLabel });
          libraryButton.setAttribute("aria-label", libraryButton.title);
          libraryButton.onclick = () => openPromptLibraryModal({
            content: track.text,
            sourceLabel: libraryLabel,
          });
          header.appendChild(libraryButton);
          header.appendChild(mode);
          if (!fixedName) {
            const actions = document.createElement("div");
            actions.className = "pm4a-track-actions";
            const trackIndex = config.tracks.indexOf(track);
            const makeMoveButton = (symbol, label, direction) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "pm4a-track-icon-button";
              button.textContent = symbol;
              button.title = label;
              button.setAttribute("aria-label", label);
              const targetIndex = trackIndex + direction;
              button.disabled = targetIndex < 0 || targetIndex >= config.tracks.length;
              button.onclick = () => {
                [config.tracks[trackIndex], config.tracks[targetIndex]] = [
                  config.tracks[targetIndex],
                  config.tracks[trackIndex],
                ];
                persist();
                renderTracks();
              };
              return button;
            };
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "pm4a-track-icon-button";
            remove.textContent = "×";
            remove.title = t("删除栏目");
            remove.setAttribute("aria-label", t("删除栏目"));
            remove.onclick = () => {
              config.tracks = config.tracks.filter((candidate) => candidate.id !== track.id);
              persist();
              renderTracks();
            };
            actions.append(
              makeMoveButton("↑", t("上移栏目"), -1),
              makeMoveButton("↓", t("下移栏目"), 1),
              remove
            );
            header.appendChild(actions);
          }
          card.appendChild(header);
          if (!track.collapsed) {
            const body = document.createElement("div");
            body.className = "pm4a-track-body";
            const prompt = document.createElement("textarea");
            prompt.className = "pm4a-track-prompt";
            prompt.spellcheck = false;
            prompt.placeholder = t("固定文本，或粘贴 __文件夹路径__");
            prompt.value = track.text;
            prompt.dataset.trackId = track.id;
            if (track.ui_height) prompt.style.height = `${track.ui_height}px`;
            prompt.addEventListener("input", () => {
              track.text = prompt.value;
              if (libraryButton) libraryButton.disabled = !track.text.trim();
              schedulePersist();
            });
            void attachAutocompletePlus(prompt, {
              nodeType: node.comfyClass || NODE_CLASS,
              inputName: `track_${track.name || track.id}`,
            });
            body.appendChild(prompt);
            card.appendChild(body);
            resizeObserver.observe(prompt);
          }

          trackList.appendChild(card);
        }
        syncTrackInputs({ removeStale: removeStaleInputs });
      }

      addButton.onclick = () => {
        config.tracks.push(defaultTrack(uid(), `栏目 ${config.tracks.length + 1}`));
        persist();
        renderTracks();
        trackList.scrollTop = trackList.scrollHeight;
      };

      trackList.addEventListener("scroll", scheduleTrackInputLayout, { passive: true });

      const replacePositiveTracks = (entries, positiveText = "") => {
        const incomingTracks = Array.isArray(entries) ? entries : [];
        for (const track of config.tracks) track.text = "";

        let applied = 0;
        const unmatched = [];
        for (const entry of incomingTracks) {
          if (!entry || typeof entry.text !== "string" || !entry.text.trim()) continue;
          const genericPositive = entry.id === "positive" || entry.name === "正面";
          const target = genericPositive
            ? config.tracks.find((candidate) => candidate.id === "action")
            : config.tracks.find((candidate) => candidate.id === entry.id)
              || config.tracks.find((candidate) => candidate.name === entry.name);
          if (!target) {
            unmatched.push(String(entry.name || entry.id || t("未命名栏目")));
            continue;
          }
          target.text = entry.text.trim();
          applied += 1;
        }

        if (!applied && typeof positiveText === "string" && positiveText.trim()) {
          const action = config.tracks.find((candidate) => candidate.id === "action");
          if (action) {
            action.text = positiveText.trim();
            applied = 1;
          }
        }

        persist();
        renderTracks();
        return { accepted: applied > 0, applied, unmatched };
      };

      const receiveTrack = ({ id, name, text }, mode = "replace") => {
        if (typeof text !== "string") return false;
        const incoming = text.trim();
        const combine = (current) => {
          if (mode === "replace") return incoming;
          const existing = String(current || "").trim();
          if (!existing) return incoming;
          if (!incoming) return existing;
          return `${existing.replace(/,+$/, "")},\n${incoming}`;
        };
        if (id === "negative") {
          config.negative = combine(config.negative);
          negativeInput.value = config.negative;
        } else {
          const genericPositive = id === "positive" || name === "正面";
          const track = genericPositive
            ? config.tracks.find((candidate) => candidate.id === "action")
            : config.tracks.find((candidate) => candidate.id === id)
              || config.tracks.find((candidate) => candidate.name === name);
          if (!track) return false;
          track.text = combine(track.text);
          const card = [...trackList.children].find((candidate) => candidate.dataset.trackId === track.id);
          const prompt = card?.querySelector(".pm4a-track-prompt");
          if (prompt) prompt.value = track.text;
        }
        persist();
        return true;
      };

      node.__pm4aSchedulerReceiveTrack = (track, mode = "replace") => receiveTrack(track, mode);
      node.__pm4aSchedulerReceivePositive = (tracks, positiveText = "") => (
        replacePositiveTracks(tracks, positiveText)
      );
      node.__pm4aSchedulerReceiveSlot = (slot, value, mode = "append") => {
        if (!WEB_SLOTS.has(slot) || typeof value !== "string") return false;
        return receiveTrack(
          { id: slot, name: FIXED_TRACK_NAMES[slot] || "负面", text: value },
          mode
        );
      };

      oneRoundButton.onclick = async () => {
        const eligible = config.tracks.filter((track) => track.enabled && track.mode === "sequence" && /__.+?__/.test(track.text));
        if (!eligible.length) {
          return;
        }
        oneRoundButton.disabled = true;
        try {
          const data = await fetchJson("/pm4a/api/scheduler/counts", { config });
          const maximum = Number(data.maximum || 0);
          if (maximum < 1) throw new Error("没有找到可循环的文件夹通配符");
          config.task_count = maximum;
          taskInput.value = String(maximum);
          persist();
        } catch (error) {
          console.error("[4A Scheduler] Failed to count tasks", error);
        } finally {
          oneRoundButton.disabled = false;
        }
      };

      indexWidget.beforeQueued = () => {
        if (batchState) {
          indexWidget.value = batchState.currentIndex;
          runWidget.value = batchState.runId;
        } else {
          indexWidget.value = config.start_index;
          runWidget.value = "";
        }
      };

      runButton.onclick = async () => {
        if (batchState) return;
        config.start_index = Math.max(0, Number.parseInt(startInput.value, 10) || 0);
        config.task_count = Math.max(1, Number.parseInt(taskInput.value, 10) || 1);
        clearTimeout(persistTimer);
        persist();
        runButton.disabled = true;
        oneRoundButton.disabled = true;
        let loader = null;
        let baseLoraText = "";
        try {
          const data = await fetchJson("/pm4a/api/scheduler/prepare", {
            config,
            task_count: config.task_count,
            seed: resolveSchedulerSeed(node),
          });
          const loraPlans = Array.isArray(data.lora_plans) ? data.lora_plans : [];
          if (config.lora_append) {
            refreshLoraTargets();
            loader = resolveLoraLoaderForAppend();
            if (!loader) {
              console.warn(
                "[4A Scheduler]",
                loraLoaderNodes(node.graph || app.graph).length
                  ? t("请先选择 LoRA Loader")
                  : t("工作流中没有 LoraManager LoRA Loader"),
              );
            } else {
              baseLoraText = readLoraLoaderText(loader);
            }
          }
          batchState = {
            runId: data.run_id,
            currentIndex: config.start_index,
            skipQueueHook: true,
          };
          const indices = Array.from(
            { length: config.task_count },
            (_, offset) => config.start_index + offset,
          );
          const planText = (executionIndex) => {
            const plan = loraPlans.find(
              (entry) => Number(entry?.execution_index) === executionIndex,
            );
            return typeof plan?.append_text === "string" ? plan.append_text : "";
          };
          const queueOrder = (config.lora_append && config.lora_group_same)
            ? [...indices].sort((left, right) => {
              const leftText = planText(left);
              const rightText = planText(right);
              if (leftText !== rightText) return leftText < rightText ? -1 : 1;
              return left - right;
            })
            : indices;
          for (const executionIndex of queueOrder) {
            batchState.currentIndex = executionIndex;
            indexWidget.value = batchState.currentIndex;
            runWidget.value = batchState.runId;
            if (loader) {
              applyLoraAppendText(loader, baseLoraText, planText(executionIndex));
            }
            await app.queuePrompt(0);
          }
        } catch (error) {
          console.error("[4A Scheduler] Failed to queue batch", error);
        } finally {
          if (loader) writeLoraLoaderText(loader, baseLoraText);
          batchState = null;
          indexWidget.value = config.start_index;
          runWidget.value = "";
          runButton.disabled = false;
          oneRoundButton.disabled = false;
        }
      };

      if (!app.__pm4aSchedulerLoraQueueHooked) {
        app.__pm4aSchedulerLoraQueueHooked = true;
        const originalQueuePrompt = app.queuePrompt.bind(app);
        // ComfyUI may re-enter queuePrompt while one call is still draining its
        // internal queue; only the outermost hook may mutate/restore widgets.
        let queueHookDepth = 0;
        const writeRunId = (schedulerNode, widget, value) => {
          if (!widget) return;
          widget.value = value;
          if (Array.isArray(schedulerNode?.widgets_values) && Array.isArray(schedulerNode.widgets)) {
            const index = schedulerNode.widgets.indexOf(widget);
            if (index >= 0) schedulerNode.widgets_values[index] = value;
          }
        };
        app.queuePrompt = async function pm4aSchedulerQueuePrompt(...args) {
          const active = findSchedulerNodes().filter((candidate) => {
            const widget = candidate.widgets?.find((entry) => entry?.name === "config_json");
            const conf = normalizeConfig(widget?.value);
            return conf.lora_append && !candidate.__pm4aSchedulerBatchState?.skipQueueHook;
          });
          if (!active.length) return originalQueuePrompt(...args);

          queueHookDepth += 1;
          const isOutermost = queueHookDepth === 1;
          const restores = [];
          try {
            if (isOutermost) {
              // Official Run: queuePrompt(number, batchCount) re-serializes each
              // count after beforeQueued (seed rerolls). Re-assert run_id + LoRA
              // in beforeQueued so prompt expansion and LoRA stay on the same card.
              const batchCount = Math.max(1, Math.trunc(Number(args[1]) || 1));
              for (const schedulerNode of active) {
                try {
                  const widget = schedulerNode.widgets?.find((entry) => entry?.name === "config_json");
                  const conf = normalizeConfig(widget?.value);
                  const indexWidgetLocal = schedulerNode.widgets?.find(
                    (entry) => entry?.name === "execution_index",
                  );
                  const runWidgetLocal = schedulerNode.widgets?.find(
                    (entry) => entry?.name === "run_id",
                  );
                  const executionIndex = Number.isFinite(Number(indexWidgetLocal?.value))
                    ? Math.trunc(Number(indexWidgetLocal.value))
                    : conf.start_index;
                  const data = await fetchJson("/pm4a/api/scheduler/prepare", {
                    config: { ...conf, start_index: executionIndex },
                    task_count: batchCount,
                    seed: resolveSchedulerSeed(schedulerNode),
                  });
                  const runId = data.run_id || "";
                  const appendText = data.lora_plans?.[0]?.append_text || "";
                  const loader = findLoraLoaderTarget(schedulerNode);
                  const baseLoraText = loader ? readLoraLoaderText(loader) : "";
                  const nextLoraText = loader && appendText
                    ? mergeLoraAppendText(baseLoraText, appendText)
                    : baseLoraText;
                  const previousRunId = runWidgetLocal?.value;
                  const previousBeforeQueued = runWidgetLocal?.beforeQueued;
                  const applyForSerialize = () => {
                    if (runWidgetLocal) writeRunId(schedulerNode, runWidgetLocal, runId);
                    if (loader && nextLoraText !== baseLoraText) {
                      writeLoraLoaderText(loader, nextLoraText);
                    }
                  };
                  applyForSerialize();
                  if (runWidgetLocal) {
                    runWidgetLocal.beforeQueued = (...beforeArgs) => {
                      applyForSerialize();
                      return previousBeforeQueued?.apply(runWidgetLocal, beforeArgs);
                    };
                  }
                  restores.push({
                    schedulerNode,
                    runWidgetLocal,
                    previousRunId,
                    previousBeforeQueued,
                    loader,
                    baseLoraText,
                  });
                } catch (error) {
                  console.warn("[4A Scheduler] LoRA append skipped for single queue", error);
                }
              }
            }
            return await originalQueuePrompt(...args);
          } finally {
            if (isOutermost) {
              for (const entry of restores) {
                if (entry.runWidgetLocal) {
                  entry.runWidgetLocal.beforeQueued = entry.previousBeforeQueued;
                  writeRunId(entry.schedulerNode, entry.runWidgetLocal, entry.previousRunId);
                }
                if (entry.loader) writeLoraLoaderText(entry.loader, entry.baseLoraText);
              }
            }
            queueHookDepth -= 1;
          }
        };
      }

      Object.defineProperty(node, "__pm4aSchedulerBatchState", {
        configurable: true,
        get: () => batchState,
      });

      const originalOnConfigure = node.onConfigure?.bind(node);
      node.onConfigure = function (info) {
        const result = originalOnConfigure?.(info);
        node.__pm4aSchedulerConfigureVersion = Number(
          node.__pm4aSchedulerConfigureVersion || 0,
        ) + 1;
        const configureVersion = node.__pm4aSchedulerConfigureVersion;
        requestAnimationFrame(() => {
          if (configureVersion !== node.__pm4aSchedulerConfigureVersion) return;
          loadFromWidget({ restoring: true });
        });
        return result;
      };

      const originalOnExecuted = node.onExecuted?.bind(node);
      node.onExecuted = function (message) {
        const result = originalOnExecuted?.(message);
        const raw = Array.isArray(message?.pm4a_external_tracks)
          ? message.pm4a_external_tracks[0]
          : message?.pm4a_external_tracks;
        if (raw !== undefined && raw !== null) {
          try {
            const updates = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (updates && typeof updates === "object") {
              for (const [trackId, value] of Object.entries(updates)) {
                if (typeof value !== "string") continue;
                if (trackId === "negative") {
                  config.negative = value;
                  negativeInput.value = value;
                  continue;
                }
                const track = config.tracks.find((candidate) => candidate.id === trackId);
                if (track) track.text = value;
              }
              persist();
              renderTracks();
            }
          } catch (error) {
            console.error("[4A Scheduler] Failed to save external prompt text", error);
          }
        }
        return result;
      };

      const originalOnConnectionsChange = node.onConnectionsChange?.bind(node);
      node.onConnectionsChange = function () {
        const result = originalOnConnectionsChange?.apply(this, arguments);
        scheduleTrackInputLayout();
        setTimeout(disconnectInternalInputs, 0);
        return result;
      };

      schedulerWidget = node.addDOMWidget("pm4a_scheduler_ui", "pm4a_scheduler", main, withSyncedDomWidth({
        serialize: false,
        hideOnZoom: false,
        margin: 0,
        getMinHeight: () => 340,
        getMaxHeight: () => Math.max(340, Number(node.size?.[1] || 710) - 105),
      }));

      const bottomWidgets = node.widgets?.filter((candidate) =>
        candidate?.name === "seed" || candidate?.name === "control_after_generate"
      ) || [];
      if (bottomWidgets.length) {
        const widgetIndex = node.widgets.indexOf(schedulerWidget);
        node.widgets.splice(widgetIndex, 1);
        const firstBottomIndex = Math.min(...bottomWidgets.map((candidate) => node.widgets.indexOf(candidate)));
        node.widgets.splice(firstBottomIndex, 0, schedulerWidget);
      }

      node.resizable = true;
      node.setSize([520, 710]);
      renderNegative();
      renderTracks();
    };
  },
});
