import { app } from "../../scripts/app.js";
import { configureComfyI18n, t } from "./i18n.js?v=1";
import { useKSamplerMinimumWidth } from "./sampler_node_size.js";
import { withSyncedDomWidth } from "./dom_widget_layout.js";

const NODE_CLASS = "Input Parameters (4A Prompt Manager)";
const SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h14M15 4l3 3-3 3M20 17H6M9 14l-3 3 3 3"/></svg>';
const DEFAULT_RATIO = "2:3 竖图";

function injectStyles() {
  if (document.getElementById("pm4a-input-parameters-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-input-parameters-styles";
  style.textContent = `
    .pm4a-resolution { width:100%; height:45px; padding:0 16px 1px; display:flex; flex-direction:column; gap:4px; box-sizing:border-box; container-type:inline-size; color:#ddd; font:11px/1 system-ui,sans-serif; }
    .pm4a-resolution * { box-sizing:border-box; }
    .pm4a-resolution-top { display:grid; grid-template-columns:minmax(0,1fr) 20px; gap:4px; }
    .pm4a-resolution-select, .pm4a-resolution-field { height:20px; border:1px solid #666; border-radius:10px; color:#ddd; background:#222; }
    .pm4a-resolution-select { width:100%; padding:1px 30px; outline:0; appearance:none; -webkit-appearance:none; font:inherit; cursor:pointer; }
    .pm4a-resolution-select::-ms-expand { display:none; }
    .pm4a-resolution-swap { width:20px; height:20px; padding:2px; display:grid; place-items:center; border:0; border-radius:4px; color:#c8cdd2; background:transparent; cursor:pointer; }
    .pm4a-resolution-swap:hover { color:#fff; background:#3a3e43; }
    .pm4a-resolution-swap svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .pm4a-resolution-dimensions { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:5px; }
    .pm4a-resolution-field { position:relative; overflow:hidden; }
    .pm4a-resolution-label { position:absolute; z-index:1; left:30px; top:50%; transform:translateY(-50%); color:#999fa6; pointer-events:none; }
    .pm4a-resolution-input { width:100%; height:100%; padding:1px 30px 1px 58px; border:0; outline:0; appearance:textfield; -moz-appearance:textfield; color:#eee; background:transparent; text-align:right; font:inherit; }
    .pm4a-resolution-input::-webkit-inner-spin-button, .pm4a-resolution-input::-webkit-outer-spin-button { margin:0; -webkit-appearance:none; appearance:none; }
    @container (max-width:260px) {
      .pm4a-resolution-select { padding-inline:12px; }
      .pm4a-resolution-label { left:8px; }
      .pm4a-resolution-input { padding:1px 7px 1px 38px; }
    }
  `;
  document.head.appendChild(style);
}

function hideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  widget.computeSize = () => [0, -4];
}

function roundDimension(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(8, Math.min(16384, Math.round(value / 8) * 8));
}

function parseRatioParts(ratioName) {
  const match = String(ratioName || "").match(/(\d+)\s*:\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function calculatePresetDimensions(longestSide, ratioName) {
  const longest = roundDimension(longestSide) ?? 1536;
  const parts = parseRatioParts(ratioName) || [2, 3];
  if (parts[0] >= parts[1]) {
    return [longest, roundDimension(longest * parts[1] / parts[0])];
  }
  return [roundDimension(longest * parts[0] / parts[1]), longest];
}

function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget.name === name) || null;
}

function optionValues(widget) {
  const values = typeof widget?.options?.values === "function"
    ? widget.options.values()
    : widget?.options?.values;
  return Array.isArray(values) ? values : [];
}

function matchingOption(widget, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const wanted = value.trim();
  const values = optionValues(widget);
  return values.find((candidate) => candidate === wanted)
    ?? values.find((candidate) => String(candidate).toLowerCase() === wanted.toLowerCase())
    ?? null;
}

function setWidgetValue(node, widget, value) {
  if (!widget || value === null || value === undefined || Object.is(widget.value, value)) return false;
  const previous = widget.value;
  widget.value = value;
  if (widget.inputEl) widget.inputEl.value = value;
  if (Array.isArray(node.widgets_values)) {
    const index = node.widgets.indexOf(widget);
    if (index >= 0) node.widgets_values[index] = value;
  }
  widget.callback?.(value);
  node.onWidgetChanged?.(widget.name, value, previous, widget);
  return true;
}

function numericWidgetValue(widget, raw, integer = false) {
  if (raw === "" || raw === null || raw === undefined) return null;
  let value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (integer) value = Math.trunc(value);
  const min = Number(widget?.options?.min);
  const max = Number(widget?.options?.max);
  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);
  return value;
}

function closestRatio(width, height, ratioNames = []) {
  const target = Number(width) / Number(height);
  if (!Number.isFinite(target) || target <= 0) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of ratioNames) {
    const parts = parseRatioParts(name);
    if (!parts) continue;
    const distance = Math.abs(Math.log(target / (parts[0] / parts[1])));
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

function defaultRatio(ratioWidget) {
  return matchingOption(ratioWidget, ratioWidget?.value)
    || matchingOption(ratioWidget, DEFAULT_RATIO)
    || optionValues(ratioWidget)[0]
    || DEFAULT_RATIO;
}

function splitRawSampler(node, parameters) {
  let sampler = parameters.sampler || "";
  let scheduler = parameters.scheduler || "";
  const raw = typeof parameters.sampler_raw === "string" ? parameters.sampler_raw.trim() : "";
  if (!raw || (sampler && scheduler)) return { sampler, scheduler };

  const schedulerWidget = widgetByName(node, "scheduler");
  const schedulers = optionValues(schedulerWidget)
    .map(String)
    .sort((left, right) => right.length - left.length);
  const rawLower = raw.toLowerCase();
  for (const candidate of schedulers) {
    const suffix = `_${candidate.toLowerCase()}`;
    if (rawLower.endsWith(suffix) && raw.length > suffix.length) {
      sampler ||= raw.slice(0, -suffix.length);
      scheduler ||= candidate;
      break;
    }
  }
  sampler ||= raw;
  return { sampler, scheduler };
}

function setupInputParametersNode(node) {
  if (node.__pm4aInputParametersReady) return;
  node.__pm4aInputParametersReady = true;
  configureComfyI18n(app);
  injectStyles();

  const ratioWidget = widgetByName(node, "ratio");
  const widthWidget = widgetByName(node, "width");
  const heightWidget = widgetByName(node, "height");
  hideWidget(ratioWidget);
  hideWidget(widthWidget);
  hideWidget(heightWidget);

  const resolution = document.createElement("div");
  resolution.className = "pm4a-resolution";
  resolution.addEventListener("pointerdown", (event) => event.stopPropagation());
  resolution.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

  const top = document.createElement("div");
  top.className = "pm4a-resolution-top";
  const ratioSelect = document.createElement("select");
  ratioSelect.className = "pm4a-resolution-select";
  ratioSelect.title = t("选择比例并按当前最长边计算一次宽高");
  for (const ratioName of optionValues(ratioWidget)) {
    const option = document.createElement("option");
    option.value = ratioName;
    option.textContent = t(ratioName);
    ratioSelect.appendChild(option);
  }
  const swapButton = document.createElement("button");
  swapButton.type = "button";
  swapButton.className = "pm4a-resolution-swap";
  swapButton.innerHTML = SWAP_ICON;
  swapButton.title = t("交换宽高（不重新计算）");
  swapButton.setAttribute("aria-label", swapButton.title);
  top.append(ratioSelect, swapButton);

  const dimensions = document.createElement("div");
  dimensions.className = "pm4a-resolution-dimensions";
  const makeDimension = (name) => {
    const field = document.createElement("label");
    field.className = "pm4a-resolution-field";
    const label = document.createElement("span");
    label.className = "pm4a-resolution-label";
    label.textContent = name;
    const input = document.createElement("input");
    input.className = "pm4a-resolution-input";
    input.type = "number";
    input.min = "8";
    input.max = "16384";
    input.step = "8";
    input.inputMode = "numeric";
    field.append(label, input);
    return { field, input };
  };
  const widthControl = makeDimension(t("宽度"));
  const heightControl = makeDimension(t("高度"));
  dimensions.append(widthControl.field, heightControl.field);
  resolution.append(top, dimensions);

  const syncResolution = () => {
    const ratio = defaultRatio(ratioWidget);
    ratioSelect.value = ratio;
    widthControl.input.value = String(roundDimension(widthWidget?.value) ?? 1024);
    heightControl.input.value = String(roundDimension(heightWidget?.value) ?? 1536);
  };

  const setResolution = ({ ratio, width, height }) => {
    node.__pm4aApplyingResolution = true;
    try {
      if (ratio !== undefined) {
        const matchedRatio = matchingOption(ratioWidget, ratio);
        if (matchedRatio !== null) setWidgetValue(node, ratioWidget, matchedRatio);
      }
      if (width !== undefined) {
        const value = roundDimension(width);
        if (value !== null) setWidgetValue(node, widthWidget, value);
      }
      if (height !== undefined) {
        const value = roundDimension(height);
        if (value !== null) setWidgetValue(node, heightWidget, value);
      }
    } finally {
      node.__pm4aApplyingResolution = false;
    }
    syncResolution();
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    node.graph?.change?.();
  };
  node.__pm4aSetResolution = setResolution;
  node.__pm4aInputParametersSyncResolution = syncResolution;

  ratioSelect.addEventListener("change", () => {
    const longest = Math.max(
      roundDimension(widthWidget?.value) ?? 1024,
      roundDimension(heightWidget?.value) ?? 1536,
    );
    const [width, height] = calculatePresetDimensions(longest, ratioSelect.value);
    setResolution({ ratio: ratioSelect.value, width, height });
  });

  const commitDimension = (name, input) => {
    const value = roundDimension(input.value);
    if (value === null) {
      syncResolution();
      return;
    }
    setResolution({ [name]: value });
  };
  widthControl.input.addEventListener("change", () => commitDimension("width", widthControl.input));
  heightControl.input.addEventListener("change", () => commitDimension("height", heightControl.input));
  for (const control of [widthControl, heightControl]) {
    control.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        control.input.blur();
      }
    });
  }

  swapButton.addEventListener("click", () => {
    const width = roundDimension(widthWidget?.value) ?? 1024;
    const height = roundDimension(heightWidget?.value) ?? 1536;
    const ratios = optionValues(ratioWidget);
    setResolution({
      ratio: closestRatio(height, width, ratios),
      width: height,
      height: width,
    });
  });

  node.addDOMWidget("pm4a_resolution_ui", "pm4a_resolution", resolution, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => 45,
    getMaxHeight: () => 45,
  }));
  syncResolution();

  node.__pm4aInputParametersReceive = (parameters) => {
    if (!parameters || typeof parameters !== "object") return { updated: [], skipped: [] };
    const updated = [];
    const skipped = [];

    for (const [name, integer] of [["seed", true], ["steps", true], ["cfg", false], ["denoise", false]]) {
      if (parameters[name] === undefined || parameters[name] === null) continue;
      const widget = widgetByName(node, name);
      const value = numericWidgetValue(widget, parameters[name], integer);
      if (value === null) {
        skipped.push(name);
      } else {
        setWidgetValue(node, widget, value);
        updated.push(name);
      }
    }

    const names = splitRawSampler(node, parameters);
    for (const name of ["sampler", "scheduler"]) {
      if (!names[name]) continue;
      const widget = widgetByName(node, name);
      const value = matchingOption(widget, names[name]);
      if (value === null) {
        skipped.push(name);
      } else {
        setWidgetValue(node, widget, value);
        updated.push(name);
      }
    }

    const width = Number(parameters.width);
    const height = Number(parameters.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      const ratio = matchingOption(
        ratioWidget,
        closestRatio(width, height, optionValues(ratioWidget)),
      );
      node.__pm4aSetResolution?.({ ratio, width, height });
      updated.push("ratio", "width", "height");
    }

    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    node.graph?.change?.();
    return {
      updated: [...new Set(updated)],
      skipped: [...new Set(skipped)],
    };
  };
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.InputParameters",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    useKSamplerMinimumWidth(nodeType);

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupInputParametersNode(this);
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      setupInputParametersNode(this);
      this.__pm4aInputParametersSyncResolution?.();
      return result;
    };
  },
});
