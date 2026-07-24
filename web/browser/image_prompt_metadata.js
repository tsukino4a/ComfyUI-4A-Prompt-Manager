const SOURCE_LABELS = {
  "4a": "4A",
  novelai: "NovelAI",
  civitai: "Civitai",
  a1111: "Image Saver",
  generic: "通用",
};

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

function metadataValue(metadata, wantedKey) {
  if (!metadata || typeof metadata !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(metadata, wantedKey)) return metadata[wantedKey];
  const normalized = wantedKey.toLowerCase();
  const key = Object.keys(metadata).find((candidate) => candidate.toLowerCase() === normalized);
  return key === undefined ? undefined : metadata[key];
}

function metadataStrings(metadata, keys) {
  const values = [];
  const seen = new Set();
  for (const key of keys) {
    const value = firstString(metadataValue(metadata, key));
    if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

const GENERATION_TEXT_KEYS = [
  "parameters",
  "UserComment",
  "Comment",
  "Description",
  "ImageDescription",
];

function looksLikeGenerationText(value) {
  return /(?:^|[\r\n,.!?。！？])\s*(?:Negative prompt|Steps|Sampler|CFG scale|Seed|Size)\s*:/i
    .test(value);
}

function generationParameterText(metadata) {
  for (const [index, value] of metadataStrings(metadata, GENERATION_TEXT_KEYS).entries()) {
    if (index === 0 && firstString(metadataValue(metadata, "parameters")) === value) return value;
    if (looksLikeGenerationText(value)) return value;
  }
  return "";
}

function parseJsonValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** ComfyUI PNG "prompt" is the API graph ({ id: { class_type, inputs } }), not a caption. */
function looksLikeComfyApiPrompt(value) {
  const obj = typeof value === "string" ? parseJsonValue(value) : value;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let classTypeCount = 0;
  for (const entry of Object.values(obj)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.class_type !== "string" || !entry.class_type.trim()) continue;
    classTypeCount += 1;
    if (entry.inputs && typeof entry.inputs === "object") return true;
  }
  return classTypeCount >= 2;
}

/** ComfyUI PNG "workflow" is the LiteGraph UI graph (nodes/links), not a caption. */
function looksLikeComfyWorkflow(value) {
  const obj = typeof value === "string" ? parseJsonValue(value) : value;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.nodes) || !obj.nodes.length) return false;
  return obj.nodes.some((node) => (
    node
    && typeof node === "object"
    && (typeof node.type === "string" || typeof node.class_type === "string")
  ));
}

function looksLikeComfyEmbeddedGraph(value) {
  if (value == null) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
    return looksLikeComfyApiPrompt(trimmed) || looksLikeComfyWorkflow(trimmed);
  }
  return looksLikeComfyApiPrompt(value) || looksLikeComfyWorkflow(value);
}

/**
 * Drop Comfy embedded graph blobs from the "raw metadata" view/snapshot.
 * Parsing still runs on the full extract; this is only what we persist/show.
 */
export function sanitizeRawMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Comfy embed-workflow fields: never show/persist. Real captions use
    // parameters / pm4a_prompt_json / positive / description, etc.
    const lower = key.toLowerCase();
    if (lower === "workflow" || lower === "prompt") continue;
    if (looksLikeComfyEmbeddedGraph(value)) continue;
    out[key] = value;
  }
  return out;
}

const JSON_NUMBER_SOURCE = "-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";
const JSON_NUMBER_AT_START = new RegExp(`^${JSON_NUMBER_SOURCE}`);
const RAW_JSON_NUMBER_PREFIX = "\u0000pm4a_raw_number:";
let rawJsonNumberNonce = 0;

function rawJsonNumberPrefix(metadata) {
  const serialized = JSON.stringify(metadata) || "";
  let prefix;
  do {
    rawJsonNumberNonce += 1;
    const nonce = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${rawJsonNumberNonce.toString(36)}-${Math.random().toString(36).slice(2)}`;
    prefix = `${RAW_JSON_NUMBER_PREFIX}${nonce}:`;
  } while (serialized.includes(JSON.stringify(prefix).slice(1, -1)));
  return prefix;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function protectJsonNumbers(text, rawNumberPrefix) {
  let protectedText = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const char = text[index];
        index += 1;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') break;
      }
      protectedText += text.slice(start, index);
      continue;
    }
    const number = text.slice(index).match(JSON_NUMBER_AT_START)?.[0];
    if (number) {
      protectedText += JSON.stringify(`${rawNumberPrefix}${number}`);
      index += number.length;
      continue;
    }
    protectedText += text[index];
    index += 1;
  }
  return protectedText;
}

function expandMetadataJson(value, rawNumberPrefix, depth = 0) {
  if (depth >= 64) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => expandMetadataJson(entry, rawNumberPrefix, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [
          key,
          expandMetadataJson(entry, rawNumberPrefix, depth + 1),
        ]),
    );
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try {
    return expandMetadataJson(
      JSON.parse(protectJsonNumbers(text, rawNumberPrefix)),
      rawNumberPrefix,
      depth + 1,
    );
  } catch (_) {
    return value;
  }
}

export function formatRawMetadataJson(metadata) {
  const cleaned = sanitizeRawMetadata(metadata);
  const rawNumberPrefix = rawJsonNumberPrefix(cleaned);
  const value = expandMetadataJson(cleaned, rawNumberPrefix);
  const serializedPrefix = escapeRegExp(
    JSON.stringify(rawNumberPrefix).slice(1, -1),
  );
  const rawNumber = new RegExp(
    `"${serializedPrefix}(${JSON_NUMBER_SOURCE})"`,
    "g",
  );
  return JSON.stringify(value, null, 2)
    .replace(rawNumber, "$1");
}

function embeddedJsonObjects(value) {
  const text = firstString(value) || "";
  const objects = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonValue(text.slice(start, end + 1));
          if (parsed) objects.push(parsed);
          break;
        }
      }
    }
  }
  return objects;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractLoraTags(...values) {
  const found = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/<lora:[^>\r\n]+>/gi)) {
      const tag = match[0].trim();
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(tag);
      }
    }
  }
  return found;
}

export function stripLoraTags(value) {
  if (typeof value !== "string") return "";
  const stripped = value
    .replace(/<lora:[^>\r\n]+>/gi, "")
    .replace(/,[ \t]*,+/g, ",")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return /[^,\s]/.test(stripped) ? stripped : "";
}

function normalizeLoraHashes(value) {
  if (!Array.isArray(value)) return [];
  const found = [];
  const seen = new Set();
  for (const entry of value) {
    const name = cleanText(entry?.name);
    const hash = cleanText(entry?.hash);
    if (!name || !hash) continue;
    const key = `${name.toLowerCase()}\u0000${hash.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name, hash });
  }
  return found;
}

function defaultLoraTags(hashes) {
  const tags = [];
  const seen = new Set();
  for (const entry of hashes) {
    const fileName = cleanText(entry?.name).replace(/\\/g, "/").split("/").pop() || "";
    const modelName = fileName
      .replace(/\.(?:safetensors|ckpt|pt|pth|bin)$/i, "")
      .trim();
    const key = modelName.toLowerCase();
    if (!modelName || seen.has(key)) continue;
    seen.add(key);
    tags.push(`<lora:${modelName}:1>`);
  }
  return tags;
}

function normalizeLoraMetadata(value, promptText = "") {
  const suppliedText = cleanText(value?.text);
  const tags = extractLoraTags(suppliedText, promptText);
  const hashes = normalizeLoraHashes(value?.hashes);
  if (!tags.length && !hashes.length) return null;
  const resolvedTags = tags.length ? tags : defaultLoraTags(hashes);
  return { text: resolvedTags.join(" "), hashes };
}

function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  // Deduplicate by type+name; prefer the longer hash (full sha256 over Autov2).
  const byIdentity = new Map();
  for (const entry of value) {
    const type = cleanText(entry?.type) || "模型";
    const name = cleanText(entry?.name);
    const hash = cleanText(entry?.hash);
    const versionId = entry?.model_version_id ?? entry?.modelVersionId ?? "";
    const modelVersionId = String(versionId ?? "").trim();
    if (!name && !hash && !modelVersionId) continue;
    const identity = `${type.toLowerCase()}\u0000${name.toLowerCase()}`;
    const item = {
      type,
      name,
      hash,
      ...(modelVersionId ? { model_version_id: modelVersionId } : {}),
    };
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, item);
      continue;
    }
    const prevHash = cleanText(previous.hash);
    const nextHash = hash;
    const preferNext = (
      nextHash.length > prevHash.length
      || (!prevHash && nextHash)
      || (!previous.model_version_id && item.model_version_id)
    );
    if (preferNext) {
      byIdentity.set(identity, {
        ...item,
        hash: nextHash.length >= prevHash.length ? nextHash : prevHash,
        ...(previous.model_version_id && !item.model_version_id
          ? { model_version_id: previous.model_version_id }
          : {}),
      });
    } else if (nextHash && prevHash.startsWith(nextHash) && nextHash.length < prevHash.length) {
      // Incoming short hash is a prefix of the kept full hash — ignore.
    } else if (nextHash && !prevHash) {
      byIdentity.set(identity, { ...previous, hash: nextHash });
    } else if (item.model_version_id && !previous.model_version_id) {
      byIdentity.set(identity, { ...previous, model_version_id: item.model_version_id });
    }
  }
  return [...byIdentity.values()].map((entry) => {
    const cleaned = { type: entry.type, name: entry.name };
    if (entry.hash) cleaned.hash = entry.hash;
    if (entry.model_version_id) cleaned.model_version_id = entry.model_version_id;
    return cleaned;
  });
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeInputParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of ["seed", "steps", "cfg", "denoise", "width", "height"]) {
    const number = finiteNumber(value[key]);
    if (number !== null) normalized[key] = number;
  }
  for (const key of ["sampler", "scheduler", "sampler_raw"]) {
    const text = cleanText(value[key]);
    if (text) normalized[key] = text;
  }
  return Object.keys(normalized).length ? normalized : null;
}

const INPUT_PARAMETERS_SCHEMA = "pm4a_input_parameters";
const INPUT_PARAMETERS_METADATA_KEYS = [
  "pm4a_generation_parameters",
  INPUT_PARAMETERS_SCHEMA,
];

function normalizeInputParametersPayload(value, allowUnmarked = false) {
  let parsed = value;
  for (let depth = 0; typeof parsed === "string" && depth < 3; depth++) {
    if (!parsed.trim()) return null;
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const marker = cleanText(parsed.schema).toLowerCase();
  if (!allowUnmarked && marker !== INPUT_PARAMETERS_SCHEMA) return null;
  const candidate = parsed.parameters && typeof parsed.parameters === "object"
    ? parsed.parameters
    : parsed;
  return normalizeInputParameters(candidate);
}

function parseInputParametersMetadata(metadata) {
  for (const key of INPUT_PARAMETERS_METADATA_KEYS) {
    const normalized = normalizeInputParametersPayload(metadataValue(metadata, key), true);
    if (normalized) return normalized;
  }
  for (const value of metadataStrings(metadata, ["pm4a_prompt_json", ...GENERATION_TEXT_KEYS])) {
    for (const candidate of embeddedJsonObjects(value)) {
      const normalized = normalizeInputParametersPayload(candidate);
      if (normalized) return normalized;
    }
  }
  return null;
}

const DOUBLE_SAMPLE_SCHEMA = "pm4a_double_sample_parameters";
const DOUBLE_SAMPLE_METADATA_KEYS = [
  DOUBLE_SAMPLE_SCHEMA,
  "double_sample_parameters",
];

function normalizeDoubleSampleParameters(value, allowUnmarked = false, depth = 0) {
  if (depth > 4) return null;
  let parsed = value;
  for (let parseDepth = 0; typeof parsed === "string" && parseDepth < 3; parseDepth++) {
    if (!parsed.trim()) return null;
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  for (const key of [DOUBLE_SAMPLE_SCHEMA, "double_sample_parameters"]) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      return normalizeDoubleSampleParameters(parsed[key], true, depth + 1);
    }
  }

  const marker = cleanText(parsed.schema).toLowerCase();
  const marked = marker === DOUBLE_SAMPLE_SCHEMA;
  if (!allowUnmarked && !marked) return null;
  const candidate = parsed.parameters && typeof parsed.parameters === "object"
    ? parsed.parameters
    : parsed;
  const normalized = normalizeInputParameters(candidate);
  if (!normalized) return null;
  delete normalized.width;
  delete normalized.height;
  return Object.keys(normalized).length ? normalized : null;
}

function parseDoubleSampleParameters(metadata) {
  for (const key of DOUBLE_SAMPLE_METADATA_KEYS) {
    const normalized = normalizeDoubleSampleParameters(metadataValue(metadata, key), true);
    if (normalized) return normalized;
  }
  const generationParameters = normalizeDoubleSampleParameters(
    metadataValue(metadata, "pm4a_generation_parameters"),
  );
  if (generationParameters) return generationParameters;
  for (const value of metadataStrings(metadata, ["pm4a_prompt_json", ...GENERATION_TEXT_KEYS])) {
    for (const candidate of embeddedJsonObjects(value)) {
      const normalized = normalizeDoubleSampleParameters(candidate);
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizeTrack(track, index) {
  return {
    id: String(track?.id || `track-${index + 1}`),
    name: String(track?.name || `栏目 ${index + 1}`),
    text: stripLoraTags(track?.text),
  };
}

function normalizeDocument(payload, fallbackSource = "4a") {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tracks)) return null;
  const sourceType = String(payload.source_type || fallbackSource);
  const parameters = normalizeInputParameters(payload.parameters);
  const doubleSampleParameters = normalizeDoubleSampleParameters(
    payload.double_sample_parameters,
    true,
  );
  const promptText = [
    typeof payload.positive === "string" ? payload.positive : "",
    ...payload.tracks.map((track) => typeof track?.text === "string" ? track.text : ""),
  ].join("\n");
  const loras = normalizeLoraMetadata(payload.loras, promptText);
  const models = normalizeModels(payload.models);
  const {
    version: _ignoredVersion,
    ...rest
  } = payload;
  return {
    ...rest,
    source_type: sourceType,
    source_label: String(payload.source_label || SOURCE_LABELS[sourceType] || sourceType),
    tracks: payload.tracks.map(normalizeTrack),
    positive: stripLoraTags(payload.positive),
    negative: typeof payload.negative === "string" ? payload.negative : "",
    parameters: parameters || undefined,
    double_sample_parameters: doubleSampleParameters || undefined,
    loras: loras || undefined,
    models: models.length ? models : undefined,
  };
}

export function parsePromptDocument(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return normalizeDocument(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

function unwrap4ADocument(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (current && typeof current === "object") {
      const normalized = normalizeDocument(current, "4a");
      if (normalized) return normalized;
      return null;
    }
    if (typeof current !== "string" || !current.trim()) return null;
    try {
      current = JSON.parse(current);
    } catch (_) {
      return null;
    }
  }
  return normalizeDocument(current, "4a");
}

function extractEmbedded4A(value) {
  const text = firstString(value) || "";
  const direct = unwrap4ADocument(text);
  if (direct) return direct;

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = unwrap4ADocument(text.slice(start, end + 1));
          if (candidate) return candidate;
          break;
        }
      }
    }
  }
  return null;
}

function parse4A(metadata) {
  for (const value of metadataStrings(metadata, ["pm4a_prompt_json", ...GENERATION_TEXT_KEYS])) {
    const document = extractEmbedded4A(value);
    if (document) return document;
  }
  return null;
}

function promptDocument(sourceType, positive, negative, parameters = null) {
  const positiveText = cleanText(positive);
  const negativeText = cleanText(negative);
  if (!positiveText && !negativeText) return null;
  return normalizeDocument({
    source_type: sourceType,
    source_label: SOURCE_LABELS[sourceType],
    tracks: positiveText ? [{ id: "positive", name: "正面", text: positiveText }] : [],
    positive: positiveText,
    negative: negativeText,
    parameters,
  }, sourceType);
}

function characterLines(base, captions) {
  const lines = [];
  const baseText = cleanText(base);
  if (baseText) lines.push(baseText);
  if (Array.isArray(captions)) {
    captions.forEach((entry, index) => {
      const text = cleanText(entry?.char_caption);
      if (text) lines.push(`char${index + 1}: ${text}`);
    });
  }
  return lines.join("\n");
}

function parseNovelAI(metadata) {
  const commentRaw = metadataValue(metadata, "Comment");
  const comment = parseJsonValue(commentRaw);
  const software = cleanText(firstString(metadataValue(metadata, "Software")));
  const source = cleanText(firstString(metadataValue(metadata, "Source")));
  const title = cleanText(firstString(metadataValue(metadata, "Title")));
  const isNovelAI = /^novelai\b/i.test(software)
    || /^novelai\b/i.test(source)
    || /^novelai generated image$/i.test(title)
    || Boolean(comment?.v4_prompt)
    || comment?.request_type === "PromptGenerateRequest";
  if (!isNovelAI) return null;

  const positiveCaption = comment?.v4_prompt?.caption;
  const negativeCaption = comment?.v4_negative_prompt?.caption;
  const positive = characterLines(
    positiveCaption?.base_caption
      ?? comment?.prompt
      ?? firstString(metadataValue(metadata, "Description")),
    positiveCaption?.char_captions,
  );
  const negative = characterLines(
    negativeCaption?.base_caption
      ?? comment?.uc
      ?? comment?.negative_prompt,
    negativeCaption?.char_captions,
  );
  return promptDocument("novelai", positive, negative);
}

const DEFAULT_A1111_SCHEDULERS = [
  "linear_quadratic",
  "bong_tangent",
  "ddim_uniform",
  "sgm_uniform",
  "exponential",
  "kl_optimal",
  "beta57",
  "karras",
  "simple",
  "normal",
  "beta",
];

const A1111_SCHEDULERS = new Set(DEFAULT_A1111_SCHEDULERS);
let sortedA1111Schedulers = [...A1111_SCHEDULERS].sort(
  (left, right) => right.length - left.length || left.localeCompare(right),
);

export function registerKnownSchedulers(values) {
  const choices = Array.isArray(values) ? values : [values];
  let changed = false;
  for (const value of choices) {
    const scheduler = cleanText(value).toLowerCase();
    if (!scheduler || A1111_SCHEDULERS.has(scheduler)) continue;
    A1111_SCHEDULERS.add(scheduler);
    changed = true;
  }
  if (changed) {
    sortedA1111Schedulers = [...A1111_SCHEDULERS].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    );
  }
  return sortedA1111Schedulers.length;
}

const A1111_SAMPLER_NAMES = new Map([
  ["euler", "euler"],
  ["euler a", "euler_ancestral"],
  ["dpm++ 2m", "dpmpp_2m"],
  ["dpm++ 2m sde", "dpmpp_2m_sde"],
  ["dpm++ 2s a", "dpmpp_2s_ancestral"],
  ["dpm++ sde", "dpmpp_sde"],
  ["dpm++ 3m sde", "dpmpp_3m_sde"],
]);

function normalizeA1111SamplerName(value) {
  const text = cleanText(value);
  if (!text) return "";
  return A1111_SAMPLER_NAMES.get(text.toLowerCase()) || text;
}

function splitSamplerAndScheduler(value) {
  const raw = cleanText(value);
  if (!raw) return {};
  const lower = raw.toLowerCase();
  for (const scheduler of sortedA1111Schedulers) {
    for (const separator of ["_", " "]) {
      const suffix = `${separator}${scheduler}`;
      if (lower.endsWith(suffix) && raw.length > suffix.length) {
        return {
          sampler_raw: raw,
          sampler: normalizeA1111SamplerName(raw.slice(0, -suffix.length)),
          scheduler,
        };
      }
    }
  }
  return { sampler_raw: raw, sampler: normalizeA1111SamplerName(raw) };
}

function a1111Setting(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,\\n])\\s*${escaped}\\s*:\\s*([^,\\n]+)`, "i").exec(text);
  return match?.[1]?.trim() || "";
}

function parseA1111Parameters(metadata) {
  const parameters = generationParameterText(metadata);
  if (!parameters || !parameters.trim()) return null;
  const text = parameters.replace(/\r\n?/g, "\n").trim();
  const parsed = {};
  const integerFields = [["steps", "Steps"], ["seed", "Seed"]];
  const floatFields = [
    ["cfg", "CFG scale"],
    ["denoise", "Denoising strength"],
  ];
  for (const [key, label] of integerFields) {
    const value = finiteNumber(a1111Setting(text, label));
    if (value !== null) parsed[key] = Math.trunc(value);
  }
  for (const [key, label] of floatFields) {
    const value = finiteNumber(a1111Setting(text, label));
    if (value !== null) parsed[key] = value;
  }

  Object.assign(parsed, splitSamplerAndScheduler(a1111Setting(text, "Sampler")));
  const explicitScheduler = cleanText(
    a1111Setting(text, "Scheduler") || a1111Setting(text, "Schedule type"),
  ).toLowerCase();
  if (explicitScheduler) parsed.scheduler = explicitScheduler;

  const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(a1111Setting(text, "Size"));
  if (size) {
    parsed.width = Number(size[1]);
    parsed.height = Number(size[2]);
  }
  return normalizeInputParameters(parsed);
}

function parseA1111Models(metadata) {
  const parameters = generationParameterText(metadata);
  if (!parameters.trim()) return [];
  const hashes = jsonObjectAfterLabel(parameters, "Hashes") || {};
  const read = (...labels) => {
    for (const label of labels) {
      const value = a1111Setting(parameters, label);
      if (value) return value;
    }
    return "";
  };
  return normalizeModels([
    {
      type: "基础模型",
      name: read("Model"),
      hash: read("Model hash") || cleanText(String(hashes.model ?? "")),
    },
    {
      type: "UNet",
      name: read("UNet", "UNET", "Diffusion model"),
      hash: read("UNet hash", "UNET hash", "Diffusion model hash"),
    },
    {
      type: "CLIP",
      name: read("CLIP", "Text encoder"),
      hash: read("CLIP hash", "Text encoder hash"),
    },
    {
      type: "VAE",
      name: read("VAE"),
      hash: read("VAE hash"),
    },
    {
      type: "Refiner",
      name: read("Refiner"),
      hash: read("Refiner hash"),
    },
  ]);
}

function parseA1111(metadata) {
  const parameters = generationParameterText(metadata);
  if (!parameters || !parameters.trim()) return null;
  const text = parameters.replace(/\r\n?/g, "\n").trim();
  const negativeMarker = /\n\s*Negative prompt\s*:/i.exec(text);
  const settingsPattern = /\n\s*Steps\s*:/i;

  let positive = "";
  let negative = "";
  if (negativeMarker) {
    positive = text.slice(0, negativeMarker.index);
    const negativeStart = negativeMarker.index + negativeMarker[0].length;
    const remainder = text.slice(negativeStart);
    const settings = settingsPattern.exec(remainder);
    negative = settings ? remainder.slice(0, settings.index) : remainder;
  } else {
    const settings = settingsPattern.exec(text);
    if (!settings) return null;
    positive = text.slice(0, settings.index);
  }
  const sourceType = /(?:^|,)\s*Civitai (?:resources|metadata)\s*:/i.test(text)
    ? "civitai"
    : "a1111";
  const document = promptDocument(sourceType, positive, negative, parseA1111Parameters(metadata));
  return normalizeDocument({ ...document, models: parseA1111Models(metadata) }, sourceType);
}

function mergeParameters(document, parameters) {
  if (!document || !parameters) return document;
  return normalizeDocument({
    ...document,
    parameters: { ...parameters, ...(document.parameters || {}) },
  }, document.source_type || "4a");
}

function mergeModels(document, models) {
  if (!document || !models?.length) return document;
  return normalizeDocument({
    ...document,
    models: [...(document.models || []), ...models],
  }, document.source_type || "4a");
}

function jsonValueAfterLabel(text, label) {
  if (typeof text !== "string" || !text) return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`(?:^|[,\\n])\\s*${escaped}\\s*:`, "i").exec(text);
  if (!marker) return null;
  const objectStart = text.indexOf("{", marker.index + marker[0].length);
  const arrayStart = text.indexOf("[", marker.index + marker[0].length);
  const start = [objectStart, arrayStart]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  if (start < 0) return null;
  const opening = text[start];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escapedCharacter = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escapedCharacter) escapedCharacter = false;
      else if (character === "\\") escapedCharacter = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return parseJsonValue(text.slice(start, index + 1));
    }
  }
  return null;
}

function jsonObjectAfterLabel(text, label) {
  const value = jsonValueAfterLabel(text, label);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function civitaiResources(metadata) {
  const direct = parseJsonValue(metadataValue(metadata, "Civitai resources"));
  if (Array.isArray(direct)) return direct;
  const value = jsonValueAfterLabel(generationParameterText(metadata), "Civitai resources");
  return Array.isArray(value) ? value : [];
}

function civitaiMetadata(metadata) {
  const direct = parseJsonValue(metadataValue(metadata, "Civitai metadata"));
  if (direct && !Array.isArray(direct)) return direct;
  return jsonObjectAfterLabel(generationParameterText(metadata), "Civitai metadata") || {};
}

function parseCivitaiParameters(metadata) {
  const value = civitaiMetadata(metadata);
  const aspect = value?.aspectRatio || {};
  return normalizeInputParameters({
    seed: value?.seed,
    steps: value?.steps,
    cfg: value?.cfgScale ?? value?.cfg,
    sampler: value?.sampler,
    scheduler: value?.scheduler,
    denoise: value?.denoise ?? value?.denoisingStrength,
    width: value?.width ?? aspect?.width,
    height: value?.height ?? aspect?.height,
  });
}

function parseCivitaiModels(metadata) {
  return normalizeModels(civitaiResources(metadata)
    .filter((entry) => /checkpoint|model/i.test(cleanText(entry?.type)))
    .map((entry) => ({
      type: "基础模型",
      name: [cleanText(entry?.modelName), cleanText(entry?.modelVersionName)]
        .filter(Boolean)
        .join(" · "),
      hash: cleanText(entry?.hash ?? entry?.modelHash),
      model_version_id: entry?.modelVersionId,
    })));
}

function civitaiLoraTag(entry, nameOverride = "") {
  const name = cleanText(nameOverride || entry?.modelName || entry?.name);
  const weight = finiteNumber(entry?.weight ?? entry?.strength) ?? 1;
  return name ? `<lora:${name}:${weight}>` : "";
}

function parseCivitaiLoraTags(metadata) {
  return civitaiResources(metadata)
    .filter((entry) => /lora/i.test(cleanText(entry?.type)))
    .map((entry) => civitaiLoraTag(entry))
    .filter(Boolean);
}

let localLoraVersionIndexPromise = null;

async function localLoraVersionIndex() {
  if (localLoraVersionIndexPromise) return localLoraVersionIndexPromise;
  localLoraVersionIndexPromise = (async () => {
    const index = new Map();
    if (typeof fetch !== "function") return index;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 1500) : null;
    try {
      const response = await fetch("/api/lm/loras/list?page=1&page_size=500", {
        signal: controller?.signal,
      });
      if (!response.ok) return index;
      const payload = await response.json();
      for (const item of payload?.items || []) {
        const versionId = item?.civitai?.id ?? item?.modelVersionId;
        const fileName = cleanText(item?.file_name || item?.name);
        if (versionId === undefined || versionId === null || !fileName) continue;
        index.set(String(versionId), {
          fileName,
          hash: cleanText(item?.sha256),
        });
      }
    } catch (_) {
      // LoRA Manager is optional; keep the Civitai display name when unavailable.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return index;
  })();
  return localLoraVersionIndexPromise;
}

async function enrichLocalCivitaiLoras(document, metadata) {
  if (!document) return null;
  const resources = civitaiResources(metadata)
    .filter((entry) => /lora/i.test(cleanText(entry?.type)) && entry?.modelVersionId != null);
  if (!resources.length) return document;
  const index = await localLoraVersionIndex();
  let loraText = cleanText(document.loras?.text);
  const hashes = [...(document.loras?.hashes || [])];
  let changed = false;
  for (const resource of resources) {
    const local = index.get(String(resource.modelVersionId));
    if (!local) continue;
    const originalTag = civitaiLoraTag(resource);
    const localTag = civitaiLoraTag(resource, local.fileName);
    if (originalTag && localTag) {
      loraText = loraText.includes(originalTag)
        ? loraText.replace(originalTag, localTag)
        : [loraText, localTag].filter(Boolean).join(" ");
      changed = true;
    }
    if (local.hash) hashes.push({ name: local.fileName, hash: local.hash });
  }
  if (!changed && hashes.length === (document.loras?.hashes || []).length) return document;
  return normalizeDocument({
    ...document,
    loras: { text: loraText, hashes },
  }, document.source_type || "generic");
}

function loraHashEntriesFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key]) => /^lora\s*:/i.test(key))
    .map(([key, hash]) => ({
      name: key.replace(/^lora\s*:/i, "").trim(),
      hash: cleanText(String(hash ?? "")),
    }));
}

function loraHashEntriesFromList(value) {
  const text = cleanText(firstString(value));
  if (!text) return [];
  return text.replace(/^"|"$/g, "").split(/\s*,\s*/).map((part) => {
    const separator = part.lastIndexOf(":");
    if (separator < 1) return null;
    return {
      name: part.slice(0, separator).trim(),
      hash: part.slice(separator + 1).trim(),
    };
  }).filter(Boolean);
}

function parseLoraHashes(metadata) {
  const entries = [];
  const directHashes = parseJsonValue(metadataValue(metadata, "Hashes"));
  entries.push(...loraHashEntriesFromObject(directHashes));
  entries.push(...loraHashEntriesFromList(metadataValue(metadata, "Lora hashes")));

  const parameters = generationParameterText(metadata);
  entries.push(...loraHashEntriesFromObject(jsonObjectAfterLabel(parameters, "Hashes")));
  const quotedList = /(?:^|,)\s*Lora hashes\s*:\s*"([^"]*)"/i.exec(parameters);
  if (quotedList) entries.push(...loraHashEntriesFromList(quotedList[1]));
  return normalizeLoraHashes(entries);
}

function enrichLoraMetadata(document, metadata) {
  if (!document) return null;
  const hashes = normalizeLoraHashes([
    ...(document.loras?.hashes || []),
    ...parseLoraHashes(metadata),
  ]);
  return normalizeDocument({
    ...document,
    loras: {
      text: document.loras?.text || "",
      hashes,
    },
  }, document.source_type || "4a");
}

function enrichExternalMetadata(document, metadata) {
  if (!document) return null;
  const withParameters = mergeParameters(document, parseCivitaiParameters(metadata));
  const withModels = mergeModels(withParameters, parseCivitaiModels(metadata));
  const withHashes = enrichLoraMetadata(withModels, metadata);
  const resourceTags = parseCivitaiLoraTags(metadata);
  if (!resourceTags.length) return withHashes;
  return normalizeDocument({
    ...withHashes,
    loras: {
      text: [withHashes?.loras?.text, ...resourceTags].filter(Boolean).join(" "),
      hashes: withHashes?.loras?.hashes || [],
    },
  }, withHashes.source_type || "generic");
}

function enrichDoubleSampleMetadata(document, metadata) {
  if (!document) return document;
  const primaryParameters = parseInputParametersMetadata(metadata);
  const withPrimaryParameters = primaryParameters
    ? normalizeDocument({
      ...document,
      parameters: { ...(document.parameters || {}), ...primaryParameters },
    }, document.source_type || "4a")
    : document;
  const parameters = (
    withPrimaryParameters.double_sample_parameters
    || parseDoubleSampleParameters(metadata)
  );
  if (!parameters) return withPrimaryParameters;
  return normalizeDocument({
    ...withPrimaryParameters,
    double_sample_parameters: parameters,
  }, withPrimaryParameters.source_type || "4a");
}

function nestedJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  return parseJsonValue(trimmed);
}

function findTextByKeys(value, wantedKeys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
  seen.add(value);
  const keys = Object.keys(value);
  for (const wanted of wantedKeys) {
    const actual = keys.find((key) => key.toLowerCase() === wanted);
    const candidate = actual === undefined ? undefined : value[actual];
    if (typeof candidate === "string" && candidate.trim()) {
      // Skip Comfy embedded API/workflow JSON that was saved under "prompt".
      if (looksLikeComfyEmbeddedGraph(candidate)) continue;
      return candidate.trim();
    }
  }
  for (const key of keys) {
    // Never mine captions out of Comfy embed-workflow blobs.
    const lower = key.toLowerCase();
    if (lower === "workflow" || lower === "prompt") continue;
    const child = nestedJson(value[key]);
    if (!child || looksLikeComfyEmbeddedGraph(child)) continue;
    const found = findTextByKeys(child, wantedKeys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function parseGeneric(metadata) {
  // Do not read Comfy's "prompt" key (API graph). Use positive/caption/etc.
  let positive = findTextByKeys(
    metadata,
    ["positive", "description", "imagedescription", "caption", "base_caption", "text"],
  );
  let negative = findTextByKeys(
    metadata,
    [
      "negative", "negative_prompt", "negativeprompt", "uc",
      "undesired_content", "undesired content",
    ],
  );
  for (const raw of metadataStrings(metadata, ["UserComment", "Comment"])) {
    const nested = nestedJson(raw);
    if (nested) {
      positive ||= findTextByKeys(
        nested,
        ["positive", "description", "caption", "base_caption", "text"],
      );
      negative ||= findTextByKeys(
        nested,
        ["negative", "negative_prompt", "negativeprompt", "uc", "undesired_content"],
      );
    } else if (!positive && !looksLikeGenerationText(raw)) {
      positive = cleanText(raw);
    }
  }
  return promptDocument("generic", positive, negative);
}

async function gunzipJson(bytes) {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decoded = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  return JSON.parse(decoded);
}

export async function extractNovelAIStealthMetadata(file) {
  const name = String(file?.name || "").toLowerCase();
  const isPng = file?.type === "image/png" || name.endsWith(".png");
  const isWebp = file?.type === "image/webp" || name.endsWith(".webp");
  if (!isPng && !isWebp) return null;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;

  // NovelAI stealth data lives in the alpha channel. PNG exposes its color
  // type in a fixed header position, while WebP may preserve the same alpha
  // bits in an ALPH chunk after conversion, so WebP is verified by its magic.
  if (isPng) {
    try {
      const header = new Uint8Array(await file.slice(0, 26).arrayBuffer());
      if (header.length < 26 || (header[25] !== 4 && header[25] !== 6)) return null;
    } catch (_) {
      return null;
    }
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const capacityBits = bitmap.width * bitmap.height;
    let bitPosition = 0;

    const readByte = () => {
      if (bitPosition + 8 > capacityBits) throw new Error("stealth metadata truncated");
      let value = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = Math.floor(bitPosition / bitmap.height);
        const y = bitPosition % bitmap.height;
        value = (value << 1) | (rgba[(y * bitmap.width + x) * 4 + 3] & 1);
        bitPosition += 1;
      }
      return value;
    };
    const readBytes = (length) => {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index++) result[index] = readByte();
      return result;
    };

    const magic = new TextDecoder().decode(readBytes("stealth_pngcomp".length));
    if (magic !== "stealth_pngcomp") return null;
    const lengthBytes = readBytes(4);
    const lengthBits = (
      (lengthBytes[0] * 0x1000000)
      + (lengthBytes[1] << 16)
      + (lengthBytes[2] << 8)
      + lengthBytes[3]
    );
    const byteLength = Math.floor(lengthBits / 8);
    if (byteLength < 1 || byteLength > 16 * 1024 * 1024) return null;
    if (bitPosition + byteLength * 8 > capacityBits) return null;

    const metadata = await gunzipJson(readBytes(byteLength));
    if (!metadata || typeof metadata !== "object") return null;
    const comment = metadata.Comment;
    if (typeof comment === "string") {
      const parsedComment = parseJsonValue(comment);
      if (parsedComment) metadata.Comment = parsedComment;
    }
    return metadata;
  } catch (_) {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

export async function readImagePromptDocument(file, metadata = {}) {
  const fourA = parse4A(metadata);
  if (fourA) {
    return enrichLocalCivitaiLoras(
      enrichDoubleSampleMetadata(
        enrichExternalMetadata(
          mergeModels(
            mergeParameters(fourA, parseA1111Parameters(metadata)),
            parseA1111Models(metadata),
          ),
          metadata,
        ),
        metadata,
      ),
      metadata,
    );
  }

  const regularNovelAI = parseNovelAI(metadata);
  if (regularNovelAI) {
    return enrichLocalCivitaiLoras(
      enrichDoubleSampleMetadata(enrichExternalMetadata(regularNovelAI, metadata), metadata),
      metadata,
    );
  }

  const stealthMetadata = await extractNovelAIStealthMetadata(file);
  if (stealthMetadata) {
    const stealthFourA = parse4A(stealthMetadata);
    if (stealthFourA) {
      return enrichLocalCivitaiLoras(
        enrichDoubleSampleMetadata(
          enrichExternalMetadata(stealthFourA, stealthMetadata),
          stealthMetadata,
        ),
        stealthMetadata,
      );
    }
    const stealthNovelAI = parseNovelAI(stealthMetadata);
    if (stealthNovelAI) {
      return enrichLocalCivitaiLoras(
        enrichDoubleSampleMetadata(
          enrichExternalMetadata(stealthNovelAI, stealthMetadata),
          stealthMetadata,
        ),
        stealthMetadata,
      );
    }
  }

  return enrichLocalCivitaiLoras(
    enrichDoubleSampleMetadata(
      enrichExternalMetadata(parseA1111(metadata) || parseGeneric(metadata), metadata),
      metadata,
    ),
    metadata,
  );
}
