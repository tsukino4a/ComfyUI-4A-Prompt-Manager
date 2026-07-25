# Nested wildcards & sequential batching

[中文](wildcard-nesting.zh-CN.md)

In **sequence** mode, Prompt Scheduler counts and expands a **leaf space**, instead of sharing one `index % size` across every nesting level. This page covers the rules, common patterns, and pitfalls.

UI entry: **Prompt Scheduler** → set a track to sequence → **Count tasks** / **Run batch**.

---

## Rules at a glance

| Situation | Behavior |
|-----------|----------|
| Several candidates under one `__key__` (folder files, multi-line TXT, JSON cards) | **Sum**: exhaust each branch left-to-right |
| Candidate body contains more `__…__` | **Recurse** into nested refs with the same rules |
| Several `__a__, __b__` side by side in one track | **Product** (left = outer, right = inner) |
| Several sequence tracks | Each track has its own leaf length; job count = **max**; shorter tracks wrap; **no** cross-track product |
| `{a\|b}`, weights, `$$` multi-select, `N#__key__` | **Always random**; do not lengthen the sequential cycle |
| Random / shuffle tracks | Sample / shuffle over the leaf space (`{}` stays random) |

**Count tasks** uses the same leaf space as sequential expansion. `__key__` tokens inside `{}` do **not** count toward the sequential job total.

---

## Syntax sources

Impact-style parsing is built in:

- `__folder__` / `__path/file__` — library folder or single file  
- TXT — each non-empty line is a candidate; a line may be plain text or another `__…__`  
- JSON cards — `content` / `negative` may contain `__…__`; expansion also carries that card’s LoRAs, negatives, and sparse generation settings  
- `{a|b}`, `{2::a|1::b}`, `{2$$, $$a|b|c}`, `3#__key__` — choice / multi-pick; treated as random during batching  

TXT and JSON may nest into each other.

---

## Examples (check with Count tasks)

Abstract leaf names below; build matching folders/files in your library.

### 1. Same-track product

```text
__pool/a__, __pool/b__
```

If `a` → `a1,a2,a3` and `b` → `b1,b2`:

- Count: **6**
- Order:

```text
a1, b1 → a1, b2 → a2, b1 → a2, b2 → a3, b1 → a3, b2
```

### 2. Nested tree (branch sum)

`pack` has two candidates:

1. body `__pool/inner__` (`i1,i2`)  
2. body `plain`

Track: `__pool/pack__`

- Count: **3**
- Order: `i1 → i2 → plain`

### 3. Suite with multiple branches

`suite` points at `__pool/x__` (3 leaves) and `__pool/y__` (2 leaves):

- Count: **5**
- Order: all of x, then y  

Useful for “normal scenes / character scenes” recipes.

### 4. Outer cards × inner product

Two outer cards, each with content `__pool/a__, __pool/b__` (product 6):

Track: `__pool/outer__`

- Count: **12** (2×6)
- Order: full 6 steps, then the same 6 for the second card  

Typical: outer = LoRA/presets to compare; inner = scene × pose.

### 5. Tree × product in one body

One card content: `__pool/pack__, __pool/b__` (pack = 3, b = 2):

- Count: **6**
- Order: `i1,b1 → i1,b2 → i2,b1 → i2,b2 → plain,b1 → plain,b2`

### 6. Multi-line TXT, one wildcard per line

`menu.txt`:

```text
__pool/a__
__pool/b__
__pool/pack__
```

Track: `__pool/menu__` (or that file’s key)

- Count: sum of line leaf sizes (e.g. 3+2+3 = **8**)
- Order: finish a, then b, then pack  

A line may itself be `__a__, __b__` (that line contributes a product to the sum).

### 7. JSON nesting (same rules as TXT)

JSON is just another candidate carrier: multiple cards = branches; `__…__` in `content` = nesting.  
Cross-format: a JSON `content` of `__some_txt_pool__` still counts expanded leaves.

### 8. `{__a__|__b__}` is not a sequential union

```text
{__pool/a__|__pool/b__}
```

- Each run: **randomly** pick a or b, then **randomly** pick inside  
- Count: **0**  
- For ordered `a1→…→a3→b1→b2`, use multi-line TXT / multi-card folders (§6), not `{}`

### 9. `{red|blue}, __pool/a__`

- Count: only `a` (e.g. **3**)  
- `a` advances in sequence; color re-rolls every job  

### 10. Multiple tracks

- Track 1: `__pool/a__` (3)  
- Track 2: `__pool/b__` (2)  
- Count: **3** (max)  
- On job 3, track 2 wraps to `b1`; tracks do **not** form a 3×2 product  

---

## Practical recipes

**Compare LoRAs/presets × shared scenes**

1. Folder of JSON cards with different LoRAs; each `content` nests `__scenes__` or `__suite__`  
2. Suite splits into normal / character branches with further nesting  
3. One sequence track: `__your_lora_folder__` → Count → batch  

**Layered libraries**

- Top: style/character entry (JSON for LoRA binding)  
- Middle: suite TXT or multi-card folders  
- Bottom: concrete tag lines  

**Random seasoning**

- Put ordered axes on `__…__`  
- Put cycle-neutral variation in `{a|b}` / weights  

---

## Pitfalls

1. **Count matches expansion** — refresh the library after edits; restart ComfyUI after Python changes.  
2. **`{}` / `N#` do not add sequential length** — count **0** for brace-only tracks is expected.  
3. **Random is leaf-uniform** — large branches dominate; for “50/50 pick a folder first”, use `{__big__|__small__}`.  
4. **Duplicate keys** `__b__, __b__` form a product — rarely useful in prompts.  
5. **Newlines in JSON `content` ≠ TXT multi-line options** — one JSON card is still one candidate.  
6. Negatives / fixed negative tracks use the same wildcard rules.  

---

## See also

- English README: [README.md](../README.md) (Scheduler highlight)  
- Chinese doc: [wildcard-nesting.zh-CN.md](wildcard-nesting.zh-CN.md)
