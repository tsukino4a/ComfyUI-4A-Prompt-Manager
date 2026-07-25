"""Metadata loader and read-only display for resolved prompts."""

from __future__ import annotations


class PromptDisplay4A:
    NAME = "Prompt Display (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "imported_json": (
                    "STRING",
                    {"default": "", "multiline": True, "dynamicPrompts": False},
                )
            },
            "optional": {
                "prompt_json": (
                    "STRING",
                    {"forceInput": True, "multiline": True, "dynamicPrompts": False},
                )
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "display"
    CATEGORY = "4A-Prompt-Manager"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Show prompt metadata from a dropped image, or from the optional "
        "prompt_json input for the current execution only (not a live stream)."
    )

    def display(self, imported_json: str = "", **kwargs):
        imported = (
            imported_json if isinstance(imported_json, str) else str(imported_json or "")
        )
        # Only treat as connected when the executor actually passed the input.
        connected = "prompt_json" in kwargs
        raw_wire = kwargs.get("prompt_json") if connected else None
        wire = (
            ""
            if not connected
            else (raw_wire if isinstance(raw_wire, str) else str(raw_wire or ""))
        )
        has_image = bool(imported.strip())
        source = "image" if has_image else "scheduler"
        value = imported if has_image else wire
        return {
            "ui": {
                "pm4a_prompt_json": [value],
                "pm4a_connected_prompt_json": [wire],
                "pm4a_prompt_connected": [connected],
                "pm4a_prompt_source": [source],
            },
            "result": (),
        }
