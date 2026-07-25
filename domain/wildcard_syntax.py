"""Impact-compatible, dependency-free wildcard parsing and expansion."""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from functools import lru_cache
from hashlib import sha256
from math import isfinite
from random import Random
from typing import Any, Protocol, Sequence


@dataclass(frozen=True)
class WildcardCandidate:
    key: str
    content: str
    negative: str = ""
    lora_text: str = ""
    models: tuple[dict[str, Any], ...] = ()
    parameters: dict[str, Any] = field(default_factory=dict)
    double_sample_parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExpansionResult:
    text: str
    negatives: tuple[str, ...] = ()
    selected_keys: tuple[str, ...] = ()
    lora_texts: tuple[str, ...] = ()
    models: tuple[dict[str, Any], ...] = ()
    parameters: dict[str, Any] = field(default_factory=dict)
    double_sample_parameters: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExpansionContext:
    seed: int
    mode: str = "random"
    execution_index: int = 0
    track_id: str = ""
    max_depth: int = 100


class WildcardResolver(Protocol):
    def resolve(self, key: str) -> Sequence[WildcardCandidate]: ...


class WildcardSyntaxError(ValueError):
    """Wildcard source text is malformed."""


class WildcardResolutionError(LookupError):
    """A syntactically valid wildcard cannot be expanded."""


@dataclass(frozen=True)
class _Literal:
    text: str


@dataclass(frozen=True)
class _Reference:
    key: str
    position: int


@dataclass(frozen=True)
class _QuantifiedReference:
    count: int
    reference: _Reference


@dataclass(frozen=True)
class _WeightedOption:
    weight: float
    value: "_Sequence"


@dataclass(frozen=True)
class _Choice:
    options: tuple[_WeightedOption, ...]
    count_min: int = 1
    count_max: int | None = 1
    separator: str = " "


_Node = _Literal | _Reference | _QuantifiedReference | _Choice
_Sequence = tuple[_Node, ...]


@dataclass
class _RuntimeState:
    occurrences: dict[str, int]


@dataclass
class _ResultAccumulator:
    negatives: list[str]
    selected_keys: list[str]
    lora_texts: list[str]
    models_groups: list[tuple[dict[str, Any], ...]]
    parameters_list: list[dict[str, Any]]
    double_sample_list: list[dict[str, Any]]


_COUNT_RE = re.compile(r"(?:(\d+)(?:-(\d*)?)?|-(\d+))\Z")
_MAX_COUNT = 10_000
_MODES = {"random", "sequence", "shuffle"}


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
    return _Reference(key, _position(source_positions, opening)), index


def _skip_reference(
    text: str,
    source_positions: tuple[int, ...],
    opening: int,
    limit: int,
) -> int:
    index = opening
    while index < limit and text[index] == "_":
        index += 1
    while index < limit:
        if text[index] == "_" and index + 1 < limit and text[index + 1] == "_":
            while index < limit and text[index] == "_":
                index += 1
            return index
        index += 1
    raise WildcardSyntaxError(
        f"未闭合的通配符引用，位置 {_position(source_positions, opening)}"
    )


def _choice_end(
    text: str,
    source_positions: tuple[int, ...],
    opening: int,
) -> int:
    depth = 0
    index = opening + 1
    while index < len(text):
        if text[index] == "_" and index + 1 < len(text) and text[index + 1] == "_":
            index = _skip_reference(text, source_positions, index, len(text))
            continue
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            if depth == 0:
                return index
            depth -= 1
        index += 1
    raise WildcardSyntaxError(
        f"未闭合的选择，位置 {_position(source_positions, opening)}"
    )


def _top_level_positions(
    text: str,
    source_positions: tuple[int, ...],
    start: int,
    end: int,
    token: str,
) -> tuple[int, ...]:
    found: list[int] = []
    depth = 0
    index = start
    while index < end:
        if text[index] == "_" and index + 1 < end and text[index + 1] == "_":
            index = _skip_reference(text, source_positions, index, end)
            continue
        if text[index] == "{":
            depth += 1
            index += 1
            continue
        if text[index] == "}":
            depth -= 1
            index += 1
            continue
        if depth == 0 and text.startswith(token, index, end):
            found.append(index)
            index += len(token)
            continue
        index += 1
    return tuple(found)


def _parse_count_spec(
    value: str,
    source_positions: tuple[int, ...],
    position: int,
) -> tuple[int, int | None]:
    match = _COUNT_RE.fullmatch(value.strip())
    if not match:
        raise WildcardSyntaxError(
            f"无效的多选数量或范围，位置 {_position(source_positions, position)}"
        )
    first, second, omitted_first = match.groups()
    if omitted_first is not None:
        lower, upper = 1, int(omitted_first)
    elif second is None:
        lower = upper = int(first or "0")
    elif second == "":
        lower, upper = int(first or "0"), None
    else:
        lower, upper = int(first or "0"), int(second)
    if (
        lower < 1
        or lower > _MAX_COUNT
        or (upper is not None and (upper < lower or upper > _MAX_COUNT))
    ):
        raise WildcardSyntaxError(
            f"无效的多选数量或范围，位置 {_position(source_positions, position)}"
        )
    return lower, upper


def _weight_and_value_start(
    text: str,
    source_positions: tuple[int, ...],
    start: int,
    end: int,
) -> tuple[float, int]:
    markers = _top_level_positions(text, source_positions, start, end, "::")
    if not markers:
        return 1.0, start
    marker = markers[0]
    prefix = text[start:marker].strip()
    try:
        weight = float(prefix)
    except ValueError as error:
        raise WildcardSyntaxError(
            f"无效的相对权重，位置 {_position(source_positions, start)}"
        ) from error
    if not isfinite(weight) or weight < 0:
        raise WildcardSyntaxError(
            f"无效的相对权重，位置 {_position(source_positions, start)}"
        )
    return weight, marker + 2


def _parse_choice(
    text: str,
    source_positions: tuple[int, ...],
    opening: int,
) -> tuple[_Choice, int]:
    closing = _choice_end(text, source_positions, opening)
    content_start = opening + 1
    dollar_markers = _top_level_positions(
        text, source_positions, content_start, closing, "$$"
    )
    if len(dollar_markers) > 2:
        raise WildcardSyntaxError(
            f"无效的多选分隔符，位置 {_position(source_positions, opening)}"
        )

    count_min, count_max = 1, 1
    separator = " "
    body_start = content_start
    if dollar_markers:
        count_min, count_max = _parse_count_spec(
            text[content_start:dollar_markers[0]],
            source_positions,
            content_start,
        )
        if len(dollar_markers) == 1:
            body_start = dollar_markers[0] + 2
        else:
            separator = text[dollar_markers[0] + 2 : dollar_markers[1]]
            body_start = dollar_markers[1] + 2

    pipes = _top_level_positions(text, source_positions, body_start, closing, "|")
    ranges: list[tuple[int, int]] = []
    option_start = body_start
    for pipe in pipes:
        ranges.append((option_start, pipe))
        option_start = pipe + 1
    ranges.append((option_start, closing))

    options: list[_WeightedOption] = []
    for start, end in ranges:
        weight, value_start = _weight_and_value_start(
            text, source_positions, start, end
        )
        if not text[value_start:end].strip():
            raise WildcardSyntaxError(
                f"空选择项，位置 {_position(source_positions, start)}"
            )
        options.append(
            _WeightedOption(
                weight,
                _scan(
                    text[value_start:end],
                    source_positions[value_start:end],
                ),
            )
        )
    if not any(option.weight > 0 for option in options):
        raise WildcardSyntaxError(
            f"选择项权重不能全部为零，位置 {_position(source_positions, opening)}"
        )
    return _Choice(tuple(options), count_min, count_max, separator), closing + 1


def _scan(text: str, source_positions: tuple[int, ...]) -> _Sequence:
    nodes: list[_Node] = []
    literal_start = 0
    index = 0
    while index < len(text):
        if text[index] == "}":
            raise WildcardSyntaxError(
                f"未匹配的选择结束符，位置 {_position(source_positions, index)}"
            )
        if text[index] == "{":
            if literal_start < index:
                nodes.append(_Literal(text[literal_start:index]))
            choice, index = _parse_choice(text, source_positions, index)
            nodes.append(choice)
            literal_start = index
            continue

        quantifier_end = index
        while quantifier_end < len(text) and text[quantifier_end].isdigit():
            quantifier_end += 1
        if (
            quantifier_end > index
            and quantifier_end + 2 < len(text)
            and text[quantifier_end] == "#"
            and text[quantifier_end + 1 : quantifier_end + 3] == "__"
        ):
            count = int(text[index:quantifier_end])
            if count < 1 or count > _MAX_COUNT:
                raise WildcardSyntaxError(
                    f"通配符重复数量必须在 1 到 {_MAX_COUNT} 之间，"
                    f"位置 {_position(source_positions, index)}"
                )
            if literal_start < index:
                nodes.append(_Literal(text[literal_start:index]))
            reference, index = _parse_reference(
                text, source_positions, quantifier_end + 1
            )
            nodes.append(_QuantifiedReference(count, reference))
            literal_start = index
            continue

        if text[index : index + 2] == "__":
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
    """Parse wildcard text into an immutable syntax tree."""
    if not isinstance(text, str):
        raise TypeError("wildcard text must be a string")
    uncommented, positions = _without_comment_lines(text)
    return _scan(uncommented, positions)


def reference_keys(text: str) -> tuple[str, ...]:
    """Return referenced keys in textual order without resolving them."""

    def collect(nodes: _Sequence) -> tuple[str, ...]:
        keys: list[str] = []
        for node in nodes:
            if isinstance(node, _Reference):
                keys.append(node.key)
            elif isinstance(node, _QuantifiedReference):
                keys.append(node.reference.key)
            elif isinstance(node, _Choice):
                for option in node.options:
                    keys.extend(collect(option.value))
        return tuple(keys)

    return collect(parse(text))


def sequential_reference_keys(text: str) -> tuple[str, ...]:
    """Keys that participate in sequential leaf space (top-level ``__key__`` only).

    Ignores ``{a|b}``, weighted/multi-select choices, and ``N#__key__``.
    """

    def collect(nodes: _Sequence) -> tuple[str, ...]:
        return tuple(
            node.key for node in nodes if isinstance(node, _Reference)
        )

    if not isinstance(text, str) or not text.strip():
        return ()
    return collect(parse(text))


def sequential_leaf_count(
    text: str,
    resolver: WildcardResolver,
    *,
    max_depth: int = 100,
    stack: tuple[str, ...] = (),
) -> int:
    """Size of the sequential leaf space for one prompt text.

    - ``__key__`` alternatives (folder/file options) sum — exhaust branches L→R.
    - Multiple top-level ``__key__`` tokens multiply (outer-left, inner-right).
    - ``{a|b}``, weights, ``$$`` multi-select, and ``N#__key__`` are ignored
      (always random at expand time; they do not lengthen the sequential cycle).
    """
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
    """Map a flat index onto axis coordinates; rightmost axis varies fastest."""
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
        # Choices / quantified refs stay random and do not form sequential axes.
    if not axes:
        return 0
    return _product(axes)


def _option_stack_entry(candidate_key: str, option_index: int) -> str:
    """Distinguish multi-line TXT options that share one file key."""
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
    # Push the reference key so ``__key__`` inside content cannot recurse.
    # Do not treat sibling options as cycles: multi-line TXT shares one file key.
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


def _random_context(context: ExpansionContext) -> ExpansionContext:
    """Force Impact-style random selection for ``{}`` / ``N#`` constructs."""
    if context.mode == "random":
        return context
    return replace(context, mode="random")


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
    weights: Sequence[float],
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
    if weights and all(weight == weights[0] for weight in weights):
        if weights[0] <= 0:
            raise WildcardSyntaxError(
                f"多选数量 {count} 超过正权重候选数"
            )
        return tuple(rng.sample(range(size), count))

    remaining = list(range(size))
    selected: list[int] = []
    for _ in range(count):
        total = sum(weights[index] for index in remaining)
        if total <= 0:
            raise WildcardSyntaxError(
                f"多选数量 {count} 超过正权重候选数"
            )
        target = rng.random() * total
        cumulative = 0.0
        chosen = remaining[-1]
        for index in remaining:
            cumulative += weights[index]
            if target < cumulative:
                chosen = index
                break
        selected.append(chosen)
        remaining.remove(chosen)
    return tuple(selected)


@lru_cache(maxsize=16)
def _shuffled_order(size: int, seed: int) -> tuple[int, ...]:
    order = list(range(size))
    Random(seed).shuffle(order)
    return tuple(order)


def _choose_count(
    choice: _Choice,
    available: int,
    context: ExpansionContext,
    occurrence: int,
) -> int:
    upper = available if choice.count_max is None else choice.count_max
    if choice.count_min > available or upper > available:
        requested = (
            str(choice.count_min)
            if choice.count_min == upper
            else f"{choice.count_min}-{upper}"
        )
        raise WildcardSyntaxError(
            f"多选数量 {requested} 超过可用候选数 {available}"
        )
    span = upper - choice.count_min + 1
    if span == 1:
        return choice.count_min
    if context.mode == "sequence":
        offset = (context.execution_index + occurrence) % span
    elif context.mode == "shuffle":
        order = list(range(span))
        Random(_seed(context, occurrence, "choice-count:shuffle")).shuffle(order)
        offset = order[(context.execution_index + occurrence) % span]
    else:
        offset = Random(_seed(context, occurrence, "choice-count:random")).randrange(
            span
        )
    return choice.count_min + offset


def _expanded_options(choice: _Choice) -> tuple[_WeightedOption, ...]:
    expanded: list[_WeightedOption] = []
    for option in choice.options:
        if len(option.value) == 1 and isinstance(
            option.value[0], _QuantifiedReference
        ):
            quantified = option.value[0]
            expanded.extend(
                _WeightedOption(option.weight, (quantified.reference,))
                for _ in range(quantified.count)
            )
        else:
            expanded.append(option)
    return tuple(expanded)


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
    accumulator.selected_keys.append(candidate.key)
    if candidate.lora_text:
        accumulator.lora_texts.append(candidate.lora_text)
    if candidate.models:
        accumulator.models_groups.append(candidate.models)
    if candidate.parameters:
        accumulator.parameters_list.append(dict(candidate.parameters))
    if candidate.double_sample_parameters:
        accumulator.double_sample_list.append(dict(candidate.double_sample_parameters))
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
    """Expand one ``__key__`` with mode-based selection (used inside random ``{}``)."""
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
        weights=(1.0,) * len(candidates),
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
    """Expand one ``__key__`` to the leaf at ``leaf_index`` (tree walk)."""
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

    # Defensive wrap if caller index was out of range.
    total = _leaf_count_key(
        reference.key, resolver, stack, context.max_depth
    )
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


def _expand_choice(
    choice: _Choice,
    resolver: WildcardResolver,
    context: ExpansionContext,
    state: _RuntimeState,
    accumulator: _ResultAccumulator,
    stack: tuple[str, ...],
) -> str:
    # ``{}`` is always random, even when the track mode is sequence/shuffle.
    context = _random_context(context)
    direct_reference: _Reference | None = None
    if (
        len(choice.options) == 1
        and len(choice.options[0].value) == 1
        and isinstance(choice.options[0].value[0], _Reference)
    ):
        direct_reference = choice.options[0].value[0]

    if direct_reference is not None:
        purpose = f"wildcard:{direct_reference.key}"
        occurrence = state.occurrences.get(purpose, 0)
        if len(stack) >= context.max_depth:
            raise WildcardResolutionError(
                f"通配符引用超过最大深度 {context.max_depth}，"
                f"位置 {direct_reference.position}"
            )
        candidates = tuple(resolver.resolve(direct_reference.key))
        if not candidates:
            raise WildcardResolutionError(
                f"无法解析通配符 {direct_reference.key!r}，"
                f"位置 {direct_reference.position}"
            )
        count = _choose_count(choice, len(candidates), context, occurrence)
        selected = _select_indices(
            size=len(candidates),
            count=count,
            weights=(1.0,) * len(candidates),
            context=context,
            occurrence=occurrence,
            purpose=purpose,
        )
        _next_occurrence(state, purpose, count)
        return choice.separator.join(
            _candidate_content(
                candidates[index],
                direct_reference,
                resolver,
                context,
                state,
                accumulator,
                stack,
                content_leaf_index=None,
            )
            for index in selected
        )

    options = _expanded_options(choice)
    purpose = "inline-choice"
    occurrence = state.occurrences.get(purpose, 0)
    count = _choose_count(choice, len(options), context, occurrence)
    selected = _select_indices(
        size=len(options),
        count=count,
        weights=tuple(option.weight for option in options),
        context=context,
        occurrence=occurrence,
        purpose=purpose,
    )
    _next_occurrence(state, purpose, count)
    return choice.separator.join(
        _expand_nodes(
            options[index].value,
            resolver,
            context,
            state,
            accumulator,
            stack,
            leaf_index=None,
        )
        for index in selected
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
            count = _leaf_count_key(
                node.key, resolver, stack, context.max_depth
            )
            if count < 1:
                raise WildcardResolutionError(
                    f"无法解析通配符 {node.key!r}，位置 {node.position}"
                )
            sizes.append(count)
        total = _product(sizes)
        ref_coords = list(
            _decode_product_coords(int(leaf_index) % total, sizes)
        )

    parts: list[str] = []
    ref_i = 0
    for node in nodes:
        if isinstance(node, _Literal):
            parts.append(node.text)
        elif isinstance(node, _Reference):
            if ref_coords is not None:
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
        elif isinstance(node, _QuantifiedReference):
            random_context = _random_context(context)
            parts.append(
                "|".join(
                    _resolve_reference(
                        node.reference,
                        resolver,
                        random_context,
                        state,
                        accumulator,
                        stack,
                    )
                    for _ in range(node.count)
                )
            )
        else:
            parts.append(
                _expand_choice(
                    node, resolver, context, state, accumulator, stack
                )
            )
    return "".join(parts)


def expand(
    text: str,
    resolver: WildcardResolver,
    context: ExpansionContext,
) -> ExpansionResult:
    """Expand wildcard syntax and preserve selected-card metadata.

    Sequential / shuffle / random track modes address the ``__key__`` leaf
    space (nested branches sum; same-text keys form a product). Inline
    ``{a|b}`` choices and ``N#__key__`` always select randomly.
    """
    if context.mode not in _MODES:
        raise WildcardSyntaxError(f"无效的通配符选择模式：{context.mode}")
    if context.max_depth < 1:
        raise WildcardSyntaxError("通配符最大递归深度必须至少为 1")
    nodes = parse(text)
    leaf_size = _leaf_count_nodes(nodes, resolver, (), context.max_depth)
    leaf_index = (
        _pick_leaf_index(leaf_size, context) if leaf_size > 0 else None
    )
    accumulator = _ResultAccumulator([], [], [], [], [], [])
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
