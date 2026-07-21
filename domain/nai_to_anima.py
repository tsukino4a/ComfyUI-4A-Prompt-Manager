"""Convert NovelAI prompt weights to Anima/ComfyUI-style weights."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence


NUMBER_RE = re.compile(r"-?(?:\d+(?:\.\d*)?|\.\d+)")
NOVELAI_BRACE_FACTOR = 1.05
NOVELAI_BRACKET_FACTOR = 1 / NOVELAI_BRACE_FACTOR


class PromptSyntaxError(ValueError):
    pass


@dataclass(frozen=True)
class TextNode:
    text: str


@dataclass(frozen=True)
class GroupNode:
    factor: float
    children: list["Node"]
    start: int
    opener: str


@dataclass(frozen=True)
class ConversionResult:
    text: str
    repaired_prompt: str
    added_closers: tuple[str, ...]

    @property
    def repaired(self) -> bool:
        return bool(self.added_closers)


Node = TextNode | GroupNode


class Parser:
    def __init__(self, text: str, curly_base: float, square_base: float) -> None:
        self.text = text
        self.pos = 0
        self.curly_base = curly_base
        self.square_base = square_base

    def parse(self) -> list[Node]:
        nodes = self._parse_until(None)
        if self.pos != len(self.text):
            raise PromptSyntaxError(f"unexpected trailing text at position {self.pos}")
        return nodes

    def _parse_until(self, closer: str | None) -> list[Node]:
        nodes: list[Node] = []
        while self.pos < len(self.text):
            if closer == "::" and self.text.startswith("::", self.pos):
                self.pos += 2
                self._require_content(nodes, "::")
                return nodes

            char = self.text[self.pos]
            if closer == "}" and char == "}":
                self.pos += 1
                self._require_content(nodes, "}")
                return nodes
            if closer == "]" and char == "]":
                self.pos += 1
                self._require_content(nodes, "]")
                return nodes

            if char in "}]":
                raise PromptSyntaxError(
                    f"unexpected closing '{char}' at position {self.pos}"
                )
            if self.text.startswith("::", self.pos):
                raise PromptSyntaxError(f"unexpected closing '::' at position {self.pos}")

            number_match = self._number_group_at(self.pos)
            if number_match is not None:
                nodes.append(self._parse_number_group(number_match))
                continue
            if char == "{":
                nodes.append(self._parse_bracket_group("{", "}", self.curly_base))
                continue
            if char == "[":
                nodes.append(self._parse_bracket_group("[", "]", self.square_base))
                continue
            nodes.append(self._parse_text(closer))

        if closer is not None:
            raise PromptSyntaxError(f"missing closing '{closer}'")
        return nodes

    def _parse_text(self, closer: str | None) -> TextNode:
        start = self.pos
        while self.pos < len(self.text):
            if closer == "::" and self.text.startswith("::", self.pos):
                break
            if self.text.startswith("::", self.pos):
                break
            if self.text[self.pos] in "{}[]":
                break
            if self._number_group_at(self.pos) is not None:
                break
            self.pos += 1
        if start == self.pos:
            raise PromptSyntaxError(f"unexpected token at position {self.pos}")
        return TextNode(self.text[start : self.pos])

    def _parse_number_group(self, number_match: re.Match[str]) -> GroupNode:
        start = self.pos
        factor = float(number_match.group(0))
        self.pos = number_match.end() + 2
        children = self._parse_until("::")
        return GroupNode(factor=factor, children=children, start=start, opener="::")

    def _parse_bracket_group(self, opener: str, closer: str, factor: float) -> GroupNode:
        start = self.pos
        self.pos += 1
        children = self._parse_until(closer)
        return GroupNode(factor=factor, children=children, start=start, opener=opener)

    def _number_group_at(self, pos: int) -> re.Match[str] | None:
        match = NUMBER_RE.match(self.text, pos)
        if match is None or not self.text.startswith("::", match.end()):
            return None
        return match

    @staticmethod
    def _require_content(nodes: Sequence[Node], closer: str) -> None:
        for node in nodes:
            if isinstance(node, TextNode) and node.text.strip():
                return
            if isinstance(node, GroupNode):
                return
        raise PromptSyntaxError(f"empty weighted group before '{closer}'")


def repair_missing_closers(prompt: str) -> tuple[str, tuple[str, ...]]:
    """Insert only missing closers while preserving all user-authored text."""

    output: list[str] = []
    stack: list[str] = []
    added: list[str] = []
    position = 0

    def close_until(closer: str) -> None:
        while stack and stack[-1] != closer:
            inserted = stack.pop()
            output.append(inserted)
            added.append(inserted)
        if stack and stack[-1] == closer:
            stack.pop()

    while position < len(prompt):
        number_match = NUMBER_RE.match(prompt, position)
        if number_match is not None and prompt.startswith("::", number_match.end()):
            end = number_match.end() + 2
            output.append(prompt[position:end])
            stack.append("::")
            position = end
            continue

        if prompt.startswith("::", position):
            if "::" in stack:
                close_until("::")
            output.append("::")
            position += 2
            continue

        character = prompt[position]
        if character == "{":
            stack.append("}")
        elif character == "[":
            stack.append("]")
        elif character in "}]" and character in stack:
            close_until(character)
        output.append(character)
        position += 1

    while stack:
        inserted = stack.pop()
        output.append(inserted)
        added.append(inserted)
    return "".join(output), tuple(added)


def convert_prompt(
    prompt: str,
    *,
    curly_base: float = NOVELAI_BRACE_FACTOR,
    square_base: float = NOVELAI_BRACKET_FACTOR,
) -> str:
    if curly_base <= 0:
        raise ValueError("curly base must be greater than 0")
    if square_base <= 0:
        raise ValueError("square base must be greater than 0")
    nodes = Parser(prompt, curly_base=curly_base, square_base=square_base).parse()
    return "".join(render_node(node) for node in nodes)


def convert_prompt_tolerant(prompt: str) -> ConversionResult:
    repaired_prompt, added_closers = repair_missing_closers(prompt)
    return ConversionResult(
        text=convert_prompt(repaired_prompt),
        repaired_prompt=repaired_prompt,
        added_closers=added_closers,
    )


def render_node(node: Node) -> str:
    if isinstance(node, TextNode):
        return node.text
    factor, children = collapse_group(node)
    inner = "".join(render_node(child) for child in children)
    return f"({inner}:{format_weight(factor)})"


def collapse_group(group: GroupNode) -> tuple[float, list[Node]]:
    factor = group.factor
    children = group.children
    while len(children) == 1 and isinstance(children[0], GroupNode):
        child = children[0]
        factor *= child.factor
        children = child.children
    return factor, children


def format_weight(factor: float) -> str:
    if factor < 0:
        return f"{factor:.2f}"
    return f"{adjust_weight(factor):.2f}"


def adjust_weight(factor: float) -> float:
    if factor >= 2:
        adjusted = 1 + (factor - 1) * 1.2
    elif factor >= 1.2:
        adjusted = 1 + (factor - 1) * 1.5
    elif factor > 1:
        adjusted = 1 + (factor - 1) * 2.5
    elif factor >= 0.8:
        adjusted = 1 - (1 - factor) * 2.5
    else:
        adjusted = 1 - (1 - factor) * 1.5
    return max(0.05, min(3.0, adjusted))
