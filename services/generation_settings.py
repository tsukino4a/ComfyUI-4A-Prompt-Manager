"""Persistence, defaults, and validation for preview generation settings."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

try:
    from ..integrations.comfyui.workflow_analysis import (
        GenerationConfigError,
        WorkflowAnalysis,
    )
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from integrations.comfyui.workflow_analysis import (  # type: ignore
        GenerationConfigError,
        WorkflowAnalysis,
    )
    from support.i18n import tr  # type: ignore


MAX_WORKFLOW_BYTES = 4 * 1024 * 1024
DEFAULT_SETTINGS: dict[str, Any] = {
    "model": "",
    "clip": "",
    "vae": "",
    "width": 512,
    "height": 512,
    "steps": 20,
    "cfg": 7.0,
    "sampler": "euler",
    "scheduler": "normal",
    "denoise": 1.0,
    "seed_mode": "random",
    "seed": 0,
    "positive_prefix": "masterpiece, best quality, score_7,",
    "positive_suffix": "",
    "negative_prefix": (
        "worst quality, low quality, score_1, score_2, score_3, artist name,"
    ),
    "negative_suffix": "",
}


def read_json_file(path: Path, *, max_bytes: int = MAX_WORKFLOW_BYTES) -> dict[str, Any]:
    try:
        if path.stat().st_size > max_bytes:
            raise GenerationConfigError(tr("api.json 不能超过 4 MB"))
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except GenerationConfigError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GenerationConfigError(tr("无法读取 api.json：{error}", error=exc)) from exc
    if not isinstance(value, dict):
        raise GenerationConfigError(tr("api.json 顶层必须是对象"))
    return value


def write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def merged_settings(saved: object, analysis: WorkflowAnalysis) -> dict[str, Any]:
    result = dict(DEFAULT_SETTINGS)
    result.update(analysis.defaults)
    if isinstance(saved, dict):
        for key in DEFAULT_SETTINGS:
            if key in saved:
                result[key] = saved[key]
    return result


def validate_settings(
    value: object,
    analysis: WorkflowAnalysis,
    *,
    output_root: Path,
    model_options: list[str] | None = None,
    clip_options: list[str] | None = None,
    vae_options: list[str] | None = None,
    sampler_options: list[str] | None = None,
    scheduler_options: list[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GenerationConfigError(tr("设置必须是对象"))
    result = merged_settings(value, analysis)
    for key in ("model", "clip", "vae", "sampler", "scheduler"):
        if not isinstance(result.get(key), str):
            raise GenerationConfigError(tr("{key} 必须是字符串", key=key))
        result[key] = result[key].strip()
    if model_options and result["model"] not in model_options:
        raise GenerationConfigError(tr("选择的模型不存在"))
    if analysis.clip is None:
        result["clip"] = ""
    elif clip_options and result["clip"] not in clip_options:
        raise GenerationConfigError(tr("选择的 CLIP 不存在"))
    if analysis.vae is None:
        result["vae"] = ""
    elif vae_options and result["vae"] not in vae_options:
        raise GenerationConfigError(tr("选择的 VAE 不存在"))
    if (
        sampler_options
        and "sampler" in analysis.parameters
        and result["sampler"] not in sampler_options
    ):
        raise GenerationConfigError(tr("选择的采样器无效"))
    if (
        scheduler_options
        and "scheduler" in analysis.parameters
        and result["scheduler"] not in scheduler_options
    ):
        raise GenerationConfigError(tr("选择的调度器无效"))

    for key in ("width", "height", "steps", "seed"):
        try:
            result[key] = int(result[key])
        except (TypeError, ValueError) as exc:
            raise GenerationConfigError(tr("{key} 必须是整数", key=key)) from exc
    if not 64 <= result["width"] <= 16384 or result["width"] % 8:
        raise GenerationConfigError(tr("宽度必须是 64–16384 之间的 8 的倍数"))
    if not 64 <= result["height"] <= 16384 or result["height"] % 8:
        raise GenerationConfigError(tr("高度必须是 64–16384 之间的 8 的倍数"))
    if not 1 <= result["steps"] <= 10_000:
        raise GenerationConfigError(tr("步数必须在 1–10000 之间"))
    if not 0 <= result["seed"] <= 9_007_199_254_740_991:
        raise GenerationConfigError(tr("固定种子超出安全整数范围"))

    for key in ("cfg", "denoise"):
        try:
            result[key] = float(result[key])
        except (TypeError, ValueError) as exc:
            raise GenerationConfigError(tr("{key} 必须是数字", key=key)) from exc
    if not 0 <= result["cfg"] <= 100:
        raise GenerationConfigError(tr("CFG 必须在 0–100 之间"))
    if not 0 <= result["denoise"] <= 1:
        raise GenerationConfigError(tr("降噪强度必须在 0–1 之间"))
    if result.get("seed_mode") not in {"random", "fixed"}:
        raise GenerationConfigError(tr("种子模式必须是 random 或 fixed"))
    for key in (
        "positive_prefix",
        "positive_suffix",
        "negative_prefix",
        "negative_suffix",
    ):
        if not isinstance(result.get(key), str):
            raise GenerationConfigError(tr("{key} 必须是字符串", key=key))
        if len(result[key]) > 1_000_000:
            raise GenerationConfigError(tr("固定提示词文本过长"))
    return {key: result[key] for key in DEFAULT_SETTINGS}
