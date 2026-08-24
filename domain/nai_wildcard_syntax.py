"""NovelAI-isolated, dependency-free wildcard parsing and expansion."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from random import Random
from typing import Any, Sequence

try:
    from .wildcard_syntax import (
        ExpansionContext,
        ExpansionResult,
        WildcardCandidate,
        WildcardResolutionError,
        WildcardResolver,
        WildcardSyntaxError,
    )
except ImportError:  # standalone preview
    from domain.wildcard_syntax import (  # type: ignore
        ExpansionContext,
        ExpansionResult,
        WildcardCandidate,
        WildcardResolutionError,
        WildcardResolver,
        WildcardSyntaxError,
    )


@dataclass(frozen=True)
class _Literal:
    text: str


@dataclass(frozen=True)
class _Reference:
    key: str
    position: int


_Node = _Literal | _Reference
_Sequence = tuple[_Node, ...]


@dataclass
class _RuntimeState:
    occurrences: dict[str, int]


@dataclass
class _ResultAccumulator:
    negatives: list[str]
    negative_keys: list[str]
    selected_keys: list[str]
    lora_texts: list[str]
    models_groups: list[tuple[dict[str, Any], ...]]
    parameters_list: list[dict[str, Any]]
    double_sample_list: list[dict[str, Any]]
    nai_list: list[dict[str, Any]]


_MODES = {"random", "sequence", "shuffle"}
_NAI_PARAMETER_KEYS = {
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "cfg_rescale",
    "width",
    "height",
}


def copy_nai_payload(value: Any) -> dict[str, Any]:
    """Copy one normalized NAI payload while enforcing its public whitelist."""
    if not isinstance(value, dict) or not value:
        return {}
    copied: dict[str, Any] = {}
    content = value.get("content")
    if isinstance(content, str) and content:
        copied["content"] = content
    negative = value.get("negative")
    if isinstance(negative, str) and negative:
        copied["negative"] = negative
    characters_raw = value.get("characters")
    if isinstance(characters_raw, list):
        characters: list[dict[str, Any]] = []
        for entry in characters_raw:
            character = _copy_nai_character(entry)
            if character:
                characters.append(character)
        if characters:
            copied["characters"] = characters
    parameters_raw = value.get("parameters")
    if isinstance(parameters_raw, dict):
        parameters = {
            key: raw
            for key, raw in parameters_raw.items()
            if key in _NAI_PARAMETER_KEYS
        }
        if parameters:
            copied["parameters"] = parameters
    return copied


def _copy_nai_character(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    copied: dict[str, Any] = {}
    positive = value.get("positive")
    if isinstance(positive, str) and positive:
        copied["positive"] = positive
    negative = value.get("negative")
    if isinstance(negative, str) and negative:
        copied["negative"] = negative
    if "x" in value and "y" in value:
        copied["x"] = value["x"]
        copied["y"] = value["y"]
    return copied


def merge_nai_payloads(*items: Any) -> dict[str, Any]:
    """Merge NAI payloads in selection order; first claims each sparse field."""
    content = ""
    negative = ""
    characters: list[dict[str, Any]] = []
    parameter_items: list[dict[str, Any]] = []
    for item in items:
        copied = copy_nai_payload(item)
        if not content:
            next_content = copied.get("content")
            if isinstance(next_content, str) and next_content:
                content = next_content
        if not negative:
            next_negative = copied.get("negative")
            if isinstance(next_negative, str) and next_negative:
                negative = next_negative
        next_characters = copied.get("characters")
        if isinstance(next_characters, list) and next_characters:
            characters.extend(dict(entry) for entry in next_characters)
        parameters = copied.get("parameters")
        if isinstance(parameters, dict) and parameters:
            parameter_items.append(parameters)
    merged: dict[str, Any] = {}
    if content:
        merged["content"] = content
    if negative:
        merged["negative"] = negative
    if characters:
        merged["characters"] = characters
    parameters = _merge_parameters(*parameter_items)
    if parameters:
        merged["parameters"] = parameters
    return merged


def _without_comment_lines(text: str) -> tuple[str, tuple[int, ...]]:
    kept: list[str] = []
    positions: list[int] = []
    offset = 0
    for line in text.splitlines(keepends=True):
        if not line.lstrip().startswith("#"):
            kept.append(line)
            positions.extend(range(offset, offset + len(line)))
        offset += len(line)
    return "".join(kept), tuple(positions)


def _position(source_positions: tuple[int, ...], index: int) -> int:
    if index < len(source_positions):
        return source_positions[index] + 1
    if source_positions:
        return source_positions[-1] + 2
    return index + 1


def _parse_reference(
    text: str,
    source_positions: tuple[int, ...],
    opening: int,
) -> tuple[_Reference, int]:
    index = opening
    while index < len(text) and text[index] == "_":
        index += 1
    key_start = index
    while index < len(text):
        if text[index] == "_" and index + 1 < len(text) and text[index + 1] == "_":
            break
        index += 1
    if index == len(text):
        message = "空通配符键" if key_start == index and index - opening >= 4 else "未闭合的通配符引用"
        raise WildcardSyntaxError(
            f"{message}，位置 {_position(source_positions, opening)}"
        )
    key = text[key_start:index].strip()
    if not key:
        raise WildcardSyntaxError(
            f"空通配符键，位置 {_position(source_positions, opening)}"
        )
    while index < len(text) and text[index] == "_":
        index += 1
    return (
        _Reference(key, _position(source_positions, opening)),
        index,
    )


def _is_ascii_digit(char: str) -> bool:
    return len(char) == 1 and "0" <= char <= "9"


def _n_hash_digit_start(text: str, opening: int) -> int | None:
    """Start of ASCII digit run when ``opening`` is ``__`` after ``#``."""
    if opening < 2 or text[opening - 1] != "#":
        return None
    pos = opening - 2
    if pos < 0 or not _is_ascii_digit(text[pos]):
        return None
    while pos >= 0 and _is_ascii_digit(text[pos]):
        pos -= 1
    return pos + 1


def _skip_n_hash_literal(text: str, opening: int) -> int:
    """Skip ``N#__path__`` literally, including malformed/unclosed spans."""
    index = opening + 2
    while index < len(text):
        if text[index : index + 2] == "__":
            index += 2
            while index < len(text) and text[index] == "_":
                index += 1
            return index
        index += 1
    return len(text)


def _scan(text: str, source_positions: tuple[int, ...]) -> _Sequence:
    nodes: list[_Node] = []
    literal_start = 0
    index = 0
    while index < len(text):
        if text[index : index + 2] == "__":
            if _n_hash_digit_start(text, index) is not None:
                index = _skip_n_hash_literal(text, index)
                continue
            if literal_start < index:
                nodes.append(_Literal(text[literal_start:index]))
            reference, index = _parse_reference(text, source_positions, index)
            nodes.append(reference)
            literal_start = index
            continue
        index += 1

    if literal_start < len(text):
        nodes.append(_Literal(text[literal_start:]))
    return tuple(nodes)


def parse(text: str) -> _Sequence:
    """Parse NAI wildcard text into literal and reference nodes."""
    if not isinstance(text, str):
        raise TypeError("wildcard text must be a string")
    uncommented, positions = _without_comment_lines(text)
    return _scan(uncommented, positions)


def reference_keys(text: str) -> tuple[str, ...]:
    """Return referenced keys in textual order without resolving them."""
    return tuple(
        node.key for node in parse(text) if isinstance(node, _Reference)
    )


def sequential_leaf_count(
    text: str,
    resolver: WildcardResolver,
    *,
    max_depth: int = 100,
    stack: tuple[str, ...] = (),
) -> int:
    """Size of the sequential leaf space for one NAI prompt text."""
    if not isinstance(text, str) or not text.strip():
        return 0
    if max_depth < 1:
        return 0
    return _leaf_count_nodes(parse(text), resolver, stack, max_depth)


def _product(sizes: Sequence[int]) -> int:
    total = 1
    for size in sizes:
        total *= size
    return total


def _decode_product_coords(index: int, sizes: Sequence[int]) -> tuple[int, ...]:
    if not sizes:
        return ()
    coords = [0] * len(sizes)
    remaining = int(index)
    for axis in range(len(sizes) - 1, -1, -1):
        size = sizes[axis]
        coords[axis] = remaining % size
        remaining //= size
    return tuple(coords)


def _leaf_count_nodes(
    nodes: _Sequence,
    resolver: WildcardResolver,
    stack: tuple[str, ...],
    max_depth: int,
) -> int:
    axes: list[int] = []
    for node in nodes:
        if isinstance(node, _Reference):
            count = _leaf_count_key(node.key, resolver, stack, max_depth)
            if count > 0:
                axes.append(count)
    if not axes:
        return 0
    return _product(axes)


def _option_stack_entry(candidate_key: str, option_index: int) -> str:
    return f"{candidate_key}#{option_index}"


def _leaf_count_key(
    key: str,
    resolver: WildcardResolver,
    stack: tuple[str, ...],
    max_depth: int,
) -> int:
    if not key or key in stack or len(stack) >= max_depth:
        return 0
    candidates = tuple(resolver.resolve(key))
    if not candidates:
        return 0
    next_stack = stack + (key,)
    total = 0
    for option_index, candidate in enumerate(candidates):
        nested = _leaf_count_nodes(
            parse(candidate.content),
            resolver,
            next_stack + (_option_stack_entry(candidate.key, option_index),),
            max_depth,
        )
        total += nested if nested > 0 else 1
    return total


def _pick_leaf_index(size: int, context: ExpansionContext) -> int:
    if size <= 0:
        return 0
    if context.mode == "sequence":
        return context.execution_index % size
    if context.mode == "shuffle":
        cycle, offset = divmod(context.execution_index, size)
        order = _shuffled_order(size, _shuffle_seed(context, cycle, "leaf-space"))
        return order[offset]
    return Random(_seed(context, 0, "leaf-space")).randrange(size)


def _seed(context: ExpansionContext, occurrence: int, purpose: str) -> int:
    payload = "\x1f".join(
        (
            str(context.seed),
            context.track_id,
            str(context.execution_index),
            str(occurrence),
            purpose,
        )
    )
    return int.from_bytes(sha256(payload.encode("utf-8")).digest(), "big")


def _shuffle_seed(context: ExpansionContext, cycle: int, purpose: str) -> int:
    payload = "\x1f".join(
        (str(context.seed), context.track_id, str(cycle), purpose)
    )
    return int.from_bytes(sha256(payload.encode("utf-8")).digest(), "big")


def _next_occurrence(
    state: _RuntimeState,
    purpose: str,
    amount: int = 1,
) -> int:
    occurrence = state.occurrences.get(purpose, 0)
    state.occurrences[purpose] = occurrence + amount
    return occurrence


def _select_indices(
    *,
    size: int,
    count: int,
    context: ExpansionContext,
    occurrence: int,
    purpose: str,
) -> tuple[int, ...]:
    if count > size:
        raise WildcardSyntaxError(
            f"多选数量 {count} 超过可用候选数 {size}"
        )
    if context.mode == "sequence":
        start = (context.execution_index + occurrence) % size
        return tuple((start + offset) % size for offset in range(count))
    if context.mode == "shuffle":
        absolute = context.execution_index + occurrence
        cycle, offset = divmod(absolute, size)
        shuffle_seed = _shuffle_seed(context, cycle, f"{purpose}:shuffle")
        order = _shuffled_order(size, shuffle_seed)
        return tuple(order[(offset + index) % size] for index in range(count))

    rng = Random(_seed(context, occurrence, f"{purpose}:random"))
    return tuple(rng.sample(range(size), count))


@lru_cache(maxsize=16)
def _shuffled_order(size: int, seed: int) -> tuple[int, ...]:
    order = list(range(size))
    Random(seed).shuffle(order)
    return tuple(order)


def _candidate_content(
    candidate: WildcardCandidate,
    reference: _Reference,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
    *,
    content_leaf_index: int | None,
) -> str:
    if candidate.key in stack:
        raise WildcardResolutionError(
            f"检测到循环通配符引用 {reference.key!r}，位置 {reference.position}"
        )
    if candidate.negative:
        accumulator.negatives.append(candidate.negative)
        accumulator.negative_keys.append(candidate.key)
    accumulator.selected_keys.append(candidate.key)
    if candidate.lora_text:
        accumulator.lora_texts.append(candidate.lora_text)
    if candidate.models:
        accumulator.models_groups.append(candidate.models)
    if candidate.parameters:
        accumulator.parameters_list.append(dict(candidate.parameters))
    if candidate.double_sample_parameters:
        accumulator.double_sample_list.append(dict(candidate.double_sample_parameters))
    if candidate.nai:
        accumulator.nai_list.append(copy_nai_payload(candidate.nai))
    return _expand_nodes(
        parse(candidate.content),
        resolver,
        context,
        state,
        accumulator,
        stack + (candidate.key,),
        leaf_index=content_leaf_index,
    )


def _resolve_reference(
    reference: _Reference,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
) -> str:
    if len(stack) >= context.max_depth:
        raise WildcardResolutionError(
            f"通配符引用超过最大深度 {context.max_depth}，位置 {reference.position}"
        )
    candidates = tuple(resolver.resolve(reference.key))
    if not candidates:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )
    purpose = f"wildcard:{reference.key}"
    occurrence = _next_occurrence(state, purpose)
    chosen = _select_indices(
        size=len(candidates),
        count=1,
        context=context,
        occurrence=occurrence,
        purpose=purpose,
    )[0]
    return _candidate_content(
        candidates[chosen],
        reference,
        resolver,
        context,
        state,
        accumulator,
        stack,
        content_leaf_index=None,
    )


def _resolve_reference_at_leaf(
    reference: _Reference,
    leaf_index: int,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
) -> str:
    if len(stack) >= context.max_depth:
        raise WildcardResolutionError(
            f"通配符引用超过最大深度 {context.max_depth}，位置 {reference.position}"
        )
    if reference.key in stack:
        raise WildcardResolutionError(
            f"检测到循环通配符引用 {reference.key!r}，位置 {reference.position}"
        )
    candidates = tuple(resolver.resolve(reference.key))
    if not candidates:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )

    next_stack = stack + (reference.key,)
    remaining = int(leaf_index)
    for option_index, candidate in enumerate(candidates):
        nested = _leaf_count_nodes(
            parse(candidate.content),
            resolver,
            next_stack + (_option_stack_entry(candidate.key, option_index),),
            context.max_depth,
        )
        branch_size = nested if nested > 0 else 1
        if remaining < branch_size:
            return _candidate_content(
                candidate,
                reference,
                resolver,
                context,
                state,
                accumulator,
                stack,
                content_leaf_index=remaining if nested > 0 else None,
            )
        remaining -= branch_size

    total = _leaf_count_key(reference.key, resolver, stack, context.max_depth)
    if total <= 0:
        raise WildcardResolutionError(
            f"无法解析通配符 {reference.key!r}，位置 {reference.position}"
        )
    return _resolve_reference_at_leaf(
        reference,
        int(leaf_index) % total,
        resolver,
        context,
        state,
        accumulator,
        stack,
    )


def _expand_nodes(
    nodes: _Sequence,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
    *,
    leaf_index: int | None,
) -> str:
    ref_nodes = [node for node in nodes if isinstance(node, _Reference)]
    ref_coords: list[int] | None = None
    if ref_nodes and leaf_index is not None:
        sizes: list[int] = []
        for node in ref_nodes:
            count = _leaf_count_key(node.key, resolver, stack, context.max_depth)
            if count < 1:
                raise WildcardResolutionError(
                    f"无法解析通配符 {node.key!r}，位置 {node.position}"
                )
            sizes.append(count)
        total = _product(sizes)
        ref_coords = list(_decode_product_coords(int(leaf_index) % total, sizes))

    parts: list[str] = []
    ref_i = 0
    for node in nodes:
        if isinstance(node, _Literal):
            parts.append(node.text)
        elif ref_coords is not None:
            parts.append(
                _resolve_reference_at_leaf(
                    node,
                    ref_coords[ref_i],
                    resolver,
                    context,
                    state,
                    accumulator,
                    stack,
                )
            )
            ref_i += 1
        else:
            parts.append(
                _resolve_reference(
                    node, resolver, context, state, accumulator, stack
                )
            )
    return "".join(parts)


def expand(
    text: str,
    resolver: WildcardResolver,
    context: ExpansionContext,
) -> ExpansionResult:
    """Expand NAI wildcard syntax and preserve selected-card metadata."""
    if context.mode not in _MODES:
        raise WildcardSyntaxError(f"无效的通配符选择模式：{context.mode}")
    if context.max_depth < 1:
        raise WildcardSyntaxError("通配符最大递归深度必须至少为 1")
    nodes = parse(text)
    leaf_size = _leaf_count_nodes(nodes, resolver, (), context.max_depth)
    leaf_index = _pick_leaf_index(leaf_size, context) if leaf_size > 0 else None
    accumulator = _ResultAccumulator([], [], [], [], [], [], [], [])
    expanded = _expand_nodes(
        nodes,
        resolver,
        context,
        _RuntimeState({}),
        accumulator,
        (),
        leaf_index=leaf_index,
    )
    return ExpansionResult(
        text=expanded,
        negatives=tuple(accumulator.negatives),
        selected_keys=tuple(accumulator.selected_keys),
        lora_texts=tuple(accumulator.lora_texts),
        models=_merge_models(*accumulator.models_groups),
        parameters=_merge_parameters(*accumulator.parameters_list),
        double_sample_parameters=_merge_parameters(*accumulator.double_sample_list),
        nai=merge_nai_payloads(*accumulator.nai_list),
        negative_keys=tuple(accumulator.negative_keys),
    )


def _merge_models(*groups: Sequence[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for entry in group or ():
            if not isinstance(entry, dict):
                continue
            model_type = str(entry.get("type", "")).strip()
            if not model_type:
                continue
            key = model_type.casefold()
            if key in seen:
                continue
            seen.add(key)
            merged.append(dict(entry))
    return tuple(merged)


def _merge_parameters(*items: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    claimed: set[str] = set()
    size_claimed = False
    for item in items:
        if not isinstance(item, dict) or not item:
            continue
        if not size_claimed and ("width" in item or "height" in item):
            if "width" in item:
                merged["width"] = item["width"]
            if "height" in item:
                merged["height"] = item["height"]
            size_claimed = True
        for key, value in item.items():
            if key in {"width", "height"} or key in claimed:
                continue
            claimed.add(key)
            merged[key] = value
    return merged
