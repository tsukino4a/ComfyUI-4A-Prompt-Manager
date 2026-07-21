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
        "Loads prompt, inference and LoRA metadata from images, then displays "
        "the resolved columns as selectable read-only text."
    )

    def display(self, imported_json: str = "", prompt_json: str = ""):
        imported = imported_json if isinstance(imported_json, str) else str(imported_json or "")
        live = prompt_json if isinstance(prompt_json, str) else str(prompt_json or "")
        source = "image" if imported.strip() else "scheduler"
        value = imported if source == "image" else live
        return {
            "ui": {
                "pm4a_prompt_json": [value],
                "pm4a_live_prompt_json": [live],
                "pm4a_prompt_source": [source],
            },
            "result": (),
        }
