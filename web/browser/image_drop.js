import { t } from "./i18n.js?v=13";

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
  const localFile = Array.from(dataTransfer?.files || []).find(looksLikeImageFile);
  let fetchError = null;

  const asset = parseComfyAssetInfo(dataTransfer?.getData?.(COMFY_ASSET_INFO_MIME));
  if (asset?.filename) {
    const url = new URL(viewPath, location.href);
    url.searchParams.set("filename", asset.filename);
    url.searchParams.set("type", asset.type || "output");
    if (asset.subfolder) url.searchParams.set("subfolder", asset.subfolder);
    try {
      return await fetchImageFile(url, asset.filename);
    } catch (error) {
      fetchError = error;
    }
  }

  const uriText = dataTransfer?.getData?.("text/uri-list") || "";
  const firstUri = uriText.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  if (firstUri) {
    try {
      const url = new URL(firstUri, location.href);
      if (url.origin === location.origin) {
        return await fetchImageFile(
          url,
          url.searchParams.get("filename") || url.pathname.split("/").pop(),
        );
      }
    } catch (error) {
      fetchError ||= error;
    }
  }

  if (localFile) return localFile;
  if (fetchError) throw fetchError;
  return null;
}
