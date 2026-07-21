"""Reusable second-pass sampler parameters with portable JSON metadata."""

from __future__ import annotations

import json
from typing import Any, Final

from .input_parameters import _LazyReturnTypes, _sampler_options, _scheduler_options


DOUBLE_SAMPLE_SCHEMA: Final[str] = "pm4a_double_sample_parameters"


def serialize_parameters(
    seed: int,
    steps: int,
    cfg: float,
    sampler: str,
    scheduler: str,
    denoise: float,
) -> str:
    """Return a compact, self-identifying payload suitable for Image Saver custom."""

    payload: dict[str, Any] = {
        "schema": DOUBLE_SAMPLE_SCHEMA,
        "parameters": {
            "seed": int(seed),
            "steps": int(steps),
            "cfg": float(cfg),
            "sampler": str(sampler),
            "scheduler": str(scheduler),
            "denoise": float(denoise),
        },
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class DoubleSampleParameters4A:
    NAME = "Double Sample Parameters (4A Prompt Manager)"

    RETURN_TYPES = _LazyReturnTypes(
        lambda: (
            "INT",
            "INT",
            "FLOAT",
            _sampler_options(),
            _scheduler_options(),
            "FLOAT",
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
        "parameters_json",
    )
    FUNCTION = "get_values"
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Outputs second-pass sampler parameters and a self-identifying JSON string "
        "that can be connected to Image Saver's custom metadata input."
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
    ):
        parameters_json = serialize_parameters(
            seed,
            steps,
            cfg,
            sampler,
            scheduler,
            denoise,
        )
        return seed, steps, cfg, sampler, scheduler, denoise, parameters_json
