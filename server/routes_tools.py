"""Wildcard conversion, scheduler, widget bridge, and model routes."""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import web

try:
    from ..domain.nai_to_anima import PromptSyntaxError, convert_prompt_tolerant
    from ..integrations.comfyui.model_resolver import resolve_lora, resolve_model
    from ..services import prompt_library as wc
    from ..services import scheduler
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from domain.nai_to_anima import (  # type: ignore
        PromptSyntaxError,
        convert_prompt_tolerant,
    )
    from integrations.comfyui.model_resolver import (  # type: ignore
        resolve_lora,
        resolve_model,
    )
    from services import prompt_library as wc  # type: ignore
    from services import scheduler  # type: ignore
    from support.i18n import tr  # type: ignore

from .http_common import _json_error


logger = logging.getLogger("ComfyUI4APromptManager")
NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)"
SLOT_WIDGETS = {
    "character": "character",
    "action": "action",
    "scene": "scene",
    "quality": "quality",
    "negative": "negative",
}


def _conversion_json(text: str) -> dict[str, Any]:
    result = convert_prompt_tolerant(text)
    return {
        "text": result.text,
        "repaired": result.repaired,
        "repair_count": len(result.added_closers),
        "added_closers": list(result.added_closers),
    }


async def handle_nai_to_anima(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    texts = data.get("texts")
    if texts is not None:
        if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
            return _json_error("texts must be a string array")
        if len(texts) > 100 or sum(len(text) for text in texts) > 2_000_000:
            return _json_error("too much prompt text", 413)
        try:
            results = [_conversion_json(text) for text in texts]
        except (PromptSyntaxError, ValueError) as exc:
            return _json_error(tr("NovelAI 权重转换失败：{error}", error=exc))
        return web.json_response({"success": True, "results": results})

    text = data.get("text")
    if not isinstance(text, str):
        return _json_error("text must be string")
    if len(text) > 2_000_000:
        return _json_error("too much prompt text", 413)
    try:
        result = _conversion_json(text)
    except (PromptSyntaxError, ValueError) as exc:
        return _json_error(tr("NovelAI 权重转换失败：{error}", error=exc))
    return web.json_response({"success": True, **result})


async def handle_scheduler_counts(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    try:
        if "config" in data:
            summary = scheduler.cycle_summary(data.get("config", {}))
            return web.json_response({"success": True, **summary})
        folders = data.get("folders", [])
        if not isinstance(folders, list) or not all(
            isinstance(item, str) for item in folders
        ):
            return _json_error("folders must be a string array")
        counts = scheduler.folder_counts(folders)
        return web.json_response({"success": True, "counts": counts})
    except Exception as exc:
        logger.exception("scheduler counts failed")
        return _json_error(tr("读取提示词文件夹失败：{error}", error=exc), 500)


async def handle_scheduler_prepare(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    try:
        prepared = scheduler.prepare_run(
            data.get("config", {}),
            data.get("task_count", 1),
            seed=data.get("seed", 0),
        )
        return web.json_response({"success": True, **prepared})
    except (ValueError, FileNotFoundError) as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("scheduler prepare failed")
        return _json_error(tr("准备批量运行失败：{error}", error=exc), 500)


async def handle_scheduler_lora_plan(request: web.Request) -> web.Response:
    """Preview LoRA append text for one or more execution indexes."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    try:
        config = data.get("config", {})
        plans = scheduler.plan_lora_appends(
            config,
            seed=data.get("seed", 0),
            start_index=data.get("execution_index", data.get("start_index", 0)),
            task_count=data.get("task_count", 1),
        )
        return web.json_response({"success": True, "lora_plans": plans})
    except (ValueError, FileNotFoundError) as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("scheduler lora plan failed")
        return _json_error(tr("预览 LoRA 计划失败：{error}", error=exc), 500)


async def handle_settings_apply(request: web.Request) -> web.Response:
    """Broadcast card settings apply (models / LoRA / parameters) to the canvas."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    apply = str(data.get("apply") or "").strip()
    if apply not in {"models", "lora", "parameters"}:
        return _json_error("apply must be models, lora, or parameters")

    key = data.get("key")
    models = data.get("models")
    lora = data.get("lora")
    parameters = data.get("parameters")
    double_sample = data.get("double_sample_parameters")

    if isinstance(key, str) and key.strip():
        entry = wc.get_entry(key)
        if not entry:
            return _json_error("not found", 404)
        if models is None:
            models = entry.get("models") or []
        if lora is None:
            lora = entry.get("lora") or {"text": "", "hashes": []}
        if parameters is None:
            parameters = entry.get("parameters") or {}
        if double_sample is None:
            double_sample = entry.get("double_sample_parameters") or {}

    if apply == "models":
        if not isinstance(models, list) or not models:
            return _json_error(tr("没有可应用的模型"))
    elif apply == "lora":
        text = ""
        if isinstance(lora, dict):
            text = str(lora.get("text") or "").strip()
        if not text:
            return _json_error(tr("没有可应用的 LoRA"))
    else:
        has_parameters = isinstance(parameters, dict) and bool(parameters)
        has_double = isinstance(double_sample, dict) and bool(double_sample)
        if not has_parameters and not has_double:
            return _json_error(tr("没有可应用的推理参数"))

    payload = {
        "apply": apply,
        "models": models if isinstance(models, list) else [],
        "loras": lora if isinstance(lora, dict) else {"text": "", "hashes": []},
        "parameters": parameters if isinstance(parameters, dict) else {},
        "double_sample_parameters": (
            double_sample if isinstance(double_sample, dict) else {}
        ),
    }

    try:
        from server import PromptServer  # ComfyUI runtime

        PromptServer.instance.send_sync("pm4a_settings_apply", payload)
    except Exception as exc:
        logger.exception("settings-apply send_sync failed")
        return _json_error(tr("发送失败：{error}", error=exc), 500)

    return web.json_response({"success": True, "apply": apply})


async def handle_append_slot(request: web.Request) -> web.Response:
    """Broadcast an append or replacement into a Prompt Scheduler slot."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    slot = data.get("slot")
    text = data.get("text")
    key = data.get("key")
    mode = data.get("mode", "append")
    node_ids = data.get("node_ids")  # optional

    if slot not in SLOT_WIDGETS:
        return _json_error(f"slot must be one of {list(SLOT_WIDGETS)}")
    if mode not in {"append", "replace"}:
        return _json_error("mode must be append or replace")
    if not isinstance(text, str) and isinstance(key, str) and key.strip():
        entry = wc.get_entry(key)
        if not entry:
            return _json_error("not found", 404)
        if slot == "negative":
            text = entry.get("negative", "")
        elif entry.get("type") == "folder" or entry.get("format") == "txt_wildcard":
            text = entry.get("wildcard_syntax") or f"__{entry.get('key', key)}__"
        else:
            text = entry.get("content", "")
        if not isinstance(text, str) or not text.strip():
            message = (
                tr("负面提示词为空，没有发送内容")
                if slot == "negative"
                else tr("提示词为空，没有发送内容")
            )
            return _json_error(message)
    if not isinstance(text, str):
        return _json_error("text or key required")
    if mode == "append" and not text.strip():
        return _json_error("text required")

    widget_name = SLOT_WIDGETS[slot]
    payload: dict[str, Any] = {
        "slot": slot,
        "widget_name": widget_name,
        "value": text.strip(),
        "mode": mode,
        "node_class": NODE_CLASS,
    }
    if isinstance(node_ids, list) and node_ids:
        payload["node_ids"] = node_ids

    try:
        from server import PromptServer  # ComfyUI runtime

        PromptServer.instance.send_sync("pm4a_widget_update", payload)
    except Exception as exc:
        logger.exception("append-slot send_sync failed")
        return _json_error(tr("发送失败：{error}", error=exc), 500)

    return web.json_response({"success": True, "payload": payload})


async def handle_model_resolve(request: web.Request) -> web.Response:
    """Resolve metadata model identity to a valid local loader combo value."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    widget_name = data.get("widget_name")
    name = data.get("name", "")
    hash_value = data.get("hash", "")
    model_version_id = data.get("model_version_id", "")
    if widget_name not in {"ckpt_name", "unet_name"}:
        return _json_error("widget_name must be ckpt_name or unet_name")
    if (
        not isinstance(name, str)
        or not isinstance(hash_value, str)
        or not isinstance(model_version_id, (str, int))
    ):
        return _json_error("name, hash and model_version_id must be strings or integers")
    try:
        result = resolve_model(widget_name, name, hash_value, model_version_id)
    except LookupError as exc:
        return _json_error(str(exc), 404)
    except Exception as exc:
        logger.exception("model resolve failed")
        return _json_error(tr("模型匹配失败：{error}", error=exc), 500)
    return web.json_response({"success": True, **result})


async def handle_lora_resolve(request: web.Request) -> web.Response:
    """Resolve LoRA identity to a local file (name first, then hash)."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    name = data.get("name", "")
    hash_value = data.get("hash", "")
    if not isinstance(name, str) or not isinstance(hash_value, str):
        return _json_error("name and hash must be strings")
    try:
        result = resolve_lora(name=name, hash_value=hash_value)
    except LookupError as exc:
        return _json_error(str(exc), 404)
    except Exception as exc:
        logger.exception("lora resolve failed")
        return _json_error(tr("LoRA 匹配失败：{error}", error=exc), 500)
    return web.json_response({"success": True, **result})
