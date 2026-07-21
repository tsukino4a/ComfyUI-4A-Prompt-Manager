"""Thin route registry and compatibility exports for the PM4A HTTP API."""

from __future__ import annotations

import logging

from aiohttp import web

try:
    from ..support.config import get_wildcards_path
except ImportError:  # standalone preview
    from support.config import get_wildcards_path  # type: ignore

from . import routes_browser as _browser
from .http_common import handle_operation_progress, localized_handler
from .routes_generation import (
    handle_generation_attach,
    handle_generation_batch_plan,
    handle_generation_config,
    handle_generation_config_update,
    handle_generation_discard,
    handle_generation_finalize,
    handle_generation_prepare,
    handle_generation_workflow,
    handle_generation_workflow_reset,
)
from .routes_library import (
    handle_create_entry,
    handle_create_folder,
    handle_entry,
    handle_export_prompts,
    handle_external_wildcards_import,
    handle_external_wildcards_preview,
    handle_external_wildcards_scan,
    handle_favorites,
    handle_image,
    handle_image_metadata,
    handle_import_preview,
    handle_import_prompts,
    handle_import_txt,
    handle_import_txt_preview,
    handle_list,
    handle_open_txt_entry,
    handle_operate_entries,
    handle_reload,
    handle_rename_folder,
    handle_tree,
    handle_update_entry,
    handle_update_favorites,
    handle_update_image,
)
from .routes_tools import (
    handle_append_slot,
    handle_model_resolve,
    handle_nai_to_anima,
    handle_scheduler_counts,
    handle_scheduler_prepare,
)


logger = logging.getLogger("ComfyUI4APromptManager")


_API_ROUTES = (
    ("GET", "/pm4a/api/tree", handle_tree),
    ("POST", "/pm4a/api/reload", handle_reload),
    ("GET", "/pm4a/api/list", handle_list),
    ("GET", "/pm4a/api/entry", handle_entry),
    ("POST", "/pm4a/api/entry", handle_update_entry),
    ("POST", "/pm4a/api/entry/open-txt", handle_open_txt_entry),
    ("POST", "/pm4a/api/entry/create", handle_create_entry),
    ("GET", "/pm4a/api/progress", handle_operation_progress),
    ("POST", "/pm4a/api/entries/operate", handle_operate_entries),
    ("GET", "/pm4a/api/prompts/export", handle_export_prompts),
    ("POST", "/pm4a/api/prompts/import/preview", handle_import_preview),
    (
        "POST",
        "/pm4a/api/prompts/import/external/scan",
        handle_external_wildcards_scan,
    ),
    (
        "POST",
        "/pm4a/api/prompts/import/external/preview",
        handle_external_wildcards_preview,
    ),
    (
        "POST",
        "/pm4a/api/prompts/import/external",
        handle_external_wildcards_import,
    ),
    ("POST", "/pm4a/api/prompts/import/txt/preview", handle_import_txt_preview),
    ("POST", "/pm4a/api/prompts/import/txt", handle_import_txt),
    ("POST", "/pm4a/api/prompts/import", handle_import_prompts),
    ("POST", "/pm4a/api/folder/create", handle_create_folder),
    ("POST", "/pm4a/api/folder/rename", handle_rename_folder),
    ("GET", "/pm4a/api/image", handle_image),
    ("POST", "/pm4a/api/image", handle_update_image),
    ("POST", "/pm4a/api/image/metadata", handle_image_metadata),
    ("GET", "/pm4a/api/favorites", handle_favorites),
    ("POST", "/pm4a/api/favorites", handle_update_favorites),
    ("POST", "/pm4a/api/convert/nai-to-anima", handle_nai_to_anima),
    ("POST", "/pm4a/api/scheduler/counts", handle_scheduler_counts),
    ("POST", "/pm4a/api/scheduler/prepare", handle_scheduler_prepare),
    ("POST", "/pm4a/api/append-slot", handle_append_slot),
    ("POST", "/pm4a/api/model/resolve", handle_model_resolve),
    ("GET", "/pm4a/api/generation/config", handle_generation_config),
    ("PUT", "/pm4a/api/generation/config", handle_generation_config_update),
    ("POST", "/pm4a/api/generation/workflow", handle_generation_workflow),
    (
        "POST",
        "/pm4a/api/generation/workflow/reset",
        handle_generation_workflow_reset,
    ),
    ("POST", "/pm4a/api/generation/prepare", handle_generation_prepare),
    ("POST", "/pm4a/api/generation/finalize", handle_generation_finalize),
    ("POST", "/pm4a/api/generation/attach", handle_generation_attach),
    ("POST", "/pm4a/api/generation/discard", handle_generation_discard),
    ("POST", "/pm4a/api/generation/batch/plan", handle_generation_batch_plan),
)


def register_routes(app: web.Application) -> None:
    """Attach page/API/static routes to any aiohttp Application."""
    _browser.add_static_route(app)
    app.router.add_get("/pm4a/wildcards", _browser.handle_index)
    for method, path, handler in _API_ROUTES:
        wrapped = localized_handler(handler)
        if method == "GET":
            app.router.add_get(path, wrapped)
        elif method == "POST":
            app.router.add_post(path, wrapped)
        elif method == "PUT":
            app.router.add_put(path, wrapped)
        else:  # pragma: no cover - the explicit table only uses the methods above
            app.router.add_route(method, path, wrapped)


def add_routes() -> None:
    """Register routes on ComfyUI PromptServer."""
    try:
        from server import PromptServer
    except ImportError:
        logger.warning("PromptServer not available; routes not registered")
        return

    register_routes(PromptServer.instance.app)
    logger.info(
        "4A Prompt Manager routes registered (wildcards=%s)", get_wildcards_path()
    )
