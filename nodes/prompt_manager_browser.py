"""UI-only canvas host for the 4A Prompt Manager web application."""

from __future__ import annotations


class PromptManagerBrowser4A:
    """Provide a workflow-persistent shell for the frontend iframe widget."""

    NAME = "Prompt Manager Browser (4A Prompt Manager)"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "show"
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Displays the existing 4A Prompt Manager web interface inside the "
        "ComfyUI canvas. This UI-only node does not participate in execution."
    )

    def show(self):
        return ()
