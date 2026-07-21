import { app } from "../../scripts/app.js";
import { configureComfyI18n, pm4aFetch, t } from "./i18n.js?v=1";
import {
  hasSupportedImageTransfer,
  imageFileFromTransfer,
  looksLikeImageFile,
} from "/pm4a/static/image_drop.js?v=3";

export const ADD_PROMPT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

const LAST_FOLDER_KEY = "pm4a_comfy_add_prompt_folder";

function injectStyles() {
  if (document.getElementById("pm4a-library-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "pm4a-library-modal-styles";
  style.textContent = `
    .pm4a-library-modal-overlay { position:fixed; inset:0; z-index:100000; padding:18px; display:grid; place-items:center; pointer-events:none; background:rgba(7,9,11,.72); color:#e7e9eb; font:12px/1.4 system-ui,sans-serif; }
    .pm4a-library-modal-overlay * { box-sizing:border-box; }
    .pm4a-library-modal { width:min(680px,calc(100vw - 36px)); max-height:calc(100vh - 36px); overflow:hidden; display:flex; flex-direction:column; pointer-events:auto; border:1px solid #555b62; border-radius:8px; background:#25292d; box-shadow:0 16px 48px rgba(0,0,0,.55); }
    .pm4a-library-modal-header { min-height:38px; padding:7px 10px 7px 13px; display:flex; align-items:center; gap:8px; border-bottom:1px solid #444a50; background:#30353a; }
    .pm4a-library-modal-title { flex:1; min-width:0; font-size:14px; font-weight:700; }
    .pm4a-library-modal-source { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#99a2aa; }
    .pm4a-library-modal-form { min-height:0; overflow:auto; padding:11px 13px 12px; display:flex; flex-direction:column; gap:9px; }
    .pm4a-library-modal-top { display:grid; grid-template-columns:minmax(170px,.7fr) minmax(240px,1.3fr); gap:9px; }
    .pm4a-library-modal-field { min-width:0; display:flex; flex-direction:column; gap:4px; color:#aeb5bc; }
    .pm4a-library-modal-field > span { padding-left:2px; }
    .pm4a-library-modal input, .pm4a-library-modal select, .pm4a-library-modal textarea { width:100%; border:1px solid #50565d; border-radius:5px; outline:0; color:#eceeef; background:#17191c; font:inherit; }
    .pm4a-library-modal input, .pm4a-library-modal select { height:31px; padding:4px 8px; }
    .pm4a-library-modal textarea { min-height:150px; max-height:42vh; padding:7px 9px; resize:vertical; line-height:1.45; }
    .pm4a-library-modal-secondary { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
    .pm4a-library-modal-secondary textarea { min-height:82px; max-height:24vh; }
    .pm4a-library-modal input:focus, .pm4a-library-modal select:focus, .pm4a-library-modal textarea:focus { border-color:#268bd2; box-shadow:0 0 0 1px rgba(38,139,210,.25); }
    .pm4a-library-modal-preview { min-height:58px; padding:6px; display:flex; align-items:center; gap:9px; border:1px dashed #59616a; border-radius:5px; background:#202327; cursor:pointer; }
    .pm4a-library-modal-preview:focus { outline:0; border-color:#268bd2; box-shadow:0 0 0 1px rgba(38,139,210,.25); }
    .pm4a-library-modal-preview.dragging { border-color:#62a8df; background:#253848; }
    .pm4a-library-modal-preview img { width:48px; height:48px; flex:0 0 48px; object-fit:cover; border-radius:4px; background:#111; }
    .pm4a-library-modal-preview-copy { min-width:0; display:flex; flex-direction:column; gap:2px; }
    .pm4a-library-modal-preview-copy strong { color:#d9dde0; font-weight:650; }
    .pm4a-library-modal-preview-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#929aa2; }
    .pm4a-library-modal-preview-clear { margin-left:auto; flex:0 0 auto; }
    .pm4a-library-modal-footer { min-height:32px; display:flex; align-items:center; gap:7px; }
    .pm4a-library-modal-status { flex:1; min-width:0; color:#9fa7ae; }
    .pm4a-library-modal-status.error { color:#e69a9a; }
    .pm4a-library-modal button { height:30px; padding:4px 11px; border:1px solid #555b62; border-radius:5px; color:#e9ebed; background:#363b40; cursor:pointer; font:inherit; }
    .pm4a-library-modal button:hover { filter:brightness(1.12); }
    .pm4a-library-modal button:disabled { opacity:.5; cursor:not-allowed; filter:none; }
    .pm4a-library-modal .pm4a-library-modal-close { width:26px; height:26px; flex:0 0 26px; display:grid; place-items:center; padding:0; border:0; border-radius:4px; color:#c7ccd1; background:transparent; }
    .pm4a-library-modal .pm4a-library-modal-close:hover { background:#43484e; }
    .pm4a-library-modal-close svg { width:15px; height:15px; display:block; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .pm4a-library-modal-save { border-color:#438c58 !important; background:#285f38 !important; font-weight:700 !important; }
    .pm4a-library-toast { position:fixed; z-index:100001; left:50%; bottom:24px; max-width:min(560px,calc(100vw - 32px)); padding:8px 12px; border:1px solid #4c555c; border-radius:6px; color:#e9ecee; background:#292e32; box-shadow:0 8px 28px rgba(0,0,0,.45); transform:translateX(-50%); font:12px/1.4 system-ui,sans-serif; }
    .pm4a-library-toast.warning { border-color:#816a3f; color:#f0d49e; }
    @media (max-width:620px) { .pm4a-library-modal-top, .pm4a-library-modal-secondary { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

async function requestJson(path, options = {}) {
  const response = await pm4aFetch(path, {
    cache: "no-store",
    headers: options.body instanceof FormData
      ? { Accept: "application/json" }
      : { Accept: "application/json", "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // The HTTP status below is more useful than a JSON parsing error.
  }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data || {};
}

function flattenFolders(nodes, depth = 0, result = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    result.push({
      path: String(node?.path || ""),
      label: `${"\u3000".repeat(depth)}${String(node?.name || node?.path || t("未命名文件夹"))}`,
    });
    flattenFolders(node?.children, depth + 1, result);
  }
  return result;
}

function showToast(message, warning = false) {
  const toast = document.createElement("div");
  toast.className = `pm4a-library-toast${warning ? " warning" : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), warning ? 5200 : 3000);
}

export function openPromptLibraryModal({
  content = "",
  negative = "",
  note = "",
  sourceLabel = "正面",
  previewFile = null,
} = {}) {
  configureComfyI18n(app);
  injectStyles();
  const positive = String(content || "").trim();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pm4a-library-modal-overlay";
    const dialog = document.createElement("section");
    dialog.className = "pm4a-library-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "false");
    dialog.setAttribute("aria-label", t("添加提示词"));

    const header = document.createElement("header");
    header.className = "pm4a-library-modal-header";
    const heading = document.createElement("div");
    heading.className = "pm4a-library-modal-title";
    heading.textContent = t("添加提示词");
    const source = document.createElement("div");
    source.className = "pm4a-library-modal-source";
    source.textContent = t("来源：{label}", { label: sourceLabel });
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "pm4a-library-modal-close";
    closeButton.innerHTML = CLOSE_ICON;
    closeButton.title = t("关闭");
    closeButton.setAttribute("aria-label", t("关闭"));
    header.append(heading, source, closeButton);

    const form = document.createElement("form");
    form.className = "pm4a-library-modal-form";
    const top = document.createElement("div");
    top.className = "pm4a-library-modal-top";

    const makeField = (labelText, control) => {
      const label = document.createElement("label");
      label.className = "pm4a-library-modal-field";
      const caption = document.createElement("span");
      caption.textContent = labelText;
      label.append(caption, control);
      return label;
    };

    const folderSelect = document.createElement("select");
    folderSelect.disabled = true;
    const loadingOption = document.createElement("option");
    loadingOption.textContent = t("正在读取文件夹…");
    folderSelect.appendChild(loadingOption);
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.maxLength = 200;
    titleInput.placeholder = t("输入{label}提示词标题", { label: sourceLabel });
    titleInput.autocomplete = "off";
    top.append(makeField(t("保存到"), folderSelect), makeField(t("标题"), titleInput));

    const contentInput = document.createElement("textarea");
    contentInput.value = positive;
    contentInput.placeholder = t("当前栏目没有可添加的内容");
    contentInput.spellcheck = false;
    const contentField = makeField(t("正面提示词"), contentInput);

    const secondary = document.createElement("div");
    secondary.className = "pm4a-library-modal-secondary";
    const negativeInput = document.createElement("textarea");
    negativeInput.value = String(negative || "");
    negativeInput.placeholder = t("可留空");
    negativeInput.spellcheck = false;
    const noteInput = document.createElement("textarea");
    noteInput.value = String(note || "");
    noteInput.placeholder = t("可留空");
    noteInput.spellcheck = false;
    secondary.append(
      makeField(t("负面提示词"), negativeInput),
      makeField(t("备注"), noteInput),
    );

    let selectedPreviewFile = previewFile instanceof Blob ? previewFile : null;
    let previewUrl = "";
    let imageRequestId = 0;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
    fileInput.hidden = true;
    const preview = document.createElement("div");
    preview.className = "pm4a-library-modal-preview";
    preview.tabIndex = 0;
    preview.setAttribute("role", "button");
    preview.setAttribute("aria-label", t("选择或拖入预览图"));
    const previewImage = document.createElement("img");
    const previewCopy = document.createElement("div");
    previewCopy.className = "pm4a-library-modal-preview-copy";
    const previewTitle = document.createElement("strong");
    const previewName = document.createElement("div");
    previewName.className = "pm4a-library-modal-preview-name";
    const previewClear = document.createElement("button");
    previewClear.type = "button";
    previewClear.className = "pm4a-library-modal-preview-clear";
    previewClear.textContent = t("清除");
    previewCopy.append(previewTitle, previewName);
    preview.append(previewImage, previewCopy, previewClear);

    const updatePreview = () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = "";
      previewClear.hidden = !(selectedPreviewFile instanceof Blob);
      if (selectedPreviewFile instanceof Blob) {
        previewUrl = URL.createObjectURL(selectedPreviewFile);
        previewImage.src = previewUrl;
        previewImage.hidden = false;
        previewTitle.textContent = t("将同时保存为预览图");
        previewName.textContent = String(selectedPreviewFile.name || t("当前载入图片"));
      } else {
        previewImage.removeAttribute("src");
        previewImage.hidden = true;
        previewTitle.textContent = t("点击或拖入示例图");
        previewName.textContent = t("支持 PNG、JPEG、WebP、GIF");
      }
    };
    const clearPreview = () => {
      imageRequestId += 1;
      selectedPreviewFile = null;
      fileInput.value = "";
      updatePreview();
    };
    const selectPreviewFile = (file) => {
      if (!(file instanceof Blob)) return;
      selectedPreviewFile = file;
      updatePreview();
    };
    updatePreview();

    const footer = document.createElement("div");
    footer.className = "pm4a-library-modal-footer";
    const status = document.createElement("div");
    status.className = "pm4a-library-modal-status";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = t("取消");
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "pm4a-library-modal-save";
    saveButton.textContent = t("添加提示词");
    saveButton.disabled = true;
    footer.append(status, cancelButton, saveButton);
    form.append(top, contentField, secondary, fileInput, preview, footer);
    dialog.append(header, form);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let saving = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      imageRequestId += 1;
      document.removeEventListener("keydown", onKeyDown, true);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      overlay.remove();
      resolve(result);
    };
    const cancel = () => {
      if (!saving) finish(null);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    closeButton.onclick = cancel;
    cancelButton.onclick = cancel;
    preview.addEventListener("click", () => {
      if (!saving) fileInput.click();
    });
    preview.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (!saving) fileInput.click();
    });
    previewClear.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!saving) clearPreview();
    });
    fileInput.addEventListener("change", () => {
      if (saving) return;
      try {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!looksLikeImageFile(file)) {
          status.textContent = t("请选择 PNG、JPEG、WebP 或 GIF 图片");
          status.classList.add("error");
          return;
        }
        if (file.size > 32 * 1024 * 1024) {
          status.textContent = t("图片不能超过 32 MB");
          status.classList.add("error");
          return;
        }
        status.textContent = "";
        status.classList.remove("error");
        selectPreviewFile(file);
      } finally {
        fileInput.value = "";
      }
    });
    const isImageDrag = (event) => hasSupportedImageTransfer(event.dataTransfer);
    preview.addEventListener("dragenter", (event) => {
      if (!isImageDrag(event)) return;
      event.preventDefault();
      if (saving) return;
      preview.classList.add("dragging");
    });
    preview.addEventListener("dragover", (event) => {
      if (!isImageDrag(event)) return;
      event.preventDefault();
      if (saving) return;
      event.dataTransfer.dropEffect = "copy";
      preview.classList.add("dragging");
    });
    preview.addEventListener("dragleave", () => {
      if (saving) return;
      preview.classList.remove("dragging");
    });
    preview.addEventListener("drop", async (event) => {
      if (!isImageDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (saving) return;
      preview.classList.remove("dragging");
      const requestId = ++imageRequestId;
      status.textContent = t("正在读取图片…");
      status.classList.remove("error");
      try {
        const file = await imageFileFromTransfer(event.dataTransfer);
        if (requestId !== imageRequestId || saving || settled) return;
        if (!file) throw new Error(t("未找到可用图片"));
        if (file.size > 32 * 1024 * 1024) {
          throw new Error(t("图片不能超过 32 MB"));
        }
        selectPreviewFile(file);
        status.textContent = "";
      } catch (error) {
        if (requestId !== imageRequestId || saving || settled) return;
        status.textContent = String(error.message || error);
        status.classList.add("error");
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      const name = titleInput.value.trim();
      const prompt = contentInput.value.trim();
      if (!name) {
        status.textContent = t("请填写标题");
        status.classList.add("error");
        titleInput.focus();
        return;
      }
      if (!prompt) {
        status.textContent = t("当前正面提示词为空");
        status.classList.add("error");
        contentInput.focus();
        return;
      }

      saving = true;
      imageRequestId += 1;
      folderSelect.disabled = true;
      titleInput.disabled = true;
      contentInput.disabled = true;
      negativeInput.disabled = true;
      noteInput.disabled = true;
      saveButton.disabled = true;
      cancelButton.disabled = true;
      closeButton.disabled = true;
      status.classList.remove("error");
      status.textContent = t("正在添加…");
      try {
        const created = await requestJson("/pm4a/api/entry/create", {
          method: "POST",
          body: JSON.stringify({
            folder: folderSelect.value,
            name,
            content: prompt,
            negative: negativeInput.value,
            note: noteInput.value,
          }),
        });
        let entry = created.entry;
        let imageError = "";
        if (selectedPreviewFile instanceof Blob && entry?.key) {
          status.textContent = t("提示词已添加，正在保存预览图…");
          const imageForm = new FormData();
          imageForm.append("key", entry.key);
          imageForm.append("image", selectedPreviewFile, selectedPreviewFile.name || "preview.png");
          try {
            const imageResult = await requestJson("/pm4a/api/image", {
              method: "POST",
              body: imageForm,
            });
            entry = imageResult.entry || entry;
          } catch (error) {
            imageError = String(error.message || error);
          }
        }
        try {
          localStorage.setItem(LAST_FOLDER_KEY, folderSelect.value);
        } catch (_) {
          // Storage can be unavailable in hardened browser environments.
        }
        if (imageError) {
          showToast(t("提示词已添加，但预览图保存失败：{error}", { error: imageError }), true);
        } else {
          showToast(t("已添加提示词“{name}”", { name: entry?.name || name }));
        }
        finish({ entry, imageError });
      } catch (error) {
        saving = false;
        folderSelect.disabled = false;
        titleInput.disabled = false;
        contentInput.disabled = false;
        negativeInput.disabled = false;
        noteInput.disabled = false;
        saveButton.disabled = false;
        cancelButton.disabled = false;
        closeButton.disabled = false;
        status.textContent = String(error.message || error);
        status.classList.add("error");
      }
    });

    (async () => {
      try {
        const tree = await requestJson("/pm4a/api/tree");
        const folders = flattenFolders(tree.tree);
        folderSelect.replaceChildren();
        const rootOption = document.createElement("option");
        rootOption.value = "";
        rootOption.textContent = t("根目录");
        folderSelect.appendChild(rootOption);
        for (const folder of folders) {
          const option = document.createElement("option");
          option.value = folder.path;
          option.textContent = folder.label;
          folderSelect.appendChild(option);
        }
        let remembered = "";
        try {
          remembered = localStorage.getItem(LAST_FOLDER_KEY) || "";
        } catch (_) {
          // Use root when storage is unavailable.
        }
        folderSelect.value = [...folderSelect.options].some((option) => option.value === remembered)
          ? remembered
          : "";
        folderSelect.disabled = false;
        saveButton.disabled = false;
        titleInput.focus();
      } catch (error) {
        loadingOption.textContent = t("文件夹读取失败");
        status.textContent = String(error.message || error);
        status.classList.add("error");
      }
    })();
  });
}
