import { app } from "../../scripts/app.js";
import { t } from "./i18n.js?v=1";

const NODE_CLASS = "Bypass Switch (4A Prompt Manager)";
const MODE_ALWAYS = 0;
const MODE_BYPASS = 4;
const CONTROL_PREFIX = "control_";

function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget.name === name) || null;
}

function setWidgetValue(node, widget, value) {
  if (!widget || Object.is(widget.value, value)) return false;
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

function graphLinks(graph) {
  return graph?.links || graph?._links || {};
}

function connectedControlNodes(switchNode) {
  const graph = switchNode?.graph || app.graph;
  const links = graphLinks(graph);
  const nodes = [];
  const seen = new Set();
  for (const input of switchNode.inputs || []) {
    if (!String(input?.name || "").startsWith(CONTROL_PREFIX)) continue;
    const linkId = input.link;
    if (linkId == null) continue;
    const link = links[linkId];
    const originId = link?.origin_id;
    if (originId == null) continue;
    const origin = graph.getNodeById?.(originId) || graph.getNodeById?.(Number(originId));
    if (!origin || seen.has(origin.id)) continue;
    seen.add(origin.id);
    nodes.push(origin);
  }
  return nodes;
}

function ensureControlSlots(node) {
  const inputs = node.inputs || [];
  const controlInputs = inputs.filter((input) => String(input?.name || "").startsWith(CONTROL_PREFIX));
  const occupied = controlInputs.filter((input) => input.link != null).length;
  const empty = controlInputs.filter((input) => input.link == null).length;
  if (controlInputs.length === 0 || empty === 0) {
    const index = controlInputs.length + 1;
    node.addInput(`${CONTROL_PREFIX}${index}`, "*");
  }
  // Keep one spare empty slot; remove extras beyond one empty trailing slot.
  const refreshed = (node.inputs || []).filter((input) =>
    String(input?.name || "").startsWith(CONTROL_PREFIX)
  );
  let emptySeen = 0;
  for (let i = refreshed.length - 1; i >= 0; i -= 1) {
    const input = refreshed[i];
    if (input.link != null) continue;
    emptySeen += 1;
    if (emptySeen > 1 && occupied > 0) {
      const absoluteIndex = node.inputs.indexOf(input);
      if (absoluteIndex >= 0) node.removeInput(absoluteIndex);
    }
  }
}

function applyConnectedModes(node, enabled) {
  const mode = enabled ? MODE_ALWAYS : MODE_BYPASS;
  for (const target of connectedControlNodes(node)) {
    if (target.mode === mode) continue;
    target.mode = mode;
    target.setDirtyCanvas?.(true, true);
  }
  node.graph?.setDirtyCanvas?.(true, true);
  node.graph?.change?.();
}

function syncSwitchAppearance(node, enabled) {
  node.color = enabled ? "#2f4f3a" : "#5a3030";
  node.bgcolor = enabled ? "#24352a" : "#3a2424";
  node.title = enabled
    ? t("Bypass Switch（启用）")
    : t("Bypass Switch（旁路）");
}

function setupBypassSwitchNode(node) {
  if (node.__pm4aBypassSwitchReady) return;
  node.__pm4aBypassSwitchReady = true;

  ensureControlSlots(node);

  const enabledWidget = widgetByName(node, "enabled");
  const syncFromWidget = () => {
    const enabled = Boolean(enabledWidget?.value);
    syncSwitchAppearance(node, enabled);
    applyConnectedModes(node, enabled);
    ensureControlSlots(node);
  };

  if (enabledWidget) {
    const previous = enabledWidget.callback?.bind(enabledWidget);
    enabledWidget.callback = (value) => {
      previous?.(value);
      syncFromWidget();
    };
  }

  node.__pm4aBypassSwitchReceive = (payload) => {
    if (!payload || typeof payload !== "object") return { updated: [], skipped: [] };
    if (!("enabled" in payload)) return { updated: [], skipped: [] };
    const enabled = Boolean(payload.enabled);
    const widget = widgetByName(node, "enabled");
    if (!widget) return { updated: [], skipped: ["enabled"] };
    setWidgetValue(node, widget, enabled);
    syncFromWidget();
    return { updated: ["enabled"], skipped: [] };
  };

  node.__pm4aBypassSwitchSnapshot = () => ({
    enabled: Boolean(widgetByName(node, "enabled")?.value),
    modes: connectedControlNodes(node).map((target) => ({
      id: target.id,
      mode: target.mode,
    })),
  });

  node.__pm4aBypassSwitchRestore = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const widget = widgetByName(node, "enabled");
    if (widget && "enabled" in snapshot) {
      setWidgetValue(node, widget, Boolean(snapshot.enabled));
    }
    const graph = node.graph || app.graph;
    for (const entry of snapshot.modes || []) {
      const target = graph.getNodeById?.(entry.id) || graph.getNodeById?.(Number(entry.id));
      if (!target || entry.mode == null) continue;
      target.mode = entry.mode;
    }
    syncFromWidget();
  };

  const originalOnConnectionsChange = node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = function (...args) {
    const result = originalOnConnectionsChange?.(...args);
    ensureControlSlots(node);
    syncFromWidget();
    return result;
  };

  const originalOnConfigure = node.onConfigure?.bind(node);
  node.onConfigure = function (info) {
    const result = originalOnConfigure?.(info);
    requestAnimationFrame(() => {
      ensureControlSlots(node);
      syncFromWidget();
    });
    return result;
  };

  syncFromWidget();
}

app.registerExtension({
  name: "ComfyUI.4APromptManager.BypassSwitch",
  nodeCreated(node) {
    if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) {
      setupBypassSwitchNode(node);
    }
  },
});
