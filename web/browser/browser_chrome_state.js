/**
 * Prompt-manager browser chrome: folder, view, and send-mode memory.
 * Scoped per Comfy workflow when a host window is present.
 */

export const SORT_MODES = new Set(["path:asc", "path:desc", "name:asc", "name:desc"]);

export const LEGACY_CHROME_KEYS = {
  recursive: "pm4a_browser_recursive",
  sidebarOpen: "pm4a_browser_sidebar_open",
  viewMode: "pm4a_browser_view_mode",
  browserMode: "pm4a_browser_mode",
  sortMode: "pm4a_browser_sort_mode",
  sendMode: "pm4a_browser_send_mode",
  expanded: "pm4a_browser_expanded",
  prefix: "pm4a_browser_prefix",
};

export const WORKFLOW_STORE_KEY = "pm4a_browser_by_workflow";
export const ACTIVE_WORKFLOW_KEY = "pm4a_browser_active_key";
export const STANDALONE_WORKFLOW_KEY = "standalone";
export const UNSAVED_WORKFLOW_KEY = "unsaved";

export function defaultChromeState() {
  return {
    prefix: "",
    recursive: true,
    sidebarOpen: true,
    viewMode: "list",
    browserMode: "comfy",
    sortMode: "path:asc",
    sendMode: "append",
    expanded: [],
  };
}

export function normalizeChromeState(raw) {
  const defaults = defaultChromeState();
  const source = raw && typeof raw === "object" ? raw : {};
  const expanded = Array.isArray(source.expanded)
    ? source.expanded.filter((path) => typeof path === "string" && path)
    : [];
  return {
    prefix: typeof source.prefix === "string" ? source.prefix : defaults.prefix,
    recursive: source.recursive === undefined ? defaults.recursive : Boolean(source.recursive),
    sidebarOpen: source.sidebarOpen === undefined
      ? defaults.sidebarOpen
      : Boolean(source.sidebarOpen),
    viewMode: source.viewMode === "cards" ? "cards" : "list",
    browserMode: source.browserMode === "nai" ? "nai" : "comfy",
    sortMode: SORT_MODES.has(source.sortMode) ? source.sortMode : defaults.sortMode,
    sendMode: source.sendMode === "replace" ? "replace" : "append",
    expanded,
  };
}

export function normalizeWorkflowKey(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  return text ? text.toLowerCase() : STANDALONE_WORKFLOW_KEY;
}

function unwrapMaybeRef(value) {
  if (
    value
    && typeof value === "object"
    && "value" in value
    && value.path == null
    && value.filename == null
    && value.key == null
  ) {
    return value.value;
  }
  return value;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return `graph:${value}`;
  }
  return "";
}

export function resolveWorkflowKey(source = {}) {
  const workflow = unwrapMaybeRef(source.activeWorkflow);
  const record = workflow && typeof workflow === "object" ? workflow : {};
  const key = firstNonEmptyString([
    record.path,
    record.filename,
    record.key,
    record.name,
    source.graphId,
  ]);
  if (key) return normalizeWorkflowKey(key);
  return source.embedded ? UNSAVED_WORKFLOW_KEY : STANDALONE_WORKFLOW_KEY;
}

export function readComfyWorkflowSource(hostWindow) {
  if (!hostWindow) {
    return { embedded: false, activeWorkflow: {}, graphId: "" };
  }
  const app = hostWindow.app || hostWindow.comfyAPI?.app?.app || null;
  if (!app) {
    return { embedded: false, activeWorkflow: {}, graphId: "" };
  }
  const workflowApi = app.extensionManager?.workflow;
  const active = unwrapMaybeRef(workflowApi?.activeWorkflow);
  const graph = app.canvas?.getCurrentGraph?.() || app.graph || app.canvas?.graph;
  return {
    embedded: true,
    activeWorkflow: active && typeof active === "object" ? active : {},
    graphId: graph?.id ?? graph?.rootGraph?.id ?? "",
  };
}

function readStorageItem(storage, key) {
  try {
    return storage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStorageItem(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (_) {
    // Storage may be unavailable in hardened browser environments.
  }
}

export function readLegacyChromeState(storage) {
  const expandedRaw = readStorageItem(storage, LEGACY_CHROME_KEYS.expanded);
  let expanded = [];
  try {
    const parsed = expandedRaw ? JSON.parse(expandedRaw) : [];
    if (Array.isArray(parsed)) {
      expanded = parsed.filter((path) => typeof path === "string" && path);
    }
  } catch (_) {
    expanded = [];
  }
  const recursiveRaw = readStorageItem(storage, LEGACY_CHROME_KEYS.recursive);
  const sidebarRaw = readStorageItem(storage, LEGACY_CHROME_KEYS.sidebarOpen);
  return normalizeChromeState({
    prefix: readStorageItem(storage, LEGACY_CHROME_KEYS.prefix) || "",
    recursive: recursiveRaw === null ? true : recursiveRaw === "true",
    sidebarOpen: sidebarRaw === null ? true : sidebarRaw !== "false",
    viewMode: readStorageItem(storage, LEGACY_CHROME_KEYS.viewMode) || "list",
    browserMode: readStorageItem(storage, LEGACY_CHROME_KEYS.browserMode) || "comfy",
    sortMode: readStorageItem(storage, LEGACY_CHROME_KEYS.sortMode) || "path:asc",
    sendMode: readStorageItem(storage, LEGACY_CHROME_KEYS.sendMode) || "append",
    expanded,
  });
}

export function readWorkflowStore(storage) {
  try {
    const parsed = JSON.parse(readStorageItem(storage, WORKFLOW_STORE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function loadChromeState(storage, workflowKey) {
  const key = normalizeWorkflowKey(workflowKey);
  const stored = readWorkflowStore(storage)[key];
  if (stored) return normalizeChromeState(stored);
  return readLegacyChromeState(storage);
}

export function saveChromeState(storage, workflowKey, chrome) {
  const key = normalizeWorkflowKey(workflowKey);
  const next = normalizeChromeState(chrome);
  const store = readWorkflowStore(storage);
  store[key] = next;
  writeStorageItem(storage, WORKFLOW_STORE_KEY, JSON.stringify(store));
  writeStorageItem(storage, ACTIVE_WORKFLOW_KEY, key);
  writeStorageItem(storage, LEGACY_CHROME_KEYS.sidebarOpen, String(next.sidebarOpen));
  return next;
}
