"""Folder-backed prompt scheduler runtime state and deterministic selection."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    from ..domain.wildcard_syntax import reference_keys
    from ..support.i18n import tr
    from . import prompt_library
    from .wildcard_expansion import (
        LibraryWildcardResolver,
        normalize_key,
    )
except ImportError:  # standalone preview
    from domain.wildcard_syntax import reference_keys  # type: ignore
    from support.i18n import tr  # type: ignore
    from services import prompt_library  # type: ignore
    from services.wildcard_expansion import (  # type: ignore
        LibraryWildcardResolver,
        normalize_key,
    )

TRACK_MODES = {"sequence", "random", "shuffle"}
RUN_TTL_SECONDS = 24 * 60 * 60
MAX_CACHED_RUNS = 128

_run_lock = threading.RLock()
_runs: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
_number_parts = re.compile(r"(\d+)")


def _natural_key(value: str) -> tuple:
    parts = _number_parts.split(value.replace("\\", "/").casefold())
    return tuple(int(part) if part.isdigit() else part for part in parts)


def normalize_config(value: Any) -> dict[str, Any]:
    """Validate the serialized widget configuration and return a clean copy."""
    if isinstance(value, str):
        try:
            value = json.loads(value or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(tr("循环节点配置无法解析：{error}", error=exc)) from exc
    if not isinstance(value, dict):
        raise ValueError(tr("循环节点配置必须是对象"))

    tracks_raw = value.get("tracks", [])
    if not isinstance(tracks_raw, list):
        raise ValueError(tr("栏目配置必须是数组"))

    tracks: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(tracks_raw):
        if not isinstance(raw, dict):
            raise ValueError(tr("第 {index} 个栏目配置无效", index=index + 1))
        track_id = str(raw.get("id") or f"track-{index + 1}").strip()
        if track_id in seen_ids:
            raise ValueError(tr("栏目 ID 不能重复"))
        seen_ids.add(track_id)
        name = str(raw.get("name") or f"栏目 {index + 1}").strip()
        mode = str(raw.get("mode") or "sequence").strip().lower()
        if mode not in TRACK_MODES:
            raise ValueError(tr("栏目“{name}”的循环模式无效", name=name))
        text = raw.get("text")
        if not isinstance(text, str):
            raise ValueError(tr("栏目“{name}”的提示词配置无效", name=name))
        tracks.append(
            {
                "id": track_id,
                "name": name,
                "enabled": bool(raw.get("enabled", True)),
                "text": text,
                "mode": mode,
            }
        )

    negative = value.get("negative", "")
    if not isinstance(negative, str):
        raise ValueError(tr("固定负面提示词必须是字符串"))
    try:
        start_index = max(0, int(value.get("start_index", 0)))
        task_count = max(1, int(value.get("task_count", 1)))
    except (TypeError, ValueError) as exc:
        raise ValueError(tr("起始位置和任务数量必须是整数")) from exc

    return {
        "start_index": start_index,
        "task_count": task_count,
        "negative": negative,
        "tracks": tracks,
    }


def wildcard_keys(text: str) -> list[str]:
    """Return distinct normalized wildcard keys in textual order."""
    if not isinstance(text, str) or not text:
        return []
    return list(
        dict.fromkeys(
            normalize_key(key)
            for key in reference_keys(text)
            if key.strip()
        )
    )


def track_folder_keys(track: dict[str, Any]) -> list[str]:
    """Keep wildcard tokens that expose a sequenceable candidate pool."""
    resolver = prompt_library.snapshot_resolver()
    return [
        key
        for key in wildcard_keys(track.get("text", ""))
        if (
            (key in resolver.folder_entry_keys and key not in resolver.file_dict)
            or len(resolver.file_dict.get(key, ())) > 1
        )
    ]


def config_folder_keys(config: Any) -> list[str]:
    clean = normalize_config(config)
    return list(
        dict.fromkeys(
            key
            for track in clean["tracks"]
            if track["enabled"]
            for key in track_folder_keys(track)
        )
    )


def snapshot_folders(
    folder_keys: Iterable[str], *, root: Optional[Path] = None
) -> dict[str, list[dict[str, str]]]:
    """Compatibility view of selected folders from a structured snapshot."""
    folders = list(
        dict.fromkeys(
            normalize_key(key)
            for key in folder_keys
            if isinstance(key, str) and key.strip()
        )
    )
    if not folders:
        return {}

    prompt_library.ensure_loaded()
    loaded_root = prompt_library.get_loaded_root().resolve()
    if root is not None and Path(root).resolve() != loaded_root:
        raise ValueError("Scheduler snapshot root must be loaded before use")
    resolver = prompt_library.snapshot_resolver()
    return {
        folder: [
            {
                "key": candidate.key,
                "name": resolver.display_paths.get(candidate.key, candidate.key).split("/")[-1],
                "display_path": resolver.display_paths.get(candidate.key, candidate.key),
                "content": candidate.content,
                "negative": candidate.negative,
            }
            for candidate in resolver.resolve(folder)
        ]
        for folder in folders
    }


def folder_counts(folder_keys: Iterable[str]) -> dict[str, int]:
    snapshots = snapshot_folders(folder_keys)
    return {key: len(entries) for key, entries in snapshots.items()}


def cycle_summary(config: Any) -> dict[str, Any]:
    """Count folder tokens and compute the longest sequential column."""
    clean = normalize_config(config)
    folders = config_folder_keys(clean)
    counts = folder_counts(folders)
    sequence_counts = [
        counts.get(key, 0)
        for track in clean["tracks"]
        if track["enabled"] and track["mode"] == "sequence"
        for key in track_folder_keys(track)
    ]
    return {
        "counts": counts,
        "maximum": max(sequence_counts, default=0),
    }


def _prune_runs(now: Optional[float] = None) -> None:
    now = time.time() if now is None else now
    for run_id in list(_runs):
        if now - float(_runs[run_id].get("last_access", now)) > RUN_TTL_SECONDS:
            _runs.pop(run_id, None)
    while len(_runs) > MAX_CACHED_RUNS:
        _runs.popitem(last=False)


def prepare_run(config: Any, task_count: int) -> dict[str, Any]:
    clean = normalize_config(config)
    try:
        count = int(task_count)
    except (TypeError, ValueError) as exc:
        raise ValueError(tr("任务数量必须是整数")) from exc
    if count < 1:
        raise ValueError(tr("任务数量至少为 1"))

    resolver = prompt_library.snapshot_resolver()
    folders = [
        key
        for track in clean["tracks"]
        if track["enabled"]
        for key in wildcard_keys(track["text"])
        if (
            (key in resolver.folder_entry_keys and key not in resolver.file_dict)
            or len(resolver.file_dict.get(key, ())) > 1
        )
    ]
    folders = list(dict.fromkeys(folders))
    for track in clean["tracks"]:
        if not track["enabled"]:
            continue
        for folder in wildcard_keys(track["text"]):
            if (
                folder in resolver.folder_entry_keys
                and folder not in resolver.file_dict
                and not resolver.folder_entry_keys[folder]
            ):
                raise ValueError(
                    tr(
                        "栏目“{name}”中的文件夹通配符没有可用提示词：__{folder}__",
                        name=track["name"],
                        folder=folder,
                    )
                )

    run_id = uuid.uuid4().hex
    now = time.time()
    with _run_lock:
        _prune_runs(now)
        _runs[run_id] = {
            "resolver": resolver,
            "selection_seed": None,
            "remaining": count,
            "last_access": now,
        }
    return {
        "run_id": run_id,
        "counts": {
            key: resolver.option_count(key)
            for key in folders
        },
    }


def acquire_run(
    run_id: str, seed: int
) -> tuple[LibraryWildcardResolver, int]:
    with _run_lock:
        _prune_runs()
        run = _runs.get(run_id)
        if not run:
            raise RuntimeError(tr("本轮提示词快照已失效，请重新点击批量运行"))
        run["last_access"] = time.time()
        if run["selection_seed"] is None:
            run["selection_seed"] = int(seed)
        _runs.move_to_end(run_id)
        return run["resolver"], int(run["selection_seed"])


def complete_run_task(run_id: str) -> None:
    if not run_id:
        return
    with _run_lock:
        run = _runs.get(run_id)
        if not run:
            return
        run["remaining"] = int(run.get("remaining", 1)) - 1
        run["last_access"] = time.time()
        if run["remaining"] <= 0:
            _runs.pop(run_id, None)

