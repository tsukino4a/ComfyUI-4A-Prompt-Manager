/**
 * Reads generation data from ComfyUI's own "prompt" metadata: the executed API
 * graph ({ id: { class_type, inputs } }) that SaveImage embeds. PNG stores it as
 * a "prompt" text chunk; WebP stores "prompt:{...}" in an EXIF string.
 */

const TEXT_INPUTS = ["text", "text_g", "text_l", "t5xxl", "clip_l", "prompt", "string", "value"];
const SEED_INPUTS = ["seed", "noise_seed"];
const SKIPPED_PARAMETER_LINKS = new Set([
  "model", "clip", "vae", "positive", "negative", "conditioning",
  "latent_image", "samples", "image", "pixels", "mask",
]);

function parseGraph(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^prompt:/, "");
  if (!text.startsWith("{")) return null;
  try {
    const graph = JSON.parse(text);
    const nodes = graph && typeof graph === "object" && !Array.isArray(graph)
      ? Object.values(graph)
      : [];
    return nodes.some((node) => typeof node?.class_type === "string" && node.inputs)
      ? graph
      : null;
  } catch (_) {
    return null;
  }
}

export function comfyPromptGraph(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const key = Object.keys(metadata).find((name) => name.toLowerCase() === "prompt");
  if (key !== undefined) {
    const graph = typeof metadata[key] === "object" ? metadata[key] : parseGraph(metadata[key]);
    if (graph) return graph;
  }
  for (const value of Object.values(metadata)) {
    if (typeof value === "string" && value.startsWith("prompt:")) {
      const graph = parseGraph(value);
      if (graph) return graph;
    }
  }
  return null;
}

function isLink(graph, value) {
  return Array.isArray(value)
    && value.length === 2
    && Number.isInteger(value[1])
    && Object.prototype.hasOwnProperty.call(graph, String(value[0]));
}

function upstream(graph, value) {
  return isLink(graph, value) ? graph[String(value[0])] : null;
}

/** The node that consumes conditioning closest to the saved image wins (last pass). */
function samplingNode(graph) {
  const consumed = new Set();
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node?.inputs || {})) {
      if (isLink(graph, value)) consumed.add(String(value[0]));
    }
  }
  const queue = Object.keys(graph).filter((id) => !consumed.has(id));
  const seen = new Set(queue);
  while (queue.length) {
    const node = graph[queue.shift()];
    const inputs = node?.inputs || {};
    if (isLink(graph, inputs.positive) || isLink(graph, inputs.guider)) return node;
    for (const value of Object.values(inputs)) {
      if (!isLink(graph, value) || seen.has(String(value[0]))) continue;
      seen.add(String(value[0]));
      queue.push(String(value[0]));
    }
  }
  return null;
}

function stringValue(graph, value, seen = new Set()) {
  if (typeof value === "string") return value.trim();
  const node = upstream(graph, value);
  if (!node || seen.has(node)) return "";
  seen.add(node);
  for (const key of TEXT_INPUTS) {
    const text = stringValue(graph, node.inputs?.[key], seen);
    if (text) return text;
  }
  return "";
}

function conditioningText(graph, value, role, seen = new Set()) {
  const node = upstream(graph, value);
  if (!node || seen.has(node)) return [];
  seen.add(node);
  const inputs = node.inputs || {};
  // Encoders such as TextEncodeQwenImage21 output both conditionings from one node.
  if (role === "negative" && inputs.negative_prompt !== undefined) {
    return [stringValue(graph, inputs.negative_prompt)].filter(Boolean);
  }
  const texts = TEXT_INPUTS.map((key) => stringValue(graph, inputs[key])).filter(Boolean);
  if (texts.length) return texts;
  const next = isLink(graph, inputs[role])
    ? [inputs[role]]
    : Object.entries(inputs)
      .filter(([key, entry]) => key.startsWith("conditioning") && isLink(graph, entry))
      .map(([, entry]) => entry);
  return next.flatMap((entry) => conditioningText(graph, entry, role, seen));
}

function promptText(graph, holder, role) {
  return [...new Set(conditioningText(graph, holder?.inputs?.[role], role))].join("\n");
}

function scalarValue(graph, value, keys) {
  if (typeof value === "number" || typeof value === "string") return value;
  const inputs = upstream(graph, value)?.inputs || {};
  for (const key of [...keys, "value", "int", "float", "number"]) {
    const found = inputs[key];
    if (typeof found === "number" || typeof found === "string") return found;
  }
  return undefined;
}

/** Split samplers such as SamplerCustomAdvanced keep settings in nearby helper nodes. */
const PARAMETER_FIELDS = {
  seed: SEED_INPUTS, steps: ["steps"], cfg: ["cfg"], denoise: ["denoise"],
  sampler: ["sampler_name"], scheduler: ["scheduler"],
};
const PARAMETER_INPUTS = new Set(Object.values(PARAMETER_FIELDS).flat());

function samplingParameters(graph, anchor) {
  const parameters = {};
  const queue = [[anchor, 0]];
  const seen = new Set([anchor]);
  while (queue.length) {
    const [node, depth] = queue.shift();
    const inputs = node.inputs || {};
    for (const [field, keys] of Object.entries(PARAMETER_FIELDS)) {
      if (parameters[field] !== undefined) continue;
      const key = keys.find((name) => inputs[name] !== undefined);
      if (key) parameters[field] = scalarValue(graph, inputs[key], keys);
    }
    if (depth >= 2) continue;
    for (const [key, value] of Object.entries(inputs)) {
      const child = SKIPPED_PARAMETER_LINKS.has(key) || PARAMETER_INPUTS.has(key)
        ? null
        : upstream(graph, value);
      if (!child || seen.has(child)) continue;
      seen.add(child);
      queue.push([child, depth + 1]);
    }
  }
  const latent = upstream(graph, anchor.inputs?.latent_image);
  for (const field of ["width", "height"]) {
    const size = scalarValue(graph, latent?.inputs?.[field], [field]);
    if (size !== undefined) parameters[field] = size;
  }
  return parameters;
}

function fileStem(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop()
    .replace(/\.(?:safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, "")
    .trim();
}

function modelChain(graph, holder) {
  const models = [];
  const loras = [];
  const seen = new Set();
  let node = upstream(graph, holder?.inputs?.model);
  while (node && !seen.has(node)) {
    seen.add(node);
    const inputs = node.inputs || {};
    const lora = fileStem(stringValue(graph, inputs.lora_name));
    if (lora) {
      const weight = scalarValue(graph, inputs.strength_model ?? inputs.strength, ["strength_model"]);
      loras.unshift(`<lora:${lora}:${weight ?? 1}>`);
    }
    const checkpoint = fileStem(stringValue(graph, inputs.ckpt_name));
    if (checkpoint) models.push({ type: "基础模型", name: checkpoint });
    const unet = fileStem(stringValue(graph, inputs.unet_name));
    if (unet) models.push({ type: "UNet", name: unet });
    node = upstream(graph, inputs.model);
  }
  return { models, loras };
}

export function parseComfyPromptMetadata(metadata) {
  const graph = comfyPromptGraph(metadata);
  const anchor = graph && samplingNode(graph);
  if (!anchor) return null;
  const guider = upstream(graph, anchor.inputs?.guider);
  const holder = isLink(graph, anchor.inputs?.positive) ? anchor : guider;
  const positive = promptText(graph, holder, "positive") || promptText(graph, holder, "conditioning");
  const negative = promptText(graph, holder, "negative");
  if (!positive && !negative) return null;
  const modelHolder = isLink(graph, anchor.inputs?.model) ? anchor : guider;
  return {
    positive,
    negative,
    parameters: samplingParameters(graph, anchor),
    ...modelChain(graph, modelHolder),
  };
}
