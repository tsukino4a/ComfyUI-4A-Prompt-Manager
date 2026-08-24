import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(root, "web", "browser", "nai_settings.js")).href;
const helpers = await import(moduleUrl);

const {
  NAI_PARAMETER_FIELD_KEYS,
  browserModeVisibility,
  buildNaiDocument,
  buildNaiSlotRequest,
  cloneNaiSettings,
  conversionEndpointForMode,
  convertTextsForAction,
  emptyNaiSettings,
  fillNaiForm,
  flattenNovelAIForComfyMode,
  naiSavePatch,
  naiSettingsEqual,
  normalizeBrowserMode,
  normalizeNaiSettings,
  promptFieldProvenance,
  promptFieldSourceDisplay,
  rawTextForNaiSlot,
  readNaiForm,
  readObjectInfoChoices,
  resolveEntryTextsForMode,
  setChoiceOptions,
  shouldConvertDetail,
  sourceResolutionFromParameters,
} = helpers;

const plain = (value) => JSON.parse(JSON.stringify(value));

test("Comfy add-prompt import flattens NovelAI characters into prompt text", () => {
  assert.deepEqual(
    flattenNovelAIForComfyMode({
      source_type: "novelai",
      characters: [
        { positive: "alice", negative: "bad alice" },
        { positive: "bob", negative: "" },
        { positive: "", negative: "bad carol" },
      ],
    }, {
      positive: "base positive",
      negative: "base negative",
    }),
    {
      positive: "base positive\nchar1: alice\nchar2: bob",
      negative: "base negative\nchar1: bad alice\nchar3: bad carol",
    },
  );
});

test("Comfy add-prompt import leaves non-NovelAI prompt text unchanged", () => {
  assert.deepEqual(
    flattenNovelAIForComfyMode({
      source_type: "4a",
      characters: [{ positive: "must stay structured", negative: "also structured" }],
    }, {
      positive: "base positive",
      negative: "base negative",
    }),
    { positive: "base positive", negative: "base negative" },
  );
});

class FakeControl {
  constructor(tagName = "INPUT") {
    this.tagName = tagName;
    this.value = "";
    this.options = [];
  }

  replaceChildren(...children) {
    this.options = children;
  }

  appendChild(child) {
    this.options.push(child);
    return child;
  }
}

function fakeForm() {
  const controls = new Map();
  for (const key of NAI_PARAMETER_FIELD_KEYS) {
    const tag = ["sampler", "scheduler"].includes(key)
      ? "SELECT"
      : "INPUT";
    controls.set(`[data-nai-param="${key}"]`, new FakeControl(tag));
  }
  return {
    controls,
    querySelector(selector) {
      return controls.get(selector) || null;
    },
  };
}

test("NAI schema is exact, sparse, and has no defaults", () => {
  assert.deepEqual([...NAI_PARAMETER_FIELD_KEYS], [
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "cfg_rescale",
    "width",
    "height",
  ]);
  assert.deepEqual(plain(emptyNaiSettings()), {});
  assert.deepEqual(plain(normalizeNaiSettings({
    model: " ",
    parameters: {
      width: "",
      seed: "",
      unknown: "drop",
    },
    token: "drop",
  })), {});
});

test("normalizer keeps nai content, negative, characters, and the allowed parameters", () => {
  const original = {
    content: "  nai positive  ",
    negative: " nai negative ",
    model: " nai-diffusion-5-full ",
    characters: [{
      id: "char-1",
      name: "角色 1",
      enabled: true,
      positive: "hero",
      negative: "bad hands",
      mode: "sequence",
      use_position: true,
      x: 0.2,
      y: 0.8,
      use_order: true,
    }],
    parameters: {
      width: "832.8",
      height: 1216,
      steps: "28",
      cfg: "5.25",
      sampler: " k_euler ",
      scheduler: "native",
      seed: "42.9",
      smea: "SMEA+DYN",
      decrisper: "true",
      variety: false,
      cfg_rescale: "0",
      uncond_scale: 1,
      denoise: 0.5,
    },
  };
  const normalized = plain(normalizeNaiSettings(original));
  assert.deepEqual(normalized, {
    content: "nai positive",
    negative: "nai negative",
    parameters: {
      steps: 28,
      cfg: 5.25,
      sampler: "k_euler",
      scheduler: "native",
      cfg_rescale: 0,
      width: 832,
      height: 1216,
    },
    characters: [{
      positive: "hero",
      negative: "bad hands",
      x: 0.2,
      y: 0.8,
    }],
  });
  assert.equal(original.model, " nai-diffusion-5-full ");
  assert.equal(original.parameters.width, "832.8");
  assert.equal(original.characters[0].id, "char-1");
});

test("numeric whitespace stays blank instead of becoming zero", () => {
  assert.deepEqual(plain(normalizeNaiSettings({
    parameters: {
      width: "   ",
      cfg: "\t",
      seed: "\r\n",
    },
  })), {});
});

test("blank nai content and negative are omitted", () => {
  assert.deepEqual(plain(normalizeNaiSettings({
    content: "   ",
    negative: "\n",
  })), {});
});

test("Comfy card dimensions become a complete source ratio only", () => {
  assert.deepEqual(
    plain(sourceResolutionFromParameters({ width: 832, height: 1216, steps: 23 })),
    { width: 832, height: 1216 },
  );
  assert.equal(sourceResolutionFromParameters({ width: 832 }), null);
  assert.equal(sourceResolutionFromParameters({ width: 0, height: 1216 }), null);
});

test("clone and equality canonicalize allowed fields without aliasing", () => {
  const sourceValue = {
    content: "nai positive",
    parameters: { steps: 28, cfg_rescale: 0 },
    characters: [{ positive: "hero", x: 0.25, y: 0.75 }],
  };
  const cloned = cloneNaiSettings(sourceValue);
  cloned.parameters.steps = 30;
  cloned.characters[0].positive = "mutated";
  cloned.content = "mutated content";
  assert.equal(sourceValue.parameters.steps, 28);
  assert.equal(sourceValue.characters[0].positive, "hero");
  assert.equal(sourceValue.content, "nai positive");
  assert.equal(naiSettingsEqual(
    sourceValue,
    {
      content: "nai positive",
      parameters: { cfg_rescale: 0, steps: 28 },
      characters: [{ positive: "hero", negative: "", x: 0.25, y: 0.75 }],
    },
  ), true);
  assert.equal(naiSettingsEqual(sourceValue, cloned), false);
});

test("form helpers keep every control blank and round-trip the allowed fields", () => {
  const form = fakeForm();
  fillNaiForm(form, {});
  for (const control of form.controls.values()) assert.equal(control.value, "");

  form.querySelector('[data-nai-param="steps"]').value = "0";
  form.querySelector('[data-nai-param="cfg_rescale"]').value = "0.2";
  assert.deepEqual(plain(readNaiForm(form)), {
    parameters: { steps: 0, cfg_rescale: 0.2 },
  });

  fillNaiForm(form, {
    content: "ignored by form",
    characters: [{ positive: "hero" }],
    parameters: { sampler: "k_euler", scheduler: "karras" },
  });
  assert.equal(form.querySelector('[data-nai-param="sampler"]').value, "k_euler");
  assert.equal(form.querySelector('[data-nai-param="scheduler"]').value, "karras");
  assert.deepEqual(plain(readNaiForm(form)), {
    parameters: { sampler: "k_euler", scheduler: "karras" },
  });
});

test("choice helpers retain blank, unique live choices, and a card-only value", () => {
  const select = new FakeControl("SELECT");
  const documentLike = {
    createElement() {
      return { value: "", textContent: "" };
    },
  };
  setChoiceOptions(
    select,
    ["native", "karras", "native", ""],
    "legacy-scheduler",
    documentLike,
  );
  assert.deepEqual(
    select.options.map(({ value }) => value),
    ["", "native", "karras", "legacy-scheduler"],
  );
  assert.equal(select.value, "legacy-scheduler");

  const samplerInfo = {
    NovelAI4ASampler: {
      input: {
        required: {
          sampler: [["sampler-a", "sampler-b"]],
          scheduler: [["native", "karras"]],
        },
      },
    },
  };
  assert.deepEqual(
    plain(readObjectInfoChoices(
      samplerInfo,
      "NovelAI4ASampler",
      ["sampler", "scheduler"],
    )),
    {
      sampler: ["sampler-a", "sampler-b"],
      scheduler: ["native", "karras"],
    },
  );
  assert.deepEqual(
    plain(readObjectInfoChoices({}, "NovelAI4ASampler", ["sampler"])),
    {},
  );
});

test("mode and save decisions isolate NAI from TXT and legacy cards", () => {
  assert.equal(normalizeBrowserMode("nai"), "nai");
  assert.equal(normalizeBrowserMode("other"), "comfy");
  assert.deepEqual(plain(browserModeVisibility("comfy", false)), {
    comfyLora: true,
    comfySettings: true,
    comfyApply: true,
    naiSettings: false,
  });
  assert.deepEqual(plain(browserModeVisibility("nai", false)), {
    comfyLora: false,
    comfySettings: false,
    comfyApply: false,
    naiSettings: true,
  });
  assert.deepEqual(plain(browserModeVisibility("comfy", true)), {
    comfyLora: false,
    comfySettings: false,
    comfyApply: true,
    naiSettings: false,
  });
  assert.equal(browserModeVisibility("nai", true).naiSettings, false);

  assert.deepEqual(plain(naiSavePatch({ format: "txt_wildcard" }, {
    parameters: { steps: 1 },
  })), {});
  assert.deepEqual(plain(naiSavePatch({ nai: {} }, {})), {});
  assert.deepEqual(plain(naiSavePatch({
    nai: { parameters: { steps: 28 } },
  }, {})), { nai: {} });
  assert.deepEqual(plain(naiSavePatch({ nai: {} }, {
    content: "nai positive",
    characters: [{ positive: "hero" }],
  })), {
    nai: {
      content: "nai positive",
      characters: [{ positive: "hero", negative: "" }],
    },
  });
});

test("conversion predicate uses native-mode text first and falls back per field", () => {
  assert.equal(shouldConvertDetail("comfy", {
    format: "json_card",
    content: "{red|blue}",
    nai: {},
  }), false);
  assert.equal(shouldConvertDetail("comfy", {
    format: "json_card",
    nai: { parameters: { cfg_rescale: 0 } },
  }), false);
  assert.equal(shouldConvertDetail("comfy", {
    format: "json_card",
    nai: { content: "1.2::red::" },
  }), true);
  assert.equal(shouldConvertDetail("comfy", {
    format: "json_card",
    content: "{red|blue}",
    nai: { content: "1.2::red::" },
  }), false);
  assert.equal(shouldConvertDetail("nai", {
    format: "json_card",
    content: "(red:1.2)",
    nai: {},
  }), true);
  assert.equal(shouldConvertDetail("nai", {
    format: "json_card",
    content: "(red:1.2)",
    nai: { content: "1.2::red::" },
  }), false);
  assert.equal(shouldConvertDetail("nai", {
    format: "json_card",
    negative: "bad",
    nai: { content: "1.2::red::" },
  }, "negative"), true);
  assert.equal(shouldConvertDetail("nai", {
    format: "json_card",
    negative: "bad",
    nai: { negative: "lowres" },
  }, "negative"), false);
  assert.equal(shouldConvertDetail("comfy", {
    format: "txt_wildcard",
    nai: { content: "must-not-convert" },
  }), false);
  assert.equal(shouldConvertDetail("comfy", {
    type: "folder",
    nai: { content: "must-not-convert" },
  }), false);
  assert.equal(shouldConvertDetail("nai", {
    format: "txt_wildcard",
    content: "preview",
  }), false);
});

test("NAI route payload builders prefer native mode text then field fallback", () => {
  const card = {
    key: "people/hero",
    content: "(raw hero:1.2)",
    negative: "raw bad",
    nai: {
      content: "1.2::hero::",
      negative: "lowres",
    },
  };
  assert.deepEqual(plain(buildNaiSlotRequest(card, "quality", "append")), {
    route: "/pm4a/api/nai/append-slot",
    body: { slot: "quality", value: "1.2::hero::", mode: "append" },
  });
  assert.deepEqual(plain(buildNaiSlotRequest(card, "negative", "replace")), {
    route: "/pm4a/api/nai/append-slot",
    body: { slot: "negative", value: "lowres", mode: "replace" },
  });
  assert.equal(rawTextForNaiSlot(card, "quality", "comfy"), "(raw hero:1.2)");
  assert.equal(rawTextForNaiSlot(card, "negative", "comfy"), "raw bad");
  assert.equal(
    rawTextForNaiSlot({ content: "(only comfy:1.2)" }, "quality", "nai"),
    "(only comfy:1.2)",
  );
  assert.equal(
    rawTextForNaiSlot({ nai: { content: "only nai" } }, "quality", "comfy"),
    "only nai",
  );
  assert.equal(
    rawTextForNaiSlot({
      content: "(fallback:1.2)",
      nai: { content: "   " },
    }, "quality", "nai"),
    "(fallback:1.2)",
  );
  assert.equal(
    rawTextForNaiSlot({
      negative: "fallback negative",
      nai: { negative: "\t" },
    }, "negative", "nai"),
    "fallback negative",
  );
  assert.equal(
    buildNaiSlotRequest({
      key: "styles/legacy",
      format: "txt_wildcard",
      wildcard_syntax: "__styles/legacy__",
      content: "preview must not send",
    }, "scene", "append").body.value,
    "__styles/legacy__",
  );
  assert.deepEqual(plain(buildNaiDocument("(raw positive:1.2)", "raw negative")), {
    tracks: [{
      id: "positive",
      name: "正面",
      text: "(raw positive:1.2)",
    }],
    positive: "(raw positive:1.2)",
    negative: "raw negative",
    characters: [],
  });
  assert.deepEqual(
    plain(buildNaiDocument("scene", "neg", [
      { positive: "hero", x: 0.2, y: 0.8 },
      { positive: "extra", negative: "bad", x: 0.6, y: 0.4 },
    ])),
    {
      tracks: [{ id: "positive", name: "正面", text: "scene" }],
      positive: "scene",
      negative: "neg",
      characters: [
        {
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
        },
        {
          id: "char-2",
          name: "角色 2",
          enabled: true,
          positive: "extra",
          negative: "bad",
          mode: "sequence",
          use_position: true,
          x: 0.6,
          y: 0.4,
          use_order: true,
        },
      ],
    },
  );
  assert.deepEqual(
    plain(buildNaiDocument("scene", "", [
      { positive: "hero", x: 0.2, y: 0.8 },
      { positive: "auto" },
    ])).characters.map((character) => character.use_position),
    [true, false],
  );
});

test("action conversion chooses endpoint and batches only fields that need fallback", async () => {
  assert.equal(
    conversionEndpointForMode("comfy"),
    "/pm4a/api/convert/nai-to-anima",
  );
  assert.equal(
    conversionEndpointForMode("nai"),
    "/pm4a/api/convert/anima-to-nai",
  );

  const calls = [];
  const request = async (route, options) => {
    calls.push([route, JSON.parse(options.body)]);
    return { results: [{ text: "converted positive" }, { text: "converted negative" }] };
  };
  const raw = ["raw positive", "raw negative"];
  const result = await convertTextsForAction(request, "comfy", raw, {
    format: "json_card",
    nai: { content: "raw positive", negative: "raw negative" },
  }, ["content", "negative"]);

  assert.deepEqual(calls, [[
    "/pm4a/api/convert/nai-to-anima",
    { texts: raw },
  ]]);
  assert.deepEqual(result, {
    texts: ["converted positive", "converted negative"],
    error: null,
    skipped: false,
  });
  assert.deepEqual(raw, ["raw positive", "raw negative"]);
});

test("action conversion converts only the fields that lack native text", async () => {
  const calls = [];
  const request = async (route, options) => {
    calls.push(JSON.parse(options.body));
    return { results: [{ text: "converted content" }] };
  };
  const result = await convertTextsForAction(
    request,
    "nai",
    ["comfy content", "already nai negative"],
    {
      format: "json_card",
      content: "comfy content",
      nai: { negative: "already nai negative" },
    },
    ["content", "negative"],
  );
  assert.deepEqual(result, {
    texts: ["converted content", "already nai negative"],
    error: null,
    skipped: false,
  });
  assert.deepEqual(calls, [{ texts: ["comfy content"] }]);
});

test("action conversion falls back to raw text when conversion fails", async () => {
  const raw = ["draft (positive:1.2)", "draft negative"];
  const result = await convertTextsForAction(async () => {
    throw Object.assign(new Error("HTTP 413"), { status: 413 });
  }, "nai", raw, { format: "json_card", content: "draft (positive:1.2)" });
  assert.deepEqual(result.texts, raw);
  assert.match(result.error.message, /413/);
  assert.equal(result.skipped, false);
});

test("plain Comfy action returns raw text without issuing a conversion request", async () => {
  let calls = 0;
  const result = await convertTextsForAction(async () => {
    calls += 1;
    throw new Error("must not request");
  }, "comfy", ["{red|blue}", "__folder/raw__"], {
    format: "json_card",
    nai: {},
  });
  const raw = ["{red|blue}", "__folder/raw__"];
  assert.equal(calls, 0);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.texts, raw);
});

test("Comfy NAI cards and NAI mode call only their directional endpoint", async () => {
  const calls = [];
  const request = async (route, options) => {
    calls.push([route, JSON.parse(options.body)]);
    return { results: [{ text: "converted" }] };
  };
  await convertTextsForAction(request, "comfy", ["1.2::red ::"], {
    format: "json_card",
    nai: { content: "1.2::red ::" },
  }, ["content"]);
  await convertTextsForAction(request, "nai", ["(red:1.2)"], {
    format: "json_card",
    content: "(red:1.2)",
  }, ["content"]);
  assert.deepEqual(calls.map(([route]) => route), [
    "/pm4a/api/convert/nai-to-anima",
    "/pm4a/api/convert/anima-to-nai",
  ]);
});

test("promptFieldProvenance distinguishes native text from converted fallbacks", () => {
  const dual = {
    format: "json_card",
    content: "comfy",
    negative: "comfy-neg",
    nai: { content: "nai", negative: "nai-neg" },
  };
  assert.deepEqual(
    promptFieldProvenance(dual, "nai", "content"),
    { source: "native", origin: null },
  );
  assert.deepEqual(
    promptFieldProvenance(dual, "comfy", "negative"),
    { source: "native", origin: null },
  );

  const comfyOnly = { format: "json_card", content: "(hero:1.2)", negative: "bad" };
  assert.deepEqual(
    promptFieldProvenance(comfyOnly, "nai", "content"),
    { source: "converted", origin: "comfy" },
  );
  assert.deepEqual(
    promptFieldProvenance(comfyOnly, "comfy", "content"),
    { source: "native", origin: null },
  );

  const naiOnly = { format: "json_card", nai: { content: "1.2::hero::" } };
  assert.deepEqual(
    promptFieldProvenance(naiOnly, "comfy", "content"),
    { source: "converted", origin: "nai" },
  );
  assert.deepEqual(
    promptFieldProvenance(naiOnly, "nai", "negative"),
    { source: "empty", origin: null },
  );
  assert.deepEqual(
    promptFieldProvenance(naiOnly, "comfy", "content", {
      contentDirty: true,
      content: "(hero:1.38)",
    }),
    { source: "draft-native", origin: "nai" },
  );
  assert.deepEqual(
    promptFieldProvenance(dual, "comfy", "content", {
      contentDirty: true,
      content: "edited",
    }),
    { source: "native", origin: null },
  );
  assert.deepEqual(
    promptFieldProvenance({ format: "txt_wildcard", content: "{a|b}" }, "nai", "content"),
    { source: "native", origin: null },
  );
  assert.equal(
    promptFieldSourceDisplay({ source: "converted", origin: "nai" }).label,
    "由 NAI 转换",
  );
  assert.equal(
    promptFieldSourceDisplay({ source: "draft-native", origin: "comfy" }).label,
    "将保存为独立提示词",
  );
});

test("resolveEntryTextsForMode keeps native fields and converts only empty fallbacks", async () => {
  const calls = [];
  const request = async (route, options) => {
    const body = JSON.parse(options.body);
    calls.push([route, body]);
    return { results: body.texts.map(() => ({ text: "converted nai" })) };
  };

  const native = await resolveEntryTextsForMode(request, {
    format: "json_card",
    content: "comfy",
    negative: "comfy-neg",
    nai: { content: "nai", negative: "nai-neg" },
  }, "nai");
  assert.deepEqual(native, { texts: ["nai", "nai-neg"], error: null, converted: false });
  assert.equal(calls.length, 0);

  const partial = await resolveEntryTextsForMode(request, {
    format: "json_card",
    content: "(hero:1.2)",
    negative: "bad",
    nai: { negative: "lowres" },
  }, "nai");
  assert.deepEqual(partial, {
    texts: ["converted nai", "lowres"],
    error: null,
    converted: true,
  });
  assert.deepEqual(calls, [[
    "/pm4a/api/convert/anima-to-nai",
    { texts: ["(hero:1.2)"] },
  ]]);

  calls.length = 0;
  const comfyFallback = await resolveEntryTextsForMode(request, {
    format: "json_card",
    nai: { content: "1.2::hero::", negative: "lowres" },
  }, "comfy");
  assert.equal(calls[0][0], "/pm4a/api/convert/nai-to-anima");
  assert.deepEqual(comfyFallback.texts, ["converted nai", "converted nai"]);
  assert.equal(comfyFallback.converted, true);
});

test("resolveEntryTextsForMode uses raw fallback text when conversion fails", async () => {
  const failure = new Error("bad syntax");
  const result = await resolveEntryTextsForMode(async () => {
    throw failure;
  }, {
    format: "json_card",
    content: "(hero:1.2)",
    negative: "bad",
  }, "nai");
  assert.deepEqual(result.texts, ["(hero:1.2)", "bad"]);
  assert.equal(result.error, failure);
  assert.equal(result.converted, false);
});

test("resolveEntryTextsForMode never converts TXT option previews", async () => {
  let calls = 0;
  const result = await resolveEntryTextsForMode(async () => {
    calls += 1;
    throw new Error("must not request");
  }, {
    format: "txt_wildcard",
    content: "{red|blue}\n__nested__",
    negative: "",
  }, "nai");
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    texts: ["{red|blue}\n__nested__", ""],
    error: null,
    converted: false,
  });
});
