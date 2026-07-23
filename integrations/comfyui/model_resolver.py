"""Resolve image metadata model/LoRA names/hashes to local ComfyUI values."""

from __future__ import annotations

import hashlib
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
    "lora_name": ("loras",),
}

_MODEL_INDEX_CACHE: dict[str, dict[str, Any]] = {}
_MODEL_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin"}
_LORA_TAG_RE = re.compile(r"<lora:([^>:]+)(?::([^>]*))?>", re.IGNORECASE)


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


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    value = digest.hexdigest()
    sidecar = path.with_suffix(".sha256")
    try:
        sidecar.write_text(value, encoding="utf-8")
    except OSError:
        pass
    return value


def _hash_from_sidecars(path: Path) -> str:
    """Prefer .sha256 text sidecar, then LM / Comfy metadata.json sha256."""
    sidecar = path.with_suffix(".sha256")
    try:
        value = _hash_text(sidecar.read_text(encoding="utf-8").split()[0])
        if value:
            return value
    except (OSError, IndexError):
        pass
    meta = path.with_suffix(".metadata.json")
    try:
        payload = json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return _hash_text(payload.get("sha256", ""))


def _hash_index(index: dict[str, Any]) -> dict[str, list[str]]:
    if index["hashes"] is not None:
        return index["hashes"]
    hashes: dict[str, list[str]] = {}
    for _category, filename, path in index["files"]:
        value = _hash_from_sidecars(path)
        if value:
            hashes.setdefault(value, []).append(filename)
    index["hashes"] = hashes
    return hashes


def _ensure_hash_for_lookup(index: dict[str, Any], wanted_hash: str) -> None:
    """Compute missing file hashes until the requested digest can be matched."""
    hashes = _hash_index(index)
    wanted = _hash_text(wanted_hash)
    if len(wanted) < 8:
        return
    for full_hash in hashes:
        if full_hash.startswith(wanted) or wanted.startswith(full_hash):
            return
    known_files = {filename for names in hashes.values() for filename in names}
    for _category, filename, path in index["files"]:
        if filename in known_files:
            continue
        try:
            value = _hash_text(_file_sha256(path))
        except OSError:
            continue
        if not value:
            continue
        hashes.setdefault(value, []).append(filename)
        known_files.add(filename)
        if value.startswith(wanted) or wanted.startswith(value):
            return


def _hash_for_filename(index: dict[str, Any], filename: str) -> str:
    """Return sha256 for a known index filename (sidecar/metadata, else compute)."""
    wanted = str(filename or "")
    if not wanted:
        return ""
    hashes = _hash_index(index)
    for full_hash, filenames in hashes.items():
        if wanted in filenames:
            return full_hash
    for _category, name, path in index["files"]:
        if name != wanted:
            continue
        value = _hash_from_sidecars(path)
        if not value:
            try:
                value = _hash_text(_file_sha256(path))
            except OSError:
                value = ""
        if value:
            hashes.setdefault(value, []).append(name)
        return value
    return ""


def lora_tag_name(filename: str) -> str:
    """Return the `<lora:name:...>` token used by this project / LoraManager."""
    basename = Path(str(filename or "").replace("\\", "/")).name
    suffix = Path(basename).suffix.casefold()
    if suffix in _MODEL_EXTENSIONS:
        return basename[: -len(suffix)]
    return basename


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
        raise ValueError("widget_name must be ckpt_name, unet_name, or lora_name")
    if folder_paths_module is None:
        import folder_paths as folder_paths_module  # type: ignore

    index = _index_for(widget_name, folder_paths_module)
    exact = _first_exact(index, name)
    if exact:
        result = {"value": exact, "match": "name", "widget_name": widget_name}
        matched_hash = _hash_for_filename(index, exact)
        if matched_hash:
            result["matched_hash"] = matched_hash
        if widget_name == "lora_name":
            result["tag_name"] = lora_tag_name(exact)
        return result

    wanted_hash = _hash_text(hash_value)
    if len(wanted_hash) >= 8:
        # Sidecar / metadata.json first; compute file digests only if still missing.
        _ensure_hash_for_lookup(index, wanted_hash)
        matches: list[tuple[str, str]] = []
        for full_hash, filenames in _hash_index(index).items():
            if full_hash.startswith(wanted_hash) or wanted_hash.startswith(full_hash):
                matches.extend((filename, full_hash) for filename in filenames)
        if matches:
            filename, matched_hash = matches[0]
            result = {
                "value": filename,
                "match": "hash",
                "matched_hash": matched_hash,
                "widget_name": widget_name,
            }
            if widget_name == "lora_name":
                result["tag_name"] = lora_tag_name(filename)
            return result

    wanted_version = str(model_version_id or "").strip()
    if wanted_version and widget_name != "lora_name":
        version_matches = _version_index(index).get(wanted_version, [])
        if version_matches:
            filename = version_matches[0]
            result = {
                "value": filename,
                "match": "version",
                "matched_model_version_id": wanted_version,
                "widget_name": widget_name,
            }
            matched_hash = _hash_for_filename(index, filename)
            if matched_hash:
                result["matched_hash"] = matched_hash
            return result

    kind = tr("LoRA") if widget_name == "lora_name" else tr("模型")
    if len(wanted_hash) >= 8 or wanted_version:
        raise LookupError(tr("没有找到同名、Hash 或 Civitai 版本一致的本地{kind}", kind=kind))
    raise LookupError(
        tr("没有找到同名{kind}，也没有可用的 Hash 或 Civitai 版本 ID", kind=kind)
    )


def resolve_lora(
    name: str = "",
    hash_value: str = "",
    *,
    folder_paths_module: Any | None = None,
) -> dict[str, str]:
    """Resolve a LoRA by local name first, then SHA256 / AutoV2 prefix."""
    return resolve_model(
        "lora_name",
        name=name,
        hash_value=hash_value,
        folder_paths_module=folder_paths_module,
    )


def _hash_matches(wanted_hash: str, matched_hash: str) -> bool:
    wanted = _hash_text(wanted_hash)
    matched = _hash_text(matched_hash)
    if len(wanted) < 8 or not matched:
        return False
    if len(wanted) >= 64:
        return wanted == matched
    return matched.startswith(wanted) or wanted.startswith(matched)


def align_models_list(
    models: list[dict[str, Any]] | None,
    *,
    folder_paths_module: Any | None = None,
) -> list[dict[str, Any]]:
    """Rewrite model entries to local stem + full sha256 when uniquely resolvable.

    Rules match the browser helper:
    - hash present → only hash match may rewrite (no name fallback)
    - no hash → name / version match may rewrite
    """
    if not isinstance(models, list):
        return []
    aligned: list[dict[str, Any]] = []
    seen_types: set[str] = set()
    for entry in models:
        if not isinstance(entry, dict):
            continue
        model_type = str(entry.get("type", "")).strip()
        name = str(entry.get("name", "")).strip()
        digest = _hash_text(entry.get("hash", ""))
        version = str(entry.get("model_version_id", "") or "").strip()
        if not model_type or not name:
            continue
        type_key = model_type.casefold()
        if type_key in seen_types:
            continue
        seen_types.add(type_key)
        item: dict[str, Any] = {"type": model_type, "name": name}
        if digest:
            item["hash"] = digest
        if version:
            item["model_version_id"] = version

        resolved: dict[str, str] | None = None
        if len(digest) >= 8:
            for widget_name in ("unet_name", "ckpt_name"):
                try:
                    data = resolve_model(
                        widget_name,
                        name="",
                        hash_value=digest,
                        folder_paths_module=folder_paths_module,
                    )
                except LookupError:
                    continue
                if data.get("match") == "hash" and _hash_matches(
                    digest, data.get("matched_hash", "")
                ):
                    resolved = data
                    break
        else:
            for widget_name in ("unet_name", "ckpt_name"):
                try:
                    data = resolve_model(
                        widget_name,
                        name=name,
                        hash_value="",
                        model_version_id=version,
                        folder_paths_module=folder_paths_module,
                    )
                except LookupError:
                    continue
                resolved = data
                break

        if resolved:
            stem = lora_tag_name(resolved.get("value", ""))
            if stem:
                item["name"] = stem
            matched = _hash_text(resolved.get("matched_hash", ""))
            if matched:
                item["hash"] = matched
        aligned.append(item)
    return aligned


def remap_lora_payload(
    lora: dict[str, Any] | None,
    *,
    folder_paths_module: Any | None = None,
) -> dict[str, Any]:
    """Rewrite imported LoRA tags/names to local files (name first, then hash)."""
    if not isinstance(lora, dict):
        return {"text": "", "hashes": []}
    text = lora.get("text", "") if isinstance(lora.get("text", ""), str) else ""
    hashes_raw = lora.get("hashes", []) if isinstance(lora.get("hashes", []), list) else []

    hash_by_name: dict[str, dict[str, str]] = {}
    for entry in hashes_raw:
        if not isinstance(entry, dict):
            continue
        entry_name = str(entry.get("name", "")).strip()
        digest = str(entry.get("hash", "")).strip()
        if not entry_name or not digest:
            continue
        key = lora_tag_name(entry_name).casefold() or entry_name.casefold()
        hash_by_name[key] = {"name": entry_name, "hash": digest}

    tags: list[str] = []
    hashes: list[dict[str, str]] = []
    seen: set[str] = set()
    for match in _LORA_TAG_RE.finditer(text):
        old_name = match.group(1).strip()
        strength = (match.group(2) or "1").strip() or "1"
        if not old_name:
            continue
        meta = (
            hash_by_name.get(old_name.casefold())
            or hash_by_name.get(lora_tag_name(old_name).casefold())
        )
        digest = meta["hash"] if meta else ""
        try:
            resolved = resolve_lora(
                name=old_name,
                hash_value=digest,
                folder_paths_module=folder_paths_module,
            )
            local_name = resolved.get("tag_name") or lora_tag_name(resolved["value"])
            hash_name = Path(str(resolved["value"]).replace("\\", "/")).name
            local_hash = resolved.get("matched_hash") or digest
        except Exception:
            local_name = old_name
            hash_name = meta["name"] if meta else old_name
            local_hash = digest
        key = local_name.casefold()
        if key in seen:
            continue
        seen.add(key)
        tags.append(f"<lora:{local_name}:{strength}>")
        if local_hash:
            hashes.append({"name": hash_name, "hash": local_hash})
    return {"text": " ".join(tags), "hashes": hashes}

