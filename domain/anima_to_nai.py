"""Convert Anima/ComfyUI parenthesis weights to NovelAI numeric groups."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Sequence


DEFAULT_WEIGHT = Decimal("1.1")
NUMBER_RE = re.compile(
    r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
)
MAX_WEIGHT_CHARS = 256
MAX_OUTPUT_CHARS = 4_000_000


class PromptSyntaxError(ValueError):
    """Raised when parenthesis weight syntax is structurally invalid."""


class PromptOutputLimitError(ValueError):
    """Raised when converted display text exceeds its output budget."""


@dataclass(frozen=True)
class TextNode:
    text: str


@dataclass(frozen=True)
class OpaqueNode:
    text: str


@dataclass(frozen=True)
class GroupNode:
    weight: Decimal
    children: list["Node"]


Node = TextNode | OpaqueNode | GroupNode


class Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def parse(self) -> list[Node]:
        return self._parse_until(None)

    def _parse_until(self, closer: str | None) -> list[Node]:
        nodes: list[Node] = []
        text_buffer: list[str] = []

        def flush_text() -> None:
            if text_buffer:
                nodes.append(TextNode("".join(text_buffer)))
                text_buffer.clear()

        while self.pos < len(self.text):
            character = self.text[self.pos]

            if character == "\\":
                text_buffer.append(character)
                self.pos += 1
                if self.pos < len(self.text):
                    text_buffer.append(self.text[self.pos])
                    self.pos += 1
                continue

            if character == ")":
                if closer == ")":
                    flush_text()
                    self.pos += 1
                    return nodes
                raise PromptSyntaxError(
                    f"unexpected closing ')' at position {self.pos}"
                )

            if character == "(":
                flush_text()
                nodes.append(self._parse_group())
                continue

            if character in "[{":
                flush_text()
                nodes.append(OpaqueNode(self._consume_opaque(character)))
                continue

            if self.text.startswith("__", self.pos):
                wildcard = self._consume_wildcard()
                if wildcard is not None:
                    flush_text()
                    nodes.append(OpaqueNode(wildcard))
                    continue

            text_buffer.append(character)
            self.pos += 1

        flush_text()
        if closer is not None:
            raise PromptSyntaxError(f"missing closing ')' for group")
        return nodes

    def _parse_group(self) -> GroupNode:
        start = self.pos
        self.pos += 1
        children = self._parse_until(")")
        weight, content = _extract_weight(children)
        if not _has_content(content):
            raise PromptSyntaxError(
                f"empty weighted group starting at position {start}"
            )
        _validate_group_content(content, start)
        return GroupNode(weight=weight, children=content)

    def _consume_opaque(self, opener: str) -> str:
        closer = "]" if opener == "[" else "}"
        start = self.pos
        depth = 0
        while self.pos < len(self.text):
            character = self.text[self.pos]
            if character == "\\":
                self.pos += min(2, len(self.text) - self.pos)
                continue
            self.pos += 1
            if character == opener:
                depth += 1
            elif character == closer:
                depth -= 1
                if depth == 0:
                    break
        return self.text[start : self.pos]

    def _consume_wildcard(self) -> str | None:
        end = self.text.find("__", self.pos + 2)
        if end < 0:
            return None
        start = self.pos
        self.pos = end + 2
        return self.text[start : self.pos]


def _extract_weight(children: list[Node]) -> tuple[Decimal, list[Node]]:
    if not children or not isinstance(children[-1], TextNode):
        return DEFAULT_WEIGHT, children

    trailing = children[-1].text
    separator = _last_unescaped_colon(trailing)
    if separator < 0:
        return DEFAULT_WEIGHT, children

    token = trailing[separator + 1 :].strip()
    if not NUMBER_RE.fullmatch(token):
        return DEFAULT_WEIGHT, children

    if _number_token_is_zero(token):
        weight = Decimal(0)
    else:
        try:
            weight = Decimal(token)
        except InvalidOperation as exc:
            raise PromptSyntaxError(
                f"normalized weight exceeds {MAX_WEIGHT_CHARS} characters"
            ) from exc
    if not weight.is_finite():
        return DEFAULT_WEIGHT, children
    if not weight.is_zero() and _fixed_length(weight) > MAX_WEIGHT_CHARS:
        raise PromptSyntaxError(
            f"normalized weight exceeds {MAX_WEIGHT_CHARS} characters"
        )

    prefix = trailing[:separator]
    content = list(children[:-1])
    if prefix:
        content.append(TextNode(prefix))
    return weight, content


def _last_unescaped_colon(text: str) -> int:
    last = -1
    position = 0
    while position < len(text):
        if text[position] == "\\":
            position += min(2, len(text) - position)
            continue
        if text[position] == ":":
            last = position
        position += 1
    return last


def _contains_unescaped_double_colon(text: str) -> bool:
    return "::" in text


def _number_token_is_zero(token: str) -> bool:
    mantissa = re.split(r"[eE]", token, maxsplit=1)[0].lstrip("+-")
    return all(character in "0." for character in mantissa)


def _validate_group_content(nodes: Sequence[Node], start: int) -> None:
    for node in nodes:
        if isinstance(node, GroupNode):
            continue
        if _contains_unescaped_double_colon(node.text):
            raise PromptSyntaxError(
                f"unescaped '::' in weighted group starting at position {start}"
            )

    if nodes and isinstance(nodes[-1], TextNode) and nodes[-1].text.endswith(":"):
        raise PromptSyntaxError(
            f"weighted group content conflicts with '::' closer at position {start}"
        )


def _has_content(nodes: Sequence[Node]) -> bool:
    return any(
        isinstance(node, GroupNode)
        or (isinstance(node, (TextNode, OpaqueNode)) and bool(node.text.strip()))
        for node in nodes
    )


def _fixed_length(value: Decimal) -> int:
    sign, digits, exponent = value.as_tuple()
    digit_count = len(digits)
    while digit_count > 1 and digits[digit_count - 1] == 0:
        digit_count -= 1
        exponent += 1
    sign_count = int(bool(sign) and not value.is_zero())
    if exponent >= 0:
        return sign_count + digit_count + exponent
    decimal_position = digit_count + exponent
    if decimal_position > 0:
        return sign_count + digit_count + 1
    return sign_count + 2 - decimal_position + digit_count


def _format_weight(weight: Decimal) -> str:
    if weight.is_zero():
        return "0"
    rendered = format(weight, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered.startswith("+"):
        rendered = rendered[1:]
    return rendered


class Renderer:
    def __init__(self, max_output_chars: int) -> None:
        if (
            not isinstance(max_output_chars, int)
            or isinstance(max_output_chars, bool)
            or max_output_chars < 0
        ):
            raise ValueError("max_output_chars must be a non-negative integer")
        self.max_output_chars = max_output_chars
        self.length = 0
        self.parts: list[str] = []

    def render(self, nodes: Sequence[Node]) -> str:
        self._render_nodes(nodes)
        return "".join(self.parts)

    def _append(self, text: str) -> None:
        if self.length + len(text) > self.max_output_chars:
            raise PromptOutputLimitError(
                f"converted output exceeds {self.max_output_chars} character limit"
            )
        self.parts.append(text)
        self.length += len(text)

    def _render_nodes(self, nodes: Sequence[Node]) -> None:
        for node in nodes:
            if isinstance(node, (TextNode, OpaqueNode)):
                self._append(node.text)
                continue
            if self.parts and self.parts[-1][-1] in "0123456789.-":
                self._append(" ")
            self._append(f"{_format_weight(node.weight)}::")
            self._render_nodes(node.children)
            self._append("::")


def convert_prompt(
    prompt: str,
    *,
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> str:
    """Return a display-only NovelAI representation of one prompt."""

    if not isinstance(prompt, str):
        raise TypeError("prompt must be string")
    return Renderer(max_output_chars).render(Parser(prompt).parse())


def convert_prompts(
    prompts: Sequence[str],
    *,
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> list[str]:
    """Convert a sequence without mutating it."""

    if isinstance(prompts, (str, bytes)):
        raise TypeError("prompts must be a sequence of strings")
    if (
        not isinstance(max_output_chars, int)
        or isinstance(max_output_chars, bool)
        or max_output_chars < 0
    ):
        raise ValueError("max_output_chars must be a non-negative integer")

    converted: list[str] = []
    remaining = max_output_chars
    for prompt in prompts:
        result = convert_prompt(prompt, max_output_chars=remaining)
        converted.append(result)
        remaining -= len(result)
    return converted
