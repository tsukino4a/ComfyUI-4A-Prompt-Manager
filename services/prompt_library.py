"""Wildcard loading and expansion (file keys + folder-union keys)."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

try:
    from ..domain import wildcard_syntax
    from ..storage import library_metadata as metadata
    from ..storage.prompt_documents import (
        IMAGE_EXTS,
        _detect_image_extension,
        _find_sidecar_image,
        _INVALID_FILENAME_CHARS,
        _normalize_optional_prompt,
        _normalize_txt_text,
        _paths_refer_to_same_file,
        _read_json_prompt,
        _read_txt_content,
        _write_txt_wildcard,
        parse_txt_options,
        read_prompt_document,
        read_txt_text,
        _rename_case_safe,
        _validated_entry_name,
        _validated_folder_name,
        _WINDOWS_RESERVED_NAMES,
        _write_json_prompt,
    )
    from ..support.config import get_wildcards_path
    from ..support.i18n import tr
    from . import wildcard_expansion as _wildcard_expansion
    from .wildcard_expansion import (
        LibraryWildcardResolver,
        _natural_display_key,
        cleanup_prompt_commas,
        join_positive_parts,
        normalize_key,
    )
except ImportError:  # standalone preview
    from domain import wildcard_syntax  # type: ignore
    from storage import library_metadata as metadata  # type: ignore
    from storage.prompt_documents import (  # type: ignore
        IMAGE_EXTS,
        _detect_image_extension,
        _find_sidecar_image,
        _INVALID_FILENAME_CHARS,
        _normalize_optional_prompt,
        _normalize_txt_text,
        _paths_refer_to_same_file,
        _read_json_prompt,
        _read_txt_content,
        _write_txt_wildcard,
        parse_txt_options,
        read_prompt_document,
        read_txt_text,
        _rename_case_safe,
        _validated_entry_name,
        _validated_folder_name,
        _WINDOWS_RESERVED_NAMES,
        _write_json_prompt,
    )
    from support.config import get_wildcards_path  # type: ignore
    from support.i18n import tr  # type: ignore
    from services import wildcard_expansion as _wildcard_expansion  # type: ignore
    from services.wildcard_expansion import (  # type: ignore
        LibraryWildcardResolver,
        _natural_display_key,
        cleanup_prompt_commas,
        join_positive_parts,
        normalize_key,
    )

logger = logging.getLogger("ComfyUI4APromptManager")

ROOT_WILDCARD_KEY = "*"
LIST_SORT_MODES = {"path:asc", "path:desc", "name:asc", "name:desc"}
BUNDLE_FORMAT = "pm4a-prompt-bundle"
MAX_BULK_IMPORT_PROMPTS = 20_000
MAX_BULK_IMPORT_CHARACTERS = 50_000_000

_lock = threading.RLock()
_file_dict: dict[str, list[str]] = {}
_folder_dict: dict[str, list[str]] = {}
_file_paths: dict[str, Path] = {}
_display_paths: dict[str, str] = {}
_negative_dict: dict[str, str] = {}
_note_dict: dict[str, str] = {}
_folder_display_paths: dict[str, str] = {}
_conflict_keys: tuple[str, ...] = ()
_loaded_root: Optional[Path] = None

ProgressCallback = Callable[[int, int, str], None]


def _entry_format(path: Optional[Path]) -> str:
    return (
        "txt_wildcard"
        if path and path.suffix.casefold() == ".txt"
        else "json_card"
    )


def _entry_capabilities(entry_format: str) -> dict[str, bool]:
    is_txt = entry_format == "txt_wildcard"
    return {
        "content_edit": not is_txt,
        "negative": not is_txt,
        "note": not is_txt,
        "image": True,
        "generation": not is_txt,
        "external_edit": is_txt,
    }


def _canonical_content(options: Iterable[str]) -> str:
    return "\n".join(options)


def entry_supports(key: str, capability: str) -> bool:
    """Return one indexed entry capability from the shared format model."""
    ensure_loaded()
    normalized = normalize_key(key)
    with _lock:
        path = _file_paths.get(normalized)
        if not path:
            raise FileNotFoundError(tr("提示词不存在"))
        return bool(_entry_capabilities(_entry_format(path)).get(capability, False))


def _build_folder_indexes(
    file_dict: dict[str, list[str]],
    display_paths: dict[str, str],
    root: Optional[Path] = None,
) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Rebuild folder unions and preserve empty directories from disk."""
    folder_dict: dict[str, list[str]] = {}
    folder_display_paths: dict[str, str] = {}
    for key, options in file_dict.items():
        if not options:
            continue
        parts = key.split("/")
        display_parts = display_paths.get(key, key).split("/")
        for index in range(1, len(parts)):
            folder_key = "/".join(parts[:index])
            folder_display_paths.setdefault(
                folder_key, "/".join(display_parts[:index])
            )
            folder_dict.setdefault(folder_key, []).extend(options)

    # ``__*__`` is a reserved alias for the entire library. ``*`` cannot be a
    # Windows directory name, so it cannot collide with a real folder key.
    root_options = [
        option
        for key, options in file_dict.items()
        for option in options
    ]
    folder_dict[ROOT_WILDCARD_KEY] = root_options
    folder_display_paths[ROOT_WILDCARD_KEY] = "全部提示词"

    # File-derived indexes cannot see empty folders. Scan directory names only
    # so a folder created in the browser appears immediately in the tree.
    if root and root.is_dir():
        for directory in root.rglob("*"):
            if not directory.is_dir():
                continue
            try:
                relative = directory.relative_to(root)
            except ValueError:
                continue
            if relative.parts and relative.parts[0].casefold() == metadata.INTERNAL_DIR_NAME.casefold():
                continue
            display_path = str(relative).replace("\\", "/")
            folder_key = normalize_key(display_path)
            if not folder_key:
                continue
            folder_dict.setdefault(folder_key, [])
            folder_display_paths.setdefault(folder_key, display_path)

    return folder_dict, folder_display_paths


def reload(root: Optional[Path] = None) -> None:
    """Scan wildcards directory into file and folder dictionaries."""
    global _file_dict, _folder_dict, _file_paths
    global _display_paths, _negative_dict, _note_dict
    global _folder_display_paths, _conflict_keys, _loaded_root

    root = Path(root) if root is not None else get_wildcards_path()
    file_dict: dict[str, list[str]] = {}
    file_paths: dict[str, Path] = {}
    display_paths: dict[str, str] = {}
    negative_dict: dict[str, str] = {}
    note_dict: dict[str, str] = {}

    if not root.is_dir():
        logger.warning("Wildcards root does not exist: %s", root)
        with _lock:
            _file_dict = {}
            _folder_dict = {}
            _file_paths = {}
            _display_paths = {}
            _negative_dict = {}
            _note_dict = {}
            _folder_display_paths = {}
            _conflict_keys = ()
            _loaded_root = root
        return

    # Collect every .txt under root
    for txt in root.rglob("*.txt"):
        if not txt.is_file():
            continue
        try:
            rel = txt.relative_to(root)
        except ValueError:
            continue
        if rel.parts and rel.parts[0].casefold() == metadata.INTERNAL_DIR_NAME.casefold():
            continue
        rel_without_suffix = rel.with_suffix("")
        display_path = str(rel_without_suffix).replace("\\", "/")
        key = normalize_key(display_path)
        if not key:
            continue
        try:
            options = list(read_prompt_document(txt).options)
        except (OSError, ValueError) as exc:
            logger.warning("Failed to read %s: %s", txt, exc)
            continue
        if not options:
            continue
        file_dict[key] = options
        file_paths[key] = txt
        display_paths[key] = display_path
        negative_dict[key] = ""
        note_dict[key] = ""

    conflict_keys: set[str] = set()
    # JSON and TXT with the same logical key are ambiguous and neither is indexed.
    for prompt_json in root.rglob("*.json"):
        if not prompt_json.is_file():
            continue
        try:
            rel = prompt_json.relative_to(root)
        except ValueError:
            continue
        if rel.parts and rel.parts[0].casefold() == metadata.INTERNAL_DIR_NAME.casefold():
            continue
        rel_without_suffix = rel.with_suffix("")
        display_path = str(rel_without_suffix).replace("\\", "/")
        key = normalize_key(display_path)
        if not key:
            continue
        existing_path = file_paths.get(key)
        if existing_path and existing_path.suffix.casefold() == ".txt":
            conflict_keys.add(key)
            file_dict.pop(key, None)
            file_paths.pop(key, None)
            display_paths.pop(key, None)
            negative_dict.pop(key, None)
            note_dict.pop(key, None)
            logger.error(
                "Conflicting TXT and JSON prompt documents share key %s", key
            )
            continue
        try:
            document = read_prompt_document(prompt_json)
        except ValueError as exc:
            logger.warning("%s", exc)
            continue
        file_dict[key] = list(document.options)
        file_paths[key] = prompt_json
        display_paths[key] = display_path
        negative_dict[key] = document.negative
        note_dict[key] = document.note

    try:
        metadata.reconcile_entries(
            root,
            {
                key: (display_paths[key], "\n".join(options))
                for key, options in file_dict.items()
                if options
            },
        )
    except metadata.MetadataError as exc:
        logger.error("Wildcard metadata was not loaded: %s", exc)
    except OSError as exc:
        logger.warning("Wildcard metadata could not be reconciled: %s", exc)

    folder_dict, folder_display_paths = _build_folder_indexes(
        file_dict, display_paths, root
    )

    with _lock:
        _file_dict = file_dict
        _folder_dict = folder_dict
        _file_paths = file_paths
        _display_paths = display_paths
        _negative_dict = negative_dict
        _note_dict = note_dict
        _folder_display_paths = folder_display_paths
        _conflict_keys = tuple(sorted(conflict_keys))
        _loaded_root = root

    logger.info(
        "Loaded %d wildcard files, %d folder keys from %s",
        len(file_dict),
        len(folder_dict),
        root,
    )


def ensure_loaded() -> None:
    """Load wildcards once; use reload() to refresh or switch roots."""
    with _lock:
        if _loaded_root is not None:
            return
    reload()


def snapshot_resolver() -> LibraryWildcardResolver:
    """Copy the complete in-memory library into an immutable resolver."""
    ensure_loaded()
    with _lock:
        return LibraryWildcardResolver.from_indexes(
            _file_dict,
            tuple(_folder_dict),
            _negative_dict,
            _display_paths,
        )


def expand_prompt(
    text: str,
    *,
    seed: int = 0,
    mode: str = "random",
    execution_index: int = 0,
    track_id: str = "",
    max_depth: int = 100,
    resolver: wildcard_syntax.WildcardResolver | None = None,
) -> wildcard_syntax.ExpansionResult:
    """Expand one prompt through the shared parser and structured resolver."""
    active_resolver = resolver if resolver is not None else snapshot_resolver()
    return _wildcard_expansion.expand_prompt(
        text,
        resolver=active_resolver,
        seed=seed,
        mode=mode,
        execution_index=execution_index,
        track_id=track_id,
        max_depth=max_depth,
    )


def get_loaded_root() -> Path:
    """Return the currently indexed wildcard root."""
    ensure_loaded()
    with _lock:
        return Path(_loaded_root or get_wildcards_path())


def _resolve_folder_path_locked(folder: str) -> tuple[Path, str, str]:
    root = Path(_loaded_root or get_wildcards_path())
    normalized = normalize_key(folder)
    if normalized == ROOT_WILDCARD_KEY:
        normalized = ""
    if normalized:
        display_path = _folder_display_paths.get(normalized)
        if display_path is None:
            raise FileNotFoundError(tr("保存文件夹不存在，请刷新后重试"))
        target = root / Path(*display_path.split("/"))
    else:
        display_path = ""
        target = root
    if not target.is_dir():
        raise FileNotFoundError(tr("保存文件夹不存在，请刷新后重试"))
    root_resolved = root.resolve()
    target_resolved = target.resolve()
    if target_resolved != root_resolved and root_resolved not in target_resolved.parents:
        raise ValueError(tr("保存文件夹超出提示词根目录"))
    return target, normalized, display_path


def create_folder(parent: str, name: str) -> dict:
    """Create one directory below an indexed folder and return its tree identity."""
    ensure_loaded()
    folder_name = _validated_folder_name(name)
    with _lock:
        parent_path, parent_key, parent_display = _resolve_folder_path_locked(parent)
        target = parent_path / folder_name
        target_key = normalize_key(f"{parent_key}/{folder_name}" if parent_key else folder_name)
        if target_key in _folder_display_paths or target.exists():
            raise FileExistsError(tr("已存在同名文件夹：{name}", name=folder_name))
        target.mkdir()
        display_path = f"{parent_display}/{folder_name}" if parent_display else folder_name
        _folder_dict[target_key] = []
        _folder_display_paths[target_key] = display_path
    return {
        "name": folder_name,
        "path": target_key,
        "display_path": display_path,
        "file_count": 0,
    }


def rename_folder(folder: str, name: str) -> dict:
    """Rename one indexed folder while preserving prompt metadata and keys."""
    global _file_dict, _folder_dict, _file_paths
    global _display_paths, _negative_dict, _note_dict, _folder_display_paths

    ensure_loaded()
    folder_key = normalize_key(folder)
    folder_name = _validated_folder_name(name)
    if not folder_key or folder_key == ROOT_WILDCARD_KEY:
        raise ValueError(tr("根目录不能重命名"))

    with _lock:
        root = Path(_loaded_root or get_wildcards_path())
        source_display = _folder_display_paths.get(folder_key)
        if not source_display:
            raise FileNotFoundError(tr("文件夹不存在，请刷新后重试"))
        source = root / Path(*source_display.split("/"))
        if not source.is_dir():
            raise FileNotFoundError(tr("文件夹不存在，请刷新后重试"))
        if source.name == folder_name:
            return {
                "old_path": folder_key,
                "path": folder_key,
                "name": folder_name,
                "display_path": source_display,
                "renamed_entries": 0,
                "file_count": len(_file_dict),
                "key_moves": {},
            }

        target = source.with_name(folder_name)
        target_display = str(target.relative_to(root)).replace("\\", "/")
        target_key = normalize_key(target_display)
        if target_key != folder_key and target_key in _folder_display_paths:
            raise FileExistsError(tr("已存在同名文件夹：{name}", name=folder_name))
        if target.exists() and not _paths_refer_to_same_file(source, target):
            raise FileExistsError(tr("已存在同名文件夹：{name}", name=folder_name))

        updated_file_dict: dict[str, list[str]] = {}
        updated_file_paths: dict[str, Path] = {}
        updated_display_paths: dict[str, str] = {}
        updated_negative_dict: dict[str, str] = {}
        updated_note_dict: dict[str, str] = {}
        key_moves: dict[str, str] = {}
        source_prefix = folder_key + "/"

        for current_key, options in _file_dict.items():
            current_path = _file_paths[current_key]
            if current_key.startswith(source_prefix):
                relative = current_path.relative_to(source)
                next_path = target / relative
                next_display = str(
                    next_path.relative_to(root).with_suffix("")
                ).replace("\\", "/")
                next_key = normalize_key(next_display)
                key_moves[current_key] = next_key
            else:
                next_path = current_path
                next_display = _display_paths[current_key]
                next_key = current_key
            if next_key in updated_file_dict:
                raise FileExistsError(tr("重命名后提示词键冲突：{key}", key=next_key))
            updated_file_dict[next_key] = list(options)
            updated_file_paths[next_key] = next_path
            updated_display_paths[next_key] = next_display
            if current_key in _negative_dict:
                updated_negative_dict[next_key] = _negative_dict[current_key]
            if current_key in _note_dict:
                updated_note_dict[next_key] = _note_dict[current_key]

        renamed = False
        try:
            _rename_case_safe(source, target)
            renamed = True
            updated_folder_dict, updated_folder_display_paths = _build_folder_indexes(
                updated_file_dict,
                updated_display_paths,
                root,
            )
        except Exception:
            if renamed and target.exists():
                _rename_case_safe(target, source)
            raise

        _file_dict = updated_file_dict
        _file_paths = updated_file_paths
        _display_paths = updated_display_paths
        _negative_dict = updated_negative_dict
        _note_dict = updated_note_dict
        _folder_dict = updated_folder_dict
        _folder_display_paths = updated_folder_display_paths

        try:
            metadata.apply_key_operations(
                root,
                moves=key_moves,
                current={
                    key: (updated_display_paths[key], _canonical_content(values))
                    for key, values in updated_file_dict.items()
                    if values
                },
            )
        except (metadata.MetadataError, OSError) as exc:
            logger.warning("Folder renamed but metadata could not be updated: %s", exc)

        return {
            "old_path": folder_key,
            "path": target_key,
            "name": folder_name,
            "display_path": target_display,
            "renamed_entries": len(key_moves),
            "file_count": len(updated_file_dict),
            "key_moves": key_moves,
        }


def create_entry(
    folder: str,
    name: str,
    content: str,
    *,
    negative: str = "",
    note: str = "",
) -> dict:
    """Create a JSON prompt inside an existing folder without overwriting."""
    ensure_loaded()
    entry_name = _validated_entry_name(name)
    normalized_content = _normalize_txt_text(content)
    if not normalized_content:
        raise ValueError(tr("提示词内容不能为空"))
    normalized_negative = _normalize_optional_prompt(negative)
    normalized_note = note.strip()

    with _lock:
        folder_path, folder_key, folder_display = _resolve_folder_path_locked(folder)
        target = folder_path / f"{entry_name}.json"
        target_key = normalize_key(f"{folder_key}/{entry_name}" if folder_key else entry_name)
        if target_key in _file_paths or target.exists():
            raise FileExistsError(tr("已存在同名提示词：{name}", name=entry_name))
        _write_json_prompt(
            target,
            content=normalized_content,
            negative=normalized_negative,
            note=normalized_note,
        )
        display_path = f"{folder_display}/{entry_name}" if folder_display else entry_name
        root = Path(_loaded_root or get_wildcards_path())
        _file_dict[target_key] = [normalized_content]
        _file_paths[target_key] = target
        _display_paths[target_key] = display_path
        _negative_dict[target_key] = normalized_negative
        _note_dict[target_key] = normalized_note

        root_options = _folder_dict.setdefault(ROOT_WILDCARD_KEY, [])
        if normalized_content not in root_options:
            root_options.append(normalized_content)
        key_parts = target_key.split("/")
        display_parts = display_path.split("/")
        for index in range(1, len(key_parts)):
            ancestor_key = "/".join(key_parts[:index])
            ancestor_options = _folder_dict.setdefault(ancestor_key, [])
            if normalized_content not in ancestor_options:
                ancestor_options.append(normalized_content)
            _folder_display_paths.setdefault(
                ancestor_key, "/".join(display_parts[:index])
            )

    try:
        metadata.migrate_entry(
            root,
            target_key,
            target_key,
            display_path=display_path,
            content=normalized_content,
        )
    except (metadata.MetadataError, OSError) as exc:
        logger.warning("Prompt created but metadata could not be refreshed: %s", exc)
    entry = get_entry(target_key)
    if not entry:
        raise RuntimeError(tr("创建后无法重新读取提示词"))
    return entry


def export_prompt_bundle(
    folder: str = "",
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Export every prompt below a folder into one portable JSON document."""
    ensure_loaded()
    with _lock:
        root = Path(_loaded_root or get_wildcards_path())
        _folder_path, folder_key, folder_display = _resolve_folder_path_locked(folder)
        prefix = f"{folder_key}/" if folder_key else ""
        prompt_keys = sorted(
            (
                key
                for key in _file_dict
                if not folder_key or key.startswith(prefix)
            ),
            key=lambda key: (_display_paths.get(key, key).casefold(), key),
        )
        total = len(prompt_keys)
        if progress_callback:
            progress_callback(0, total, tr("正在整理提示词"))
        records = []
        for index, key in enumerate(prompt_keys, 1):
            display_path = _display_paths.get(key, key)
            if folder_display:
                relative_inside = display_path[len(folder_display) + 1 :]
                selected_folder_name = folder_display.rsplit("/", 1)[-1]
                relative_path = f"{selected_folder_name}/{relative_inside}"
            else:
                relative_path = display_path
            options = _file_dict.get(key, [])
            source_path = _file_paths.get(key)
            is_txt = bool(
                source_path and source_path.suffix.casefold() == ".txt"
            )
            content = (
                read_txt_text(source_path)
                if is_txt and source_path
                else (options[0] if options else "")
            )
            records.append(
                {
                    "storage": "txt" if is_txt else "json",
                    "key": key,
                    "title": display_path.rsplit("/", 1)[-1],
                    "relative_path": relative_path,
                    "content": content,
                    "negative": "" if is_txt else _negative_dict.get(key, ""),
                    "note": "" if is_txt else _note_dict.get(key, ""),
                }
            )
            if progress_callback:
                progress_callback(index, total, tr("正在整理提示词"))

    if progress_callback:
        progress_callback(total, total, tr("正在整理自定义元数据"))
    sparse_metadata = metadata.get_entries_metadata(root, prompt_keys)
    for record in records:
        raw_metadata = sparse_metadata.get(record.pop("key"), {})
        if raw_metadata.get("favorite") is True:
            record["metadata"] = {"favorite": True}

    return {
        "format": BUNDLE_FORMAT,
        "source_folder": folder_display,
        "prompt_count": len(records),
        "prompts": records,
    }


def _validated_import_metadata(value: object, index: int) -> dict[str, object]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(tr("第 {index} 条提示词的 metadata 必须是对象", index=index))
    result: dict[str, object] = {}
    if "favorite" in value:
        if not isinstance(value["favorite"], bool):
            raise ValueError(
                tr("第 {index} 条提示词的 favorite 必须是布尔值", index=index)
            )
        if value["favorite"]:
            result["favorite"] = True
    return result


def _validated_import_document(
    raw: object,
    index: int,
    *,
    require_storage: bool,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(tr("第 {index} 条提示词必须是对象", index=index))
    content = raw.get("content")
    if require_storage and "storage" not in raw:
        raise ValueError(
            tr("第 {index} 条提示词必须声明 storage", index=index)
        )
    storage = raw.get("storage", "json")
    negative = raw.get("negative", "")
    note = raw.get("note", "")
    if not isinstance(content, str):
        raise ValueError(
            tr("第 {index} 条提示词的 content 必须是字符串", index=index)
        )
    if not isinstance(negative, str):
        raise ValueError(
            tr("第 {index} 条提示词的 negative 必须是字符串", index=index)
        )
    if not isinstance(note, str):
        raise ValueError(tr("第 {index} 条提示词的 note 必须是字符串", index=index))
    if storage not in {"json", "txt"}:
        raise ValueError(tr("第 {index} 条提示词的 storage 无效", index=index))
    if storage == "txt":
        if negative.strip() or note.strip():
            raise ValueError(
                tr(
                    "第 {index} 条 TXT Wildcard 不支持 negative 或 note",
                    index=index,
                )
            )
        normalized_content = content.replace("\r\n", "\n").replace("\r", "\n")
        if not parse_txt_options(normalized_content):
            raise ValueError(tr("第 {index} 条提示词内容为空", index=index))
    else:
        normalized_content = _normalize_txt_text(content)
    if not normalized_content:
        raise ValueError(tr("第 {index} 条提示词内容为空", index=index))
    return {
        "storage": storage,
        "content": normalized_content,
        "negative": "" if storage == "txt" else _normalize_optional_prompt(negative),
        "note": "" if storage == "txt" else note.strip(),
        "metadata": _validated_import_metadata(raw.get("metadata"), index),
    }


def _validated_relative_import_path(raw: dict, index: int) -> tuple[list[str], str]:
    value = raw.get("relative_path") or raw.get("title")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            tr("第 {index} 条提示词缺少 relative_path 或 title", index=index)
        )
    normalized = value.strip().replace("\\", "/").strip("/")
    parts = [part.strip() for part in normalized.split("/")]
    if not parts or any(not part for part in parts):
        raise ValueError(tr("第 {index} 条提示词的相对路径无效", index=index))
    if parts[-1].lower().endswith((".json", ".txt")):
        parts[-1] = parts[-1].rsplit(".", 1)[0]
    folder_parts = [_validated_folder_name(part) for part in parts[:-1]]
    if folder_parts and folder_parts[0].casefold() == metadata.INTERNAL_DIR_NAME.casefold():
        raise ValueError(tr("不能导入到内部元数据目录"))
    return folder_parts, _validated_entry_name(parts[-1])


def _plan_bulk_import_locked(
    folder: str,
    prompts: list[object],
    source_type: str,
    progress_callback: Optional[ProgressCallback] = None,
) -> tuple[Path, str, list[dict[str, Any]], int]:
    if source_type not in {"txt", "json"}:
        raise ValueError(tr("source_type 必须是 txt 或 json"))
    if not prompts or len(prompts) > MAX_BULK_IMPORT_PROMPTS:
        raise ValueError(
            tr(
                "一次必须导入 1 到 {maximum} 条提示词",
                maximum=MAX_BULK_IMPORT_PROMPTS,
            )
        )

    destination_path, destination_key, destination_display = _resolve_folder_path_locked(folder)
    documents = [
        _validated_import_document(
            raw,
            index,
            require_storage=source_type == "json",
        )
        for index, raw in enumerate(prompts, 1)
    ]
    if sum(
        len(document["content"]) + len(document["negative"]) + len(document["note"])
        for document in documents
    ) > MAX_BULK_IMPORT_CHARACTERS:
        raise ValueError(tr("导入的提示词文本总量过大"))

    next_number = 1
    if source_type == "txt":
        direct_numbers = [
            int(path.stem)
            for path in _file_paths.values()
            if path.parent == destination_path and path.stem.isdigit()
        ]
        next_number = max(direct_numbers, default=0) + 1

    used_keys = set(_file_paths)
    plan: list[dict[str, Any]] = []
    renamed_count = 0
    total = len(documents)
    if progress_callback:
        progress_callback(0, total, tr("正在检查导入内容"))
    for index, (raw, document) in enumerate(zip(prompts, documents), 1):
        if source_type == "txt":
            folder_parts: list[str] = []
            base_name = str(next_number)
            next_number += 1
        else:
            folder_parts, base_name = _validated_relative_import_path(raw, index)

        target_folder = destination_path.joinpath(*folder_parts)
        display_folder_parts = [part for part in (destination_display, *folder_parts) if part]
        display_folder = "/".join(display_folder_parts)
        suffix = 1
        while True:
            candidate_name = base_name if suffix == 1 else f"{base_name} ({suffix})"
            extension = ".txt" if document["storage"] == "txt" else ".json"
            target = target_folder / f"{candidate_name}{extension}"
            display_path = f"{display_folder}/{candidate_name}" if display_folder else candidate_name
            key = normalize_key(display_path)
            alternate = target.with_suffix(
                ".json" if extension == ".txt" else ".txt"
            )
            if key not in used_keys and not target.exists() and not alternate.exists():
                break
            suffix += 1
        if candidate_name != base_name:
            renamed_count += 1
        used_keys.add(key)
        plan.append(
            {
                **document,
                "title": candidate_name,
                "key": key,
                "display_path": display_path,
                "relative_path": "/".join([*folder_parts, candidate_name]),
                "target": target,
            }
        )
        if progress_callback:
            progress_callback(index, total, tr("正在检查导入内容"))
    return destination_path, destination_key, plan, renamed_count


def preview_bulk_import(
    folder: str,
    prompts: list[object],
    source_type: str,
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Validate a bulk import and return its resolved titles without writing."""
    ensure_loaded()
    with _lock:
        _destination, destination_key, plan, renamed_count = _plan_bulk_import_locked(
            folder, prompts, source_type, progress_callback
        )
        return {
            "count": len(plan),
            "destination": destination_key,
            "renamed_count": renamed_count,
            "preview": [
                {
                    "title": item["title"],
                    "relative_path": item["relative_path"],
                    "display_path": item["display_path"],
                }
                for item in plan[:6]
            ],
        }


def import_prompt_bundle(
    folder: str,
    prompts: list[object],
    source_type: str,
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Create a validated TXT/JSON batch without overwriting existing prompts."""
    ensure_loaded()
    with _lock:
        root = Path(_loaded_root or get_wildcards_path())
        destination, destination_key, plan, renamed_count = _plan_bulk_import_locked(
            folder, prompts, source_type
        )
        created_files: list[Path] = []
        created_dirs: set[Path] = set()
        total = len(plan)
        if progress_callback:
            progress_callback(0, total, tr("正在写入提示词"))
        try:
            for index, item in enumerate(plan, 1):
                target = item["target"]
                cursor = target.parent
                missing_dirs: list[Path] = []
                while cursor != destination and not cursor.exists():
                    missing_dirs.append(cursor)
                    cursor = cursor.parent
                target.parent.mkdir(parents=True, exist_ok=True)
                created_dirs.update(missing_dirs)
                if item["storage"] == "txt":
                    _write_txt_wildcard(target, item["content"])
                else:
                    _write_json_prompt(
                        target,
                        content=item["content"],
                        negative=item["negative"],
                        note=item["note"],
                    )
                created_files.append(target)
                if progress_callback:
                    progress_callback(index, total, tr("正在写入提示词"))
            if progress_callback:
                progress_callback(total, total, tr("正在同步提示词索引"))
            reload(root)
        except Exception:
            for path in reversed(created_files):
                path.unlink(missing_ok=True)
            for path in sorted(created_dirs, key=lambda value: len(value.parts), reverse=True):
                try:
                    path.rmdir()
                except OSError:
                    pass
            reload(root)
            raise

        imported_metadata = {
            item["key"]: item["metadata"]
            for item in plan
            if item["metadata"]
        }
        current = {
            item["key"]: (
                item["display_path"],
                (
                    "\n".join(parse_txt_options(item["content"]))
                    if item["storage"] == "txt"
                    else item["content"]
                ),
            )
            for item in plan
        }
        try:
            if progress_callback:
                progress_callback(total, total, tr("正在恢复自定义元数据"))
            metadata.apply_imported_metadata(root, imported_metadata, current)
        except (metadata.MetadataError, OSError) as exc:
            logger.warning("Prompts imported but metadata could not be restored: %s", exc)

        return {
            "created": len(plan),
            "destination": destination_key,
            "renamed_count": renamed_count,
            "created_preview": [item["display_path"] for item in plan[:6]],
            "file_count": len(_file_dict),
        }


def _available_txt_target_locked(
    destination: Path,
    destination_display: str,
    relative_parent: tuple[str, ...],
    name: str,
    used_keys: set[str],
) -> tuple[Path, str, str, bool]:
    target_folder = destination.joinpath(*relative_parent)
    display_folder = "/".join(
        part for part in (destination_display, *relative_parent) if part
    )
    suffix = 1
    while True:
        candidate_name = name if suffix == 1 else f"{name} ({suffix})"
        target = target_folder / f"{candidate_name}.txt"
        display_path = (
            f"{display_folder}/{candidate_name}" if display_folder else candidate_name
        )
        key = normalize_key(display_path)
        companions_exist = any(
            target.with_suffix(extension).exists()
            for extension in (*IMAGE_EXTS, ".json")
        )
        if key not in used_keys and not target.exists() and not companions_exist:
            return target, key, display_path, suffix > 1
        suffix += 1


def preview_txt_wildcard_import(
    folder: str,
    name: str,
    content: str,
) -> dict[str, Any]:
    """Preview one TXT pool without expanding its lines into JSON records."""
    ensure_loaded()
    options = parse_txt_options(content)
    if not options:
        raise ValueError(tr("提示词内容不能为空"))
    entry_name = _validated_entry_name(name)
    with _lock:
        destination, destination_key, destination_display = _resolve_folder_path_locked(
            folder
        )
        target, key, display_path, renamed = _available_txt_target_locked(
            destination,
            destination_display,
            (),
            entry_name,
            set(_file_paths),
        )
        return {
            "format": "txt_wildcard",
            "count": 1,
            "file_count": 1,
            "option_count": len(options),
            "destination": destination_key,
            "renamed_count": int(renamed),
            "key": key,
            "display_path": display_path,
            "filename": target.name,
            "sample": options[:3],
        }


def import_txt_wildcard(
    folder: str,
    name: str,
    content: str,
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Write one traditional TXT wildcard as one library entry."""
    ensure_loaded()
    options = parse_txt_options(content)
    if not options:
        raise ValueError(tr("提示词内容不能为空"))
    entry_name = _validated_entry_name(name)
    with _lock:
        root = Path(_loaded_root or get_wildcards_path())
        destination, destination_key, destination_display = _resolve_folder_path_locked(
            folder
        )
        target, key, display_path, renamed = _available_txt_target_locked(
            destination,
            destination_display,
            (),
            entry_name,
            set(_file_paths),
        )
        if progress_callback:
            progress_callback(0, 1, tr("正在写入提示词"))
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_txt_wildcard(target, content)
        try:
            if progress_callback:
                progress_callback(1, 1, tr("正在同步提示词索引"))
            reload(root)
        except Exception:
            target.unlink(missing_ok=True)
            reload(root)
            raise
        return {
            "created": 1,
            "format": "txt_wildcard",
            "destination": destination_key,
            "renamed_count": int(renamed),
            "option_count": len(options),
            "key": key,
            "display_path": display_path,
            "file_count": len(_file_dict),
        }


def _plan_external_txt_import_locked(
    folder: str,
    files: list[dict[str, Any]],
) -> tuple[Path, str, list[dict[str, Any]], int]:
    destination, destination_key, destination_display = _resolve_folder_path_locked(
        folder
    )
    used_keys = set(_file_paths)
    plan: list[dict[str, Any]] = []
    renamed_count = 0
    for file in files:
        source = Path(file.get("path", ""))
        relative_text = str(file.get("relative_path", "")).replace("\\", "/")
        relative = Path(relative_text)
        if (
            not source.is_file()
            or source.suffix.casefold() != ".txt"
            or relative.is_absolute()
            or relative.suffix.casefold() != ".txt"
            or any(part in {"", ".", ".."} for part in relative.parts)
        ):
            raise ValueError(tr("外部 Wildcard 文件无效"))
        parent_parts = tuple(
            _validated_folder_name(part) for part in relative.parent.parts
            if part not in {"", "."}
        )
        name = _validated_entry_name(relative.stem)
        target, key, display_path, renamed = _available_txt_target_locked(
            destination,
            destination_display,
            parent_parts,
            name,
            used_keys,
        )
        used_keys.add(key)
        renamed_count += int(renamed)
        plan.append(
            {
                "source": source,
                "target": target,
                "key": key,
                "display_path": display_path,
                "option_count": int(file.get("option_count", 0)),
            }
        )
    return destination, destination_key, plan, renamed_count


def preview_external_txt_import(
    folder: str,
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    ensure_loaded()
    with _lock:
        _destination, destination_key, plan, renamed_count = (
            _plan_external_txt_import_locked(folder, files)
        )
        return {
            "format": "txt_wildcard",
            "destination": destination_key,
            "file_count": len(plan),
            "option_count": sum(item["option_count"] for item in plan),
            "renamed_count": renamed_count,
            "preview": [item["display_path"] for item in plan[:6]],
        }


def import_external_txt_files(
    folder: str,
    files: list[dict[str, Any]],
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Copy trusted, server-resolved external TXT files into the library."""
    ensure_loaded()
    with _lock:
        root = Path(_loaded_root or get_wildcards_path())
        destination, destination_key, plan, renamed_count = (
            _plan_external_txt_import_locked(folder, files)
        )
        created: list[Path] = []
        created_dirs: set[Path] = set()
        total = len(plan)
        if progress_callback:
            progress_callback(0, total, tr("正在写入提示词"))
        try:
            for index, item in enumerate(plan, 1):
                source = item["source"]
                target = item["target"]
                cursor = target.parent
                while cursor != destination and not cursor.exists():
                    created_dirs.add(cursor)
                    cursor = cursor.parent
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                created.append(target)
                for extension in IMAGE_EXTS:
                    companion = source.with_suffix(extension)
                    if companion.is_file():
                        companion_target = target.with_suffix(extension)
                        shutil.copy2(companion, companion_target)
                        created.append(companion_target)
                        break
                if progress_callback:
                    progress_callback(index, total, tr("正在写入提示词"))
            if progress_callback:
                progress_callback(total, total, tr("正在同步提示词索引"))
            reload(root)
        except Exception:
            for path in reversed(created):
                path.unlink(missing_ok=True)
            for path in sorted(created_dirs, key=lambda value: len(value.parts), reverse=True):
                try:
                    path.rmdir()
                except OSError:
                    pass
            reload(root)
            raise
        return {
            "created": len(plan),
            "format": "txt_wildcard",
            "destination": destination_key,
            "renamed_count": renamed_count,
            "option_count": sum(item["option_count"] for item in plan),
            "keys": [item["key"] for item in plan],
            "created_preview": [item["display_path"] for item in plan[:6]],
            "file_count": len(_file_dict),
        }


def _lexical_path(path: Path) -> Path:
    """Return an absolute path without touching the filesystem.

    ``Path.resolve()`` performs filesystem work on Windows. Calling it for
    every indexed prompt made a two-file folder operation scale with the
    entire library and take several seconds.
    """
    return Path(os.path.abspath(os.fspath(path)))


def _path_identity(path: Path) -> str:
    return os.path.normcase(os.fspath(_lexical_path(path)))


def _is_within_path(path: Path, parent: Path) -> bool:
    try:
        _lexical_path(path).relative_to(_lexical_path(parent))
        return True
    except ValueError:
        return False


def _entry_identity(root: Path, path: Path) -> tuple[str, str]:
    relative = path.relative_to(root).with_suffix("")
    display_path = str(relative).replace("\\", "/")
    return normalize_key(display_path), display_path


def _copy_name(path: Path, number: int) -> str:
    suffix = " - 副本" if number == 1 else f" - 副本 {number}"
    return f"{path.stem}{suffix}{path.suffix}"


def _file_companions(source: Path, target: Optional[Path] = None) -> list[tuple[Path, Optional[Path]]]:
    pairs: list[tuple[Path, Optional[Path]]] = [(source, target)]
    for extension in IMAGE_EXTS:
        image = source.with_suffix(extension)
        if image.is_file():
            pairs.append((image, target.with_suffix(extension) if target else None))

    return pairs


def _rebuild_folder_indexes_from_known(
    file_dict: dict[str, list[str]],
    display_paths: dict[str, str],
    known_folders: dict[str, str],
) -> tuple[dict[str, list[str]], dict[str, str]]:
    folder_dict, folder_display_paths = _build_folder_indexes(file_dict, display_paths)
    for key, display_path in known_folders.items():
        if not key or key == ROOT_WILDCARD_KEY:
            continue
        folder_dict.setdefault(key, [])
        folder_display_paths.setdefault(key, display_path)
    return folder_dict, folder_display_paths


def operate_items(
    action: str,
    items: Iterable[dict],
    destination: str = "",
    progress_callback: Optional[ProgressCallback] = None,
) -> dict:
    """Delete, copy, or move indexed entries without rescanning the library."""
    global _file_dict, _folder_dict, _file_paths
    global _display_paths, _negative_dict, _note_dict, _folder_display_paths

    ensure_loaded()
    if action not in {"delete", "copy", "move"}:
        raise ValueError(tr("不支持的操作"))

    selected_files: list[str] = []
    selected_folders: list[str] = []
    seen: set[tuple[str, str]] = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError(tr("操作项目格式无效"))
        kind = raw.get("type")
        key = normalize_key(raw.get("key", "")) if isinstance(raw.get("key"), str) else ""
        identity = (str(kind), key)
        if identity in seen:
            continue
        seen.add(identity)
        if kind == "file" and key:
            selected_files.append(key)
        elif kind == "folder" and key and key != ROOT_WILDCARD_KEY:
            selected_folders.append(key)
        else:
            raise ValueError(tr("根目录不能删除、复制或移动"))
    if not selected_files and not selected_folders:
        raise ValueError(tr("没有可操作的项目"))

    # An ancestor folder already includes every nested selection.
    selected_folders.sort(key=lambda value: (value.count("/"), value))
    minimal_folders: list[str] = []
    for key in selected_folders:
        if any(key == parent or key.startswith(parent + "/") for parent in minimal_folders):
            continue
        minimal_folders.append(key)
    selected_folders = minimal_folders
    selected_files = [
        key for key in selected_files
        if not any(key.startswith(folder + "/") for folder in selected_folders)
    ]

    with _lock:
        root = Path(_loaded_root or get_wildcards_path()).resolve()
        if action == "delete":
            destination_path = root
            destination_key = ""
            destination_display = ""
        else:
            destination_path, destination_key, destination_display = _resolve_folder_path_locked(destination)
            destination_path = destination_path.resolve()

        for key in selected_files:
            if key not in _file_paths:
                raise FileNotFoundError(tr("提示词不存在：{key}", key=key))
        for key in selected_folders:
            if key not in _folder_display_paths:
                raise FileNotFoundError(tr("文件夹不存在：{key}", key=key))

        original_file_dict = dict(_file_dict)
        original_file_paths = dict(_file_paths)
        original_display_paths = dict(_display_paths)
        original_negative_dict = dict(_negative_dict)
        original_note_dict = dict(_note_dict)
        original_folder_displays = dict(_folder_display_paths)
        indexed_paths = {_path_identity(path): key for key, path in original_file_paths.items()}
        reserved_targets: set[str] = set()
        plans: list[dict] = []

        selected_folder_paths = [
            root / Path(*original_folder_displays[key].split("/"))
            for key in selected_folders
        ]
        if action != "delete" and any(_is_within_path(destination_path, source) for source in selected_folder_paths):
            raise ValueError(tr("目标文件夹不能位于正在操作的文件夹内部"))

        for key, source in sorted(
            (key, original_file_paths[key]) for key in selected_files
        ):
            source_id = _path_identity(source)
            if any(source_id == _path_identity(old) for plan in plans for old, _new in plan.get("pairs", [])):
                continue

            if action == "delete":
                pairs = _file_companions(source)
            else:
                candidate = destination_path / source.name
                if action == "move" and _paths_refer_to_same_file(source, candidate):
                    raise ValueError(
                        tr("“{name}”已经在目标文件夹中", name=source.stem)
                    )
                copy_number = 0
                while True:
                    pairs = _file_companions(source, candidate)
                    collisions = [
                        target for _old, target in pairs
                        if target and (target.exists() or _path_identity(target) in reserved_targets)
                    ]
                    target_keys = [
                        _entry_identity(root, target)[0]
                        for old, target in pairs
                        if target and _path_identity(old) in indexed_paths
                    ]
                    key_collision = any(
                        target_key in original_file_paths
                        and not (
                            action == "move"
                            and target_key == indexed_paths.get(_path_identity(old))
                        )
                        for (old, target), target_key in zip(
                            [(old, target) for old, target in pairs if target and _path_identity(old) in indexed_paths],
                            target_keys,
                        )
                    )
                    if not collisions and not key_collision:
                        break
                    if action == "move":
                        raise FileExistsError(
                            tr("目标文件夹中已存在同名提示词：{name}", name=source.name)
                        )
                    copy_number += 1
                    candidate = destination_path / _copy_name(source, copy_number)
                reserved_targets.update(_path_identity(target) for _old, target in pairs if target)
            plans.append({"kind": "file", "source": source, "pairs": pairs})

        for key in selected_folders:
            display_path = original_folder_displays[key]
            source = root / Path(*display_path.split("/"))
            if action == "delete":
                target = None
            else:
                target = destination_path / source.name
                if _path_identity(target) == _path_identity(source):
                    raise ValueError(
                        tr("“{name}”已经在目标文件夹中", name=source.name)
                    )
                copy_number = 0
                while target.exists() or _path_identity(target) in reserved_targets:
                    if action == "move":
                        raise FileExistsError(
                            tr("目标文件夹中已存在同名文件夹：{name}", name=source.name)
                        )
                    copy_number += 1
                    suffix = " - 副本" if copy_number == 1 else f" - 副本 {copy_number}"
                    target = destination_path / f"{source.name}{suffix}"
                reserved_targets.add(_path_identity(target))
            plans.append({
                "kind": "folder",
                "key": key,
                "display_path": display_path,
                "source": source,
                "target": target,
            })

        # All conflicts are checked before the first filesystem mutation.
        total = len(plans)
        action_labels = {
            "delete": tr("正在删除文件"),
            "copy": tr("正在复制文件"),
            "move": tr("正在移动文件"),
        }
        progress_label = action_labels[action]
        if progress_callback:
            progress_callback(0, total, progress_label)
        for index, plan in enumerate(plans, 1):
            if plan["kind"] == "folder":
                source = plan["source"]
                target = plan["target"]
                if action == "delete":
                    shutil.rmtree(source)
                elif action == "copy":
                    shutil.copytree(source, target)
                else:
                    shutil.move(str(source), str(target))
                if progress_callback:
                    progress_callback(index, total, progress_label)
                continue
            pairs = plan["pairs"]
            if action == "delete":
                for source, _target in pairs:
                    source.unlink(missing_ok=True)
            elif action == "copy":
                for source, target in pairs:
                    assert target is not None
                    shutil.copy2(source, target)
            else:
                for source, target in pairs:
                    assert target is not None
                    shutil.move(str(source), str(target))
            if progress_callback:
                progress_callback(index, total, progress_label)

        next_file_dict = dict(original_file_dict)
        next_file_paths = dict(original_file_paths)
        next_display_paths = dict(original_display_paths)
        next_negative_dict = dict(original_negative_dict)
        next_note_dict = dict(original_note_dict)
        key_moves: dict[str, str] = {}
        key_copies: dict[str, str] = {}
        deleted_keys: set[str] = set()

        def apply_index_change(old_key: str, target_path: Optional[Path]) -> None:
            if action in {"delete", "move"}:
                next_file_dict.pop(old_key, None)
                next_file_paths.pop(old_key, None)
                next_display_paths.pop(old_key, None)
                next_negative_dict.pop(old_key, None)
                next_note_dict.pop(old_key, None)
            if action == "delete" or target_path is None:
                deleted_keys.add(old_key)
                return
            new_key, new_display = _entry_identity(root, target_path)
            next_file_dict[new_key] = list(original_file_dict[old_key])
            next_file_paths[new_key] = target_path
            next_display_paths[new_key] = new_display
            next_negative_dict[new_key] = original_negative_dict.get(old_key, "")
            next_note_dict[new_key] = original_note_dict.get(old_key, "")
            if action == "move":
                key_moves[old_key] = new_key
            else:
                key_copies[old_key] = new_key

        for plan in plans:
            if plan["kind"] == "file":
                for source, target in plan["pairs"]:
                    old_key = indexed_paths.get(_path_identity(source))
                    if old_key:
                        apply_index_change(old_key, target)
                continue
            source = plan["source"]
            target = plan["target"]
            source_key = plan["key"]
            source_prefix = source_key + "/"
            for old_key, old_path in original_file_paths.items():
                if old_key.startswith(source_prefix):
                    relative = old_path.relative_to(source)
                    apply_index_change(old_key, target / relative if target else None)

        next_folder_displays: dict[str, str] = {}
        for folder_key, folder_display in original_folder_displays.items():
            if folder_key == ROOT_WILDCARD_KEY:
                continue
            matching_plan = next(
                (
                    plan for plan in plans
                    if plan["kind"] == "folder"
                    and (
                        folder_key == plan["key"]
                        or folder_key.startswith(plan["key"] + "/")
                    )
                ),
                None,
            )
            if not matching_plan:
                next_folder_displays[folder_key] = folder_display
                continue
            if action == "delete":
                continue
            source_depth = len(matching_plan["display_path"].split("/"))
            relative_parts = folder_display.split("/")[source_depth:]
            target_path = matching_plan["target"].joinpath(*relative_parts)
            target_display = str(target_path.relative_to(root)).replace("\\", "/")
            target_key = normalize_key(target_display)
            if action == "copy":
                next_folder_displays[folder_key] = folder_display
            if target_key:
                next_folder_displays[target_key] = target_display

        next_folder_dict, next_folder_displays = _rebuild_folder_indexes_from_known(
            next_file_dict, next_display_paths, next_folder_displays
        )
        _file_dict = next_file_dict
        _file_paths = next_file_paths
        _display_paths = next_display_paths
        _negative_dict = next_negative_dict
        _note_dict = next_note_dict
        _folder_dict = next_folder_dict
        _folder_display_paths = next_folder_displays

        try:
            if progress_callback:
                progress_callback(total, total, tr("正在同步自定义元数据"))
            metadata.apply_key_operations(
                root,
                moves=key_moves,
                copies=key_copies,
                deletes=deleted_keys,
                current=None if action == "delete" else {
                    key: (next_display_paths[key], _canonical_content(values))
                    for key, values in next_file_dict.items()
                    if values
                },
            )
        except (metadata.MetadataError, OSError) as exc:
            logger.warning("Items changed but metadata could not be updated: %s", exc)

        result = {
            "action": action,
            "affected": len(plans),
            "file_count": len(next_file_dict),
        }
        if action == "delete":
            result["deleted_keys"] = sorted(deleted_keys)
            result["deleted_folders"] = sorted(selected_folders)
        else:
            result["favorites"] = get_favorites()
            result["key_moves"] = dict(key_moves)
            result["key_copies"] = dict(key_copies)
        return result


def list_entries(
    *,
    prefix: str = "",
    search: str = "",
    limit: int = 100,
    offset: int = 0,
    immediate_only: bool = True,
    sort_by: str = "path:asc",
    favorites_only: bool = False,
) -> tuple[list[dict], int]:
    """
    List wildcard *file* entries for the browser grid (folders live in /api/tree).

    immediate_only: if True and prefix set, only files directly in that folder.
    When prefix is empty, return files from the whole library.
    """
    ensure_loaded()
    prefix_n = normalize_key(prefix) if prefix else ""
    search_n = search.strip().lower()
    favorite_keys = set(get_favorites()) if favorites_only else None

    with _lock:
        items: list[dict] = []
        for key, lines in _file_dict.items():
            if favorite_keys is not None and key not in favorite_keys:
                continue
            display_path = _display_paths.get(key, key)
            name = display_path.split("/")[-1]
            source_path = _file_paths.get(key)
            entry_format = _entry_format(source_path)

            if prefix_n:
                if immediate_only:
                    if not key.startswith(prefix_n + "/"):
                        continue
                    rest = key[len(prefix_n) + 1 :]
                    if "/" in rest:
                        continue
                elif not (key == prefix_n or key.startswith(prefix_n + "/")):
                    continue

            if search_n:
                hay = (
                    f"{key} {display_path} {name} {' '.join(lines)} "
                    f"{_negative_dict.get(key, '')} {_note_dict.get(key, '')}"
                ).lower()
                if search_n not in hay:
                    continue

            items.append(
                {
                    "key": key,
                    "name": name,
                    "display_path": display_path,
                    "type": "file",
                    "format": entry_format,
                    "option_count": len(lines),
                    "wildcard_syntax": f"__{key}__",
                    "capabilities": _entry_capabilities(entry_format),
                }
            )

    sort_mode = sort_by if sort_by in LIST_SORT_MODES else "path:asc"

    def path_sort_key(item: dict) -> tuple[str, str, str]:
        display_path = item["display_path"]
        parent, _, name = display_path.rpartition("/")
        return (parent.casefold(), name.casefold(), item["key"])

    def name_sort_key(item: dict) -> tuple[str, str, str]:
        return (item["name"].casefold(), item["display_path"].casefold(), item["key"])

    items.sort(
        key=name_sort_key if sort_mode.startswith("name:") else path_sort_key,
        reverse=sort_mode.endswith(":desc"),
    )
    total = len(items)
    page = items[offset : offset + limit]
    # Sidecar checks touch the filesystem, so only do them for the requested
    # page instead of every matching item in a large recursive/root listing.
    for item in page:
        txt_path = _file_paths.get(item["key"])
        item["has_image"] = bool(txt_path and _find_sidecar_image(txt_path))
    return page, total


def get_entry(key: str) -> Optional[dict]:
    ensure_loaded()
    n = normalize_key(key)
    with _lock:
        if n in _file_dict:
            txt_path = _file_paths.get(n)
            img = _find_sidecar_image(txt_path) if txt_path else None
            options = _file_dict[n]
            display_path = _display_paths.get(n, n)
            entry_format = _entry_format(txt_path)
            preview_options = options[:200] if entry_format == "txt_wildcard" else options
            content = "\n".join(preview_options)
            is_txt = entry_format == "txt_wildcard"
            return {
                "key": n,
                "type": "file",
                "name": display_path.split("/")[-1],
                "display_path": display_path,
                "format": entry_format,
                "option_count": len(options),
                "wildcard_syntax": f"__{n}__",
                "content": content,
                "negative": _negative_dict.get(n, ""),
                "note": _note_dict.get(n, ""),
                "lines": list(preview_options),
                "truncated": is_txt and len(options) > len(preview_options),
                "capabilities": _entry_capabilities(entry_format),
                "has_image": bool(img),
                "image_ext": img.suffix.lower() if img else None,
            }
        if n in _folder_dict:
            display_path = _folder_display_paths.get(n, n)
            return {
                "key": n,
                "type": "folder",
                "name": display_path.split("/")[-1],
                "display_path": display_path,
                "content": "",
                "option_count": len(_folder_dict[n]),
                "wildcard_syntax": f"__{n}__",
                "has_image": False,
            }
    return None


def get_favorites() -> list[str]:
    """Return existing favorite entry keys from the library metadata file."""
    ensure_loaded()
    with _lock:
        root = _loaded_root or get_wildcards_path()
        existing = set(_file_dict)
    return [key for key in metadata.list_favorites(root) if key in existing]


def set_favorite(key: str, favorite: bool) -> bool:
    """Persist one favorite flag outside the browser profile."""
    ensure_loaded()
    normalized_key = normalize_key(key)
    with _lock:
        root = _loaded_root
        options = _file_dict.get(normalized_key)
        display_path = _display_paths.get(normalized_key)
        if not root or not options or not display_path:
            raise FileNotFoundError(tr("提示词不存在"))
        metadata.set_favorite(
            root,
            normalized_key,
            bool(favorite),
            display_path=display_path,
            content=_canonical_content(options),
        )
    return bool(favorite)


def _update_json_entry_locked(
    normalized_key: str,
    source_path: Path,
    root: Path,
    *,
    name: Optional[str],
    content: Optional[str],
    negative: Optional[str],
    note: Optional[str],
) -> dict:
    global _file_dict, _folder_dict, _file_paths
    global _display_paths, _negative_dict, _note_dict, _folder_display_paths

    current_content = _file_dict[normalized_key][0]
    current_negative = _negative_dict.get(normalized_key, "")
    current_note = _note_dict.get(normalized_key, "")
    next_content = _normalize_txt_text(content) if content is not None else current_content
    if content is not None and not next_content:
        raise ValueError(tr("提示词内容不能为空"))
    next_negative = (
        _normalize_optional_prompt(negative) if negative is not None else current_negative
    )
    next_note = note.strip() if note is not None else current_note

    target_name = _validated_entry_name(name) if name is not None else source_path.stem
    target_path = source_path.with_name(f"{target_name}.json")
    relative_target = target_path.relative_to(root).with_suffix("")
    display_path = str(relative_target).replace("\\", "/")
    target_key = normalize_key(display_path)
    existing_key_path = _file_paths.get(target_key)
    if existing_key_path and not _paths_refer_to_same_file(source_path, existing_key_path):
        raise FileExistsError(tr("已存在同名提示词键：{key}", key=target_key))

    rename_pairs: list[tuple[Path, Path]] = [(source_path, target_path)]
    for extension in IMAGE_EXTS:
        source_image = source_path.with_suffix(extension)
        if source_image.is_file():
            rename_pairs.append((source_image, target_path.with_suffix(extension)))
    for source, target in rename_pairs:
        if target.exists() and not _paths_refer_to_same_file(source, target):
            raise FileExistsError(tr("已存在同名文件：{filename}", filename=target.name))

    updated_file_dict = dict(_file_dict)
    updated_file_paths = dict(_file_paths)
    updated_display_paths = dict(_display_paths)
    updated_negative_dict = dict(_negative_dict)
    updated_note_dict = dict(_note_dict)
    if target_key != normalized_key:
        updated_file_dict.pop(normalized_key, None)
        updated_file_paths.pop(normalized_key, None)
        updated_display_paths.pop(normalized_key, None)
        updated_negative_dict.pop(normalized_key, None)
        updated_note_dict.pop(normalized_key, None)
    updated_file_dict[target_key] = [next_content]
    updated_file_paths[target_key] = target_path
    updated_display_paths[target_key] = display_path
    updated_negative_dict[target_key] = next_negative
    updated_note_dict[target_key] = next_note
    updated_folder_dict, updated_folder_display_paths = _build_folder_indexes(
        updated_file_dict, updated_display_paths, root
    )

    fields_changed = (
        next_content != current_content
        or next_negative != current_negative
        or next_note != current_note
    )
    if fields_changed:
        metadata.archive_files(
            root,
            "prompt-document-replace",
            normalized_key,
            [source_path],
        )

    renamed: list[tuple[Path, Path]] = []
    try:
        for source, target in rename_pairs:
            if source != target:
                _rename_case_safe(source, target)
                renamed.append((target, source))
        if fields_changed:
            _write_json_prompt(
                target_path,
                content=next_content,
                negative=next_negative,
                note=next_note,
            )
    except Exception:
        for current, original in reversed(renamed):
            if current.exists():
                _rename_case_safe(current, original)
        raise

    _file_dict = updated_file_dict
    _file_paths = updated_file_paths
    _display_paths = updated_display_paths
    _negative_dict = updated_negative_dict
    _note_dict = updated_note_dict
    _folder_dict = updated_folder_dict
    _folder_display_paths = updated_folder_display_paths
    try:
        metadata.migrate_entry(
            root,
            normalized_key,
            target_key,
            display_path=display_path,
            content=next_content,
        )
    except (metadata.MetadataError, OSError) as exc:
        logger.warning("Prompt saved but metadata could not be updated: %s", exc)
    entry = get_entry(target_key)
    if not entry:
        raise RuntimeError(tr("保存后无法重新读取提示词"))
    return entry


def update_entry(
    key: str,
    *,
    name: Optional[str] = None,
    content: Optional[str] = None,
    negative: Optional[str] = None,
    note: Optional[str] = None,
) -> dict:
    """Update a prompt file and optionally rename its sidecar previews."""
    global _file_dict, _folder_dict, _file_paths
    global _display_paths, _folder_display_paths

    ensure_loaded()
    normalized_key = normalize_key(key)
    if name is None and content is None and negative is None and note is None:
        raise ValueError(tr("没有可保存的修改"))

    with _lock:
        source_path = _file_paths.get(normalized_key)
        root = _loaded_root
        if not source_path or not root:
            raise FileNotFoundError(tr("提示词不存在"))
        if source_path.suffix.casefold() == ".json":
            return _update_json_entry_locked(
                normalized_key,
                source_path,
                root,
                name=name,
                content=content,
                negative=negative,
                note=note,
            )
        if content is not None or negative is not None or note is not None:
            raise ValueError(tr("TXT Wildcard 内容只能使用外部文本编辑器修改"))

        target_name = _validated_entry_name(name) if name is not None else source_path.stem
        target_path = source_path.with_name(f"{target_name}.txt")
        relative_target = target_path.relative_to(root).with_suffix("")
        target_key = normalize_key(str(relative_target).replace("\\", "/"))
        existing_key_path = _file_paths.get(target_key)
        if existing_key_path and not _paths_refer_to_same_file(source_path, existing_key_path):
            raise FileExistsError(tr("已存在同名提示词键：{key}", key=target_key))

        rename_pairs: list[tuple[Path, Path]] = [(source_path, target_path)]
        for extension in IMAGE_EXTS:
            source_image = source_path.with_suffix(extension)
            if source_image.is_file():
                rename_pairs.append((source_image, target_path.with_suffix(extension)))

        for source, target in rename_pairs:
            if target.exists() and not _paths_refer_to_same_file(source, target):
                raise FileExistsError(
                    tr("已存在同名文件：{filename}", filename=target.name)
                )

        display_path = str(relative_target).replace("\\", "/")
        updated_file_dict: dict[str, list[str]] = {}
        updated_file_paths: dict[str, Path] = {}
        updated_display_paths: dict[str, str] = {}
        for current_key, options in _file_dict.items():
            if current_key == normalized_key:
                updated_file_dict[target_key] = list(options)
                updated_file_paths[target_key] = target_path
                updated_display_paths[target_key] = display_path
            else:
                updated_file_dict[current_key] = options
                updated_file_paths[current_key] = _file_paths[current_key]
                updated_display_paths[current_key] = _display_paths[current_key]
        updated_folder_dict, updated_folder_display_paths = _build_folder_indexes(
            updated_file_dict, updated_display_paths, root
        )

        renamed: list[tuple[Path, Path]] = []
        try:
            for source, target in rename_pairs:
                if source != target:
                    _rename_case_safe(source, target)
                    renamed.append((target, source))
        except Exception:
            for current, original in reversed(renamed):
                if current.exists():
                    _rename_case_safe(current, original)
            raise

        _file_dict = updated_file_dict
        _file_paths = updated_file_paths
        _display_paths = updated_display_paths
        _folder_dict = updated_folder_dict
        _folder_display_paths = updated_folder_display_paths
        try:
            metadata.migrate_entry(
                root,
                normalized_key,
                target_key,
                display_path=display_path,
                content="\n".join(updated_file_dict[target_key]),
            )
        except (metadata.MetadataError, OSError) as exc:
            logger.warning("Prompt saved but metadata could not be updated: %s", exc)
        entry = get_entry(target_key)
        if not entry:
            raise RuntimeError(tr("保存后无法重新读取提示词"))
        return entry


def update_entry_image(key: str, data: bytes) -> dict:
    """Atomically replace the sidecar preview for one prompt file."""
    ensure_loaded()
    normalized_key = normalize_key(key)
    extension = _detect_image_extension(data)
    if not extension:
        raise ValueError(tr("仅支持 PNG、JPG、WEBP 或 GIF 图片"))

    with _lock:
        txt_path = _file_paths.get(normalized_key)
        root = _loaded_root
        if not txt_path or not root:
            raise FileNotFoundError(tr("提示词不存在"))

        target_path = txt_path.with_suffix(extension)
        temporary = txt_path.with_name(
            f".{txt_path.stem}.pm4a-image-{uuid.uuid4().hex}.tmp"
        )
        backups: list[tuple[Path, Path]] = []
        installed = False
        current_images = [
            txt_path.with_suffix(image_extension)
            for image_extension in IMAGE_EXTS
            if txt_path.with_suffix(image_extension).is_file()
        ]
        metadata.archive_files(
            root,
            "preview-image-replace",
            normalized_key,
            current_images,
        )
        try:
            temporary.write_bytes(data)
            for image_extension in IMAGE_EXTS:
                current = txt_path.with_suffix(image_extension)
                if not current.is_file():
                    continue
                backup = current.with_name(
                    f".{current.name}.pm4a-backup-{uuid.uuid4().hex}.tmp"
                )
                current.rename(backup)
                backups.append((current, backup))
            os.replace(temporary, target_path)
            installed = True
        except Exception:
            temporary.unlink(missing_ok=True)
            if installed:
                target_path.unlink(missing_ok=True)
            for original, backup in reversed(backups):
                if backup.exists():
                    backup.rename(original)
            raise

        for _original, backup in backups:
            try:
                backup.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("Failed to remove preview backup %s: %s", backup, exc)

        entry = get_entry(normalized_key)
        if not entry:
            raise RuntimeError(tr("保存后无法重新读取提示词"))
        return entry


def get_image_path(key: str) -> Optional[Path]:
    ensure_loaded()
    n = normalize_key(key)
    with _lock:
        txt_path = _file_paths.get(n)
    if not txt_path:
        return None
    return _find_sidecar_image(txt_path)


def get_txt_entry_path(key: str) -> Path:
    """Resolve an indexed TXT key while enforcing the library sandbox."""
    ensure_loaded()
    normalized = normalize_key(key)
    with _lock:
        path = _file_paths.get(normalized)
        root = Path(_loaded_root or get_wildcards_path()).resolve()
    if (
        not path
        or path.suffix.casefold() != ".txt"
    ):
        raise FileNotFoundError(tr("传统 TXT Wildcard 不存在"))
    resolved = path.resolve()
    if root not in resolved.parents:
        raise ValueError(tr("提示词路径超出允许目录"))
    return resolved


def open_txt_entry(key: str, action: str) -> None:
    """Open an indexed TXT in its editor or reveal it in the file manager."""
    if action not in {"edit", "reveal"}:
        raise ValueError(tr("打开方式无效"))
    path = get_txt_entry_path(key)
    if sys.platform == "win32":
        if action == "reveal":
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(path)  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if action == "reveal" else ["open", str(path)])
        return
    subprocess.Popen(["xdg-open", str(path.parent if action == "reveal" else path)])


def build_folder_tree() -> dict:
    """
    Nested folder tree from wildcard keys.

    Returns:
      {
        "root": "...",
        "file_count": N,
        "tree": [ {name, path, file_count, children: [...]}, ... ]
      }
    """
    ensure_loaded()

    # node: {name, path, file_count, children: dict[str, node]}
    root_children: dict[str, dict] = {}

    with _lock:
        keys = list(_file_dict)
        folder_display_paths = {
            key: value
            for key, value in _folder_display_paths.items()
            if key != ROOT_WILDCARD_KEY
        }
        loaded = str(_loaded_root or get_wildcards_path())

    def _ensure_folder(folder_path: str) -> None:
        folder_parts = folder_path.split("/")
        cursor = root_children
        path_acc: list[str] = []
        for part in folder_parts:
            path_acc.append(part)
            path = "/".join(path_acc)
            if part not in cursor:
                display_path = folder_display_paths.get(path, path)
                cursor[part] = {
                    "name": display_path.split("/")[-1],
                    "path": path,
                    "file_count": 0,
                    "children": {},
                }
            node = cursor[part]
            cursor = node["children"]

    # Build nodes from the folder index first so empty folders are visible.
    for folder_path in sorted(folder_display_paths):
        _ensure_folder(folder_path)

    # Count each file in all of its ancestor folders.
    for key in keys:
        parts = key.split("/")
        if len(parts) < 2:
            continue
        cursor = root_children
        for part in parts[:-1]:
            node = cursor.get(part)
            if not node:
                break
            node["file_count"] += 1
            cursor = node["children"]

    def _to_list(children: dict) -> list[dict]:
        out = []
        for key in sorted(
            children.keys(), key=lambda value: children[value]["name"].casefold()
        ):
            node = children[key]
            out.append(
                {
                    "name": node["name"],
                    "path": node["path"],
                    "file_count": node["file_count"],
                    "children": _to_list(node["children"]),
                }
            )
        return out

    return {
        "root": loaded,
        "file_count": len(keys),
        "tree": _to_list(root_children),
    }


def list_sources_and_tree() -> dict:
    """Top-level sources (first path segment) for the browser sidebar."""
    ensure_loaded()
    with _lock:
        sources: dict[str, dict] = {}
        for key in _file_dict:
            top = key.split("/")[0] if "/" in key else key
            display_path = _folder_display_paths.get(top, _display_paths.get(key, key))
            display_name = display_path.split("/")[0]
            source = sources.setdefault(top, {"name": display_name, "count": 0})
            source["count"] += 1
        loaded_root = str(_loaded_root or get_wildcards_path())
        file_count = len(_file_dict)
        folder_count = len(_folder_dict)
        conflicts = list(_conflict_keys)
    return {
        "root": loaded_root,
        "sources": [
            {"name": source["name"], "count": source["count"]}
            for source in sorted(
                sources.values(), key=lambda value: value["name"].casefold()
            )
        ],
        "file_count": file_count,
        "folder_count": folder_count,
        "conflicts": conflicts,
    }
