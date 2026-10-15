"""SHA256 lookup for local model files, shared by the resolver and Image Saver."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

_SHA256 = re.compile(r"[0-9a-f]{64}")


def _valid_sha256(value: object) -> str:
    text = str(value or "").strip().casefold()
    return text if _SHA256.fullmatch(text) else ""


def sidecar_sha256(path: Path) -> str:
    """Return a hash already stored next to the file (.sha256, then .metadata.json)."""
    try:
        words = path.with_suffix(".sha256").read_text(encoding="utf-8").split()
        value = _valid_sha256(words[0] if words else "")
        if value:
            return value
    except OSError:
        pass
    try:
        payload = json.loads(path.with_suffix(".metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    return _valid_sha256(payload.get("sha256")) if isinstance(payload, dict) else ""


def compute_sha256(path: Path) -> str:
    """Hash the file and store the result as a .sha256 sidecar when possible."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    value = digest.hexdigest()
    try:
        path.with_suffix(".sha256").write_text(value, encoding="utf-8")
    except OSError:
        pass
    return value
