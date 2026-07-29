"""Filesystem fingerprint + snapshot cache for the in-memory prompt library.

The on-disk JSON/TXT cards remain the source of truth. This cache only speeds up
reload when every tracked path/mtime_ns/size (and directory set) still matches.
Compatible with Linux, Windows, and macOS (pathlib + os.walk + os.replace).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Optional

try:
    from .library_metadata import INTERNAL_DIR_NAME, metadata_dir
except ImportError:  # standalone preview
    from storage.library_metadata import INTERNAL_DIR_NAME, metadata_dir  # type: ignore

logger = logging.getLogger("ComfyUI4APromptManager")

CACHE_VERSION = 1
CACHE_FILE_NAME = "index-cache-v1.json"


def cache_path(root: Path) -> Path:
    return metadata_dir(root) / CACHE_FILE_NAME


def invalidate(root: Path) -> None:
    """Drop the snapshot so the next reload rescans card contents."""
    path = cache_path(root)
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Could not invalidate index cache %s: %s", path, exc)


def _posix_relative(path: Path, root: Path) -> Optional[str]:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return None
    text = relative.as_posix()
    return "" if text == "." else text


def _is_internal(relative_parts: tuple[str, ...]) -> bool:
    return bool(relative_parts) and relative_parts[0].casefold() == INTERNAL_DIR_NAME.casefold()


def collect_disk_fingerprint(root: Path) -> dict[str, Any]:
    """Walk the library once, collecting stats only (no file body reads)."""
    root = Path(root)
    files: dict[str, dict[str, int]] = {}
    directories: list[str] = []
    if not root.is_dir():
        return {"files": files, "directories": directories}

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        rel_dir = _posix_relative(current, root)
        if rel_dir is None:
            dirnames[:] = []
            continue
        rel_parts = tuple(rel_dir.split("/")) if rel_dir else ()
        if _is_internal(rel_parts):
            dirnames[:] = []
            continue
        # Prune nested .pm4a directories early.
        dirnames[:] = [
            name for name in dirnames if name.casefold() != INTERNAL_DIR_NAME.casefold()
        ]
        if rel_dir:
            directories.append(rel_dir)
        for name in filenames:
            suffix = Path(name).suffix.casefold()
            if suffix not in {".json", ".txt"}:
                continue
            path = current / name
            if not path.is_file():
                continue
            rel = _posix_relative(path, root)
            if not rel:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            files[rel] = {
                "mtime_ns": int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
                "size": int(stat.st_size),
            }

    directories.sort()
    return {"files": files, "directories": directories}


def diff_file_fingerprints(
    old_fingerprint: dict[str, Any],
    new_fingerprint: dict[str, Any],
) -> tuple[set[str], set[str], set[str]]:
    """Return (added, removed, changed) relative prompt-file paths."""
    old_files = old_fingerprint.get("files") or {}
    new_files = new_fingerprint.get("files") or {}
    if not isinstance(old_files, dict):
        old_files = {}
    if not isinstance(new_files, dict):
        new_files = {}
    old_rels = {str(key) for key in old_files}
    new_rels = {str(key) for key in new_files}
    added = new_rels - old_rels
    removed = old_rels - new_rels
    changed: set[str] = set()
    for rel in old_rels & new_rels:
        previous = old_files.get(rel)
        current = new_files.get(rel)
        if not isinstance(previous, dict) or not isinstance(current, dict):
            changed.add(rel)
            continue
        if int(previous.get("mtime_ns", -1)) != int(current.get("mtime_ns", -2)):
            changed.add(rel)
            continue
        if int(previous.get("size", -1)) != int(current.get("size", -2)):
            changed.add(rel)
    return added, removed, changed


def _fingerprint_matches(cached: dict[str, Any], current: dict[str, Any]) -> bool:
    cached_files = cached.get("files")
    cached_dirs = cached.get("directories")
    if not isinstance(cached_files, dict) or not isinstance(cached_dirs, list):
        return False
    current_files = current.get("files") or {}
    current_dirs = current.get("directories") or []
    if len(cached_files) != len(current_files) or len(cached_dirs) != len(current_dirs):
        return False
    if cached_dirs != current_dirs:
        return False
    for rel, stats in cached_files.items():
        live = current_files.get(rel)
        if not isinstance(stats, dict) or not isinstance(live, dict):
            return False
        if int(stats.get("mtime_ns", -1)) != int(live.get("mtime_ns", -2)):
            return False
        if int(stats.get("size", -1)) != int(live.get("size", -2)):
            return False
    return True


def build_snapshot(
    root: Path,
    *,
    fingerprint: dict[str, Any],
    entries: dict[str, dict[str, Any]],
    empty_folders: dict[str, str],
    conflict_keys: list[str],
) -> dict[str, Any]:
    return {
        "version": CACHE_VERSION,
        "root": str(Path(root).resolve()),
        "fingerprint": {
            "files": fingerprint.get("files") or {},
            "directories": list(fingerprint.get("directories") or []),
        },
        "entries": entries,
        "empty_folders": empty_folders,
        "conflict_keys": list(conflict_keys),
    }


def write_snapshot(root: Path, snapshot: dict[str, Any]) -> None:
    path = cache_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def read_snapshot(root: Path) -> Optional[dict[str, Any]]:
    path = cache_path(root)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        logger.warning("Ignoring unreadable index cache %s: %s", path, exc)
        return None
    if not isinstance(raw, dict) or raw.get("version") != CACHE_VERSION:
        return None
    if raw.get("root") != str(Path(root).resolve()):
        return None
    if not isinstance(raw.get("entries"), dict):
        return None
    if not isinstance(raw.get("fingerprint"), dict):
        return None
    return raw


def try_load_valid_snapshot(
    root: Path,
    *,
    snapshot: Optional[dict[str, Any]] = None,
    current_fingerprint: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """Return a snapshot only when on-disk fingerprints still match.

    Callers that already read the snapshot / walked the tree can pass them in to
    avoid a second disk pass.
    """
    if snapshot is None:
        snapshot = read_snapshot(root)
    if snapshot is None:
        return None
    current = (
        current_fingerprint
        if current_fingerprint is not None
        else collect_disk_fingerprint(root)
    )
    if not _fingerprint_matches(snapshot.get("fingerprint") or {}, current):
        return None
    entries = snapshot.get("entries")
    if not isinstance(entries, dict):
        return None
    # Refuse obviously tampered/truncated snapshots that still carry a matching
    # fingerprint (e.g. empty entries while the library has prompt files).
    tracked_files = current.get("files") or {}
    if tracked_files and not entries:
        logger.warning("Ignoring index cache with empty entries while files exist")
        return None
    if len(entries) > len(tracked_files):
        logger.warning("Ignoring index cache with more entries than tracked files")
        return None
    # Refresh fingerprint to the just-collected one so callers can reuse it.
    snapshot = dict(snapshot)
    snapshot["fingerprint"] = current
    return snapshot
