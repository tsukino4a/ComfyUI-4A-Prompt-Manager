"""Dynamic folder-backed prompt scheduler node."""

from __future__ import annotations

import json

try:
    from ..services import prompt_library as wc
    from ..services import scheduler
except ImportError:  # standalone import check
    from services import prompt_library as wc  # type: ignore
    from services import scheduler  # type: ignore


_EXTERNAL_TRACK_PREFIX = "pm4a_track_"


class _FlexibleStringInputs(dict):
    """Accept JS-created STRING inputs for the scheduler's dynamic tracks."""

    def __getitem__(self, key):
        return ("STRING", {"forceInput": True})

    def __contains__(self, key):
        return True


def _external_track_input_name(track_id: str) -> str:
    return f"{_EXTERNAL_TRACK_PREFIX}{str(track_id).encode('utf-8').hex()}"


class PromptScheduler4A:
    NAME = "Prompt Scheduler (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config_json": (
                    "STRING",
                    {
                        "default": (
                            '{"start_index":0,"task_count":1,'
                            '"negative":"","tracks":[]}'
                        ),
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
                "execution_index": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0x7FFFFFFF},
                ),
                "run_id": (
                    "STRING",
                    {"default": "", "multiline": False, "dynamicPrompts": False},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF},
                ),
            },
            "optional": _FlexibleStringInputs(),
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "prompt_json")
    FUNCTION = "compose"
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Compact prompt columns. Paste folder wildcard syntax into a column and "
        "choose sequential or random selection for batch execution."
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # This node reflects a live prompt library, so cached text from a
        # previous queue must not be reused.
        return float("nan")

    def compose(
        self,
        config_json: str,
        execution_index: int,
        run_id: str,
        seed: int,
        unique_id: str | int | None = None,
        **external_inputs,
    ):
        config = scheduler.normalize_config(config_json)
        selection_seed = int(seed)
        acquired = False
        if run_id:
            resolver, selection_seed = scheduler.acquire_run(run_id, seed)
            acquired = True
        else:
            resolver = wc.snapshot_resolver()

        positive_parts: list[str] = []
        companion_negatives: list[str] = []
        resolved_tracks: list[dict[str, str]] = []
        try:
            for track in config["tracks"]:
                input_name = _external_track_input_name(track["id"])
                # External sockets override only this execution; never write back
                # into the scheduler UI / config_json.
                track_text = track["text"]
                if input_name in external_inputs:
                    incoming = external_inputs[input_name]
                    if incoming is not None:
                        track_text = (
                            incoming if isinstance(incoming, str) else str(incoming)
                        )
                if not track["enabled"]:
                    continue
                expanded = wc.expand_prompt(
                    track_text,
                    seed=selection_seed,
                    mode=track["mode"],
                    execution_index=execution_index,
                    track_id=track["id"],
                    resolver=resolver,
                )
                track_prompt = wc.cleanup_prompt_commas(expanded.text)
                if track_prompt.strip():
                    resolved_tracks.append(
                        {
                            "id": track["id"],
                            "name": track["name"],
                            "text": track_prompt,
                        }
                    )
                    positive_parts.append(track_prompt)
                for negative_index, selected_negative in enumerate(expanded.negatives):
                    negative_result = wc.expand_prompt(
                        selected_negative,
                        seed=selection_seed,
                        mode=track["mode"],
                        execution_index=execution_index,
                        track_id=f"{track['id']}:negative:{negative_index}",
                        resolver=resolver,
                    )
                    if negative_result.text.strip():
                        companion_negatives.append(negative_result.text)
                    companion_negatives.extend(negative_result.negatives)

            negative_input_name = _external_track_input_name("negative")
            negative_text = config["negative"]
            if negative_input_name in external_inputs:
                incoming = external_inputs[negative_input_name]
                if incoming is not None:
                    negative_text = (
                        incoming if isinstance(incoming, str) else str(incoming)
                    )
            fixed_negative_result = wc.expand_prompt(
                negative_text,
                seed=selection_seed,
                mode="random",
                execution_index=execution_index,
                track_id="fixed-negative",
                resolver=resolver,
            )
            positive = wc.join_positive_parts(*positive_parts)
            negative = wc.join_positive_parts(
                fixed_negative_result.text,
                *fixed_negative_result.negatives,
                *companion_negatives,
            )
            prompt_json = json.dumps(
                {
                    "scheduler_node_id": "" if unique_id is None else str(unique_id),
                    "tracks": resolved_tracks,
                    "positive": positive,
                    "negative": negative,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            return (positive, negative, prompt_json)
        finally:
            if acquired:
                scheduler.complete_run_task(run_id)
