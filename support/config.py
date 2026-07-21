"""Load plugin configuration (wildcards path, etc.)."""

from __future__ import annotations

import configparser
import logging
from pathlib import Path

logger = logging.getLogger("ComfyUI4APromptManager")

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PLUGIN_ROOT / "config.ini"
CONFIG_EXAMPLE_PATH = PLUGIN_ROOT / "config.example.ini"


def _default_wildcards_path() -> Path:
    """Prefer sibling export/wildcards in this repo, else plugin/wildcards."""
    repo_export = PLUGIN_ROOT.parent / "export" / "wildcards"
    if repo_export.is_dir():
        return repo_export
    return PLUGIN_ROOT / "wildcards"


def ensure_config() -> None:
    """Create config.ini from example if missing."""
    if CONFIG_PATH.exists():
        return
    if CONFIG_EXAMPLE_PATH.exists():
        CONFIG_PATH.write_text(CONFIG_EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        return
    CONFIG_PATH.write_text(
        "[main]\nwildcards_path =\n",
        encoding="utf-8",
    )


def get_wildcards_path() -> Path:
    """Return the absolute wildcards root directory."""
    ensure_config()
    parser = configparser.ConfigParser()
    try:
        parser.read(CONFIG_PATH, encoding="utf-8")
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to read config.ini: %s", exc)
        return _default_wildcards_path()

    raw = ""
    if parser.has_section("main"):
        raw = parser.get("main", "wildcards_path", fallback="").strip()

    if not raw:
        path = _default_wildcards_path()
    else:
        path = Path(raw)
        if not path.is_absolute():
            path = (PLUGIN_ROOT / path).resolve()

    path.mkdir(parents=True, exist_ok=True)
    return path
