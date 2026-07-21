"""Discover traditional wildcard libraries from sibling ComfyUI nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

try:
    from ...storage.prompt_documents import read_txt_options
    from ...support.config import PLUGIN_ROOT
    from ...support.i18n import tr
except ImportError:  # standalone preview
    from storage.prompt_documents import read_txt_options  # type: ignore
    from support.config import PLUGIN_ROOT  # type: ignore
    from support.i18n import tr  # type: ignore


ProgressCallback = Callable[[int, int, str], None]


def _wildcards_directory(node_root: Path) -> Path | None:
    try:
        children = node_root.iterdir()
    except OSError:
        return None
    for child in children:
        if (
            child.name.casefold() == "wildcards"
            and child.is_dir()
            and not child.is_symlink()
        ):
            return child
    return None


def _txt_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if (
            not path.is_file()
            or path.is_symlink()
            or path.suffix.casefold() != ".txt"
        ):
            continue
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if root.resolve() not in resolved.parents:
            continue
        files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix().casefold())


def _discover_sources(
    custom_nodes_root: Path | None,
    current_plugin_root: Path | None,
) -> list[dict[str, Any]]:
    custom_root = Path(custom_nodes_root or PLUGIN_ROOT.parent).resolve()
    current_root = Path(current_plugin_root or PLUGIN_ROOT).resolve()
    if not custom_root.is_dir():
        raise FileNotFoundError(tr("无法找到 ComfyUI custom_nodes 目录"))

    sources: list[dict[str, Any]] = []
    for node_root in sorted(custom_root.iterdir(), key=lambda path: path.name.casefold()):
        if (
            node_root.name.startswith(".")
            or node_root.name.casefold().endswith(".disabled")
            or not node_root.is_dir()
            or node_root.is_symlink()
            or not (node_root / "__init__.py").is_file()
        ):
            continue
        try:
            node_resolved = node_root.resolve()
            if node_resolved == current_root or custom_root not in node_resolved.parents:
                continue
        except OSError:
            continue
        wildcard_root = _wildcards_directory(node_root)
        if wildcard_root is None:
            continue
        try:
            if node_resolved not in wildcard_root.resolve().parents:
                continue
        except OSError:
            continue
        sources.append(
            {
                "id": node_root.name,
                "name": node_root.name,
                "files": [
                    {
                        "id": f"{node_root.name}/{path.relative_to(wildcard_root).as_posix()}",
                        "relative_path": path.relative_to(wildcard_root).as_posix(),
                        "_path": path,
                    }
                    for path in _txt_files(wildcard_root)
                ],
            }
        )
    return sources


def scan_external_wildcards(
    *,
    custom_nodes_root: Path | None = None,
    current_plugin_root: Path | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Return lightweight metadata for traditional wildcard files."""
    sources = _discover_sources(custom_nodes_root, current_plugin_root)

    total_files = sum(len(source["files"]) for source in sources)
    if progress_callback:
        progress_callback(0, total_files, tr("正在解析外部 Wildcard 文件"))

    errors: list[dict[str, str]] = []
    processed = 0
    for source in sources:
        source_prompt_count = 0
        source_error_count = 0
        for file in source["files"]:
            path = file["_path"]
            file_error = ""
            try:
                options = read_txt_options(path)
            except (OSError, UnicodeError) as exc:
                options = []
                file_error = str(exc)

            file.pop("_path", None)
            file["sample"] = options[:3]
            file["option_count"] = len(options)
            file["prompt_count"] = len(options)
            if file_error:
                file["error"] = file_error
                source_error_count += 1
                errors.append(
                    {
                        "source_id": source["id"],
                        "file_id": file["id"],
                        "relative_path": file["relative_path"],
                        "error": file_error,
                    }
                )
            source_prompt_count += len(options)
            processed += 1
            if progress_callback:
                progress_callback(
                    processed,
                    total_files,
                    tr("正在解析外部 Wildcard 文件"),
                )

        source["file_count"] = len(source["files"])
        source["prompt_count"] = source_prompt_count
        source["error_count"] = source_error_count

    return {
        "sources": sources,
        "source_count": len(sources),
        "file_count": total_files,
        "prompt_count": sum(source["prompt_count"] for source in sources),
        "error_count": len(errors),
        "errors": errors,
    }


def resolve_external_wildcard_files(
    file_ids: list[str],
    *,
    custom_nodes_root: Path | None = None,
    current_plugin_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Resolve opaque scan IDs back to sandboxed server-side file paths."""
    if not isinstance(file_ids, list) or not all(
        isinstance(file_id, str) and file_id for file_id in file_ids
    ):
        raise ValueError(tr("外部 Wildcard 文件无效"))
    sources = _discover_sources(custom_nodes_root, current_plugin_root)
    available = {
        file["id"]: file
        for source in sources
        for file in source["files"]
    }
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for file_id in file_ids:
        if file_id in seen or file_id not in available:
            raise ValueError(tr("外部 Wildcard 文件无效"))
        seen.add(file_id)
        file = available[file_id]
        path = file["_path"]
        options = read_txt_options(path)
        resolved.append(
            {
                "id": file_id,
                "relative_path": file["relative_path"],
                "path": path,
                "option_count": len(options),
            }
        )
    return resolved
