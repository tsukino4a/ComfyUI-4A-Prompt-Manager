import { app } from "../../scripts/app.js";
import { getPngMetadata, getWebpMetadata } from "../../scripts/pnginfo.js";
import { readImagePromptDocument } from "/pm4a/static/image_prompt_metadata.js?v=13";
import { getLocale, pm4aFetch, t } from "./i18n.js?v=1";

export const SCHEDULER_NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)";
export const INPUT_PARAMETERS_NODE_CLASS = "Input Parameters (4A Prompt Manager)";
export const DOUBLE_SAMPLE_PARAMETERS_NODE_CLASS = "Double Sample Parameters (4A Prompt Manager)";
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
  const document = await readImagePromptDocument(file, metadata);
  if (!document) throw new Error(t("图片中没有识别到正面或负面提示词"));
  const dimensions = await readImageDimensions(file);
  const snapshotDocument = {
    ...document,
    raw_metadata: metadata,
    image_dimensions: dimensions || undefined,
  };
  return {
    metadata,
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

export function replaceLoraLoaderText(node, value) {
  const widget = node?.inputWidget || node?.widgets?.find((candidate) => candidate.name === "text");
  if (!widget) return false;
  setWidgetValue(node, widget, "");
  setWidgetValue(node, widget, value);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  node.graph?.change?.();
  return true;
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

export function applyLoraFromPayload(hostNode, payload) {
  const textValue = typeof payload?.loras?.text === "string" ? payload.loras.text.trim() : "";
  if (!textValue) return null;
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

/** Apply every Meta Loader target available in the payload. */
export async function applyAllFromPayload(hostNode, payload) {
  const applied = [];
  const errors = [];

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

  const modelResult = await applyModelsFromPayload(hostNode, payload);
  const modelCount = modelResult.applied.length;
  if (modelCount) {
    applied.push(modelCount === 1 ? t("模型 1 个") : t("模型 {count} 个", { count: modelCount }));
  }
  errors.push(...modelResult.errors);

  try {
    const message = applyInputParametersFromPayload(hostNode, payload);
    if (message) applied.push(t("生成参数"));
  } catch (error) {
    if (payload?.parameters) {
      errors.push(t("{key}：{error}", { key: t("生成参数"), error: error.message || error }));
    }
  }

  try {
    const message = applyDoubleSampleFromPayload(hostNode, payload);
    if (message) applied.push(t("双采样参数"));
  } catch (error) {
    if (payload?.double_sample_parameters) {
      errors.push(t("{key}：{error}", { key: t("双采样参数"), error: error.message || error }));
    }
  }

  try {
    const message = applyLoraFromPayload(hostNode, payload);
    if (message) applied.push("LoRA");
  } catch (error) {
    if (typeof payload?.loras?.text === "string" && payload.loras.text.trim()) {
      errors.push(t("{key}：{error}", { key: "LoRA", error: error.message || error }));
    }
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
