"""Image generation configuration, workflow, and preview routes."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from aiohttp import web

try:
    from ..services import generation
    from ..services import prompt_library as wc
    from ..support.config import PLUGIN_ROOT
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from services import generation  # type: ignore
    from services import prompt_library as wc  # type: ignore
    from support.config import PLUGIN_ROOT  # type: ignore
    from support.i18n import tr  # type: ignore

from .http_common import _json_error


logger = logging.getLogger("ComfyUI4APromptManager")
DEFAULT_GENERATION_WORKFLOW = PLUGIN_ROOT / "workflows" / "default_api.json"


def _generation_storage_dir(request: web.Request) -> Path:
    """Use the active ComfyUI user folder, with a standalone preview fallback."""
    try:
        import folder_paths
        from server import PromptServer

        manager = PromptServer.instance.user_manager
        user_id = manager.get_request_user_id(request)
        root = Path(folder_paths.get_user_directory())
        return root / user_id / "4A-Prompt-Manager" / "generation"
    except Exception:
        return PLUGIN_ROOT / ".pm4a" / "generation"


def _generation_paths(request: web.Request) -> tuple[Path, Path]:
    root = _generation_storage_dir(request)
    return root / "settings.json", root / "workflow_api.json"


def _comfy_generation_runtime() -> dict[str, Any]:
    """Read live Comfy node/model choices without making them import requirements."""
    try:
        import folder_paths
        import nodes as comfy_nodes

        class_mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS")
        available_classes = set(class_mappings)
        output_classes = {
            name
            for name, node_class in class_mappings.items()
            if bool(getattr(node_class, "OUTPUT_NODE", False))
        }
        try:
            import comfy.samplers

            sampler_options = list(comfy.samplers.KSampler.SAMPLERS)
            scheduler_options = list(comfy.samplers.KSampler.SCHEDULERS)
        except Exception:
            sampler_options = []
            scheduler_options = []
        return {
            "available": True,
            "available_classes": available_classes,
            "output_classes": output_classes,
            "folder_paths": folder_paths,
            "output_root": Path(folder_paths.get_output_directory()),
            "temp_root": Path(folder_paths.get_temp_directory()),
            "sampler_options": sampler_options,
            "scheduler_options": scheduler_options,
        }
    except Exception:
        preview_root = PLUGIN_ROOT / ".pm4a" / "preview-output"
        return {
            "available": False,
            "available_classes": None,
            "output_classes": set(),
            "folder_paths": None,
            "output_root": preview_root,
            "temp_root": preview_root / "temp",
            "sampler_options": ["euler"],
            "scheduler_options": ["normal"],
        }


def _filename_options(runtime: dict[str, Any], *categories: str) -> list[str]:
    folder_paths = runtime.get("folder_paths")
    if folder_paths is None:
        return []
    result: list[str] = []
    seen: set[str] = set()
    available = getattr(folder_paths, "folder_names_and_paths", {})
    for category in categories:
        if isinstance(available, dict) and category not in available:
            continue
        try:
            values = folder_paths.get_filename_list(category)
        except Exception:
            continue
        for value in values:
            text = str(value)
            normalized = text.replace("\\", "/").casefold()
            if normalized not in seen:
                seen.add(normalized)
                result.append(text)
    return sorted(result, key=str.casefold)


def _model_options(runtime: dict[str, Any], model_kind: str) -> list[str]:
    if model_kind == "checkpoint":
        return _filename_options(runtime, "checkpoints")
    return _filename_options(runtime, "diffusion_models", "unet")


def _clip_options(runtime: dict[str, Any]) -> list[str]:
    return _filename_options(runtime, "text_encoders", "clip")


def _vae_options(runtime: dict[str, Any]) -> list[str]:
    return _filename_options(runtime, "vae")


def _coerce_named_option(
    settings: dict[str, Any],
    key: str,
    options: list[str],
    analysis_default: object,
) -> None:
    if not options:
        return
    current = str(settings.get(key, "") or "")
    if current in options:
        return
    fallback = str(analysis_default or "")
    settings[key] = fallback if fallback in options else options[0]


def _read_saved_settings(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_generation_workflow(workflow_path: Path) -> tuple[dict[str, Any], str]:
    path = workflow_path if workflow_path.is_file() else DEFAULT_GENERATION_WORKFLOW
    return generation.read_json_file(path), "custom" if path == workflow_path else "default"


def _generation_context(request: web.Request, *, validate: bool = True) -> dict[str, Any]:
    settings_path, workflow_path = _generation_paths(request)
    runtime = _comfy_generation_runtime()
    workflow, source = _read_generation_workflow(workflow_path)
    analysis = generation.analyze_workflow(
        workflow,
        available_classes=runtime["available_classes"] if validate else None,
        output_classes=runtime["output_classes"],
    )
    models = _model_options(runtime, analysis.model_kind)
    clips = _clip_options(runtime) if analysis.clip is not None else []
    vaes = _vae_options(runtime) if analysis.vae is not None else []
    settings = generation.merged_settings(_read_saved_settings(settings_path), analysis)
    _coerce_named_option(settings, "model", models, analysis.defaults.get("model", ""))
    if analysis.clip is not None:
        _coerce_named_option(settings, "clip", clips, analysis.defaults.get("clip", ""))
    else:
        settings["clip"] = ""
    if analysis.vae is not None:
        _coerce_named_option(settings, "vae", vaes, analysis.defaults.get("vae", ""))
    else:
        settings["vae"] = ""
    settings = generation.validate_settings(
        settings,
        analysis,
        output_root=runtime["output_root"],
        model_options=models or None,
        clip_options=clips or None,
        vae_options=vaes or None,
        sampler_options=runtime["sampler_options"] or None,
        scheduler_options=runtime["scheduler_options"] or None,
    )
    return {
        "settings_path": settings_path,
        "workflow_path": workflow_path,
        "runtime": runtime,
        "workflow": workflow,
        "workflow_source": source,
        "analysis": analysis,
        "settings": settings,
        "model_options": models,
        "clip_options": clips,
        "vae_options": vaes,
    }


def _generation_config_payload(context: dict[str, Any]) -> dict[str, Any]:
    runtime = context["runtime"]
    return {
        "success": True,
        "comfy_available": runtime["available"],
        "settings": context["settings"],
        "workflow_source": context["workflow_source"],
        "analysis": context["analysis"].public(),
        "options": {
            "models": context["model_options"],
            "clips": context["clip_options"],
            "vaes": context["vae_options"],
            "samplers": runtime["sampler_options"],
            "schedulers": runtime["scheduler_options"],
        },
        "compression": {
            "format": "webp",
            "quality": generation.WEBP_QUALITY,
            "method": generation.WEBP_METHOD,
        },
    }


async def handle_generation_config(request: web.Request) -> web.Response:
    try:
        context = await asyncio.to_thread(_generation_context, request)
        return web.json_response(_generation_config_payload(context))
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation config load failed")
        return _json_error(tr("读取生图设置失败：{error}", error=str(exc)), 500)


async def handle_generation_config_update(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    try:
        context = await asyncio.to_thread(_generation_context, request)
        raw_settings = data.get("settings", data)
        settings = generation.validate_settings(
            raw_settings,
            context["analysis"],
            output_root=context["runtime"]["output_root"],
            model_options=context["model_options"] or None,
            clip_options=context["clip_options"] or None,
            vae_options=context["vae_options"] or None,
            sampler_options=context["runtime"]["sampler_options"] or None,
            scheduler_options=context["runtime"]["scheduler_options"] or None,
        )
        await asyncio.to_thread(
            generation.write_json_atomic, context["settings_path"], settings
        )
        context["settings"] = settings
        return web.json_response(_generation_config_payload(context))
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation config save failed")
        return _json_error(tr("保存生图设置失败：{error}", error=str(exc)), 500)


async def handle_generation_workflow(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    workflow = data.get("workflow")
    try:
        encoded = json.dumps(workflow, ensure_ascii=False).encode("utf-8")
        if len(encoded) > generation.MAX_WORKFLOW_BYTES:
            raise generation.GenerationConfigError(tr("api.json 不能超过 4 MB"))
        runtime = _comfy_generation_runtime()
        if not runtime["available"]:
            raise generation.GenerationConfigError(
                tr("请在运行中的 ComfyUI 内替换工作流")
            )
        analysis = generation.analyze_workflow(
            workflow,
            available_classes=runtime["available_classes"],
            output_classes=runtime["output_classes"],
        )
        settings_path, workflow_path = _generation_paths(request)
        models = _model_options(runtime, analysis.model_kind)
        clips = _clip_options(runtime) if analysis.clip is not None else []
        vaes = _vae_options(runtime) if analysis.vae is not None else []
        settings = generation.merged_settings(_read_saved_settings(settings_path), analysis)
        _coerce_named_option(settings, "model", models, analysis.defaults.get("model", ""))
        if analysis.clip is not None:
            _coerce_named_option(
                settings, "clip", clips, analysis.defaults.get("clip", "")
            )
        else:
            settings["clip"] = ""
        if analysis.vae is not None:
            _coerce_named_option(settings, "vae", vaes, analysis.defaults.get("vae", ""))
        else:
            settings["vae"] = ""
        settings = generation.validate_settings(
            settings,
            analysis,
            output_root=runtime["output_root"],
            model_options=models or None,
            clip_options=clips or None,
            vae_options=vaes or None,
            sampler_options=runtime["sampler_options"] or None,
            scheduler_options=runtime["scheduler_options"] or None,
        )
        await asyncio.to_thread(generation.write_json_atomic, workflow_path, workflow)
        await asyncio.to_thread(generation.write_json_atomic, settings_path, settings)
        context = _generation_context(request)
        return web.json_response(_generation_config_payload(context))
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation workflow save failed")
        return _json_error(tr("替换工作流失败：{error}", error=str(exc)), 500)


async def handle_generation_workflow_reset(request: web.Request) -> web.Response:
    _settings_path, workflow_path = _generation_paths(request)
    try:
        workflow_path.unlink(missing_ok=True)
        context = await asyncio.to_thread(_generation_context, request)
        return web.json_response(_generation_config_payload(context))
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation workflow reset failed")
        return _json_error(tr("恢复默认工作流失败：{error}", error=str(exc)), 500)


async def handle_generation_prepare(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    positive = data.get("positive", "")
    negative = data.get("negative", "")
    apply_fixed_prompts = data.get("apply_fixed_prompts", True)
    if not isinstance(apply_fixed_prompts, bool):
        return _json_error("apply_fixed_prompts must be boolean")
    try:
        context = await asyncio.to_thread(_generation_context, request)
        if not context["runtime"]["available"]:
            raise generation.GenerationConfigError(
                tr("图片生成只能在运行中的 ComfyUI 内使用")
            )
        if not context["settings"].get("model"):
            raise generation.GenerationConfigError(tr("请先在生图设置中选择模型"))
        prepared = generation.prepare_workflow(
            context["workflow"],
            context["analysis"],
            context["settings"],
            positive,
            negative,
            apply_fixed_prompts=apply_fixed_prompts,
        )
        return web.json_response({"success": True, **prepared})
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation prepare failed")
        return _json_error(tr("准备工作流失败：{error}", error=str(exc)), 500)


async def handle_generation_finalize(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    locator = data.get("locator")
    metadata = data.get("metadata")
    title = data.get("title", "PM4A")
    key = data.get("key", "")
    if not isinstance(locator, dict) or not isinstance(metadata, dict):
        return _json_error("locator and metadata must be objects")
    if not isinstance(title, str) or not isinstance(key, str):
        return _json_error("title and key must be strings")
    try:
        if key and not await asyncio.to_thread(wc.entry_supports, key, "generation"):
            raise ValueError(tr("Wildcard 卡片不能生成示例图"))
        context = await asyncio.to_thread(_generation_context, request)
        finalized = await asyncio.to_thread(
            generation.finalize_image,
            locator,
            metadata,
            title=title,
            output_root=context["runtime"]["output_root"],
            temp_root=context["runtime"]["temp_root"],
        )
        entry = None
        if key:
            try:
                entry = await asyncio.to_thread(
                    wc.update_entry_image, key, finalized["bytes"]
                )
            except Exception as exc:
                logger.exception("generation preview sidecar save failed")
                return web.json_response(
                    {
                        "success": False,
                        "error": tr(
                            "保存提示词示例图失败：{error}；预览图已保留，可重试挂接",
                            error=str(exc),
                        ),
                        "locator": finalized["locator"],
                        "quality": finalized["quality"],
                    },
                    status=500,
                )
            await asyncio.to_thread(
                generation.discard_pending_preview,
                finalized["locator"],
                temp_root=context["runtime"]["temp_root"],
            )
        return web.json_response(
            {
                "success": True,
                "locator": None if key else finalized["locator"],
                "quality": finalized["quality"],
                "entry": entry,
            }
        )
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation finalize failed")
        return _json_error(tr("保存生成图片失败：{error}", error=str(exc)), 500)


async def handle_generation_attach(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    locator = data.get("locator")
    key = data.get("key")
    if not isinstance(locator, dict) or not isinstance(key, str) or not key.strip():
        return _json_error("locator and key are required")
    try:
        if not await asyncio.to_thread(wc.entry_supports, key, "generation"):
            raise ValueError(tr("Wildcard 卡片不能生成示例图"))
        runtime = _comfy_generation_runtime()
        entry = await asyncio.to_thread(
            generation.attach_preview_image,
            locator,
            temp_root=runtime["temp_root"],
            update_image=wc.update_entry_image,
            key=key,
        )
        return web.json_response({"success": True, "entry": entry})
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except (generation.GenerationConfigError, ValueError) as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation attach failed")
        return _json_error(tr("挂接生成图片失败：{error}", error=str(exc)), 500)


async def handle_generation_discard(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    locator = data.get("locator")
    if not isinstance(locator, dict):
        return _json_error("locator is required")
    try:
        runtime = _comfy_generation_runtime()
        removed = await asyncio.to_thread(
            generation.discard_pending_preview,
            locator,
            temp_root=runtime["temp_root"],
        )
        return web.json_response({"success": True, "removed": removed})
    except generation.GenerationConfigError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation preview discard failed")
        return _json_error(tr("清理临时预览图失败：{error}", error=str(exc)), 500)


async def handle_generation_batch_plan(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    folder = data.get("folder", "")
    mode = data.get("mode", "missing")
    recursive = data.get("recursive", True)
    if not isinstance(folder, str) or mode not in {"missing", "all"} or not isinstance(recursive, bool):
        return _json_error("folder, mode or recursive is invalid")
    try:
        keys: list[str] = []
        scanned_count = 0
        skipped_wildcard_count = 0
        skipped_existing_preview_count = 0
        offset = 0
        while True:
            items, total = wc.list_entries(
                prefix=folder,
                limit=500,
                offset=offset,
                immediate_only=not recursive,
                sort_by="path:asc",
            )
            for item in items:
                key = item["key"]
                if not folder and not recursive and "/" in key:
                    continue
                scanned_count += 1
                if not item.get("capabilities", {}).get("generation", False):
                    skipped_wildcard_count += 1
                    continue
                if mode == "missing" and item.get("has_image"):
                    skipped_existing_preview_count += 1
                    continue
                keys.append(key)
                if len(keys) > 20_000:
                    raise ValueError(tr("单次批量生成不能超过 20000 条提示词"))
            offset += len(items)
            if offset >= total or not items:
                break
        return web.json_response(
            {
                "success": True,
                "folder": folder,
                "mode": mode,
                "recursive": recursive,
                "scanned_count": scanned_count,
                "count": len(keys),
                "generatable_count": len(keys),
                "skipped_wildcard_count": skipped_wildcard_count,
                "skipped_existing_preview_count": skipped_existing_preview_count,
                "keys": keys,
            }
        )
    except (FileNotFoundError, ValueError) as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("generation batch plan failed")
        return _json_error(tr("读取批量生图范围失败：{error}", error=str(exc)), 500)
