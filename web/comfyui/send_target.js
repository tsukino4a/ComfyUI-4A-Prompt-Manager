import { app } from "../../scripts/app.js";
import { t } from "./i18n.js";

export const SCHEDULER_NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)";
export const SEND_TARGET_ALL = "all";

const EXTRA_KEY = "pm4a_send_target";
const CHANGE_EVENT = "pm4a-send-target-change";

export function isScheduler(node) {
  return Boolean(node) && (node.comfyClass === SCHEDULER_NODE_CLASS || node.type === SCHEDULER_NODE_CLASS);
}

/** Every scheduler in the root graph and its subgraphs. */
export function allSchedulerNodes() {
  const results = [];
  const visited = new Set();
  const visit = (graph) => {
    if (!graph || visited.has(graph)) return;
    visited.add(graph);
    for (const node of graph._nodes || graph.nodes || []) {
      if (isScheduler(node)) results.push(node);
      if (node?.subgraph) visit(node.subgraph);
    }
  };
  visit(app.graph);
  return results;
}

/** Node ids are only unique per graph, so subgraph schedulers carry their graph id. */
export function schedulerKey(node) {
  const graph = node?.graph;
  return !graph || graph === app.graph ? String(node?.id) : `${graph.id}:${node.id}`;
}

export function schedulerLabel(node) {
  const graph = node?.graph;
  const graphName = graph && graph !== app.graph && graph.name ? ` (${graph.name})` : "";
  return `#${node.id}${graphName} ${node.title || "Prompt Scheduler"}`;
}

function linkedOrigin(graph, link) {
  if (!link) return null;
  return graph?.getNodeById?.(link.origin_id) || graph?.getNodeById?.(Number(link.origin_id)) || null;
}

/** Scheduler wired into this node's prompt_json input, if any. */
export function connectedScheduler(hostNode) {
  const graph = hostNode?.graph || app.graph;
  const input = hostNode?.inputs?.find((candidate) => candidate.name === "prompt_json");
  if (input?.link === null || input?.link === undefined) return null;
  const origin = linkedOrigin(graph, graph?.links?.[input.link] || graph?._links?.[input.link]);
  return isScheduler(origin) ? origin : null;
}

export function getSendTarget() {
  return String(app.graph?.extra?.[EXTRA_KEY] || "");
}

export function notifySendTargetChange() {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

let refreshFrame = 0;
/** Coalesce refreshes from bursts of node add/remove (e.g. loading a workflow). */
export function scheduleSendTargetRefresh() {
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    notifySendTargetChange();
  });
}

export function onSendTargetChange(listener) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function flashSchedulers(schedulers) {
  for (const scheduler of schedulers) scheduler.__pm4aSchedulerFlash?.();
}

export function setSendTarget(value) {
  const graph = app.graph;
  if (!graph) return;
  graph.extra = graph.extra || {};
  if (value) graph.extra[EXTRA_KEY] = String(value);
  else delete graph.extra[EXTRA_KEY];
  graph.setDirtyCanvas?.(true, true);
  notifySendTargetChange();
  flashSchedulers(resolveTargetSchedulers().schedulers);
}

/**
 * Prompt Scheduler(s) that should receive content sent from `sourceNode`.
 * Order: prompt_json wire > workflow send target > the only scheduler.
 */
export function resolveTargetSchedulers(sourceNode = null) {
  const linked = sourceNode ? connectedScheduler(sourceNode) : null;
  if (linked) return { schedulers: [linked], error: "" };
  const all = allSchedulerNodes();
  if (!all.length) return { schedulers: [], error: t("工作流中没有 Scheduler") };
  const target = getSendTarget();
  if (target === SEND_TARGET_ALL) return { schedulers: all, error: "" };
  const chosen = all.find((node) => schedulerKey(node) === target);
  if (chosen) return { schedulers: [chosen], error: "" };
  if (all.length === 1) return { schedulers: all, error: "" };
  return { schedulers: [], error: t("请先选择接收调度器") };
}

export function isReceivingScheduler(node) {
  const target = getSendTarget();
  return target === SEND_TARGET_ALL || target === schedulerKey(node);
}

/** Dropdown options; empty when there is nothing to choose between. */
export function sendTargetOptions() {
  const all = allSchedulerNodes();
  if (all.length < 2) return [];
  return [
    ...all.map((node) => ({ value: schedulerKey(node), label: schedulerLabel(node) })),
    { value: SEND_TARGET_ALL, label: t("全部调度器") },
  ];
}

/** Current target if it still exists in the workflow, otherwise "". */
export function validSendTarget(options = sendTargetOptions()) {
  const target = getSendTarget();
  return options.some((option) => option.value === target) ? target : "";
}

export function notify(message, severity = "warn") {
  const toast = app.extensionManager?.toast;
  if (typeof toast?.add === "function") {
    toast.add({ severity, summary: "4A Prompt Manager", detail: message, life: 4000 });
  } else {
    console.warn("[4A-PM]", message);
  }
}

/**
 * Workflow-wide receiving scheduler picker for sender nodes. Hidden when the
 * workflow has fewer than two schedulers or `sourceNode` is wired to one.
 */
export function createSendTargetSelect(className, sourceNode = null) {
  const select = document.createElement("select");
  select.className = className;
  select.title = t("接收调度器");
  const refresh = () => {
    const options = sendTargetOptions();
    select.hidden = !options.length || Boolean(sourceNode && connectedScheduler(sourceNode));
    if (select.hidden) return;
    const current = validSendTarget(options);
    select.replaceChildren();
    if (!current) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = t("选择接收调度器");
      select.appendChild(placeholder);
    }
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = current;
  };
  select.addEventListener("change", () => setSendTarget(select.value));
  select.addEventListener("pointerenter", refresh);
  const dispose = onSendTargetChange(refresh);
  refresh();
  return { element: select, refresh, dispose };
}

// Same-origin bridge for the prompt browser page (iframe or opened window).
window.__pm4aSendTarget = Object.freeze({
  options: sendTargetOptions,
  current: () => validSendTarget(),
  set: setSendTarget,
  error: () => resolveTargetSchedulers().error,
  subscribe: onSendTargetChange,
});
