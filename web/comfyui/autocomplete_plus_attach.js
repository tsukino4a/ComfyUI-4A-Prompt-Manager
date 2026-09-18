/**
 * Attach ComfyUI-Autocomplete-Plus handlers to custom textareas.
 *
 * The plugin only auto-hooks official ComfyWidgets.STRING controls. Scheduler
 * uses DOM textareas, so we import the same event handlers and bind them here.
 * Missing plugin installs fail quietly.
 *
 * AutoFormatter is intentionally not attached: it rewrites the textarea on
 * blur (clicking outside) and would change scheduler text in place.
 */

const EXTENSION_JS_ROOTS = Object.freeze([
  "/extensions/comfyui-autocomplete-plus/js",
  "/extensions/ComfyUI-Autocomplete-Plus/js",
]);

const EVENT_HANDLERS = Object.freeze([
  ["input", "handleInput"],
  ["focus", "handleFocus"],
  ["blur", "handleBlur"],
  ["keydown", "handleKeyDown"],
  ["keyup", "handleKeyUp"],
  ["mousemove", "handleMouseMove"],
  ["click", "handleClick"],
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
        ] = await Promise.all([
          import(`${root}/autocomplete.js`),
          import(`${root}/related-tags.js`),
        ]);
        return {
          autocomplete: new AutocompleteEventHandler(),
          relatedTags: new RelatedTagsEventHandler(),
        };
      } catch (_) {
        // try next extension path / missing plugin
      }
    }
    return null;
  })();
  return handlersPromise;
}

/** @param {HTMLTextAreaElement} element */
export async function attachAutocompletePlus(element) {
  if (!(element instanceof HTMLTextAreaElement) || element.readOnly) return false;
  if (attachedElements.has(element)) return true;
  attachedElements.add(element);

  // Help other tools / plugin fallback recognize this as a prompt textarea.
  element.classList.add("comfy-multiline-input");

  const handlers = await loadHandlers();
  if (!handlers) {
    attachedElements.delete(element);
    return false;
  }

  for (const [eventName, method] of EVENT_HANDLERS) {
    element.addEventListener(eventName, (event) => {
      handlers.autocomplete[method](event);
      handlers.relatedTags[method](event);
    });
  }
  return true;
}
