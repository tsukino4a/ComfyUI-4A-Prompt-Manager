"""Resolve image metadata model names/hashes to ComfyUI combo values."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

try:
    from ...support.i18n import tr
except ImportError:  # standalone preview
    from support.i18n import tr  # type: ignore


WIDGET_CATEGORIES = {
    "ckpt_name": ("checkpoints",),
    "unet_name": ("diffusion_models", "unet"),
}

_MODEL_INDEX_CACHE: dict[str, dict[str, Any]] = {}
_MODEL_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin"}


def _normalized_name(value: str) -> str:
    return str(value or "").strip().replace("\\", "/").casefold()


def _name_parts(value: str) -> tuple[str, str, str]:
    normalized = _normalized_name(value)
    basename = normalized.rsplit("/", 1)[-1]
    suffix = Path(basename).suffix.casefold()
    stem = basename[: -len(suffix)] if suffix in _MODEL_EXTENSIONS else basename
    return normalized, basename, stem


def _hash_text(value: str) -> str:
    return re.sub(r"[^0-9a-f]", "", str(value or "").casefold())


def _full_path(folder_paths: Any, category: str, filename: str) -> Path | None:
    try:
        if hasattr(folder_paths, "get_full_path"):
            value = folder_paths.get_full_path(category, filename)
        else:
            value = folder_paths.get_full_path_or_raise(category, filename)
    except Exception:
        return None
    return Path(value) if value else None


def _category_files(folder_paths: Any, categories: tuple[str, ...]) -> list[tuple[str, str, Path]]:
    files: list[tuple[str, str, Path]] = []
    seen: set[str] = set()
    available = getattr(folder_paths, "folder_names_and_paths", None)
    for category in categories:
        if isinstance(available, dict) and category not in available:
            continue
        try:
            filenames = folder_paths.get_filename_list(category)
        except Exception:
            continue
        for filename in filenames:
            normalized = _normalized_name(filename)
            if not normalized or normalized in seen:
                continue
            full_path = _full_path(folder_paths, category, filename)
            if full_path is None:
                continue
            seen.add(normalized)
            files.append((category, str(filename), full_path))
    return files


def _index_for(widget_name: str, folder_paths: Any) -> dict[str, Any]:
    categories = WIDGET_CATEGORIES[widget_name]
    files = _category_files(folder_paths, categories)
    signature = tuple((category, filename, str(path)) for category, filename, path in files)
    cached = _MODEL_INDEX_CACHE.get(widget_name)
    if cached and cached["signature"] == signature:
        return cached

    exact: dict[str, list[str]] = {}
    for _category, filename, _path in files:
        for alias in _name_parts(filename):
            if alias:
                exact.setdefault(alias, []).append(filename)

    index = {
        "signature": signature,
        "files": files,
        "exact": exact,
        "hashes": None,
        "versions": None,
    }
    _MODEL_INDEX_CACHE[widget_name] = index
    return index


def _hash_index(index: dict[str, Any]) -> dict[str, list[str]]:
    if index["hashes"] is not None:
        return index["hashes"]
    hashes: dict[str, list[str]] = {}
    for _category, filename, path in index["files"]:
        sidecar = path.with_suffix(".sha256")
        try:
            value = _hash_text(sidecar.read_text(encoding="utf-8").split()[0])
        except (OSError, IndexError):
            continue
        if value:
            hashes.setdefault(value, []).append(filename)
    index["hashes"] = hashes
    return hashes


def _sidecar_version_id(path: Path) -> str:
    for sidecar in (path.with_suffix(".civitai.info"), path.with_suffix(".metadata.json")):
        try:
            payload = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        candidates = [
            payload.get("modelVersionId"),
            payload.get("id") if sidecar.name.endswith(".civitai.info") else None,
            payload.get("civitai", {}).get("id")
            if isinstance(payload.get("civitai"), dict)
            else None,
        ]
        for candidate in candidates:
            if candidate is not None and str(candidate).strip():
                return str(candidate).strip()
    return ""


def _version_index(index: dict[str, Any]) -> dict[str, list[str]]:
    if index["versions"] is not None:
        return index["versions"]
    versions: dict[str, list[str]] = {}
    for _category, filename, path in index["files"]:
        version_id = _sidecar_version_id(path)
        if version_id:
            versions.setdefault(version_id, []).append(filename)
    index["versions"] = versions
    return versions


def _first_exact(index: dict[str, Any], name: str) -> str | None:
    for alias in _name_parts(name):
        matches = index["exact"].get(alias, [])
        if matches:
            return matches[0]
    return None


def resolve_model(
    widget_name: str,
    name: str = "",
    hash_value: str = "",
    model_version_id: str | int = "",
    *,
    folder_paths_module: Any | None = None,
) -> dict[str, str]:
    """Return a valid combo value, preferring exact name before hash prefix."""
    if widget_name not in WIDGET_CATEGORIES:
        raise ValueError("widget_name must be ckpt_name or unet_name")
    if folder_paths_module is None:
        import folder_paths as folder_paths_module  # type: ignore

    index = _index_for(widget_name, folder_paths_module)
    exact = _first_exact(index, name)
    if exact:
        return {"value": exact, "match": "name", "widget_name": widget_name}

    wanted_hash = _hash_text(hash_value)
    if len(wanted_hash) >= 8:
        matches: list[tuple[str, str]] = []
        for full_hash, filenames in _hash_index(index).items():
            if full_hash.startswith(wanted_hash) or wanted_hash.startswith(full_hash):
                matches.extend((filename, full_hash) for filename in filenames)
        if matches:
            filename, matched_hash = matches[0]
            return {
                "value": filename,
                "match": "hash",
                "matched_hash": matched_hash,
                "widget_name": widget_name,
            }

    wanted_version = str(model_version_id or "").strip()
    if wanted_version:
        version_matches = _version_index(index).get(wanted_version, [])
        if version_matches:
            return {
                "value": version_matches[0],
                "match": "version",
                "matched_model_version_id": wanted_version,
                "widget_name": widget_name,
            }

    if len(wanted_hash) >= 8 or wanted_version:
        raise LookupError(tr("没有找到同名、Hash 或 Civitai 版本一致的本地模型"))
    raise LookupError(
        tr("没有找到同名模型，图片也没有可用的模型 Hash 或 Civitai 版本 ID")
    )

