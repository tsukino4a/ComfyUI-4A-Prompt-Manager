"""Install deps when ComfyUI-Manager installs this node (or when run manually)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    requirements = Path(__file__).resolve().parent / "requirements.txt"
    cmd = [sys.executable, "-m", "pip", "install", "-r", str(requirements)]
    print("[4A Prompt Manager]", " ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
