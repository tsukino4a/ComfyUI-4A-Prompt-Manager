/**
 * ComfyUI-side locale adapter.
 *
 * Wraps the single shared browser translator served at
 * /pm4a/static/i18n.js so every ComfyUI extension module in this plugin
 * imports the exact same module instance (and therefore shares one
 * activeLocale) instead of loading independent copies with divergent state.
 *
 * pm4aFetch() is for /pm4a/api/* requests only: it attaches the
 * X-PM4A-Locale header via the shared localeHeaders() helper. Native
 * ComfyUI requests (e.g. /prompt, /system_stats) must keep using their own
 * fetch/api helpers untouched.
 */
import {
  getLocale,
  localeHeaders,
  normalizeLocale,
  setLocale,
  t,
} from "/pm4a/static/i18n.js?v=13";

export function getComfyLocale(app) {
  let current;
  try {
    current = app?.extensionManager?.setting?.get?.("Comfy.Locale");
  } catch (_) {
    current = undefined;
  }
  if (current === undefined || current === null || String(current).trim() === "") {
    try {
      current = app?.ui?.settings?.getSettingValue?.("Comfy.Locale");
    } catch (_) {
      current = undefined;
    }
  }
  if (current === undefined || current === null || String(current).trim() === "") {
    return "zh";
  }
  return normalizeLocale(current);
}

export function configureComfyI18n(app) {
  return setLocale(getComfyLocale(app));
}

export function pm4aFetch(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: localeHeaders(options.headers || {}),
  });
}

export { getLocale, localeHeaders, normalizeLocale, t };
