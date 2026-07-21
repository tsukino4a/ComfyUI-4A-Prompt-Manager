"""Sparse, human-readable metadata and edit history for a wildcard library."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Iterable, Mapping, Optional

try:
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from support.i18n import tr  # type: ignore

INTERNAL_DIR_NAME = ".pm4a"
METADATA_FILE_NAME = "library.json"

_lock = threading.RLock()


class MetadataError(RuntimeError):
    """Raised when existing metadata cannot be read safely."""


def content_digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def metadata_dir(root: Path) -> Path:
    return Path(root) / INTERNAL_DIR_NAME


def metadata_path(root: Path) -> Path:
    return metadata_dir(root) / METADATA_FILE_NAME


def history_dir(root: Path) -> Path:
    return metadata_dir(root) / "history"


def _empty_store() -> dict:
    return {"entries": {}}


def _read_store_unlocked(root: Path) -> dict:
    path = metadata_path(root)
    if not path.is_file():
        return _empty_store()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MetadataError(
            tr("元数据文件无法读取：{path} ({error})", path=path, error=exc)
        ) from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), dict):
        raise MetadataError(tr("元数据文件格式无效：{path}", path=path))
    entries = {}
    for key, value in raw["entries"].items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        if value.get("favorite") is not True:
            continue
        record = {"favorite": True}
        if isinstance(value.get("display_path"), str):
            record["display_path"] = value["display_path"]
        if isinstance(value.get("content_sha256"), str):
            record["content_sha256"] = value["content_sha256"]
        entries[key] = record
    return {"entries": entries}


def _write_store_unlocked(root: Path, store: dict) -> None:
    path = metadata_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(store, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _has_user_metadata(record: dict) -> bool:
    return record.get("favorite") is True


def _touch_record(record: dict, display_path: str, content: str) -> None:
    record["display_path"] = display_path
    record["content_sha256"] = content_digest(content)


def get_entries_metadata(root: Path, keys: Iterable[str]) -> dict[str, dict]:
    """Return sparse user metadata for several entries with one file read."""
    selected = set(keys)
    if not selected:
        return {}
    with _lock:
        store = _read_store_unlocked(root)
        return {
            key: dict(record)
            for key, record in store["entries"].items()
            if key in selected and _has_user_metadata(record)
        }


def apply_imported_metadata(
    root: Path,
    imported: Mapping[str, Mapping[str, object]],
    current: Mapping[str, tuple[str, str]],
) -> None:
    """Apply validated sparse metadata for a completed bulk import in one write."""
    if not imported:
        return
    with _lock:
        store = _read_store_unlocked(root)
        entries = store["entries"]
        changed = False
        for key, raw in imported.items():
            identity = current.get(key)
            if not identity:
                continue
            if raw.get("favorite") is not True:
                continue
            record = {"favorite": True}
            display_path, content = identity
            _touch_record(record, display_path, content)
            entries[key] = record
            changed = True
        if changed:
            _write_store_unlocked(root, store)


def list_favorites(root: Path) -> list[str]:
    with _lock:
        store = _read_store_unlocked(root)
        return sorted(
            key for key, record in store["entries"].items() if record.get("favorite") is True
        )


def set_favorite(
    root: Path,
    key: str,
    favorite: bool,
    *,
    display_path: str,
    content: str,
) -> dict:
    with _lock:
        store = _read_store_unlocked(root)
        entries = store["entries"]
        record = dict(entries.get(key, {}))
        if favorite:
            record["favorite"] = True
            _touch_record(record, display_path, content)
            entries[key] = record
        else:
            record.pop("favorite", None)
            if _has_user_metadata(record):
                _touch_record(record, display_path, content)
                entries[key] = record
            else:
                entries.pop(key, None)
                record = {}
        _write_store_unlocked(root, store)
        return dict(record)


def migrate_entry(
    root: Path,
    old_key: str,
    new_key: str,
    *,
    display_path: str,
    content: str,
) -> None:
    """Move sparse metadata after an in-app rename."""
    with _lock:
        store = _read_store_unlocked(root)
        entries = store["entries"]
        if old_key == new_key:
            record = entries.get(old_key)
            if not record:
                return
            _touch_record(record, display_path, content)
            entries[old_key] = record
            _write_store_unlocked(root, store)
            return
        old = entries.pop(old_key, None)
        if not old:
            return
        target = dict(entries.get(new_key, {}))
        if target:
            target["favorite"] = bool(target.get("favorite") or old.get("favorite"))
            record = target
        else:
            record = dict(old)
        if not _has_user_metadata(record):
            entries.pop(new_key, None)
        else:
            _touch_record(record, display_path, content)
            entries[new_key] = record
        _write_store_unlocked(root, store)


def apply_key_operations(
    root: Path,
    *,
    moves: Mapping[str, str] | None = None,
    copies: Mapping[str, str] | None = None,
    deletes: Iterable[str] = (),
    current: Mapping[str, tuple[str, str]] | None = None,
) -> None:
    """Apply a group of index key changes with a single metadata write."""
    moves = moves or {}
    copies = copies or {}
    current = current or {}
    with _lock:
        path = metadata_path(root)
        if not path.is_file() and not moves and not copies:
            return
        store = _read_store_unlocked(root)
        entries = store["entries"]
        changed = False

        for key in deletes:
            if entries.pop(key, None) is not None:
                changed = True

        for old_key, new_key in moves.items():
            if old_key == new_key:
                continue
            record = entries.pop(old_key, None)
            if record is None:
                continue
            target = dict(entries.get(new_key, {}))
            if target:
                target["favorite"] = bool(target.get("favorite") or record.get("favorite"))
                record = target
            if _has_user_metadata(record):
                entries[new_key] = record
            else:
                entries.pop(new_key, None)
            changed = True

        for old_key, new_key in copies.items():
            source = entries.get(old_key)
            if source is None or not _has_user_metadata(source):
                continue
            entries[new_key] = dict(source)
            changed = True

        for key, (display_path, content) in current.items():
            record = entries.get(key)
            if not record:
                continue
            before = dict(record)
            _touch_record(record, display_path, content)
            entries[key] = record
            changed = changed or record != before

        if changed:
            _write_store_unlocked(root, store)


def reconcile_entries(
    root: Path,
    current: Mapping[str, tuple[str, str]],
) -> None:
    """Refresh paths/hashes and follow uniquely identifiable external moves."""
    with _lock:
        path = metadata_path(root)
        if not path.is_file():
            return
        store = _read_store_unlocked(root)
        entries = store["entries"]
        changed = False

        missing = [key for key in entries if key not in current]
        hash_to_keys: dict[str, list[str]] = {}
        if missing:
            for key, (_display_path, content) in current.items():
                hash_to_keys.setdefault(content_digest(content), []).append(key)

        claimed: set[str] = set(entries).intersection(current)
        for old_key in missing:
            record = entries.get(old_key)
            digest = record.get("content_sha256") if record else None
            candidates = hash_to_keys.get(digest, []) if isinstance(digest, str) else []
            if len(candidates) != 1 or candidates[0] in claimed:
                continue
            new_key = candidates[0]
            entries[new_key] = entries.pop(old_key)
            claimed.add(new_key)
            changed = True

        for key, record in list(entries.items()):
            if key not in current:
                continue
            display_path, content = current[key]
            digest = content_digest(content)
            if record.get("display_path") != display_path or record.get("content_sha256") != digest:
                record["display_path"] = display_path
                record["content_sha256"] = digest
                entries[key] = record
                changed = True

        if changed:
            _write_store_unlocked(root, store)


def archive_files(root: Path, action: str, key: str, files: Iterable[Path]) -> Optional[Path]:
    """Copy replaced source files to a timestamped, scan-excluded history folder."""
    existing = [Path(path) for path in files if Path(path).is_file()]
    if not existing:
        return None
    root = Path(root).resolve()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    target_root = history_dir(root) / f"{stamp}-{uuid.uuid4().hex[:8]}"
    target_root.mkdir(parents=True, exist_ok=False)
    copied: list[str] = []
    try:
        for source in existing:
            source = source.resolve()
            try:
                relative = source.relative_to(root)
            except ValueError as exc:
                raise ValueError(
                    tr("不能备份提示词库之外的文件：{path}", path=source)
                ) from exc
            target = target_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied.append(str(relative).replace("\\", "/"))
        manifest = {
            "action": action,
            "key": key,
            "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "files": copied,
        }
        (target_root / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:
        shutil.rmtree(target_root, ignore_errors=True)
        raise
    return target_root
