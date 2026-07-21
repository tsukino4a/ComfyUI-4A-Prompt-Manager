"""Stateless prompt-document and filesystem helpers."""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

try:
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from support.i18n import tr  # type: ignore


IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"}


@dataclass(frozen=True)
class PromptDocument:
    format: Literal["json_card", "txt_wildcard"]
    options: tuple[str, ...]
    raw_content: str
    negative: str = ""
    note: str = ""


def _normalize_txt_text(text: str) -> Optional[str]:
    parts: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts.append(stripped)
    if not parts:
        return None
    return "\n".join(parts)


def _read_txt_content(path: Path) -> Optional[str]:
    """Read a wildcard file as one prompt (multi-line joined with newlines).

    Empty lines and ``#`` comment lines are skipped. Remaining lines are joined
    with ``\n`` so each ``.txt`` is a single expand option.
    """
    options = read_txt_options(path)
    return "\n".join(options) if options else None


def read_txt_options(path: Path) -> list[str]:
    """Read a traditional wildcard TXT as one prompt option per line."""
    return parse_txt_options(read_txt_text(path))


def read_txt_text(path: Path) -> str:
    """Read TXT with the encodings commonly used by ComfyUI wildcard packs."""
    raw = path.read_bytes()
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "cp932", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def parse_txt_options(text: str) -> list[str]:
    return [
        stripped
        for line in text.splitlines()
        if (stripped := line.strip()) and not stripped.startswith("#")
    ]


def read_prompt_document(path: Path) -> PromptDocument:
    """Read one JSON card or traditional line-based TXT wildcard."""
    if path.suffix.casefold() == ".json":
        document = _read_json_prompt(path)
        return PromptDocument(
            format="json_card",
            options=(document["content"],),
            raw_content=document["content"],
            negative=document["negative"],
            note=document["note"],
        )
    if path.suffix.casefold() == ".txt":
        raw_content = read_txt_text(path)
        options = tuple(parse_txt_options(raw_content))
        return PromptDocument(
            format="txt_wildcard",
            options=options,
            raw_content=raw_content,
        )
    raise ValueError(f"Unsupported prompt document: {path.name}")


def _write_txt_wildcard(path: Path, content: str) -> None:
    """Atomically write one traditional TXT wildcard without expanding it."""
    if not parse_txt_options(content):
        raise ValueError(tr("提示词内容不能为空"))
    temporary = path.with_name(f".{path.stem}.pm4a-save-{uuid.uuid4().hex}.tmp")
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    try:
        temporary.write_text(normalized, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _normalize_optional_prompt(text: str) -> str:
    return _normalize_txt_text(text) or ""


def _read_json_prompt(path: Path) -> dict[str, str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(
            tr("JSON 提示词无法读取：{filename} ({error})", filename=path.name, error=exc)
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(tr("JSON 提示词必须是对象：{filename}", filename=path.name))
    content = raw.get("content", "")
    negative = raw.get("negative", "")
    note = raw.get("note", "")
    if not isinstance(content, str):
        raise ValueError(tr("content 必须是字符串：{filename}", filename=path.name))
    if not isinstance(negative, str):
        raise ValueError(tr("negative 必须是字符串：{filename}", filename=path.name))
    if not isinstance(note, str):
        raise ValueError(tr("note 必须是字符串：{filename}", filename=path.name))
    normalized_content = _normalize_txt_text(content)
    if not normalized_content:
        raise ValueError(tr("content 不能为空：{filename}", filename=path.name))
    return {
        "content": normalized_content,
        "negative": _normalize_optional_prompt(negative),
        "note": note.strip(),
    }


def _write_json_prompt(
    path: Path, *, content: str, negative: str, note: str
) -> None:
    payload = {
        "content": content,
        "negative": negative,
        "note": note,
    }
    temporary = path.with_name(f".{path.stem}.pm4a-save-{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _find_sidecar_image(txt_path: Path) -> Optional[Path]:
    stem = txt_path.with_suffix("")
    for ext in IMAGE_EXTS:
        candidate = Path(str(stem) + ext)
        if candidate.is_file():
            return candidate
    return None


def _detect_image_extension(data: bytes) -> Optional[str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    return None


def _validated_entry_name(value: str) -> str:
    name = value.strip()
    if name.lower().endswith((".txt", ".json")):
        name = name[:-4].rstrip()
    if not name:
        raise ValueError(tr("标题不能为空"))
    if len(name) > 200:
        raise ValueError(tr("标题不能超过 200 个字符"))
    if name in {".", ".."} or _INVALID_FILENAME_CHARS.search(name):
        raise ValueError(tr("标题包含文件名不允许使用的字符"))
    if name.endswith((" ", ".")):
        raise ValueError(tr("标题不能以空格或句点结尾"))
    reserved_base = name.split(".", 1)[0].upper()
    if reserved_base in _WINDOWS_RESERVED_NAMES or re.fullmatch(
        r"(?:COM|LPT)[1-9]", reserved_base
    ):
        raise ValueError(tr("这个标题是系统保留名称"))
    return name


def _validated_folder_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise ValueError(tr("文件夹名称不能为空"))
    if len(name) > 200:
        raise ValueError(tr("文件夹名称不能超过 200 个字符"))
    if name in {".", ".."} or _INVALID_FILENAME_CHARS.search(name):
        raise ValueError(tr("文件夹名称包含系统不允许使用的字符"))
    if name.endswith((" ", ".")):
        raise ValueError(tr("文件夹名称不能以空格或句点结尾"))
    reserved_base = name.split(".", 1)[0].upper()
    if reserved_base in _WINDOWS_RESERVED_NAMES or re.fullmatch(
        r"(?:COM|LPT)[1-9]", reserved_base
    ):
        raise ValueError(tr("这个文件夹名称是系统保留名称"))
    return name


def _paths_refer_to_same_file(left: Path, right: Path) -> bool:
    try:
        return left.exists() and right.exists() and left.samefile(right)
    except OSError:
        return False


def _rename_case_safe(source: Path, target: Path) -> None:
    if source == target:
        return
    if _paths_refer_to_same_file(source, target):
        temporary = source.with_name(
            f".{source.stem}.pm4a-rename-{uuid.uuid4().hex}{source.suffix}"
        )
        source.rename(temporary)
        temporary.rename(target)
        return
    source.rename(target)
