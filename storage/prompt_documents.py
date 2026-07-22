"""Stateless prompt-document and filesystem helpers."""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

try:
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from support.i18n import tr  # type: ignore


IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"}
_LORA_TAG_RE = re.compile(r"<lora:([^>:]+)(?::([^>]*))?>", re.IGNORECASE)


def empty_lora_payload() -> dict[str, Any]:
    return {"text": "", "hashes": []}


@dataclass(frozen=True)
class PromptDocument:
    format: Literal["json_card", "txt_wildcard"]
    options: tuple[str, ...]
    raw_content: str
    negative: str = ""
    note: str = ""
    lora: dict[str, Any] = field(default_factory=empty_lora_payload)


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


def lora_tag_names(text: str) -> list[str]:
    """Return LoRA names from `<lora:name:strength>` tags in order."""
    if not isinstance(text, str) or not text:
        return []
    return [match.group(1).strip() for match in _LORA_TAG_RE.finditer(text) if match.group(1).strip()]


def normalize_lora_payload(
    value: Any,
    *,
    require_hashes_when_text: bool = True,
    filename: str = "",
) -> dict[str, Any]:
    """Normalize optional JSON-card `lora` to `{text, hashes}`."""
    label = f"：{filename}" if filename else ""
    if value is None:
        return empty_lora_payload()
    if value == "" or value == {}:
        return empty_lora_payload()
    if not isinstance(value, dict):
        raise ValueError(tr("lora 必须是对象{label}", label=label))
    text = value.get("text", "")
    hashes_raw = value.get("hashes", [])
    if not isinstance(text, str):
        raise ValueError(tr("lora.text 必须是字符串{label}", label=label))
    if hashes_raw is None:
        hashes_raw = []
    if not isinstance(hashes_raw, list):
        raise ValueError(tr("lora.hashes 必须是数组{label}", label=label))
    hashes: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in hashes_raw:
        if not isinstance(entry, dict):
            raise ValueError(tr("lora.hashes 项必须是对象{label}", label=label))
        name = str(entry.get("name", "")).strip()
        digest = str(entry.get("hash", "")).strip()
        if not name or not digest:
            raise ValueError(tr("lora.hashes 项需要 name 与 hash{label}", label=label))
        key = f"{name.casefold()}\0{digest.casefold()}"
        if key in seen:
            continue
        seen.add(key)
        hashes.append({"name": name, "hash": digest})
    tags = [
        match.group(0).strip()
        for match in _LORA_TAG_RE.finditer(text)
        if match.group(0).strip()
    ]
    normalized_text = " ".join(dict.fromkeys(tags))
    if not normalized_text and not hashes:
        return empty_lora_payload()
    if require_hashes_when_text and normalized_text and not hashes:
        raise ValueError(tr("lora 需要 hashes 才能保存{label}", label=label))
    return {"text": normalized_text, "hashes": hashes}


def merge_lora_texts(*texts: str) -> str:
    """Merge LoRA tag strings, skipping duplicate names (first wins)."""
    tags: list[str] = []
    seen: set[str] = set()
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            continue
        for match in _LORA_TAG_RE.finditer(text):
            name = match.group(1).strip()
            tag = match.group(0).strip()
            if not name or not tag:
                continue
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            tags.append(tag)
    return " ".join(tags)


def append_lora_text(base: str, extra: str) -> str:
    """Append LoRA tags from extra that are not already named in base."""
    base_text = base if isinstance(base, str) else ""
    extra_text = extra if isinstance(extra, str) else ""
    if not extra_text.strip():
        return base_text
    existing = {name.casefold() for name in lora_tag_names(base_text)}
    additions: list[str] = []
    for match in _LORA_TAG_RE.finditer(extra_text):
        name = match.group(1).strip()
        tag = match.group(0).strip()
        if not name or not tag:
            continue
        key = name.casefold()
        if key in existing:
            continue
        existing.add(key)
        additions.append(tag)
    if not additions:
        return base_text
    if not base_text.strip():
        return " ".join(additions)
    return f"{base_text.rstrip()} {' '.join(additions)}"


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
            lora=document["lora"],
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


def _read_json_prompt(path: Path) -> dict[str, Any]:
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
        "lora": normalize_lora_payload(
            raw.get("lora"),
            require_hashes_when_text=False,
            filename=path.name,
        ),
    }


def _write_json_prompt(
    path: Path,
    *,
    content: str,
    negative: str,
    note: str,
    lora: Optional[dict[str, Any]] = None,
) -> None:
    payload: dict[str, Any] = {
        "content": content,
        "negative": negative,
        "note": note,
    }
    normalized_lora = normalize_lora_payload(
        lora,
        require_hashes_when_text=True,
        filename=path.name,
    )
    if normalized_lora["text"] or normalized_lora["hashes"]:
        payload["lora"] = normalized_lora
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
