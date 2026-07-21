"""Apply validated generation inputs to a ComfyUI API workflow."""

from __future__ import annotations

import copy
import secrets
from typing import Any, Mapping

try:
    from ...support.i18n import tr
    from .workflow_analysis import GenerationConfigError, WorkflowAnalysis
except ImportError:  # standalone preview
    from integrations.comfyui.workflow_analysis import (  # type: ignore
        GenerationConfigError,
        WorkflowAnalysis,
    )
    from support.i18n import tr  # type: ignore


def _join_prompt(*parts: object) -> str:
    cleaned = [str(part or "").strip().strip(",").strip() for part in parts]
    return ", ".join(part for part in cleaned if part)


def prepare_workflow(
    workflow: Mapping[str, Any],
    analysis: WorkflowAnalysis,
    settings: Mapping[str, Any],
    positive: str,
    negative: str = "",
    *,
    apply_fixed_prompts: bool = True,
) -> dict[str, Any]:
    if not isinstance(positive, str) or not positive.strip():
        raise GenerationConfigError(tr("正面提示词不能为空"))
    if not isinstance(negative, str):
        raise GenerationConfigError(tr("负面提示词必须是字符串"))
    prompt = copy.deepcopy(dict(workflow))
    seed = (
        secrets.randbelow(9_007_199_254_740_992)
        if settings.get("seed_mode") == "random"
        else int(settings.get("seed", 0))
    )
    if apply_fixed_prompts:
        effective_positive = _join_prompt(
            settings.get("positive_prefix"), positive, settings.get("positive_suffix")
        )
        effective_negative = _join_prompt(
            settings.get("negative_prefix"), negative, settings.get("negative_suffix")
        )
    else:
        effective_positive = positive.strip()
        effective_negative = negative.strip()
    for binding in analysis.positive:
        prompt[binding.node_id]["inputs"][binding.input_name] = effective_positive
    for binding in analysis.negative:
        prompt[binding.node_id]["inputs"][binding.input_name] = effective_negative
    prompt[analysis.model.node_id]["inputs"][analysis.model.input_name] = settings["model"]
    if analysis.clip is not None and settings.get("clip"):
        prompt[analysis.clip.node_id]["inputs"][analysis.clip.input_name] = settings["clip"]
    if analysis.vae is not None and settings.get("vae"):
        prompt[analysis.vae.node_id]["inputs"][analysis.vae.input_name] = settings["vae"]
    prompt[analysis.width.node_id]["inputs"][analysis.width.input_name] = int(
        settings["width"]
    )
    prompt[analysis.height.node_id]["inputs"][analysis.height.input_name] = int(
        settings["height"]
    )
    replacements = {
        "seed": seed,
        "steps": int(settings["steps"]),
        "cfg": float(settings["cfg"]),
        "sampler": settings["sampler"],
        "scheduler": settings["scheduler"],
        "denoise": float(settings["denoise"]),
    }
    for name, binding in analysis.parameters.items():
        prompt[binding.node_id]["inputs"][binding.input_name] = replacements[name]
    output_node = prompt[analysis.output_node]
    preview_node: dict[str, Any] = {
        "class_type": "PreviewImage",
        "inputs": {"images": copy.deepcopy(output_node["inputs"]["images"])},
    }
    if "_meta" in output_node:
        preview_node["_meta"] = copy.deepcopy(output_node["_meta"])
    prompt[analysis.output_node] = preview_node
    parameters = {
        "model": settings["model"],
        "clip": settings.get("clip", ""),
        "vae": settings.get("vae", ""),
        "seed": seed,
        "steps": int(settings["steps"]),
        "cfg": float(settings["cfg"]),
        "sampler": settings["sampler"],
        "scheduler": settings["scheduler"],
        "denoise": float(settings["denoise"]),
        "width": int(settings["width"]),
        "height": int(settings["height"]),
    }
    return {
        "prompt": prompt,
        "seed": seed,
        "positive": effective_positive,
        "negative": effective_negative,
        "parameters": parameters,
        "output_node": analysis.output_node,
    }
