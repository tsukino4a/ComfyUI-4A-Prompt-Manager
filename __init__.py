"""
@author: 4A
@title: ComfyUI-4A-Prompt-Manager
@nickname: 4A Prompt Manager
@description: Folder-backed prompt scheduler with wildcard browser and Web prompt injection.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger("ComfyUI4APromptManager")

try:
    from .nodes.prompt_scheduler import PromptScheduler4A
    from .nodes.prompt_display import PromptDisplay4A
    from .nodes.meta_apply import MetaApply4A
    from .nodes.input_parameters import InputParameters4A
    from .nodes.double_sample_parameters import DoubleSampleParameters4A
    from .nodes.image_saver import ImageSaver4A
    from .nodes.prompt_manager_browser import PromptManagerBrowser4A
    from .server.routes import add_routes
except ImportError:  # standalone test collection
    from nodes.prompt_scheduler import PromptScheduler4A  # type: ignore
    from nodes.prompt_display import PromptDisplay4A  # type: ignore
    from nodes.meta_apply import MetaApply4A  # type: ignore
    from nodes.input_parameters import InputParameters4A  # type: ignore
    from nodes.double_sample_parameters import DoubleSampleParameters4A  # type: ignore
    from nodes.image_saver import ImageSaver4A  # type: ignore
    from nodes.prompt_manager_browser import PromptManagerBrowser4A  # type: ignore
    from server.routes import add_routes  # type: ignore

NODE_CLASS_MAPPINGS = {
    PromptScheduler4A.NAME: PromptScheduler4A,
    PromptDisplay4A.NAME: PromptDisplay4A,
    MetaApply4A.NAME: MetaApply4A,
    InputParameters4A.NAME: InputParameters4A,
    DoubleSampleParameters4A.NAME: DoubleSampleParameters4A,
    ImageSaver4A.NAME: ImageSaver4A,
    PromptManagerBrowser4A.NAME: PromptManagerBrowser4A,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    PromptScheduler4A.NAME: "Prompt Scheduler (4A Prompt Manager)",
    PromptDisplay4A.NAME: "Meta Loader (4A Prompt Manager)",
    MetaApply4A.NAME: "Meta Apply (4A Prompt Manager)",
    InputParameters4A.NAME: "Input Parameters (4A Prompt Manager)",
    DoubleSampleParameters4A.NAME: "Double Sample Parameters (4A Prompt Manager)",
    ImageSaver4A.NAME: "Image Saver (4A Prompt Manager)",
    PromptManagerBrowser4A.NAME: "Prompt Manager Browser (4A Prompt Manager)",
}

WEB_DIRECTORY = "./web/comfyui"


def _load_wildcards_async() -> None:
    try:
        from .services import prompt_library as wc

        wc.reload()
    except Exception:
        logger.exception("Failed to load wildcards")


try:
    add_routes()
except Exception:
    logger.exception("Failed to register 4A Prompt Manager routes")

threading.Thread(target=_load_wildcards_async, daemon=True).start()

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
