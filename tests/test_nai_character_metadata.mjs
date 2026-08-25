import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataModuleUrl = pathToFileURL(
  path.join(root, "web", "browser", "image_prompt_metadata.js"),
).href;

const {
  buildNovelAICharacters,
  clampNovelAICoordinate,
  novelAISettingsFromComment,
  parseNovelAI,
  parsePromptDocument,
} = await import(metadataModuleUrl);

function novelAIMetadata(comment, extra = {}) {
  return {
    Software: "NovelAI",
    Comment: typeof comment === "string" ? comment : JSON.stringify(comment),
    ...extra,
  };
}

function characterTemplate(index, overrides = {}) {
  return {
    id: `char-${index}`,
    name: `角色 ${index}`,
    enabled: true,
    positive: "",
    negative: "",
    mode: "sequence",
    use_position: false,
    x: 0.5,
    y: 0.5,
    use_order: false,
    ...overrides,
  };
}

test("parseNovelAI pairs two characters with base-only positive and negative", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: {
      caption: {
        base_caption: "base positive",
        char_captions: [
          { char_caption: "alice positive" },
          { char_caption: "bob positive" },
        ],
      },
      use_coords: false,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: {
        base_caption: "base negative",
        char_captions: [
          { char_caption: "alice negative" },
          { char_caption: "bob negative" },
        ],
      },
    },
  }));

  assert.ok(doc);
  assert.equal(doc.positive, "base positive");
  assert.equal(doc.negative, "base negative");
  assert.equal(doc.tracks.length, 1);
  assert.equal(doc.tracks[0].text, "base positive");
  assert.doesNotMatch(doc.positive, /char1:/i);
  assert.doesNotMatch(doc.tracks[0].text, /char1:/i);
  assert.deepEqual(doc.characters, [
    characterTemplate(1, {
      positive: "alice positive",
      negative: "alice negative",
      use_order: true,
    }),
    characterTemplate(2, {
      positive: "bob positive",
      negative: "bob negative",
      use_order: true,
    }),
  ]);
});

test("parseNovelAI pairs extra positive captions with empty negatives", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: {
      caption: {
        base_caption: "scene",
        char_captions: [
          { char_caption: "only positive" },
          { char_caption: "second positive" },
        ],
      },
    },
    v4_negative_prompt: {
      caption: {
        base_caption: "scene neg",
        char_captions: [{ char_caption: "only negative" }],
      },
    },
  }));

  assert.deepEqual(doc.characters, [
    characterTemplate(1, {
      positive: "only positive",
      negative: "only negative",
    }),
    characterTemplate(2, {
      positive: "second positive",
      negative: "",
    }),
  ]);
});

test("parseNovelAI pairs extra negative captions with empty positives", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: {
      caption: {
        base_caption: "scene",
        char_captions: [{ char_caption: "only positive" }],
      },
    },
    v4_negative_prompt: {
      caption: {
        base_caption: "scene neg",
        char_captions: [
          { char_caption: "only negative" },
          { char_caption: "second negative" },
        ],
      },
    },
  }));

  assert.deepEqual(doc.characters, [
    characterTemplate(1, {
      positive: "only positive",
      negative: "only negative",
    }),
    characterTemplate(2, {
      positive: "",
      negative: "second negative",
    }),
  ]);
});

test("buildNovelAICharacters applies coords only from positive captions", () => {
  const characters = buildNovelAICharacters(
    {
      char_captions: [
        {
          char_caption: " pos ",
          centers: [{ x: 0.2, y: 0.8 }],
        },
      ],
    },
    {
      char_captions: [
        {
          char_caption: " neg ",
          centers: [{ x: 0.9, y: 0.1 }],
        },
      ],
    },
    { use_coords: true, use_order: false },
  );

  assert.deepEqual(characters, [
    characterTemplate(1, {
      positive: "pos",
      negative: "neg",
      use_position: true,
      x: 0.2,
      y: 0.8,
    }),
  ]);
});

test("buildNovelAICharacters clamps coordinates and rejects invalid centers", () => {
  assert.equal(clampNovelAICoordinate(1.5), 1);
  assert.equal(clampNovelAICoordinate(-0.25), 0);
  assert.equal(clampNovelAICoordinate(Number.NaN), 0.5);

  const clamped = buildNovelAICharacters(
    {
      char_captions: [
        { char_caption: "a", centers: [{ x: 1.5, y: -0.1 }] },
        { char_caption: "b", centers: [{ x: Number.NaN, y: 0.4 }] },
      ],
    },
    { char_captions: [] },
    { use_coords: true, use_order: true },
  );

  assert.deepEqual(clamped, [
    characterTemplate(1, {
      positive: "a",
      use_position: true,
      x: 1,
      y: 0,
      use_order: true,
    }),
    characterTemplate(2, {
      positive: "b",
      use_position: false,
      use_order: true,
    }),
  ]);
});

test("buildNovelAICharacters ignores negative coords and order flags", () => {
  const characters = buildNovelAICharacters(
    {
      char_captions: [{ char_caption: "pos" }],
    },
    {
      char_captions: [{ char_caption: "neg" }],
      use_coords: true,
      use_order: true,
    },
    { use_coords: false, use_order: true },
  );

  assert.deepEqual(characters, [
    characterTemplate(1, {
      positive: "pos",
      negative: "neg",
      use_order: true,
    }),
  ]);
});

test("parseNovelAI falls back to legacy prompt fields without characters", () => {
  const doc = parseNovelAI(novelAIMetadata({
    prompt: "legacy positive",
    uc: "legacy negative",
    request_type: "PromptGenerateRequest",
  }, {
    Description: "ignored when prompt exists",
  }));

  assert.equal(doc.positive, "legacy positive");
  assert.equal(doc.negative, "legacy negative");
  assert.deepEqual(doc.characters, []);
  assert.doesNotMatch(doc.positive, /char1:/i);
});

test("parseNovelAI accepts parsed Comment objects like stealth metadata", () => {
  const doc = parseNovelAI({
    Software: "NovelAI",
    Comment: {
      v4_prompt: {
        caption: {
          base_caption: "base",
          char_captions: [{ char_caption: "hero" }],
        },
      },
      v4_negative_prompt: {
        caption: {
          base_caption: "neg base",
          char_captions: [{ char_caption: "hero neg" }],
        },
      },
    },
  });

  assert.equal(doc.positive, "base");
  assert.deepEqual(doc.characters, [
    characterTemplate(1, {
      positive: "hero",
      negative: "hero neg",
    }),
  ]);
});

test("parseNovelAI with v4 captions but no char entries returns empty characters", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: { caption: { base_caption: "only base" } },
    v4_negative_prompt: { caption: { base_caption: "only neg" } },
  }));

  assert.equal(doc.positive, "only base");
  assert.equal(doc.negative, "only neg");
  assert.deepEqual(doc.characters, []);
});

test("parsePromptDocument preserves characters and defaults missing characters to []", () => {
  const withCharacters = parsePromptDocument(JSON.stringify({
    source_type: "novelai",
    tracks: [{ id: "positive", name: "正面", text: "base" }],
    positive: "base",
    negative: "neg",
    characters: [characterTemplate(1, { positive: "hero" })],
  }));
  assert.deepEqual(withCharacters.characters, [
    characterTemplate(1, { positive: "hero" }),
  ]);

  const withoutCharacters = parsePromptDocument(JSON.stringify({
    source_type: "generic",
    tracks: [{ id: "positive", name: "正面", text: "hello" }],
    positive: "hello",
    negative: "",
  }));
  assert.deepEqual(withoutCharacters.characters, []);
});

test("parseNovelAI does not flatten character captions into positive text", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: {
      caption: {
        base_caption: "masterpiece",
        char_captions: [{ char_caption: "1girl, solo" }],
      },
    },
    v4_negative_prompt: {
      caption: { base_caption: "lowres" },
    },
  }));

  assert.equal(doc.positive, "masterpiece");
  assert.notEqual(doc.positive, "masterpiece\nchar1: 1girl, solo");
  assert.equal(doc.tracks[0].text, "masterpiece");
});

test("parseNovelAI returns document for characters-only metadata with empty base", () => {
  const doc = parseNovelAI(novelAIMetadata({
    v4_prompt: {
      caption: {
        char_captions: [{ char_caption: "solo heroine" }],
      },
    },
    v4_negative_prompt: {
      caption: {
        char_captions: [{ char_caption: "bad hands" }],
      },
    },
  }));

  assert.ok(doc);
  assert.equal(doc.positive, "");
  assert.equal(doc.negative, "");
  assert.deepEqual(doc.tracks, []);
  assert.deepEqual(doc.characters, [
    characterTemplate(1, {
      positive: "solo heroine",
      negative: "bad hands",
    }),
  ]);
});

test("parseNovelAI applies independent legacy fallback per empty v4 base field", () => {
  const doc = parseNovelAI(novelAIMetadata({
    prompt: "legacy positive only",
    uc: "legacy negative only",
    v4_prompt: {
      caption: {
        char_captions: [{ char_caption: "hero" }],
      },
    },
    v4_negative_prompt: {
      caption: {
        base_caption: "v4 negative base",
      },
    },
  }));

  assert.equal(doc.positive, "legacy positive only");
  assert.equal(doc.negative, "v4 negative base");
  assert.deepEqual(doc.characters, [
    characterTemplate(1, { positive: "hero", negative: "" }),
  ]);
});

test("parseNovelAI does not block positive legacy when only negative v4 caption exists", () => {
  const doc = parseNovelAI(novelAIMetadata({
    prompt: "scene from legacy",
    uc: "legacy uc",
    v4_negative_prompt: {
      caption: {
        base_caption: "v4 neg",
        char_captions: [{ char_caption: "char neg" }],
      },
    },
  }, {
    Description: "description fallback",
  }));

  assert.equal(doc.positive, "scene from legacy");
  assert.equal(doc.negative, "v4 neg");
  assert.deepEqual(doc.characters, [
    characterTemplate(1, { positive: "", negative: "char neg" }),
  ]);
});

test("parseNovelAI falls back Description and negative_prompt independently", () => {
  const doc = parseNovelAI(novelAIMetadata({
    negative_prompt: "legacy neg prompt",
    v4_prompt: {
      caption: {
        char_captions: [{ char_caption: "hero" }],
      },
    },
    v4_negative_prompt: {
      caption: {},
    },
  }, {
    Description: "description positive",
  }));

  assert.equal(doc.positive, "description positive");
  assert.equal(doc.negative, "legacy neg prompt");
});

test("buildNovelAICharacters ignores centers when use_coords is false", () => {
  const characters = buildNovelAICharacters(
    {
      char_captions: [
        { char_caption: "hero", centers: [{ x: 0.1, y: 0.9 }] },
      ],
    },
    { char_captions: [] },
    { use_coords: false },
  );

  assert.deepEqual(characters, [
    characterTemplate(1, {
      positive: "hero",
      use_position: false,
      x: 0.5,
      y: 0.5,
    }),
  ]);
});

test("buildNovelAICharacters treats empty or missing centers as disabled position", () => {
  const emptyCenters = buildNovelAICharacters(
    {
      char_captions: [
        { char_caption: "a", centers: [] },
        { char_caption: "b" },
      ],
    },
    { char_captions: [] },
    { use_coords: true },
  );

  assert.deepEqual(emptyCenters, [
    characterTemplate(1, { positive: "a" }),
    characterTemplate(2, { positive: "b" }),
  ]);
});

test("buildNovelAICharacters uses only the first center entry", () => {
  const characters = buildNovelAICharacters(
    {
      char_captions: [{
        char_caption: "hero",
        centers: [{ x: 0.2, y: 0.3 }, { x: 0.9, y: 0.1 }],
      }],
    },
    { char_captions: [] },
    { use_coords: true },
  );

  assert.deepEqual(characters, [
    characterTemplate(1, {
      positive: "hero",
      use_position: true,
      x: 0.2,
      y: 0.3,
    }),
  ]);
});

test("novelAISettingsFromComment maps Comment sampling fields onto nai.parameters", () => {
  assert.deepEqual(novelAISettingsFromComment({
    steps: "28.9",
    scale: "5.5",
    cfg: 99,
    sampler: " k_euler_ancestral ",
    noise_schedule: " karras ",
    scheduler: "native",
    cfg_rescale: "0.2",
    width: "832.2",
    height: 1216,
  }), {
    parameters: {
      steps: 28,
      cfg: 5.5,
      sampler: "k_euler_ancestral",
      scheduler: "karras",
      cfg_rescale: 0.2,
      width: 832,
      height: 1216,
    },
  });
  assert.deepEqual(novelAISettingsFromComment({
    cfg: 7,
    scheduler: "native",
  }), {
    parameters: {
      cfg: 7,
      scheduler: "native",
    },
  });
  assert.deepEqual(novelAISettingsFromComment({
    steps: "nope",
    sampler: "  ",
    cfg_rescale: Number.NaN,
  }), {});
  assert.deepEqual(novelAISettingsFromComment(null), {});
});

test("parseNovelAI stores Comment steps/scale/sampler/noise_schedule/cfg_rescale as document.nai.parameters", () => {
  const doc = parseNovelAI(novelAIMetadata({
    steps: 23,
    scale: 5,
    sampler: "k_euler",
    noise_schedule: "karras",
    cfg_rescale: 0,
    v4_prompt: {
      caption: {
        base_caption: "base positive",
        char_captions: [{ char_caption: "alice" }],
      },
    },
    v4_negative_prompt: {
      caption: {
        base_caption: "base negative",
        char_captions: [{ char_caption: "alice neg" }],
      },
    },
  }));

  assert.ok(doc);
  assert.equal(doc.positive, "base positive");
  assert.deepEqual(doc.characters, [
    characterTemplate(1, { positive: "alice", negative: "alice neg" }),
  ]);
  assert.deepEqual(doc.nai, {
    parameters: {
      steps: 23,
      cfg: 5,
      sampler: "k_euler",
      scheduler: "karras",
      cfg_rescale: 0,
    },
  });
});

test("parseNovelAI extracts nai.parameters from a parsed Comment object", () => {
  const doc = parseNovelAI({
    Software: "NovelAI",
    Comment: {
      prompt: "legacy positive",
      uc: "legacy negative",
      steps: 28,
      cfg: 4.5,
      sampler: "k_dpmpp_2m",
      scheduler: "exponential",
      cfg_rescale: 0.3,
    },
  });

  assert.equal(doc.positive, "legacy positive");
  assert.deepEqual(doc.nai.parameters, {
    steps: 28,
    cfg: 4.5,
    sampler: "k_dpmpp_2m",
    scheduler: "exponential",
    cfg_rescale: 0.3,
  });
});

test("parseNovelAI omits nai.parameters when Comment has no sampling fields", () => {
  const doc = parseNovelAI(novelAIMetadata({
    prompt: "legacy positive",
    uc: "legacy negative",
  }));
  assert.equal(doc.nai, undefined);
});

test("parsePromptDocument preserves native NAI text, characters, and parameters", () => {
  const characters = [{ positive: "hero", negative: "bad hands", x: 0.2, y: 0.8 }];
  const parsed = parsePromptDocument(JSON.stringify({
    source_type: "novelai",
    tracks: [{ id: "positive", name: "正面", text: "base" }],
    positive: "base",
    negative: "neg",
    nai: {
      content: "{{native}}",
      negative: "[native bad]",
      characters,
      parameters: {
        steps: 28,
        cfg: 5.5,
        sampler: "k_euler",
        scheduler: "karras",
        cfg_rescale: 0.2,
      },
    },
  }));
  assert.deepEqual(parsed.nai, {
    content: "{{native}}",
    negative: "[native bad]",
    characters,
    parameters: {
      steps: 28,
      cfg: 5.5,
      sampler: "k_euler",
      scheduler: "karras",
      cfg_rescale: 0.2,
    },
  });
});
