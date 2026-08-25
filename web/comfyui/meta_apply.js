import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parsePromptDocument } from "/pm4a/static/image_prompt_metadata.js";
import {
  bindOfficialImageDrop,
  imageFileFromTransfer,
  looksLikeImageFile,
} from "/pm4a/static/image_drop.js";
import {
  buildStoredImageUrl,
  imageReferenceFromComboValue,
  imageReferenceLabel,
  normalizeStoredImageReference,
  uploadInputImage,
} from "./prompt_display_state.js";
import { configureComfyI18n, t } from "./i18n.js";
import {
  applyAllFromPayload,
  readImagePromptSnapshot,
} from "./meta_apply_core.js";
import { withSyncedDomWidth } from "./dom_widget_layout.js";

const NODE_CLASS = "Meta Apply (4A Prompt Manager)";
const PROMPT_DISPLAY_CLASS = "Prompt Display (4A Prompt Manager)";
const IMAGE_REF_PROPERTY = "pm4a_imported_image_ref";
const MIN_WIDGET_HEIGHT = 160;

function settingsApplyHostNode() {
  const graph = app.graph;
  const nodes = graph?._nodes || graph?.nodes || [];
  const preferred = nodes.find((node) => (
    node
    && (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS)
  ));
  if (preferred) return preferred;
  const display = nodes.find((node) => (
    node
    && (node.comfyClass === PROMPT_DISPLAY_CLASS || node.type === PROMPT_DISPLAY_CLASS)
  ));
  if (display) return display;
  return { graph, properties: {} };
}

const APPLY_FLAG_WIDGETS = {
  applyModel: ["自动应用模型", "apply_model"],
  applyLora: ["自动应用 LoRA", "apply_lora"],
  applyModelLora: ["自动应用模型/LoRA", "apply_model_lora"],
  applyParameters: ["自动应用推理参数", "apply_parameters"],
  applyPrompt: ["自动应用提示词", "apply_prompt"],
};

function readApplyFlags(node) {
  const valueOf = (names, fallback = true) => {
    const widget = node.widgets?.find((item) => names.includes(item.name));
    if (!widget) return fallback;
    return widget.value !== false;
  };
  const hasSplitModel = node.widgets?.some((item) => APPLY_FLAG_WIDGETS.applyModel.includes(item.name));
  const hasSplitLora = node.widgets?.some((item) => APPLY_FLAG_WIDGETS.applyLora.includes(item.name));
  const legacyModelLora = valueOf(APPLY_FLAG_WIDGETS.applyModelLora, true);
  return {
    applyModel: hasSplitModel ? valueOf(APPLY_FLAG_WIDGETS.applyModel) : legacyModelLora,
    applyLora: hasSplitLora ? valueOf(APPLY_FLAG_WIDGETS.applyLora) : legacyModelLora,
    applyParameters: valueOf(APPLY_FLAG_WIDGETS.applyParameters),
    applyPrompt: valueOf(APPLY_FLAG_WIDGETS.applyPrompt),
  };
}

function ensureMetaApplyStyles() {
  if (document.getElementById("pm4a-meta-apply-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-meta-apply-styles";
  style.textContent = `
    .pm4a-meta-apply-root {
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      padding: 4px 10px 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow: hidden;
      color: #c9ced3;
      font: 12px/1.35 system-ui, sans-serif;
    }
    .pm4a-meta-apply-root * { box-sizing: border-box; }
    .pm4a-meta-apply-preview {
      flex: 1 1 auto;
      min-height: 0;
      border: 1px solid #464a50;
      border-radius: 6px;
      background: #141618;
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .pm4a-meta-apply-preview img {
      width: 100%;
      height: 100%;
      min-height: 0;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
    }
    .pm4a-meta-apply-empty { max-width: 180px; color: #858c94; text-align: center; }
    .pm4a-meta-apply-pick {
      flex: 0 0 auto;
      height: 26px;
      border: 0;
      border-radius: 4px;
      color: #c9cdd1;
      background: #3a3e43;
      cursor: pointer;
      font: inherit;
    }
    .pm4a-meta-apply-pick:hover { color: #fff; background: #464b51; }
    .pm4a-meta-apply-status {
      flex: 0 0 auto;
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

function viewPath() {
  return api.fileURL?.("/view") || app.api?.apiURL?.("/view") || "/view";
}

function hideFilenameSlot(widget) {
  if (!widget) return;
  widget.hidden = true;
  widget.serialize = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  widget.computeSize = () => [0, -4];
}

function imageSlot(node) {
  return node.widgets?.find((widget) => widget.name === "image") || null;
}

function storedImageReference(node) {
  return normalizeStoredImageReference(node.properties?.[IMAGE_REF_PROPERTY])
    || imageReferenceFromComboValue(imageSlot(node)?.value);
}

function writeImageReference(node, reference) {
  node.properties = node.properties || {};
  node.properties[IMAGE_REF_PROPERTY] = reference;
  const widget = imageSlot(node);
  if (widget) widget.value = imageReferenceLabel(reference);
  node.graph?.change?.();
}

function setupMetaApplyNode(node) {
  if (node.__pm4aMetaApplyReady) return;
  node.__pm4aMetaApplyReady = true;
  configureComfyI18n(app);
  ensureMetaApplyStyles();
  hideFilenameSlot(imageSlot(node));

  const main = document.createElement("div");
  main.className = "pm4a-meta-apply-root";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());

  const preview = document.createElement("div");
  preview.className = "pm4a-meta-apply-preview";
  const previewImage = document.createElement("img");
  previewImage.alt = t("拖入图片预览");
  previewImage.draggable = false;
  previewImage.hidden = true;
  const previewEmpty = document.createElement("div");
  previewEmpty.className = "pm4a-meta-apply-empty";
  previewEmpty.textContent = t("选择或拖入预览图");
  preview.append(previewImage, previewEmpty);

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "pm4a-meta-apply-pick";
  pick.textContent = t("选择或拖入预览图");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.avif";
  fileInput.hidden = true;

  const status = document.createElement("div");
  status.className = "pm4a-meta-apply-status";
  status.setAttribute("aria-live", "polite");
  main.append(pick, fileInput, status, preview);

  let applyGeneration = 0;
  const setStatus = (message) => {
    const text = message || t("等待图片");
    status.textContent = text;
    status.title = text;
  };
  setStatus(t("等待图片"));

  const showStoredPreview = (reference) => {
    const url = buildStoredImageUrl(reference, viewPath());
    if (!url) {
      previewImage.removeAttribute("src");
      previewImage.hidden = true;
      previewEmpty.hidden = false;
      previewEmpty.textContent = t("选择或拖入预览图");
      return;
    }
    previewImage.src = url;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
  };
  previewImage.addEventListener("error", () => {
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = t("预览文件不可用，请重新拖入图片");
  });

  const restorePreview = () => {
    hideFilenameSlot(imageSlot(node));
    const reference = storedImageReference(node);
    if (!reference) return;
    writeImageReference(node, reference);
    showStoredPreview(reference);
  };

  const applyImage = async (file) => {
    if (!looksLikeImageFile(file)) {
      setStatus(t("仅支持常见图片格式（PNG、JPEG、WebP、GIF 等）"));
      return;
    }
    const generation = ++applyGeneration;
    setStatus(t("正在读取并应用元数据…"));
    try {
      const reference = await uploadInputImage(
        file,
        (url, init) => api.fetchApi(url, init),
      );
      if (generation !== applyGeneration) return;
      writeImageReference(node, reference);
      showStoredPreview(reference);
      const snapshot = await readImagePromptSnapshot(file);
      if (generation !== applyGeneration) return;
      const payload = parsePromptDocument(snapshot.promptJson);
      if (!payload) throw new Error(t("图片中没有识别到正面或负面提示词"));
      const result = await applyAllFromPayload(node, payload, readApplyFlags(node));
      if (generation !== applyGeneration) return;
      setStatus(result.message);
    } catch (error) {
      if (generation !== applyGeneration) return;
      setStatus(t(String(error.message || error)));
    }
  };

  const importTransfer = async (dataTransfer) => {
    try {
      const file = await imageFileFromTransfer(dataTransfer, { viewPath: viewPath() });
      if (!file) return false;
      await applyImage(file);
      return true;
    } catch (error) {
      setStatus(t(String(error.message || error)));
      return true;
    }
  };

  pick.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void applyImage(file);
  });

  bindOfficialImageDrop(main, { app, node, onDrop: importTransfer });

  let uiWidget = null;
  uiWidget = node.addDOMWidget("pm4a_meta_apply_ui", "pm4a_meta_apply", main, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => MIN_WIDGET_HEIGHT,
    getMaxHeight: () => {
      const measuredTop = Number(uiWidget?.last_y);
      const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0 ? measuredTop : 55;
      return Math.max(MIN_WIDGET_HEIGHT, Number(node.size?.[1] || 360) - widgetTop - 8);
    },
  }));
  node.resizable = true;
  if (!Array.isArray(node.size) || node.size[1] < 360) {
    node.setSize([315, 360]);
  }
  node.__pm4aMetaApplyRestorePreview = restorePreview;
  restorePreview();
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.MetaApply",

  setup() {
    api.addEventListener("pm4a_settings_apply", (event) => {
      const detail = event?.detail || {};
      const apply = String(detail.apply || "");
      if (!["models", "lora", "parameters"].includes(apply)) return;
      configureComfyI18n(app);
      const host = settingsApplyHostNode();
      const payload = {
        models: Array.isArray(detail.models) ? detail.models : [],
        loras: detail.loras && typeof detail.loras === "object"
          ? detail.loras
          : { text: "", hashes: [] },
        parameters: detail.parameters && typeof detail.parameters === "object"
          ? detail.parameters
          : {},
        double_sample_parameters: (
          detail.double_sample_parameters
          && typeof detail.double_sample_parameters === "object"
        )
          ? detail.double_sample_parameters
          : {},
      };
      void applyAllFromPayload(host, payload, {
        applyPrompt: false,
        applyModel: apply === "models",
        applyLora: apply === "lora",
        applyParameters: apply === "parameters",
      }).then((result) => {
        if (result?.message) console.info("[4A-PM]", result.message);
      }).catch((error) => {
        console.warn("[4A-PM] settings apply failed:", error?.message || error);
      });
    });
  },

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
      setupMetaApplyNode(this);
      this.__pm4aMetaApplyRestorePreview?.();
      return result;
    };
  },
});
