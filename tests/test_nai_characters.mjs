import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(root, "web", "browser", "nai_characters.js")).href;
const {
  evenlyDistributedCharacterPositions,
  naiCharacterPromptHeight,
  normalizeNaiCharacters,
} = await import(moduleUrl);

const plain = (value) => JSON.parse(JSON.stringify(value));

test("character prompt height follows content with a compact minimum", () => {
  assert.equal(naiCharacterPromptHeight(0), 52);
  assert.equal(naiCharacterPromptHeight(36), 52);
  assert.equal(naiCharacterPromptHeight(80.2), 81);
  assert.equal(naiCharacterPromptHeight(Number.NaN), 52);
});

test("normalizeNaiCharacters strips document fields and maps prompt aliases", () => {
  assert.deepEqual(plain(normalizeNaiCharacters([
    {
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
      prompt: "ignored alias",
      negative_prompt: "ignored alias",
    },
    {
      prompt: "from prompt",
      negative_prompt: "from negative_prompt",
    },
    null,
    "skip",
    [],
  ])), [
    { positive: "hero", negative: "bad hands", x: 0.2, y: 0.8 },
    { positive: "from prompt", negative: "from negative_prompt" },
  ]);
});

test("automatic position omits x/y even when coordinates are present", () => {
  assert.deepEqual(plain(normalizeNaiCharacters([
    { positive: "a", x: 0.1, y: 0.9, use_position: false },
    { positive: "b", x: 0.2, y: 0.3, automatic: true },
  ])), [
    { positive: "a", negative: "" },
    { positive: "b", negative: "" },
  ]);
});

test("complete x/y pairs are clamped to 0..1", () => {
  assert.deepEqual(plain(normalizeNaiCharacters([
    { positive: "high", x: 1.5, y: -0.25 },
    { positive: "edge", x: 0, y: 1 },
    { positive: "string", x: "0.25", y: "0.75" },
  ])), [
    { positive: "high", negative: "", x: 1, y: 0 },
    { positive: "edge", negative: "", x: 0, y: 1 },
    { positive: "string", negative: "", x: 0.25, y: 0.75 },
  ]);
});

test("incomplete coordinates are dropped; complete pairs stay sparse per character", () => {
  assert.deepEqual(plain(normalizeNaiCharacters([
    { positive: "only-x", x: 0.2 },
    { positive: "nan", x: Number.NaN, y: 0.4 },
    { positive: "bool", x: false, y: 0.5 },
  ])), [
    { positive: "only-x", negative: "" },
    { positive: "nan", negative: "" },
    { positive: "bool", negative: "" },
  ]);
  assert.deepEqual(plain(normalizeNaiCharacters([
    { positive: "placed", x: 0.2, y: 0.8 },
    { positive: "auto" },
  ])), [
    { positive: "placed", negative: "", x: 0.2, y: 0.8 },
    { positive: "auto", negative: "" },
  ]);
});

test("evenlyDistributedCharacterPositions fills a clamped grid", () => {
  assert.deepEqual(evenlyDistributedCharacterPositions(0), []);
  assert.deepEqual(evenlyDistributedCharacterPositions(1), [{ x: 0.5, y: 0.5 }]);
  assert.deepEqual(evenlyDistributedCharacterPositions(2), [
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
  ]);
  assert.deepEqual(evenlyDistributedCharacterPositions(3), [
    { x: 0.25, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.25, y: 0.75 },
  ]);
  assert.deepEqual(evenlyDistributedCharacterPositions(4), [
    { x: 0.25, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.25, y: 0.75 },
    { x: 0.75, y: 0.75 },
  ]);
  assert.deepEqual(evenlyDistributedCharacterPositions(4, 4), [
    { x: 0.125, y: 0.5 },
    { x: 0.375, y: 0.5 },
    { x: 0.625, y: 0.5 },
    { x: 0.875, y: 0.5 },
  ]);
  assert.deepEqual(evenlyDistributedCharacterPositions(4, 0.25), [
    { x: 0.5, y: 0.125 },
    { x: 0.5, y: 0.375 },
    { x: 0.5, y: 0.625 },
    { x: 0.5, y: 0.875 },
  ]);
});
