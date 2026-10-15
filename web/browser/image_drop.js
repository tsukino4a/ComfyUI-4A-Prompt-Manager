import { t } from "./i18n.js";

export const COMFY_ASSET_INFO_MIME = "application/x-comfy-asset-info";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function looksLikeImageFile(file) {
  return Boolean(file && (
    file.type?.startsWith("image/")
    || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(file.name || "")
  ));
}

function parseComfyAssetInfo(raw) {
  try {
    const value = JSON.parse(raw || "");
    return value && typeof value.filename === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

export function hasSupportedImageTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  const items = Array.from(dataTransfer?.items || []);
  const types = Array.from(dataTransfer?.types || []);
  return files.some(looksLikeImageFile)
    || items.some((item) => item.kind === "file" && item.type?.startsWith("image/"))
    || types.includes("Files")
    || types.includes(COMFY_ASSET_INFO_MIME)
    || types.includes("text/uri-list");
}

async function responseBlobWithinLimit(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(t("图片不能超过 32 MB"));
    return blob;
  }

  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(t("图片不能超过 32 MB"));
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: response.headers.get("Content-Type") || "" });
}

export async function fetchImageFile(url, fileName) {
  if (!looksLikeImageFile({ name: fileName })) {
    throw new Error(t("拖入的资产不是支持的图片"));
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(t("图片读取失败：{status}", { status: response.status }));

  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType
    && !contentType.startsWith("image/")
    && contentType !== "application/octet-stream") {
    throw new Error(t("拖入的资产不是支持的图片"));
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(t("图片不能超过 32 MB"));
  }

  const blob = await responseBlobWithinLimit(response);
  const file = new File([blob], fileName || "asset.png", { type: blob.type });
  if (!looksLikeImageFile(file)) throw new Error(t("拖入的资产不是支持的图片"));
  return file;
}

export async function imageFileFromTransfer(dataTransfer, { viewPath = "/view" } = {}) {
  const directFile = Array.from(dataTransfer?.files || []).find(looksLikeImageFile);
  const itemFile = directFile ? null : Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .find(looksLikeImageFile);
  const localFile = directFile || itemFile;
  if (localFile) return localFile;

  const asset = parseComfyAssetInfo(dataTransfer?.getData?.(COMFY_ASSET_INFO_MIME));
  const uriText = dataTransfer?.getData?.("text/uri-list") || "";
  const firstUri = uriText.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  let uri = null;
  try {
    uri = firstUri ? new URL(firstUri, location.href) : null;
  } catch (_) {
    /* malformed uri-list entry */
  }
  // Asset cards may carry only a basename without its subfolder; the
  // frontend's content URL is the reliable location.
  let fetchError = null;
  if (uri?.origin === location.origin) {
    try {
      return await fetchImageFile(
        uri,
        asset?.filename || uri.searchParams.get("filename") || uri.pathname.split("/").pop(),
      );
    } catch (error) {
      fetchError = error;
    }
  }
  if (!asset?.filename) {
    if (fetchError) throw fetchError;
    return null;
  }
  const url = new URL(viewPath, location.href);
  url.searchParams.set("filename", asset.filename);
  url.searchParams.set("type", asset.type || "output");
  if (asset.subfolder) url.searchParams.set("subfolder", asset.subfolder);
  return fetchImageFile(url, asset.filename);
}

export function bindOfficialImageDrop(root, { app, node, onDrop }) {
  const setGlow = (active) => {
    if (active) app.dragOverNode = node;
    else if (app.dragOverNode?.id === node.id) app.dragOverNode = null;
    node.setDirtyCanvas?.(false, true);
    app.canvas?.setDirty?.(false, true);
  };
  const accept = (event) => {
    if (!hasSupportedImageTransfer(event?.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    setGlow(true);
    return true;
  };
  root.addEventListener("dragenter", accept);
  root.addEventListener("dragover", accept);
  root.addEventListener("dragleave", (event) => {
    if (!root.contains?.(event.relatedTarget)) setGlow(false);
  });
  root.addEventListener("drop", (event) => {
    if (!accept(event)) return undefined;
    setGlow(false);
    return onDrop(event.dataTransfer);
  });

  const originalOnDragDrop = node.onDragDrop;
  node.onDragDrop = function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return onDrop(event.dataTransfer);
    return originalOnDragDrop?.apply(this, arguments) ?? false;
  };
  const originalOnDragOver = node.onDragOver;
  node.onDragOver = function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return true;
    return originalOnDragOver?.apply(this, arguments) ?? false;
  };
}
