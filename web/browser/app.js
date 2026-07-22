import { readImagePromptDocument, stripLoraTags } from "./image_prompt_metadata.js?v=13";
import {
  hasSupportedImageTransfer,
  imageFileFromTransfer,
  looksLikeImageFile,
} from "./image_drop.js?v=3";
import {
  applyDocumentTranslations,
  buildBrowserLocaleReloadUrl,
  getLocale,
  localeHeaders,
  readBrowserLocale,
  setLocale,
  t,
  trySaveBrowserLocale,
} from "./i18n.js?v=16";
import {
  detectLoraManager,
  emptyLoraPayload,
  entriesToLoraPayload,
  loraPayloadEqual,
  parseLoraEntries,
  formatLoraStrength,
  pickExactLoraFromManager,
  pickLoraFromManagerItem,
  searchLoraManager,
  withLoraStrength,
} from "./lora_library.js?v=2";

setLocale(readBrowserLocale());
applyDocumentTranslations();

const localeToggle = document.getElementById("locale-toggle");
const localeToggleIcon = localeToggle?.querySelector(".locale-toggle-icon");

function localeToggleLabel() {
  return getLocale() === "en" ? t("切换到中文") : t("切换到 English");
}

if (localeToggle) {
  const label = localeToggleLabel();
  if (localeToggleIcon) {
    localeToggleIcon.textContent = getLocale() === "en" ? "EN" : "中";
  }
  localeToggle.title = label;
  localeToggle.setAttribute("aria-label", label);
  localeToggle.addEventListener("click", () => {
    const nextLocale = getLocale() === "en" ? "zh" : "en";
    const saveResult = trySaveBrowserLocale(nextLocale);
    const reloadUrl = buildBrowserLocaleReloadUrl(globalThis.location.href, saveResult);
    globalThis.location.replace(reloadUrl);
  });
}

const STORAGE_KEYS = {
  recursive: "pm4a_browser_recursive",
  sidebarOpen: "pm4a_browser_sidebar_open",
  viewMode: "pm4a_browser_view_mode",
  sortMode: "pm4a_browser_sort_mode",
  sendMode: "pm4a_browser_send_mode",
  expanded: "pm4a_browser_expanded",
  prefix: "pm4a_browser_prefix",
};

const SLOT_LABELS = {
  quality: t("质量"),
  action: t("动作"),
  character: t("角色"),
  scene: t("场景"),
  negative: t("负面"),
};

const INSPECTOR_BUTTON_LABELS = {
  quality: t("质量"),
  action: t("动作"),
  character: t("角色"),
  scene: t("场景"),
  negative: t("负面"),
};

const SEND_TO_LABELS = {
  quality: "发送到质量",
  action: "发送到动作",
  character: "发送到角色",
  scene: "发送到场景",
  negative: "发送到负面",
};

const ICONS = {
  quality: `<svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m12 2 1.4 4.1 4.1 1.4-4.1 1.4L12 13l-1.4-4.1-4.1-1.4 4.1-1.4L12 2Zm6 10 .9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9L18 12ZM5 13l.75 2.25L8 16l-2.25.75L5 19l-.75-2.25L2 16l2.25-.75L5 13Z" />
  </svg>`,
  action: `<svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="13.5" cy="3.5" r="2" />
    <path d="M9.8 17.9 10.9 13l2 2v6.5h2v-7.7l-2.1-2 .6-3A7.3 7.3 0 0 0 19 11V9c-1.7 0-3.2-.8-4.2-2l-1-1.6a2 2 0 0 0-2.5-.8L6 6.8V12h2V8.1l1.8-.7-1.6 8.1-4.9-1-.4 2 6.9 1.4Z" />
  </svg>`,
  character: `<svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="7" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0H4Z" />
  </svg>`,
  scene: `<svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="17" cy="6.5" r="3" />
    <path d="M2 20 8.7 9.8l4.1 5.6 2.2-2.8 7 7.4H2Z" />
  </svg>`,
  negative: `<svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM7 11h10v2H7v-2Z" />
  </svg>`,
};

const CHEVRON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>`;
const FOLDER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h5l2 2h9v11H4z" /></svg>`;
const STAR_ICON = `<svg class="favorite-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.7 2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.25l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93L12 2.7Z" /></svg>`;
const COPY_ICON = `<svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" /></svg>`;
const CARD_PLACEHOLDER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5z" /><path d="M8 8h8M8 11.5h8M8 15h5" /></svg>`;
const TXT_WILDCARD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h10l4 4v13H5Z" /><path d="M15 3.5v4h4M8 11h8M8 14.5h8M8 18h5" /></svg>`;
const IMPORT_BUNDLE_FORMAT = "pm4a-prompt-bundle";
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BULK_IMPORT_PROMPTS = 20_000;
const PROGRESS_POLL_INTERVAL_MS = 150;
const numberFormatter = new Intl.NumberFormat(getLocale() === "en" ? "en-US" : "zh-CN");

const SORT_MODES = new Set(["path:asc", "path:desc", "name:asc", "name:desc"]);

function readStoredBoolean(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "true";
  } catch (_) {
    return fallback;
  }
}

function readStoredString(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (_) {
    return fallback;
  }
}

function storeValue(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (_) {
    // Storage may be unavailable in hardened browser environments.
  }
}

function readStoredExpanded() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.expanded);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((path) => typeof path === "string" && path);
  } catch (_) {
    return [];
  }
}

function persistExpanded() {
  storeValue(STORAGE_KEYS.expanded, JSON.stringify([...state.expanded]));
}

function persistPrefix() {
  storeValue(STORAGE_KEYS.prefix, state.prefix || "");
}

const state = {
  prefix: readStoredString(STORAGE_KEYS.prefix, ""),
  search: "",
  recursive: readStoredBoolean(STORAGE_KEYS.recursive, true),
  sidebarOpen: readStoredBoolean(STORAGE_KEYS.sidebarOpen, true),
  viewMode: readStoredString(STORAGE_KEYS.viewMode, "list") === "cards" ? "cards" : "list",
  favorites: new Set(),
  favoriteRequests: new Set(),
  favoritesOnly: false,
  sortMode: SORT_MODES.has(readStoredString(STORAGE_KEYS.sortMode, "path:asc"))
    ? readStoredString(STORAGE_KEYS.sortMode, "path:asc")
    : "path:asc",
  sendMode: readStoredString(STORAGE_KEYS.sendMode, "append") === "replace"
    ? "replace"
    : "append",
  limit: 100,
  offset: 0,
  total: 0,
  hasMore: true,
  items: [],
  tree: [],
  folderMap: new Map(),
  expanded: new Set(readStoredExpanded()),
  fileCount: 0,
  requestGeneration: 0,
  listController: null,
  loadingPromise: null,
  detailController: null,
  currentIndex: -1,
  selectedKey: "",
  selected: null,
  entryCache: new Map(),
  editingTitle: false,
  editingContent: false,
  editingNegative: false,
  editingNote: false,
  detailLoraEntries: [],
  loraManagerAvailable: false,
  loraPickerTimer: 0,
  loraPickerRequestId: 0,
  loraPickerPending: null,
  savingEntry: false,
  saveRequestId: 0,
  uploadingImage: false,
  imageDraft: null,
  imageDraftUrl: "",
  imageDropRequestId: 0,
  createImage: null,
  createImageUrl: "",
  createGeneratedLocator: null,
  createMetadataRequestId: 0,
  creatingEntry: false,
  contextFolderPath: "",
  contextItems: [],
  batchMode: false,
  batchSelection: new Set(),
  pendingOperation: "",
  pendingOperationItems: [],
  operatingItems: false,
  folderCreateParent: "",
  folderEditMode: "create",
  folderEditTarget: "",
  creatingFolder: false,
  importFile: null,
  importSourceLabel: "",
  importSourceType: "",
  importContent: "",
  importOptionCount: 0,
  importPrompts: [],
  importPreview: null,
  importRequestId: 0,
  parsingImport: false,
  importingPrompts: false,
  externalWildcardSources: [],
  externalWildcardSelected: new Set(),
  generationConfig: null,
  generationConfigLoading: null,
  generationBusy: false,
  generationConfirmMode: "",
  generationConfirmKey: "",
  generationBatchFolder: "",
  generationBatchPlan: null,
  generationBatchRunning: false,
  generationBatchStopRequested: false,
  imageRevisions: new Map(),
};

const $ = (id) => document.getElementById(id);
let detailReturnFocus = null;
let imageRevisionSequence = 0;

function keyQuery(key) {
  return `key=${encodeURIComponent(key)}`;
}

function previewImageUrl(key) {
  const revision = state.imageRevisions.get(key);
  return `/pm4a/api/image?${keyQuery(key)}${revision ? `&v=${encodeURIComponent(revision)}` : ""}`;
}

function bumpImageRevision(key) {
  imageRevisionSequence += 1;
  state.imageRevisions.set(
    key,
    `${Date.now().toString(36)}-${imageRevisionSequence.toString(36)}`,
  );
}

async function api(path, options = {}) {
  let headers = { ...(options.headers || {}) };
  if (path.startsWith("/pm4a/api/")) {
    headers = localeHeaders(headers);
  }
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const error = new Error(formatApiErrorMessage(data.error, response.status));
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatApiErrorMessage(raw, status = 0) {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (raw && typeof raw === "object") {
    if (typeof raw.message === "string" && raw.message.trim()) return raw.message;
    if (typeof raw.error === "string" && raw.error.trim()) return raw.error;
    try {
      return JSON.stringify(raw);
    } catch (_) {
      /* fall through */
    }
  }
  return status ? `HTTP ${status}` : t("请求失败");
}

function toast(message, type = "", placement = "") {
  const element = $("toast");
  const host = placement === "above-actions" ? $("detail-inspector") : document.body;
  if (element.parentElement !== host) host.appendChild(element);
  element.hidden = false;
  element.textContent = message;
  element.className = `toast ${type} ${placement}`.trim();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2600);
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Fall through to the selection-based copy path below.
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error(t("浏览器拒绝访问剪贴板"));
}

async function copyFolderWildcard(folder) {
  const rawPath = typeof folder === "string" ? folder : folder?.path;
  const key = String(rawPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const wildcard = key ? `__${key}__` : "__*__";
  try {
    await writeClipboardText(wildcard);
    toast(t("已复制文件夹 Wildcard：{wildcard}", { wildcard }), "success");
  } catch (error) {
    toast(t("复制失败：{error}", { error: error.message || error }), "error");
  }
}

function wildcardSyntaxForKey(key) {
  const item = state.items.find((candidate) => candidate.key === key);
  if (item?.wildcard_syntax) return item.wildcard_syntax;
  const normalized = String(key || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized ? `__${normalized}__` : "";
}

async function copyPromptWildcards(items) {
  const keys = (items || [])
    .filter((item) => item?.type === "file" && item.key)
    .map((item) => item.key);
  const refs = keys.map((key) => wildcardSyntaxForKey(key)).filter(Boolean);
  if (!refs.length) {
    toast(t("没有可复制的 Wildcard"), "error");
    return;
  }
  const wildcard = refs.length === 1 ? refs[0] : `{${refs.join("|")}}`;
  try {
    await writeClipboardText(wildcard);
    toast(
      refs.length === 1
        ? t("已复制 Wildcard：{wildcard}", { wildcard })
        : t("已复制 {count} 项为 Wildcard：{wildcard}", { count: refs.length, wildcard }),
      "success",
    );
  } catch (error) {
    toast(t("复制失败：{error}", { error: error.message || error }), "error");
  }
}

function setModalStatus(id, message = "", type = "") {
  const element = $(id);
  element.textContent = message;
  element.className = `modal-status ${type}`.trim();
}

function setCreateImageStatus(message = "", type = "") {
  const element = $("add-prompt-image-status");
  element.textContent = message;
  element.className = `create-image-status ${type}`.trim();
}

function populateFolderOptions(select, selectedPath = state.prefix) {
  select.innerHTML = "";
  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.textContent = t("根目录");
  select.appendChild(rootOption);

  const walk = (nodes, depth = 0) => {
    for (const node of nodes || []) {
      const option = document.createElement("option");
      option.value = node.path;
      option.textContent = `${"　".repeat(depth)}${depth ? "└ " : ""}${node.name}`;
      select.appendChild(option);
      walk(node.children, depth + 1);
    }
  };
  walk(state.tree);
  select.value = state.folderMap.has(selectedPath) ? selectedPath : "";
}

function populateCreateFolderOptions(selectedPath = state.prefix) {
  populateFolderOptions($("add-prompt-folder"), selectedPath);
}

function discardGeneratedPreview(locator) {
  if (!locator) return;
  void api("/pm4a/api/generation/discard", {
    method: "POST",
    body: JSON.stringify({ locator }),
  }).catch((error) => {
    console.warn("[4A Prompt Manager] Failed to discard pending preview", error);
  });
}

function clearCreateImage() {
  const generatedLocator = state.createGeneratedLocator;
  state.createMetadataRequestId += 1;
  if (state.createImageUrl) URL.revokeObjectURL(state.createImageUrl);
  state.createImage = null;
  state.createImageUrl = "";
  state.createGeneratedLocator = null;
  discardGeneratedPreview(generatedLocator);
  const preview = $("add-prompt-image-preview");
  preview.onerror = null;
  preview.removeAttribute("src");
  preview.hidden = true;
  $("add-prompt-image-empty").hidden = false;
  $("add-prompt-image-drop").classList.remove("dragging");
  setCreateImageStatus(t("尚未选择图片"));
}

function openAddPromptModal() {
  const form = $("add-prompt-form");
  form.reset();
  clearCreateImage();
  populateCreateFolderOptions(state.prefix);
  setModalStatus("add-prompt-status");
  $("add-prompt-modal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("add-prompt-name").focus());
}

function closeAddPromptModal() {
  if (state.creatingEntry || state.generationBusy) return;
  $("add-prompt-modal").hidden = true;
  clearCreateImage();
  document.body.classList.remove("modal-open");
}

function promptDocumentPositive(documentData) {
  if (typeof documentData?.positive === "string" && documentData.positive.trim()) {
    return stripLoraTags(documentData.positive);
  }
  return stripLoraTags((documentData?.tracks || [])
    .filter((track) => {
      const identity = `${track?.id || ""} ${track?.name || ""}`.toLowerCase();
      return !identity.includes("negative") && !identity.includes("负面");
    })
    .map((track) => String(track?.text || "").trim())
    .filter(Boolean)
    .join("\n"));
}

async function readCreateImagePrompt(file) {
  const form = new FormData();
  form.append("image", file, file.name || "prompt-image");
  const data = await api("/pm4a/api/image/metadata", { method: "POST", body: form });
  return readImagePromptDocument(file, data.metadata || {});
}

async function setCreateImage(file) {
  if (!looksLikeImageFile(file)) {
    setCreateImageStatus(t("请选择 PNG、JPG、WEBP 或 GIF 图片"), "error");
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    setCreateImageStatus(t("图片不能超过 32 MB"), "error");
    return;
  }

  if (state.createImageUrl) URL.revokeObjectURL(state.createImageUrl);
  discardGeneratedPreview(state.createGeneratedLocator);
  state.createImage = file;
  state.createGeneratedLocator = null;
  state.createImageUrl = URL.createObjectURL(file);
  const preview = $("add-prompt-image-preview");
  preview.hidden = false;
  preview.src = state.createImageUrl;
  preview.onerror = () => setCreateImageStatus(t("图片预览失败"), "error");
  $("add-prompt-image-empty").hidden = true;
  if (!$("add-prompt-name").value.trim()) {
    $("add-prompt-name").value = String(file.name || "").replace(/\.[^.]+$/, "");
  }

  const requestId = ++state.createMetadataRequestId;
  setCreateImageStatus(t("正在读取图片提示词…"));
  try {
    const documentData = await readCreateImagePrompt(file);
    if (requestId !== state.createMetadataRequestId || state.createImage !== file) return;
    if (!documentData) {
      setCreateImageStatus(t("图片已作为例图；没有读取到可用的提示词数据"));
      return;
    }
    const positive = promptDocumentPositive(documentData);
    const negative = typeof documentData.negative === "string"
      ? documentData.negative.trim()
      : "";
    if (positive) $("add-prompt-content").value = positive;
    if (negative) $("add-prompt-negative").value = negative;
    const sourceLabel = String(documentData.source_label || "");
    const source = (sourceLabel === "通用" ? t("通用") : sourceLabel)
      || documentData.source_type
      || t("图片");
    setCreateImageStatus(t("已读取 {source} 提示词，并设为例图", { source }), "success");
  } catch (error) {
    if (requestId !== state.createMetadataRequestId) return;
    setCreateImageStatus(t("图片已作为例图；提示词读取失败：{error}", { error: error.message || error }), "error");
  }
}

async function saveNewPrompt(event) {
  event.preventDefault();
  if (state.creatingEntry) return;
  const folder = $("add-prompt-folder").value;
  const name = $("add-prompt-name").value.trim();
  const content = $("add-prompt-content").value;
  const negative = $("add-prompt-negative").value;
  const note = $("add-prompt-note").value;
  if (!name) {
    setModalStatus("add-prompt-status", t("请填写标题"), "error");
    $("add-prompt-name").focus();
    return;
  }
  if (!content.trim()) {
    setModalStatus("add-prompt-status", t("请填写正面提示词"), "error");
    $("add-prompt-content").focus();
    return;
  }

  state.creatingEntry = true;
  $("add-prompt-save").disabled = true;
  $("add-prompt-cancel").disabled = true;
  setModalStatus("add-prompt-status", t("正在创建提示词…"));
  let entry = null;
  let imageError = "";
  try {
    const data = await api("/pm4a/api/entry/create", {
      method: "POST",
      body: JSON.stringify({ folder, name, content, negative, note }),
    });
    entry = data.entry;
    if (!entry?.key) throw new Error(t("创建结果无效"));
    if (state.createGeneratedLocator) {
      setModalStatus("add-prompt-status", t("提示词已创建，正在挂接生成图片…"));
      try {
        const attached = await api("/pm4a/api/generation/attach", {
          method: "POST",
          body: JSON.stringify({ key: entry.key, locator: state.createGeneratedLocator }),
        });
        entry = attached.entry || entry;
        state.createGeneratedLocator = null;
      } catch (error) {
        imageError = String(error.message || error);
      }
    } else if (state.createImage) {
      setModalStatus("add-prompt-status", t("提示词已创建，正在保存例图…"));
      try {
        entry = await uploadDetailImage(entry.key, state.createImage);
      } catch (error) {
        imageError = String(error.message || error);
      }
    }

    state.entryCache.clear();
    state.search = "";
    $("search").value = "";
    $("search").parentElement.classList.remove("has-value");
    state.favoritesOnly = false;
    updateFavoriteFilterButton();
    await loadTree();
    await selectFolder(folder, { preserveInspector: false });
    state.creatingEntry = false;
    closeAddPromptModal();
    selectPrompt(entry.key);
    if (imageError) {
      toast(t("提示词已创建，但例图保存失败：{error}", { error: imageError }), "error");
    } else {
      toast(t("提示词已添加"), "success");
    }
  } catch (error) {
    setModalStatus("add-prompt-status", String(error.message || error), "error");
  } finally {
    state.creatingEntry = false;
    $("add-prompt-save").disabled = false;
    $("add-prompt-cancel").disabled = false;
  }
}

function clearExternalWildcardResults() {
  state.externalWildcardSources = [];
  state.externalWildcardSelected = new Set();
  $("external-wildcards-results").hidden = true;
  $("external-wildcards-list").innerHTML = "";
  $("external-wildcards-summary").textContent = t("检测结果");
  $("external-wildcards-toggle-all").textContent = t("取消全选");
}

function importableExternalWildcardFiles() {
  return state.externalWildcardSources.flatMap((source) =>
    (source.files || []).filter((file) => {
      const count = Number(file.prompt_count || 0);
      return !file.error && count > 0;
    })
  );
}

function selectedExternalWildcardFileIds() {
  return importableExternalWildcardFiles()
    .filter((file) => state.externalWildcardSelected.has(file.id))
    .map((file) => file.id);
}

function syncExternalWildcardSelectionControls() {
  const files = importableExternalWildcardFiles();
  const allSelected = files.length > 0
    && files.every((file) => state.externalWildcardSelected.has(file.id));
  for (const input of $("external-wildcards-list").querySelectorAll("input[data-file-id]")) {
    input.checked = state.externalWildcardSelected.has(input.dataset.fileId);
    input.disabled = input.dataset.importable !== "1";
  }
  $("external-wildcards-toggle-all").textContent = allSelected ? t("取消全选") : t("全选");
  $("external-wildcards-toggle-all").disabled = files.length < 1;
}

async function applyExternalWildcardSelection() {
  state.importFile = null;
  state.importSourceLabel = t("其他节点 Wildcards");
  state.importSourceType = "external_txt";
  state.importPrompts = selectedExternalWildcardFileIds();
  state.importContent = "";
  state.importOptionCount = 0;
  state.importPreview = null;
  $("import-prompts-file-name").textContent = state.importSourceLabel;
  $("import-prompts-preview").hidden = true;
  $("import-prompts-confirm").disabled = true;
  syncExternalWildcardSelectionControls();
  if (!state.importPrompts.length) {
    setModalStatus("import-prompts-status", t("请选择至少一个包含提示词的 Wildcard 文件"));
    return;
  }
  await refreshImportPreview(t("正在检查所选 Wildcards"));
}

function renderExternalWildcardSources(data) {
  state.externalWildcardSources = Array.isArray(data.sources) ? data.sources : [];
  state.externalWildcardSelected = new Set(
    importableExternalWildcardFiles().map((file) => file.id)
  );
  $("external-wildcards-summary").textContent = t(
    "检测到 {sourceCount} 个节点、{fileCount} 个文件、{promptCount} 条提示词",
    {
      sourceCount: numberFormatter.format(Number(data.source_count || 0)),
      fileCount: numberFormatter.format(Number(data.file_count || 0)),
      promptCount: numberFormatter.format(Number(data.prompt_count || 0)),
    },
  );
  const list = $("external-wildcards-list");
  list.innerHTML = "";
  for (const source of state.externalWildcardSources) {
    const section = document.createElement("section");
    section.className = "external-wildcards-source";
    const heading = document.createElement("div");
    heading.className = "external-wildcards-source-heading";
    const name = document.createElement("strong");
    name.textContent = source.name || source.id;
    const count = document.createElement("span");
    count.textContent = t("{fileCount} 个文件，{promptCount} 条提示词", {
      fileCount: numberFormatter.format(Number(source.file_count || 0)),
      promptCount: numberFormatter.format(Number(source.prompt_count || 0)),
    });
    heading.append(name, count);
    section.appendChild(heading);

    for (const file of source.files || []) {
      const promptCount = Number(file.prompt_count || 0);
      const label = document.createElement("label");
      label.className = `external-wildcards-file${file.error ? " has-error" : ""}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.fileId = file.id;
      checkbox.dataset.importable = !file.error && promptCount > 0
        ? "1"
        : "0";
      checkbox.disabled = checkbox.dataset.importable !== "1";
      checkbox.checked = state.externalWildcardSelected.has(file.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.externalWildcardSelected.add(file.id);
        else state.externalWildcardSelected.delete(file.id);
        void applyExternalWildcardSelection();
      });
      const path = document.createElement("span");
      path.className = "external-wildcards-file-path";
      path.textContent = file.relative_path;
      path.title = file.error || file.relative_path;
      const fileCount = document.createElement("span");
      fileCount.className = "external-wildcards-file-count";
      fileCount.textContent = file.error
        ? t("读取失败")
        : t("{count} 条", { count: numberFormatter.format(promptCount) });
      label.append(checkbox, path, fileCount);
      section.appendChild(label);
    }
    list.appendChild(section);
  }
  $("external-wildcards-results").hidden = false;
  syncExternalWildcardSelectionControls();
}

function resetImportPrompts() {
  state.importRequestId += 1;
  state.importFile = null;
  state.importSourceLabel = "";
  state.importSourceType = "";
  state.importContent = "";
  state.importPrompts = [];
  state.importPreview = null;
  clearExternalWildcardResults();
  const input = $("import-prompts-input");
  input.value = "";
  $("import-prompts-file-name").textContent = t("选择或拖入文件");
  $("import-prompts-preview").hidden = true;
  $("import-prompts-preview-list").innerHTML = "";
  $("import-prompts-count").textContent = t("即将导入 0 条提示词");
  $("import-prompts-renamed").textContent = "";
  $("import-prompts-confirm").disabled = true;
  $("import-prompts-drop").classList.remove("dragging");
  $("import-prompts-drop").disabled = false;
  $("external-wildcards-detect").disabled = false;
  document.querySelector('input[name="import-txt-mode"][value="split"]').checked = true;
  setModalStatus("import-prompts-status");
}

function openImportPromptsModal() {
  if (state.creatingEntry) return;
  if (!$("add-prompt-modal").hidden) closeAddPromptModal();
  resetImportPrompts();
  populateFolderOptions($("import-prompts-destination"), state.prefix);
  $("import-prompts-modal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("import-prompts-destination").focus());
}

function closeImportPromptsModal() {
  if (state.parsingImport || state.importingPrompts) return;
  $("import-prompts-modal").hidden = true;
  resetImportPrompts();
  if ($("add-prompt-modal").hidden && $("folder-create-modal").hidden && $("operation-modal").hidden) {
    document.body.classList.remove("modal-open");
  }
}

async function detectExternalWildcards() {
  if (state.parsingImport || state.importingPrompts) return;
  resetImportPrompts();
  const requestId = ++state.importRequestId;
  state.parsingImport = true;
  $("external-wildcards-detect").disabled = true;
  $("import-prompts-drop").disabled = true;
  $("import-prompts-destination").disabled = true;
  setModalStatus("import-prompts-status", t("正在分析其他节点的 Wildcards…"));
  showOperationProgress("scan", 0, t("正在分析其他节点的 Wildcards"));
  const progressId = createProgressId();
  const stopProgressPolling = startOperationProgressPolling(progressId);
  let shouldPreview = false;
  try {
    const data = await api("/pm4a/api/prompts/import/external/scan", {
      method: "POST",
      body: JSON.stringify({ progress_id: progressId }),
    });
    if (requestId !== state.importRequestId) return;
    renderExternalWildcardSources(data);
    state.importFile = null;
    state.importSourceLabel = t("其他节点 Wildcards");
    state.importSourceType = "external_txt";
    state.importPrompts = selectedExternalWildcardFileIds();
    state.importContent = "";
    $("import-prompts-file-name").textContent = state.importSourceLabel;
    if (!Number(data.source_count || 0)) {
      setModalStatus(
        "import-prompts-status",
        t("未检测到其他启用节点的 wildcards 目录"),
      );
    } else if (!state.importPrompts.length) {
      setModalStatus(
        "import-prompts-status",
        t("检测到目录，但没有可导入的 TXT 提示词"),
      );
    } else {
      shouldPreview = true;
    }
  } catch (error) {
    if (requestId !== state.importRequestId) return;
    clearExternalWildcardResults();
    setModalStatus("import-prompts-status", String(error.message || error), "error");
  } finally {
    stopProgressPolling();
    if (requestId === state.importRequestId) {
      state.parsingImport = false;
      $("external-wildcards-detect").disabled = false;
      $("import-prompts-drop").disabled = false;
      $("import-prompts-destination").disabled = false;
      hideOperationProgress();
    }
  }
  if (shouldPreview && requestId === state.importRequestId) {
    await refreshImportPreview(t("正在检查所选 Wildcards"));
  }
}

function looksLikeImportFile(file) {
  return Boolean(file && /\.(?:json|txt)$/i.test(file.name || ""));
}

async function decodeImportFile(file, sourceType) {
  const buffer = await file.arrayBuffer();
  const encodings = sourceType === "json"
    ? ["utf-8"]
    : ["utf-8", "gb18030", "shift_jis", "windows-1252"];
  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch (_) {
      // Try the next common wildcard-file encoding.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

async function parseImportFile(file, onProgress = null, txtMode = "split") {
  if (!looksLikeImportFile(file)) throw new Error(t("请选择 .json 或 .txt 文件"));
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error(t("导入文件不能超过 64 MB"));
  const sourceType = file.name.toLowerCase().endsWith(".txt") ? "txt" : "json";
  const text = await decodeImportFile(file, sourceType);
  if (sourceType === "txt") {
    const lines = text.split(/\r\n?|\n/);
    if (txtMode === "pool") {
      const optionCount = lines.reduce((count, line) => {
        const content = line.trim();
        return count + (content && !content.startsWith("#") ? 1 : 0);
      }, 0);
      if (!optionCount) throw new Error(t("TXT 中没有可导入的提示词行"));
      return {
        sourceType: "txt_pool",
        prompts: [],
        content: text,
        name: file.name,
        optionCount,
      };
    }
    const prompts = [];
    let lastYield = performance.now();
    onProgress?.(0, lines.length, t("正在解析 TXT 行"));
    for (let index = 0; index < lines.length; index += 1) {
      const content = lines[index].trim();
      if (content && !content.startsWith("#")) prompts.push({ content });
      const now = performance.now();
      if (index + 1 === lines.length || now - lastYield >= 24) {
        onProgress?.(index + 1, lines.length, t("正在解析 TXT 行"));
        if (index + 1 < lines.length) await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    if (!prompts.length) throw new Error(t("TXT 中没有可导入的提示词行"));
    return { sourceType, prompts };
  }

  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (error) {
    throw new Error(t("JSON 无法解析：{error}", { error: error.message || error }));
  }
  if (!bundle || bundle.format !== IMPORT_BUNDLE_FORMAT) {
    throw new Error(t("这不是受支持的 PM4A 完整提示词 JSON"));
  }
  if (!Array.isArray(bundle.prompts) || !bundle.prompts.length) {
    throw new Error(t("JSON 中没有可导入的 prompts"));
  }
  const prompts = [];
  let lastYield = performance.now();
  onProgress?.(0, bundle.prompts.length, t("正在解析 JSON 提示词"));
  for (let index = 0; index < bundle.prompts.length; index += 1) {
    prompts.push(bundle.prompts[index]);
    const now = performance.now();
    if (index + 1 === bundle.prompts.length || now - lastYield >= 24) {
      onProgress?.(index + 1, bundle.prompts.length, t("正在解析 JSON 提示词"));
      if (index + 1 < bundle.prompts.length) await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  return { sourceType, prompts };
}

function renderImportPreview(data) {
  state.importPreview = data;
  const count = Number(data.count ?? data.file_count ?? 0);
  const optionCount = Number(data.option_count || 0);
  $("import-prompts-count").textContent = optionCount
    ? t("即将导入 {fileCount} 个 TXT 文件，共 {optionCount} 个选项", {
      fileCount: numberFormatter.format(count),
      optionCount: numberFormatter.format(optionCount),
    })
    : t("即将导入 {count} 条提示词", { count: numberFormatter.format(count) });
  $("import-prompts-renamed").textContent = data.renamed_count
    ? t("{count} 条同名项将自动改名", { count: numberFormatter.format(data.renamed_count) })
    : "";
  const list = $("import-prompts-preview-list");
  list.innerHTML = "";
  for (const item of (data.preview || []).slice(0, 5)) {
    const row = document.createElement("li");
    row.textContent = typeof item === "string"
      ? item
      : item.relative_path || item.title || item.display_path;
    row.title = typeof item === "string" ? item : item.display_path || row.textContent;
    list.appendChild(row);
  }
  if (count > 5) {
    const more = document.createElement("li");
    more.textContent = t("… 以及另外 {count} 条", { count: numberFormatter.format(count - 5) });
    list.appendChild(more);
  }
  $("import-prompts-preview").hidden = false;
  $("import-prompts-confirm").disabled = count < 1;
  setModalStatus(
    "import-prompts-status",
    t("{name} 已解析完成", {
      name: state.importSourceLabel || state.importFile?.name || t("导入文件"),
    }),
    "success",
  );
}

async function refreshImportPreview(progressLabel = t("正在检查目标目录")) {
  const hasInput = state.importSourceType === "txt_pool"
    ? Boolean(state.importContent)
    : state.importPrompts.length > 0;
  if (!hasInput || state.parsingImport || state.importingPrompts) return;
  if (
    state.importSourceType !== "txt_pool"
    && state.importSourceType !== "external_txt"
    && state.importPrompts.length > MAX_BULK_IMPORT_PROMPTS
  ) {
    state.importPreview = null;
    $("import-prompts-preview").hidden = true;
    $("import-prompts-confirm").disabled = true;
    setModalStatus(
      "import-prompts-status",
      t("已选择 {count} 条，超过单次导入上限 {maximum} 条，请取消部分文件", {
        count: numberFormatter.format(state.importPrompts.length),
        maximum: numberFormatter.format(MAX_BULK_IMPORT_PROMPTS),
      }),
      "error",
    );
    return;
  }
  const requestId = ++state.importRequestId;
  state.parsingImport = true;
  $("import-prompts-confirm").disabled = true;
  $("import-prompts-destination").disabled = true;
  $("external-wildcards-detect").disabled = true;
  $("external-wildcards-toggle-all").disabled = true;
  for (const input of $("external-wildcards-list").querySelectorAll("input[data-file-id]")) {
    input.disabled = true;
  }
  const workCount = state.importSourceType === "txt_pool" ? 1 : state.importPrompts.length;
  showOperationProgress("parse", workCount, progressLabel);
  const progressId = createProgressId();
  const stopProgressPolling = startOperationProgressPolling(progressId);
  try {
    const folder = $("import-prompts-destination").value;
    const endpoint = state.importSourceType === "txt_pool"
      ? "/pm4a/api/prompts/import/txt/preview"
      : state.importSourceType === "external_txt"
        ? "/pm4a/api/prompts/import/external/preview"
        : "/pm4a/api/prompts/import/preview";
    const payload = state.importSourceType === "txt_pool"
      ? {
        folder,
        name: state.importFile?.name || state.importSourceLabel,
        content: state.importContent,
        progress_id: progressId,
      }
      : state.importSourceType === "external_txt"
        ? { folder, file_ids: state.importPrompts, progress_id: progressId }
        : {
          folder,
          source_type: state.importSourceType,
          prompts: state.importPrompts,
          progress_id: progressId,
        };
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (requestId !== state.importRequestId) return;
    renderImportPreview(data);
  } catch (error) {
    if (requestId !== state.importRequestId) return;
    state.importPreview = null;
    $("import-prompts-preview").hidden = true;
    setModalStatus("import-prompts-status", String(error.message || error), "error");
  } finally {
    stopProgressPolling();
    if (requestId === state.importRequestId) {
      state.parsingImport = false;
      $("import-prompts-destination").disabled = false;
      $("external-wildcards-detect").disabled = false;
      syncExternalWildcardSelectionControls();
      hideOperationProgress();
    }
  }
}

async function selectImportFile(file) {
  if (!file || state.parsingImport || state.importingPrompts) return;
  const requestId = ++state.importRequestId;
  state.parsingImport = true;
  clearExternalWildcardResults();
  state.importFile = file;
  state.importSourceLabel = file.name || t("导入文件");
  state.importPrompts = [];
  state.importPreview = null;
  $("import-prompts-file-name").textContent = file.name || t("导入文件");
  $("import-prompts-preview").hidden = true;
  $("import-prompts-confirm").disabled = true;
  $("import-prompts-destination").disabled = true;
  setModalStatus("import-prompts-status", t("正在解析文件…"));
  showOperationProgress("parse", 0, t("正在读取 {name}", { name: file.name || t("导入文件") }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  let stopProgressPolling = () => {};
  try {
    const txtMode = document.querySelector(
      'input[name="import-txt-mode"]:checked'
    )?.value || "split";
    const parsed = await parseImportFile(file, setOperationProgress, txtMode);
    if (requestId !== state.importRequestId) return;
    state.importSourceType = parsed.sourceType;
    state.importPrompts = parsed.prompts;
    state.importContent = parsed.content || "";
    state.importOptionCount = Number(parsed.optionCount || parsed.prompts.length);
    const workCount = parsed.sourceType === "txt_pool" ? 1 : parsed.prompts.length;
    if (
      parsed.sourceType !== "txt_pool"
      && parsed.prompts.length > MAX_BULK_IMPORT_PROMPTS
    ) {
      throw new Error(t(
        "已选择 {count} 条，超过单次导入上限 {maximum} 条，请取消部分文件",
        {
          count: numberFormatter.format(parsed.prompts.length),
          maximum: numberFormatter.format(MAX_BULK_IMPORT_PROMPTS),
        },
      ));
    }
    setOperationProgress(0, workCount, t("正在检查目标目录"));
    const progressId = createProgressId();
    stopProgressPolling = startOperationProgressPolling(progressId);
    const isPool = parsed.sourceType === "txt_pool";
    const data = await api(
      isPool
        ? "/pm4a/api/prompts/import/txt/preview"
        : "/pm4a/api/prompts/import/preview",
      {
      method: "POST",
      body: JSON.stringify(isPool ? {
        folder: $("import-prompts-destination").value,
        name: parsed.name,
        content: parsed.content,
        progress_id: progressId,
      } : {
        folder: $("import-prompts-destination").value,
        source_type: parsed.sourceType,
        prompts: parsed.prompts,
        progress_id: progressId,
      }),
    });
    if (requestId !== state.importRequestId) return;
    renderImportPreview(data);
  } catch (error) {
    if (requestId !== state.importRequestId) return;
    state.importFile = null;
    state.importSourceLabel = "";
    state.importSourceType = "";
    state.importContent = "";
    state.importOptionCount = 0;
    state.importPrompts = [];
    state.importPreview = null;
    $("import-prompts-preview").hidden = true;
    setModalStatus("import-prompts-status", String(error.message || error), "error");
  } finally {
    stopProgressPolling();
    if (requestId === state.importRequestId) {
      state.parsingImport = false;
      $("import-prompts-destination").disabled = false;
      hideOperationProgress();
    }
  }
}

async function importPrompts(event) {
  event.preventDefault();
  if (state.importingPrompts || state.parsingImport || !state.importPreview) return;
  state.importingPrompts = true;
  const destination = $("import-prompts-destination").value;
  const itemCount = state.importSourceType === "txt_pool"
    ? 1
    : state.importPrompts.length;
  $("import-prompts-confirm").disabled = true;
  $("import-prompts-cancel").disabled = true;
  $("import-prompts-destination").disabled = true;
  showOperationProgress("import", itemCount);
  const progressId = createProgressId();
  const stopProgressPolling = startOperationProgressPolling(progressId);
  try {
    const endpoint = state.importSourceType === "txt_pool"
      ? "/pm4a/api/prompts/import/txt"
      : state.importSourceType === "external_txt"
        ? "/pm4a/api/prompts/import/external"
        : "/pm4a/api/prompts/import";
    const payload = state.importSourceType === "txt_pool"
      ? {
        folder: destination,
        name: state.importFile?.name || state.importSourceLabel,
        content: state.importContent,
        progress_id: progressId,
      }
      : state.importSourceType === "external_txt"
        ? { folder: destination, file_ids: state.importPrompts, progress_id: progressId }
        : {
          folder: destination,
          source_type: state.importSourceType,
          prompts: state.importPrompts,
          progress_id: progressId,
        };
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showOperationRefreshProgress(itemCount, t("导入已完成，正在同步提示词列表"));
    state.entryCache.clear();
    if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites);
    await loadTree();
    await selectFolder(destination, { preserveInspector: false });
    state.importingPrompts = false;
    $("import-prompts-modal").hidden = true;
    resetImportPrompts();
    document.body.classList.remove("modal-open");
    const importedCount = data.created || itemCount;
    toast(
      data.renamed_count
        ? t("已导入 {count} 条提示词，{renamedCount} 条同名项已自动改名", {
          count: importedCount,
          renamedCount: data.renamed_count,
        })
        : t("已导入 {count} 条提示词", { count: importedCount }),
      "success",
    );
  } catch (error) {
    setModalStatus("import-prompts-status", String(error.message || error), "error");
  } finally {
    stopProgressPolling();
    state.importingPrompts = false;
    hideOperationProgress();
    $("import-prompts-confirm").disabled = !state.importPreview;
    $("import-prompts-cancel").disabled = false;
    $("import-prompts-destination").disabled = false;
  }
}

async function exportFolderPrompts(folderPath = "") {
  showOperationProgress("export", 0, folderPath ? t("正在整理文件夹中的提示词") : t("正在整理全部提示词"));
  const progressId = createProgressId();
  const stopProgressPolling = startOperationProgressPolling(progressId);
  try {
    const data = await api(`/pm4a/api/prompts/export?folder=${encodeURIComponent(folderPath || "")}&progress_id=${encodeURIComponent(progressId)}`);
    const exportedCount = Number(data.bundle?.prompt_count || 0);
    if (exportedCount > 0) setOperationProgress(exportedCount, exportedCount, t("正在生成下载文件"));
    const text = `${JSON.stringify(data.bundle, null, 2)}\n`;
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = data.filename || (getLocale() === "en" ? "PM4A-Prompts.json" : "PM4A提示词.json");
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("已导出 {count} 条提示词", { count: numberFormatter.format(data.bundle?.prompt_count || 0) }), "success");
  } catch (error) {
    toast(t("导出失败：{error}", { error: error.message || error }), "error");
  } finally {
    stopProgressPolling();
    hideOperationProgress();
  }
}

function hideFolderContextMenu() {
  $("folder-context-menu").hidden = true;
}

function positionContextMenu(event, mode) {
  const menu = $("folder-context-menu");
  menu.dataset.mode = mode;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(event.clientY, window.innerHeight - rect.height - 6))}px`;
  menu.querySelector("button:not([hidden])")?.focus();
}

function showFolderContextMenu(event, folderPath = "") {
  event.preventDefault();
  event.stopPropagation();
  state.contextFolderPath = folderPath || "";
  state.contextItems = folderPath ? [{ type: "folder", key: folderPath }] : [];
  const menu = $("folder-context-menu");
  const createLabel = menu.querySelector('[data-context-action="create"] span');
  const renameItem = menu.querySelector('[data-context-action="rename"]');
  const copyLabel = menu.querySelector('[data-context-action="wildcard"] span');
  const exportLabel = menu.querySelector('[data-context-action="export"] span');
  const generateLabel = menu.querySelector('[data-context-action="generate"] span');
  createLabel.textContent = folderPath ? t("新建子文件夹") : t("在根目录新建文件夹");
  renameItem.hidden = !folderPath;
  copyLabel.textContent = folderPath ? t("复制文件夹 Wildcard") : t("复制根目录 Wildcard");
  exportLabel.textContent = folderPath ? t("导出此文件夹提示词") : t("导出根目录全部提示词");
  generateLabel.textContent = folderPath ? t("批量生成此文件夹示例图") : t("批量生成全部示例图");
  menu.querySelectorAll('[data-context-action="create"], [data-context-action="wildcard"], [data-context-action="export"], [data-context-action="generate"]').forEach((item) => {
    item.hidden = false;
  });
  menu.querySelectorAll("[data-context-prompt]").forEach((item) => {
    item.hidden = true;
  });
  menu.querySelectorAll("[data-context-operation]").forEach((item) => {
    item.hidden = !folderPath;
  });
  menu.querySelector('[data-context-action="operation-copy"] span').textContent = t("复制到…");
  menu.querySelector('[data-context-action="operation-move"] span').textContent = t("移动到…");
  menu.querySelector('[data-context-action="operation-delete"] span').textContent = t("删除");
  positionContextMenu(event, "folder");
}

function showPromptContextMenu(event, key) {
  event.preventDefault();
  event.stopPropagation();
  if (state.batchMode && state.batchSelection.has(key)) {
    state.contextItems = [...state.batchSelection].map((selectedKey) => ({ type: "file", key: selectedKey }));
  } else {
    state.contextItems = [{ type: "file", key }];
    if (state.batchMode) {
      state.batchSelection.clear();
      state.batchSelection.add(key);
      updateSelectedRow();
      updateBatchModeButton();
    }
  }
  const count = state.contextItems.length;
  const menu = $("folder-context-menu");
  menu.querySelectorAll('[data-context-action="create"], [data-context-action="rename"], [data-context-action="wildcard"], [data-context-action="export"], [data-context-action="generate"]').forEach((item) => {
    item.hidden = true;
  });
  menu.querySelectorAll("[data-context-prompt]").forEach((item) => {
    item.hidden = false;
  });
  menu.querySelectorAll("[data-context-operation]").forEach((item) => {
    item.hidden = false;
  });
  menu.querySelector('[data-context-action="prompt-wildcard"] span').textContent = count > 1
    ? t("复制 {count} 项为 Wildcard", { count })
    : t("复制为 Wildcard");
  menu.querySelector('[data-context-action="operation-copy"] span').textContent = count > 1 ? t("复制 {count} 项到…", { count }) : t("复制到…");
  menu.querySelector('[data-context-action="operation-move"] span').textContent = count > 1 ? t("移动 {count} 项到…", { count }) : t("移动到…");
  menu.querySelector('[data-context-action="operation-delete"] span').textContent = count > 1 ? t("删除所选提示词") : t("删除");
  positionContextMenu(event, "prompt");
}

function closeOperationModal() {
  if (state.operatingItems) return;
  $("operation-modal").hidden = true;
  state.pendingOperation = "";
  state.pendingOperationItems = [];
  if (
    $("add-prompt-modal").hidden
    && $("folder-create-modal").hidden
    && $("import-prompts-modal").hidden
    && $("confirm-modal").hidden
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openOperationModal(action, items) {
  state.pendingOperation = action;
  state.pendingOperationItems = items.map((item) => ({ ...item }));
  $("operation-title").textContent = action === "move" ? t("移动到") : t("复制到");
  $("operation-summary").textContent = t("已选择 {count} 项", { count: items.length });
  $("operation-confirm").textContent = action === "move" ? t("移动") : t("复制");
  setModalStatus("operation-status");
  populateFolderOptions($("operation-destination"), state.prefix);
  $("operation-modal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("operation-destination").focus());
}

let confirmModalResolver = null;

function settleConfirmModal(result) {
  if (!confirmModalResolver) return;
  const resolve = confirmModalResolver;
  confirmModalResolver = null;
  resolve(Boolean(result));
}

function closeConfirmModal(result = false) {
  $("confirm-modal").hidden = true;
  if (
    $("add-prompt-modal").hidden
    && $("folder-create-modal").hidden
    && $("import-prompts-modal").hidden
    && $("operation-modal").hidden
  ) {
    document.body.classList.remove("modal-open");
  }
  settleConfirmModal(result);
}

function openConfirmModal({
  title = t("删除确认"),
  message = "",
  confirmLabel = t("删除"),
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    if (confirmModalResolver) settleConfirmModal(false);
    confirmModalResolver = resolve;
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-ok").textContent = confirmLabel;
    $("confirm-ok").classList.toggle("modal-danger-button", danger);
    $("confirm-modal").hidden = false;
    document.body.classList.add("modal-open");
    requestAnimationFrame(() => $("confirm-cancel").focus());
  });
}

function applyDeletedFilesLocally(items, data) {
  const fallbackKeys = items
    .filter((item) => item.type === "file")
    .map((item) => item.key);
  const deletedKeys = new Set(
    Array.isArray(data.deleted_keys) && data.deleted_keys.length
      ? data.deleted_keys
      : fallbackKeys,
  );

  for (const key of deletedKeys) {
    state.entryCache.delete(key);
    state.favorites.delete(key);
  }

  const previousLength = state.items.length;
  state.items = state.items.filter((item) => !deletedKeys.has(item.key));
  const removedVisible = previousLength - state.items.length;
  document.querySelectorAll("#prompt-list .prompt-item").forEach((item) => {
    if (deletedKeys.has(item.dataset.key)) item.remove();
  });

  state.total = Math.max(0, state.total - removedVisible);
  state.offset = Math.max(0, state.offset - removedVisible);
  state.hasMore = state.offset < state.total;
  const serverFileCount = Number(data.file_count);
  state.fileCount = Number.isFinite(serverFileCount)
    ? Math.max(0, serverFileCount)
    : Math.max(0, state.fileCount - deletedKeys.size);

  const touchedFolders = new Set();
  for (const key of deletedKeys) {
    const parts = String(key).split("/").filter(Boolean);
    parts.pop();
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      const folder = state.folderMap.get(path);
      if (folder) folder.file_count = Math.max(0, Number(folder.file_count || 0) - 1);
      touchedFolders.add(path);
    }
  }
  document.querySelectorAll("#folder-tree [data-folder-path]").forEach((row) => {
    const path = row.dataset.folderPath;
    if (!touchedFolders.has(path)) return;
    const count = row.querySelector(".folder-count");
    if (count) count.textContent = numberFormatter.format(state.folderMap.get(path)?.file_count || 0);
  });

  $("all-count").textContent = numberFormatter.format(state.fileCount);
  $("library-meta").textContent = t("{count} 条提示词", { count: numberFormatter.format(state.fileCount) });
  if (deletedKeys.has(state.selectedKey)) clearInspector();
  else {
    state.currentIndex = state.items.findIndex((item) => item.key === state.selectedKey);
    updateDetailNavigation(false);
    updateSelectedRow();
  }

  hideListStates();
  if (state.total === 0) showEmptyState();
  updateResultSummary(false);
  updateFavoriteFilterButton();
  updateBatchModeButton();
  if (!state.items.length && state.hasMore) loadNextPage();
}

function remapSelectedPrompt(keyMoves) {
  if (!state.selectedKey || !keyMoves || typeof keyMoves !== "object") return "";
  const oldKey = state.selectedKey;
  const newKey = typeof keyMoves[oldKey] === "string" ? keyMoves[oldKey] : "";
  if (!newKey || newKey === oldKey) return "";

  state.selectedKey = newKey;
  if (state.selected?.key === oldKey) {
    state.selected = { ...state.selected, key: newKey };
  }
  state.entryCache.delete(oldKey);
  return newKey;
}

function showOperationProgress(action, itemCount = 0, detail = "") {
  const labels = {
    delete: [t("正在删除"), t("正在删除文件，请稍候")],
    copy: [t("正在复制"), t("正在复制文件，请稍候")],
    move: [t("正在移动"), t("正在移动文件，请稍候")],
    parse: [t("正在解析"), t("正在解析导入文件")],
    scan: [t("正在检测"), t("正在分析其他节点的 Wildcards")],
    import: [t("正在导入…"), t("正在写入提示词，请稍候")],
    export: [t("正在导出"), t("正在生成完整 JSON，请稍候")],
  };
  const [title, summary] = labels[action] || [t("正在处理"), t("正在处理文件，请稍候")];
  $("operation-progress-title").textContent = title;
  $("operation-progress-summary").textContent = detail || summary;
  setOperationProgress(0, itemCount);
  $("operation-progress").hidden = false;
  document.body.classList.add("operation-busy");
}

function setOperationProgress(current, total, summary = "") {
  const safeTotal = Math.max(0, Number.isFinite(Number(total)) ? Math.trunc(Number(total)) : 0);
  const safeCurrent = safeTotal
    ? Math.min(safeTotal, Math.max(0, Number.isFinite(Number(current)) ? Math.trunc(Number(current)) : 0))
    : 0;
  const track = $("operation-progress-track");
  const count = $("operation-progress-count");
  const determinate = safeTotal > 0;
  track.classList.toggle("is-indeterminate", !determinate);
  count.hidden = !determinate;
  if (determinate) {
    const ratio = safeCurrent / safeTotal;
    track.style.setProperty("--operation-progress-ratio", String(ratio));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(safeTotal));
    track.setAttribute("aria-valuenow", String(safeCurrent));
    count.textContent = `${numberFormatter.format(safeCurrent)} / ${numberFormatter.format(safeTotal)}`;
  } else {
    track.style.removeProperty("--operation-progress-ratio");
    track.removeAttribute("aria-valuemin");
    track.removeAttribute("aria-valuemax");
    track.removeAttribute("aria-valuenow");
  }
  if (summary) $("operation-progress-summary").textContent = summary;
}

function createProgressId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `pm4a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function startOperationProgressPolling(progressId) {
  let stopped = false;
  let timer = 0;
  const poll = async () => {
    if (stopped) return;
    try {
      const response = await fetch(`/pm4a/api/progress?progress_id=${encodeURIComponent(progressId)}`, {
        cache: "no-store",
        headers: localeHeaders(),
      });
      if (response.ok) {
        const progress = await response.json();
        if (!stopped && progress.success !== false) {
          setOperationProgress(progress.current, progress.total, progress.summary || "");
          if (progress.done) return;
        }
      }
    } catch (_) {
      // The main operation request owns error reporting; a missed poll is harmless.
    }
    if (!stopped) timer = window.setTimeout(poll, PROGRESS_POLL_INTERVAL_MS);
  };
  poll();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

function hideOperationProgress() {
  $("operation-progress").hidden = true;
  document.body.classList.remove("operation-busy");
}

function showOperationRefreshProgress(itemCount, summary = t("文件操作已完成，正在同步列表")) {
  $("operation-progress-title").textContent = t("正在更新界面");
  setOperationProgress(itemCount, itemCount, summary);
}

async function runItemOperation(action, items, destination = "") {
  if (!items.length || state.operatingItems) return;
  state.operatingItems = true;
  showOperationProgress(action, items.length);
  const progressId = createProgressId();
  const stopProgressPolling = startOperationProgressPolling(progressId);
  if (!$("operation-modal").hidden) {
    $("operation-confirm").disabled = true;
    $("operation-cancel").disabled = true;
    setModalStatus("operation-status", action === "move" ? t("正在移动…") : t("正在复制…"));
  }
  try {
    const data = await api("/pm4a/api/entries/operate", {
      method: "POST",
      body: JSON.stringify({ action, items, destination, progress_id: progressId }),
    });
    showOperationRefreshProgress(items.length);
    const incrementalFileDelete = action === "delete" && items.every((item) => item.type === "file");
    const selectedKeyBeforeOperation = state.selectedKey;
    const selectedWasDeleted = action === "delete"
      && Array.isArray(data.deleted_keys)
      && data.deleted_keys.includes(selectedKeyBeforeOperation);
    const movedSelectedKey = action === "move" ? remapSelectedPrompt(data.key_moves) : "";
    state.batchSelection.clear();
    if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites);
    if (action !== "copy" && items.some(
      (item) => item.type === "folder" && (state.prefix === item.key || state.prefix.startsWith(`${item.key}/`)),
    )) {
      state.prefix = "";
      persistPrefix();
    }
    state.pendingOperation = "";
    state.pendingOperationItems = [];
    $("operation-modal").hidden = true;
    document.body.classList.remove("modal-open");
    if (incrementalFileDelete) {
      applyDeletedFilesLocally(items, data);
    } else {
      if (selectedWasDeleted) clearInspector();
      state.entryCache.clear();
      if (action === "delete" && Array.isArray(data.deleted_keys)) {
        for (const key of data.deleted_keys) state.favorites.delete(key);
      }
      await loadTree();
      await resetAndLoadList({ preserveInspector: true });
      if (movedSelectedKey && !state.selected) selectPrompt(movedSelectedKey);
      updateFavoriteFilterButton();
      updateBatchModeButton();
    }
    const summaryKeys = { delete: "已删除 {count} 项", copy: "已复制 {count} 项", move: "已移动 {count} 项" };
    toast(t(summaryKeys[action], { count: data.affected || items.length }), "success");
  } catch (error) {
    if (!$("operation-modal").hidden) {
      setModalStatus("operation-status", String(error.message || error), "error");
    } else {
      toast(t("操作失败：{error}", { error: error.message || error }), "error");
    }
  } finally {
    stopProgressPolling();
    hideOperationProgress();
    state.operatingItems = false;
    $("operation-confirm").disabled = false;
    $("operation-cancel").disabled = false;
  }
}

async function requestItemOperation(action, items) {
  if (!items.length) return;
  if (action === "delete") {
    const confirmMessage = items.length > 1
      ? t("确定永久删除选中的 {count} 项吗？此操作无法撤销。", { count: items.length })
      : t("确定永久删除这个项目吗？此操作无法撤销。");
    // Native window.confirm steals Electron/ComfyUI keyboard focus until the
    // app is deactivated and reactivated; keep confirmation in-page instead.
    const confirmed = await openConfirmModal({
      title: t("删除确认"),
      message: confirmMessage,
      confirmLabel: t("删除"),
      danger: true,
    });
    if (!confirmed) return;
    await runItemOperation("delete", items);
    return;
  }
  openOperationModal(action, items);
}

function openFolderCreateModal(parent = "") {
  state.folderCreateParent = parent || "";
  state.folderEditMode = "create";
  state.folderEditTarget = "";
  const display = parent ? getFolderDisplayPath(parent) : t("根目录");
  $("folder-create-title").textContent = t("新建文件夹");
  $("folder-create-parent").textContent = t("创建位置：{path}", { path: display });
  $("folder-create-name").value = "";
  $("folder-create-save").textContent = t("创建");
  setModalStatus("folder-create-status");
  $("folder-create-modal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => $("folder-create-name").focus());
}

function openFolderRenameModal(folderPath) {
  if (!folderPath) return;
  state.folderCreateParent = "";
  state.folderEditMode = "rename";
  state.folderEditTarget = folderPath;
  const display = getFolderDisplayPath(folderPath) || folderPath;
  const name = state.folderMap.get(folderPath)?.name || display.split("/").pop() || "";
  $("folder-create-title").textContent = t("重命名文件夹");
  $("folder-create-parent").textContent = t("当前路径：{path}", { path: display });
  $("folder-create-name").value = name;
  $("folder-create-save").textContent = t("重命名");
  setModalStatus("folder-create-status");
  $("folder-create-modal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    $("folder-create-name").focus();
    $("folder-create-name").select();
  });
}

function remapFolderPrefix(value, oldPath, newPath) {
  const current = String(value || "");
  if (current === oldPath) return newPath;
  if (current.startsWith(`${oldPath}/`)) return `${newPath}${current.slice(oldPath.length)}`;
  return current;
}

function closeFolderCreateModal() {
  if (state.creatingFolder) return;
  $("folder-create-modal").hidden = true;
  if (
    $("add-prompt-modal").hidden
    && $("import-prompts-modal").hidden
    && $("operation-modal").hidden
    && $("confirm-modal").hidden
  ) {
    document.body.classList.remove("modal-open");
  }
}

async function saveNewFolder(event) {
  event.preventDefault();
  if (state.creatingFolder) return;
  const name = $("folder-create-name").value.trim();
  if (!name) {
    setModalStatus("folder-create-status", t("请输入文件夹名称"), "error");
    $("folder-create-name").focus();
    return;
  }
  const renaming = state.folderEditMode === "rename";
  const originalPath = state.folderEditTarget;
  state.creatingFolder = true;
  $("folder-create-save").disabled = true;
  $("folder-create-cancel").disabled = true;
  setModalStatus("folder-create-status", renaming ? t("正在重命名…") : t("正在创建…"));
  try {
    const data = renaming
      ? await api("/pm4a/api/folder/rename", {
        method: "POST",
        body: JSON.stringify({ folder: originalPath, name }),
      })
      : await api("/pm4a/api/folder/create", {
        method: "POST",
        body: JSON.stringify({ parent: state.folderCreateParent, name }),
      });
    const folder = data.folder;
    if (!folder?.path) throw new Error(renaming ? t("重命名结果无效") : t("创建结果无效"));
    if (renaming) {
      const oldPath = folder.old_path || originalPath;
      const newPath = folder.path;
      const oldDisplay = getFolderDisplayPath(oldPath) || oldPath;
      const selectedKey = state.selectedKey;
      const nextSelectedKey = remapFolderPrefix(selectedKey, oldPath, newPath);
      state.prefix = remapFolderPrefix(state.prefix, oldPath, newPath);
      persistPrefix();
      state.expanded = new Set(
        [...state.expanded].map((path) => remapFolderPrefix(path, oldPath, newPath)),
      );
      persistExpanded();
      if (selectedKey && nextSelectedKey !== selectedKey) {
        state.selectedKey = nextSelectedKey;
        if (state.selected) {
          state.selected = {
            ...state.selected,
            key: nextSelectedKey,
            display_path: remapFolderPrefix(
              state.selected.display_path,
              oldDisplay,
              folder.display_path || newPath,
            ),
          };
        }
      }
      state.entryCache.clear();
      if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites);
    }
    await loadTree();
    expandFolderPath(folder.path);
    state.creatingFolder = false;
    closeFolderCreateModal();
    if (renaming) {
      await resetAndLoadList({ preserveInspector: true });
      toast(t("已重命名文件夹：{name}", { name: folder.display_path || folder.name }), "success");
    } else {
      await selectFolder(folder.path, { preserveInspector: true });
      toast(t("已创建文件夹：{name}", { name: folder.display_path || folder.name }), "success");
    }
  } catch (error) {
    setModalStatus("folder-create-status", String(error.message || error), "error");
  } finally {
    state.creatingFolder = false;
    $("folder-create-save").disabled = false;
    $("folder-create-cancel").disabled = false;
  }
}

function setSendStatus(message = "", type = "") {
  const element = $("send-status");
  element.textContent = message;
  element.className = `send-status ${type}`.trim();
}

function makeSendButton(slot, key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `send-button ${slot}-slot`;
  button.dataset.slot = slot;
  button.dataset.key = key;
  button.title = t(SEND_TO_LABELS[slot]);
  button.setAttribute("aria-label", t(SEND_TO_LABELS[slot]));
  button.innerHTML = ICONS[slot];
  return button;
}

function makeCopyButton(key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "send-button copy-button";
  button.dataset.copyKey = key;
  button.title = t("复制提示词内容");
  button.setAttribute("aria-label", t("复制提示词内容"));
  button.innerHTML = COPY_ICON;
  return button;
}

function syncFavoriteButton(button, key) {
  const active = state.favorites.has(key);
  button.classList.toggle("active", active);
  button.title = active ? t("取消收藏") : t("添加到收藏");
  button.setAttribute("aria-label", active ? t("取消收藏：{key}", { key }) : t("添加到收藏：{key}", { key }));
  button.setAttribute("aria-pressed", String(active));
}

function makeFavoriteButton(key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "favorite-button";
  button.dataset.favoriteKey = key;
  button.innerHTML = STAR_ICON;
  syncFavoriteButton(button, key);
  return button;
}

function updateFavoriteButtons(key) {
  document.querySelectorAll("[data-favorite-key]").forEach((button) => {
    if (button.dataset.favoriteKey === key) syncFavoriteButton(button, key);
  });
}

function replaceFavoriteKey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey || !state.favorites.delete(oldKey)) return;
  state.favorites.add(newKey);
}

function setFavoriteButtonsBusy(key, busy) {
  document.querySelectorAll("[data-favorite-key]").forEach((button) => {
    if (button.dataset.favoriteKey === key) button.disabled = busy;
  });
}

async function loadLibraryFavorites() {
  try {
    const data = await api("/pm4a/api/favorites");
    const serverFavorites = Array.isArray(data.favorites)
      ? data.favorites.filter((key) => typeof key === "string")
      : [];
    state.favorites = new Set(serverFavorites);
  } catch (error) {
    state.favorites = new Set();
    toast(t("收藏文件读取失败：{error}", { error: error.message || error }), "error");
  }
}

async function toggleFavorite(key) {
  if (!key || state.favoriteRequests.has(key)) return;
  const adding = !state.favorites.has(key);
  if (adding) state.favorites.add(key);
  else state.favorites.delete(key);
  updateFavoriteButtons(key);
  state.favoriteRequests.add(key);
  setFavoriteButtonsBusy(key, true);
  try {
    await api("/pm4a/api/favorites", {
      method: "POST",
      body: JSON.stringify({ key, favorite: adding }),
    });
    toast(adding ? t("已添加到收藏") : t("已取消收藏"), "success");
    if (state.favoritesOnly && !adding) await resetAndLoadList();
  } catch (error) {
    if (adding) state.favorites.delete(key);
    else state.favorites.add(key);
    updateFavoriteButtons(key);
    toast(t("收藏保存失败：{error}", { error: error.message || error }), "error");
  } finally {
    state.favoriteRequests.delete(key);
    setFavoriteButtonsBusy(key, false);
  }
}

function updateFavoriteFilterButton() {
  const button = $("btn-favorites-only");
  button.classList.toggle("active", state.favoritesOnly);
  button.setAttribute("aria-pressed", String(state.favoritesOnly));
  const label = state.favoritesOnly ? t("显示全部提示词") : t("只显示收藏的提示词");
  button.title = label;
  button.setAttribute("aria-label", label);
}

function updateBatchModeButton() {
  const button = $("btn-batch-mode");
  const count = state.batchSelection.size;
  button.classList.toggle("active", state.batchMode);
  button.setAttribute("aria-pressed", String(state.batchMode));
  button.setAttribute("aria-label", state.batchMode ? t("关闭批量选择") : t("开启批量选择"));
  button.title = state.batchMode ? t("关闭批量选择") : t("批量选择提示词");
  $("batch-mode-label").textContent = state.batchMode && count ? t("已选 {count}", { count }) : t("批量");
}

function setBatchMode(enabled) {
  state.batchMode = Boolean(enabled);
  if (!state.batchMode) state.batchSelection.clear();
  document.body.classList.toggle("batch-mode", state.batchMode);
  updateBatchModeButton();
  updateSelectedRow();
}

function toggleBatchSelection(key) {
  if (state.batchSelection.has(key)) state.batchSelection.delete(key);
  else state.batchSelection.add(key);
  updateBatchModeButton();
  updateSelectedRow();
}

function syncBatchSelectionVisual() {
  document.querySelectorAll("#prompt-list .prompt-item").forEach((row) => {
    const batchSelected = state.batchSelection.has(row.dataset.key);
    row.classList.toggle("batch-selected", batchSelected);
    const selected = Boolean(state.selectedKey) && row.dataset.key === state.selectedKey;
    row.setAttribute("aria-selected", String(selected || batchSelected));
  });
  updateBatchModeButton();
}

const BATCH_MARQUEE_THRESHOLD_PX = 6;

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function setupBatchMarqueeSelection() {
  const surface = $("list-scroll");
  if (!surface) return;
  // List actually scrolls inside the library pane, not #list-scroll.
  const scroller = $("library-pane") || surface;

  let pointerId = null;
  let startClientX = 0;
  let startClientY = 0;
  let startContentX = 0;
  let startContentY = 0;
  let lastClientX = 0;
  let lastClientY = 0;
  let active = false;
  let suppressClick = false;
  let baseSelection = null;
  let marquee = null;

  const contentPointFromClient = (clientX, clientY) => {
    const rect = scroller.getBoundingClientRect();
    return {
      x: clientX - rect.left + scroller.scrollLeft,
      y: clientY - rect.top + scroller.scrollTop,
    };
  };

  const rowContentRect = (row) => {
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      left: rowRect.left - scrollerRect.left + scroller.scrollLeft,
      top: rowRect.top - scrollerRect.top + scroller.scrollTop,
      right: rowRect.right - scrollerRect.left + scroller.scrollLeft,
      bottom: rowRect.bottom - scrollerRect.top + scroller.scrollTop,
    };
  };

  const ensureMarquee = () => {
    if (marquee) return marquee;
    marquee = document.createElement("div");
    marquee.className = "batch-marquee";
    marquee.hidden = true;
    document.body.appendChild(marquee);
    return marquee;
  };

  const clearMarquee = () => {
    if (!marquee) return;
    marquee.hidden = true;
    marquee.style.cssText = "";
  };

  const finish = (event) => {
    if (pointerId === null) return;
    if (event && typeof event.pointerId === "number" && event.pointerId !== pointerId) return;
    const capturedId = pointerId;
    const wasActive = active;
    pointerId = null;
    active = false;
    baseSelection = null;
    surface.classList.remove("batch-marquee-active");
    if (wasActive) {
      suppressClick = true;
      clearMarquee();
      window.setTimeout(() => {
        suppressClick = false;
      }, 120);
    }
    try {
      if (surface.hasPointerCapture?.(capturedId)) {
        surface.releasePointerCapture(capturedId);
      }
    } catch (_) {
      // Ignore if capture was never set or already released.
    }
  };

  const updateFromPointer = (clientX, clientY) => {
    lastClientX = clientX;
    lastClientY = clientY;
    const current = contentPointFromClient(clientX, clientY);
    const left = Math.min(startContentX, current.x);
    const top = Math.min(startContentY, current.y);
    const right = Math.max(startContentX, current.x);
    const bottom = Math.max(startContentY, current.y);
    const selectionRect = { left, top, right, bottom };

    const scrollerRect = scroller.getBoundingClientRect();
    const viewLeft = left - scroller.scrollLeft + scrollerRect.left;
    const viewTop = top - scroller.scrollTop + scrollerRect.top;
    const viewRight = right - scroller.scrollLeft + scrollerRect.left;
    const viewBottom = bottom - scroller.scrollTop + scrollerRect.top;
    const clipLeft = Math.max(viewLeft, scrollerRect.left);
    const clipTop = Math.max(viewTop, scrollerRect.top);
    const clipRight = Math.min(viewRight, scrollerRect.right);
    const clipBottom = Math.min(viewBottom, scrollerRect.bottom);
    const box = ensureMarquee();
    if (clipRight > clipLeft && clipBottom > clipTop) {
      box.hidden = false;
      box.style.left = `${clipLeft}px`;
      box.style.top = `${clipTop}px`;
      box.style.width = `${clipRight - clipLeft}px`;
      box.style.height = `${clipBottom - clipTop}px`;
    } else {
      box.hidden = true;
    }

    const next = new Set(baseSelection);
    document.querySelectorAll("#prompt-list .prompt-item").forEach((row) => {
      if (rectsIntersect(selectionRect, rowContentRect(row))) {
        next.add(row.dataset.key);
      }
    });
    state.batchSelection = next;
    syncBatchSelectionVisual();
  };

  surface.addEventListener("dragstart", (event) => {
    if (state.batchMode) event.preventDefault();
  });

  surface.addEventListener("pointerdown", (event) => {
    if (!state.batchMode || event.button !== 0) return;
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    pointerId = event.pointerId;
    startClientX = event.clientX;
    startClientY = event.clientY;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    const start = contentPointFromClient(event.clientX, event.clientY);
    startContentX = start.x;
    startContentY = start.y;
    active = false;
    baseSelection = new Set(state.batchSelection);
  });

  surface.addEventListener("pointermove", (event) => {
    if (pointerId === null || event.pointerId !== pointerId || !state.batchMode) return;
    const dx = event.clientX - startClientX;
    const dy = event.clientY - startClientY;
    if (!active) {
      if (Math.hypot(dx, dy) < BATCH_MARQUEE_THRESHOLD_PX) return;
      active = true;
      surface.classList.add("batch-marquee-active");
      try {
        surface.setPointerCapture(pointerId);
      } catch (_) {
        // Some hosts reject capture; marquee can still track via bubbling moves.
      }
      event.preventDefault();
    }
    event.preventDefault();
    updateFromPointer(event.clientX, event.clientY);
  });

  // Wheel/trackpad scroll does not always emit pointermove; re-hit-test in content space.
  scroller.addEventListener(
    "scroll",
    () => {
      if (!active || pointerId === null || !state.batchMode) return;
      updateFromPointer(lastClientX, lastClientY);
    },
    { passive: true },
  );

  surface.addEventListener("pointerup", finish);
  surface.addEventListener("pointercancel", finish);
  surface.addEventListener("lostpointercapture", () => {
    if (pointerId !== null) finish();
  });

  $("prompt-list").addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function applyViewMode(rerender = false) {
  const cards = state.viewMode === "cards";
  const list = $("prompt-list");
  list.classList.toggle("card-view", cards);
  list.classList.toggle("list-view", !cards);
  $("btn-view-list").classList.toggle("active", !cards);
  $("btn-view-list").setAttribute("aria-pressed", String(!cards));
  $("btn-view-cards").classList.toggle("active", cards);
  $("btn-view-cards").setAttribute("aria-pressed", String(cards));
  if (rerender) {
    renderItems(state.items, true);
    updateSelectedRow(false, false);
    $("library-pane").scrollTop = 0;
  }
}

function setViewMode(mode) {
  if (mode !== "list" && mode !== "cards") return;
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  storeValue(STORAGE_KEYS.viewMode, mode);
  applyViewMode(true);
}

function installInspectorSendIcons() {
  document.querySelectorAll("#detail-inspector .inspector-send-button").forEach((button) => {
    const slot = button.dataset.slot;
    button.innerHTML = `${ICONS[slot]}<span>${INSPECTOR_BUTTON_LABELS[slot]}</span>`;
  });
}

function setInspectorButtonsDisabled(disabled) {
  document.querySelectorAll("#detail-inspector .inspector-send-button").forEach((button) => {
    button.disabled = disabled;
  });
}

function updateSendModeButton() {
  const replace = state.sendMode === "replace";
  const currentLabel = replace ? t("替换") : t("追加");
  const title = replace
    ? t("发送模式：全部替换对应栏位；点击切换为追加到对应栏位后方")
    : t("发送模式：追加到对应栏位后方；点击切换为全部替换对应栏位");
  for (const [buttonId, labelId] of [
    ["btn-send-mode", "send-mode-label"],
    ["detail-send-mode", "detail-send-mode-label"],
  ]) {
    const button = $(buttonId);
    button.dataset.mode = state.sendMode;
    button.setAttribute("aria-pressed", String(replace));
    button.title = title;
    button.setAttribute("aria-label", button.title);
    $(labelId).textContent = currentLabel;
  }
}

function toggleSendMode() {
  state.sendMode = state.sendMode === "append" ? "replace" : "append";
  storeValue(STORAGE_KEYS.sendMode, state.sendMode);
  updateSendModeButton();
  toast(state.sendMode === "replace" ? t("发送模式：全部替换") : t("发送模式：追加到末尾"));
}

function hasDirtyDetailEdits() {
  if (!state.selected) return false;
  const capabilities = state.selected.capabilities || {};
  const titleChanged = $("detail-title-input").value.trim() !== state.selected.name;
  const contentChanged = capabilities.content_edit !== false
    && $("detail-content-editor").value !== (state.selected.content || "");
  const negativeChanged = capabilities.negative !== false
    && $("detail-negative-editor").value !== (state.selected.negative || "");
  const noteChanged = capabilities.note !== false
    && $("detail-note-editor").value !== (state.selected.note || "");
  const loraChanged = capabilities.lora !== false
    && !loraPayloadEqual(
      entriesToLoraPayload(state.detailLoraEntries),
      state.selected.lora || emptyLoraPayload(),
    );
  return titleChanged
    || contentChanged
    || negativeChanged
    || noteChanged
    || loraChanged
    || Boolean(state.imageDraft);
}

function updateDetailEditControls() {
  const available = Boolean(state.selected) && !state.savingEntry;
  const capabilities = state.selected?.capabilities || {};
  const contentEditable = available && capabilities.content_edit !== false;
  const negativeEnabled = available && capabilities.negative !== false;
  const noteEnabled = available && capabilities.note !== false;
  const loraEnabled = available && capabilities.lora !== false;
  const titleButton = $("detail-edit-title");
  const contentButton = $("detail-edit-content");
  const negativeButton = $("detail-edit-negative");
  const noteButton = $("detail-edit-note");
  const addLoraButton = $("detail-add-lora");
  const imageButton = $("detail-edit-image");
  const generateButton = $("detail-generate-image");
  const titleModified = Boolean(state.selected)
    && $("detail-title-input").value.trim() !== state.selected.name;
  const contentModified = Boolean(state.selected)
    && $("detail-content-editor").value !== (state.selected.content || "");
  const negativeModified = Boolean(state.selected)
    && $("detail-negative-editor").value !== (state.selected.negative || "");
  const noteModified = Boolean(state.selected)
    && $("detail-note-editor").value !== (state.selected.note || "");

  titleButton.disabled = !available;
  contentButton.disabled = !contentEditable;
  negativeButton.disabled = !negativeEnabled;
  noteButton.disabled = !noteEnabled;
  addLoraButton.disabled = !loraEnabled || !state.loraManagerAvailable;
  addLoraButton.title = !loraEnabled
    ? t("添加 LoRA")
    : state.loraManagerAvailable
      ? t("添加 LoRA")
      : t("需要安装 LoraManager 才能添加");
  addLoraButton.setAttribute("aria-label", addLoraButton.title);
  $("detail-copy-content").disabled = !available;
  $("detail-copy-negative").disabled = !negativeEnabled;
  imageButton.disabled = !Boolean(state.selected)
    || state.savingEntry
    || state.uploadingImage;
  imageButton.classList.toggle("active", state.uploadingImage);
  imageButton.classList.toggle("modified", Boolean(state.imageDraft));
  imageButton.title = state.imageDraft ? t("取消示例图草稿") : t("修改示例图");
  imageButton.setAttribute("aria-label", imageButton.title);
  generateButton.disabled = !Boolean(state.selected)
    || state.savingEntry
    || state.uploadingImage
    || state.generationBusy
    || capabilities.generation === false;
  generateButton.classList.toggle("active", state.generationBusy);
  titleButton.classList.toggle("active", state.editingTitle);
  contentButton.classList.toggle("active", state.editingContent);
  negativeButton.classList.toggle("active", state.editingNegative);
  noteButton.classList.toggle("active", state.editingNote);
  titleButton.classList.toggle("modified", titleModified);
  contentButton.classList.toggle("modified", contentModified);
  negativeButton.classList.toggle("modified", negativeModified);
  noteButton.classList.toggle("modified", noteModified);
  titleButton.setAttribute("aria-pressed", String(state.editingTitle));
  contentButton.setAttribute("aria-pressed", String(state.editingContent));
  negativeButton.setAttribute("aria-pressed", String(state.editingNegative));
  noteButton.setAttribute("aria-pressed", String(state.editingNote));
  titleButton.title = state.editingTitle ? t("完成标题编辑") : t("修改标题");
  contentButton.title = state.editingContent ? t("完成提示词内容编辑") : t("修改提示词内容");
  negativeButton.title = state.editingNegative ? t("完成负面提示词编辑") : t("修改负面提示词");
  noteButton.title = state.editingNote ? t("完成备注编辑") : t("修改备注");
  titleButton.setAttribute("aria-label", titleButton.title);
  contentButton.setAttribute("aria-label", contentButton.title);
  negativeButton.setAttribute("aria-label", negativeButton.title);
  noteButton.setAttribute("aria-label", noteButton.title);

  const saveButton = $("detail-save");
  saveButton.disabled = !available || !hasDirtyDetailEdits();
  saveButton.classList.toggle("saving", state.savingEntry);
  saveButton.querySelector("span").textContent = state.savingEntry ? t("正在保存") : t("保存修改");
}

function resetDetailEditing() {
  state.editingTitle = false;
  state.editingContent = false;
  state.editingNegative = false;
  state.editingNote = false;
  state.savingEntry = false;
  const title = state.selected?.name || "";
  const content = state.selected?.content || "";
  const negative = state.selected?.negative || "";
  const note = state.selected?.note || "";
  $("detail-title").hidden = false;
  $("detail-title").textContent = title;
  $("detail-title-input").hidden = true;
  $("detail-title-input").value = title;
  $("detail-content").hidden = false;
  $("detail-content").textContent = content;
  $("detail-content-editor").hidden = true;
  $("detail-content-editor").value = content;
  $("detail-content-editor").style.height = "";
  $("detail-negative").hidden = false;
  $("detail-negative").textContent = negative;
  $("detail-negative-editor").hidden = true;
  $("detail-negative-editor").value = negative;
  $("detail-negative-editor").style.height = "";
  $("detail-note").hidden = false;
  $("detail-note").textContent = note;
  $("detail-note-editor").hidden = true;
  $("detail-note-editor").value = note;
  $("detail-note-editor").style.height = "";
  updateDetailEditControls();
}

function resizeDetailTitleInput() {
  const input = $("detail-title-input");
  const row = input.parentElement;
  const editButton = $("detail-edit-title");
  if (!row) return;

  input.style.width = "1px";
  const maximum = Math.max(54, row.clientWidth - editButton.offsetWidth - 4);
  input.style.width = `${Math.min(maximum, Math.max(54, input.scrollWidth + 2))}px`;
}

function beginTitleEdit() {
  if (!state.selected || state.savingEntry) return;
  setSendStatus("");
  const input = $("detail-title-input");
  if (state.editingTitle) {
    const draft = input.value.trim();
    if (!draft) {
      setSendStatus(t("标题不能为空"), "error");
      input.focus();
      return;
    }
    state.editingTitle = false;
    $("detail-title").textContent = draft;
    $("detail-title").hidden = false;
    input.hidden = true;
    updateDetailEditControls();
    return;
  }

  state.editingTitle = true;
  $("detail-title").hidden = true;
  input.hidden = false;
  resizeDetailTitleInput();
  updateDetailEditControls();
  input.focus();
  input.select();
}

function resizeDetailEditor(editorId) {
  const editor = $(editorId);
  editor.style.height = "auto";
  editor.style.height = `${Math.max(72, editor.scrollHeight + 2)}px`;
}

function resizeDetailContentEditor() {
  resizeDetailEditor("detail-content-editor");
}

function beginContentEdit() {
  if (
    !state.selected
    || state.savingEntry
    || state.selected.capabilities?.content_edit === false
  ) return;
  setSendStatus("");
  const editor = $("detail-content-editor");
  if (state.editingContent) {
    if (!editor.value.trim()) {
      setSendStatus(t("提示词内容不能为空"), "error");
      editor.focus();
      return;
    }
    state.editingContent = false;
    $("detail-content").textContent = editor.value;
    $("detail-content").hidden = false;
    editor.hidden = true;
    updateDetailEditControls();
    return;
  }

  state.editingContent = true;
  $("detail-content").hidden = true;
  editor.hidden = false;
  resizeDetailContentEditor();
  updateDetailEditControls();
  editor.focus();
}

function beginOptionalDetailEdit(field, label) {
  if (!state.selected || state.savingEntry) return;
  if (state.selected.capabilities?.[field] === false) return;
  setSendStatus("");
  const stateKey = field === "negative" ? "editingNegative" : "editingNote";
  const display = $(`detail-${field}`);
  const editor = $(`detail-${field}-editor`);
  if (state[stateKey]) {
    state[stateKey] = false;
    display.textContent = editor.value;
    display.hidden = false;
    editor.hidden = true;
    updateDetailEditControls();
    return;
  }
  state[stateKey] = true;
  display.hidden = true;
  editor.hidden = false;
  resizeDetailEditor(`detail-${field}-editor`);
  updateDetailEditControls();
  editor.focus();
  editor.setAttribute("aria-label", label);
}

function beginNegativeEdit() {
  beginOptionalDetailEdit("negative", t("负面提示词"));
}

function beginNoteEdit() {
  beginOptionalDetailEdit("note", t("备注"));
}

async function copyDetailText(editorId, buttonId, label) {
  if (!state.selected) return;
  const text = $(editorId).value;
  if (!text) return;

  try {
    await writeClipboardText(text);
    const button = $(buttonId);
    button.classList.add("copied");
    clearTimeout(button.copiedTimer);
    button.copiedTimer = setTimeout(() => button.classList.remove("copied"), 700);
    toast(t("{label}已复制", { label: t(label) }), "success");
  } catch (error) {
    toast(t("复制失败：{error}", { error: error.message || error }), "error");
  }
}

async function copyDetailContent() {
  if (state.selected?.format === "txt_wildcard") {
    const text = state.selected.wildcard_syntax || `__${state.selected.key}__`;
    try {
      await writeClipboardText(text);
      toast(t("已复制传统 Wildcard 语法"), "success");
    } catch (error) {
      toast(t("复制失败：{error}", { error: error.message || error }), "error");
    }
    return;
  }
  return copyDetailText("detail-content-editor", "detail-copy-content", "提示词内容");
}

function copyDetailNegative() {
  return copyDetailText("detail-negative-editor", "detail-copy-negative", "负面提示词");
}

function setImageUploadState(uploading) {
  state.uploadingImage = uploading;
  const panel = $("detail-image");
  panel.classList.toggle("uploading", uploading);
  $("detail-image-drop-overlay").querySelector("span").textContent = uploading
    ? t("正在保存示例图…")
    : t("松开即可替换示例图");
  updateDetailEditControls();
}

function resetImageUploadState() {
  state.uploadingImage = false;
  $("detail-image").classList.remove("dragging", "uploading");
  $("detail-image-drop-overlay").querySelector("span").textContent = t("松开即可替换示例图");
}

function clearImageDraft(restoreSavedImage = false) {
  if (state.imageDraftUrl) URL.revokeObjectURL(state.imageDraftUrl);
  state.imageDraft = null;
  state.imageDraftUrl = "";
  $("detail-image").classList.remove("draft");
  $("detail-image-draft-label").hidden = true;
  if (restoreSavedImage && state.selected) renderInspectorImage(state.selected, true);
  updateDetailEditControls();
}

function setImageDraft(file) {
  if (!state.selected || state.uploadingImage || !file) return;
  const looksLikeImage = file.type.startsWith("image/")
    || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name || "");
  if (!looksLikeImage) {
    toast(t("请选择 PNG、JPG、WEBP 或 GIF 图片"), "error");
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    toast(t("图片不能超过 32 MB"), "error");
    return;
  }

  if (state.imageDraftUrl) URL.revokeObjectURL(state.imageDraftUrl);
  state.imageDraft = file;
  state.imageDraftUrl = URL.createObjectURL(file);
  $("detail-image-section").hidden = false;
  const panel = $("detail-image");
  const image = $("detail-image-element");
  panel.hidden = false;
  panel.classList.add("draft");
  image.hidden = false;
  image.alt = t("{name}示例图草稿", { name: state.selected.name });
  image.onerror = () => {
    toast(t("图片草稿读取失败"), "error");
    clearImageDraft(true);
  };
  image.src = state.imageDraftUrl;
  $("detail-image-empty").hidden = true;
  $("detail-image-draft-label").hidden = false;
  updateDetailEditControls();
  toast(t("示例图已加入草稿，点击保存后才会替换"), "success", "above-actions");
}

async function chooseDetailImage() {
  if (!state.selected || state.uploadingImage) return;
  if (state.imageDraft) {
    clearImageDraft(true);
    toast(t("已取消示例图草稿"), "success");
    return;
  }
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "pm4a-preview-image",
        multiple: false,
        types: [{
          description: t("示例图"),
          accept: {
            "image/png": [".png"],
            "image/jpeg": [".jpg", ".jpeg"],
            "image/webp": [".webp"],
            "image/gif": [".gif"],
          },
        }],
      });
      const file = await handle.getFile();
      setImageDraft(file);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      // Fall back to the native file input when the File System API is unavailable.
    }
  }

  const input = $("detail-image-input");
  input.value = "";
  try {
    if (typeof input.showPicker === "function") input.showPicker();
    else input.click();
  } catch (_) {
    input.click();
  }
}

async function uploadDetailImage(key, file) {
  const form = new FormData();
  form.append("key", key);
  form.append("image", file, file.name || "preview-image");
  const data = await api("/pm4a/api/image", { method: "POST", body: form });
  if (!data.entry?.key) throw new Error(t("示例图保存结果无效"));
  return data.entry;
}

async function saveDetailEdits() {
  if (!state.selected || state.savingEntry || !hasDirtyDetailEdits()) return;

  const oldKey = state.selected.key;
  const payload = { key: oldKey };
  const name = $("detail-title-input").value.trim();
  const content = $("detail-content-editor").value;
  const negative = $("detail-negative-editor").value;
  const note = $("detail-note-editor").value;
  const lora = entriesToLoraPayload(state.detailLoraEntries);
  const imageDraft = state.imageDraft;
  if (!name) {
    setSendStatus(t("标题不能为空"), "error");
    beginTitleEdit();
    return;
  }
  if (!content.trim()) {
    setSendStatus(t("提示词内容不能为空"), "error");
    if (!state.editingContent) beginContentEdit();
    $("detail-content-editor").focus();
    return;
  }
  const titleChanged = name !== state.selected.name;
  const contentChanged = content !== (state.selected.content || "");
  const negativeChanged = negative !== (state.selected.negative || "");
  const noteChanged = note !== (state.selected.note || "");
  const loraChanged = !loraPayloadEqual(lora, state.selected.lora || emptyLoraPayload());
  const textChanged = titleChanged
    || contentChanged
    || negativeChanged
    || noteChanged
    || loraChanged;
  if (titleChanged) payload.name = name;
  if (contentChanged) payload.content = content;
  if (negativeChanged) payload.negative = negative;
  if (noteChanged) payload.note = note;
  if (loraChanged) payload.lora = lora;
  const saveRequestId = ++state.saveRequestId;

  state.savingEntry = true;
  if (imageDraft) setImageUploadState(true);
  updateDetailEditControls();
  setSendStatus(t("正在保存修改…"));

  let entry = state.selected;
  let textSaved = false;
  try {
    if (textChanged) {
      const data = await api("/pm4a/api/entry", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      entry = data.entry;
      if (!entry?.key) throw new Error(t("保存结果无效"));
      textSaved = true;
    }
    if (imageDraft) entry = await uploadDetailImage(entry.key, imageDraft);

    state.entryCache.delete(oldKey);
    state.entryCache.set(entry.key, entry);
    replaceFavoriteKey(oldKey, entry.key);
    if (imageDraft && !textChanged) markListItemHasImage(entry.key);
    const ownsInspector = state.saveRequestId === saveRequestId
      && state.selectedKey === oldKey;
    if (ownsInspector) {
      state.selectedKey = entry.key;
      state.selected = entry;
      clearImageDraft(false);
      resetImageUploadState();
      renderInspectorEntry(entry, true);
      resetDetailEditing();
      setInspectorButtonsDisabled(false);
    }
    if (textChanged) {
      try {
        await resetAndLoadList({ preserveInspector: true });
      } catch (refreshError) {
        toast(t("修改已保存，但列表刷新失败：{error}", { error: refreshError.message || refreshError }), "error");
      }
    } else if (imageDraft) {
      refreshVisibleCardImage(entry.key);
    }
    if (state.saveRequestId === saveRequestId && state.selectedKey === entry.key) {
      setSendStatus(t("修改已保存"), "success");
    }
    toast(t("修改已保存"), "success");
  } catch (error) {
    let message = String(error.message || error);
    const ownsInspector = state.saveRequestId === saveRequestId
      && state.selectedKey === oldKey;
    if (textSaved) {
      state.entryCache.delete(oldKey);
      state.entryCache.set(entry.key, entry);
      replaceFavoriteKey(oldKey, entry.key);
      if (ownsInspector) {
        state.selectedKey = entry.key;
        state.selected = entry;
        $("detail-title").textContent = entry.name || "";
        renderDetailPath(entry);
        $("detail-content").textContent = entry.content || "";
        $("detail-negative").textContent = entry.negative || "";
        $("detail-note").textContent = entry.note || "";
        resetImageUploadState();
        resetDetailEditing();
        setInspectorButtonsDisabled(false);
      }
      message = t("标题和正文已保存，但示例图保存失败：{error}", { error: message });
      try {
        await resetAndLoadList({ preserveInspector: true });
      } catch (_) {
        // Keep the inspector usable even when the list refresh also fails.
      }
    } else if (ownsInspector) {
      state.savingEntry = false;
      resetImageUploadState();
      updateDetailEditControls();
    }
    if (state.saveRequestId === saveRequestId) setSendStatus(message, "error");
    toast(message, "error");
  } finally {
    if (state.saveRequestId === saveRequestId && state.uploadingImage) {
      setImageUploadState(false);
    }
  }
}

function applySidebarState() {
  document.body.classList.toggle("sidebar-hidden", !state.sidebarOpen);
  $("sidebar").setAttribute("aria-hidden", String(!state.sidebarOpen));
  $("btn-show-sidebar").setAttribute("aria-expanded", String(state.sidebarOpen));
  updateWorkspaceMargin();
}

const CARD_MIN_WIDTH_FALLBACK = 160;
const SIDEBAR_CONTENT_GAP = 10;
const WORKSPACE_RIGHT_GUTTER = 16;
const MIN_PUSH_CONTENT_CARDS = 2.1;

function readCardMinWidth() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--card-min-width").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CARD_MIN_WIDTH_FALLBACK;
}

function clearShellOffset(element) {
  if (!element) return;
  element.style.marginLeft = "";
  element.style.marginRight = "";
  element.style.width = "";
}

function applyShellOffset(element, left, width, rightGutter) {
  if (!element) return;
  element.style.width = `${width}px`;
  element.style.marginLeft = `${left}px`;
  element.style.marginRight = `${rightGutter}px`;
}

function readShellGutter() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--shell-gutter").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 16;
}

function readWorkspaceMax() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--workspace-max").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1440;
}

// Keep the main workspace clear of the fixed sidebar. The top search header sits
// above the sidebar, so it stays full-width. Push when the viewport can still fit
// ~2.1 minimum card widths beside the sidebar; otherwise keep overlay mode.
// Use layout width (not transformed getBoundingClientRect) so open can animate
// in sync with the sidebar slide, matching the close reveal.
function updateWorkspaceMargin() {
  const workspace = $("workspace");
  const sidebar = $("sidebar");
  if (!workspace || !sidebar) return;

  clearShellOffset(document.querySelector(".header-shell"));
  if (!state.sidebarOpen) {
    clearShellOffset(workspace);
    return;
  }

  const viewportWidth = window.innerWidth;
  const sidebarWidth = sidebar.offsetWidth || Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
  ) || 230;
  const minContentWidth = readCardMinWidth() * MIN_PUSH_CONTENT_CARDS;
  if (viewportWidth < sidebarWidth + minContentWidth) {
    clearShellOffset(workspace);
    return;
  }

  const naturalWidth = Math.min(readWorkspaceMax(), viewportWidth - readShellGutter() * 2);
  const naturalLeft = (viewportWidth - naturalWidth) / 2;
  const requiredLeft = sidebarWidth + SIDEBAR_CONTENT_GAP;
  if (naturalLeft >= requiredLeft) {
    clearShellOffset(workspace);
    return;
  }

  const width = Math.max(minContentWidth, viewportWidth - requiredLeft - WORKSPACE_RIGHT_GUTTER);
  applyShellOffset(workspace, requiredLeft, width, WORKSPACE_RIGHT_GUTTER);
}

function openSidebar() {
  state.sidebarOpen = true;
  storeValue(STORAGE_KEYS.sidebarOpen, true);
  applySidebarState();
}

function closeSidebar() {
  state.sidebarOpen = false;
  storeValue(STORAGE_KEYS.sidebarOpen, false);
  applySidebarState();
}

function updateRecursiveButton() {
  const button = $("btn-recursive");
  button.classList.toggle("active", state.recursive);
  button.setAttribute("aria-pressed", String(state.recursive));
  button.querySelector("span").textContent = state.recursive
    ? t("包含子文件夹")
    : t("仅当前文件夹");
}

function indexTree(nodes) {
  for (const node of nodes) {
    state.folderMap.set(node.path, node);
    indexTree(node.children || []);
  }
}

function getFolderDisplayPath(path) {
  let current = "";
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      current = current ? `${current}/${part}` : part;
      return state.folderMap.get(current)?.name || part;
    })
    .join("/");
}

function renderTree() {
  const tree = $("folder-tree");
  tree.innerHTML = "";

  const walk = (nodes) => {
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      const wrapper = document.createElement("div");
      wrapper.className = "tree-node";

      const container = document.createElement("div");
      container.className = "tree-row-container";

      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const expanded = state.expanded.has(node.path);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `tree-toggle${hasChildren ? "" : " empty"}${expanded ? " expanded" : ""}`;
      toggle.dataset.togglePath = node.path;
      toggle.title = expanded ? t("折叠分类") : t("展开分类");
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.innerHTML = CHEVRON_ICON;

      const row = document.createElement("button");
      row.type = "button";
      row.className = `tree-row${state.prefix === node.path ? " active" : ""}`;
      row.dataset.folderPath = node.path;
      row.title = node.name;

      const icon = document.createElement("span");
      icon.className = "folder-icon";
      icon.innerHTML = FOLDER_ICON;

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = node.name;

      const count = document.createElement("span");
      count.className = "folder-count";
      count.textContent = numberFormatter.format(node.file_count || 0);

      row.append(icon, name, count);
      container.append(toggle, row);
      wrapper.appendChild(container);

      if (hasChildren && expanded) {
        const children = document.createElement("div");
        children.className = "tree-children";
        children.appendChild(walk(node.children));
        wrapper.appendChild(children);
      }

      fragment.appendChild(wrapper);
    }
    return fragment;
  };

  tree.appendChild(walk(state.tree));
  $("btn-all-prompts").classList.toggle("active", state.prefix === "");
}

function renderBreadcrumbs() {
  const crumbs = $("crumbs");
  crumbs.innerHTML = "";

  const appendCrumb = (label, path, current) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `breadcrumb-button${current ? " current" : ""}`;
    button.textContent = label;
    button.title = label;
    button.addEventListener("click", () => selectFolder(path));
    crumbs.appendChild(button);
  };

  appendCrumb(t("全部提示词"), "", !state.prefix);
  if (!state.prefix) return;

  const parts = state.prefix.split("/");
  let path = "";
  for (const [index, part] of parts.entries()) {
    path = path ? `${path}/${part}` : part;
    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "/";
    crumbs.appendChild(separator);

    const node = state.folderMap.get(path);
    appendCrumb(node?.name || part, path, index === parts.length - 1);
  }
}

function expandFolderPath(path) {
  let currentPath = "";
  let changed = false;
  for (const part of String(path || "").split("/").filter(Boolean)) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (!state.expanded.has(currentPath)) {
      state.expanded.add(currentPath);
      changed = true;
    }
  }
  if (changed) persistExpanded();
}

function navigateToDetailFolder(path) {
  closeDetailModal({ restoreFocus: false });
  selectFolder(path, { preserveInspector: true }).catch((error) => {
    toast(t("打开分类失败：{error}", { error: error.message || error }), "error");
  });
}

function renderDetailPath(item) {
  const container = $("detail-path");
  container.innerHTML = "";

  const keyParts = String(item?.key || "").split("/").filter(Boolean);
  const displayParts = String(item?.display_path || item?.key || "").split("/").filter(Boolean);
  keyParts.pop();
  displayParts.pop();

  const appendFolder = (label, path, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "detail-path-button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", t("打开分类：{title}", { title }));
    button.addEventListener("click", () => navigateToDetailFolder(path));
    container.appendChild(button);
  };

  if (!keyParts.length) {
    appendFolder(t("全部提示词"), "", t("全部提示词"));
    return;
  }

  let path = "";
  let displayPath = "";
  keyParts.forEach((part, index) => {
    path = path ? `${path}/${part}` : part;
    const label = state.folderMap.get(path)?.name || displayParts[index] || part;
    displayPath = displayPath ? `${displayPath}/${label}` : label;

    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "detail-path-separator";
      separator.textContent = "/";
      separator.setAttribute("aria-hidden", "true");
      container.appendChild(separator);
    }
    appendFolder(label, path, displayPath);
  });
}

async function loadTree() {
  try {
    const data = await api("/pm4a/api/tree");
    state.tree = data.tree || [];
    state.fileCount = data.file_count || 0;
    state.folderMap.clear();
    indexTree(state.tree);

    if (state.prefix && !state.folderMap.has(state.prefix)) {
      state.prefix = "";
      persistPrefix();
    }

    $("all-count").textContent = numberFormatter.format(state.fileCount);
    $("library-meta").textContent = t("{count} 条提示词", { count: numberFormatter.format(state.fileCount) });
    $("library-meta").title = data.root || "";
    renderTree();
    renderBreadcrumbs();
  } catch (error) {
    $("library-meta").textContent = t("分类加载失败");
    $("folder-tree").innerHTML = `<p class="tree-error">${String(error.message || error)}</p>`;
    toast(t("分类加载失败：{error}", { error: error.message || error }), "error");
  }
}

function renderSkeleton(count = 12) {
  const list = $("prompt-list");
  list.innerHTML = "";
  const fragment = document.createDocumentFragment();
  const skeletonCount = state.viewMode === "cards" ? Math.max(count, 15) : count;
  for (let index = 0; index < skeletonCount; index += 1) {
    const item = document.createElement("div");
    item.className = state.viewMode === "cards" ? "skeleton-card" : "skeleton-row";
    item.setAttribute("aria-hidden", "true");
    fragment.appendChild(item);
  }
  list.appendChild(fragment);
}

function hideListStates() {
  $("empty-state").hidden = true;
  $("error-state").hidden = true;
}

function showEmptyState() {
  const title = $("empty-title");
  const message = $("empty-message");
  if (state.favoritesOnly && state.search) {
    title.textContent = t("收藏中没有匹配结果");
    message.textContent = t("收藏的提示词中没有包含“{search}”的结果。", { search: state.search });
  } else if (state.favoritesOnly) {
    title.textContent = t("没有收藏的提示词");
    message.textContent = state.prefix
      ? t("当前分类中还没有收藏内容。")
      : t("点击列表或卡片上的星标即可添加收藏。");
  } else if (state.search) {
    title.textContent = t("没有匹配结果");
    message.textContent = t("当前分类中没有包含“{search}”的提示词。", { search: state.search });
  } else if (state.prefix && !state.recursive) {
    title.textContent = t("当前层没有提示词");
    message.textContent = t("可以开启“{includeSubfolders}”，或从左侧继续进入下级分类。", {
      includeSubfolders: t("包含子文件夹"),
    });
  } else {
    title.textContent = t("这个分类是空的");
    message.textContent = t("刷新提示词库，或从左侧选择其他分类。");
  }
  $("empty-state").hidden = false;
}

function showListError(error, initialLoad) {
  if (initialLoad) $("prompt-list").innerHTML = "";
  $("error-message").textContent = String(error.message || error);
  $("error-state").hidden = false;
}

function updateResultSummary(loadingInitial = false) {
  if (loadingInitial) {
    $("scope-count").textContent = t("正在加载…");
    $("load-progress").textContent = "";
    return;
  }
  $("scope-count").textContent = t("共 {count} 条", { count: numberFormatter.format(state.total) });
  $("load-progress").textContent = state.total
    ? t("已显示 {count}", { count: numberFormatter.format(state.items.length) })
    : "";
}

function updateSelectedRow(scrollIntoView = false, focus = false) {
  let selectedRow = null;
  document.querySelectorAll("#prompt-list .prompt-item").forEach((row) => {
    const selected = Boolean(state.selectedKey) && row.dataset.key === state.selectedKey;
    const batchSelected = state.batchSelection.has(row.dataset.key);
    row.classList.toggle("selected", selected);
    row.classList.toggle("batch-selected", batchSelected);
    row.setAttribute("aria-selected", String(selected || batchSelected));
    if (selected) selectedRow = row;
  });

  if (selectedRow && scrollIntoView) {
    selectedRow.scrollIntoView({ block: "nearest" });
  }
  if (selectedRow && focus) selectedRow.focus({ preventScroll: true });
}

function preparePromptItem(element, item, className) {
  const selected = state.selectedKey === item.key;
  const batchSelected = state.batchSelection.has(item.key);
  element.className = `${className} prompt-item${selected ? " selected" : ""}${batchSelected ? " batch-selected" : ""}`;
  element.classList.toggle("txt-wildcard", item.format === "txt_wildcard");
  element.tabIndex = 0;
  element.dataset.key = item.key;
  element.title = `${item.name}\n${item.display_path || item.key}`;
  element.setAttribute("aria-label", t("{name}，查看详情", { name: item.name }));
  element.setAttribute("aria-selected", String(selected || batchSelected));
  return element;
}

function getParentFolderName(item) {
  const parts = String(item.display_path || item.key || "").split("/").filter(Boolean);
  return parts.length > 1 ? parts.at(-2) : t("根目录");
}

function createListItem(item) {
  const row = preparePromptItem(document.createElement("article"), item, "prompt-row");
  const title = document.createElement("h2");
  title.className = "prompt-title";
  title.textContent = item.name;
  const badge = document.createElement("span");
  badge.className = "wildcard-format-badge";
  badge.hidden = item.format !== "txt_wildcard";
  badge.textContent = t("Wildcard · {count} 条", {
    count: numberFormatter.format(Number(item.option_count || 0)),
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.setAttribute("aria-label", t("{name}的收藏、发送和复制操作", { name: item.name }));
  actions.append(
    makeFavoriteButton(item.key),
    makeSendButton("character", item.key),
    makeSendButton("action", item.key),
    makeCopyButton(item.key),
  );
  row.append(title, badge, actions);
  return row;
}

function createCardItem(item) {
  const card = preparePromptItem(document.createElement("article"), item, "prompt-card");
  card.classList.add(item.has_image ? "has-preview" : "no-preview");

  const preview = document.createElement("div");
  preview.className = "card-preview";
  const placeholder = document.createElement("div");
  placeholder.className = "card-placeholder";
  placeholder.innerHTML = item.format === "txt_wildcard"
    ? TXT_WILDCARD_ICON
    : CARD_PLACEHOLDER_ICON;
  preview.appendChild(placeholder);

  if (item.has_image) {
    preview.prepend(createCardPreviewImage(item, card));
  }

  const header = document.createElement("div");
  header.className = "card-header";
  const folder = document.createElement("span");
  folder.className = "card-folder-label";
  folder.textContent = getParentFolderName(item);
  folder.title = folder.textContent;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.setAttribute("aria-label", t("{name}的收藏、发送和复制操作", { name: item.name }));
  actions.append(
    makeFavoriteButton(item.key),
    makeSendButton("character", item.key),
    makeSendButton("action", item.key),
    makeCopyButton(item.key),
  );
  header.append(folder, actions);

  const footer = document.createElement("div");
  footer.className = "card-footer";
  const title = document.createElement("h2");
  title.className = "prompt-card-title";
  title.textContent = item.name;
  title.title = item.name;
  footer.appendChild(title);
  if (item.format === "txt_wildcard") {
    const badge = document.createElement("span");
    badge.className = "wildcard-format-badge";
    badge.textContent = t("Wildcard · {count} 条", {
      count: numberFormatter.format(Number(item.option_count || 0)),
    });
    footer.appendChild(badge);
  }

  card.append(preview, header, footer);
  return card;
}

function createCardPreviewImage(item, card) {
  const image = document.createElement("img");
  image.loading = "lazy";
  image.decoding = "async";
  image.alt = t("{name}预览图", { name: item.name });
  image.src = previewImageUrl(item.key);
  image.addEventListener("error", () => {
    image.remove();
    card.classList.remove("has-preview");
    card.classList.add("no-preview");
  }, { once: true });
  return image;
}

function refreshVisibleCardImage(key) {
  if (state.viewMode !== "cards") return;
  const card = Array.from($("prompt-list").querySelectorAll(".prompt-card"))
    .find((candidate) => candidate.dataset.key === key);
  const item = state.items.find((candidate) => candidate.key === key);
  if (!card || !item?.has_image) return;
  const preview = card.querySelector(".card-preview");
  if (!preview) return;
  let image = preview.querySelector("img");
  if (!image) {
    image = createCardPreviewImage(item, card);
    preview.prepend(image);
  } else {
    image.alt = t("{name}预览图", { name: item.name });
    image.src = previewImageUrl(key);
  }
  card.classList.add("has-preview");
  card.classList.remove("no-preview");
}

function renderItems(items, replace = false) {
  const list = $("prompt-list");
  if (replace) list.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.appendChild(state.viewMode === "cards" ? createCardItem(item) : createListItem(item));
  }
  list.appendChild(fragment);
}

function compareFolded(left, right) {
  const a = String(left || "").toLocaleLowerCase();
  const b = String(right || "").toLocaleLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function updateDetailNavigation(loading = false) {
  const previous = $("detail-prev");
  const next = $("detail-next");
  previous.disabled = loading || state.currentIndex <= 0;
  next.disabled = loading || state.currentIndex < 0 || state.currentIndex >= state.total - 1;
}

function syncSelectedResult() {
  if (state.selectedKey && !$("inspector-content").hidden) {
    state.currentIndex = state.items.findIndex((item) => item.key === state.selectedKey);
    const listedEntry = state.currentIndex >= 0 ? state.items[state.currentIndex] : null;
    if (listedEntry && state.selected) {
      state.selected = {
        ...state.selected,
        key: listedEntry.key,
        name: listedEntry.name || state.selected.name,
        display_path: listedEntry.display_path || state.selected.display_path,
      };
      renderDetailPath(state.selected);
    }
    updateSelectedRow(false, false);
  }
  updateDetailNavigation(false);
}

function openDetailModal() {
  const modal = $("detail-modal");
  if (!modal.hidden) return;
  detailReturnFocus = document.activeElement;
  modal.hidden = false;
  requestAnimationFrame(() => $("detail-inspector").focus({ preventScroll: true }));
}

function closeDetailModal(options = {}) {
  const modal = $("detail-modal");
  if (modal.hidden) return;
  state.imageDropRequestId += 1;
  modal.hidden = true;

  const returnFocus = detailReturnFocus;
  detailReturnFocus = null;
  if (options.restoreFocus === false || !returnFocus?.isConnected) return;
  requestAnimationFrame(() => returnFocus.focus?.({ preventScroll: true }));
}

function clearInspector() {
  closeDetailModal({ restoreFocus: false });
  state.detailController?.abort();
  state.detailController = null;
  state.currentIndex = -1;
  state.selectedKey = "";
  state.selected = null;
  state.detailLoraEntries = [];
  state.saveRequestId += 1;
  clearImageDraft(false);
  resetImageUploadState();
  resetDetailEditing();
  $("inspector-empty").hidden = false;
  $("inspector-content").hidden = true;
  $("detail-loading").hidden = true;
  $("detail-body").hidden = true;
  $("detail-image").hidden = true;
  $("detail-image-element").removeAttribute("src");
  setInspectorButtonsDisabled(true);
  setSendStatus("");
  updateDetailNavigation(false);
  updateSelectedRow(false, false);
}

function loadNextPage() {
  if (state.loadingPromise) return state.loadingPromise;
  if (!state.hasMore) return Promise.resolve();

  const generation = state.requestGeneration;
  const initialLoad = state.items.length === 0;
  const controller = new AbortController();
  state.listController = controller;
  $("prompt-list").setAttribute("aria-busy", "true");
  $("load-more").hidden = initialLoad;
  $("error-state").hidden = true;

  const params = new URLSearchParams({
    prefix: state.prefix,
    search: state.search,
    sort: state.sortMode,
    limit: String(state.limit),
    offset: String(state.offset),
    immediate: state.recursive ? "0" : "1",
    favorites: state.favoritesOnly ? "1" : "0",
  });

  const task = (async () => {
    try {
      const data = await api(`/pm4a/api/list?${params}`, {
        signal: controller.signal,
      });
      if (generation !== state.requestGeneration) return;

      const pageItems = Array.isArray(data.items) ? data.items : [];
      const replace = state.offset === 0;
      if (replace) state.items = [];
      state.items.push(...pageItems);
      state.total = Number(data.total) || 0;
      state.offset = (Number(data.offset) || 0) + pageItems.length;
      state.hasMore = pageItems.length > 0 && state.offset < state.total;

      hideListStates();
      renderItems(pageItems, replace);
      if (state.total === 0) showEmptyState();
      updateResultSummary(false);
      syncSelectedResult();
    } catch (error) {
      if (error.name === "AbortError" || generation !== state.requestGeneration) return;
      showListError(error, initialLoad);
      updateResultSummary(false);
    } finally {
      if (generation === state.requestGeneration && state.loadingPromise === task) {
        state.loadingPromise = null;
        state.listController = null;
        $("prompt-list").setAttribute("aria-busy", "false");
        $("load-more").hidden = true;
      }
    }
  })();

  state.loadingPromise = task;
  return task;
}

function resetAndLoadList(options = {}) {
  // Filtering, sorting, changing folders and refreshing the list must not
  // discard a prompt the user already opened in the inspector.
  const preserveInspector = options.preserveInspector !== false;
  state.listController?.abort();
  state.requestGeneration += 1;
  state.listController = null;
  state.loadingPromise = null;
  state.offset = 0;
  state.total = 0;
  state.hasMore = true;
  state.items = [];
  state.batchSelection.clear();
  updateBatchModeButton();
  if (preserveInspector) {
    state.currentIndex = -1;
    updateDetailNavigation(false);
  } else {
    clearInspector();
  }

  hideListStates();
  renderSkeleton();
  updateResultSummary(true);
  $("library-pane").scrollTop = 0;
  renderBreadcrumbs();
  renderTree();
  return loadNextPage();
}

function selectFolder(path, options = {}) {
  state.prefix = path || "";
  persistPrefix();
  const node = state.folderMap.get(state.prefix);
  if (node?.children?.length && !state.expanded.has(state.prefix)) {
    state.expanded.add(state.prefix);
    persistExpanded();
  }
  return resetAndLoadList({ ...options, preserveInspector: options.preserveInspector ?? true });
}

async function getEntry(key, signal) {
  if (state.entryCache.has(key)) return state.entryCache.get(key);
  const data = await api(`/pm4a/api/entry?${keyQuery(key)}`, { signal });
  state.entryCache.set(key, data.entry);
  return data.entry;
}

async function sendByKey(key, slot, button) {
  if (!key || !slot || button.disabled) return;
  button.disabled = true;
  setSendStatus("");

  try {
    const sendMode = state.sendMode;
    let result;
    try {
      result = await api("/pm4a/api/append-slot", {
        method: "POST",
        body: JSON.stringify({ slot, key, mode: sendMode }),
      });
    } catch (error) {
      if (String(error.message || error) !== "text required") throw error;
      const entry = await getEntry(key);
      const text = slot === "negative"
        ? (entry.negative || "").trim()
        : entry.type === "folder" || entry.format === "txt_wildcard"
          ? entry.wildcard_syntax || `__${entry.key}__`
          : (entry.content || "").trim();
      if (!text) {
        throw new Error(slot === "negative" ? t("负面提示词为空，没有发送内容") : t("提示词为空，没有发送内容"));
      }
      result = await api("/pm4a/api/append-slot", {
        method: "POST",
        body: JSON.stringify({ slot, text, mode: sendMode }),
      });
    }
    const replacing = sendMode === "replace";
    const message = replacing
      ? t("已替换“{label}”内容", { label: SLOT_LABELS[slot] })
      : t("已追加到“{label}”", { label: SLOT_LABELS[slot] });

    toast(message, "success");
    if (state.selectedKey === key) setSendStatus(message, "success");
  } catch (error) {
    const message = String(error.message || error);
    toast(message, "error");
    if (state.selectedKey === key) setSendStatus(message, "error");
  } finally {
    button.disabled = false;
  }
}

async function copyByKey(key, button) {
  if (!key || button.disabled) return;
  button.disabled = true;

  try {
    const entry = await getEntry(key);
    const text = entry.format === "txt_wildcard"
      ? entry.wildcard_syntax || `__${entry.key}__`
      : entry.content || "";
    if (!text.trim()) throw new Error(t("提示词为空，没有复制内容"));
    await writeClipboardText(text);
    toast(t("已复制“{name}”的提示词内容", { name: entry.name || key }), "success");
  } catch (error) {
    toast(t("复制失败：{error}", { error: error.message || error }), "error");
  } finally {
    button.disabled = false;
  }
}

function renderInspectorImage(entry, cacheBust = false) {
  $("detail-image-section").hidden = false;
  const imagePanel = $("detail-image");
  const imageElement = $("detail-image-element");
  const emptyState = $("detail-image-empty");
  imagePanel.hidden = false;
  emptyState.querySelector("span").textContent = t("拖入图片，或点击铅笔添加");
  if (entry.has_image) {
    imageElement.hidden = false;
    emptyState.hidden = true;
    imageElement.alt = t("{name}预览图", { name: entry.name });
    imageElement.onerror = () => {
      if (state.selectedKey !== entry.key) return;
      imageElement.hidden = true;
      emptyState.hidden = false;
      emptyState.querySelector("span").textContent = t("示例图读取失败，可拖入图片替换");
      toast(t("预览图读取失败"), "error");
    };
    if (cacheBust) bumpImageRevision(entry.key);
    imageElement.src = previewImageUrl(entry.key);
  } else {
    imageElement.onerror = null;
    imageElement.removeAttribute("src");
    imageElement.alt = "";
    imageElement.hidden = true;
    emptyState.hidden = false;
  }
}

function renderDetailLoraList() {
  const list = $("detail-lora-list");
  list.replaceChildren();
  for (const [index, entry] of state.detailLoraEntries.entries()) {
    const resolved = withLoraStrength(entry, entry.strength);
    state.detailLoraEntries[index] = resolved;
    const row = document.createElement("div");
    row.className = "detail-lora-item";
    const tag = document.createElement("div");
    tag.className = "detail-lora-tag";
    tag.textContent = resolved.tag;
    const meta = document.createElement("div");
    meta.className = "detail-lora-meta";
    meta.textContent = [resolved.hashName || resolved.name, resolved.hash]
      .filter(Boolean)
      .join(" · ");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "detail-edit-button";
    remove.title = t("删除 LoRA");
    remove.setAttribute("aria-label", remove.title);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>';
    remove.addEventListener("click", () => {
      state.detailLoraEntries = state.detailLoraEntries.filter((_, i) => i !== index);
      renderDetailLoraList();
      updateDetailEditControls();
    });
    row.append(tag, meta, remove);
    list.appendChild(row);
  }
}

async function refreshLoraManagerAvailability() {
  state.loraManagerAvailable = await detectLoraManager({ force: true });
  updateDetailEditControls();
  return state.loraManagerAvailable;
}

function clearLoraPickerSelection() {
  state.loraPickerPending = null;
  $("lora-picker-confirm").hidden = true;
  $("lora-picker-selected-name").textContent = "";
  $("lora-picker-strength").value = "1";
  $("lora-picker-results")
    .querySelectorAll(".lora-picker-result.active")
    .forEach((node) => node.classList.remove("active"));
}

function closeLoraPicker() {
  $("lora-picker-modal").hidden = true;
  $("lora-picker-search").value = "";
  $("lora-picker-paste").value = "";
  $("lora-picker-results").replaceChildren();
  $("lora-picker-status").textContent = "";
  clearLoraPickerSelection();
}

async function addLorasFromPasteText() {
  const paste = $("lora-picker-paste");
  const status = $("lora-picker-status");
  const parseButton = $("lora-picker-parse");
  const tags = parseLoraEntries({ text: paste.value });
  if (!tags.length) {
    status.textContent = t("没有可解析的 LoRA 标签");
    return;
  }
  parseButton.disabled = true;
  status.textContent = t("正在解析添加…");
  let added = 0;
  let skipped = 0;
  const missing = [];
  try {
    for (const tag of tags) {
      if (state.detailLoraEntries.some((candidate) => candidate.name.toLowerCase() === tag.name.toLowerCase())) {
        skipped += 1;
        continue;
      }
      try {
        const entry = await pickExactLoraFromManager(tag.name, tag.strength);
        if (!entry) {
          missing.push(tag.name);
          continue;
        }
        state.detailLoraEntries = [...state.detailLoraEntries, entry];
        added += 1;
      } catch (_) {
        missing.push(tag.name);
      }
    }
    if (added) {
      renderDetailLoraList();
      updateDetailEditControls();
    }
    const missingText = missing.join(", ");
    let message = "";
    if (added && (skipped || missing.length)) {
      message = t("已解析添加 {added} 个；跳过已有 {skipped} 个；未匹配：{missing}", {
        added,
        skipped,
        missing: missingText || "-",
      });
    } else if (added) {
      message = t("已解析添加 {added} 个 LoRA", { added });
    } else if (missing.length) {
      message = t("未匹配任何 LoRA：{missing}", { missing: missingText });
    } else {
      message = t("已添加过同名 LoRA");
    }
    if (added) {
      closeLoraPicker();
      toast(message, "success");
    } else {
      status.textContent = message;
    }
  } finally {
    parseButton.disabled = false;
  }
}

async function selectLoraPickerItem(item, button) {
  const exists = state.detailLoraEntries.some(
    (candidate) => candidate.name.toLowerCase() === item.name.toLowerCase(),
  );
  if (exists) {
    toast(t("已添加过同名 LoRA"), "error");
    return;
  }
  $("lora-picker-results")
    .querySelectorAll(".lora-picker-result.active")
    .forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
  $("lora-picker-status").textContent = t("正在读取默认强度…");
  try {
    const preview = await pickLoraFromManagerItem(item);
    state.loraPickerPending = item;
    $("lora-picker-selected-name").textContent = item.name;
    $("lora-picker-strength").value = formatLoraStrength(
      preview.defaultStrength || preview.strength,
    );
    $("lora-picker-confirm").hidden = false;
    $("lora-picker-status").textContent = "";
    $("lora-picker-strength").focus();
    $("lora-picker-strength").select();
  } catch (error) {
    clearLoraPickerSelection();
    $("lora-picker-status").textContent = t(
      "读取强度失败：{error}",
      { error: error.message || error },
    );
  }
}

async function confirmLoraPickerAdd() {
  const item = state.loraPickerPending;
  if (!item) return;
  try {
    const entry = await pickLoraFromManagerItem(item, $("lora-picker-strength").value);
    const exists = state.detailLoraEntries.some(
      (candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (exists) {
      toast(t("已添加过同名 LoRA"), "error");
      return;
    }
    state.detailLoraEntries = [...state.detailLoraEntries, entry];
    renderDetailLoraList();
    updateDetailEditControls();
    closeLoraPicker();
  } catch (error) {
    toast(t("添加失败：{error}", { error: error.message || error }), "error");
  }
}

async function renderLoraPickerResults(query) {
  const requestId = ++state.loraPickerRequestId;
  const results = $("lora-picker-results");
  const status = $("lora-picker-status");
  status.textContent = t("正在搜索…");
  results.replaceChildren();
  clearLoraPickerSelection();
  try {
    const items = await searchLoraManager(query);
    if (requestId !== state.loraPickerRequestId) return;
    if (!items.length) {
      status.textContent = t("没有匹配的 LoRA");
      return;
    }
    status.textContent = "";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lora-picker-result";
      button.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "lora-picker-result-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "lora-picker-result-meta";
      meta.textContent = [item.fileName, item.hash].filter(Boolean).join(" · ");
      button.append(name, meta);
      button.addEventListener("click", () => {
        void selectLoraPickerItem(item, button);
      });
      results.appendChild(button);
    }
  } catch (error) {
    if (requestId !== state.loraPickerRequestId) return;
    status.textContent = t("搜索失败：{error}", { error: error.message || error });
  }
}

async function openLoraPicker() {
  if (!state.selected || state.selected.capabilities?.lora === false) return;
  const available = await refreshLoraManagerAvailability();
  if (!available) {
    toast(t("需要安装 LoraManager 才能添加"), "error");
    return;
  }
  clearLoraPickerSelection();
  $("lora-picker-modal").hidden = false;
  $("lora-picker-search").focus();
  await renderLoraPickerResults("");
}

function renderInspectorEntry(entry, cacheBust = false) {
  const isTxt = entry.format === "txt_wildcard";
  $("detail-title").textContent = entry.name || "";
  renderDetailPath(entry);
  $("detail-content").textContent = entry.content || "";
  $("detail-negative").textContent = entry.negative || "";
  $("detail-note").textContent = entry.note || "";
  state.detailLoraEntries = isTxt ? [] : parseLoraEntries(entry.lora || emptyLoraPayload());
  renderDetailLoraList();
  void refreshLoraManagerAvailability();
  const badge = $("detail-format-badge");
  badge.hidden = !isTxt;
  badge.textContent = isTxt
    ? t("Wildcard · {count} 条", {
      count: numberFormatter.format(Number(entry.option_count || 0)),
    })
    : "";
  $("detail-content-label").textContent = isTxt
    ? t("Wildcard 选项预览")
    : t("提示词内容");
  const truncated = $("detail-content-truncated");
  truncated.hidden = !isTxt || !entry.truncated;
  truncated.textContent = entry.truncated
    ? t("仅显示前 {shown} 条，共 {total} 条；请使用外部文本编辑器查看完整内容。", {
      shown: numberFormatter.format((entry.lines || []).length),
      total: numberFormatter.format(Number(entry.option_count || 0)),
    })
    : "";
  $("detail-negative-panel").hidden = isTxt;
  $("detail-lora-panel").hidden = isTxt;
  $("detail-note-panel").hidden = isTxt;
  $("detail-open-txt").hidden = !isTxt;
  $("detail-reveal-txt").hidden = !isTxt;
  renderInspectorImage(entry, cacheBust);
}


async function openSelectedTxt(action) {
  if (state.selected?.format !== "txt_wildcard") return;
  try {
    await api("/pm4a/api/entry/open-txt", {
      method: "POST",
      body: JSON.stringify({ key: state.selected.key, action }),
    });
    toast(
      action === "reveal"
        ? t("已在文件管理器中显示")
        : t("已交给默认文本编辑器打开；编辑完成后请刷新提示词库"),
      "success",
    );
  } catch (error) {
    toast(t("打开失败：{error}", { error: error.message || error }), "error");
  }
}

async function loadDetailAt(index, options = {}) {
  if (index < 0 || index >= state.total) return;
  if (index >= state.items.length && state.hasMore) await loadNextPage();
  const item = state.items[index];
  if (!item) return;

  state.detailController?.abort();
  const controller = new AbortController();
  state.detailController = controller;
  state.currentIndex = index;
  state.selectedKey = item.key;
  state.selected = null;
  state.saveRequestId += 1;
  clearImageDraft(false);
  resetImageUploadState();
  resetDetailEditing();
  setSendStatus("");
  setInspectorButtonsDisabled(true);

  $("inspector-empty").hidden = true;
  $("inspector-content").hidden = false;
  $("detail-title").textContent = item.name;
  renderDetailPath(item);
  $("detail-loading").hidden = false;
  $("detail-body").hidden = true;
  updateDetailNavigation(true);
  updateSelectedRow(true, Boolean(options.focusRow));

  try {
    const entry = await getEntry(item.key, controller.signal);
    if (controller.signal.aborted || state.selectedKey !== item.key) return;
    state.selected = entry;
    renderInspectorEntry(entry);
    resetDetailEditing();
    $("detail-body").hidden = false;
    setInspectorButtonsDisabled(false);
  } catch (error) {
    if (error.name === "AbortError") return;
    $("detail-image-section").hidden = true;
    $("detail-content").textContent = t("读取详情失败：{error}", { error: error.message || error });
    $("detail-body").hidden = false;
    toast(t("读取详情失败：{error}", { error: error.message || error }), "error");
  } finally {
    if (state.detailController === controller) {
      state.detailController = null;
      $("detail-loading").hidden = true;
      updateDetailNavigation(false);
    }
  }
}

function selectPrompt(key, options = {}) {
  const index = state.items.findIndex((item) => item.key === key);
  if (index < 0) return;
  openDetailModal();
  const currentDetailAvailable = state.selectedKey === key
    && !$("inspector-content").hidden
    && (Boolean(state.selected) || Boolean(state.detailController));
  if (currentDetailAvailable) {
    state.currentIndex = index;
    updateDetailNavigation(Boolean(state.detailController));
    updateSelectedRow(true, Boolean(options.focusRow));
    return;
  }
  loadDetailAt(index, options);
}

async function navigateDetail(direction) {
  const targetIndex = state.currentIndex + direction;
  if (targetIndex < 0 || targetIndex >= state.total) return;
  if (targetIndex >= state.items.length && state.hasMore) await loadNextPage();
  if (targetIndex < state.items.length) await loadDetailAt(targetIndex);
}

function debounce(callback, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function setupImageDropZone() {
  const panel = $("detail-image");
  let dragDepth = 0;
  const isImageDrag = (event) => hasSupportedImageTransfer(event.dataTransfer);
  const clearDragState = () => {
    dragDepth = 0;
    panel.classList.remove("dragging");
  };

  panel.addEventListener("dragenter", (event) => {
    if (!state.selected || state.uploadingImage || !isImageDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragover", (event) => {
    if (!state.selected || state.uploadingImage || !isImageDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) panel.classList.remove("dragging");
  });
  panel.addEventListener("drop", async (event) => {
    if (!isImageDrag(event)) return;
    event.preventDefault();
    clearDragState();
    const selectedKey = state.selectedKey;
    const requestId = ++state.imageDropRequestId;
    try {
      const file = await imageFileFromTransfer(event.dataTransfer);
      if (requestId !== state.imageDropRequestId || selectedKey !== state.selectedKey) return;
      if (!file) {
        toast(t("拖入的资产不是支持的图片"), "error");
        return;
      }
      setImageDraft(file);
    } catch (error) {
      if (requestId !== state.imageDropRequestId || selectedKey !== state.selectedKey) return;
      toast(t("资产图片读取失败：{error}", { error: error.message || error }), "error");
    }
  });
  document.addEventListener("dragend", clearDragState);
}

function setupCreateImageDropZone() {
  const panel = $("add-prompt-image-drop");
  let dragDepth = 0;
  const isImageDrag = (event) => hasSupportedImageTransfer(event.dataTransfer);
  const clearDragState = () => {
    dragDepth = 0;
    panel.classList.remove("dragging");
  };
  panel.addEventListener("dragenter", (event) => {
    if (!isImageDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragover", (event) => {
    if (!isImageDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) panel.classList.remove("dragging");
  });
  panel.addEventListener("drop", async (event) => {
    if (!isImageDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragState();
    const requestId = ++state.createMetadataRequestId;
    try {
      const file = await imageFileFromTransfer(event.dataTransfer);
      if (requestId !== state.createMetadataRequestId) return;
      if (!file) {
        setCreateImageStatus(t("拖入的文件不是支持的图片"), "error");
        return;
      }
      await setCreateImage(file);
    } catch (error) {
      if (requestId !== state.createMetadataRequestId) return;
      setCreateImageStatus(t("资产图片读取失败：{error}", { error: error.message || error }), "error");
    }
  });
  document.addEventListener("dragend", clearDragState);
}

function setupImportPromptDropZone() {
  const panel = $("import-prompts-drop");
  let dragDepth = 0;
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const clearDragState = () => {
    dragDepth = 0;
    panel.classList.remove("dragging");
  };
  panel.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragover", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    panel.classList.add("dragging");
  });
  panel.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) panel.classList.remove("dragging");
  });
  panel.addEventListener("drop", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragState();
    const file = Array.from(event.dataTransfer?.files || []).find(looksLikeImportFile);
    if (file) selectImportFile(file);
    else setModalStatus("import-prompts-status", t("拖入的文件不是 JSON 或 TXT"), "error");
  });
  document.addEventListener("dragend", clearDragState);
}

function populateSimpleSelect(select, values, selectedValue, emptyLabel = t("暂无可用选项")) {
  select.innerHTML = "";
  const choices = Array.isArray(values) ? values : [];
  if (!choices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  for (const value of choices) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.disabled = false;
  select.value = choices.includes(selectedValue) ? selectedValue : choices[0];
}

async function loadGenerationConfig(force = false) {
  if (!force && state.generationConfig) return state.generationConfig;
  if (!force && state.generationConfigLoading) return state.generationConfigLoading;
  state.generationConfigLoading = api("/pm4a/api/generation/config")
    .then((config) => {
      state.generationConfig = config;
      return config;
    })
    .finally(() => {
      state.generationConfigLoading = null;
    });
  return state.generationConfigLoading;
}

function renderGenerationSettings(config) {
  const settings = config.settings || {};
  const options = config.options || {};
  const analysis = config.analysis || {};
  populateSimpleSelect($("generation-model"), options.models, settings.model, t("没有检测到可用模型"));
  populateSimpleSelect($("generation-clip"), options.clips, settings.clip, t("没有检测到可用 CLIP"));
  populateSimpleSelect($("generation-vae"), options.vaes, settings.vae, t("没有检测到可用 VAE"));
  populateSimpleSelect($("generation-sampler"), options.samplers, settings.sampler, t("沿用工作流"));
  populateSimpleSelect($("generation-scheduler"), options.schedulers, settings.scheduler, t("沿用工作流"));
  $("generation-width").value = settings.width ?? 512;
  $("generation-height").value = settings.height ?? 512;
  $("generation-steps").value = settings.steps ?? 20;
  $("generation-cfg").value = settings.cfg ?? 7;
  $("generation-denoise").value = settings.denoise ?? 1;
  $("generation-seed-mode").value = settings.seed_mode || "random";
  $("generation-seed").value = settings.seed ?? 0;
  $("generation-positive-prefix").value = settings.positive_prefix || "";
  $("generation-positive-suffix").value = settings.positive_suffix || "";
  $("generation-negative-prefix").value = settings.negative_prefix || "";
  $("generation-negative-suffix").value = settings.negative_suffix || "";
  const supported = analysis.parameters || {};
  for (const [name, id] of Object.entries({
    steps: "generation-steps",
    cfg: "generation-cfg",
    sampler: "generation-sampler",
    scheduler: "generation-scheduler",
    denoise: "generation-denoise",
  })) {
    $(id).disabled = !supported[name] || $(id).options?.length === 0;
  }
  if (!analysis.clip) $("generation-clip").disabled = true;
  if (!analysis.vae) $("generation-vae").disabled = true;
  const supportsNegative = analysis.supports_negative !== false;
  $("generation-negative-prefix").disabled = !supportsNegative;
  $("generation-negative-suffix").disabled = !supportsNegative;
  $("generation-seed").disabled = $("generation-seed-mode").value !== "fixed";
  const source = config.workflow_source === "custom" ? t("自定义 api.json") : t("内置纯原生工作流");
  const modelKind = analysis.model?.kind === "unet" ? "UNET" : "Checkpoint";
  const outputClass = analysis.output?.class_type || t("未知输出");
  $("generation-workflow-summary").textContent = `${source} · ${modelKind} · ${outputClass}`;
  $("generation-workflow-reset").disabled = config.workflow_source !== "custom";
  if (!config.comfy_available) {
    setModalStatus("generation-settings-status", t("独立预览模式只能查看设置；请在 ComfyUI 中使用生图。"), "error");
  } else {
    setModalStatus("generation-settings-status");
  }
}

async function openGenerationSettings() {
  $("generation-settings-modal").hidden = false;
  document.body.classList.add("modal-open");
  setModalStatus("generation-settings-status", t("正在读取设置…"));
  $("generation-settings-save").disabled = true;
  try {
    const config = await loadGenerationConfig(true);
    renderGenerationSettings(config);
  } catch (error) {
    setModalStatus("generation-settings-status", String(error.message || error), "error");
  } finally {
    $("generation-settings-save").disabled = false;
  }
}

function closeGenerationSettings() {
  $("generation-settings-modal").hidden = true;
  document.body.classList.remove("modal-open");
}

function generationSettingsFromForm() {
  return {
    model: $("generation-model").value,
    clip: $("generation-clip").value,
    vae: $("generation-vae").value,
    width: Number($("generation-width").value),
    height: Number($("generation-height").value),
    steps: Number($("generation-steps").value),
    cfg: Number($("generation-cfg").value),
    sampler: $("generation-sampler").value,
    scheduler: $("generation-scheduler").value,
    denoise: Number($("generation-denoise").value),
    seed_mode: $("generation-seed-mode").value,
    seed: Number($("generation-seed").value),
    positive_prefix: $("generation-positive-prefix").value,
    positive_suffix: $("generation-positive-suffix").value,
    negative_prefix: $("generation-negative-prefix").value,
    negative_suffix: $("generation-negative-suffix").value,
  };
}

async function saveGenerationSettings(event) {
  event.preventDefault();
  $("generation-settings-save").disabled = true;
  $("generation-settings-cancel").disabled = true;
  setModalStatus("generation-settings-status", t("正在保存…"));
  try {
    const config = await api("/pm4a/api/generation/config", {
      method: "PUT",
      body: JSON.stringify({ settings: generationSettingsFromForm() }),
    });
    state.generationConfig = config;
    renderGenerationSettings(config);
    setModalStatus("generation-settings-status", t("设置已保存"), "success");
    toast(t("生图设置已保存"), "success");
  } catch (error) {
    setModalStatus("generation-settings-status", String(error.message || error), "error");
  } finally {
    $("generation-settings-save").disabled = false;
    $("generation-settings-cancel").disabled = false;
  }
}

async function importGenerationWorkflow(file) {
  if (!file) return;
  setModalStatus("generation-settings-status", t("正在检查 api.json…"));
  $("generation-workflow-import").disabled = true;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error(t("api.json 不能超过 4 MB"));
    const workflow = JSON.parse(await file.text());
    const config = await api("/pm4a/api/generation/workflow", {
      method: "POST",
      body: JSON.stringify({ workflow }),
    });
    state.generationConfig = config;
    renderGenerationSettings(config);
    setModalStatus("generation-settings-status", t("自定义工作流已启用"), "success");
    toast(t("api.json 已替换"), "success");
  } catch (error) {
    setModalStatus("generation-settings-status", String(error.message || error), "error");
  } finally {
    $("generation-workflow-import").disabled = false;
  }
}

async function resetGenerationWorkflow() {
  if (!window.confirm(t("恢复内置纯原生工作流？当前自定义 api.json 将停止使用。"))) return;
  $("generation-workflow-reset").disabled = true;
  setModalStatus("generation-settings-status", t("正在恢复默认工作流…"));
  try {
    const config = await api("/pm4a/api/generation/workflow/reset", {
      method: "POST",
      body: "{}",
    });
    state.generationConfig = config;
    renderGenerationSettings(config);
    setModalStatus("generation-settings-status", t("已恢复内置工作流"), "success");
  } catch (error) {
    setModalStatus("generation-settings-status", String(error.message || error), "error");
  } finally {
    $("generation-workflow-reset").disabled = state.generationConfig?.workflow_source !== "custom";
  }
}

function comfyImageUrl(locator) {
  const query = new URLSearchParams({
    filename: locator.filename || "",
    subfolder: locator.subfolder || "",
    type: locator.type || "output",
  });
  return `/view?${query.toString()}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function connectGenerationSocket(clientId, getPromptId, onProgress, setFailure) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws?clientId=${encodeURIComponent(clientId)}`);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    const promptId = getPromptId();
    const data = message?.data || {};
    if (!promptId || data.prompt_id !== promptId) return;
    if (message.type === "progress" && Number(data.max) > 0) {
      onProgress?.(Number(data.value) || 0, Number(data.max) || 0);
    } else if (message.type === "execution_error") {
      setFailure(String(data.exception_message || data.exception_type || t("工作流执行失败")));
    }
  });
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(socket), 1800);
    socket.addEventListener("open", () => {
      window.clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timer);
      resolve(socket);
    }, { once: true });
  });
}

async function waitForPromptHistory(promptId, getFailure) {
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const socketFailure = getFailure();
    if (socketFailure) throw new Error(socketFailure);
    const response = await fetch(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      const record = payload[promptId];
      if (record) {
        const status = record.status || {};
        if (status.status_str === "error") {
          const details = JSON.stringify(status.messages || []).slice(0, 1200);
          throw new Error(details || t("工作流执行失败"));
        }
        if (status.completed || (record.outputs && Object.keys(record.outputs).length)) {
          return record;
        }
      }
    }
    await delay(450);
  }
  throw new Error(t("等待生图结果超时"));
}

async function queueGenerationPrompt(prompt, outputNode, onProgress) {
  const clientId = crypto.randomUUID?.() || `pm4a-gen-${Date.now()}-${Math.random()}`;
  let promptId = "";
  let executionFailure = "";
  const socket = await connectGenerationSocket(
    clientId,
    () => promptId,
    onProgress,
    (message) => { executionFailure = message; },
  );
  try {
    const queued = await api("/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt, client_id: clientId }),
    });
    promptId = queued.prompt_id;
    if (!promptId) throw new Error(t("ComfyUI 没有返回 prompt_id"));
    const history = await waitForPromptHistory(promptId, () => executionFailure);
    const images = history.outputs?.[String(outputNode)]?.images;
    if (!Array.isArray(images) || images.length !== 1) {
      throw new Error(t("工作流最终输出必须恰好包含一张图片"));
    }
    return { promptId, locator: images[0] };
  } finally {
    try { socket?.close(); } catch (_) { /* no-op */ }
  }
}

function joinGenerationPromptParts(...parts) {
  return parts
    .map((part) => String(part || "").trim().replace(/^,+|,+$/g, "").trim())
    .filter(Boolean)
    .join(", ");
}

const GENERATION_AFFIX_FIELDS = {
  positive_prefix: "positive-prefix",
  positive_suffix: "positive-suffix",
  negative_prefix: "negative-prefix",
  negative_suffix: "negative-suffix",
};

function configuredGenerationAffixes(config) {
  const settings = config?.settings || {};
  return Object.fromEntries(
    Object.keys(GENERATION_AFFIX_FIELDS).map((key) => [key, settings[key] || ""]),
  );
}

function fillGenerationAffixFields(scope, config) {
  const affixes = configuredGenerationAffixes(config);
  for (const [key, suffix] of Object.entries(GENERATION_AFFIX_FIELDS)) {
    const field = $(`${scope}-${suffix}`);
    field.value = affixes[key];
    resizeGenerationAffixField(field);
  }
}

function resizeGenerationAffixField(field) {
  if (!field?.classList.contains("generation-auto-resize") || !field.offsetParent) return;
  field.style.height = "auto";
  const styles = window.getComputedStyle(field);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 21;
  const borders = (Number.parseFloat(styles.borderTopWidth) || 0)
    + (Number.parseFloat(styles.borderBottomWidth) || 0);
  field.style.height = `${Math.ceil(field.scrollHeight + borders + lineHeight)}px`;
}

function readGenerationAffixFields(scope) {
  return Object.fromEntries(
    Object.entries(GENERATION_AFFIX_FIELDS).map(([key, suffix]) => [
      key,
      $(`${scope}-${suffix}`).value,
    ]),
  );
}

function setGenerationAffixFieldsDisabled(scope, disabled, supportsNegative = true) {
  for (const [key, suffix] of Object.entries(GENERATION_AFFIX_FIELDS)) {
    $(`${scope}-${suffix}`).disabled = disabled || (!supportsNegative && key.startsWith("negative_"));
  }
}

function composeGenerationPrompts(affixes, positive, negative) {
  return {
    positive: joinGenerationPromptParts(
      affixes.positive_prefix,
      positive,
      affixes.positive_suffix,
    ),
    negative: joinGenerationPromptParts(
      affixes.negative_prefix,
      negative,
      affixes.negative_suffix,
    ),
  };
}

async function generatePromptImage({
  title,
  positive,
  negative = "",
  key = "",
  onProgress,
  applyFixedPrompts = true,
}) {
  const prepared = await api("/pm4a/api/generation/prepare", {
    method: "POST",
    body: JSON.stringify({
      positive,
      negative,
      apply_fixed_prompts: applyFixedPrompts,
    }),
  });
  const queued = await queueGenerationPrompt(prepared.prompt, prepared.output_node, onProgress);
  return api("/pm4a/api/generation/finalize", {
    method: "POST",
    body: JSON.stringify({
      locator: queued.locator,
      title,
      key,
      metadata: {
        original_positive: positive,
        original_negative: negative,
        positive: prepared.positive,
        negative: prepared.negative,
        parameters: prepared.parameters,
        prompt_id: queued.promptId,
      },
    }),
  });
}

function markListItemHasImage(key) {
  const item = state.items.find((candidate) => candidate.key === key);
  if (item) item.has_image = true;
}

async function openGenerationConfirm(mode, key = "") {
  state.generationConfirmMode = mode;
  state.generationConfirmKey = key;
  $("generation-confirm-modal").hidden = false;
  document.body.classList.add("modal-open");
  $("generation-confirm-submit").disabled = true;
  setModalStatus("generation-confirm-status", t("正在读取默认提示词…"));
  try {
    const config = await loadGenerationConfig(true);
    if (!config.comfy_available) throw new Error(t("请在运行中的 ComfyUI 内使用生图"));
    if (
      state.generationConfirmMode !== mode
      || state.generationConfirmKey !== key
    ) return;
    fillGenerationAffixFields("generation-confirm", config);
    setGenerationAffixFieldsDisabled(
      "generation-confirm",
      false,
      config.analysis?.supports_negative !== false,
    );
    setModalStatus("generation-confirm-status");
    $("generation-confirm-submit").disabled = false;
    requestAnimationFrame(() => $("generation-confirm-positive-prefix").focus());
  } catch (error) {
    setModalStatus("generation-confirm-status", String(error.message || error), "error");
  }
}

async function openDetailGenerationConfirm() {
  if (!state.selected || state.generationBusy) return;
  if (state.selected.capabilities?.generation === false) {
    setSendStatus(t("Wildcard 卡片不能生成示例图"), "error");
    toast(t("Wildcard 卡片不能生成示例图"), "error");
    return;
  }
  if (hasDirtyDetailEdits()) {
    setSendStatus(t("请先保存当前修改，再生成示例图"), "error");
    toast(t("请先保存当前修改"), "error");
    return;
  }
  const entry = state.selected;
  await openGenerationConfirm("detail", entry.key);
}

async function openCreateGenerationConfirm() {
  if (state.generationBusy || state.creatingEntry) return;
  if (!$("add-prompt-content").value.trim()) {
    setModalStatus("add-prompt-status", t("请先填写正面提示词"), "error");
    $("add-prompt-content").focus();
    return;
  }
  await openGenerationConfirm("create");
}

function closeGenerationConfirm() {
  if (state.generationBusy) return;
  $("generation-confirm-modal").hidden = true;
  state.generationConfirmMode = "";
  state.generationConfirmKey = "";
  if ($("detail-modal").hidden && $("add-prompt-modal").hidden) {
    document.body.classList.remove("modal-open");
  }
}

async function submitGenerationConfirm(event) {
  if (state.generationConfirmMode === "create") {
    return generateCreateImage(event);
  }
  if (state.generationConfirmMode === "detail") {
    return generateDetailImage(event);
  }
  event.preventDefault();
}

async function generateDetailImage(event) {
  event.preventDefault();
  if (!state.selected || state.generationBusy) return;
  if (state.selected.capabilities?.generation === false) {
    setModalStatus("generation-confirm-status", t("Wildcard 卡片不能生成示例图"), "error");
    return;
  }
  if (state.selected.key !== state.generationConfirmKey) {
    setModalStatus("generation-confirm-status", t("当前提示词已变化，请关闭后重新打开"), "error");
    return;
  }
  const prompts = composeGenerationPrompts(
    readGenerationAffixFields("generation-confirm"),
    state.selected.content || "",
    state.selected.negative || "",
  );
  const positive = prompts.positive;
  const negative = prompts.negative;
  if (!positive.trim()) {
    setModalStatus("generation-confirm-status", t("正面提示词不能为空"), "error");
    $("generation-confirm-positive-prefix").focus();
    return;
  }
  state.generationBusy = true;
  setImageUploadState(true);
  $("detail-image-drop-overlay").querySelector("span").textContent = t("正在生成示例图…");
  setSendStatus(t("正在提交生图任务…"));
  $("generation-confirm-submit").disabled = true;
  $("generation-confirm-cancel").disabled = true;
  $("generation-confirm-close").disabled = true;
  setGenerationAffixFieldsDisabled("generation-confirm", true);
  setModalStatus("generation-confirm-status", t("正在提交生图任务…"));
  let completed = false;
  try {
    const result = await generatePromptImage({
      title: state.selected.name,
      positive,
      negative,
      key: state.selected.key,
      applyFixedPrompts: false,
      onProgress: (value, max) => {
        setSendStatus(t("正在生成 {value} / {max}", { value, max }));
        setModalStatus("generation-confirm-status", t("正在生成 {value} / {max}", { value, max }));
      },
    });
    const entry = result.entry;
    if (!entry) throw new Error(t("示例图保存结果无效"));
    state.selected = entry;
    state.entryCache.set(entry.key, entry);
    markListItemHasImage(entry.key);
    renderInspectorEntry(entry, true);
    resetDetailEditing();
    refreshVisibleCardImage(entry.key);
    updateSelectedRow();
    setSendStatus(t("示例图已生成并保存"), "success");
    toast(t("示例图已生成并保存"), "success");
    completed = true;
  } catch (error) {
    setSendStatus(String(error.message || error), "error");
    setModalStatus("generation-confirm-status", String(error.message || error), "error");
    toast(t("生成失败：{error}", { error: error.message || error }), "error");
  } finally {
    state.generationBusy = false;
    setImageUploadState(false);
    $("generation-confirm-submit").disabled = false;
    $("generation-confirm-cancel").disabled = false;
    $("generation-confirm-close").disabled = false;
    setGenerationAffixFieldsDisabled(
      "generation-confirm",
      false,
      state.generationConfig?.analysis?.supports_negative !== false,
    );
    if (completed) closeGenerationConfirm();
  }
}

async function generateCreateImage(event) {
  event.preventDefault();
  if (state.generationBusy || state.creatingEntry) return;
  if (state.generationConfirmMode !== "create") return;
  const prompts = composeGenerationPrompts(
    readGenerationAffixFields("generation-confirm"),
    $("add-prompt-content").value,
    $("add-prompt-negative").value,
  );
  const positive = prompts.positive;
  const negative = prompts.negative;
  if (!positive.trim()) {
    setModalStatus("generation-confirm-status", t("正面提示词不能为空"), "error");
    $("generation-confirm-positive-prefix").focus();
    return;
  }
  state.generationBusy = true;
  $("add-prompt-generate").disabled = true;
  $("add-prompt-save").disabled = true;
  $("generation-confirm-submit").disabled = true;
  $("generation-confirm-cancel").disabled = true;
  $("generation-confirm-close").disabled = true;
  setGenerationAffixFieldsDisabled("generation-confirm", true);
  setModalStatus("add-prompt-status", t("正在提交生图任务…"));
  setModalStatus("generation-confirm-status", t("正在提交生图任务…"));
  let completed = false;
  try {
    const result = await generatePromptImage({
      title: $("add-prompt-name").value.trim() || "PM4A",
      positive,
      negative,
      applyFixedPrompts: false,
      onProgress: (value, max) => {
        setModalStatus("add-prompt-status", t("正在生成 {value} / {max}", { value, max }));
        setModalStatus("generation-confirm-status", t("正在生成 {value} / {max}", { value, max }));
      },
    });
    const previousLocator = state.createGeneratedLocator;
    if (state.createImageUrl) URL.revokeObjectURL(state.createImageUrl);
    state.createImage = null;
    state.createGeneratedLocator = result.locator;
    discardGeneratedPreview(previousLocator);
    state.createImageUrl = comfyImageUrl(result.locator);
    const preview = $("add-prompt-image-preview");
    preview.src = state.createImageUrl;
    preview.hidden = false;
    $("add-prompt-image-empty").hidden = true;
    setCreateImageStatus(t("生成图片已保存，将在添加提示词后设为例图"), "success");
    setModalStatus("add-prompt-status", t("图片生成完成"), "success");
    completed = true;
  } catch (error) {
    setModalStatus("add-prompt-status", String(error.message || error), "error");
    setModalStatus("generation-confirm-status", String(error.message || error), "error");
  } finally {
    state.generationBusy = false;
    $("add-prompt-generate").disabled = false;
    $("add-prompt-save").disabled = false;
    $("generation-confirm-submit").disabled = false;
    $("generation-confirm-cancel").disabled = false;
    $("generation-confirm-close").disabled = false;
    setGenerationAffixFieldsDisabled(
      "generation-confirm",
      false,
      state.generationConfig?.analysis?.supports_negative !== false,
    );
    if (completed) closeGenerationConfirm();
  }
}

async function refreshGenerationBatchPlan() {
  if (state.generationBatchRunning) return;
  $("generation-batch-confirm").disabled = true;
  setModalStatus("generation-batch-status", t("正在统计提示词…"));
  try {
    const plan = await api("/pm4a/api/generation/batch/plan", {
      method: "POST",
      body: JSON.stringify({
        folder: state.generationBatchFolder,
        mode: $("generation-batch-mode").value,
        recursive: $("generation-batch-recursive").checked,
      }),
    });
    state.generationBatchPlan = plan;
    $("generation-batch-summary").textContent = t(
      "本次将生成 {count} 张，跳过 {skipped} 个 Wildcard",
      {
        count: numberFormatter.format(plan.count),
        skipped: numberFormatter.format(plan.skipped_wildcard_count || 0),
      },
    );
    setModalStatus("generation-batch-status", plan.count ? "" : t("当前范围没有需要生成的提示词"));
    $("generation-batch-confirm").disabled = !plan.count;
  } catch (error) {
    state.generationBatchPlan = null;
    setModalStatus("generation-batch-status", String(error.message || error), "error");
  }
}

async function openGenerationBatchModal(folder = "") {
  state.generationBatchFolder = folder || "";
  state.generationBatchPlan = null;
  state.generationBatchStopRequested = false;
  $("generation-batch-mode").value = "missing";
  $("generation-batch-recursive").checked = true;
  $("generation-batch-folder").textContent = folder ? t("分类：{folder}", { folder }) : t("范围：全部提示词");
  $("generation-batch-cancel").textContent = t("取消");
  $("generation-batch-cancel").disabled = false;
  $("generation-batch-close").disabled = false;
  $("generation-batch-confirm").textContent = t("开始批量生成");
  fillGenerationAffixFields("generation-batch", {});
  setGenerationAffixFieldsDisabled("generation-batch", false);
  $("generation-batch-modal").hidden = false;
  document.body.classList.add("modal-open");
  try {
    const config = await loadGenerationConfig(true);
    if (!config.comfy_available) throw new Error(t("请在运行中的 ComfyUI 内使用批量生图"));
    fillGenerationAffixFields("generation-batch", config);
    setGenerationAffixFieldsDisabled(
      "generation-batch",
      false,
      config.analysis?.supports_negative !== false,
    );
    await refreshGenerationBatchPlan();
  } catch (error) {
    setModalStatus("generation-batch-status", String(error.message || error), "error");
    $("generation-batch-confirm").disabled = true;
  }
}

function closeGenerationBatchModal() {
  if (state.generationBatchRunning) return;
  $("generation-batch-modal").hidden = true;
  document.body.classList.remove("modal-open");
}

function stopGenerationBatch() {
  if (!state.generationBatchRunning || state.generationBatchStopRequested) return;
  state.generationBatchStopRequested = true;
  setModalStatus("generation-batch-status", t("将在当前图片完成后停止…"));
  $("generation-batch-cancel").disabled = true;
}

function handleGenerationBatchCancel() {
  if (state.generationBatchRunning) {
    stopGenerationBatch();
    return;
  }
  closeGenerationBatchModal();
}

async function runGenerationBatch(event) {
  event.preventDefault();
  if (state.generationBatchRunning) return;
  if (!state.generationBatchPlan?.count) await refreshGenerationBatchPlan();
  const keys = [...(state.generationBatchPlan?.keys || [])];
  if (!keys.length) return;
  const affixes = readGenerationAffixFields("generation-batch");
  state.generationBatchRunning = true;
  state.generationBatchStopRequested = false;
  state.generationBusy = true;
  $("generation-batch-mode").disabled = true;
  $("generation-batch-recursive").disabled = true;
  setGenerationAffixFieldsDisabled("generation-batch", true);
  $("generation-batch-confirm").disabled = true;
  $("generation-batch-cancel").textContent = t("停止");
  $("generation-batch-close").disabled = true;
  let succeeded = 0;
  let skipped = state.generationBatchPlan?.skipped_wildcard_count || 0;
  const errors = [];
  try {
    for (let index = 0; index < keys.length; index += 1) {
      if (state.generationBatchStopRequested) break;
      const key = keys[index];
      try {
        const entry = await getEntry(key);
        if (entry.capabilities?.generation === false) {
          skipped += 1;
          continue;
        }
        const prompts = composeGenerationPrompts(
          affixes,
          entry.content || "",
          entry.negative || "",
        );
        const positive = prompts.positive;
        const negative = prompts.negative;
        if (!positive) throw new Error(t("条目的正面提示词为空"));
        setModalStatus(
          "generation-batch-status",
          t("全部图片进度：{current} / {total} · 当前图片：{name}", {
            current: index + 1,
            total: keys.length,
            name: entry.name,
          }),
        );
        const result = await generatePromptImage({
          title: entry.name,
          positive,
          negative,
          key: entry.key,
          applyFixedPrompts: false,
          onProgress: (value, max) => setModalStatus(
            "generation-batch-status",
            t("全部图片进度：{current} / {total} · 当前图片：{name} · 单图步数：{value} / {max}", {
              current: index + 1,
              total: keys.length,
              name: entry.name,
              value,
              max,
            }),
          ),
        });
        if (!result.entry) throw new Error(t("示例图保存结果无效"));
        state.entryCache.set(entry.key, result.entry);
        markListItemHasImage(entry.key);
        bumpImageRevision(entry.key);
        if (state.selectedKey === entry.key) {
          state.selected = result.entry;
          renderInspectorEntry(result.entry);
          resetDetailEditing();
        }
        refreshVisibleCardImage(entry.key);
        succeeded += 1;
      } catch (error) {
        errors.push(t("{key}：{error}", { key, error: error.message || error }));
      }
    }
  } finally {
    const stopped = state.generationBatchStopRequested;
    state.generationBatchRunning = false;
    state.generationBatchStopRequested = false;
    state.generationBusy = false;
    $("generation-batch-mode").disabled = false;
    $("generation-batch-recursive").disabled = false;
    setGenerationAffixFieldsDisabled(
      "generation-batch",
      false,
      state.generationConfig?.analysis?.supports_negative !== false,
    );
    $("generation-batch-cancel").disabled = false;
    $("generation-batch-cancel").textContent = t("关闭");
    $("generation-batch-close").disabled = false;
    $("generation-batch-confirm").textContent = t("再次生成");
    $("generation-batch-confirm").disabled = false;
    state.generationBatchPlan = null;
    updateSelectedRow();
    const summary = stopped
      ? t("已停止，成功 {succeeded} 条，失败 {failed} 条，跳过 {skipped} 条", {
        succeeded,
        failed: errors.length,
        skipped,
      })
      : t("成功 {succeeded} 条，失败 {failed} 条，跳过 {skipped} 条", {
        succeeded,
        failed: errors.length,
        skipped,
      });
    const errorDetails = errors.slice(0, 3).reduce(
      (details, error) => details ? t("{details}；{error}", { details, error }) : error,
      "",
    );
    const status = errors.length
      ? stopped
        ? t("已停止，成功 {succeeded} 条，失败 {failed} 条；{errors}。", {
          succeeded,
          failed: errors.length,
          errors: errorDetails,
        })
        : t("成功 {succeeded} 条，失败 {failed} 条；{errors}。", {
          succeeded,
          failed: errors.length,
          errors: errorDetails,
        })
      : summary;
    setModalStatus("generation-batch-status", status, errors.length ? "error" : "success");
    $("generation-batch-summary").textContent = summary;
    toast(summary, errors.length ? "error" : "success");
  }
}

function setupEventHandlers() {
  $("btn-generation-settings").addEventListener("click", openGenerationSettings);
  $("generation-settings-close").addEventListener("click", closeGenerationSettings);
  $("generation-settings-cancel").addEventListener("click", closeGenerationSettings);
  $("generation-settings-form").addEventListener("submit", saveGenerationSettings);
  $("generation-settings-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("generation-settings-modal")) closeGenerationSettings();
  });
  $("generation-seed-mode").addEventListener("change", () => {
    $("generation-seed").disabled = $("generation-seed-mode").value !== "fixed";
  });
  $("generation-workflow-import").addEventListener("click", () => {
    const input = $("generation-workflow-input");
    input.value = "";
    input.click();
  });
  $("generation-workflow-input").addEventListener("change", () => {
    const input = $("generation-workflow-input");
    if (input.files?.[0]) importGenerationWorkflow(input.files[0]);
    input.value = "";
  });
  $("generation-workflow-reset").addEventListener("click", resetGenerationWorkflow);

  $("generation-confirm-close").addEventListener("click", closeGenerationConfirm);
  $("generation-confirm-cancel").addEventListener("click", closeGenerationConfirm);
  $("generation-confirm-form").addEventListener("submit", submitGenerationConfirm);
  $("generation-confirm-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("generation-confirm-modal")) closeGenerationConfirm();
  });
  document.querySelectorAll(".generation-auto-resize").forEach((field) => {
    field.addEventListener("input", () => resizeGenerationAffixField(field));
  });

  $("btn-add-prompt").addEventListener("click", openAddPromptModal);
  $("add-prompt-import").addEventListener("click", openImportPromptsModal);
  $("add-prompt-close").addEventListener("click", closeAddPromptModal);
  $("add-prompt-cancel").addEventListener("click", closeAddPromptModal);
  $("add-prompt-form").addEventListener("submit", saveNewPrompt);
  $("add-prompt-generate").addEventListener("click", openCreateGenerationConfirm);
  $("add-prompt-image-drop").addEventListener("click", () => {
    const input = $("add-prompt-image-input");
    input.value = "";
    input.click();
  });
  $("add-prompt-image-input").addEventListener("change", () => {
    const input = $("add-prompt-image-input");
    if (input.files?.[0]) setCreateImage(input.files[0]);
    input.value = "";
  });
  $("add-prompt-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("add-prompt-modal")) closeAddPromptModal();
  });

  $("import-prompts-close").addEventListener("click", closeImportPromptsModal);
  $("import-prompts-cancel").addEventListener("click", closeImportPromptsModal);
  $("import-prompts-form").addEventListener("submit", importPrompts);
  $("external-wildcards-detect").addEventListener("click", () => {
    void detectExternalWildcards();
  });
  $("external-wildcards-toggle-all").addEventListener("click", () => {
    const files = importableExternalWildcardFiles();
    const allSelected = files.length > 0
      && files.every((file) => state.externalWildcardSelected.has(file.id));
    state.externalWildcardSelected = new Set(
      allSelected ? [] : files.map((file) => file.id)
    );
    void applyExternalWildcardSelection();
  });
  $("import-prompts-drop").addEventListener("click", () => {
    const input = $("import-prompts-input");
    input.value = "";
    input.click();
  });
  $("import-prompts-input").addEventListener("change", () => {
    const input = $("import-prompts-input");
    if (input.files?.[0]) selectImportFile(input.files[0]);
    input.value = "";
  });
  $("import-prompts-destination").addEventListener("change", () => {
    if (state.importPrompts.length || state.importContent) refreshImportPreview();
  });
  document.querySelectorAll('input[name="import-txt-mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (state.importFile?.name?.toLowerCase().endsWith(".txt")) {
        void selectImportFile(state.importFile);
      }
    });
  });
  $("import-prompts-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("import-prompts-modal")) closeImportPromptsModal();
  });

  $("folder-create-close").addEventListener("click", closeFolderCreateModal);
  $("folder-create-cancel").addEventListener("click", closeFolderCreateModal);
  $("folder-create-form").addEventListener("submit", saveNewFolder);
  $("folder-create-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("folder-create-modal")) closeFolderCreateModal();
  });

  $("generation-batch-close").addEventListener("click", closeGenerationBatchModal);
  $("generation-batch-cancel").addEventListener("click", handleGenerationBatchCancel);
  $("generation-batch-form").addEventListener("submit", runGenerationBatch);
  $("generation-batch-mode").addEventListener("change", refreshGenerationBatchPlan);
  $("generation-batch-recursive").addEventListener("change", refreshGenerationBatchPlan);

  $("btn-show-sidebar").addEventListener("click", openSidebar);
  $("btn-hide-sidebar").addEventListener("click", closeSidebar);
  $("sidebar").addEventListener("transitionend", (event) => {
    if (event.target === $("sidebar") && (event.propertyName === "transform" || event.propertyName === "opacity")) {
      updateWorkspaceMargin();
    }
  });
  window.addEventListener("resize", () => {
    updateWorkspaceMargin();
    if (state.editingTitle) resizeDetailTitleInput();
    if (state.editingContent) resizeDetailContentEditor();
    if (state.editingNegative) resizeDetailEditor("detail-negative-editor");
    if (state.editingNote) resizeDetailEditor("detail-note-editor");
    document.querySelectorAll(".generation-auto-resize").forEach(resizeGenerationAffixField);
  });

  $("btn-recursive").addEventListener("click", () => {
    state.recursive = !state.recursive;
    storeValue(STORAGE_KEYS.recursive, state.recursive);
    updateRecursiveButton();
    resetAndLoadList({ preserveInspector: true });
  });

  $("btn-collapse").addEventListener("click", () => {
    state.expanded.clear();
    persistExpanded();
    renderTree();
  });

  $("btn-all-prompts").addEventListener("click", () => selectFolder(""));

  $("folder-tree").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle-path]");
    if (toggle) {
      const path = toggle.dataset.togglePath;
      if (state.expanded.has(path)) state.expanded.delete(path);
      else state.expanded.add(path);
      persistExpanded();
      renderTree();
      return;
    }
    const row = event.target.closest("[data-folder-path]");
    if (row) selectFolder(row.dataset.folderPath);
  });

  $("folder-tree").addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-folder-path]");
    showFolderContextMenu(event, row?.dataset.folderPath || "");
  });
  $("btn-all-prompts").addEventListener("contextmenu", (event) => {
    showFolderContextMenu(event, "");
  });
  $("folder-context-menu").addEventListener("click", (event) => {
    const action = event.target.closest("[data-context-action]")?.dataset.contextAction;
    if (!action) return;
    const folderPath = state.contextFolderPath;
    const contextItems = state.contextItems.map((item) => ({ ...item }));
    hideFolderContextMenu();
    if (action === "create") openFolderCreateModal(folderPath);
    else if (action === "rename") openFolderRenameModal(folderPath);
    else if (action === "wildcard") copyFolderWildcard(folderPath);
    else if (action === "prompt-wildcard") copyPromptWildcards(contextItems);
    else if (action === "export") exportFolderPrompts(folderPath);
    else if (action === "generate") openGenerationBatchModal(folderPath);
    else if (action === "operation-copy") requestItemOperation("copy", contextItems);
    else if (action === "operation-move") requestItemOperation("move", contextItems);
    else if (action === "operation-delete") requestItemOperation("delete", contextItems);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#folder-context-menu")) hideFolderContextMenu();
  });
  window.addEventListener("blur", hideFolderContextMenu);
  window.addEventListener("resize", hideFolderContextMenu);

  setupBatchMarqueeSelection();

  $("prompt-list").addEventListener("click", (event) => {
    if (state.batchMode) {
      const row = event.target.closest(".prompt-item");
      if (row) toggleBatchSelection(row.dataset.key);
      return;
    }
    const favoriteButton = event.target.closest(".favorite-button");
    if (favoriteButton) {
      event.stopPropagation();
      toggleFavorite(favoriteButton.dataset.favoriteKey);
      return;
    }
    const copyButton = event.target.closest(".copy-button");
    if (copyButton) {
      event.stopPropagation();
      copyByKey(copyButton.dataset.copyKey, copyButton);
      return;
    }
    const sendButton = event.target.closest(".send-button");
    if (sendButton) {
      event.stopPropagation();
      sendByKey(sendButton.dataset.key, sendButton.dataset.slot, sendButton);
      return;
    }
    const row = event.target.closest(".prompt-item");
    if (row) selectPrompt(row.dataset.key);
  });

  $("prompt-list").addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".prompt-item");
    if (row) showPromptContextMenu(event, row.dataset.key);
  });

  $("prompt-list").addEventListener("keydown", async (event) => {
    if (event.target.closest(".send-button, .favorite-button")) return;
    const row = event.target.closest(".prompt-item");
    if (!row || event.target !== row) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (state.batchMode) toggleBatchSelection(row.dataset.key);
      else selectPrompt(row.dataset.key);
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const currentIndex = state.items.findIndex((item) => item.key === row.dataset.key);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= state.total) return;
    if (targetIndex >= state.items.length && state.hasMore) await loadNextPage();
    const targetItem = state.items[targetIndex];
    const targetRow = [...document.querySelectorAll("#prompt-list .prompt-item")]
      .find((candidate) => candidate.dataset.key === targetItem?.key);
    targetRow?.focus({ preventScroll: false });
  });

  $("btn-view-list").addEventListener("click", () => setViewMode("list"));
  $("btn-view-cards").addEventListener("click", () => setViewMode("cards"));
  $("btn-send-mode").addEventListener("click", toggleSendMode);
  $("detail-send-mode").addEventListener("click", toggleSendMode);
  $("sort-select").addEventListener("change", () => {
    const mode = $("sort-select").value;
    if (!SORT_MODES.has(mode) || mode === state.sortMode) return;
    state.sortMode = mode;
    storeValue(STORAGE_KEYS.sortMode, mode);
    resetAndLoadList();
  });
  $("btn-favorites-only").addEventListener("click", () => {
    state.favoritesOnly = !state.favoritesOnly;
    updateFavoriteFilterButton();
    resetAndLoadList();
  });
  $("btn-batch-mode").addEventListener("click", () => setBatchMode(!state.batchMode));

  $("operation-close").addEventListener("click", closeOperationModal);
  $("operation-cancel").addEventListener("click", closeOperationModal);
  $("operation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.pendingOperation || !state.pendingOperationItems.length) return;
    runItemOperation(
      state.pendingOperation,
      state.pendingOperationItems,
      $("operation-destination").value,
    );
  });
  $("operation-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("operation-modal")) closeOperationModal();
  });
  $("confirm-close").addEventListener("click", () => closeConfirmModal(false));
  $("confirm-cancel").addEventListener("click", () => closeConfirmModal(false));
  $("confirm-ok").addEventListener("click", () => closeConfirmModal(true));
  $("confirm-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("confirm-modal")) closeConfirmModal(false);
  });

  const handleSearch = debounce(() => {
    state.search = $("search").value.trim();
    resetAndLoadList({ preserveInspector: true });
  }, 280);
  $("search").addEventListener("input", () => {
    $("search").parentElement.classList.toggle("has-value", Boolean($("search").value));
    handleSearch();
  });

  $("btn-retry").addEventListener("click", () => {
    $("error-state").hidden = true;
    if (state.items.length) loadNextPage();
    else resetAndLoadList();
  });

  $("btn-reload").addEventListener("click", async () => {
    const button = $("btn-reload");
    button.disabled = true;
    button.classList.add("reloading");
    try {
      await api("/pm4a/api/reload", { method: "POST", body: "{}" });
      state.entryCache.clear();
      clearInspector();
      state.expanded.clear();
      persistExpanded();
      await loadTree();
      await resetAndLoadList();
      toast(t("提示词库已刷新"), "success");
    } catch (error) {
      toast(t("刷新失败：{error}", { error: error.message || error }), "error");
    } finally {
      button.disabled = false;
      button.classList.remove("reloading");
    }
  });

  $("detail-close").addEventListener("click", closeDetailModal);
  $("detail-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("detail-modal")) closeDetailModal();
  });
  $("detail-prev").addEventListener("click", () => navigateDetail(-1));
  $("detail-next").addEventListener("click", () => navigateDetail(1));
  $("detail-edit-title").addEventListener("click", beginTitleEdit);
  $("detail-edit-content").addEventListener("click", beginContentEdit);
  $("detail-edit-negative").addEventListener("click", beginNegativeEdit);
  $("detail-edit-note").addEventListener("click", beginNoteEdit);
  $("detail-add-lora").addEventListener("click", () => {
    void openLoraPicker();
  });
  $("lora-picker-close").addEventListener("click", closeLoraPicker);
  $("lora-picker-cancel").addEventListener("click", closeLoraPicker);
  $("lora-picker-add").addEventListener("click", () => {
    void confirmLoraPickerAdd();
  });
  $("lora-picker-strength").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirmLoraPickerAdd();
    }
  });
  $("lora-picker-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("lora-picker-modal")) closeLoraPicker();
  });
  $("lora-picker-search").addEventListener("input", () => {
    clearTimeout(state.loraPickerTimer);
    const query = $("lora-picker-search").value;
    state.loraPickerTimer = setTimeout(() => {
      void renderLoraPickerResults(query);
    }, 200);
  });
  $("lora-picker-parse").addEventListener("click", () => {
    void addLorasFromPasteText();
  });
  $("lora-picker-paste").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void addLorasFromPasteText();
    }
  });
  $("detail-copy-content").addEventListener("click", copyDetailContent);
  $("detail-copy-negative").addEventListener("click", copyDetailNegative);
  $("detail-reveal-txt").addEventListener("click", () => openSelectedTxt("reveal"));
  $("detail-open-txt").addEventListener("click", () => openSelectedTxt("edit"));
  $("detail-edit-image").addEventListener("click", chooseDetailImage);
  $("detail-generate-image").addEventListener("click", openDetailGenerationConfirm);
  $("detail-image-input").addEventListener("change", () => {
    const input = $("detail-image-input");
    const file = input.files?.[0];
    if (file) setImageDraft(file);
    input.value = "";
  });
  $("detail-save").addEventListener("click", saveDetailEdits);
  $("detail-title-input").addEventListener("input", () => {
    resizeDetailTitleInput();
    updateDetailEditControls();
  });
  $("detail-content-editor").addEventListener("input", () => {
    resizeDetailContentEditor();
    updateDetailEditControls();
  });
  ["negative", "note"].forEach((field) => {
    $(`detail-${field}-editor`).addEventListener("input", () => {
      resizeDetailEditor(`detail-${field}-editor`);
      updateDetailEditControls();
    });
  });
  [
    $("detail-title-input"),
    $("detail-content-editor"),
    $("detail-negative-editor"),
    $("detail-note-editor"),
  ].forEach((editor) => {
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (editor === $("detail-title-input")) beginTitleEdit();
        else if (editor === $("detail-content-editor")) beginContentEdit();
        else if (editor === $("detail-negative-editor")) beginNegativeEdit();
        else beginNoteEdit();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        saveDetailEdits();
      }
    });
  });
  document.querySelectorAll("#detail-inspector .inspector-send-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.selected) sendByKey(state.selected.key, button.dataset.slot, button);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (state.operatingItems || state.parsingImport || state.importingPrompts || state.generationBatchRunning) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      hideFolderContextMenu();
      if (!$("confirm-modal").hidden) closeConfirmModal(false);
      else if (!$("operation-modal").hidden) closeOperationModal();
      else if (!$("folder-create-modal").hidden) closeFolderCreateModal();
      else if (!$("generation-settings-modal").hidden) closeGenerationSettings();
      else if (!$("generation-confirm-modal").hidden) closeGenerationConfirm();
      else if (!$("generation-batch-modal").hidden) closeGenerationBatchModal();
      else if (!$("import-prompts-modal").hidden) closeImportPromptsModal();
      else if (!$("add-prompt-modal").hidden) closeAddPromptModal();
      else if (!$("detail-modal").hidden) closeDetailModal();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      if (!$("generation-settings-modal").hidden || !$("generation-confirm-modal").hidden || !$("generation-batch-modal").hidden || !$("add-prompt-modal").hidden || !$("import-prompts-modal").hidden || !$("folder-create-modal").hidden || !$("operation-modal").hidden || !$("confirm-modal").hidden || !$("detail-modal").hidden) return;
      event.preventDefault();
      $("search").focus();
      $("search").select();
    }
  });
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver(
    (entries) => {
      if (state.hasMore && entries.some((entry) => entry.isIntersecting)) loadNextPage();
    },
    {
      root: $("library-pane"),
      rootMargin: "260px 0px",
      threshold: 0,
    }
  );
  observer.observe($("list-sentinel"));
}

async function init() {
  applySidebarState();
  installInspectorSendIcons();
  applyViewMode(false);
  updateSendModeButton();
  $("sort-select").value = state.sortMode;
  await loadLibraryFavorites();
  updateFavoriteFilterButton();
  updateBatchModeButton();
  setupEventHandlers();
  setupImageDropZone();
  setupCreateImageDropZone();
  setupImportPromptDropZone();
  setupInfiniteScroll();
  updateRecursiveButton();
  clearInspector();
  await loadTree();
  await resetAndLoadList();
}

init().catch((error) => {
  console.error("[4A-PM] initialization failed", error);
  showListError(error, true);
  updateResultSummary(false);
});
