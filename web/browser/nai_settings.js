/** Sparse NovelAI card settings and Browser mode helpers. */

import { normalizeNaiCharacters } from "./nai_characters.js";

export const NAI_PARAMETER_FIELD_KEYS = Object.freeze([
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "cfg_rescale",
  "width",
  "height",
]);

const NAI_INTEGER_FIELDS = new Set(["steps", "width", "height"]);
const NAI_STRING_FIELDS = new Set(["sampler", "scheduler"]);

export function emptyNaiSettings() {
  return {};
}

export function appendNaiCharacterLines(base, characters, key) {
  const lines = [String(base || "").trim()];
  const list = Array.isArray(characters) ? characters : [];
  list.forEach((character, index) => {
    const text = typeof character?.[key] === "string" ? character[key].trim() : "";
    if (text) lines.push(`char${index + 1}: ${text}`);
  });
  return lines.filter(Boolean).join("\n");
}

export function naiTextForComfyField(entry, field = "content") {
  const nai = entry?.nai && typeof entry.nai === "object" && !Array.isArray(entry.nai)
    ? entry.nai
    : {};
  const textKey = field === "negative" ? "negative" : "content";
  const characterKey = field === "negative" ? "negative" : "positive";
  return appendNaiCharacterLines(nai[textKey], nai.characters, characterKey);
}

export function flattenNovelAIForComfyMode(documentData, texts = {}) {
  const positive = String(texts.positive || "").trim();
  const negative = String(texts.negative || "").trim();
  if (documentData?.source_type !== "novelai" || !Array.isArray(documentData.characters)) {
    return { positive, negative };
  }
  return {
    positive: appendNaiCharacterLines(positive, documentData.characters, "positive"),
    negative: appendNaiCharacterLines(negative, documentData.characters, "negative"),
  };
}

function normalizedBoolean(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function normalizedNumber(value, integer) {
  if (
    value === ""
    || value === null
    || value === undefined
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
  ) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return integer ? Math.trunc(number) : number;
}

export function normalizeNaiSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  const content = typeof source.content === "string" ? source.content.trim() : "";
  const negative = typeof source.negative === "string" ? source.negative.trim() : "";
  if (content) result.content = content;
  if (negative) result.negative = negative;
  const sourceParameters = source.parameters
    && typeof source.parameters === "object"
    && !Array.isArray(source.parameters)
    ? source.parameters
    : {};
  const parameters = {};
  for (const key of NAI_PARAMETER_FIELD_KEYS) {
    const raw = sourceParameters[key];
    if (NAI_STRING_FIELDS.has(key)) {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text) parameters[key] = text;
      continue;
    }
    const number = normalizedNumber(raw, NAI_INTEGER_FIELDS.has(key));
    if (number !== undefined) parameters[key] = number;
  }
  if (Object.keys(parameters).length) result.parameters = parameters;
  const characters = normalizeNaiCharacters(source.characters);
  if (characters.length) result.characters = characters;
  return result;
}

export function cloneNaiSettings(value) {
  const normalized = normalizeNaiSettings(value);
  return {
    ...normalized,
    ...(normalized.parameters ? { parameters: { ...normalized.parameters } } : {}),
    ...(normalized.characters
      ? { characters: normalized.characters.map((character) => ({ ...character })) }
      : {}),
  };
}

export function naiSettingsEqual(left, right) {
  return JSON.stringify(normalizeNaiSettings(left)) === JSON.stringify(normalizeNaiSettings(right));
}

function formControl(root, key) {
  return root?.querySelector?.(`[data-nai-param="${key}"]`) || null;
}

function ensureCurrentSelectOption(control, value, documentLike) {
  if (!control || control.tagName !== "SELECT" || !value) return;
  const options = Array.from(control.options || []);
  if (options.some((option) => option.value === value)) return;
  const owner = documentLike || control.ownerDocument || globalThis.document;
  if (!owner?.createElement) return;
  const option = owner.createElement("option");
  option.value = value;
  option.textContent = value;
  control.appendChild(option);
}

function setFormControlValue(control, value, documentLike) {
  if (!control) return;
  const next = value === null || value === undefined ? "" : String(value);
  ensureCurrentSelectOption(control, next, documentLike);
  control.value = next;
}

export function readNaiForm(root) {
  if (!root) return emptyNaiSettings();
  const source = { parameters: {} };
  for (const key of NAI_PARAMETER_FIELD_KEYS) {
    const control = formControl(root, key);
    if (!control) continue;
    source.parameters[key] = control.value;
  }
  return normalizeNaiSettings(source);
}

export function fillNaiForm(root, value = {}) {
  if (!root) return;
  const normalized = normalizeNaiSettings(value);
  for (const key of NAI_PARAMETER_FIELD_KEYS) {
    setFormControlValue(formControl(root, key), normalized.parameters?.[key]);
  }
}

export function sourceResolutionFromParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
  const width = Number(parameters.width);
  const height = Number(parameters.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return { width: Math.trunc(width), height: Math.trunc(height) };
}

export function setChoiceOptions(control, choices, currentValue = "", documentLike) {
  if (!control) return;
  const values = [];
  const seen = new Set();
  for (const value of ["", ...(Array.isArray(choices) ? choices : []), currentValue]) {
    const text = String(value ?? "").trim();
    if (seen.has(text)) continue;
    seen.add(text);
    values.push(text);
  }
  const owner = documentLike || control.ownerDocument || globalThis.document;
  if (!owner?.createElement) {
    control.value = String(currentValue ?? "");
    return;
  }
  const options = values.map((value) => {
    const option = owner.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  });
  control.replaceChildren(...options);
  control.value = String(currentValue ?? "").trim();
}

export function readObjectInfoChoices(data, nodeName, fields) {
  const required = data?.[nodeName]?.input?.required;
  if (!required || typeof required !== "object") return {};
  const result = {};
  for (const field of fields || []) {
    const definition = required[field];
    const choices = Array.isArray(definition) ? definition[0] : null;
    if (!Array.isArray(choices)) continue;
    const values = [...new Set(
      choices
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    )];
    if (values.length) result[field] = values;
  }
  return result;
}

export function normalizeBrowserMode(value) {
  return value === "nai" ? "nai" : "comfy";
}

export function shouldConvertDetail(mode, entry, field = "content") {
  if (!entry) return false;
  if (entry.type === "folder" || entry.format !== "json_card") return false;
  if (normalizeBrowserMode(mode) === "nai") {
    return !String(entry?.nai?.[field] || "").trim() && Boolean(String(entry?.[field] || "").trim());
  }
  return !String(entry?.[field] || "").trim() && Boolean(naiTextForComfyField(entry, field).trim());
}

export function browserModeVisibility(mode, isTxt = false) {
  const nai = normalizeBrowserMode(mode) === "nai";
  return {
    comfyLora: !nai && !isTxt,
    comfySettings: !nai && !isTxt,
    comfyApply: !nai,
    naiSettings: nai && !isTxt,
  };
}

export function naiSavePatch(entry, draft) {
  if (entry?.format === "txt_wildcard") return {};
  const next = normalizeNaiSettings(draft);
  return naiSettingsEqual(next, entry?.nai || {}) ? {} : { nai: next };
}

function preferNonblankText(primary, fallback) {
  const native = String(primary ?? "");
  return native.trim() ? native : String(fallback ?? "");
}

export function rawTextForNaiSlot(entry, slot, targetMode = "nai") {
  const naiMode = normalizeBrowserMode(targetMode) === "nai";
  if (slot === "negative") {
    return preferNonblankText(
      naiMode ? entry?.nai?.negative : entry?.negative,
      naiMode ? entry?.negative : naiTextForComfyField(entry, "negative"),
    );
  }
  if (entry?.type === "folder" || entry?.format === "txt_wildcard") {
    return String(entry?.wildcard_syntax || (entry?.key ? `__${entry.key}__` : ""));
  }
  return preferNonblankText(
    naiMode ? entry?.nai?.content : entry?.content,
    naiMode ? entry?.content : naiTextForComfyField(entry, "content"),
  );
}

export function buildNaiSlotRequest(
  entry,
  slot,
  mode,
  value = undefined,
  targetMode = "nai",
) {
  return {
    route: "/pm4a/api/nai/append-slot",
    body: {
      slot,
      value: value === undefined
        ? rawTextForNaiSlot(entry, slot, targetMode)
        : String(value),
      mode: mode === "replace" ? "replace" : "append",
    },
  };
}

export function buildNaiDocument(rawContent, rawNegative, rawCharacters = []) {
  const positive = String(rawContent ?? "");
  const negative = String(rawNegative ?? "");
  const characters = normalizeNaiCharacters(rawCharacters).map((character, index) => {
    const positioned = Number.isFinite(character.x) && Number.isFinite(character.y);
    return {
      id: `char-${index + 1}`,
      name: `角色 ${index + 1}`,
      enabled: true,
      positive: character.positive,
      negative: character.negative,
      mode: "sequence",
      use_position: positioned,
      ...(positioned ? { x: character.x, y: character.y } : {}),
      use_order: true,
    };
  });
  return {
    tracks: [{ id: "positive", name: "正面", text: positive }],
    positive,
    negative,
    characters,
  };
}

export function conversionEndpointForMode(mode) {
  return normalizeBrowserMode(mode) === "nai"
    ? "/pm4a/api/convert/anima-to-nai"
    : "/pm4a/api/convert/nai-to-anima";
}

export async function convertTextsForAction(request, mode, texts, entry, fields = null) {
  const raw = Array.isArray(texts) ? texts.map((text) => String(text ?? "")) : [];
  const requestedFields = Array.isArray(fields) && fields.length === raw.length
    ? fields
    : raw.map(() => "content");
  const convertIndexes = requestedFields
    .map((field, index) => shouldConvertDetail(mode, entry, field) ? index : -1)
    .filter((index) => index >= 0);
  if (!convertIndexes.length) {
    return { texts: raw, error: null, skipped: true };
  }
  try {
    const convertible = convertIndexes.map((index) => raw[index]);
    const data = await request(conversionEndpointForMode(mode), {
      method: "POST",
      body: JSON.stringify({ texts: convertible }),
    });
    if (!Array.isArray(data?.results) || data.results.length !== convertible.length) {
      throw new Error("invalid conversion result");
    }
    const converted = [...raw];
    data.results.forEach((item, resultIndex) => {
      if (!item || typeof item.text !== "string") throw new Error("invalid conversion result");
      converted[convertIndexes[resultIndex]] = item.text;
    });
    return { texts: converted, error: null, skipped: false };
  } catch (error) {
    return {
      texts: raw,
      error: error instanceof Error ? error : new Error(String(error)),
      skipped: false,
    };
  }
}

function nativeEntryText(entry, mode, field) {
  if (normalizeBrowserMode(mode) === "nai") {
    return String(entry?.nai?.[field] || "");
  }
  return String(entry?.[field] || "");
}

function fallbackEntryText(entry, mode, field) {
  if (normalizeBrowserMode(mode) === "nai") {
    return String(entry?.[field] || "");
  }
  return naiTextForComfyField(entry, field);
}

function draftFieldState(draft, field) {
  if (field === "negative") {
    return {
      dirty: Boolean(draft?.negativeDirty),
      text: String(draft?.negative ?? ""),
    };
  }
  return {
    dirty: Boolean(draft?.contentDirty),
    text: String(draft?.content ?? ""),
  };
}

export function promptFieldProvenance(entry, mode, field, draft = null) {
  const normalizedMode = normalizeBrowserMode(mode);
  const otherMode = normalizedMode === "nai" ? "comfy" : "nai";
  if (!entry || entry.type === "folder" || entry.format === "txt_wildcard") {
    return { source: "native", origin: null };
  }
  const native = nativeEntryText(entry, normalizedMode, field);
  const other = fallbackEntryText(entry, normalizedMode, field);
  const { dirty, text } = draftFieldState(draft, field);
  if (dirty) {
    if (text.trim()) {
      return native.trim()
        ? { source: "native", origin: null }
        : { source: "draft-native", origin: other.trim() ? otherMode : null };
    }
    return { source: "empty", origin: null };
  }
  if (native.trim()) return { source: "native", origin: null };
  if (other.trim()) return { source: "converted", origin: otherMode };
  return { source: "empty", origin: null };
}

export function promptFieldSourceDisplay(provenance, translate = (key) => key) {
  const source = provenance?.source || "empty";
  if (source === "native") {
    return {
      source,
      label: translate("原生"),
      title: translate("JSON 里保存了当前模式的独立提示词"),
    };
  }
  if (source === "converted") {
    return {
      source,
      label: provenance.origin === "nai"
        ? translate("由 NAI 转换")
        : translate("由 Comfy 转换"),
      title: translate("当前模式没有独立提示词，正在显示从另一侧转换的预览"),
    };
  }
  if (source === "draft-native") {
    return {
      source,
      label: translate("将保存为独立提示词"),
      title: translate("保存后会写入当前模式的独立提示词"),
    };
  }
  return { source: "empty", label: "", title: "" };
}

export async function resolveEntryTextsForMode(
  request,
  entry,
  mode,
  fields = ["content", "negative"],
) {
  const normalizedMode = normalizeBrowserMode(mode);
  if (entry?.format !== "json_card" || entry?.type === "folder") {
    return {
      texts: fields.map((field) => String(entry?.[field] || "")),
      error: null,
      converted: false,
    };
  }
  const result = fields.map((field) => nativeEntryText(entry, normalizedMode, field));
  const fallbackIndexes = [];
  const fallbackTexts = [];
  fields.forEach((field, index) => {
    if (result[index].trim()) return;
    const fallback = fallbackEntryText(entry, normalizedMode, field);
    if (!fallback.trim()) return;
    fallbackIndexes.push(index);
    fallbackTexts.push(fallback);
  });
  if (!fallbackTexts.length) {
    return { texts: result, error: null, converted: false };
  }
  try {
    const data = await request(conversionEndpointForMode(normalizedMode), {
      method: "POST",
      body: JSON.stringify({ texts: fallbackTexts }),
    });
    if (!Array.isArray(data?.results) || data.results.length !== fallbackTexts.length) {
      throw new Error("invalid conversion result");
    }
    data.results.forEach((item, index) => {
      if (!item || typeof item.text !== "string") throw new Error("invalid conversion result");
      result[fallbackIndexes[index]] = item.text;
    });
    return { texts: result, error: null, converted: true };
  } catch (error) {
    fallbackIndexes.forEach((targetIndex, index) => {
      result[targetIndex] = fallbackTexts[index];
    });
    return {
      texts: result,
      error: error instanceof Error ? error : new Error(String(error)),
      converted: false,
    };
  }
}
