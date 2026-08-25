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

export function imageReferenceFromComboValue(value) {
  let raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) return null;
  let type = "input";
  const annotated = raw.match(/^(.*) \[(input|output|temp)\]$/i);
  if (annotated) {
    raw = annotated[1].trim();
    type = annotated[2].toLowerCase();
  }
  const slash = raw.lastIndexOf("/");
  if (slash < 0) {
    return normalizeStoredImageReference({ filename: raw, subfolder: "", type });
  }
  return normalizeStoredImageReference({
    filename: raw.slice(slash + 1),
    subfolder: raw.slice(0, slash),
    type,
  });
}

export async function uploadInputImage(file, fetchApi) {
  const form = new FormData();
  form.append("image", file, file.name || "imported-image");
  form.append("type", "input");
  const response = await fetchApi("/upload/image", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `图片持久化失败：${response.status}`);
  }
  const reference = normalizeStoredImageReference(payload);
  if (!reference) throw new Error("图片上传成功，但返回的文件引用无效");
  return reference;
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
 * Keep showing that snapshot until the user clears it — do not replace it
 * with a later execution's connected prompt_json (e.g. mid-batch queue).
 */
export function shouldKeepImportedPromptDisplay({
  importedJson = "",
  importedImage = null,
} = {}) {
  if (typeof importedJson === "string" && importedJson.trim()) return true;
  return Boolean(normalizeStoredImageReference(importedImage));
}
