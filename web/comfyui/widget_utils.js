export function injectStyle(id, css) {
  let style = document.getElementById(id);
  if (style?.textContent === css) return;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

export function hideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  widget.computeSize = () => [0, -4];
}

export function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget.name === name) || null;
}

export function optionValues(widget) {
  const values = typeof widget?.options?.values === "function"
    ? widget.options.values()
    : widget?.options?.values;
  return Array.isArray(values) ? values : [];
}

export function matchingOption(widget, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const wanted = value.trim();
  const values = optionValues(widget);
  return values.find((candidate) => candidate === wanted)
    ?? values.find((candidate) => String(candidate).toLowerCase() === wanted.toLowerCase())
    ?? null;
}

export function setWidgetValue(node, widget, value) {
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

function splitRawSampler(node, parameters) {
  let sampler = parameters.sampler || "";
  let scheduler = parameters.scheduler || "";
  const raw = typeof parameters.sampler_raw === "string" ? parameters.sampler_raw.trim() : "";
  if (!raw || (sampler && scheduler)) return { sampler, scheduler };

  const schedulers = optionValues(widgetByName(node, "scheduler"))
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

export function receiveSamplerParameters(node, parameters, updated, skipped) {
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
}

export function finishParameterReceive(node, updated, skipped) {
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  node.graph?.change?.();
  return {
    updated: [...new Set(updated)],
    skipped: [...new Set(skipped)],
  };
}
