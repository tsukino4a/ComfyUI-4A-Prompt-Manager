"""UI-only node that auto-applies image metadata into the current workflow."""

from __future__ import annotations

import os

try:
    import folder_paths
except ImportError:  # standalone test collection
    folder_paths = None  # type: ignore


_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif",
}


def _input_image_files() -> list[str]:
    if folder_paths is None:
        return [""]
    input_dir = folder_paths.get_input_directory()
    if not os.path.isdir(input_dir):
        return [""]
    files = sorted(
        name
        for name in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, name))
        and os.path.splitext(name)[1].lower() in _IMAGE_EXTENSIONS
    )
    return files or [""]


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
                "image": (_input_image_files(), {"image_upload": True}),
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

    def show(
        self,
        image=None,
        **kwargs,
    ):
        return ()
