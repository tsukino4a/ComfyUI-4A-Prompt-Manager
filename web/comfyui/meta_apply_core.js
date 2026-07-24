import { app } from "../../scripts/app.js";
import { getPngMetadata, getWebpMetadata } from "../../scripts/pnginfo.js";
import {
  readImagePromptDocument,
  sanitizeRawMetadata,
} from "/pm4a/static/image_prompt_metadata.js?v=17";
import { getLocale, pm4aFetch, t } from "./i18n.js?v=1";

export const SCHEDULER_NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)";
export const INPUT_PARAMETERS_NODE_CLASS = "Input Parameters (4A Prompt Manager)";
export const DOUBLE_SAMPLE_PARAMETERS_NODE_CLASS = "Double Sample Parameters (4A Prompt Manager)";
export const BYPASS_SWITCH_NODE_CLASS = "Bypass Switch (4A Prompt Manager)";
export const LORA_LOADER_NODE_CLASS = "Lora Loader (LoraManager)";

export const TARGET_NODE_PROPERTY = "pm4a_target_scheduler_id";
export const TARGET_PARAMETERS_PROPERTY = "pm4a_target_parameters_id";
export const TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY = "pm4a_target_double_sample_parameters_id";
export const TARGET_LORA_PROPERTY = "pm4a_target_lora_loader_id";

const DISPLAY_FIXED_TRACK_NAMES = Object.freeze({
  quality: "质量",
  character: "角色",
  action: "动作",
  scene: "场景",
  positive: "正面",
  negative: "负面",
});
const TRANSLATABLE_MODEL_TYPES = new Set(["基础模型", "模型"]);

export function displayTrackName(entry) {
  const rawName = String(entry?.name || "");
  const fixedName = DISPLAY_FIXED_TRACK_NAMES[String(entry?.id || "")]
    || (Object.values(DISPLAY_FIXED_TRACK_NAMES).includes(rawName) ? rawName : "");
  return fixedName ? t(fixedName) : rawName;
}

export function displayModelType(value) {
  const type = String(value || "模型");
  return TRANSLATABLE_MODEL_TYPES.has(type) ? t(type) : type;
}

export function localeJoin(values, separators = {}) {
  return values.join(getLocale() === "en" ? separators.en : separators.zh);
}

async function readImageDimensions(file) {
  if (!(file instanceof Blob)) return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({
        width: Math.trunc(Number(image.naturalWidth || 0)),
        height: Math.trunc(Number(image.naturalHeight || 0)),
      });
      image.onerror = () => resolve(null);
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function readImagePromptSnapshot(file) {
  const lowerName = String(file?.name || "").toLowerCase();
  const form = new FormData();
  form.append("image", file, file.name || "metadata-image");
  const response = await pm4aFetch("/pm4a/api/image/metadata", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || t("图片元数据读取失败：{status}", { status: response.status }));
  }
  let metadata = payload?.metadata || {};
  if (file?.type === "image/png" || lowerName.endsWith(".png")) {
    metadata = { ...metadata, ...(await getPngMetadata(file)) };
  } else if (file?.type === "image/webp" || lowerName.endsWith(".webp")) {
    metadata = { ...metadata, ...(await getWebpMetadata(file)) };
  }
  // Parse against the full extract, then persist/show only non-graph fields.
  const document = await readImagePromptDocument(file, metadata);
  if (!document) throw new Error(t("图片中没有识别到正面或负面提示词"));
  const dimensions = await readImageDimensions(file);
  const displayMetadata = sanitizeRawMetadata(metadata);
  const snapshotDocument = {
    ...document,
    raw_metadata: displayMetadata,
    image_dimensions: dimensions || undefined,
  };
  return {
    metadata: displayMetadata,
    document: snapshotDocument,
    promptJson: JSON.stringify(snapshotDocument),
  };
}

export function isScheduler(node) {
  return node && (node.comfyClass === SCHEDULER_NODE_CLASS || node.type === SCHEDULER_NODE_CLASS);
}

export function schedulerNodes(graph) {
  return (graph?._nodes || graph?.nodes || []).filter(isScheduler);
}

export function isInputParameters(node) {
  return node && (
    node.comfyClass === INPUT_PARAMETERS_NODE_CLASS
    || node.type === INPUT_PARAMETERS_NODE_CLASS
  );
}

export function inputParameterNodes(graph) {
  return (graph?._nodes || graph?.nodes || []).filter(isInputParameters);
}

export function isDoubleSampleParameters(node) {
  return node && (
    node.comfyClass === DOUBLE_SAMPLE_PARAMETERS_NODE_CLASS
    || node.type === DOUBLE_SAMPLE_PARAMETERS_NODE_CLASS
  );
}

export function doubleSampleParameterNodes(graph) {
  return (graph?._nodes || graph?.nodes || []).filter(isDoubleSampleParameters);
}

export function isLoraLoader(node) {
  return node && (node.comfyClass === LORA_LOADER_NODE_CLASS || node.type === LORA_LOADER_NODE_CLASS);
}

export function loraLoaderNodes(graph) {
  return (graph?._nodes || graph?.nodes || []).filter(isLoraLoader);
}

export function isBypassSwitch(node) {
  return node && (
    node.comfyClass === BYPASS_SWITCH_NODE_CLASS
    || node.type === BYPASS_SWITCH_NODE_CLASS
  );
}

export function bypassSwitchNodes(graph) {
  return (graph?._nodes || graph?.nodes || []).filter(isBypassSwitch);
}

export function modelTargetSpec(entry) {
  const type = String(entry?.type || "").toLowerCase();
  if (/\b(?:clip|vae)\b/.test(type)) return null;
  if (/\b(?:unet|diffusion)\b/.test(type)) return ["unet_name"];
  if (/\bcheckpoint\b/.test(type)) return ["ckpt_name"];
  if (type.includes("基础") || type.includes("模型") || type.includes("refiner")) {
    return ["ckpt_name", "unet_name"];
  }
  return null;
}

export function modelTargetNodes(graph, widgetNames) {
  const targets = [];
  for (const candidate of graph?._nodes || graph?.nodes || []) {
    if (!candidate || candidate.mode === 2 || candidate.mode === 4) continue;
    for (const widgetName of widgetNames) {
      const widget = candidate.widgets?.find((item) => item.name === widgetName);
      if (widget) targets.push({ node: candidate, widget, widgetName });
    }
  }
  return targets;
}

export function modelTargetLabel(target) {
  const kind = target.widgetName === "unet_name" ? "UNet" : "Checkpoint";
  return `[${kind}] ${target.node.title || t("节点 #{id}", { id: target.node.id })}`;
}

export async function resolveLocalModel(entry, widgetName) {
  const response = await pm4aFetch("/pm4a/api/model/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      widget_name: widgetName,
      name: String(entry?.name || ""),
      hash: String(entry?.hash || ""),
      model_version_id: String(entry?.model_version_id || ""),
    }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // Preserve the HTTP status when a proxy returns a non-JSON error page.
  }
  if (!response.ok || !data?.success || !data?.value) {
    throw new Error(data?.error || t("模型匹配服务返回 {status}", { status: response.status }));
  }
  return data;
}

export async function resolveLocalLora(entry) {
  const response = await pm4aFetch("/pm4a/api/lora/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: String(entry?.name || ""),
      hash: String(entry?.hash || ""),
    }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // Preserve the HTTP status when a proxy returns a non-JSON error page.
  }
  if (!response.ok || !data?.success || !data?.value) {
    throw new Error(data?.error || t("LoRA 匹配服务返回 {status}", { status: response.status }));
  }
  return data;
}

function loraHashLookup(hashes) {
  const map = new Map();
  for (const entry of Array.isArray(hashes) ? hashes : []) {
    const name = String(entry?.name || "").trim();
    const hash = String(entry?.hash || entry?.sha256 || "").trim();
    if (!name || !hash) continue;
    const stem = name.replace(/\\/g, "/").split("/").pop()
      ?.replace(/\.(?:safetensors|ckpt|pt|pth|bin)$/i, "")
      || name;
    map.set(name.toLowerCase(), hash);
    map.set(stem.toLowerCase(), hash);
  }
  return map;
}

/** Remap `<lora:name:strength>` tags to local files (name first, then hash). */
export async function remapLoraTextFromPayload(loras) {
  const text = typeof loras?.text === "string" ? loras.text.trim() : "";
  if (!text) return "";
  const hashByName = loraHashLookup(loras?.hashes);
  const tags = [];
  const seen = new Set();
  for (const entry of parseLoraTags(text)) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hash = hashByName.get(key) || "";
    let localName = entry.name;
    try {
      const resolved = await resolveLocalLora({ name: entry.name, hash });
      localName = String(resolved.tag_name || resolved.value || entry.name)
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.replace(/\.(?:safetensors|ckpt|pt|pth|bin)$/i, "")
        || entry.name;
    } catch (_) {
      // Keep the original name when local resolve fails.
    }
    const strength = entry.strength || "1";
    tags.push(`<lora:${localName}:${strength}>`);
  }
  return tags.join(" ");
}

export function setWidgetValue(node, widget, value) {
  if (!widget) return;
  widget.value = value;
  if (widget.inputEl) widget.inputEl.value = value;
  if (Array.isArray(node.widgets_values)) {
    const index = node.widgets.indexOf(widget);
    if (index >= 0) node.widgets_values[index] = value;
  }
  widget.callback?.(value);
}

export function replaceModelWidget(target, value) {
  if (!target?.node || !target?.widget) return false;
  setWidgetValue(target.node, target.widget, value);
  target.node.setDirtyCanvas?.(true, true);
  target.node.graph?.setDirtyCanvas?.(true, true);
  target.node.graph?.change?.();
  return true;
}

export function graphNodeById(graph, id) {
  if (!graph || id === undefined || id === null || id === "") return null;
  const direct = graph.getNodeById?.(id) || graph.getNodeById?.(Number(id));
  if (direct) return direct;
  return (graph._nodes || graph.nodes || []).find((candidate) => String(candidate?.id) === String(id)) || null;
}

export function connectedScheduler(hostNode) {
  const graph = hostNode.graph || app.graph;
  const input = hostNode.inputs?.find((candidate) => candidate.name === "prompt_json");
  const link = input?.link !== null && input?.link !== undefined
    ? (graph?.links?.[input.link] || graph?._links?.[input.link])
    : null;
  const connected = link ? graphNodeById(graph, link.origin_id) : null;
  return isScheduler(connected) ? connected : null;
}

export function findSourceScheduler(hostNode, payload) {
  const graph = hostNode.graph || app.graph;
  const connected = connectedScheduler(hostNode);
  if (connected) return connected;

  const chosen = graphNodeById(graph, hostNode.properties?.[TARGET_NODE_PROPERTY]);
  if (isScheduler(chosen)) return chosen;

  const declared = graphNodeById(graph, payload?.scheduler_node_id);
  if (isScheduler(declared)) return declared;

  const schedulers = schedulerNodes(graph);
  return schedulers.length === 1 ? schedulers[0] : null;
}

export function findInputParametersTarget(hostNode) {
  const graph = hostNode.graph || app.graph;
  const chosen = graphNodeById(graph, hostNode.properties?.[TARGET_PARAMETERS_PROPERTY]);
  if (isInputParameters(chosen)) return chosen;
  const targets = inputParameterNodes(graph);
  return targets.length === 1 ? targets[0] : null;
}

export function findDoubleSampleParametersTarget(hostNode) {
  const graph = hostNode.graph || app.graph;
  const chosen = graphNodeById(
    graph,
    hostNode.properties?.[TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY],
  );
  if (isDoubleSampleParameters(chosen)) return chosen;
  const targets = doubleSampleParameterNodes(graph);
  return targets.length === 1 ? targets[0] : null;
}

export function findLoraLoaderTarget(hostNode) {
  const graph = hostNode.graph || app.graph;
  const chosen = graphNodeById(graph, hostNode.properties?.[TARGET_LORA_PROPERTY]);
  if (isLoraLoader(chosen)) return chosen;
  const targets = loraLoaderNodes(graph);
  return targets.length === 1 ? targets[0] : null;
}

/** Exactly one Bypass Switch is supported for now. */
export function findBypassSwitchTarget(hostNode) {
  const targets = bypassSwitchNodes(hostNode.graph || app.graph);
  if (targets.length > 1) {
    throw new Error(t("工作流中有多个 Bypass Switch，目前只支持一个"));
  }
  return targets[0] || null;
}

export function applyBypassSwitch(hostNode, enabled) {
  const target = findBypassSwitchTarget(hostNode);
  if (!target) {
    throw new Error(t("工作流中没有 Bypass Switch 节点"));
  }
  const result = target.__pm4aBypassSwitchReceive?.({ enabled: Boolean(enabled) });
  if (!result) throw new Error(t("Bypass Switch 尚未准备好，请刷新页面"));
  return t("已设置“{name}”为 {state}", {
    name: target.title || t("Bypass Switch #{id}", { id: target.id }),
    state: enabled ? t("启用") : t("旁路"),
  });
}

/**
 * Sync Bypass Switch from whether double-sample settings are present.
 * ON when has fields; OFF when absent (skipped only if no switch and turning OFF).
 */
export function syncBypassSwitchFromDoubleSample(hostNode, hasDoubleSample) {
  const enabled = Boolean(hasDoubleSample);
  const bypassCount = bypassSwitchNodes(hostNode.graph || app.graph).length;
  if (!enabled && bypassCount === 0) return null;
  return applyBypassSwitch(hostNode, enabled);
}

/**
 * Apply first-pass / second-pass parameter blocks and sync Bypass.
 * Shared by Meta Apply and Prompt Display.
 */
export function applyParameterSettingsFromPayload(hostNode, payload) {
  const applied = [];
  const errors = [];
  const parameters = payload?.parameters && typeof payload.parameters === "object"
    ? payload.parameters
    : null;
  const doubleParams = sparseObject(payload?.double_sample_parameters);
  const hasDoubleSample = Object.keys(doubleParams).length > 0;

  if (parameters && Object.keys(parameters).length) {
    try {
      const message = applyInputParametersFromPayload(hostNode, { parameters });
      if (message) applied.push(t("生成参数"));
    } catch (error) {
      errors.push(t("{key}：{error}", { key: t("生成参数"), error: error.message || error }));
    }
  }

  if (hasDoubleSample) {
    try {
      const message = applyDoubleSampleFromPayload(hostNode, {
        double_sample_parameters: doubleParams,
      });
      if (message) applied.push(t("双采样参数"));
    } catch (error) {
      errors.push(t("{key}：{error}", {
        key: t("双采样参数"),
        error: error.message || error,
      }));
    }
  }

  try {
    const message = syncBypassSwitchFromDoubleSample(hostNode, hasDoubleSample);
    if (message) applied.push(t("二采样开关"));
  } catch (error) {
    errors.push(t("{key}：{error}", {
      key: t("二采样开关"),
      error: error.message || error,
    }));
  }

  return { applied, errors };
}

/** Stable key for batch “group same model” ordering (aligns with modelTargetSpec). */
export function modelGroupKey(plan) {
  const models = Array.isArray(plan?.models) ? plan.models : [];
  if (!models.length) return "";
  const ranked = [];
  for (const entry of models) {
    if (!entry?.name || !modelTargetSpec(entry)) continue;
    const type = String(entry?.type || "").trim().toLowerCase();
    let score = 3;
    if (type === "基础模型" || type === "checkpoint") score = 0;
    else if (type === "unet" || /\bunet\b/.test(type) || /\bdiffusion\b/.test(type)) score = 1;
    else if (type.includes("基础") || type.includes("模型") || type.includes("refiner")) score = 2;
    ranked.push({ name: String(entry.name), score });
  }
  if (!ranked.length) return "";
  ranked.sort((left, right) => (
    left.score - right.score
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  ));
  return ranked[0].name;
}

function sparseObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/** True when a scheduler settings plan has anything to write. */
export function settingsPlanNonempty(plan) {
  if (!plan || typeof plan !== "object") return false;
  if (Array.isArray(plan.models) && plan.models.length) return true;
  if (Object.keys(sparseObject(plan.parameters)).length) return true;
  if (Object.keys(sparseObject(plan.double_sample_parameters)).length) return true;
  return false;
}

/**
 * Apply sparse Wildcard card settings collected by scheduler prepare.
 * Parameters flag covers first-pass, double-sample, and Bypass sync together.
 * Empty plans are no-ops (plain text / no card settings must not touch Bypass).
 * @param {object} hostNode
 * @param {object} plan
 * @param {{ applyModels?: boolean, applyParameters?: boolean }} [options]
 */
export async function applySettingsPlanFromPayload(hostNode, plan, options = {}) {
  if (!settingsPlanNonempty(plan)) return { applied: [], errors: [] };
  const applyModels = options.applyModels === true;
  const applyParameters = options.applyParameters === true;
  const applied = [];
  const errors = [];
  const payload = {
    models: Array.isArray(plan?.models) ? plan.models : [],
    parameters: plan?.parameters && typeof plan.parameters === "object" ? plan.parameters : null,
    double_sample_parameters: (
      plan?.double_sample_parameters
      && typeof plan.double_sample_parameters === "object"
    )
      ? plan.double_sample_parameters
      : null,
  };

  if (applyModels && payload.models.length) {
    const modelResult = await applyModelsFromPayload(hostNode, payload);
    if (modelResult.applied.length) {
      applied.push(
        modelResult.applied.length === 1
          ? t("模型 1 个")
          : t("模型 {count} 个", { count: modelResult.applied.length }),
      );
    }
    errors.push(...modelResult.errors);
  }

  if (applyParameters) {
    const paramResult = applyParameterSettingsFromPayload(hostNode, payload);
    applied.push(...paramResult.applied);
    errors.push(...paramResult.errors);
  }

  return { applied, errors };
}

export function withGraphChangeTransaction(node, update) {
  const graph = node?.graph || app.graph;
  const transactional = typeof graph?.beforeChange === "function"
    && typeof graph?.afterChange === "function";
  const emitsChange = typeof app.canvas?.emitBeforeChange === "function"
    && typeof app.canvas?.emitAfterChange === "function";
  if (emitsChange) app.canvas.emitBeforeChange();
  if (transactional) graph.beforeChange();
  try {
    return update();
  } finally {
    if (transactional) graph.afterChange();
    if (emitsChange) app.canvas.emitAfterChange();
    else graph?.change?.();
  }
}

export function loraLoaderTextWidget(node) {
  return node?.inputWidget || node?.widgets?.find((candidate) => candidate.name === "text") || null;
}

export function readLoraLoaderText(node) {
  const widget = loraLoaderTextWidget(node);
  return widget ? String(widget.value ?? "") : "";
}

export function parseLoraTags(text) {
  if (typeof text !== "string" || !text) return [];
  const tags = [];
  const seen = new Set();
  for (const match of text.matchAll(/<lora:([^>:]+)(?::([^>]*))?>/gi)) {
    const name = String(match[1] || "").trim();
    const tag = String(match[0] || "").trim();
    if (!name || !tag) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ name, tag, strength: String(match[2] ?? "").trim() });
  }
  return tags;
}

export function mergeLoraAppendText(baseText, appendText) {
  const base = typeof baseText === "string" ? baseText : "";
  const extra = typeof appendText === "string" ? appendText : "";
  if (!extra.trim()) return base;
  const existing = new Set(parseLoraTags(base).map((entry) => entry.name.toLowerCase()));
  const additions = [];
  for (const entry of parseLoraTags(extra)) {
    const key = entry.name.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    additions.push(entry.tag);
  }
  if (!additions.length) return base;
  if (!base.trim()) return additions.join(" ");
  return `${base.replace(/\s+$/g, "")} ${additions.join(" ")}`;
}

export function replaceLoraLoaderText(node, value) {
  const widget = loraLoaderTextWidget(node);
  if (!widget) return false;
  setWidgetValue(node, widget, "");
  setWidgetValue(node, widget, value);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  node.graph?.change?.();
  return true;
}

export function writeLoraLoaderText(node, value) {
  return replaceLoraLoaderText(node, value == null ? "" : String(value));
}

export async function convertNovelAITexts(payload, texts) {
  if (payload?.source_type !== "novelai") {
    return texts.map((text) => ({ text, repaired: false, repair_count: 0 }));
  }
  const response = await pm4aFetch("/pm4a/api/convert/nai-to-anima", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // The status below is more useful than a JSON parsing error.
  }
  if (!response.ok || !data?.success || !Array.isArray(data.results)) {
    throw new Error(data?.error || t("转换服务返回 {status}", { status: response.status }));
  }
  return data.results;
}

export function conversionRepairNotice(results) {
  const count = results.reduce((total, result) => total + Number(result?.repair_count || 0), 0);
  return count ? t("（已补全 {count} 个闭合符号）", { count }) : "";
}

export async function applyPositiveFromPayload(hostNode, payload) {
  const scheduler = findSourceScheduler(hostNode, payload);
  if (!scheduler) {
    throw new Error(
      schedulerNodes(hostNode.graph || app.graph).length
        ? t("请先选择 Scheduler")
        : t("工作流中没有 Scheduler"),
    );
  }
  const sourceTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const results = await convertNovelAITexts(
    payload,
    [...sourceTracks.map((track) => track.text), payload.positive || ""],
  );
  const convertedTracks = sourceTracks.map((track, index) => ({
    ...track,
    text: results[index]?.text ?? track.text,
  }));
  const convertedPositive = results[sourceTracks.length]?.text ?? payload.positive;
  const result = scheduler.__pm4aSchedulerReceivePositive?.(
    convertedTracks,
    convertedPositive,
  );
  if (!result) throw new Error(t("Scheduler 尚未准备好，请刷新页面"));
  const missing = result.unmatched?.length
    ? t("；未找到 {names}", {
      names: localeJoin(
        result.unmatched.map((name) => displayTrackName({ name })),
        { zh: "、", en: ", " },
      ),
    })
    : "";
  const notice = conversionRepairNotice(results);
  if (!result.accepted) throw new Error(t("没有可回填的正面提示词"));
  return t("已使用全部正面提示词{notice}{missing}", { notice, missing });
}

export async function applyNegativeFromPayload(hostNode, payload) {
  const negative = typeof payload?.negative === "string" ? payload.negative.trim() : "";
  if (!negative) return null;
  const scheduler = findSourceScheduler(hostNode, payload);
  if (!scheduler) {
    throw new Error(
      schedulerNodes(hostNode.graph || app.graph).length
        ? t("请先选择 Scheduler")
        : t("工作流中没有 Scheduler"),
    );
  }
  const entry = { id: "negative", name: "负面", text: negative };
  const results = await convertNovelAITexts(payload, [entry.text]);
  const converted = { ...entry, text: results[0]?.text ?? entry.text };
  const accepted = scheduler.__pm4aSchedulerReceiveTrack?.(converted, "replace");
  const notice = conversionRepairNotice(results);
  if (!accepted) throw new Error(t("未找到“{name}”栏目", { name: displayTrackName(entry) }));
  return t("已回填“{name}”{notice}", { name: displayTrackName(entry), notice });
}

export async function applyModelsFromPayload(hostNode, payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const applied = [];
  const errors = [];
  const graph = hostNode.graph || app.graph;
  for (const entry of models) {
    const widgetNames = modelTargetSpec(entry);
    if (!widgetNames) continue;
    const propertyKey = `pm4a_target_model_${widgetNames.join("_")}`;
    const targets = modelTargetNodes(graph, widgetNames);
    if (!targets.length) {
      errors.push(t("{key}：{error}", {
        key: displayModelType(entry.type),
        error: t("工作流中没有兼容的 Checkpoint / UNet Loader"),
      }));
      continue;
    }
    const remembered = String(hostNode.properties?.[propertyKey] || "");
    let target = null;
    if (remembered) {
      target = targets.find((candidate, index) => (
        `${candidate.node.id}:${candidate.widgetName}:${index}` === remembered
      )) || null;
    }
    if (!target && targets.length === 1) target = targets[0];
    if (!target) {
      errors.push(t("{key}：{error}", {
        key: displayModelType(entry.type),
        error: t("请先选择模型 Loader"),
      }));
      continue;
    }
    try {
      const result = await resolveLocalModel(entry, target.widgetName);
      if (!replaceModelWidget(target, result.value)) {
        throw new Error(t("模型 Loader 尚未准备好"));
      }
      applied.push(result);
    } catch (error) {
      errors.push(t("{key}：{error}", {
        key: displayModelType(entry.type),
        error: error.message || error,
      }));
    }
  }
  return { applied, errors };
}

export function applyInputParametersFromPayload(hostNode, payload) {
  const parameters = payload?.parameters;
  if (!parameters || typeof parameters !== "object") return null;
  const target = findInputParametersTarget(hostNode);
  if (!target) {
    throw new Error(inputParameterNodes(hostNode.graph || app.graph).length
      ? t("请先选择参数节点")
      : t("工作流中没有 4A 参数节点"));
  }
  const result = target.__pm4aInputParametersReceive?.(parameters);
  if (!result) throw new Error(t("参数节点尚未准备好，请刷新页面"));
  const skipped = result.skipped || [];
  const suffix = skipped.length
    ? t("；未匹配 {names}", { names: localeJoin(skipped, { zh: "、", en: ", " }) })
    : "";
  return t("已发送到“{name}”{suffix}", {
    name: target.title || t("参数节点 #{id}", { id: target.id }),
    suffix,
  });
}

export function applyDoubleSampleFromPayload(hostNode, payload) {
  const parameters = payload?.double_sample_parameters;
  if (!parameters || typeof parameters !== "object") return null;
  const target = findDoubleSampleParametersTarget(hostNode);
  if (!target) {
    throw new Error(doubleSampleParameterNodes(hostNode.graph || app.graph).length
      ? t("请先选择双采样参数节点")
      : t("工作流中没有 4A 双采样参数节点"));
  }
  const result = target.__pm4aDoubleSampleParametersReceive?.(parameters);
  if (!result) throw new Error(t("双采样参数节点尚未准备好，请刷新页面"));
  const skipped = result.skipped || [];
  const suffix = skipped.length
    ? t("；未匹配 {names}", { names: localeJoin(skipped, { zh: "、", en: ", " }) })
    : "";
  return t("已发送到“{name}”{suffix}", {
    name: target.title || t("双采样参数节点 #{id}", { id: target.id }),
    suffix,
  });
}

export async function applyLoraFromPayload(hostNode, payload) {
  const rawText = typeof payload?.loras?.text === "string" ? payload.loras.text.trim() : "";
  if (!rawText) return null;
  const textValue = await remapLoraTextFromPayload(payload.loras) || rawText;
  const target = findLoraLoaderTarget(hostNode);
  if (!target) {
    throw new Error(loraLoaderNodes(hostNode.graph || app.graph).length
      ? t("请先选择 LoRA Loader")
      : t("工作流中没有 LoraManager LoRA Loader"));
  }
  if (!replaceLoraLoaderText(target, textValue)) {
    throw new Error(t("没有找到 LoRA Loader 的文本框"));
  }
  return t("已替换“{name}”", { name: target.title || `LoRA Loader #${target.id}` });
}

/**
 * Apply Meta Loader targets available in the payload.
 * @param {{
 *   applyPrompt?: boolean,
 *   applyModel?: boolean,
 *   applyLora?: boolean,
 *   applyModelLora?: boolean,
 *   applyParameters?: boolean,
 * }} [options]
 */
export async function applyAllFromPayload(hostNode, payload, options = {}) {
  const applyPrompt = options.applyPrompt !== false;
  // Prefer split flags; fall back to legacy applyModelLora when split flags omitted.
  const applyModelFlag = options.applyModel !== undefined
    ? options.applyModel !== false
    : options.applyModelLora !== false;
  const applyLoraFlag = options.applyLora !== undefined
    ? options.applyLora !== false
    : options.applyModelLora !== false;
  const applyParameters = options.applyParameters !== false;
  const applied = [];
  const errors = [];

  if (applyPrompt) {
    try {
      applied.push(await applyPositiveFromPayload(hostNode, payload));
    } catch (error) {
      errors.push(t("{key}：{error}", { key: t("正面提示词"), error: error.message || error }));
    }

    try {
      const message = await applyNegativeFromPayload(hostNode, payload);
      if (message) applied.push(message);
    } catch (error) {
      errors.push(t("{key}：{error}", { key: t("负面"), error: error.message || error }));
    }
  }

  if (applyModelFlag) {
    const modelResult = await applyModelsFromPayload(hostNode, payload);
    const modelCount = modelResult.applied.length;
    if (modelCount) {
      applied.push(modelCount === 1 ? t("模型 1 个") : t("模型 {count} 个", { count: modelCount }));
    }
    errors.push(...modelResult.errors);
  }

  if (applyLoraFlag) {
    try {
      const message = await applyLoraFromPayload(hostNode, payload);
      if (message) applied.push("LoRA");
    } catch (error) {
      if (typeof payload?.loras?.text === "string" && payload.loras.text.trim()) {
        errors.push(t("{key}：{error}", { key: "LoRA", error: error.message || error }));
      }
    }
  }

  if (applyParameters) {
    const paramResult = applyParameterSettingsFromPayload(hostNode, payload);
    applied.push(...paramResult.applied);
    errors.push(...paramResult.errors);
  }

  const successText = applied.length
    ? t("已自动应用：{applied}", { applied: localeJoin(applied, { zh: "、", en: ", " }) })
    : t("没有可使用的参数");
  const errorText = errors.length
    ? t("；未应用 {errors}", { errors: localeJoin(errors, { zh: "；", en: "; " }) })
    : "";
  return {
    applied,
    errors,
    message: `${successText}${errorText}`,
  };
}
