"""Reusable sampler and resolution parameters for 4A workflows."""

from __future__ import annotations

import json
from typing import Any
from typing import Final

try:
    import comfy.samplers
except ImportError:  # Allows the lightweight standalone tests to import this module.
    comfy = None


RATIO_PRESETS: Final[tuple[tuple[str, int, int], ...]] = (
    ("1:1 方形", 1, 1),
    ("4:3 横图", 4, 3),
    ("3:4 竖图", 3, 4),
    ("3:2 横图", 3, 2),
    ("2:3 竖图", 2, 3),
    ("16:9 横图", 16, 9),
    ("9:16 竖图", 9, 16),
    ("5:4 横图", 5, 4),
    ("4:5 竖图", 4, 5),
    ("5:3 横图", 5, 3),
    ("3:5 竖图", 3, 5),
    ("7:4 横图", 7, 4),
    ("4:7 竖图", 4, 7),
    ("2:1 横图", 2, 1),
    ("1:2 竖图", 1, 2),
    ("21:9 超宽", 21, 9),
    ("9:21 超长", 9, 21),
)

RATIO_VALUES: Final[tuple[str, ...]] = tuple(item[0] for item in RATIO_PRESETS)

INPUT_PARAMETERS_SCHEMA: Final[str] = "pm4a_input_parameters"


def serialize_parameters(
    seed: int,
    steps: int,
    cfg: float,
    sampler: str,
    scheduler: str,
    denoise: float,
    width: int,
    height: int,
) -> str:
    """Return the primary generation parameters as portable 4A metadata."""

    payload: dict[str, Any] = {
        "schema": INPUT_PARAMETERS_SCHEMA,
        "parameters": {
            "seed": int(seed),
            "steps": int(steps),
            "cfg": float(cfg),
            "sampler": str(sampler),
            "scheduler": str(scheduler),
            "denoise": float(denoise),
            "width": int(width),
            "height": int(height),
        },
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _round_to_multiple(value: float, multiple: int = 8) -> int:
    """Round halves upward to the nearest model-safe dimension."""

    return max(multiple, int(value / multiple + 0.5) * multiple)


def _sampler_options():
    if comfy is None:
        return ["euler"]
    return comfy.samplers.KSampler.SAMPLERS


def _scheduler_options():
    if comfy is None:
        return ["normal"]
    # Must stay a list (same as KSampler): Comfy COMBO link checks treat list≠tuple.
    # Return the live reference — packs like RES4LYF may append names after import.
    return comfy.samplers.KSampler.SCHEDULERS


class _LazyReturnTypes:
    """Rebuild RETURN_TYPES on every access.

    COMBO outputs are compared by list equality at link-validation time. If we
    freeze sampler/scheduler options at class definition, late-loading packs
    (e.g. RES4LYF adding beta57) leave our output type one step behind the
    target node's INPUT_TYPES and trigger Return type mismatch.
    """

    def __init__(self, factory):
        self._factory = factory

    def __get__(self, obj, owner=None):
        return self._factory()


class InputParameters4A:
    NAME = "Input Parameters (4A Prompt Manager)"

    RETURN_TYPES = _LazyReturnTypes(
        lambda: (
            "INT",
            "INT",
            "FLOAT",
            _sampler_options(),
            _scheduler_options(),
            "FLOAT",
            "INT",
            "INT",
            "STRING",
        )
    )
    RETURN_NAMES = (
        "seed",
        "steps",
        "cfg",
        "sampler",
        "scheduler",
        "denoise",
        "width",
        "height",
        "parameters_json",
    )
    FUNCTION = "get_values"
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Outputs sampler parameters, independent width and height, and portable JSON metadata. "
        "The ratio preset is a one-shot sizing helper in the frontend."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                    },
                ),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "cfg": (
                    "FLOAT",
                    {"default": 7.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01},
                ),
                "sampler": (_sampler_options(),),
                "scheduler": (_scheduler_options(),),
                "denoise": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
                "ratio": (RATIO_VALUES, {"default": "2:3 竖图"}),
                "width": (
                    "INT",
                    {"default": 1024, "min": 8, "max": 16384, "step": 8},
                ),
                "height": (
                    "INT",
                    {"default": 1536, "min": 8, "max": 16384, "step": 8},
                ),
            }
        }

    def get_values(
        self,
        seed: int,
        steps: int,
        cfg: float,
        sampler: str,
        scheduler: str,
        denoise: float,
        ratio: str,
        width: int,
        height: int,
    ):
        del ratio  # Stored for the one-shot frontend preset; outputs stay independent.
        rounded_width = _round_to_multiple(float(width))
        rounded_height = _round_to_multiple(float(height))
        parameters_json = serialize_parameters(
            seed,
            steps,
            cfg,
            sampler,
            scheduler,
            denoise,
            rounded_width,
            rounded_height,
        )
        return (
            seed,
            steps,
            cfg,
            sampler,
            scheduler,
            denoise,
            rounded_width,
            rounded_height,
            parameters_json,
        )
