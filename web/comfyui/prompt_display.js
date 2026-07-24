import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  formatRawMetadataJson,
  parsePromptDocument,
  registerKnownSchedulers,
} from "/pm4a/static/image_prompt_metadata.js?v=17";
import { ADD_PROMPT_ICON, openPromptLibraryModal } from "./prompt_library_modal.js?v=compact-labels-2";
import {
  buildStoredImageUrl,
  imageReferenceFromUpload,
  imageReferenceLabel,
  normalizeStoredImageReference,
  resolvePromptDisplayRestoreState,
} from "./prompt_display_state.js?v=2";
import {
  fetchImageFile,
  hasSupportedImageTransfer,
  imageFileFromTransfer,
  looksLikeImageFile,
} from "/pm4a/static/image_drop.js?v=3";
import { configureComfyI18n, t } from "./i18n.js?v=1";
import {
  TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY,
  TARGET_LORA_PROPERTY,
  TARGET_NODE_PROPERTY,
  TARGET_PARAMETERS_PROPERTY,
  applyDoubleSampleFromPayload,
  applyInputParametersFromPayload,
  applyLoraFromPayload,
  applyModelsFromPayload,
  applyParameterSettingsFromPayload,
  applyPositiveFromPayload,
  connectedScheduler,
  conversionRepairNotice,
  convertNovelAITexts,
  displayModelType,
  displayTrackName,
  doubleSampleParameterNodes,
  findSourceScheduler,
  graphNodeById,
  inputParameterNodes,
  isScheduler,
  localeJoin,
  loraLoaderNodes,
  modelTargetLabel,
  modelTargetNodes,
  modelTargetSpec,
  readImagePromptSnapshot,
  schedulerNodes,
  setWidgetValue,
  syncBypassSwitchFromDoubleSample,
  withGraphChangeTransaction,
} from "./meta_apply_core.js?v=10";
import { withSyncedDomWidth } from "./dom_widget_layout.js";

const DISPLAY_NODE_CLASS = "Prompt Display (4A Prompt Manager)";
const LAST_JSON_PROPERTY = "pm4a_last_prompt_json";
const LAST_LIVE_JSON_PROPERTY = "pm4a_last_live_prompt_json";
const IMPORTED_FILE_PROPERTY = "pm4a_imported_file_name";
const IMPORTED_IMAGE_PROPERTY = "pm4a_imported_image_ref";
const PREVIEW_RATIO_PROPERTY = "pm4a_preview_ratio";
const PREVIEW_CACHE_MAX_FILES = 8;
const PREVIEW_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const previewFileCache = new Map();
let previewFileCacheBytes = 0;
const RETURN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M5 12h9a5 5 0 0 1 5 5"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/></svg>';
const APPLY_ALL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="11" height="8" rx="1.5"/><path d="M7 2h10a1.5 1.5 0 0 1 1.5 1.5V10M10 18h10M16 14l4 4-4 4"/></svg>';
const APPLY_PARAMETERS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h9M3 12h7M3 18h9M8 4v4M6 10v4M9 16v4M14 12h6M17 9l3 3-3 3"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';
const TRANSLATABLE_SOURCE_LABELS = new Set(["图片", "通用"]);

function displaySourceLabel(value) {
  const label = String(value || "图片");
  return TRANSLATABLE_SOURCE_LABELS.has(label) ? t(label) : label;
}

function previewCacheKey(fileName, promptJson) {
  const text = String(promptJson || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${String(fileName || "")}\u0000${text.length}\u0000${hash >>> 0}`;
}

function rememberPreviewFile(fileName, promptJson, file, metadata = null) {
  if (!(file instanceof Blob)) return;
  const key = previewCacheKey(fileName, promptJson);
  const previous = previewFileCache.get(key);
  if (previous) previewFileCacheBytes -= previous.size;
  const entry = {
    file,
    metadata: metadata && typeof metadata === "object" ? metadata : null,
    size: Number(file.size || 0),
  };
  previewFileCache.delete(key);
  previewFileCache.set(key, entry);
  previewFileCacheBytes += entry.size;
  while (
    previewFileCache.size > PREVIEW_CACHE_MAX_FILES
    || previewFileCacheBytes > PREVIEW_CACHE_MAX_BYTES
  ) {
    const oldestKey = previewFileCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = previewFileCache.get(oldestKey);
    previewFileCache.delete(oldestKey);
    previewFileCacheBytes -= Number(oldest?.size || 0);
  }
}

function recallPreviewFile(fileName, promptJson) {
  const key = previewCacheKey(fileName, promptJson);
  const entry = previewFileCache.get(key);
  if (!entry) return null;
  previewFileCache.delete(key);
  previewFileCache.set(key, entry);
  return entry;
}

function injectStyles() {
  if (document.getElementById("pm4a-prompt-display-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-prompt-display-styles";
  style.textContent = `
    .pm4a-prompt-display { width:100%; height:100%; min-height:0; padding:0 4px 2px; display:flex; flex-direction:column; gap:7px; overflow:hidden; box-sizing:border-box; color:#e8e8e8; background:transparent; border:0; border-radius:0; font:12px/1.35 system-ui,sans-serif; }
    .pm4a-prompt-display * { box-sizing:border-box; }
    .pm4a-display-summary { min-height:28px; padding:3px 5px 3px 7px; display:flex; align-items:center; gap:6px; border:1px solid #464a50; border-radius:5px; background:#292c30; }
    .pm4a-display-summary-title { flex:1; min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e6e8ea; font-weight:700; }
    .pm4a-display-status { min-width:0; max-width:42%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9ca3aa; text-align:right; }
    .pm4a-display-target { width:126px; height:24px; min-width:0; padding:2px 5px; border:1px solid #4b4f55; border-radius:4px; color:#ddd; background:#1b1d20; font:inherit; }
    .pm4a-display-live-button, .pm4a-display-meta-button { height:24px; padding:2px 7px; border:0; border-radius:4px; color:#c9cdd1; background:#3a3e43; cursor:pointer; font:inherit; white-space:nowrap; }
    .pm4a-display-live-button:hover, .pm4a-display-meta-button:hover { color:#fff; background:#464b51; }
    .pm4a-display-workspace { flex:1; min-height:0; display:flex; gap:0; overflow:hidden; }
    .pm4a-display-preview { flex:0 0 34%; min-width:120px; min-height:0; overflow:hidden; display:flex; flex-direction:column; border:1px solid #464a50; border-radius:6px; background:#202327; }
    .pm4a-display-preview[hidden] { display:none; }
    .pm4a-display-preview-frame { flex:1; min-height:0; padding:6px; display:grid; place-items:center; overflow:hidden; background:#141618; }
    .pm4a-display-preview-image { width:100%; height:100%; min-height:0; display:block; object-fit:contain; user-select:none; -webkit-user-drag:none; }
    .pm4a-display-preview-image[hidden] { display:none; }
    .pm4a-display-preview-empty { max-width:170px; color:#858c94; text-align:center; line-height:1.5; }
    .pm4a-display-preview-empty[hidden] { display:none; }
    .pm4a-display-preview-size { flex:0 0 auto; min-height:27px; padding:5px 8px; display:flex; align-items:center; justify-content:center; border-top:1px solid #3f4348; color:#aab1b8; background:#202327; font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace; user-select:text; }
    .pm4a-display-preview-size[hidden] { display:none; }
    .pm4a-display-splitter { position:relative; flex:0 0 13px; min-height:0; cursor:col-resize; touch-action:none; user-select:none; }
    .pm4a-display-splitter[hidden] { display:none; }
    .pm4a-display-splitter::before { content:""; position:absolute; top:0; bottom:0; left:6px; width:1px; border-radius:2px; background:#4b5056; transition:width .12s ease,left .12s ease,background .12s ease,box-shadow .12s ease; }
    .pm4a-display-splitter:hover::before, .pm4a-display-splitter.active::before { left:5px; width:3px; background:#159eff; box-shadow:0 0 5px rgba(21,158,255,.55); }
    .pm4a-display-list { flex:1 1 auto; min-width:240px; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:7px; padding-right:3px; scrollbar-width:thin; }
    .pm4a-display-empty { padding:18px 12px; border:1px dashed #4b4f55; border-radius:6px; color:#9298a0; text-align:center; }
    .pm4a-display-card { flex:0 0 auto; overflow:hidden; border:1px solid #464a50; border-radius:6px; background:#292c30; }
    .pm4a-display-card.negative { border-color:#59464b; background:#2b2729; }
    .pm4a-display-card.parameters { border-color:#46535b; background:#292e31; }
    .pm4a-display-card.double-sample { border-color:#4b5363; background:#292d35; }
    .pm4a-display-card.lora { border-color:#554a63; background:#2d2932; }
    .pm4a-display-card.hashes { border-color:#4d5057; background:#2a2c30; }
    .pm4a-display-card.models { border-color:#4a555e; background:#292e32; }
    .pm4a-display-card-header { min-height:28px; padding:2px 6px 2px 9px; display:flex; align-items:center; gap:6px; background:#30343a; }
    .pm4a-display-card.negative .pm4a-display-card-header { color:#e0b5bd; background:#342d30; }
    .pm4a-display-card.parameters .pm4a-display-card-header { background:#30383d; }
    .pm4a-display-card.double-sample .pm4a-display-card-header { background:#323844; color:#cbd7eb; }
    .pm4a-display-card.lora .pm4a-display-card-header { background:#39313f; color:#d7c4e8; }
    .pm4a-display-card.hashes .pm4a-display-card-header { background:#34363b; }
    .pm4a-display-card.models .pm4a-display-card-header { background:#313940; }
    .pm4a-display-card-title-group { flex:1; min-width:0; display:flex; align-items:center; gap:3px; }
    .pm4a-display-card-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
    .pm4a-display-copy, .pm4a-display-add, .pm4a-display-return { width:24px; height:24px; flex:0 0 24px; padding:2px; display:grid; place-items:center; border:0; border-radius:4px; color:#c5c9ce; background:transparent; cursor:pointer; }
    .pm4a-display-copy:hover, .pm4a-display-add:hover, .pm4a-display-return:hover { background:#3b4046; }
    .pm4a-display-copy:disabled, .pm4a-display-add:disabled, .pm4a-display-return:disabled { opacity:.35; cursor:default; background:transparent; }
    .pm4a-display-copy svg, .pm4a-display-add svg, .pm4a-display-return svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .pm4a-display-parameter-target, .pm4a-display-double-sample-target, .pm4a-display-lora-target, .pm4a-display-model-target { width:142px; height:24px; min-width:0; padding:2px 5px; border:1px solid #4b5359; border-radius:4px; color:#ddd; background:#1b1d20; font:inherit; }
    .pm4a-display-model-target { width:132px; flex:0 1 132px; }
    .pm4a-display-parameter-grid { padding:5px; display:flex; flex-wrap:wrap; align-items:stretch; gap:4px; border-top:1px solid #424b50; }
    .pm4a-display-parameter-item { flex:0 0 auto; width:max-content; max-width:100%; min-width:0; padding:3px 6px; display:flex; align-items:baseline; gap:5px; border:1px solid #454d52; border-radius:4px; background:#1b1e20; }
    .pm4a-display-parameter-label { flex:0 0 auto; color:#99a2aa; font-size:10px; font-weight:650; letter-spacing:0.04em; line-height:1.2; }
    .pm4a-display-parameter-value { min-width:0; white-space:nowrap; color:#e7e9ea; font-size:12px; user-select:text; }
    .pm4a-display-hash-list { padding:5px 6px; display:flex; flex-direction:column; gap:4px; border-top:1px solid #464950; }
    .pm4a-display-hash-list[hidden] { display:none; }
    .pm4a-display-hash-row { min-height:27px; padding:2px 3px 2px 7px; display:flex; align-items:center; gap:7px; border:1px solid #45484e; border-radius:4px; background:#1b1d20; }
    .pm4a-display-hash-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d9dcdf; user-select:text; }
    .pm4a-display-hash-value { flex:0 1 auto; max-width:45%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aeb8c2; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; user-select:text; }
    .pm4a-display-hash-row .pm4a-display-copy { width:22px; height:22px; flex-basis:22px; }
    .pm4a-display-collapse { width:22px; height:22px; flex:0 0 22px; padding:2px; display:grid; place-items:center; border:0; border-radius:4px; color:#c2c7cc; background:transparent; cursor:pointer; }
    .pm4a-display-collapse:hover { background:#41454a; }
    .pm4a-display-collapse svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; transition:transform .14s ease; }
    .pm4a-display-collapse.expanded svg { transform:rotate(180deg); }
    .pm4a-display-model-type { flex:0 0 58px; color:#94a8b8; }
    .pm4a-display-model-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e2e6e9; user-select:text; }
    .pm4a-display-card-body { padding:6px; border-top:1px solid #42464b; }
    .pm4a-display-card.negative .pm4a-display-card-body { border-top-color:#4e3d42; }
    .pm4a-display-text { width:100%; height:46px; min-height:46px; max-height:none; padding:5px 7px; resize:none; overflow:hidden; border:1px solid #4b4f55; border-radius:4px; color:#eceeef; background:#151719; font:12px/1.4 system-ui,sans-serif; user-select:text; cursor:text; }
    .pm4a-display-text::placeholder { color:#777d84; }
    .pm4a-raw-meta-overlay { position:fixed; inset:0; z-index:100000; padding:24px; display:grid; place-items:center; background:rgba(7,9,11,.74); backdrop-filter:blur(2px); }
    .pm4a-raw-meta-dialog { width:min(920px,calc(100vw - 48px)); height:min(760px,calc(100vh - 48px)); min-width:320px; min-height:240px; overflow:hidden; display:flex; flex-direction:column; border:1px solid #596069; border-radius:8px; color:#e7e9eb; background:#202327; box-shadow:0 18px 55px rgba(0,0,0,.55); font:12px/1.5 system-ui,sans-serif; }
    .pm4a-raw-meta-header { flex:0 0 auto; min-height:42px; padding:6px 8px 6px 12px; display:flex; align-items:center; gap:10px; border-bottom:1px solid #454a50; background:#2b2f34; }
    .pm4a-raw-meta-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
    .pm4a-raw-meta-actions { display:flex; align-items:center; gap:6px; }
    .pm4a-raw-meta-actions button { height:28px; padding:3px 10px; border:1px solid #50565d; border-radius:5px; color:#d8dce0; background:#373c42; cursor:pointer; font:inherit; }
    .pm4a-raw-meta-actions button:hover { color:#fff; background:#444a51; }
    .pm4a-raw-meta-content { flex:1; min-height:0; margin:0; padding:12px 14px 18px; overflow:auto; color:#d8dde2; background:#151719; font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:2; user-select:text; scrollbar-width:thin; }
  `;
  document.head.appendChild(style);
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

function extractJson(message) {
  return firstString(message?.pm4a_prompt_json)
    ?? firstString(message?.output?.pm4a_prompt_json)
    ?? firstString(message?.ui?.pm4a_prompt_json);
}

function extractLiveJson(message) {
  return firstString(message?.pm4a_live_prompt_json)
    ?? firstString(message?.output?.pm4a_live_prompt_json)
    ?? firstString(message?.ui?.pm4a_live_prompt_json);
}

function extractSource(message) {
  return firstString(message?.pm4a_prompt_source)
    ?? firstString(message?.output?.pm4a_prompt_source)
    ?? firstString(message?.ui?.pm4a_prompt_source)
    ?? "scheduler";
}

function viewPath() {
  return app.api?.apiURL?.("/view") || "/view";
}

async function uploadInputImage(file) {
  const form = new FormData();
  form.append("image", file, file.name || "imported-image");
  form.append("type", "input");
  const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || t("图片持久化失败：{status}", { status: response.status }));
  }
  const reference = imageReferenceFromUpload(payload);
  if (!reference) throw new Error(t("图片上传成功，但返回的文件引用无效"));
  return reference;
}

function openRawMetadataModal(metadata, fileName = "") {
  const text = formatRawMetadataJson(metadata);
  const overlay = document.createElement("div");
  overlay.className = "pm4a-raw-meta-overlay";
  overlay.setAttribute("role", "presentation");

  const dialog = document.createElement("section");
  dialog.className = "pm4a-raw-meta-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t("完整图片 Meta"));

  const header = document.createElement("header");
  header.className = "pm4a-raw-meta-header";
  const title = document.createElement("strong");
  title.className = "pm4a-raw-meta-title";
  title.textContent = fileName ? t("完整 Meta · {fileName}", { fileName }) : t("完整 Meta");
  title.title = title.textContent;

  const actions = document.createElement("div");
  actions.className = "pm4a-raw-meta-actions";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = t("复制全部");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = t("关闭");
  actions.append(copyButton, closeButton);
  header.append(title, actions);

  const content = document.createElement("pre");
  content.className = "pm4a-raw-meta-content";
  content.textContent = text;
  dialog.append(header, content);
  overlay.appendChild(dialog);

  const close = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  overlay.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (event.target === overlay) close();
  });
  overlay.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  dialog.addEventListener("pointerdown", (event) => event.stopPropagation());
  closeButton.onclick = close;
  copyButton.onclick = async () => {
    try {
      await writeClipboardText(text);
      copyButton.textContent = t("已复制");
      window.setTimeout(() => { copyButton.textContent = t("复制全部"); }, 1200);
    } catch (error) {
      copyButton.textContent = t("复制失败");
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  document.body.appendChild(overlay);
  closeButton.focus();
}

function hideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  widget.computeSize = () => [0, -4];
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error(t("浏览器拒绝了复制操作"));
}

function setupDisplayNode(node) {
  if (node.__pm4aPromptDisplayReady) return;
  node.__pm4aPromptDisplayReady = true;
  configureComfyI18n(app);
  injectStyles();

  const getImportedWidget = () => node.widgets?.find((widget) => widget.name === "imported_json");
  hideWidget(getImportedWidget());

  const main = document.createElement("div");
  main.className = "pm4a-prompt-display";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());
  main.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

  const summary = document.createElement("div");
  summary.className = "pm4a-display-summary";
  const summaryTitle = document.createElement("div");
  summaryTitle.className = "pm4a-display-summary-title";
  summaryTitle.textContent = t("等待本次输出");
  const status = document.createElement("div");
  status.className = "pm4a-display-status";
  const targetSelect = document.createElement("select");
  targetSelect.className = "pm4a-display-target";
  targetSelect.hidden = true;
  targetSelect.title = t("选择栏目回填目标");
  const rawMetaButton = document.createElement("button");
  rawMetaButton.type = "button";
  rawMetaButton.className = "pm4a-display-meta-button";
  rawMetaButton.textContent = t("查看完整 Meta");
  rawMetaButton.title = t("查看图片中读取到的全部原始 metadata");
  rawMetaButton.hidden = true;
  const liveButton = document.createElement("button");
  liveButton.type = "button";
  liveButton.className = "pm4a-display-live-button";
  liveButton.textContent = t("恢复实时");
  liveButton.title = t("清除图片快照，重新跟随 Scheduler");
  liveButton.hidden = true;
  summary.append(summaryTitle, status, targetSelect, rawMetaButton, liveButton);

  const list = document.createElement("div");
  list.className = "pm4a-display-list";
  const workspace = document.createElement("div");
  workspace.className = "pm4a-display-workspace";
  const preview = document.createElement("section");
  preview.className = "pm4a-display-preview";
  preview.hidden = true;
  const previewFrame = document.createElement("div");
  previewFrame.className = "pm4a-display-preview-frame";
  const previewImage = document.createElement("img");
  previewImage.className = "pm4a-display-preview-image";
  previewImage.alt = t("拖入图片预览");
  previewImage.draggable = false;
  previewImage.hidden = true;
  const previewEmpty = document.createElement("div");
  previewEmpty.className = "pm4a-display-preview-empty";
  previewEmpty.textContent = t("重新拖入图片即可预览");
  previewFrame.append(previewImage, previewEmpty);
  const previewSize = document.createElement("div");
  previewSize.className = "pm4a-display-preview-size";
  previewSize.title = t("载入图片的实际像素尺寸");
  previewSize.hidden = true;
  preview.append(previewFrame, previewSize);
  const splitter = document.createElement("div");
  splitter.className = "pm4a-display-splitter";
  splitter.hidden = true;
  splitter.title = t("拖动调整图片预览宽度");
  workspace.append(preview, splitter, list);
  main.append(summary, workspace);

  node.properties = node.properties || {};
  let previewRatio = Number(node.properties[PREVIEW_RATIO_PROPERTY]);
  if (!Number.isFinite(previewRatio)) previewRatio = 0.34;
  previewRatio = Math.min(0.68, Math.max(0.18, previewRatio));
  const applyPreviewRatio = () => {
    preview.style.flexBasis = `${previewRatio * 100}%`;
  };
  applyPreviewRatio();
  node.__pm4aPromptDisplayRestoreLayout = () => {
    const storedRatio = Number(node.properties?.[PREVIEW_RATIO_PROPERTY]);
    if (Number.isFinite(storedRatio)) {
      previewRatio = Math.min(0.68, Math.max(0.18, storedRatio));
      applyPreviewRatio();
    }
    scheduleTextResize();
  };

  let textResizeFrame = 0;
  const resizeDisplayTexts = () => {
    textResizeFrame = 0;
    for (const text of list.querySelectorAll(".pm4a-display-text")) {
      text.style.height = "0px";
      text.style.height = `${Math.max(46, Math.ceil(text.scrollHeight) + 2)}px`;
    }
  };
  const scheduleTextResize = () => {
    if (textResizeFrame) cancelAnimationFrame(textResizeFrame);
    textResizeFrame = requestAnimationFrame(resizeDisplayTexts);
  };
  const listResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(scheduleTextResize)
    : null;
  listResizeObserver?.observe(list);

  let splitterPointerId = null;
  const resizePreviewFromPointer = (event) => {
    const rect = workspace.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const splitterWidth = splitter.getBoundingClientRect().width || 13;
    const availableWidth = Math.max(1, rect.width - splitterWidth);
    const minPreview = Math.min(120, availableWidth * 0.45);
    const minList = Math.min(240, availableWidth * 0.55);
    const previewWidth = Math.min(
      availableWidth - minList,
      Math.max(minPreview, event.clientX - rect.left),
    );
    previewRatio = Math.min(0.68, Math.max(0.18, previewWidth / availableWidth));
    node.properties[PREVIEW_RATIO_PROPERTY] = previewRatio;
    applyPreviewRatio();
    scheduleTextResize();
    node.setDirtyCanvas?.(true, true);
  };
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    splitterPointerId = event.pointerId;
    splitter.classList.add("active");
    splitter.setPointerCapture?.(event.pointerId);
    resizePreviewFromPointer(event);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (event.pointerId !== splitterPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizePreviewFromPointer(event);
  });
  const finishSplitterDrag = (event) => {
    if (event.pointerId !== splitterPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (splitter.hasPointerCapture?.(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    splitterPointerId = null;
    splitter.classList.remove("active");
    app.graph?.setDirtyCanvas?.(true, true);
  };
  splitter.addEventListener("pointerup", finishSplitterDrag);
  splitter.addEventListener("pointercancel", finishSplitterDrag);

  let previewObjectUrl = "";
  let previewPersistentUrl = "";
  let previewFileName = "";
  let previewSourceFile = null;
  let libraryModalOpen = false;
  let rawImageMetadata = null;
  const setRawImageMetadata = (metadata) => {
    rawImageMetadata = metadata && typeof metadata === "object" ? metadata : null;
    rawMetaButton.hidden = !rawImageMetadata;
  };
  const setPreviewSize = (width, height) => {
    const actualWidth = Math.trunc(Number(width));
    const actualHeight = Math.trunc(Number(height));
    const valid = actualWidth > 0 && actualHeight > 0;
    previewSize.hidden = !valid;
    previewSize.textContent = valid ? `${actualWidth} × ${actualHeight} px` : "";
  };
  previewImage.addEventListener("load", () => {
    setPreviewSize(previewImage.naturalWidth, previewImage.naturalHeight);
  });
  previewImage.addEventListener("error", () => {
    previewPersistentUrl = "";
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = t("预览文件不可用，请重新拖入图片");
  });
  rawMetaButton.onclick = () => {
    if (!rawImageMetadata) return;
    openRawMetadataModal(
      rawImageMetadata,
      previewFileName || node.properties?.[IMPORTED_FILE_PROPERTY] || "",
    );
  };
  const clearImagePreview = (hide = true) => {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = "";
    previewPersistentUrl = "";
    previewFileName = "";
    previewSourceFile = null;
    setRawImageMetadata(null);
    setPreviewSize(0, 0);
    previewImage.removeAttribute("src");
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = t("重新拖入图片即可预览");
    if (hide) {
      preview.hidden = true;
      splitter.hidden = true;
    }
  };
  const showImagePreview = (file, metadata = null, fileName = "") => {
    clearImagePreview(false);
    previewSourceFile = file;
    setRawImageMetadata(metadata);
    previewObjectUrl = URL.createObjectURL(file);
    previewFileName = String(fileName || file?.name || "");
    previewImage.src = previewObjectUrl;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
    preview.hidden = false;
    splitter.hidden = false;
    scheduleTextResize();
  };
  const showStoredImagePreview = (reference, metadata = null) => {
    const normalized = normalizeStoredImageReference(reference);
    const viewPath = api.fileURL?.("/view") || "/view";
    const url = buildStoredImageUrl(normalized, viewPath);
    if (!normalized || !url) return false;
    clearImagePreview(false);
    previewPersistentUrl = url;
    previewFileName = imageReferenceLabel(normalized);
    setRawImageMetadata(metadata);
    previewImage.src = url;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
    preview.hidden = false;
    splitter.hidden = false;
    scheduleTextResize();
    return true;
  };
  const resolveLibraryPreviewFile = async () => {
    if (previewSourceFile instanceof Blob) return previewSourceFile;
    const sourceUrl = previewPersistentUrl;
    if (!sourceUrl) return null;
    const reference = normalizeStoredImageReference(
      node.properties?.[IMPORTED_IMAGE_PROPERTY],
    );
    try {
      const file = await fetchImageFile(
        sourceUrl,
        reference?.filename || previewFileName || "preview.png",
      );
      if (previewPersistentUrl !== sourceUrl) {
        return previewSourceFile instanceof Blob ? previewSourceFile : null;
      }
      previewSourceFile = file;
      return file;
    } catch (error) {
      setStatus(t("当前预览图读取失败：{error}", { error: error.message || error }));
      return null;
    }
  };
  const syncImagePreview = (source, fileName = "", promptJson = "") => {
    if (source !== "image") {
      clearImagePreview(true);
      return;
    }
    const nextFileName = String(fileName || "");
    if (previewObjectUrl && previewFileName === nextFileName) {
      preview.hidden = false;
      splitter.hidden = false;
      return;
    }
    const storedReference = normalizeStoredImageReference(
      node.properties?.[IMPORTED_IMAGE_PROPERTY],
    );
    const storedUrl = buildStoredImageUrl(
      storedReference,
      api.fileURL?.("/view") || "/view",
    );
    if (storedUrl && previewPersistentUrl === storedUrl) {
      preview.hidden = false;
      splitter.hidden = false;
      return;
    }
    const cachedEntry = recallPreviewFile(nextFileName, promptJson);
    if (cachedEntry) {
      showImagePreview(cachedEntry.file, cachedEntry.metadata, nextFileName);
      return;
    }
    if (showStoredImagePreview(storedReference)) return;
    clearImagePreview(false);
    preview.hidden = false;
    splitter.hidden = false;
    scheduleTextResize();
  };

  const setStatus = (message) => { status.textContent = message || ""; };

  const refreshTargetSelect = (payload) => {
    const graph = node.graph || app.graph;
    const schedulers = schedulerNodes(graph);
    const unambiguous = connectedScheduler(node)
      || (isScheduler(graphNodeById(graph, payload?.scheduler_node_id))
        ? graphNodeById(graph, payload.scheduler_node_id)
        : null)
      || (schedulers.length === 1 ? schedulers[0] : null);
    targetSelect.hidden = Boolean(unambiguous) || schedulers.length < 2;
    if (targetSelect.hidden) return;

    const previous = String(node.properties?.[TARGET_NODE_PROPERTY] || "");
    targetSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("选择 Scheduler");
    targetSelect.appendChild(placeholder);
    for (const scheduler of schedulers) {
      const option = document.createElement("option");
      option.value = String(scheduler.id);
      option.textContent = scheduler.title || `Scheduler #${scheduler.id}`;
      targetSelect.appendChild(option);
    }
    targetSelect.value = schedulers.some((scheduler) => String(scheduler.id) === previous) ? previous : "";
  };

  targetSelect.onchange = () => {
    node.properties = node.properties || {};
    node.properties[TARGET_NODE_PROPERTY] = targetSelect.value;
    setStatus(targetSelect.value ? t("已选择回填目标") : "");
  };

  const sendBack = async (entry, payload) => {
    const scheduler = findSourceScheduler(node, payload);
    if (!scheduler) {
      setStatus(t("请先选择 Scheduler"));
      return;
    }
    try {
      if (payload?.source_type === "novelai") setStatus(t("正在转换 NovelAI 权重…"));
      const results = await convertNovelAITexts(payload, [entry.text]);
      const converted = { ...entry, text: results[0]?.text ?? entry.text };
      const displayName = displayTrackName(entry);
      const accepted = scheduler.__pm4aSchedulerReceiveTrack?.(converted, "replace");
      const notice = conversionRepairNotice(results);
      setStatus(accepted
        ? t("已回填“{name}”{notice}", { name: displayName, notice })
        : t("未找到“{name}”栏目", { name: displayName }));
    } catch (error) {
      setStatus(t("NovelAI 转换失败：{error}", { error: error.message || error }));
    }
  };

  const sendAllPositive = async (payload) => {
    try {
      if (payload?.source_type === "novelai") setStatus(t("正在转换 NovelAI 权重…"));
      setStatus(await applyPositiveFromPayload(node, payload));
    } catch (error) {
      setStatus(String(error.message || error));
    }
  };

  const createModelsCard = (models) => {
    if (!Array.isArray(models) || !models.length) return null;
    const formatModel = (entry) => [
      `${displayModelType(entry.type)}: ${entry.name || t("未记录名称")}`,
      entry.hash ? `Hash: ${entry.hash}` : "",
      entry.model_version_id ? t("Civitai 版本: {id}", { id: entry.model_version_id }) : "",
    ].filter(Boolean).join("\n");

    const card = document.createElement("section");
    card.className = "pm4a-display-card models";
    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = t("使用模型");
    const copyAll = document.createElement("button");
    copyAll.type = "button";
    copyAll.className = "pm4a-display-copy";
    copyAll.innerHTML = COPY_ICON;
    copyAll.title = t("复制全部模型信息");
    copyAll.setAttribute("aria-label", copyAll.title);
    copyAll.onclick = async () => {
      try {
        await writeClipboardText(models.map(formatModel).join("\n\n"));
        setStatus(t("已复制全部模型信息"));
      } catch (error) {
        setStatus(t("复制失败：{error}", { error: error.message || error }));
      }
    };
    titleGroup.append(title, copyAll);
    header.appendChild(titleGroup);

    const rows = document.createElement("div");
    rows.className = "pm4a-display-hash-list";
    const applyModelActions = [];
    let primaryModelControls = null;
    for (const entry of models) {
      const row = document.createElement("div");
      row.className = "pm4a-display-hash-row";
      const type = document.createElement("span");
      type.className = "pm4a-display-model-type";
      type.textContent = displayModelType(entry.type);
      const name = document.createElement("span");
      name.className = "pm4a-display-model-name";
      name.textContent = entry.name || t("未记录名称");
      name.title = name.textContent;
      row.append(type, name);
      if (entry.hash) {
        const hash = document.createElement("span");
        hash.className = "pm4a-display-hash-value";
        hash.textContent = entry.hash;
        hash.title = entry.hash;
        row.appendChild(hash);
      } else if (entry.model_version_id) {
        const version = document.createElement("span");
        version.className = "pm4a-display-hash-value";
        version.textContent = `Civitai #${entry.model_version_id}`;
        version.title = t("Civitai 模型版本 {id}", { id: entry.model_version_id });
        row.appendChild(version);
      }
      const widgetNames = modelTargetSpec(entry);
      if (widgetNames) {
        const targetSelect = document.createElement("select");
        targetSelect.className = "pm4a-display-model-target";
        targetSelect.title = t("选择模型 Loader");
        const propertyKey = `pm4a_target_model_${widgetNames.join("_")}`;
        let targetMap = new Map();
        const refreshModelTargets = () => {
          const targets = modelTargetNodes(node.graph || app.graph, widgetNames);
          const previous = String(node.properties?.[propertyKey] || "");
          targetMap = new Map();
          targetSelect.replaceChildren();
          if (targets.length > 1) {
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = t("选择模型 Loader");
            targetSelect.appendChild(placeholder);
          }
          targets.forEach((target, index) => {
            const key = `${target.node.id}:${target.widgetName}:${index}`;
            targetMap.set(key, target);
            const option = document.createElement("option");
            option.value = key;
            option.textContent = modelTargetLabel(target);
            targetSelect.appendChild(option);
          });
          if (targetMap.has(previous)) targetSelect.value = previous;
          else if (targets.length === 1) targetSelect.value = targetMap.keys().next().value;
          else targetSelect.value = "";
          targetSelect.hidden = targets.length < 2;
          return targets;
        };
        refreshModelTargets();
        targetSelect.onchange = () => {
          node.properties = node.properties || {};
          node.properties[propertyKey] = targetSelect.value;
          setStatus(targetSelect.value ? t("已选择模型 Loader") : "");
        };

        const send = document.createElement("button");
        send.type = "button";
        send.className = "pm4a-display-return";
        send.innerHTML = RETURN_ICON;
        send.title = t("使用这个{type}", { type: displayModelType(entry.type) });
        send.setAttribute("aria-label", send.title);
        const applyModel = async () => {
          const targets = refreshModelTargets();
          if (!targets.length) {
            throw new Error(t("工作流中没有兼容的 Checkpoint / UNet Loader"));
          }
          if (!targetMap.get(targetSelect.value)) {
            throw new Error(t("请先选择模型 Loader"));
          }
          node.properties = node.properties || {};
          node.properties[propertyKey] = targetSelect.value;
          const { applied, errors } = await applyModelsFromPayload(node, { models: [entry] });
          if (errors.length) {
            const raw = String(errors[0] || "");
            const trimmed = raw.replace(/^[^：:]+[：:]\s*/, "");
            throw new Error(trimmed || raw);
          }
          if (!applied[0]) throw new Error(t("模型 Loader 尚未准备好"));
          return applied[0];
        };
        applyModelActions.push({ entry, apply: applyModel });
        send.onclick = async () => {
          send.disabled = true;
          setStatus(t("正在匹配本地模型…"));
          try {
            const result = await applyModel();
            const matched = result.match === "hash"
              ? t("（Hash 匹配）")
              : result.match === "version" ? t("（Civitai 版本匹配）") : "";
            setStatus(t("已使用“{value}”{matched}", { value: result.value, matched }));
          } catch (error) {
            setStatus(t("模型发送失败：{error}", { error: error.message || error }));
          } finally {
            send.disabled = false;
          }
        };
        if (!primaryModelControls) primaryModelControls = { targetSelect, send };
      }
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "pm4a-display-copy";
      copy.innerHTML = COPY_ICON;
      copy.title = t("复制 {type} 信息", { type: displayModelType(entry.type) });
      copy.setAttribute("aria-label", copy.title);
      copy.onclick = async () => {
        try {
          await writeClipboardText(formatModel(entry));
          setStatus(t("已复制“{type}”信息", { type: displayModelType(entry.type) }));
        } catch (error) {
          setStatus(t("复制失败：{error}", { error: error.message || error }));
        }
      };
      row.appendChild(copy);
      rows.appendChild(row);
    }
    if (primaryModelControls) {
      header.append(primaryModelControls.targetSelect, primaryModelControls.send);
    }
    card.append(header, rows);
    card.__pm4aApplyModels = async () => {
      const applied = [];
      const errors = [];
      for (const action of applyModelActions) {
        try {
          applied.push(await action.apply());
        } catch (error) {
          errors.push(t("{key}：{error}", { key: displayModelType(action.entry.type), error: error.message || error }));
        }
      }
      return { applied, errors };
    };
    return card;
  };

  const createParametersCard = (parameters) => {
    if (!parameters || typeof parameters !== "object") return null;
    const fields = [];
    const addField = (label, value) => {
      if (value === undefined || value === null || value === "") return;
      fields.push([label, String(value)]);
    };
    addField("Seed", parameters.seed);
    addField("Steps", parameters.steps);
    addField("CFG", parameters.cfg);
    addField("Sampler", parameters.sampler || parameters.sampler_raw);
    addField("Scheduler", parameters.scheduler);
    addField("Denoise", parameters.denoise);
    if (parameters.width && parameters.height) {
      addField(t("尺寸"), `${parameters.width} × ${parameters.height}`);
    }
    if (!fields.length) return null;

    const card = document.createElement("section");
    card.className = "pm4a-display-card parameters";
    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = t("生成参数");
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    titleGroup.appendChild(title);

    const parameterTarget = document.createElement("select");
    parameterTarget.className = "pm4a-display-parameter-target";
    parameterTarget.title = t("选择参数发送目标");
    const refreshParameterTargets = () => {
      const graph = node.graph || app.graph;
      const targets = inputParameterNodes(graph);
      const previous = String(node.properties?.[TARGET_PARAMETERS_PROPERTY] || "");
      parameterTarget.replaceChildren();
      if (targets.length > 1) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("选择参数节点");
        parameterTarget.appendChild(placeholder);
      }
      for (const target of targets) {
        const option = document.createElement("option");
        option.value = String(target.id);
        option.textContent = target.title || t("参数节点 #{id}", { id: target.id });
        parameterTarget.appendChild(option);
      }
      const remembered = targets.find((target) => String(target.id) === previous);
      if (remembered) parameterTarget.value = previous;
      else if (targets.length === 1) parameterTarget.value = String(targets[0].id);
      else parameterTarget.value = "";
      parameterTarget.hidden = targets.length < 2;
    };
    refreshParameterTargets();
    parameterTarget.onchange = () => {
      node.properties = node.properties || {};
      node.properties[TARGET_PARAMETERS_PROPERTY] = parameterTarget.value;
      setStatus(parameterTarget.value ? t("已选择参数目标") : "");
    };

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "pm4a-display-return";
    sendButton.innerHTML = RETURN_ICON;
    sendButton.title = t("发送到 4A Input Parameters");
    sendButton.setAttribute("aria-label", sendButton.title);
    const applyParameters = () => {
      refreshParameterTargets();
      if (parameterTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_PARAMETERS_PROPERTY] = parameterTarget.value;
      }
      const message = applyInputParametersFromPayload(node, { parameters });
      if (!message) throw new Error(t("没有可发送的生成参数"));
      // Single-pass send also turns Bypass OFF when a switch exists.
      const bypassMessage = syncBypassSwitchFromDoubleSample(node, false);
      return {
        message: localeJoin([message, bypassMessage].filter(Boolean), { zh: "；", en: "; " }),
      };
    };
    sendButton.onclick = () => {
      try {
        setStatus(applyParameters().message);
      } catch (error) {
        setStatus(t("参数发送失败：{error}", { error: error.message || error }));
      }
    };
    header.append(titleGroup, parameterTarget, sendButton);

    const grid = document.createElement("div");
    grid.className = "pm4a-display-parameter-grid";
    for (const [labelText, valueText] of fields) {
      const item = document.createElement("div");
      item.className = "pm4a-display-parameter-item";
      const label = document.createElement("span");
      label.className = "pm4a-display-parameter-label";
      label.textContent = labelText;
      const value = document.createElement("span");
      value.className = "pm4a-display-parameter-value";
      value.textContent = valueText;
      value.title = valueText;
      item.append(label, value);
      grid.appendChild(item);
    }
    card.append(header, grid);
    card.__pm4aCommitTargets = () => {
      refreshParameterTargets();
      if (parameterTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_PARAMETERS_PROPERTY] = parameterTarget.value;
      }
    };
    return card;
  };

  const createDoubleSampleParametersCard = (parameters) => {
    if (!parameters || typeof parameters !== "object") return null;
    const fields = [];
    const addField = (label, value) => {
      if (value === undefined || value === null || value === "") return;
      fields.push([label, String(value)]);
    };
    addField("Seed", parameters.seed);
    addField("Steps", parameters.steps);
    addField("CFG", parameters.cfg);
    addField("Sampler", parameters.sampler || parameters.sampler_raw);
    addField("Scheduler", parameters.scheduler);
    addField("Denoise", parameters.denoise);
    if (!fields.length) return null;

    const card = document.createElement("section");
    card.className = "pm4a-display-card double-sample";
    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = t("双采样参数");
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    titleGroup.appendChild(title);

    const parameterTarget = document.createElement("select");
    parameterTarget.className = "pm4a-display-double-sample-target";
    parameterTarget.title = t("选择双采样参数发送目标");
    const refreshParameterTargets = () => {
      const graph = node.graph || app.graph;
      const targets = doubleSampleParameterNodes(graph);
      const previous = String(
        node.properties?.[TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY] || "",
      );
      parameterTarget.replaceChildren();
      if (targets.length > 1) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("选择双采样参数节点");
        parameterTarget.appendChild(placeholder);
      }
      for (const target of targets) {
        const option = document.createElement("option");
        option.value = String(target.id);
        option.textContent = target.title || t("双采样参数节点 #{id}", { id: target.id });
        parameterTarget.appendChild(option);
      }
      const remembered = targets.find((target) => String(target.id) === previous);
      if (remembered) parameterTarget.value = previous;
      else if (targets.length === 1) parameterTarget.value = String(targets[0].id);
      else parameterTarget.value = "";
      parameterTarget.hidden = targets.length < 2;
    };
    refreshParameterTargets();
    parameterTarget.onchange = () => {
      node.properties = node.properties || {};
      node.properties[TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY] = parameterTarget.value;
      setStatus(parameterTarget.value ? t("已选择双采样参数目标") : "");
    };

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "pm4a-display-return";
    sendButton.innerHTML = RETURN_ICON;
    sendButton.title = t("发送到 4A Double Sample Parameters");
    sendButton.setAttribute("aria-label", sendButton.title);
    const applyParameters = () => {
      refreshParameterTargets();
      if (parameterTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY] = parameterTarget.value;
      }
      const message = applyDoubleSampleFromPayload(node, { double_sample_parameters: parameters });
      if (!message) throw new Error(t("没有可发送的双采样参数"));
      const bypassMessage = syncBypassSwitchFromDoubleSample(node, true);
      return {
        message: localeJoin([message, bypassMessage].filter(Boolean), { zh: "；", en: "; " }),
      };
    };
    sendButton.onclick = () => {
      try {
        setStatus(applyParameters().message);
      } catch (error) {
        setStatus(t("双采样参数发送失败：{error}", { error: error.message || error }));
      }
    };
    header.append(titleGroup, parameterTarget, sendButton);

    const grid = document.createElement("div");
    grid.className = "pm4a-display-parameter-grid";
    for (const [labelText, valueText] of fields) {
      const item = document.createElement("div");
      item.className = "pm4a-display-parameter-item";
      const label = document.createElement("span");
      label.className = "pm4a-display-parameter-label";
      label.textContent = labelText;
      const value = document.createElement("span");
      value.className = "pm4a-display-parameter-value";
      value.textContent = valueText;
      value.title = valueText;
      item.append(label, value);
      grid.appendChild(item);
    }
    card.append(header, grid);
    card.__pm4aCommitTargets = () => {
      refreshParameterTargets();
      if (parameterTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_DOUBLE_SAMPLE_PARAMETERS_PROPERTY] = parameterTarget.value;
      }
    };
    return card;
  };

  const createLoraCard = (loras) => {
    const textValue = typeof loras?.text === "string" ? loras.text.trim() : "";
    if (!textValue) return null;

    const card = document.createElement("section");
    card.className = "pm4a-display-card lora";
    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = t("LoRA 串");
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "pm4a-display-copy";
    copyButton.innerHTML = COPY_ICON;
    copyButton.title = t("复制 LoRA 串");
    copyButton.setAttribute("aria-label", copyButton.title);
    copyButton.onclick = async () => {
      try {
        await writeClipboardText(textValue);
        setStatus(t("已复制 LoRA 串"));
      } catch (error) {
        setStatus(t("复制失败：{error}", { error: error.message || error }));
      }
    };
    titleGroup.append(title, copyButton);

    const loraTarget = document.createElement("select");
    loraTarget.className = "pm4a-display-lora-target";
    loraTarget.title = t("选择 LoRA Loader");
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
      loraTarget.hidden = targets.length < 2;
    };
    refreshLoraTargets();
    loraTarget.onchange = () => {
      node.properties = node.properties || {};
      node.properties[TARGET_LORA_PROPERTY] = loraTarget.value;
      setStatus(loraTarget.value ? t("已选择 LoRA Loader") : "");
    };

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "pm4a-display-return";
    sendButton.innerHTML = RETURN_ICON;
    sendButton.title = t("替换 LoraManager 的 LoRA 串");
    sendButton.setAttribute("aria-label", sendButton.title);
    const applyLora = async () => {
      refreshLoraTargets();
      if (loraTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_LORA_PROPERTY] = loraTarget.value;
      }
      // Display keeps the original (possibly wrong) names; remap happens inside apply.
      const message = await applyLoraFromPayload(node, { loras });
      if (!message) throw new Error(t("没有可发送的 LoRA 串"));
      return { message };
    };
    sendButton.onclick = () => {
      void applyLora()
        .then((result) => setStatus(result.message))
        .catch((error) => {
          setStatus(t("LoRA 发送失败：{error}", { error: error.message || error }));
        });
    };
    header.append(titleGroup, loraTarget, sendButton);

    const body = document.createElement("div");
    body.className = "pm4a-display-card-body";
    const text = document.createElement("textarea");
    text.className = "pm4a-display-text";
    text.readOnly = true;
    text.spellcheck = false;
    text.value = textValue;
    body.appendChild(text);
    card.append(header, body);
    card.__pm4aCommitTargets = () => {
      refreshLoraTargets();
      if (loraTarget.value) {
        node.properties = node.properties || {};
        node.properties[TARGET_LORA_PROPERTY] = loraTarget.value;
      }
    };
    card.__pm4aApplyLora = applyLora;
    scheduleTextResize();
    return card;
  };

  const createLoraHashesCard = (hashes) => {
    if (!Array.isArray(hashes) || !hashes.length) return null;
    const card = document.createElement("section");
    card.className = "pm4a-display-card hashes";
    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "pm4a-display-collapse";
    collapse.innerHTML = CHEVRON_ICON;
    collapse.title = t("展开 LoRA Hash");
    collapse.setAttribute("aria-label", collapse.title);
    collapse.setAttribute("aria-expanded", "false");
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = "LoRA Hash";
    const copyAll = document.createElement("button");
    copyAll.type = "button";
    copyAll.className = "pm4a-display-copy";
    copyAll.innerHTML = COPY_ICON;
    copyAll.title = t("复制全部 LoRA Hash");
    copyAll.setAttribute("aria-label", copyAll.title);
    copyAll.onclick = async () => {
      try {
        await writeClipboardText(hashes.map((entry) => `${entry.name}: ${entry.hash}`).join("\n"));
        setStatus(t("已复制全部 LoRA Hash"));
      } catch (error) {
        setStatus(t("复制失败：{error}", { error: error.message || error }));
      }
    };
    titleGroup.append(title, copyAll);
    header.append(collapse, titleGroup);

    const list = document.createElement("div");
    list.className = "pm4a-display-hash-list";
    list.hidden = true;
    collapse.onclick = () => {
      const expanded = list.hidden;
      list.hidden = !expanded;
      collapse.classList.toggle("expanded", expanded);
      collapse.title = expanded ? t("收起 LoRA Hash") : t("展开 LoRA Hash");
      collapse.setAttribute("aria-label", collapse.title);
      collapse.setAttribute("aria-expanded", String(expanded));
      node.setDirtyCanvas?.(false, true);
    };
    for (const entry of hashes) {
      const row = document.createElement("div");
      row.className = "pm4a-display-hash-row";
      const name = document.createElement("span");
      name.className = "pm4a-display-hash-name";
      name.textContent = entry.name;
      name.title = entry.name;
      const hash = document.createElement("span");
      hash.className = "pm4a-display-hash-value";
      hash.textContent = entry.hash;
      hash.title = entry.hash;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "pm4a-display-copy";
      copy.innerHTML = COPY_ICON;
      copy.title = t("复制 {name} 的 Hash", { name: entry.name });
      copy.setAttribute("aria-label", copy.title);
      copy.onclick = async () => {
        try {
          await writeClipboardText(entry.hash);
          setStatus(t("已复制“{name}”的 Hash", { name: entry.name }));
        } catch (error) {
          setStatus(t("复制失败：{error}", { error: error.message || error }));
        }
      };
      row.append(name, hash, copy);
      list.appendChild(row);
    }
    card.append(header, list);
    return card;
  };

  const createCard = (entry, payload, negative = false, firstPositive = false) => {
    const card = document.createElement("section");
    card.className = `pm4a-display-card${negative ? " negative" : ""}`;
    card.dataset.trackId = entry.id;
    const displayName = displayTrackName(entry);

    const header = document.createElement("div");
    header.className = "pm4a-display-card-header";
    const title = document.createElement("div");
    title.className = "pm4a-display-card-title";
    title.textContent = displayName;
    const titleGroup = document.createElement("div");
    titleGroup.className = "pm4a-display-card-title-group";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "pm4a-display-copy";
    copyButton.innerHTML = COPY_ICON;
    copyButton.disabled = !entry.text.trim();
    copyButton.title = t("复制“{name}”", { name: displayName });
    copyButton.setAttribute("aria-label", copyButton.title);
    copyButton.onclick = async () => {
      try {
        await writeClipboardText(entry.text);
        setStatus(t("已复制“{name}”", { name: displayName }));
      } catch (error) {
        setStatus(t("复制失败：{error}", { error: error.message || error }));
      }
    };
    titleGroup.append(title, copyButton);
    const returnButton = document.createElement("button");
    returnButton.type = "button";
    returnButton.className = "pm4a-display-return";
    returnButton.innerHTML = RETURN_ICON;
    returnButton.disabled = !entry.text.trim();
    returnButton.title = t("替换回 Scheduler 的“{name}”栏目", { name: displayName });
    returnButton.setAttribute("aria-label", returnButton.title);
    returnButton.onclick = () => sendBack(entry, payload);
    header.appendChild(titleGroup);
    const canAddToLibrary = !negative;
    if (canAddToLibrary) {
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "pm4a-display-add";
      addButton.innerHTML = ADD_PROMPT_ICON;
      addButton.disabled = !entry.text.trim();
      addButton.title = t("将“{label}”添加到提示词库", { label: displayName });
      addButton.setAttribute("aria-label", addButton.title);
      addButton.onclick = async () => {
        if (libraryModalOpen) return;
        libraryModalOpen = true;
        addButton.disabled = true;
        try {
          const result = await openPromptLibraryModal({
            content: entry.text,
            sourceLabel: displayName,
            previewFile: await resolveLibraryPreviewFile(),
          });
          if (!result) return;
          setStatus(result.imageError
            ? t("已添加“{name}”，但预览图保存失败", { name: result.entry?.name || displayName })
            : t("已添加“{name}”到提示词库", { name: result.entry?.name || displayName }));
        } finally {
          libraryModalOpen = false;
          addButton.disabled = !entry.text.trim();
        }
      };
      header.appendChild(addButton);
    }
    if (firstPositive) {
      const applyAllButton = document.createElement("button");
      applyAllButton.type = "button";
      applyAllButton.className = "pm4a-display-return";
      applyAllButton.innerHTML = APPLY_ALL_ICON;
      applyAllButton.disabled = !String(payload.positive || "").trim();
      applyAllButton.title = t("使用所有正面提示词");
      applyAllButton.setAttribute("aria-label", applyAllButton.title);
      applyAllButton.onclick = () => sendAllPositive(payload);
      header.appendChild(applyAllButton);
    }
    header.appendChild(returnButton);

    const body = document.createElement("div");
    body.className = "pm4a-display-card-body";
    const text = document.createElement("textarea");
    text.className = "pm4a-display-text";
    text.readOnly = true;
    text.spellcheck = false;
    text.value = entry.text;
    text.placeholder = t("本栏本次输出为空");
    body.appendChild(text);
    card.append(header, body);
    scheduleTextResize();
    return card;
  };

  const render = (raw, source = "scheduler", fileName = "") => {
    list.innerHTML = "";
    setStatus("");
    syncImagePreview(source, fileName, raw);
    const payload = parsePromptDocument(raw);
    node.__pm4aPromptDisplayPayload = payload;
    node.__pm4aPromptDisplaySource = source;
    liveButton.hidden = source !== "image";
    if (source === "image" && payload) {
      setRawImageMetadata(payload.raw_metadata || rawImageMetadata);
      setPreviewSize(
        payload.image_dimensions?.width,
        payload.image_dimensions?.height,
      );
    }
    refreshTargetSelect(payload);

    if (!payload) {
      summaryTitle.textContent = raw ? t("JSON 无法解析") : t("等待本次输出");
      const empty = document.createElement("div");
      empty.className = "pm4a-display-empty";
      empty.textContent = raw
        ? t("输入不是可识别的提示词数据")
        : t("运行工作流，或将含提示词元数据的图片拖到此节点");
      list.appendChild(empty);
      scheduleTextResize();
      return;
    }

    const sourceText = source === "image"
      ? t("图片快照 · {label} · {fileName}", {
        label: displaySourceLabel(payload.source_label),
        fileName: fileName || t("已导入图片"),
      })
      : t("本次运行");
    const modelsCard = createModelsCard(payload.models);
    const parametersCard = createParametersCard(payload.parameters);
    const doubleSampleParametersCard = createDoubleSampleParametersCard(
      payload.double_sample_parameters,
    );
    const loraCard = createLoraCard(payload.loras);
    const loraHashesCard = createLoraHashesCard(payload.loras?.hashes);
    // Hash list is display-only; do not count it as an apply-all target.
    const actionableCards = [
      modelsCard,
      parametersCard,
      doubleSampleParametersCard,
      loraCard,
    ].filter(Boolean);
    const settingsCards = [...actionableCards, loraHashesCard].filter(Boolean);
    if (actionableCards.length) {
      const applyAllButton = document.createElement("button");
      applyAllButton.type = "button";
      applyAllButton.className = "pm4a-display-return";
      applyAllButton.innerHTML = APPLY_PARAMETERS_ICON;
      applyAllButton.title = t("使用所有模型、生成参数、双采样参数与 LoRA");
      applyAllButton.setAttribute("aria-label", applyAllButton.title);
      applyAllButton.onclick = async () => {
        applyAllButton.disabled = true;
        setStatus(t("正在使用全部参数…"));
        const applied = [];
        const errors = [];
        try {
          if (modelsCard?.__pm4aApplyModels) {
            const modelResult = await modelsCard.__pm4aApplyModels();
            const modelCount = modelResult.applied.length;
            if (modelCount) {
              applied.push(modelCount === 1
                ? t("模型 1 个")
                : t("模型 {count} 个", { count: modelCount }));
            }
            errors.push(...modelResult.errors);
          }

          // Params / double-sample / Bypass: same helper as Meta Apply.
          parametersCard?.__pm4aCommitTargets?.();
          doubleSampleParametersCard?.__pm4aCommitTargets?.();
          const paramResult = applyParameterSettingsFromPayload(node, {
            parameters: payload.parameters,
            double_sample_parameters: payload.double_sample_parameters,
          });
          applied.push(...paramResult.applied);
          errors.push(...paramResult.errors);

          if (loraCard?.__pm4aApplyLora) {
            loraCard.__pm4aCommitTargets?.();
            try {
              await loraCard.__pm4aApplyLora();
              applied.push("LoRA");
            } catch (error) {
              errors.push(t("{key}：{error}", { key: "LoRA", error: error.message || error }));
            }
          }
          const successText = applied.length
            ? t("已使用全部参数（{applied}）", { applied: localeJoin(applied, { zh: "、", en: ", " }) })
            : t("没有可使用的参数");
          const errorText = errors.length
            ? t("；未应用 {errors}", { errors: localeJoin(errors, { zh: "；", en: "; " }) })
            : "";
          setStatus(`${successText}${errorText}`);
        } finally {
          applyAllButton.disabled = false;
        }
      };

      const topHeader = actionableCards[0].querySelector(":scope > .pm4a-display-card-header");
      const topSendButton = topHeader?.querySelector(":scope > .pm4a-display-return");
      if (topSendButton) topHeader.insertBefore(applyAllButton, topSendButton);
      else topHeader?.appendChild(applyAllButton);
    }
    if (settingsCards.length) list.append(...settingsCards);
    const trackCount = payload.tracks.length + 1 + settingsCards.length;
    summaryTitle.textContent = trackCount === 1
      ? t("{sourceText} · 1 栏", { sourceText })
      : t("{sourceText} · {count} 栏", { sourceText, count: trackCount });
    summaryTitle.title = summaryTitle.textContent;
    payload.tracks.forEach((track, index) => {
      list.appendChild(createCard(track, payload, false, index === 0));
    });
    list.appendChild(createCard({ id: "negative", name: "负面", text: payload.negative }, payload, true));
    scheduleTextResize();
  };

  node.__pm4aPromptDisplayRestoreFromState = () => {
    const importedWidget = getImportedWidget();
    hideWidget(importedWidget);
    const restored = resolvePromptDisplayRestoreState({
      importedJson: typeof importedWidget?.value === "string" ? importedWidget.value : "",
      lastJson: node.properties?.[LAST_JSON_PROPERTY] || "",
      importedImage: node.properties?.[IMPORTED_IMAGE_PROPERTY],
    });
    render(restored.raw, restored.source, restored.fileName);
    node.setDirtyCanvas?.(true, true);
    return restored;
  };

  node.__pm4aPromptDisplaySetJson = (raw, options = {}) => {
    const value = typeof raw === "string" ? raw : "";
    const source = options.source === "image" ? "image" : "scheduler";
    const fileName = source === "image"
      ? String(options.fileName || node.properties?.[IMPORTED_FILE_PROPERTY] || "")
      : "";
    node.properties = node.properties || {};
    node.properties[LAST_JSON_PROPERTY] = value;
    if (source === "scheduler" && options.storeLive !== false) {
      node.properties[LAST_LIVE_JSON_PROPERTY] = value;
    }
    if (source === "image") {
      node.properties[IMPORTED_FILE_PROPERTY] = fileName;
      if (Object.prototype.hasOwnProperty.call(options, "imageReference")) {
        node.properties[IMPORTED_IMAGE_PROPERTY] = normalizeStoredImageReference(
          options.imageReference,
        );
      }
    }
    render(value, source, fileName);
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  };

  liveButton.onclick = () => {
    withGraphChangeTransaction(node, () => {
      setWidgetValue(node, getImportedWidget(), "");
      node.properties = node.properties || {};
      node.properties[IMPORTED_FILE_PROPERTY] = "";
      node.properties[IMPORTED_IMAGE_PROPERTY] = null;
      const live = node.properties[LAST_LIVE_JSON_PROPERTY] || "";
      node.__pm4aPromptDisplaySetJson(live, { source: "scheduler", storeLive: false });
    });
    setStatus(t("已恢复实时输出"));
  };

  const importImage = async (file) => {
    if (!looksLikeImageFile(file)) {
      setStatus(t("仅支持常见图片格式（PNG、JPEG、WebP、GIF 等）"));
      return false;
    }
    try {
      const snapshot = await readImagePromptSnapshot(file);
      const imageReference = await uploadInputImage(file);
      const raw = snapshot.promptJson;
      const fileName = imageReferenceLabel(imageReference);
      rememberPreviewFile(fileName, raw, file, snapshot.metadata);
      withGraphChangeTransaction(node, () => {
        setWidgetValue(node, getImportedWidget(), raw);
        node.__pm4aPromptDisplaySetJson(raw, {
          source: "image",
          fileName,
          imageReference,
        });
      });
      setStatus(t("已读取图片快照"));
      return true;
    } catch (error) {
      setStatus(String(error.message || error));
      return false;
    }
  };

  const importTransfer = async (dataTransfer) => {
    try {
      const file = await imageFileFromTransfer(dataTransfer, { viewPath: viewPath() });
      if (!file) return false;
      await importImage(file);
      return true;
    } catch (error) {
      setStatus(String(error.message || error));
      return true;
    }
  };

  const setOfficialDragGlow = (active) => {
    if (active) app.dragOverNode = node;
    else if (app.dragOverNode?.id === node.id) app.dragOverNode = null;
    node.setDirtyCanvas?.(false, true);
    app.canvas?.setDirty?.(false, true);
  };

  // The display body is a DOM overlay above the canvas, so keep a scoped DOM
  // handler for that area. It exists only inside this Prompt Display node.
  const acceptsDisplayDrop = (event) => {
    if (!hasSupportedImageTransfer(event?.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    setOfficialDragGlow(true);
    return true;
  };
  main.addEventListener("dragenter", acceptsDisplayDrop);
  main.addEventListener("dragover", acceptsDisplayDrop);
  main.addEventListener("dragleave", (event) => {
    if (!main.contains(event.relatedTarget)) setOfficialDragGlow(false);
  });
  main.addEventListener("drop", async (event) => {
    if (!acceptsDisplayDrop(event)) return;
    setOfficialDragGlow(false);
    await importTransfer(event.dataTransfer);
  });

  // Match ComfyUI's official Load Image behavior: the canvas only delegates the
  // drop when the cursor is currently over this specific node.
  const originalOnDragDrop = node.onDragDrop;
  node.onDragDrop = async function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return importTransfer(event.dataTransfer);
    return originalOnDragDrop?.apply(this, arguments) ?? false;
  };

  const originalOnDragOver = node.onDragOver;
  node.onDragOver = function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return true;
    return originalOnDragOver?.apply(this, arguments) ?? false;
  };

  const originalOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    clearImagePreview(true);
    listResizeObserver?.disconnect();
    if (textResizeFrame) cancelAnimationFrame(textResizeFrame);
    return originalOnRemoved?.apply(this, arguments);
  };

  let displayWidget = null;
  displayWidget = node.addDOMWidget("pm4a_prompt_display_ui", "pm4a_prompt_display", main, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => 190,
    // Unlike Scheduler, Meta Loader has no native seed widgets below this DOM
    // widget. Use the actual widget position so the content reaches the bottom
    // while leaving only LiteGraph's resize corner uncovered.
    getMaxHeight: () => {
      const measuredTop = Number(displayWidget?.last_y);
      const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0 ? measuredTop : 55;
      return Math.max(190, Number(node.size?.[1] || 520) - widgetTop - 8);
    },
  }));

  node.resizable = true;
  node.setSize([700, 520]);
  node.__pm4aPromptDisplayRestoreFromState();
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.PromptDisplay",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "KSampler") {
      registerKnownSchedulers(nodeData.input?.required?.scheduler?.[0]);
    }
    if (nodeData.name !== DISPLAY_NODE_CLASS) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupDisplayNode(this);
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      setupDisplayNode(this);
      this.__pm4aPromptDisplayConfigureVersion = Number(
        this.__pm4aPromptDisplayConfigureVersion || 0,
      ) + 1;
      const configureVersion = this.__pm4aPromptDisplayConfigureVersion;
      requestAnimationFrame(() => {
        if (configureVersion !== this.__pm4aPromptDisplayConfigureVersion) return;
        this.__pm4aPromptDisplayRestoreLayout?.();
        this.__pm4aPromptDisplayRestoreFromState?.();
      });
      return result;
    };

    const originalExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      originalExecuted?.apply(this, arguments);
      const live = extractLiveJson(message);
      if (live !== null) {
        this.properties = this.properties || {};
        this.properties[LAST_LIVE_JSON_PROPERTY] = live;
      }
      const raw = extractJson(message);
      const source = extractSource(message) === "image" ? "image" : "scheduler";
      if (raw !== null) {
        this.__pm4aPromptDisplaySetJson?.(raw, {
          source,
          fileName: this.properties?.[IMPORTED_FILE_PROPERTY] || "",
          storeLive: source === "scheduler",
        });
      }
    };
  },
});
