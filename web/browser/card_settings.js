/** Sparse generation-settings helpers for JSON prompt cards. */

export const PARAMETER_FIELD_KEYS = Object.freeze([
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "denoise",
  "width",
  "height",
]);

export const DOUBLE_SAMPLE_FIELD_KEYS = Object.freeze([
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "denoise",
]);

export const RATIO_PRESETS = Object.freeze([
  ["1:1 方形", 1, 1],
  ["4:3 横图", 4, 3],
  ["3:4 竖图", 3, 4],
  ["3:2 横图", 3, 2],
  ["2:3 竖图", 2, 3],
  ["16:9 横图", 16, 9],
  ["9:16 竖图", 9, 16],
  ["5:4 横图", 5, 4],
  ["4:5 竖图", 4, 5],
]);

export function emptyCardSettings() {
  return {
    models: [],
    parameters: {},
    double_sample_parameters: {},
  };
}

export function cloneCardSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    models: Array.isArray(source.models)
      ? source.models.map((entry) => ({ ...entry }))
      : [],
    parameters: source.parameters && typeof source.parameters === "object"
      ? { ...source.parameters }
      : {},
    double_sample_parameters: source.double_sample_parameters
      && typeof source.double_sample_parameters === "object"
      ? { ...source.double_sample_parameters }
      : {},
  };
}

/** Persistable models only: type/name/hash/version (strips display-only fields). */
export function persistableModels(models) {
  if (!Array.isArray(models)) return [];
  const result = [];
  const seenTypes = new Set();
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const type = String(entry.type || "").trim();
    const name = String(entry.name || "").trim();
    if (!type || !name) continue;
    const typeKey = type.toLowerCase();
    if (seenTypes.has(typeKey)) continue;
    seenTypes.add(typeKey);
    const item = { type, name };
    const hash = String(entry.hash || "").trim();
    if (hash) item.hash = hash;
    const versionId = String(entry.model_version_id || "").trim();
    if (versionId) item.model_version_id = versionId;
    result.push(item);
  }
  return result;
}

export function settingsNonempty(settings) {
  const value = cloneCardSettings(settings);
  return Boolean(
    value.models.length
    || Object.keys(value.parameters).length
    || Object.keys(value.double_sample_parameters).length,
  );
}

function orderedFields(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null || source[key] === "") continue;
    result[key] = source[key];
  }
  return result;
}

export function settingsEqual(left, right) {
  const a = cloneCardSettings(left);
  const b = cloneCardSettings(right);
  return JSON.stringify({
    models: persistableModels(a.models),
    parameters: orderedFields(a.parameters, PARAMETER_FIELD_KEYS),
    double_sample_parameters: orderedFields(a.double_sample_parameters, DOUBLE_SAMPLE_FIELD_KEYS),
  }) === JSON.stringify({
    models: persistableModels(b.models),
    parameters: orderedFields(b.parameters, PARAMETER_FIELD_KEYS),
    double_sample_parameters: orderedFields(b.double_sample_parameters, DOUBLE_SAMPLE_FIELD_KEYS),
  });
}

function roundDimension(value) {
  const number = Math.round(Number(value) / 8) * 8;
  return Number.isFinite(number) ? Math.max(8, number) : null;
}

export function dimensionsFromRatio(ratioName, longestSide = 1536) {
  const preset = RATIO_PRESETS.find(([name]) => name === ratioName);
  const longest = roundDimension(longestSide) ?? 1536;
  if (!preset) return null;
  const [, left, right] = preset;
  if (left >= right) {
    return {
      width: longest,
      height: roundDimension(longest * right / left),
    };
  }
  return {
    width: roundDimension(longest * left / right),
    height: longest,
  };
}

export function settingsFromPromptDocument(documentData) {
  const settings = emptyCardSettings();
  if (!documentData || typeof documentData !== "object") return settings;
  if (Array.isArray(documentData.models)) {
    settings.models = persistableModels(documentData.models);
  }
  const parameters = documentData.parameters && typeof documentData.parameters === "object"
    ? documentData.parameters
    : {};
  for (const key of PARAMETER_FIELD_KEYS) {
    if (parameters[key] === undefined || parameters[key] === null || parameters[key] === "") {
      continue;
    }
    settings.parameters[key] = parameters[key];
  }
  const dims = documentData.image_dimensions;
  if (
    settings.parameters.width == null
    && settings.parameters.height == null
    && dims
    && Number(dims.width) > 0
    && Number(dims.height) > 0
  ) {
    settings.parameters.width = Math.trunc(Number(dims.width));
    settings.parameters.height = Math.trunc(Number(dims.height));
  }
  const doubleSample = documentData.double_sample_parameters
    && typeof documentData.double_sample_parameters === "object"
    ? documentData.double_sample_parameters
    : {};
  for (const key of DOUBLE_SAMPLE_FIELD_KEYS) {
    if (doubleSample[key] === undefined || doubleSample[key] === null || doubleSample[key] === "") {
      continue;
    }
    settings.double_sample_parameters[key] = doubleSample[key];
  }
  // Most images omit denoise; txt2img default is 1. Only fill when there is
  // no second-pass block (which would own its own denoise).
  if (
    !Object.keys(settings.double_sample_parameters).length
    && (settings.parameters.denoise === undefined || settings.parameters.denoise === null || settings.parameters.denoise === "")
    && Object.keys(settings.parameters).length
  ) {
    settings.parameters.denoise = 1;
  }
  return settings;
}

export function loraPayloadFromPromptDocument(documentData) {
  const loras = documentData?.loras;
  if (!loras || typeof loras !== "object") return null;
  const text = typeof loras.text === "string" ? loras.text.trim() : "";
  const hashes = Array.isArray(loras.hashes) ? loras.hashes : [];
  if (!text && !hashes.length) return null;
  return { text, hashes };
}

export function sparseParametersFromForm(root) {
  if (!root) return {};
  const result = {};
  for (const key of PARAMETER_FIELD_KEYS) {
    const input = root.querySelector(`[data-param="${key}"]`);
    if (!input) continue;
    const raw = String(input.value ?? "").trim();
    if (!raw) continue;
    if (key === "sampler" || key === "scheduler") {
      result[key] = raw;
      continue;
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    result[key] = ["seed", "steps", "width", "height"].includes(key)
      ? Math.trunc(number)
      : number;
  }
  return result;
}

export function sparseDoubleSampleFromForm(root) {
  if (!root) return {};
  const result = {};
  for (const key of DOUBLE_SAMPLE_FIELD_KEYS) {
    const input = root.querySelector(`[data-double="${key}"]`);
    if (!input) continue;
    const raw = String(input.value ?? "").trim();
    if (!raw) continue;
    if (key === "sampler" || key === "scheduler") {
      result[key] = raw;
      continue;
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    result[key] = ["seed", "steps"].includes(key) ? Math.trunc(number) : number;
  }
  return result;
}

function setFormControlValue(input, value) {
  if (!input) return;
  const next = value == null ? "" : String(value);
  if (input.tagName === "SELECT" && next) {
    const exists = Array.from(input.options).some((option) => option.value === next);
    if (!exists) {
      const option = document.createElement("option");
      option.value = next;
      option.textContent = next;
      input.appendChild(option);
    }
  }
  input.value = next;
}

export function fillParametersForm(root, parameters = {}) {
  if (!root) return;
  for (const key of PARAMETER_FIELD_KEYS) {
    setFormControlValue(root.querySelector(`[data-param="${key}"]`), parameters[key]);
  }
}

export function fillDoubleSampleForm(root, parameters = {}) {
  if (!root) return;
  const source = parameters && typeof parameters === "object" ? parameters : {};
  for (const key of DOUBLE_SAMPLE_FIELD_KEYS) {
    setFormControlValue(root.querySelector(`[data-double="${key}"]`), source[key]);
  }
}

const modelLocalNameCache = new Map();

function shortModelHash(hash) {
  const value = String(hash || "").trim();
  if (!value) return "";
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

function modelStemFromValue(value) {
  const base = String(value || "").replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
}

function hashFullyMatches(cardHash, matchedHash) {
  const wanted = String(cardHash || "").trim().toLowerCase();
  const full = String(matchedHash || "").trim().toLowerCase();
  if (!wanted || !full) return false;
  if (wanted.length >= 64) return wanted === full;
  return full.startsWith(wanted) || wanted.startsWith(full);
}

async function resolveModelRequest(payload) {
  const response = await fetch("/pm4a/api/model/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    return null;
  }
  if (!response.ok || !data?.success || !data?.value) return null;
  return data;
}

async function resolveModelByHash(widgetName, hash) {
  return resolveModelRequest({
    widget_name: widgetName,
    // Empty name forces hash-only matching for display remap / import align.
    name: "",
    hash,
    model_version_id: "",
  });
}

function applyResolvedModel(next, resolved, previousHash = "") {
  if (!resolved?.value) return next;
  const localName = modelStemFromValue(resolved.value);
  if (localName) next.name = localName;
  const digest = String(resolved.matched_hash || "").trim().toLowerCase();
  if (digest) {
    next.hash = digest;
    modelLocalNameCache.set(digest, localName || next.name);
    if (previousHash && previousHash !== digest) {
      modelLocalNameCache.set(previousHash, localName || next.name);
    }
  }
  return next;
}

async function resolveModelByHashAny(hash) {
  if (String(hash || "").trim().length < 8) return null;
  for (const widgetName of ["unet_name", "ckpt_name"]) {
    const data = await resolveModelByHash(widgetName, hash);
    if (!data || data.match !== "hash") continue;
    if (!hashFullyMatches(hash, data.matched_hash)) continue;
    return data;
  }
  return null;
}

async function resolveModelByNameOrVersion(name, hash, versionId) {
  for (const widgetName of ["unet_name", "ckpt_name"]) {
    const data = await resolveModelRequest({
      widget_name: widgetName,
      name: name || "",
      hash: hash || "",
      model_version_id: versionId || "",
    });
    if (data?.value) return data;
  }
  return null;
}

/**
 * Rewrite card models to local filename + full sha256 when uniquely resolvable.
 * Hash present → only hash match may rewrite (no name fallback).
 * No hash → name / version match may rewrite.
 */
export async function alignModelsToLocal(models) {
  const source = Array.isArray(models) ? models : [];
  const aligned = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const next = {
      type: String(entry.type || "").trim(),
      name: String(entry.name || "").trim(),
    };
    const hash = String(entry.hash || "").trim().toLowerCase();
    const versionId = String(entry.model_version_id || "").trim();
    if (hash) next.hash = hash;
    if (versionId) next.model_version_id = versionId;
    if (!next.type || !next.name) continue;

    if (hash.length >= 8) {
      const resolved = await resolveModelByHashAny(hash);
      if (resolved) applyResolvedModel(next, resolved, hash);
      aligned.push(next);
      continue;
    }

    const resolved = await resolveModelByNameOrVersion(next.name, "", versionId);
    if (resolved) applyResolvedModel(next, resolved);
    aligned.push(next);
  }
  return persistableModels(aligned);
}

/** Resolve local file stem by sha256; cached, display-only (never persisted). */
export async function resolveLocalModelDisplayName(entry) {
  const existing = String(entry?.localName || "").trim();
  if (existing) return existing;
  const hash = String(entry?.hash || "").trim().toLowerCase();
  if (hash.length < 8) return "";
  if (modelLocalNameCache.has(hash)) return modelLocalNameCache.get(hash) || "";
  let localName = "";
  try {
    const data = await resolveModelByHashAny(hash);
    localName = data ? modelStemFromValue(data.value) : "";
  } catch (_) {
    localName = "";
  }
  modelLocalNameCache.set(hash, localName);
  return localName;
}

export function formatModelEntryLabel(entry) {
  const type = String(entry?.type || "").trim();
  const display = String(entry?.localName || entry?.name || "").trim();
  return type ? `${type}: ${display}` : display;
}

export function formatModelEntryMeta(entry) {
  return shortModelHash(entry?.hash) || String(entry?.hash || "").trim();
}

export function renderModelsList(listElement, models, { onRemove, t }) {
  if (!listElement) return;
  listElement.replaceChildren();
  for (const [index, entry] of models.entries()) {
    const row = document.createElement("div");
    row.className = "detail-lora-item";
    const tag = document.createElement("div");
    tag.className = "detail-lora-tag";
    tag.textContent = formatModelEntryLabel(entry);
    const storedName = String(entry?.name || "").trim();
    if (entry.localName && entry.localName !== storedName) {
      tag.title = storedName;
    }
    const meta = document.createElement("div");
    meta.className = "detail-lora-meta";
    meta.textContent = formatModelEntryMeta(entry);
    if (entry.hash && !entry.localName) {
      void resolveLocalModelDisplayName(entry).then((localName) => {
        if (!localName || !tag.isConnected) return;
        models[index] = { ...models[index], localName };
        tag.textContent = formatModelEntryLabel(models[index]);
        if (localName !== storedName) tag.title = storedName;
      });
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "detail-edit-button";
    remove.title = t("删除模型");
    remove.setAttribute("aria-label", remove.title);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>';
    remove.addEventListener("click", () => onRemove?.(index));
    row.append(tag, meta, remove);
    listElement.appendChild(row);
  }
}
