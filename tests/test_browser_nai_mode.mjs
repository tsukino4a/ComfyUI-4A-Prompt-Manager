import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = path.join(root, "web", "browser");
const html = fs.readFileSync(path.join(browser, "index.html"), "utf8");
const style = fs.readFileSync(path.join(browser, "style.css"), "utf8");
const app = fs.readFileSync(path.join(browser, "app.js"), "utf8");
const promptLibraryModal = fs.readFileSync(
  path.join(root, "web", "comfyui", "prompt_library_modal.js"),
  "utf8",
);
const autocompleteAttach = fs.readFileSync(
  path.join(root, "web", "comfyui", "autocomplete_plus_attach.js"),
  "utf8",
);
const helpers = await import(pathToFileURL(path.join(browser, "nai_settings.js")).href);
const i18n = await import(pathToFileURL(path.join(browser, "i18n.js")).href);

function htmlSection(startId, endId) {
  const start = html.search(new RegExp(`id="${startId}"`));
  const end = html.search(new RegExp(`id="${endId}"`));
  assert.notEqual(start, -1, `${startId} must exist`);
  assert.notEqual(end, -1, `${endId} must exist after ${startId}`);
  assert.ok(end > start, `${endId} must follow ${startId}`);
  return html.slice(start, end);
}

function naiParamKeys(source) {
  return [...source.matchAll(/data-nai-param="([^"]+)"/g)].map((match) => match[1]);
}

test("toolbar exposes a default-Comfy remembered segmented Browser mode", () => {
  assert.match(html, /id="browser-mode-switch"[^>]*class="[^"]*\bview-switch\b[^"]*"/);
  assert.match(
    html,
    /id="btn-browser-mode-comfy"[^>]*class="view-button active"[^>]*aria-pressed="true"/,
  );
  assert.match(
    html,
    /id="btn-browser-mode-nai"[^>]*class="view-button"[^>]*aria-pressed="false"/,
  );
  assert.match(app, /pm4a_browser_mode/);
  assert.match(app, /normalizeBrowserMode\(/);
  assert.match(style, /\.browser-mode-switch\b/);
});

test("frontend relies on no-store responses instead of manual asset versions", () => {
  assert.match(app, /if \(path\.startsWith\("\/pm4a\/api\/"\)\) fetchOptions\.cache = "no-store"/);
  const versionedAssets = [];
  const manualAssetVersion = new RegExp(String.raw`\?v=`);
  for (const directory of [browser, path.join(root, "web", "comfyui")]) {
    for (const name of fs.readdirSync(directory)) {
      if (!/\.(?:html|js)$/.test(name)) continue;
      const source = fs.readFileSync(path.join(directory, name), "utf8");
      if (manualAssetVersion.test(source)) versionedAssets.push(path.join(directory, name));
    }
  }
  assert.deepEqual(versionedAssets, []);
});

test("detail DOM keeps Comfy controls and adds an isolated sparse NAI panel", () => {
  for (const legacyId of [
    "detail-lora-panel",
    "detail-settings-panel",
    "detail-parameters-form",
    "detail-double-form",
    "detail-save",
  ]) {
    assert.match(html, new RegExp(`id="${legacyId}"`));
  }
  for (const naiId of [
    "detail-nai-settings-panel",
    "detail-nai-settings-form",
    "detail-nai-options-status",
    "detail-nai-characters",
  ]) {
    assert.match(html, new RegExp(`id="${naiId}"`));
  }
  assert.match(html, /id="detail-nai-settings-panel"[^>]*hidden/);
  assert.match(html, /data-nai-apply="parameters"/);
  assert.doesNotMatch(html, /id="detail-nai-apply-settings"/);
  assert.doesNotMatch(html, /id="detail-nai-send-document"/);
  assert.doesNotMatch(html, /使用自定义位置/);
  assert.match(html, /id="detail-nai-add-character"[^>]*class="detail-edit-button"/);
  assert.match(html, /id="detail-nai-edit-positions"[^>]*hidden/);
  assert.doesNotMatch(
    htmlSection("detail-nai-settings-panel", "detail-note-panel"),
    /data-i18n="参数"/,
  );
  assert.equal((html.match(/data-nai-model/g) || []).length, 0);
  assert.deepEqual(
    naiParamKeys(htmlSection("detail-nai-settings-form", "detail-nai-characters")),
    [...helpers.NAI_PARAMETER_FIELD_KEYS],
  );
  assert.match(
    htmlSection("detail-nai-settings-form", "detail-nai-characters"),
    /class="card-settings-row-start"[^>]*>[\s\S]*data-nai-param="width"[\s\S]*data-nai-param="height"/,
  );
  assert.doesNotMatch(html, /id="detail-edit-content"/);
  assert.doesNotMatch(html, /id="detail-edit-negative"/);
  assert.doesNotMatch(html, /id="detail-edit-note"/);
  assert.match(html, /id="detail-content-editor"[^>]*rows="1"/);
  assert.doesNotMatch(html, /id="detail-content-editor"[^>]*\bhidden\b/);
  assert.match(app, /autosizePromptTextarea/);
  assert.doesNotMatch(app, /function beginContentEdit\(/);
  assert.match(
    fs.readFileSync(path.join(browser, "nai_characters.js"), "utf8"),
    /nai-card-polarity-switch/,
  );
  assert.equal((html.match(/data-comfy-apply/g) || []).length, 3);
  assert.equal((html.match(/data-nai-apply=/g) || []).length, 1);
});

test("add-prompt modal has a matching NAI panel, parameters, and character editor", () => {
  for (const naiId of [
    "add-nai-settings-panel",
    "add-nai-settings-form",
    "add-nai-characters",
    "add-nai-options-status",
    "add-prompt-load-nai-settings",
  ]) {
    assert.match(html, new RegExp(`id="${naiId}"`));
  }
  assert.match(html, /id="add-nai-settings-panel"[^>]*hidden/);
  assert.match(html, /id="add-nai-add-character"[^>]*class="detail-edit-button"/);
  assert.match(html, /id="add-nai-edit-positions"[^>]*hidden/);
  assert.doesNotMatch(
    htmlSection("add-nai-settings-panel", "add-prompt-status"),
    /data-i18n="参数"/,
  );
  assert.deepEqual(
    naiParamKeys(htmlSection("add-nai-settings-form", "add-nai-characters")),
    [...helpers.NAI_PARAMETER_FIELD_KEYS],
  );
  assert.match(
    htmlSection("add-nai-settings-form", "add-nai-characters"),
    /class="card-settings-row-start"[^>]*>[\s\S]*data-nai-param="width"[\s\S]*data-nai-param="height"/,
  );
  assert.match(app, /createNaiCharactersEditor\(/);
  assert.match(app, /\$\("detail-nai-characters"\)/);
  assert.match(app, /\$\("add-nai-characters"\)/);
});

test("detail NAI panel no longer shows a source ratio control", () => {
  const naiPanel = htmlSection("detail-nai-settings-panel", "detail-note-panel");
  assert.doesNotMatch(naiPanel, /比例来源/);
  assert.doesNotMatch(naiPanel, /detail-ratio-helper/);
  assert.doesNotMatch(naiPanel, /sourceResolutionFromParameters/);
  assert.doesNotMatch(app, /sourceResolutionFromParameters/);
  assert.match(html, /id="detail-ratio-helper"/);
});

test("production visibility decision makes panels mutually exclusive and hides NAI for TXT", () => {
  assert.deepEqual(helpers.browserModeVisibility("comfy", false), {
    comfyLora: true,
    comfySettings: true,
    comfyApply: true,
    naiSettings: false,
  });
  assert.deepEqual(helpers.browserModeVisibility("nai", false), {
    comfyLora: false,
    comfySettings: false,
    comfyApply: false,
    naiSettings: true,
  });
  assert.deepEqual(helpers.browserModeVisibility("nai", true), {
    comfyLora: false,
    comfySettings: false,
    comfyApply: false,
    naiSettings: false,
  });
  assert.match(app, /browserModeVisibility\(state\.browserMode,\s*isTxt\)/);
  assert.match(app, /\$\("add-nai-settings-panel"\)\.hidden = comfyCreate/);
});

test("app loads optional upstream choices lazily after NAI becomes relevant", () => {
  assert.doesNotMatch(app, /\/object_info\/ModelOptionNAID/);
  assert.doesNotMatch(app, /\/object_info\/GenerateNAID/);
  assert.match(app, /\/object_info\/NovelAI4ASampler/);
  assert.match(app, /Promise\.allSettled/);
  assert.match(app, /async function init\(\)/);
  assert.match(app, /function setBrowserMode\(/);
  assert.match(app, /next === "nai"/);
  assert.match(app, /ensureNaiSettingsOptions/);
  assert.match(app, /detail-nai-options-status/);
  assert.match(app, /add-nai-options-status/);
  const initStart = app.indexOf("async function init()");
  const initEnd = app.indexOf("init().catch", initStart);
  assert.notEqual(initStart, -1);
  assert.notEqual(initEnd, -1);
  assert.doesNotMatch(app.slice(initStart, initEnd), /ensureNaiSettingsOptions/);
  assert.match(app, /if \(next === "nai"\) void ensureNaiSettingsOptions\(\)/);
});

test("Comfy send path remains the legacy key route while converted actions use text", () => {
  assert.match(app, /async function sendByKey\(/);
  assert.match(app, /state\.browserMode === "nai"/);
  assert.match(app, /buildNaiSlotRequest/);
  assert.match(app, /convertTextsForAction/);
  assert.match(app, /"\/pm4a\/api\/append-slot"/);
  assert.match(app, /JSON\.stringify\(\{ slot, key, mode: sendMode \}\)/);
  assert.match(
    app,
    /convertTextsForAction\(\s*api,\s*state\.browserMode,\s*\[[^\]]+\],\s*entry,\s*\[slot === "negative" \? "negative" : "content"\]/,
  );

  const request = helpers.buildNaiSlotRequest({
    key: "card",
    content: "raw (card:1.2)",
    negative: "raw negative",
  }, "action", "replace", "1.2::card::");
  assert.deepEqual(request, {
    route: "/pm4a/api/nai/append-slot",
    body: {
      slot: "action",
      value: "1.2::card::",
      mode: "replace",
    },
  });
});

test("NAI create payload stores native drafts under nai instead of Comfy content", () => {
  assert.match(app, /function readCreateNaiDraft\(/);
  assert.match(
    app,
    /content:\s*\$\("add-prompt-content"\)\.value[\s\S]*negative:\s*\$\("add-prompt-negative"\)\.value[\s\S]*characters:\s*state\.createNaiCharactersEditor/,
  );
  assert.match(app, /const nai = naiMode \? readCreateNaiDraft\(\) : \{\}/);
  assert.match(app, /content: naiMode \? "" : content/);
  assert.match(app, /negative: naiMode \? "" : negative/);
  assert.match(app, /\.\.\.\(Object\.keys\(nai\)\.length \? \{ nai \} : \{\}\)/);
});

test("NAI image drop keeps characters structured while Comfy mode flattens them", () => {
  const dropStart = app.indexOf("async function setCreateImage(");
  const dropEnd = app.indexOf("async function saveNewPrompt(", dropStart);
  assert.notEqual(dropStart, -1);
  assert.notEqual(dropEnd, -1);
  const drop = app.slice(dropStart, dropEnd);
  assert.match(drop, /const nativeNai = normalizeNaiSettings\(documentData\.nai \|\| \{\}\)/);
  assert.match(drop, /state\.browserMode === "nai"\s*\? nativeNai\.content \|\| basePositive\s*:\s*comfyTexts\.positive/);
  assert.match(drop, /state\.browserMode === "nai"\s*\? nativeNai\.negative \|\| baseNegative\s*:\s*comfyTexts\.negative/);
  assert.match(
    drop,
    /state\.createNaiCharactersEditor\?\.setValue\(\s*nativeNai\.characters \|\| documentData\.characters \|\| \[\],?\s*\)/,
  );
  assert.doesNotMatch(drop, /fillNaiForm\(/);
  assert.match(app, /const characters = nai\.characters/);
  assert.match(app, /fillNaiForm\(form, nai\)/);
  assert.match(
    app,
    /\$\("add-prompt-load-nai-settings"\)[\s\S]*loadSettingsFromImageFile\(state\.createImage, "create"\)/,
  );
});

test("detail drafts keep Comfy and NAI texts independent and resolve native-first", () => {
  assert.match(app, /function initializeDetailTextDrafts\(/);
  assert.match(app, /detailTextDrafts = \{/);
  assert.match(app, /comfy:\s*\{/);
  assert.match(app, /nai:\s*\{/);
  assert.match(app, /content: String\(entry\?\.content \|\| ""\)/);
  assert.match(app, /const hasNativeNaiText = entry\?\.format === "json_card"/);
  assert.match(app, /content: String\(hasNativeNaiText \? nai\.content \|\| "" : entry\?\.content \|\| ""\)/);
  assert.match(app, /negative: String\(hasNativeNaiText \? nai\.negative \|\| "" : entry\?\.negative \|\| ""\)/);
  assert.match(app, /resolved: !hasNativeNaiText/);
  assert.match(app, /function captureDetailTextDraft\(/);
  assert.match(app, /function applyDetailTextDraft\(/);
  assert.match(app, /async function resolveDetailTextDraft\(/);
  assert.match(app, /resolveEntryTextsForMode\(/);
  assert.match(app, /\["content", "negative"\]/);
  assert.match(app, /void resolveDetailTextDraft\(next\)/);
  assert.match(html, /id="detail-content-source"[^>]*class="prompt-source-badge"/);
  assert.match(html, /id="detail-negative-source"[^>]*class="prompt-source-badge"/);
  assert.match(app, /function updatePromptSourceBadges\(/);
  assert.match(app, /promptFieldProvenance\(/);
  assert.match(app, /t\("NAI 负面提示词"\)/);
  assert.match(style, /\.prompt-source-badge\b/);
});

test("rendering a new entry cannot copy the previous textarea into its draft", () => {
  const dirtyStart = app.indexOf("function hasDirtyDetailEdits()");
  const dirtyEnd = app.indexOf("function updateDetailEditControls()", dirtyStart);
  const renderStart = app.indexOf("function renderInspectorEntry(");
  const renderEnd = app.indexOf("async function openSelectedTxt(", renderStart);
  assert.notEqual(dirtyStart, -1);
  assert.notEqual(dirtyEnd, -1);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  assert.doesNotMatch(app.slice(dirtyStart, dirtyEnd), /captureDetailTextDraft\(/);
  const renderSource = app.slice(renderStart, renderEnd);
  assert.ok(
    renderSource.indexOf("applyDetailTextDraft(state.browserMode)")
      < renderSource.indexOf("applySettingsDraftToDetail("),
  );
});

test("NAI settings send stays on the negative-row parameter button", () => {
  assert.match(app, /"\/pm4a\/api\/nai\/settings\/apply"/);
  assert.match(app, /JSON\.stringify\(body\)/);
  assert.match(app, /async function sendNaiSettings\(/);
  assert.match(app, /data-nai-apply/);
  assert.doesNotMatch(app, /async function sendNaiDocument\(/);
  assert.doesNotMatch(app, /"\/pm4a\/api\/nai\/document\/apply"/);
  assert.doesNotMatch(html, /发送整套/);
  assert.deepEqual(
    helpers.buildNaiDocument("raw positive", "raw negative", [
      { positive: "hero", x: 0.2, y: 0.8 },
    ]),
    {
      tracks: [{ id: "positive", name: "正面", text: "raw positive" }],
      positive: "raw positive",
      negative: "raw negative",
      characters: [{
        id: "char-1",
        name: "角色 1",
        enabled: true,
        positive: "hero",
        negative: "",
        mode: "sequence",
        use_position: true,
        x: 0.2,
        y: 0.8,
        use_order: true,
      }],
    },
  );
});

test("save stores sparse nai only when changed and never calls display conversion", () => {
  assert.match(app, /async function saveDetailEdits\(/);
  assert.match(app, /naiSavePatch/);
  assert.match(app, /payload\.nai/);
  assert.match(app, /function readDetailNaiDraft\(/);
  assert.match(app, /characters: state\.detailNaiCharactersEditor\?\.getValue\(\) \|\| \[\]/);
  assert.doesNotMatch(app, /createDisplayConversionController|applyDetailDisplayResult|detailDisplayConversion/);
  assert.deepEqual(
    helpers.naiSavePatch({ nai: {} }, { parameters: { steps: 7 } }),
    { nai: { parameters: { steps: 7 } } },
  );
  assert.deepEqual(
    helpers.naiSavePatch({ nai: { parameters: { steps: 7 } } }, {}),
    { nai: {} },
  );
});

test("copy and send actions convert for the selected Browser mode", () => {
  assert.match(app, /async function copyDetailText\(/);
  assert.match(app, /await resolveDetailTextDraft\(state\.browserMode\)/);
  assert.match(app, /async function sendByKey\(/);
  assert.match(app, /convertTextsForAction/);
  assert.match(app, /async function sendNaiSettings\(/);
  assert.match(app, /async function copyByKey\(/);
  assert.match(
    app,
    /convertTextsForAction\(\s*api,\s*state\.browserMode,\s*\[text\],\s*entry,\s*\["content"\]/,
  );
});

test("action conversion uses mode endpoint, skips plain Comfy cards, and falls back to raw", async () => {
  assert.equal(
    helpers.conversionEndpointForMode("comfy"),
    "/pm4a/api/convert/nai-to-anima",
  );
  assert.equal(
    helpers.conversionEndpointForMode("nai"),
    "/pm4a/api/convert/anima-to-nai",
  );

  const calls = [];
  const request = async (route, options) => {
    calls.push([route, JSON.parse(options.body)]);
    return { results: [{ text: "1.2::converted::" }] };
  };
  assert.deepEqual(
    await helpers.convertTextsForAction(
      request,
      "nai",
      ["raw (converted:1.2)"],
      { format: "json_card", content: "raw (converted:1.2)" },
      ["content"],
    ),
    {
      texts: ["1.2::converted::"],
      error: null,
      skipped: false,
    },
  );
  assert.deepEqual(calls, [[
    "/pm4a/api/convert/anima-to-nai",
    { texts: ["raw (converted:1.2)"] },
  ]]);

  calls.length = 0;
  assert.deepEqual(
    await helpers.convertTextsForAction(
      request,
      "comfy",
      ["plain"],
      { format: "json_card", nai: {} },
    ),
    { texts: ["plain"], error: null, skipped: true },
  );
  assert.equal(calls.length, 0);

  const failure = new Error("bad syntax");
  const fallback = await helpers.convertTextsForAction(
    async () => { throw failure; },
    "nai",
    ["raw"],
    { format: "json_card", content: "raw" },
  );
  assert.deepEqual(fallback.texts, ["raw"]);
  assert.equal(fallback.error, failure);
  assert.equal(fallback.skipped, false);
});

test("partial image-save failure reuses the unified render and refresh path", () => {
  assert.match(app, /async function saveDetailEdits\(/);
  assert.match(app, /if \(textSaved\)/);
  assert.match(app, /renderInspectorEntry\(entry/);
  assert.match(app, /resetDetailEditing\(\)/);
  assert.match(
    app,
    /if \(textSaved\) \{[\s\S]*renderInspectorEntry\(entry[\s\S]*resetDetailEditing\(\)/,
  );
});

test("new NAI controls and messages are fully translated in English mode", () => {
  assert.match(
    html,
    /id="browser-mode-switch"[^>]*aria-label="Browser 模式"[^>]*data-i18n-aria-label="Browser 模式"/,
  );
  for (const id of ["btn-browser-mode-comfy", "btn-browser-mode-nai"]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*title="[^"]+"[^>]*data-i18n-title="[^"]+"[^>]*aria-label="[^"]+"[^>]*data-i18n-aria-label="[^"]+"`),
    );
  }
  for (const text of [
    "NAI 生成设置",
    "参数",
    "步数",
    "采样器",
    "调度器",
    "角色提示词",
  ]) {
    assert.match(html, new RegExp(`data-i18n="${text}"`));
  }
  assert.match(html, /data-i18n-title="发送 NAI 设置"/);
  i18n.setLocale("en");
  for (const message of [
    "Browser 模式",
    "Comfy 模式",
    "NAI 模式",
    "NAI 生成设置",
    "发送 NAI 设置",
    "角色提示词",
    "NAI 正面提示词",
    "NAI 负面提示词",
    "原生",
    "由 NAI 转换",
    "由 Comfy 转换",
    "将保存为独立提示词",
    "JSON 里保存了当前模式的独立提示词",
    "当前模式没有独立提示词，正在显示从另一侧转换的预览",
    "保存后会写入当前模式的独立提示词",
    "；转换失败，已使用原文：{error}",
    "正在读取 NAI 上游选项…",
    "部分 NAI 上游选项不可用；仍可保留卡片当前值",
    "请先选择一张 JSON 卡片",
    "已发送 NAI 设置",
    "已发送空 NAI 设置；节点现有值保持不变",
  ]) {
    const translated = i18n.t(message, { error: "bad" });
    assert.notEqual(translated, message);
    assert.doesNotMatch(translated, /[\u3400-\u9fff]/);
  }
});
