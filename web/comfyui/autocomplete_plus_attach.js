/**
 * Attach ComfyUI-Autocomplete-Plus handlers to custom textareas.
 *
 * The plugin only auto-hooks official ComfyWidgets.STRING controls. Scheduler
 * uses DOM textareas, so we import the same event handlers and bind them here.
 * Missing plugin installs fail quietly.
 */

const EXTENSION_JS_ROOTS = Object.freeze([
  "/extensions/comfyui-autocomplete-plus/js",
  "/extensions/ComfyUI-Autocomplete-Plus/js",
]);

const attachedElements = new WeakSet();
let handlersPromise = null;

async function loadHandlers() {
  if (handlersPromise) return handlersPromise;
  handlersPromise = (async () => {
    for (const root of EXTENSION_JS_ROOTS) {
      try {
        const [
          { AutocompleteEventHandler },
          { RelatedTagsEventHandler },
          { AutoFormatterEventHandler },
          { NodeInfo },
        ] = await Promise.all([
          import(`${root}/autocomplete.js`),
          import(`${root}/related-tags.js`),
          import(`${root}/auto-formatter.js`),
          import(`${root}/node-info.js`),
        ]);
        return {
          autocomplete: new AutocompleteEventHandler(),
          relatedTags: new RelatedTagsEventHandler(),
          autoFormatter: new AutoFormatterEventHandler(),
          NodeInfo,
        };
      } catch (_) {
        // try next extension path / missing plugin
      }
    }
    return null;
  })();
  return handlersPromise;
}

/**
 * @param {HTMLTextAreaElement} element
 * @param {{ nodeType?: string, inputName?: string }} [info]
 * @returns {Promise<boolean>}
 */
export async function attachAutocompletePlus(element, info = {}) {
  if (!(element instanceof HTMLTextAreaElement) || element.readOnly) return false;
  if (attachedElements.has(element)) return true;

  // Help other tools / plugin fallback recognize this as a prompt textarea.
  element.classList.add("comfy-multiline-input");

  const handlers = await loadHandlers();
  if (!handlers) return false;
  if (attachedElements.has(element)) return true;

  const nodeInfo = new handlers.NodeInfo(
    info.nodeType || "unknown",
    info.inputName || "text",
  );

  const handleInput = (event) => {
    handlers.autocomplete.handleInput(event);
    handlers.relatedTags.handleInput(event);
    handlers.autoFormatter.handleInput(event);
  };
  const handleFocus = (event) => {
    handlers.autocomplete.handleFocus(event);
    handlers.relatedTags.handleFocus(event);
    handlers.autoFormatter.handleFocus(event);
  };
  const handleBlur = (event) => {
    handlers.autocomplete.handleBlur(event);
    handlers.relatedTags.handleBlur(event);
    handlers.autoFormatter.handleBlur(event, nodeInfo);
  };
  const handleKeyDown = (event) => {
    handlers.autocomplete.handleKeyDown(event);
    handlers.relatedTags.handleKeyDown(event);
    handlers.autoFormatter.handleKeyDown(event);
  };
  const handleKeyUp = (event) => {
    handlers.autocomplete.handleKeyUp(event);
    handlers.relatedTags.handleKeyUp(event);
    handlers.autoFormatter.handleKeyUp(event);
  };
  const handleMouseMove = (event) => {
    handlers.autocomplete.handleMouseMove(event);
    handlers.relatedTags.handleMouseMove(event);
    handlers.autoFormatter.handleMouseMove(event);
  };
  const handleClick = (event) => {
    handlers.autocomplete.handleClick(event);
    handlers.relatedTags.handleClick(event);
    handlers.autoFormatter.handleClick(event);
  };

  element.addEventListener("input", handleInput);
  element.addEventListener("focus", handleFocus);
  element.addEventListener("blur", handleBlur);
  element.addEventListener("keydown", handleKeyDown);
  element.addEventListener("keyup", handleKeyUp);
  element.addEventListener("mousemove", handleMouseMove);
  element.addEventListener("click", handleClick);
  attachedElements.add(element);
  return true;
}
