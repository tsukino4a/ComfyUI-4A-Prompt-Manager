import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "web", "comfyui", "prompt_display.js");
const source = fs.readFileSync(frontend, "utf8");

const context = vm.createContext({
  app: { graph: null, registerExtension() {} },
  api: {},
  isScheduler(node) {
    return (node?.comfyClass || node?.type) === "Prompt Scheduler (4A Prompt Manager)";
  },
  t: (value) => String(value),
});

const executableSource = source
  .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
  .replace(/\bexport\s+/g, "");
new vm.Script(
  `${executableSource}
globalThis.__promptDisplayTestExports = {
  flattenNovelAIForPromptDisplay:
    typeof flattenNovelAIForPromptDisplay === "function"
      ? flattenNovelAIForPromptDisplay
      : null,
};`,
  { filename: frontend },
).runInContext(context);

const flattenNovelAIForPromptDisplay = context
  .__promptDisplayTestExports
  .flattenNovelAIForPromptDisplay;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Meta Loader flattens structured NovelAI characters into legacy prompt text", () => {
  assert.equal(typeof flattenNovelAIForPromptDisplay, "function");
  const original = {
    source_type: "novelai",
    tracks: [{ id: "positive", name: "正面", text: "base positive" }],
    positive: "base positive",
    negative: "base negative",
    characters: [
      { positive: "alice positive", negative: "alice negative" },
      { positive: "bob positive", negative: "" },
      { positive: "", negative: "carol negative" },
    ],
    nai: { parameters: { steps: 28 } },
  };

  const flattened = plain(flattenNovelAIForPromptDisplay(original));

  assert.equal(
    flattened.positive,
    "base positive\nchar1: alice positive\nchar2: bob positive",
  );
  assert.equal(
    flattened.negative,
    "base negative\nchar1: alice negative\nchar3: carol negative",
  );
  assert.equal(flattened.tracks[0].text, flattened.positive);
  assert.deepEqual(flattened.characters, []);
  assert.deepEqual(flattened.nai, original.nai);
  assert.equal(original.positive, "base positive");
  assert.equal(original.tracks[0].text, "base positive");
  assert.equal(original.characters.length, 3);
});

test("Meta Loader creates the legacy positive track for character-only NovelAI metadata", () => {
  const flattened = plain(flattenNovelAIForPromptDisplay({
    source_type: "novelai",
    tracks: [],
    positive: "",
    negative: "",
    characters: [{ positive: "solo heroine", negative: "bad hands" }],
  }));

  assert.equal(flattened.positive, "char1: solo heroine");
  assert.equal(flattened.negative, "char1: bad hands");
  assert.deepEqual(flattened.tracks, [{
    id: "positive",
    name: "正面",
    text: "char1: solo heroine",
  }]);
  assert.deepEqual(flattened.characters, []);
});

test("Meta Loader leaves non-NovelAI documents unchanged", () => {
  const payload = {
    source_type: "4a",
    tracks: [{ id: "positive", name: "正面", text: "hello" }],
    positive: "hello",
    negative: "",
    characters: [{ positive: "kept for another consumer" }],
  };
  assert.equal(flattenNovelAIForPromptDisplay(payload), payload);
});

test("Meta Loader only targets the 4APM Prompt Scheduler", () => {
  assert.match(source, /connectedScheduler/);
  assert.match(source, /findSourceScheduler/);
  assert.match(source, /schedulerNodes/);
  assert.match(source, /__pm4aSchedulerReceiveTrack/);
  assert.match(source, /convertNovelAITexts/);
  assert.match(source, /applyPositiveFromPayload/);

  assert.doesNotMatch(source, /NAI_SCHEDULER_NODE_CLASS/);
  assert.doesNotMatch(source, /__pm4aNaiSchedulerReceive/);
  assert.doesNotMatch(source, /pm4aNaiDisplay/);
  assert.doesNotMatch(source, /pm4a-display-character-card/);
});
