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
    from ..domain.wildcard_syntax import (
        reference_keys,
        sequential_leaf_count,
        sequential_reference_keys,
    )
    from ..storage.prompt_documents import (
        merge_double_sample_parameters,
        merge_lora_texts,
        merge_models,
        merge_parameters,
    )
    from ..support.i18n import tr
    from . import prompt_library
    from .wildcard_expansion import (
        LibraryWildcardResolver,
        expand_prompt,
        normalize_key,
    )
except ImportError:  # standalone preview
    from domain.wildcard_syntax import (  # type: ignore
        reference_keys,
        sequential_leaf_count,
        sequential_reference_keys,
    )
    from storage.prompt_documents import (  # type: ignore
        merge_double_sample_parameters,
        merge_lora_texts,
        merge_models,
        merge_parameters,
    )
    from support.i18n import tr  # type: ignore
    from services import prompt_library  # type: ignore
    from services.wildcard_expansion import (  # type: ignore
        LibraryWildcardResolver,
        expand_prompt,
        normalize_key,
    )

TRACK_MODES = {"sequence", "random", "shuffle"}
RUN_TTL_SECONDS = 24 * 60 * 60
MAX_CACHED_RUNS = 128
# Cap dry-run probes when measuring nested sequential cycles.
MAX_SEQUENCE_CYCLE_PROBE = 5000

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
        "lora_append": bool(value.get("lora_append", False)),
        "lora_group_same": bool(value.get("lora_group_same", False)),
        "settings_apply_models": bool(value.get("settings_apply_models", False)),
        # Double-sample apply is folded into parameters (legacy key still accepted).
        "settings_apply_parameters": bool(
            value.get("settings_apply_parameters", False)
            or value.get("settings_apply_double_sample", False)
        ),
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


def sequential_wildcard_keys(text: str) -> list[str]:
    """Top-level ``__key__`` tokens only (excludes ``{}`` / ``N#``)."""
    if not isinstance(text, str) or not text:
        return []
    return list(
        dict.fromkeys(
            normalize_key(key)
            for key in sequential_reference_keys(text)
            if key.strip()
        )
    )


def _is_sequenceable_key(
    key: str, resolver: LibraryWildcardResolver
) -> bool:
    """True when a wildcard key exposes more than one sequential candidate."""
    if key in resolver.folder_entry_keys and key not in resolver.file_dict:
        return True
    return len(resolver.file_dict.get(key, ())) > 1


def track_folder_keys(
    track: dict[str, Any],
    resolver: Optional[LibraryWildcardResolver] = None,
) -> list[str]:
    """Keep wildcard tokens that expose a sequenceable candidate pool."""
    active = resolver or prompt_library.snapshot_resolver()
    return [
        key
        for key in wildcard_keys(track.get("text", ""))
        if _is_sequenceable_key(key, active)
    ]


def config_folder_keys(
    config: Any,
    resolver: Optional[LibraryWildcardResolver] = None,
) -> list[str]:
    clean = normalize_config(config)
    active = resolver or prompt_library.snapshot_resolver()
    return list(
        dict.fromkeys(
            key
            for track in clean["tracks"]
            if track["enabled"]
            for key in track_folder_keys(track, resolver=active)
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


def folder_counts(
    folder_keys: Iterable[str],
    resolver: Optional[LibraryWildcardResolver] = None,
) -> dict[str, int]:
    """Return option counts for folder/file wildcard keys."""
    folders = list(
        dict.fromkeys(
            normalize_key(key)
            for key in folder_keys
            if isinstance(key, str) and key.strip()
        )
    )
    if not folders:
        return {}
    active = resolver or prompt_library.snapshot_resolver()
    return {key: int(active.option_count(key)) for key in folders}


def _selection_fingerprint(result: Any) -> tuple[Any, ...]:
    """Fingerprint one expansion for sequential cycle detection.

    selected_keys alone is not enough: multi-line TXT options share one file
    key, so include resolved text / negatives / LoRA texts as well.
    """
    return (
        tuple(result.selected_keys),
        result.text,
        tuple(result.negatives),
        tuple(result.lora_texts),
    )


def sequence_cycle_length(
    text: str,
    *,
    resolver: LibraryWildcardResolver,
    seed: int = 0,
    track_id: str = "",
    max_probe: int = MAX_SEQUENCE_CYCLE_PROBE,
) -> int:
    """Return the shared-index sequential period for one track text.

    Dry-runs expansion with increasing execution_index until the index-0
    selection fingerprint repeats. Kept for diagnostics; task counting uses
    :func:`hierarchical_cycle_length` instead.
    """
    if not isinstance(text, str) or not text.strip():
        return 0
    if not wildcard_keys(text):
        return 0

    limit = max(1, int(max_probe))
    fingerprint0: tuple[Any, ...] | None = None
    for index in range(0, limit + 1):
        try:
            result = expand_prompt(
                text,
                resolver=resolver,
                seed=int(seed),
                mode="sequence",
                execution_index=index,
                track_id=track_id,
            )
        except Exception:
            return 0
        fingerprint = _selection_fingerprint(result)
        if index == 0:
            if not result.selected_keys:
                return 0
            fingerprint0 = fingerprint
            continue
        if fingerprint == fingerprint0:
            return index
    return limit


def hierarchical_cycle_length(
    text: str,
    *,
    resolver: LibraryWildcardResolver,
    stack: tuple[str, ...] = (),
) -> int:
    """Count one track's sequential ``__key__`` leaf space.

    Matches expansion: nested branches under one key sum; multiple top-level
    ``__key__`` tokens in the same text multiply (left outer, right inner).
    Inline ``{}`` / ``N#`` constructs do not lengthen the cycle.
    """
    try:
        return int(
            sequential_leaf_count(
                text,
                resolver,
                stack=stack,
            )
        )
    except Exception:
        return 0


def cycle_summary(config: Any) -> dict[str, Any]:
    """Count each sequential track's leaf space, then take the longest track."""
    clean = normalize_config(config)
    resolver = prompt_library.snapshot_resolver()
    folders = list(
        dict.fromkeys(
            key
            for track in clean["tracks"]
            if track["enabled"] and track["mode"] == "sequence"
            for key in sequential_wildcard_keys(track["text"])
            if _is_sequenceable_key(key, resolver)
        )
    )
    counts = folder_counts(folders, resolver=resolver)

    sequence_lengths: list[int] = []
    for track in clean["tracks"]:
        if not track["enabled"] or track["mode"] != "sequence":
            continue
        nested = hierarchical_cycle_length(
            track["text"],
            resolver=resolver,
        )
        if nested > 0:
            sequence_lengths.append(nested)
        # No fallback: keys inside ``{}`` / ``N#`` are random-only and must not
        # inflate the sequential task count.

    return {
        "counts": counts,
        "maximum": max(sequence_lengths, default=0),
    }


def _prune_runs(now: Optional[float] = None) -> None:
    now = time.time() if now is None else now
    for run_id in list(_runs):
        if now - float(_runs[run_id].get("last_access", now)) > RUN_TTL_SECONDS:
            _runs.pop(run_id, None)
    while len(_runs) > MAX_CACHED_RUNS:
        _runs.popitem(last=False)


def _collect_lora_append_text(
    clean: dict[str, Any],
    *,
    resolver: LibraryWildcardResolver,
    selection_seed: int,
    execution_index: int,
) -> str:
    """Dry-run the same track expansions as the node and merge selected LoRAs."""
    texts: list[str] = []
    for track in clean["tracks"]:
        if not track["enabled"]:
            continue
        expanded = expand_prompt(
            track["text"],
            resolver=resolver,
            seed=selection_seed,
            mode=track["mode"],
            execution_index=execution_index,
            track_id=track["id"],
        )
        texts.extend(expanded.lora_texts)
    return merge_lora_texts(*texts)


def _collect_settings_plan(
    clean: dict[str, Any],
    *,
    resolver: LibraryWildcardResolver,
    selection_seed: int,
    execution_index: int,
) -> dict[str, Any]:
    """Dry-run expansions and merge sparse card generation settings."""
    models_groups: list[Any] = []
    parameters_list: list[dict[str, Any]] = []
    double_sample_list: list[dict[str, Any]] = []
    for track in clean["tracks"]:
        if not track["enabled"]:
            continue
        expanded = expand_prompt(
            track["text"],
            resolver=resolver,
            seed=selection_seed,
            mode=track["mode"],
            execution_index=execution_index,
            track_id=track["id"],
        )
        if expanded.models:
            models_groups.append(list(expanded.models))
        if expanded.parameters:
            parameters_list.append(dict(expanded.parameters))
        if expanded.double_sample_parameters:
            double_sample_list.append(dict(expanded.double_sample_parameters))
    return {
        "models": merge_models(*models_groups),
        "parameters": merge_parameters(*parameters_list),
        "double_sample_parameters": merge_double_sample_parameters(
            *double_sample_list
        ),
    }


def plan_lora_appends(
    config: Any,
    *,
    seed: int,
    start_index: int,
    task_count: int,
    resolver: Optional[LibraryWildcardResolver] = None,
) -> list[dict[str, str]]:
    clean = normalize_config(config)
    active_resolver = resolver or prompt_library.snapshot_resolver()
    selection_seed = int(seed)
    start = max(0, int(start_index))
    count = max(1, int(task_count))
    return [
        {
            "execution_index": start + offset,
            "append_text": _collect_lora_append_text(
                clean,
                resolver=active_resolver,
                selection_seed=selection_seed,
                execution_index=start + offset,
            ),
        }
        for offset in range(count)
    ]


def plan_settings_appends(
    config: Any,
    *,
    seed: int,
    start_index: int,
    task_count: int,
    resolver: Optional[LibraryWildcardResolver] = None,
) -> list[dict[str, Any]]:
    clean = normalize_config(config)
    active_resolver = resolver or prompt_library.snapshot_resolver()
    selection_seed = int(seed)
    start = max(0, int(start_index))
    count = max(1, int(task_count))
    return [
        {
            "execution_index": start + offset,
            **_collect_settings_plan(
                clean,
                resolver=active_resolver,
                selection_seed=selection_seed,
                execution_index=start + offset,
            ),
        }
        for offset in range(count)
    ]


def prepare_run(
    config: Any,
    task_count: int,
    *,
    seed: int = 0,
) -> dict[str, Any]:
    clean = normalize_config(config)
    try:
        count = int(task_count)
    except (TypeError, ValueError) as exc:
        raise ValueError(tr("任务数量必须是整数")) from exc
    if count < 1:
        raise ValueError(tr("任务数量至少为 1"))
    try:
        selection_seed = int(seed)
    except (TypeError, ValueError) as exc:
        raise ValueError(tr("选择种子必须是整数")) from exc

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

    lora_plans: list[dict[str, str]] = []
    if clean.get("lora_append"):
        lora_plans = plan_lora_appends(
            clean,
            seed=selection_seed,
            start_index=clean["start_index"],
            task_count=count,
            resolver=resolver,
        )

    settings_plans: list[dict[str, Any]] = []
    if clean.get("settings_apply_models") or clean.get("settings_apply_parameters"):
        settings_plans = plan_settings_appends(
            clean,
            seed=selection_seed,
            start_index=clean["start_index"],
            task_count=count,
            resolver=resolver,
        )

    run_id = uuid.uuid4().hex
    now = time.time()
    with _run_lock:
        _prune_runs(now)
        _runs[run_id] = {
            "resolver": resolver,
            "selection_seed": selection_seed,
            "remaining": count,
            "last_access": now,
        }
    return {
        "run_id": run_id,
        "selection_seed": selection_seed,
        "counts": {
            key: resolver.option_count(key)
            for key in folders
        },
        "lora_plans": lora_plans,
        "settings_plans": settings_plans,
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

