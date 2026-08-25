import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(
  path.join(root, "web", "browser", "image_drop.js"),
).href;

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
globalThis.location = new URL("http://127.0.0.1:8000/");

const { imageFileFromTransfer } = await import(moduleUrl);

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation === undefined) delete globalThis.location;
  else globalThis.location = originalLocation;
});

test("local file wins over URI without fetching the same image again", async () => {
  const localFile = { name: "card.png", type: "image/png", size: 128 };
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("local file should avoid URI fetch");
  };

  const result = await imageFileFromTransfer({
    files: [localFile],
    items: [],
    types: ["Files", "text/uri-list"],
    getData(type) {
      return type === "text/uri-list"
        ? "http://127.0.0.1:8000/view?filename=card.png&type=input"
        : "";
    },
  });

  assert.equal(result, localFile);
  assert.equal(fetchCalls, 0);
});

test("file item wins over URI when dataTransfer.files is empty", async () => {
  const itemFile = { name: "item-card.webp", type: "image/webp", size: 256 };
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("file item should avoid URI fetch");
  };

  const result = await imageFileFromTransfer({
    files: [],
    items: [{ kind: "file", getAsFile: () => itemFile }],
    types: ["Files", "text/uri-list"],
    getData(type) {
      return type === "text/uri-list"
        ? "http://127.0.0.1:8000/view?filename=item-card.webp&type=input"
        : "";
    },
  });

  assert.equal(result, itemFile);
  assert.equal(fetchCalls, 0);
});
