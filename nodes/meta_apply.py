"""UI-only node that auto-applies image metadata into the current workflow."""

from __future__ import annotations


class MetaApply4A:
    NAME = "Meta Apply (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls):
        yes_no = {"default": True, "label_on": "yes", "label_off": "no"}
        return {
            "required": {
                # Display names are the input keys so labels show even if i18n cache is stale.
                "自动应用模型": ("BOOLEAN", {**yes_no}),
                "自动应用 LoRA": ("BOOLEAN", {**yes_no}),
                "自动应用推理参数": ("BOOLEAN", {**yes_no}),
                "自动应用提示词": ("BOOLEAN", {**yes_no}),
                # Hidden filename slot: keeps old workflow widget order and restore.
                "image": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Drop or pick an image to automatically apply detected metadata. "
        "Use the top toggles to enable model, LoRA, inference parameters, "
        "and prompt application independently."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    def show(self, **_kwargs):
        return ()
