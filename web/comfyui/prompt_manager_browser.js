import { app } from "../../scripts/app.js";
import { configureComfyI18n, getComfyLocale } from "./i18n.js?v=1";
import { withSyncedDomWidth } from "./dom_widget_layout.js";

const NODE_CLASS = "Prompt Manager Browser (4A Prompt Manager)";
const MANAGER_PATH = "/pm4a/wildcards";
const DEFAULT_NODE_SIZE = [1200, 800];
const MIN_WIDGET_HEIGHT = 360;
// Match browser card grid: at least ~2.1 columns at 160px min card width.
const MIN_BROWSER_NODE_WIDTH = Math.ceil(160 * 2.1);

function clampBrowserNodeSize(size) {
  if (!Array.isArray(size)) return size;
  if (Number(size[0]) < MIN_BROWSER_NODE_WIDTH) size[0] = MIN_BROWSER_NODE_WIDTH;
  return size;
}

function useBrowserNodeMinimumWidth(nodeType) {
  const prototype = nodeType?.prototype;
  if (!prototype || prototype.__pm4aBrowserMinimumWidthReady) return;
  prototype.__pm4aBrowserMinimumWidthReady = true;

  const originalComputeSize = prototype.computeSize;
  prototype.computeSize = function () {
    const size = originalComputeSize?.apply(this, arguments) || [
      MIN_BROWSER_NODE_WIDTH,
      DEFAULT_NODE_SIZE[1],
    ];
    return clampBrowserNodeSize(size);
  };

  const originalOnResize = prototype.onResize;
  prototype.onResize = function (size) {
    clampBrowserNodeSize(size);
    return originalOnResize?.apply(this, arguments);
  };
}

function attachBrowser(node) {
  configureComfyI18n(app);
  const frameHost = document.createElement("div");
  frameHost.className = "pm4a-browser-node-host";
  frameHost.style.cssText = [
    "position:relative",
    "width:100%",
    "height:100%",
    `min-height:${MIN_WIDGET_HEIGHT}px`,
    "overflow:hidden",
    "box-sizing:border-box",
    "border:1px solid rgba(255,255,255,0.14)",
    "border-radius:6px",
    "background:#101214",
  ].join(";");

  const iframe = document.createElement("iframe");
  iframe.className = "pm4a-browser-node-frame";
  iframe.src = `${MANAGER_PATH}?lang=${getComfyLocale(app)}`;
  iframe.title = "4A Prompt Manager";
  iframe.loading = "eager";
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");
  iframe.style.cssText = [
    "display:block",
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    "border:0",
    "background:#101214",
  ].join(";");
  frameHost.appendChild(iframe);

  let browserWidget = null;
  const availableHeight = () => {
    const measuredTop = Number(browserWidget?.last_y);
    const widgetTop = Number.isFinite(measuredTop) ? measuredTop : 30;
    return Math.max(
      MIN_WIDGET_HEIGHT,
      Number(node.size?.[1] || DEFAULT_NODE_SIZE[1]) - widgetTop - 8,
    );
  };

  browserWidget = node.addDOMWidget(
    "pm4a_browser_ui",
    "pm4a_browser",
    frameHost,
    withSyncedDomWidth({
      serialize: false,
      hideOnZoom: true,
      margin: 0,
      getMinHeight: () => MIN_WIDGET_HEIGHT,
      getMaxHeight: availableHeight,
    }),
  );

  const originalComputeLayoutSize = browserWidget.computeLayoutSize?.bind(browserWidget);
  browserWidget.computeLayoutSize = function (targetNode) {
    const base = originalComputeLayoutSize?.(targetNode) || {
      minHeight: MIN_WIDGET_HEIGHT,
      minWidth: 0,
    };
    return {
      ...base,
      minHeight: Math.max(Number(base.minHeight) || 0, MIN_WIDGET_HEIGHT),
      minWidth: Math.max(Number(base.minWidth) || 0, MIN_BROWSER_NODE_WIDTH),
    };
  };

  node.resizable = true;
  clampBrowserNodeSize(node.size);
}

function scheduleBrowserAttachment(node, attempt = 0) {
  const attach = () => {
    if (node.__pm4aBrowserAttached) return;
    if (!node.graph) {
      if (attempt < 60) {
        requestAnimationFrame(() => scheduleBrowserAttachment(node, attempt + 1));
      }
      return;
    }
    node.__pm4aBrowserAttached = true;
    attachBrowser(node);
  };
  if (attempt === 0) queueMicrotask(attach);
  else attach();
}

app.registerExtension({
  name: "ComfyUI-4A-Prompt-Manager.PromptManagerBrowser",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    useBrowserNodeMinimumWidth(nodeType);

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalOnNodeCreated?.apply(this, arguments);
      // This runs before workflow configuration. New nodes receive a useful
      // default, while loaded/undo-restored nodes overwrite it with their
      // serialized size during configure().
      this.resizable = true;
      this.setSize([...DEFAULT_NODE_SIZE]);
      scheduleBrowserAttachment(this);
    };
  },
});
