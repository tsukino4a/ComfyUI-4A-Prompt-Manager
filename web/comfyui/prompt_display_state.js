function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStoredImageReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const filename = cleanText(value.filename || value.name);
  if (!filename) return null;
  const subfolder = cleanText(value.subfolder)
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const requestedType = cleanText(value.type).toLowerCase();
  const type = ["input", "output", "temp"].includes(requestedType)
    ? requestedType
    : "input";
  return { filename, subfolder, type };
}

export function imageReferenceFromUpload(payload) {
  return normalizeStoredImageReference(payload);
}

export function imageReferenceLabel(value) {
  const reference = normalizeStoredImageReference(value);
  if (!reference) return "";
  return reference.subfolder
    ? `${reference.subfolder}/${reference.filename}`
    : reference.filename;
}

export function buildStoredImageUrl(value, viewPath = "/view") {
  const reference = normalizeStoredImageReference(value);
  if (!reference) return "";
  const query = new URLSearchParams({
    filename: reference.filename,
    subfolder: reference.subfolder,
    type: reference.type,
  });
  return `${viewPath}?${query.toString()}`;
}

export function resolvePromptDisplayRestoreState({
  importedJson = "",
  lastJson = "",
  importedImage = null,
} = {}) {
  const imported = typeof importedJson === "string" ? importedJson : "";
  const fallback = typeof lastJson === "string" ? lastJson : "";
  const raw = imported || fallback;
  const imageReference = normalizeStoredImageReference(importedImage);
  const source = imported.trim()
    || imageReference
    ? "image"
    : "scheduler";
  return {
    raw,
    source,
    fileName: source === "image"
      ? imageReferenceLabel(imageReference)
      : "",
    imageReference: source === "image" ? imageReference : null,
  };
}

/**
 * True when the node currently holds a user-loaded image snapshot.
 * Queued batch jobs may still execute with a stale empty imported_json and
 * push live scheduler text into onExecuted — the UI must keep the snapshot.
 */
export function shouldKeepImportedPromptDisplay({
  importedJson = "",
  importedImage = null,
} = {}) {
  if (typeof importedJson === "string" && importedJson.trim()) return true;
  return Boolean(normalizeStoredImageReference(importedImage));
}
