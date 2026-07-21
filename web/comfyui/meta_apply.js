import { app } from "../../scripts/app.js";
import { parsePromptDocument } from "/pm4a/static/image_prompt_metadata.js?v=13";
import {
  fetchImageFile,
  looksLikeImageFile,
} from "/pm4a/static/image_drop.js?v=3";
import {
  buildStoredImageUrl,
  normalizeStoredImageReference,
} from "./prompt_display_state.js?v=2";
import { configureComfyI18n, t } from "./i18n.js?v=1";
import {
  applyAllFromPayload,
  readImagePromptSnapshot,
} from "./meta_apply_core.js?v=1";
import { withSyncedDomWidth } from "./dom_widget_layout.js";

const NODE_CLASS = "Meta Apply (4A Prompt Manager)";

const TOP_PAD_PX = 8;

function ensureMetaApplyStyles() {
  if (document.getElementById("pm4a-meta-apply-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-meta-apply-styles";
  style.textContent = `
    .pm4a-meta-apply-top-pad {
      width: 100%;
      height: ${TOP_PAD_PX}px;
      margin: 0;
      padding: 0;
      pointer-events: none;
    }
    .pm4a-meta-apply-root {
      width: 100%;
      box-sizing: border-box;
      padding: 4px 14px 2px;
      color: #c9ced3;
      font: 12px/1.35 system-ui, sans-serif;
    }
    .pm4a-meta-apply-root * { box-sizing: border-box; }
    .pm4a-meta-apply-status {
      min-height: 28px;
      padding: 5px 8px;
      border: 1px solid #464a50;
      border-radius: 5px;
      background: #292c30;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

/** Put a few pixels between the node title and the official image combo. */
function ensureTopPadding(node) {
  if (node.__pm4aMetaApplyTopPad) return;
  const pad = document.createElement("div");
  pad.className = "pm4a-meta-apply-top-pad";
  const widget = node.addDOMWidget("pm4a_meta_apply_top_pad", "pm4a_meta_apply_top_pad", pad, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => TOP_PAD_PX,
    getMaxHeight: () => TOP_PAD_PX,
  }));
  const list = node.widgets;
  const index = list?.indexOf?.(widget) ?? -1;
  if (index > 0) {
    list.splice(index, 1);
    list.unshift(widget);
  }
  node.__pm4aMetaApplyTopPad = true;
}

function viewPath() {
  return app.api?.apiURL?.("/view") || "/view";
}

function imageReferenceFromWidgetValue(value) {
  // Official image combo values look like:
  //   "folder/file.webp [output]"
  // Matching folder_paths.annotated_filepath(): strip " [input|output|temp]".
  let raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) return null;

  let type = "input";
  const annotated = raw.match(/^(.*) \[(input|output|temp)\]$/i);
  if (annotated) {
    raw = annotated[1].trim();
    type = annotated[2].toLowerCase();
  }

  const slash = raw.lastIndexOf("/");
  if (slash < 0) {
    return normalizeStoredImageReference({ filename: raw, subfolder: "", type });
  }
  return normalizeStoredImageReference({
    filename: raw.slice(slash + 1),
    subfolder: raw.slice(0, slash),
    type,
  });
}

function imageWidget(node) {
  return node.widgets?.find((widget) => widget.name === "image") || null;
}

function setupMetaApplyNode(node) {
  if (node.__pm4aMetaApplyReady) return node.__pm4aMetaApplyApi || null;
  node.__pm4aMetaApplyReady = true;
  configureComfyI18n(app);
  ensureMetaApplyStyles();
  ensureTopPadding(node);

  const main = document.createElement("div");
  main.className = "pm4a-meta-apply-root";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());

  const status = document.createElement("div");
  status.className = "pm4a-meta-apply-status";
  status.setAttribute("aria-live", "polite");
  status.textContent = t("等待图片");
  main.append(status);

  let busy = false;
  let lastAppliedKey = "";
  let acceptWidgetChanges = false;

  const setStatus = (message) => {
    const text = message || t("等待图片");
    status.textContent = text;
    status.title = text;
  };

  const applyImage = async (file, { key = "" } = {}) => {
    if (busy) return;
    if (!looksLikeImageFile(file)) {
      setStatus(t("仅支持常见图片格式（PNG、JPEG、WebP、GIF 等）"));
      return;
    }
    const applyKey = key || `${file.name}:${file.size}:${file.lastModified || 0}`;
    if (applyKey && applyKey === lastAppliedKey) return;
    busy = true;
    setStatus(t("正在读取并应用元数据…"));
    try {
      const snapshot = await readImagePromptSnapshot(file);
      const payload = parsePromptDocument(snapshot.promptJson);
      if (!payload) throw new Error(t("图片中没有识别到正面或负面提示词"));
      const result = await applyAllFromPayload(node, payload);
      lastAppliedKey = applyKey;
      setStatus(result.message);
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      busy = false;
    }
  };

  const applyFromWidgetValue = async (value) => {
    const reference = imageReferenceFromWidgetValue(value);
    if (!reference) {
      lastAppliedKey = "";
      setStatus(t("等待图片"));
      return;
    }
    const url = buildStoredImageUrl(reference, viewPath());
    const file = await fetchImageFile(url, reference.filename);
    await applyImage(file, {
      key: `${reference.type}:${reference.subfolder}:${reference.filename}`,
    });
  };

  const widget = imageWidget(node);
  if (widget) {
    const previousCallback = widget.callback;
    widget.callback = function (value) {
      const result = previousCallback?.apply(this, arguments);
      if (acceptWidgetChanges) {
        void applyFromWidgetValue(value).catch((error) => {
          setStatus(String(error.message || error));
        });
      }
      return result;
    };
  }

  node.addDOMWidget("pm4a_meta_apply_ui", "pm4a_meta_apply", main, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => 40,
    getMaxHeight: () => 40,
  }));
  node.resizable = true;
  if (!Array.isArray(node.size) || node.size[1] < 220) {
    node.setSize([315, 220]);
  }

  const api = {
    applyFromWidgetValue: (value) => applyFromWidgetValue(value).catch((error) => {
      setStatus(String(error.message || error));
    }),
    enableWidgetChanges: () => {
      acceptWidgetChanges = true;
    },
  };
  node.__pm4aMetaApplyApi = api;

  queueMicrotask(() => {
    acceptWidgetChanges = true;
  });

  return api;
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.MetaApply",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupMetaApplyNode(this);
    };
    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      const api = setupMetaApplyNode(this);
      const widget = imageWidget(this);
      if (widget?.value && api) {
        queueMicrotask(() => {
          api.enableWidgetChanges();
          void api.applyFromWidgetValue(widget.value);
        });
      }
      return result;
    };
  },
});
