"""Image Saver Simple-compatible output node with lossless 4A metadata.

File naming and raster/EXIF saving behavior is adapted from
alexopus/ComfyUI-Image-Saver (MIT), copyright (c) 2023 Girish Gopaul.
See THIRD_PARTY_NOTICES.md for the complete notice.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

try:
    import folder_paths
except ImportError:  # Lightweight standalone tests can still use pure helpers.
    folder_paths = None

from .double_sample_parameters import DOUBLE_SAMPLE_SCHEMA
from .input_parameters import INPUT_PARAMETERS_SCHEMA


_UNSAFE_FILENAME = re.compile(r'[<>:"|?*\x00-\x1f]')
_LORA_TAG = re.compile(r"<lora:([^>:]+)(?::([^>]+))?>", re.IGNORECASE)
_EMBEDDING_TAG = re.compile(r"embedding:([^,\s():]+)", re.IGNORECASE)
_MODEL_EXTENSIONS = {".ckpt", ".pt", ".pth", ".bin", ".safetensors", ".gguf"}
GENERATION_PARAMETERS_SCHEMA = "pm4a_generation_parameters"
_HASH_CACHE: dict[str, tuple[int, int, str]] = {}
logger = logging.getLogger("ComfyUI4APromptManager.ImageSaver")


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _parse_json_object(value: Any) -> dict[str, Any] | None:
    current = value
    for _ in range(3):
        if isinstance(current, dict):
            return current
        if not isinstance(current, str) or not current.strip():
            return None
        try:
            current = json.loads(current)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    return current if isinstance(current, dict) else None


def _embedded_json_objects(value: Any) -> list[dict[str, Any]]:
    """Extract adjacent or labelled JSON objects from one combined string."""

    if isinstance(value, dict):
        return [value]
    if not isinstance(value, str) or not value.strip():
        return []
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    position = 0
    while position < len(value):
        start = value.find("{", position)
        if start < 0:
            break
        try:
            parsed, length = decoder.raw_decode(value[start:])
        except json.JSONDecodeError:
            position = start + 1
            continue
        if isinstance(parsed, dict):
            objects.append(parsed)
        position = start + max(length, 1)
    return objects


def parse_parameters_json(value: Any, expected_schema: str) -> dict[str, Any] | None:
    """Find one schema inside a single or user-concatenated JSON string."""

    candidate: dict[str, Any] | None = None
    for payload in _embedded_json_objects(value):
        if str(payload.get("schema", "")) == expected_schema:
            parameters = payload.get("parameters")
            if isinstance(parameters, dict):
                candidate = parameters
                break
    if candidate is None:
        return None

    normalized: dict[str, Any] = {}
    for key in ("seed", "steps", "width", "height"):
        if key not in candidate:
            continue
        try:
            normalized[key] = int(candidate[key])
        except (TypeError, ValueError):
            pass
    for key in ("cfg", "denoise"):
        if key not in candidate:
            continue
        try:
            normalized[key] = float(candidate[key])
        except (TypeError, ValueError):
            pass
    for key in ("sampler", "scheduler"):
        text = str(candidate.get(key, "")).strip()
        if text:
            normalized[key] = text
    return normalized or None


def _default_parameters(width: int, height: int) -> dict[str, Any]:
    return {
        "seed": 0,
        "steps": 20,
        "cfg": 7.0,
        "sampler": "",
        "scheduler": "normal",
        "denoise": 1.0,
        "width": int(width),
        "height": int(height),
    }


def generation_payload(
    parameters: dict[str, Any],
    double_parameters: dict[str, Any] | None,
    resources: dict[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": GENERATION_PARAMETERS_SCHEMA,
        "parameters": dict(parameters),
        "resources": resources,
    }
    if double_parameters:
        payload["double_sample_parameters"] = dict(double_parameters)
    return payload


def _base_model_name(model_name: str) -> str:
    name = os.path.basename(str(model_name or ""))
    stem, extension = os.path.splitext(name)
    return stem if extension.lower() in _MODEL_EXTENSIONS else name


def _find_model_file(category: str, name: str) -> Path | None:
    if folder_paths is None or not str(name or "").strip():
        return None
    wanted = str(name).strip().replace("\\", "/")
    wanted_path = Path(wanted)
    try:
        candidates = list(folder_paths.get_filename_list(category))
    except Exception:
        return None

    def score(candidate: str) -> int:
        normalized = str(candidate).replace("\\", "/")
        path = Path(normalized)
        if normalized.casefold() == wanted.casefold():
            return 0
        if path.name.casefold() == wanted_path.name.casefold():
            return 1
        if path.stem.casefold() == wanted_path.stem.casefold():
            return 2
        if path.stem.casefold() == wanted_path.name.casefold():
            return 3
        return 99

    matches = sorted((score(candidate), candidate) for candidate in candidates)
    if not matches or matches[0][0] >= 99:
        return None
    try:
        full_path = folder_paths.get_full_path(category, matches[0][1])
    except Exception:
        return None
    return Path(full_path) if full_path else None


def _find_first_model_file(name: str, categories: tuple[str, ...]) -> Path | None:
    for category in categories:
        path = _find_model_file(category, name)
        if path and path.is_file():
            return path
    return None


def _sha256(path: Path) -> str:
    stat = path.stat()
    cache_key = str(path.resolve())
    cached = _HASH_CACHE.get(cache_key)
    signature = (stat.st_size, stat.st_mtime_ns)
    if cached and cached[:2] == signature:
        return cached[2]

    sidecar = path.with_suffix(".sha256")
    if sidecar.is_file():
        try:
            saved = sidecar.read_text(encoding="utf-8").strip().lower()
            if re.fullmatch(r"[0-9a-f]{64}", saved):
                _HASH_CACHE[cache_key] = (*signature, saved)
                return saved
        except OSError:
            pass

    logger.debug("calculating SHA256 for %s", path.stem)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    value = digest.hexdigest()
    _HASH_CACHE[cache_key] = (*signature, value)
    try:
        sidecar.write_text(value, encoding="utf-8")
    except OSError:
        pass
    return value


def _resource_entry(name: str, path: Path, **extra: Any) -> dict[str, Any]:
    sha256 = _sha256(path)
    return {
        "name": str(name),
        "file_name": path.name,
        "hash": sha256[:10],
        "sha256": sha256,
        **extra,
    }


def collect_resources(
    model_name: str,
    positive: str,
    negative: str,
    loaded_loras: str = "",
) -> dict[str, Any]:
    resources: dict[str, Any] = {"models": [], "loras": [], "embeddings": []}
    model_text = str(model_name or "").strip()
    if model_text:
        model_path = _find_first_model_file(
            model_text,
            ("checkpoints", "diffusion_models", "unet"),
        )
        if model_path:
            resources["models"].append(
                _resource_entry(_base_model_name(model_text), model_path, type="基础模型")
            )

    prompt_text = f"{positive}\n{negative}\n{loaded_loras}"
    seen_loras: set[str] = set()
    for match in _LORA_TAG.finditer(prompt_text):
        name = match.group(1).strip()
        key = name.casefold()
        if not name or key in seen_loras:
            continue
        seen_loras.add(key)
        try:
            weight = float((match.group(2) or "1").split(":", 1)[0])
        except (TypeError, ValueError):
            weight = 1.0
        lora_path = _find_first_model_file(name, ("loras",))
        if lora_path:
            resources["loras"].append(_resource_entry(name, lora_path, weight=weight))

    seen_embeddings: set[str] = set()
    for match in _EMBEDDING_TAG.finditer(prompt_text):
        name = match.group(1).strip()
        key = name.casefold()
        if not name or key in seen_embeddings:
            continue
        seen_embeddings.add(key)
        embedding_path = _find_first_model_file(name, ("embeddings",))
        if embedding_path:
            resources["embeddings"].append(
                _resource_entry(name, embedding_path, weight=1.0)
            )
    return resources


def _model_name_from_prompt(prompt: dict[str, Any] | None) -> str:
    for node in (prompt or {}).values():
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        for key in ("unet_name", "ckpt_name"):
            value = inputs.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def append_loaded_loras(positive: str, loaded_loras: str) -> str:
    """Append only LoRA tags not already present in the positive prompt."""

    result = str(positive or "").strip()
    existing = {match.group(0).casefold() for match in _LORA_TAG.finditer(result)}
    additions: list[str] = []
    for match in _LORA_TAG.finditer(str(loaded_loras or "")):
        tag = match.group(0)
        if tag.casefold() in existing:
            continue
        existing.add(tag.casefold())
        additions.append(tag)
    if not additions:
        return result
    return " ".join(part for part in (result, *additions) if part)


def resolve_prompt_texts(
    prompt_json: str,
    positive: str = "",
    negative: str = "",
) -> tuple[str, str]:
    """Prefer Prompt Scheduler JSON; otherwise use direct positive/negative inputs."""

    parsed = _parse_json_object(prompt_json)
    if parsed is not None:
        json_positive = str(parsed.get("positive", "") or "").strip()
        json_negative = str(parsed.get("negative", "") or "").strip()
        if (
            isinstance(parsed.get("tracks"), list)
            or json_positive
            or json_negative
        ):
            return json_positive, json_negative
    return str(positive or "").strip(), str(negative or "").strip()


def build_prompt_document(
    prompt_json: str,
    parameters: dict[str, Any],
    double_parameters: dict[str, Any] | None,
    positive: str,
    negative: str,
) -> dict[str, Any] | None:
    """Merge scheduler JSON and both sampler passes into one authoritative record."""

    parsed = _parse_json_object(prompt_json)
    if parsed and isinstance(parsed.get("tracks"), list):
        document = copy.deepcopy(parsed)
    elif positive.strip() or negative.strip():
        document = {
            "source_type": "4a",
            "source_label": "4A",
            "tracks": (
                [{"id": "positive", "name": "正面", "text": positive.strip()}]
                if positive.strip()
                else []
            ),
            "positive": positive.strip(),
            "negative": negative.strip(),
        }
    else:
        return None

    document.pop("version", None)
    document["source_type"] = "4a"
    document["source_label"] = "4A"
    document["positive"] = positive.strip()
    document["negative"] = negative.strip()
    document["parameters"] = dict(parameters)
    if double_parameters:
        document["double_sample_parameters"] = dict(double_parameters)
    else:
        document.pop("double_sample_parameters", None)
    return document


def combined_sampler_name(sampler: str, scheduler: str) -> str:
    sampler_name = str(sampler or "").strip()
    scheduler_name = str(scheduler or "").strip()
    if not sampler_name:
        return ""
    if not scheduler_name:
        return sampler_name
    suffix = f"_{scheduler_name}".lower()
    return sampler_name if sampler_name.lower().endswith(suffix) else f"{sampler_name}_{scheduler_name}"


def _format_number(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def build_a1111_parameters(
    parameters: dict[str, Any],
    positive: str,
    negative: str,
    resources: dict[str, Any],
    custom: str = "",
) -> str:
    sampler_raw = combined_sampler_name(
        str(parameters.get("sampler", "")),
        str(parameters.get("scheduler", "")),
    )
    settings = [
        f"Steps: {parameters.get('steps', 0)}",
        f"Sampler: {sampler_raw}",
        f"Scheduler: {parameters.get('scheduler', '')}",
        f"CFG scale: {_format_number(parameters.get('cfg', 0))}",
        f"Seed: {parameters.get('seed', 0)}",
        f"Size: {parameters.get('width', 0)}x{parameters.get('height', 0)}",
        f"Denoising strength: {_format_number(parameters.get('denoise', 1.0))}",
    ]
    custom_text = str(custom or "").strip().strip(",").strip()
    if custom_text:
        settings.append(custom_text)

    hashes: dict[str, str] = {}
    models = resources.get("models", [])
    if models:
        model = models[0]
        settings.extend(
            [
                f"Model hash: {model['hash']}",
                f"Model: {model['name']}",
            ]
        )
        hashes["model"] = model["hash"]
    for lora in resources.get("loras", []):
        hashes[f"LORA:{lora['name']}"] = lora["hash"]
    for embedding in resources.get("embeddings", []):
        hashes[f"embed:{embedding['name']}"] = embedding["hash"]
    if hashes:
        settings.append(f"Hashes: {_compact_json(hashes)}")
    settings.append("Version: ComfyUI")
    prompt = str(positive or "").strip()
    negative_line = f"\nNegative prompt: {str(negative or '').strip()}"
    return f"{prompt}{negative_line}\n{', '.join(settings)}".strip()


def resource_hash_string(resources: dict[str, Any]) -> str:
    parts: list[str] = []
    for model in resources.get("models", []):
        parts.append(f"{model['name']}:{model['hash']}")
    for resource_type, prefix in (("loras", "LORA"), ("embeddings", "embed")):
        for resource in resources.get(resource_type, []):
            weight = resource.get("weight")
            suffix = f":{_format_number(weight)}" if weight is not None else ""
            parts.append(f"{prefix}:{resource['name']}:{resource['hash']}{suffix}")
    return ",".join(parts)


def _timestamp(time_format: str) -> str:
    try:
        return datetime.now().strftime(time_format)
    except (TypeError, ValueError):
        return datetime.now().strftime("%Y-%m-%d-%H%M%S")


def _sanitize_filename(filename: str) -> str:
    return _UNSAFE_FILENAME.sub("", filename).rstrip(". ")


def _apply_variables(
    value: str,
    parameters: dict[str, Any],
    model_name: str,
    counter: int,
    time_format: str,
    custom: str,
) -> str:
    result = str(value or "")
    now = datetime.now()

    def custom_time(match: re.Match[str]) -> str:
        try:
            return now.strftime(match.group(1))
        except (TypeError, ValueError):
            return match.group(0)

    def custom_counter(match: re.Match[str]) -> str:
        try:
            return f"{counter:0{int(match.group(1))}d}"
        except (TypeError, ValueError):
            return match.group(0)

    result = re.sub(r"%time_format<([^>]*)>", custom_time, result)
    result = re.sub(r"%counter<([0-9]+)>", custom_counter, result)
    replacements = {
        "%date": now.strftime("%Y-%m-%d"),
        "%time": _timestamp(time_format),
        "%model": os.path.basename(str(model_name or "")),
        "%width": str(parameters.get("width", "")),
        "%height": str(parameters.get("height", "")),
        "%seed": str(parameters.get("seed", "")),
        "%counter": str(counter),
        "%sampler_name": str(parameters.get("sampler", "")),
        "%steps": str(parameters.get("steps", "")),
        "%cfg": _format_number(parameters.get("cfg", "")),
        "%scheduler_name": str(parameters.get("scheduler", "")),
        "%basemodelname": _base_model_name(model_name),
        "%denoise": _format_number(parameters.get("denoise", "")),
        "%clip_skip": "0",
        "%custom": str(custom or ""),
    }
    for marker, replacement in replacements.items():
        result = result.replace(marker, replacement)
    directory, basename = os.path.split(result)
    return os.path.join(directory, _sanitize_filename(basename))


def _output_directory(relative_path: str) -> Path:
    if folder_paths is None:
        raise RuntimeError("ComfyUI folder_paths is unavailable")
    root_value = (
        folder_paths.get_output_directory()
        if hasattr(folder_paths, "get_output_directory")
        else folder_paths.output_directory
    )
    root = Path(root_value).resolve()
    requested = Path(relative_path or "")
    if requested.is_absolute():
        raise ValueError("Image Saver path must be relative to ComfyUI's output directory")
    resolved = (root / requested).resolve()
    if os.path.commonpath((str(root), str(resolved))) != str(root):
        raise ValueError("Image Saver path cannot leave ComfyUI's output directory")
    return resolved


def _tensor_to_image(value: Any) -> Image.Image:
    if isinstance(value, Image.Image):
        return value.copy()
    array = value.cpu().numpy() if hasattr(value, "cpu") else np.asarray(value)
    array = np.asarray(array)
    if np.issubdtype(array.dtype, np.floating):
        array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    else:
        array = np.clip(array, 0, 255).astype(np.uint8)
    if array.ndim == 3 and array.shape[-1] == 1:
        array = array[..., 0]
    return Image.fromarray(array)


def _image_size(images: Any) -> tuple[int, int]:
    first = images[0]
    if isinstance(first, Image.Image):
        return first.size
    shape = tuple(getattr(first, "shape", ()))
    if len(shape) >= 2:
        return int(shape[-2] if len(shape) == 2 else shape[1]), int(shape[0])
    image = _tensor_to_image(first)
    return image.size


def _exif_comment(
    a1111_parameters: str,
    pm4a_metadata: dict[str, str],
) -> str:
    lines = [a1111_parameters.strip()]
    labels = {
        "pm4a_prompt_json": "PM4A prompt",
        "pm4a_generation_parameters": "PM4A generation parameters",
    }
    for key, label in labels.items():
        value = pm4a_metadata.get(key, "").strip()
        if value:
            lines.append(f"{label}: {value}")
    return "\n".join(line for line in lines if line)


def _save_image(
    image: Image.Image,
    filepath: Path,
    extension: str,
    quality: int,
    lossless_webp: bool,
    optimize_png: bool,
    a1111_parameters: str,
    pm4a_metadata: dict[str, str],
    prompt: dict[str, Any] | None,
    extra_pnginfo: dict[str, Any] | None,
    embed_workflow: bool,
) -> None:
    if extension == "png":
        pnginfo = PngInfo()
        if a1111_parameters:
            pnginfo.add_text("parameters", a1111_parameters)
        for key, value in pm4a_metadata.items():
            if value:
                pnginfo.add_text(key, value)
        if embed_workflow:
            for key, value in (extra_pnginfo or {}).items():
                pnginfo.add_text(str(key), _compact_json(value))
            if prompt is not None:
                pnginfo.add_text("prompt", _compact_json(prompt))
        image.save(filepath, pnginfo=pnginfo, optimize=optimize_png)
        return

    save_image = image.convert("RGB") if extension in {"jpg", "jpeg"} else image
    options: dict[str, Any] = {"optimize": True, "quality": int(quality)}
    if extension == "webp":
        options["lossless"] = bool(lossless_webp)
    save_image.save(filepath, **options)

    try:
        import piexif
        import piexif.helper
    except ImportError as exc:
        raise RuntimeError("piexif is required to save JPEG/WebP metadata") from exc

    workflow_tags: dict[int, str] = {}
    prompt_tags: dict[int, str] = {}
    if embed_workflow:
        workflow_tags = {
            piexif.ImageIFD.Make - index: f"{key}:{_compact_json(value)}"
            for index, (key, value) in enumerate((extra_pnginfo or {}).items())
        }
        if prompt is not None:
            prompt_tags[piexif.ImageIFD.Model] = f"prompt:{_compact_json(prompt)}"

    full_comment = _exif_comment(a1111_parameters, pm4a_metadata)

    def exif_bytes(comment: str) -> bytes:
        data: dict[str, Any] = {}
        if workflow_tags or prompt_tags:
            data["0th"] = workflow_tags | prompt_tags
        if comment:
            data["Exif"] = {
                piexif.ExifIFD.UserComment: piexif.helper.UserComment.dump(
                    comment,
                    encoding="unicode",
                )
            }
        return piexif.dump(data)

    encoded = exif_bytes(full_comment)
    if extension in {"jpg", "jpeg"} and len(encoded) > 65535:
        prompt_tags.clear()
        encoded = exif_bytes(full_comment)
        if len(encoded) > 65535:
            workflow_tags.clear()
            encoded = exif_bytes(full_comment)
        if len(encoded) > 65535:
            encoded = exif_bytes(a1111_parameters)
        if len(encoded) > 65535:
            logger.warning(
                "metadata exceeds JPEG's EXIF size limit; image was saved without EXIF"
            )
            return
    piexif.insert(encoded, str(filepath))


def _save_workflow_json(extra_pnginfo: dict[str, Any] | None, filepath: Path) -> None:
    workflow = (extra_pnginfo or {}).get("workflow")
    if workflow is None:
        logger.debug("no workflow found; skipping JSON sidecar")
        return
    try:
        with filepath.open("w", encoding="utf-8") as handle:
            json.dump(workflow, handle, ensure_ascii=False)
    except Exception as exc:
        logger.warning("failed to save workflow JSON: %s", exc)


def _base_suffix(parent: Path, prefix: str, extension: str, batch_size: int) -> int | None:
    existing = [
        item.name
        for item in parent.iterdir()
        if item.is_file() and item.name.startswith(prefix) and item.name.endswith(f".{extension}")
    ]
    if batch_size == 1 and not existing:
        return None
    suffixes: list[int] = []
    for name in existing:
        stem = os.path.splitext(name)[0]
        ending = stem.rsplit("_", 1)[-1]
        if ending.isdigit():
            suffixes.append(int(ending))
    return max(suffixes) + 1 if suffixes else 1


class ImageSaver4A:
    NAME = "Image Saver (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "image(s) to save"}),
                "filename": (
                    "STRING",
                    {
                        "default": "%time_%seed",
                        "multiline": False,
                        "tooltip": "Same filename variables as Image Saver Simple",
                    },
                ),
                "path": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "path under ComfyUI's output directory",
                    },
                ),
                "extension": (["png", "jpeg", "jpg", "webp"],),
                "lossless_webp": ("BOOLEAN", {"default": True}),
                "quality_jpeg_or_webp": (
                    "INT",
                    {"default": 100, "min": 1, "max": 100},
                ),
                "optimize_png": ("BOOLEAN", {"default": False}),
                "embed_workflow": ("BOOLEAN", {"default": True}),
                "save_workflow_as_json": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "model_name": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "checkpoint or UNet filename; its SHA256 is resolved automatically",
                    },
                ),
                "loaded_loras": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "Lora Manager loaded_loras output",
                    },
                ),
                "prompt_json": (
                    "STRING",
                    {"forceInput": True, "tooltip": "Prompt Scheduler prompt_json"},
                ),
                "positive": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": (
                            "Positive prompt when Prompt Scheduler is not connected; "
                            "ignored when prompt_json provides prompts"
                        ),
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": (
                            "Negative prompt when Prompt Scheduler is not connected; "
                            "ignored when prompt_json provides prompts"
                        ),
                    },
                ),
                "parameters_json": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "Concatenated Input Parameters and Double Sample Parameters JSON",
                    },
                ),
                "custom": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "custom text appended to A1111 metadata",
                    },
                ),
                "counter": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF},
                ),
                "time_format": (
                    "STRING",
                    {"default": "%Y-%m-%d-%H%M%S", "multiline": False},
                ),
                "show_preview": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("hashes", "a1111_params")
    OUTPUT_TOOLTIPS = (
        "Resolved model, LoRA and embedding hashes",
        "A1111-compatible parameters written to the image",
    )
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Independent Image Saver Simple-style output with exact generation parameters and "
        "automatic model, LoRA and embedding hashes. "
        "Connect Prompt Scheduler prompt_json, or fill/wire positive and negative directly."
    )

    def save_images(
        self,
        images: Any,
        filename: str,
        path: str,
        extension: str,
        lossless_webp: bool,
        quality_jpeg_or_webp: int,
        optimize_png: bool,
        embed_workflow: bool = True,
        save_workflow_as_json: bool = False,
        model_name: str = "",
        loaded_loras: str = "",
        prompt_json: str = "",
        positive: str = "",
        negative: str = "",
        parameters_json: str = "",
        custom: str = "",
        counter: int = 0,
        time_format: str = "%Y-%m-%d-%H%M%S",
        show_preview: bool = True,
        prompt: dict[str, Any] | None = None,
        extra_pnginfo: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        extension = str(extension).lower()
        if extension not in {"png", "jpeg", "jpg", "webp"}:
            raise ValueError(f"Unsupported image extension: {extension}")
        if images is None or len(images) == 0:
            raise ValueError("No images supplied")

        actual_width, actual_height = _image_size(images)
        parameters = parse_parameters_json(parameters_json, INPUT_PARAMETERS_SCHEMA)
        if parameters is None:
            parameters = _default_parameters(actual_width, actual_height)

        double_parameters = parse_parameters_json(
            parameters_json,
            DOUBLE_SAMPLE_SCHEMA,
        )
        if double_parameters:
            double_parameters.pop("width", None)
            double_parameters.pop("height", None)

        positive, negative = resolve_prompt_texts(prompt_json, positive, negative)
        loaded_loras = str(loaded_loras or "").strip()
        model_name = str(model_name or "").strip() or _model_name_from_prompt(prompt)
        resources = collect_resources(model_name, positive, negative, loaded_loras)

        prompt_document = build_prompt_document(
            prompt_json,
            parameters,
            double_parameters,
            positive,
            negative,
        )
        generation_metadata = generation_payload(
            parameters,
            double_parameters,
            resources,
        )
        if prompt_document is not None:
            models = [
                {
                    "type": model["type"],
                    "name": model["name"],
                    # Cards store full sha256; A1111 params still use the short hash.
                    "hash": model.get("sha256") or model["hash"],
                }
                for model in resources["models"]
            ]
            if models:
                prompt_document["models"] = models
            lora_hashes = [
                {"name": lora["name"], "hash": lora["hash"]}
                for lora in resources["loras"]
            ]
            lora_tags = []
            seen_tags: set[str] = set()
            for match in _LORA_TAG.finditer(f"{positive}\n{negative}\n{loaded_loras}"):
                tag = match.group(0)
                if tag.casefold() not in seen_tags:
                    seen_tags.add(tag.casefold())
                    lora_tags.append(tag)
            if lora_tags or lora_hashes:
                prompt_document["loras"] = {
                    "text": " ".join(lora_tags),
                    "hashes": lora_hashes,
                }
            if resources["embeddings"]:
                prompt_document["embeddings"] = [
                    {
                        "name": embedding["name"],
                        "hash": embedding["hash"],
                        "weight": embedding["weight"],
                    }
                    for embedding in resources["embeddings"]
                ]
        pm4a_metadata = {
            "pm4a_prompt_json": _compact_json(prompt_document) if prompt_document else "",
            "pm4a_generation_parameters": _compact_json(generation_metadata),
        }

        a1111_parameters = build_a1111_parameters(
            parameters,
            append_loaded_loras(positive, loaded_loras),
            negative,
            resources,
            custom,
        )

        rendered_path = _apply_variables(
            path,
            parameters,
            model_name,
            counter,
            time_format,
            custom,
        )
        output_directory = _output_directory(rendered_path)
        output_directory.mkdir(parents=True, exist_ok=True)
        rendered_filename = _apply_variables(
            filename,
            parameters,
            model_name,
            counter,
            time_format,
            custom,
        )
        if not rendered_filename:
            rendered_filename = _timestamp(time_format)

        prefix_path = Path(rendered_filename)
        target_parent = (output_directory / prefix_path.parent).resolve()
        if os.path.commonpath((str(output_directory), str(target_parent))) != str(output_directory):
            raise ValueError("Image filename cannot leave the selected output path")
        target_parent.mkdir(parents=True, exist_ok=True)
        prefix = prefix_path.name
        suffix = _base_suffix(target_parent, prefix, extension, len(images))

        preview_images: list[dict[str, str]] = []
        for index, tensor in enumerate(images):
            current_prefix = prefix if suffix is None else f"{prefix}_{suffix + index:02d}"
            final_filename = f"{current_prefix}.{extension}"
            filepath = target_parent / final_filename
            image = _tensor_to_image(tensor)
            _save_image(
                image,
                filepath,
                extension,
                quality_jpeg_or_webp,
                lossless_webp,
                optimize_png,
                a1111_parameters,
                pm4a_metadata,
                prompt,
                extra_pnginfo,
                embed_workflow,
            )
            if save_workflow_as_json:
                _save_workflow_json(extra_pnginfo, target_parent / f"{current_prefix}.json")

            root = _output_directory("")
            subfolder = os.path.relpath(target_parent, root)
            preview_images.append(
                {
                    "filename": final_filename,
                    "subfolder": "" if subfolder == "." else subfolder,
                    "type": "output",
                }
            )

        result: dict[str, Any] = {
            "result": (resource_hash_string(resources), a1111_parameters)
        }
        if show_preview:
            result["ui"] = {"images": preview_images}
        return result
