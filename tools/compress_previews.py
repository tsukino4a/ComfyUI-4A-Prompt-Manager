"""Safely convert wildcard preview PNG files to high-quality WebP."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

from PIL import Image


def _preview_pngs(root: Path) -> list[Path]:
    return sorted(
        (path for path in root.rglob("*.png") if path.is_file()),
        key=lambda path: str(path.relative_to(root)).casefold(),
    )


def _encode_one(args: tuple[str, str, int, int]) -> tuple[str, int, int, int, int]:
    source_raw, target_raw, quality, method = args
    source = Path(source_raw)
    target = Path(target_raw)
    temporary = target.with_name(
        f".{target.stem}.pm4a-compress-{os.getpid()}-{uuid.uuid4().hex}.tmp"
    )
    try:
        with Image.open(source) as image:
            original_size = image.size
            rgb = image.convert("RGB")
            rgb.save(
                temporary,
                format="WEBP",
                quality=quality,
                method=method,
                lossless=False,
            )
        with Image.open(temporary) as check:
            if check.format != "WEBP" or check.size != original_size:
                raise OSError(f"WebP verification failed: {source}")
            check.load()
            width, height = check.size
        os.replace(temporary, target)
        return (
            source_raw,
            source.stat().st_size,
            target.stat().st_size,
            width,
            height,
        )
    finally:
        temporary.unlink(missing_ok=True)


def compress_previews(
    root: Path,
    *,
    quality: int = 90,
    method: int = 6,
    workers: int = 8,
    backup_parent: Path | None = None,
) -> dict:
    root = Path(root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Wildcard root does not exist: {root}")
    sources = _preview_pngs(root)
    if not sources:
        return {"root": str(root), "count": 0, "backup": None}

    targets = [source.with_suffix(".webp") for source in sources]
    conflicts = [target for target in targets if target.exists()]
    if conflicts:
        raise FileExistsError(f"Target WebP already exists: {conflicts[0]}")

    backup_parent = (
        Path(backup_parent).resolve()
        if backup_parent is not None
        else (root.parent / "backups").resolve()
    )
    backup_parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = backup_parent / f"wildcards-png-before-webp-{stamp}"
    if backup_root.exists():
        raise FileExistsError(f"Backup directory already exists: {backup_root}")
    backup_root.mkdir(parents=True)

    backup_mode = "hardlink"
    for index, source in enumerate(sources, start=1):
        relative = source.relative_to(root)
        backup = backup_root / relative
        backup.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, backup)
        except OSError:
            backup_mode = "mixed"
            shutil.copy2(source, backup)
        if not backup.is_file() or backup.stat().st_size != source.stat().st_size:
            raise OSError(f"Backup verification failed: {relative}")
        if index % 1000 == 0:
            print(f"backup {index}/{len(sources)}", flush=True)

    manifest_path = backup_root / "manifest.json"
    manifest = {
        "status": "prepared",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_root": str(root),
        "count": len(sources),
        "quality": quality,
        "method": method,
        "backup_mode": backup_mode,
        "files": [
            {
                "path": str(source.relative_to(root)).replace("\\", "/"),
                "bytes": source.stat().st_size,
            }
            for source in sources
        ],
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    created_targets: list[Path] = []
    old_bytes = 0
    new_bytes = 0
    jobs = [
        (str(source), str(target), quality, method)
        for source, target in zip(sources, targets)
    ]
    try:
        with ProcessPoolExecutor(max_workers=max(1, workers)) as executor:
            for index, result in enumerate(executor.map(_encode_one, jobs), start=1):
                source_raw, source_bytes, target_bytes, width, height = result
                source = Path(source_raw)
                target = source.with_suffix(".webp")
                if (width, height) != (920, 1536):
                    raise OSError(f"Unexpected preview size after conversion: {target}")
                created_targets.append(target)
                old_bytes += source_bytes
                new_bytes += target_bytes
                if index % 250 == 0 or index == len(sources):
                    print(
                        f"encode {index}/{len(sources)} "
                        f"saved={(1 - new_bytes / old_bytes) * 100:.1f}%",
                        flush=True,
                    )
    except Exception:
        for target in created_targets:
            target.unlink(missing_ok=True)
        raise

    if len(created_targets) != len(sources):
        raise OSError("Not every preview was converted")

    # Originals are removed from the active library only after every WebP decodes.
    for index, source in enumerate(sources, start=1):
        source.unlink()
        if index % 1000 == 0:
            print(f"cleanup {index}/{len(sources)}", flush=True)

    manifest.update(
        {
            "status": "complete",
            "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "original_bytes": old_bytes,
            "webp_bytes": new_bytes,
            "saved_percent": round((1 - new_bytes / old_bytes) * 100, 3),
        }
    )
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "root": str(root),
        "backup": str(backup_root),
        "count": len(sources),
        "original_bytes": old_bytes,
        "webp_bytes": new_bytes,
        "saved_percent": manifest["saved_percent"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert preview PNG files to WebP")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "wildcards",
    )
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--method", type=int, default=6)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--backup-parent", type=Path, default=None)
    args = parser.parse_args()
    if not 1 <= args.quality <= 100:
        raise SystemExit("quality must be between 1 and 100")
    if not 0 <= args.method <= 6:
        raise SystemExit("method must be between 0 and 6")
    report = compress_previews(
        args.root,
        quality=args.quality,
        method=args.method,
        workers=args.workers,
        backup_parent=args.backup_parent,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
