"""Finalize and manage generated preview images."""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Mapping

from PIL import Image

try:
    from ..integrations.comfyui.workflow_analysis import GenerationConfigError
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from integrations.comfyui.workflow_analysis import (  # type: ignore
        GenerationConfigError,
    )
    from support.i18n import tr  # type: ignore


WEBP_QUALITY = 90
WEBP_METHOD = 6
PENDING_PREVIEW_SUBDIR = Path("4A-Prompt-Manager") / "preview-temp"
PENDING_PREVIEW_MAX_AGE_SECONDS = 24 * 60 * 60

_UNSAFE_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_source_path(locator: Mapping[str, Any], roots: Mapping[str, Path]) -> Path:
    kind = str(locator.get("type", ""))
    if kind not in {"output", "temp"} or kind not in roots:
        raise GenerationConfigError(tr("只允许读取本次任务的 output 或 temp 图片"))
    filename = str(locator.get("filename", ""))
    subfolder = str(locator.get("subfolder", ""))
    if not filename or Path(filename).name != filename:
        raise GenerationConfigError(tr("生成图片文件名无效"))
    root = roots[kind].resolve()
    source = (root / subfolder / filename).resolve()
    if os.path.commonpath((str(root), str(source))) != str(root):
        raise GenerationConfigError(tr("生成图片路径越界"))
    if not source.is_file():
        raise FileNotFoundError(tr("生成图片不存在"))
    return source


def _safe_title(value: object) -> str:
    title = _UNSAFE_FILENAME.sub("-", str(value or "").strip()).strip(" .-")
    return title[:120] or "PM4A"


def _pending_preview_root(temp_root: Path) -> Path:
    return (Path(temp_root).resolve() / PENDING_PREVIEW_SUBDIR).resolve()


def _pending_preview_path(
    locator: Mapping[str, Any],
    temp_root: Path,
    *,
    require_exists: bool = True,
) -> Path:
    if str(locator.get("type", "")) != "temp":
        raise GenerationConfigError(tr("只允许使用临时预览图"))
    filename = str(locator.get("filename", ""))
    subfolder = str(locator.get("subfolder", ""))
    if (
        not filename
        or Path(filename).name != filename
        or Path(filename).suffix.casefold() != ".webp"
    ):
        raise GenerationConfigError(tr("临时预览图文件名无效"))
    requested_subfolder = Path(subfolder)
    if (
        requested_subfolder.is_absolute()
        or requested_subfolder.drive
        or ".." in requested_subfolder.parts
    ):
        raise GenerationConfigError(tr("临时预览图路径无效"))
    temp = Path(temp_root).resolve()
    managed_root = _pending_preview_root(temp)
    source = (temp / subfolder / filename).resolve()
    if os.path.commonpath((str(managed_root), str(source))) != str(managed_root):
        raise GenerationConfigError(tr("临时预览图路径无效"))
    if require_exists and not source.is_file():
        raise FileNotFoundError(tr("临时预览图不存在"))
    return source


def cleanup_pending_previews(
    temp_root: Path,
    *,
    max_age_seconds: int = PENDING_PREVIEW_MAX_AGE_SECONDS,
) -> int:
    managed_root = _pending_preview_root(temp_root)
    if not managed_root.is_dir():
        return 0
    cutoff = time.time() - max(0, int(max_age_seconds))
    removed = 0
    for path in managed_root.rglob("*"):
        try:
            is_managed_file = (
                path.suffix.casefold() == ".webp"
                or (path.name.startswith(".") and path.name.endswith(".tmp"))
            )
            if is_managed_file and path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def discard_pending_preview(
    locator: Mapping[str, Any],
    *,
    temp_root: Path,
) -> bool:
    source = _pending_preview_path(locator, temp_root, require_exists=False)
    existed = source.is_file()
    try:
        source.unlink(missing_ok=True)
    except OSError:
        return False
    return existed and not source.exists()


def _a1111_text(positive: str, negative: str, parameters: Mapping[str, Any]) -> str:
    model = Path(str(parameters.get("model", ""))).stem
    return (
        f"{positive.strip()}\nNegative prompt: {negative.strip()}\n"
        f"Steps: {parameters.get('steps')}, Sampler: {parameters.get('sampler')}, "
        f"Scheduler: {parameters.get('scheduler')}, CFG scale: {parameters.get('cfg')}, "
        f"Seed: {parameters.get('seed')}, "
        f"Size: {parameters.get('width')}x{parameters.get('height')}, "
        f"Denoising strength: {parameters.get('denoise')}, Model: {model}, Version: ComfyUI"
    ).strip()


def _webp_exif(metadata: Mapping[str, Any]) -> bytes | None:
    try:
        import piexif
        import piexif.helper
    except ImportError:
        return None
    comment = _a1111_text(
        str(metadata.get("positive", "")),
        str(metadata.get("negative", "")),
        metadata.get("parameters", {})
        if isinstance(metadata.get("parameters"), dict)
        else {},
    )
    document = json.dumps(dict(metadata), ensure_ascii=False, separators=(",", ":"))
    full_comment = f"{comment}\nPM4A generation: {document}"
    return piexif.dump(
        {
            "Exif": {
                piexif.ExifIFD.UserComment: piexif.helper.UserComment.dump(
                    full_comment, encoding="unicode"
                )
            }
        }
    )


def finalize_image(
    locator: Mapping[str, Any],
    metadata: Mapping[str, Any],
    *,
    title: str,
    output_root: Path,
    temp_root: Path,
) -> dict[str, Any]:
    """Convert a Comfy result to a managed temporary lossy WebP."""

    source = _safe_source_path(locator, {"temp": Path(temp_root)})
    cleanup_pending_previews(temp_root)
    target_dir = _pending_preview_root(temp_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    base = _safe_title(title)
    target = target_dir / f"{base}_{secrets.token_hex(8)}.webp"
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
    try:
        with Image.open(source) as image:
            original_size = image.size
            save_options: dict[str, Any] = {
                "format": "WEBP",
                "quality": WEBP_QUALITY,
                "method": WEBP_METHOD,
                "lossless": False,
            }
            exif = _webp_exif(metadata)
            if exif:
                save_options["exif"] = exif
            image.convert("RGB").save(
                temporary,
                **save_options,
            )
        with Image.open(temporary) as check:
            check.load()
            if check.format != "WEBP" or check.size != original_size:
                raise OSError(tr("WebP 压缩结果校验失败"))
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)

    relative = target.relative_to(Path(temp_root).resolve())
    return {
        "path": target,
        "bytes": target.read_bytes(),
        "locator": {
            "filename": target.name,
            "subfolder": str(relative.parent).replace("\\", "/")
            if relative.parent != Path(".")
            else "",
            "type": "temp",
        },
        "quality": WEBP_QUALITY,
    }


def attach_preview_image(
    locator: Mapping[str, Any], *, temp_root: Path, update_image: Any, key: str
) -> dict[str, Any]:
    source = _pending_preview_path(locator, temp_root)
    entry = update_image(key, source.read_bytes())
    try:
        source.unlink(missing_ok=True)
    except OSError:
        pass
    return entry
