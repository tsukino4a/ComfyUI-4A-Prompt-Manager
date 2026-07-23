"""Frontend-driven bypass controller for connected workflow nodes."""

from __future__ import annotations


class BypassSwitch4A:
    NAME = "Bypass Switch (4A Prompt Manager)"

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("enabled",)
    FUNCTION = "get_enabled"
    CATEGORY = "4A-Prompt-Manager"
    DESCRIPTION = (
        "Controls Bypass/Always mode for nodes directly connected to its inputs. "
        "When enabled is false, connected nodes are set to Bypass; when true, Always. "
        "Useful for toggling a second-sample subgraph from Wildcard card settings."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enabled": ("BOOLEAN", {"default": False}),
            },
        }

    def get_enabled(self, enabled: bool):
        return (bool(enabled),)
