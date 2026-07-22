/** Shared LoRA helpers for JSON-card library editing (LM pick-only). */

const LORA_TAG_RE = /<lora:([^>:]+)(?::([^>]*))?>/gi;

export function emptyLoraPayload() {
  return { text: "", hashes: [] };
}

export function loraNameFromFile(fileName) {
  const base = String(fileName || "").replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.(?:safetensors|ckpt|pt|pth|bin)$/i, "").trim();
}

export function normalizeLoraStrength(value, fallback = 1) {
  const weight = Number(value);
  if (!Number.isFinite(weight)) {
    const fallbackWeight = Number(fallback);
    return Number.isFinite(fallbackWeight) ? fallbackWeight : 1;
  }
  // Keep a practical range used by most LoRA loaders / LM tips.
  return Math.max(-2, Math.min(2, Math.round(weight * 100) / 100));
}

export function formatLoraStrength(value, fallback = 1) {
  const weight = normalizeLoraStrength(value, fallback);
  return Number.isInteger(weight) ? String(weight) : String(weight);
}

export function buildLoraTag(name, strength = 1) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return "";
  return `<lora:${cleanName}:${formatLoraStrength(strength)}>`;
}

export function withLoraStrength(entry, strength) {
  const name = String(entry?.name || "").trim();
  const resolved = formatLoraStrength(strength, entry?.strength ?? 1);
  return {
    ...entry,
    name,
    strength: resolved,
    tag: buildLoraTag(name, resolved),
  };
}

export function parseLoraEntries(lora) {
  const text = typeof lora?.text === "string" ? lora.text : "";
  const hashes = Array.isArray(lora?.hashes) ? lora.hashes : [];
  const hashByName = new Map();
  for (const entry of hashes) {
    const name = String(entry?.name || "").trim();
    const hash = String(entry?.hash || "").trim();
    if (!name || !hash) continue;
    const key = loraNameFromFile(name).toLowerCase() || name.toLowerCase();
    hashByName.set(key, { name, hash });
  }
  const entries = [];
  const seen = new Set();
  for (const match of text.matchAll(LORA_TAG_RE)) {
    const tag = String(match[0] || "").trim();
    const name = String(match[1] || "").trim();
    const strength = String(match[2] ?? "").trim() || "1";
    if (!tag || !name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = hashByName.get(key)
      || [...hashByName.values()].find((item) => loraNameFromFile(item.name).toLowerCase() === key)
      || null;
    entries.push({
      tag,
      name,
      strength,
      hash: meta?.hash || "",
      hashName: meta?.name || name,
    });
  }
  return entries;
}

export function entriesToLoraPayload(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tags = [];
  const hashes = [];
  const seen = new Set();
  for (const entry of list) {
    const name = String(entry?.name || "").trim();
    const hash = String(entry?.hash || "").trim();
    const hashName = String(entry?.hashName || name || "").trim();
    const tag = buildLoraTag(name, entry?.strength);
    if (!tag || !name || !hash) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    hashes.push({ name: hashName, hash });
  }
  if (!tags.length) return emptyLoraPayload();
  return { text: tags.join(" "), hashes };
}

export function loraPayloadEqual(left, right) {
  const a = entriesToLoraPayload(parseLoraEntries(left));
  const b = entriesToLoraPayload(parseLoraEntries(right));
  return a.text === b.text
    && JSON.stringify(a.hashes) === JSON.stringify(b.hashes);
}

let loraManagerAvailable = null;
let loraManagerCheckedAt = 0;

export async function detectLoraManager({ force = false } = {}) {
  const now = Date.now();
  if (!force && loraManagerAvailable !== null && now - loraManagerCheckedAt < 30_000) {
    return loraManagerAvailable;
  }
  try {
    const response = await fetch("/api/lm/loras/list?page=1&page_size=1", {
      cache: "no-store",
    });
    loraManagerAvailable = response.ok;
  } catch (_) {
    loraManagerAvailable = false;
  }
  loraManagerCheckedAt = now;
  return loraManagerAvailable;
}

export async function searchLoraManager(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({
    page: "1",
    page_size: String(Math.max(1, Math.min(50, limit))),
    fuzzy_search: "true",
  });
  const cleaned = String(query || "").trim();
  if (cleaned) params.set("search", cleaned);
  const response = await fetch(`/api/lm/loras/list?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`LoRA Manager HTTP ${response.status}`);
  const payload = await response.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map((item) => {
    const fileName = String(item?.file_name || item?.name || "").trim();
    const relativePath = String(
      item?.relative_path || item?.path || item?.filename || fileName,
    ).trim();
    const name = loraNameFromFile(fileName || relativePath);
    const hash = String(item?.sha256 || item?.hash || "").trim();
    return {
      fileName,
      relativePath,
      name,
      hash,
      previewUrl: item?.preview_url || item?.previewUrl || "",
    };
  }).filter((item) => item.name && item.hash);
}

export async function defaultLoraStrength(relativePath) {
  if (!relativePath) return 1;
  try {
    const response = await fetch(
      `/api/lm/loras/usage-tips-by-path?relative_path=${encodeURIComponent(relativePath)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return 1;
    const payload = await response.json();
    const tips = payload?.usage_tips || payload?.usageTips || payload;
    const strength = Number(
      tips?.strength ?? tips?.weight ?? tips?.model_strength ?? tips?.modelStrength,
    );
    return Number.isFinite(strength) ? strength : 1;
  } catch (_) {
    return 1;
  }
}

export async function pickLoraFromManagerItem(item, strength = null) {
  const defaultStrength = await defaultLoraStrength(item.relativePath || item.fileName);
  const resolved = formatLoraStrength(
    strength == null || strength === "" ? defaultStrength : strength,
    defaultStrength,
  );
  return {
    tag: buildLoraTag(item.name, resolved),
    name: item.name,
    strength: resolved,
    hash: item.hash,
    hashName: item.fileName || item.name,
    defaultStrength: formatLoraStrength(defaultStrength),
  };
}

/** Exact name match only (case-insensitive). Returns null when not found. */
export async function pickExactLoraFromManager(name, strength = null) {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const items = await searchLoraManager(wanted, { limit: 50 });
  const item = items.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
  if (!item) return null;
  return pickLoraFromManagerItem(item, strength);
}
