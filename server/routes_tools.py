"""Wildcard conversion, scheduler, widget bridge, and model routes."""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from aiohttp import web

try:
    from ..domain.anima_to_nai import (
        MAX_OUTPUT_CHARS as MAX_CONVERSION_OUTPUT_CHARS,
        PromptOutputLimitError,
        PromptSyntaxError as AnimaPromptSyntaxError,
        convert_prompt as convert_anima_to_nai_prompt,
        convert_prompts as convert_anima_to_nai_prompts,
    )
    from ..domain.nai_to_anima import PromptSyntaxError, convert_prompt_tolerant
    from ..integrations.comfyui.model_resolver import resolve_lora, resolve_model
    from ..services import prompt_library as wc
    from ..services import scheduler
    from ..storage.prompt_documents import normalize_nai_payload
    from ..support.i18n import tr
except ImportError:  # standalone preview
    from domain.anima_to_nai import (  # type: ignore
        MAX_OUTPUT_CHARS as MAX_CONVERSION_OUTPUT_CHARS,
        PromptOutputLimitError,
        PromptSyntaxError as AnimaPromptSyntaxError,
        convert_prompt as convert_anima_to_nai_prompt,
        convert_prompts as convert_anima_to_nai_prompts,
    )
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
    from storage.prompt_documents import normalize_nai_payload  # type: ignore
    from support.i18n import tr  # type: ignore

from .http_common import _json_error


logger = logging.getLogger("ComfyUI4APromptManager")
NODE_CLASS = "Prompt Scheduler (4A Prompt Manager)"
NAI_SCHEDULER_NODE_CLASS = "NAI Prompt Scheduler (4A Prompt Manager)"
NAI_SAMPLER_NODE_CLASS = "NovelAI4ASampler"
MAX_NAI_EVENT_TEXT_CHARS = 2_000_000
MAX_NAI_EVENT_ITEMS = 100
MAX_NAI_EVENT_DEPTH = 32
MAX_NAI_EVENT_STRUCTURE_ITEMS = 10_000
MAX_NAI_NODE_ID_CHARS = 256
SLOT_WIDGETS = {
    "character": "character",
    "action": "action",
    "scene": "scene",
    "quality": "quality",
    "negative": "negative",
}


def _optional_nai_node_ids(data: dict[str, Any]) -> list[str | int] | None:
    if "node_ids" not in data:
        return None
    node_ids = data["node_ids"]
    if not isinstance(node_ids, list):
        raise ValueError("node_ids must be an array")
    if len(node_ids) > MAX_NAI_EVENT_ITEMS:
        raise OverflowError("too many node_ids")
    if any(
        isinstance(node_id, bool)
        or not isinstance(node_id, (str, int))
        or (isinstance(node_id, str) and not node_id.strip())
        for node_id in node_ids
    ):
        raise ValueError("node_ids must contain strings or integers")
    if any(
        isinstance(node_id, str) and len(node_id) > MAX_NAI_NODE_ID_CHARS
        for node_id in node_ids
    ):
        raise OverflowError("node_id is too long")
    return list(node_ids) or None


def _integer_serialized_length(value: int) -> int:
    try:
        return len(str(value))
    except ValueError:
        absolute = abs(value)
        if absolute == 0:
            return 1
        digits = int((absolute.bit_length() - 1) * 0.3010299956639812) + 1
        if absolute >= 10**digits:
            digits += 1
        return digits + (1 if value < 0 else 0)


def _scalar_serialized_length(value: Any) -> int:
    if isinstance(value, str):
        return len(json.dumps(value, ensure_ascii=False))
    if value is None:
        return 4
    if isinstance(value, bool):
        return 4 if value else 5
    if isinstance(value, int):
        return _integer_serialized_length(value)
    if isinstance(value, float):
        try:
            return len(json.dumps(value, allow_nan=False))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("event contains an invalid number") from exc
    raise ValueError("event contains a non-JSON value")


def _validate_nai_event_structure(value: Any) -> None:
    serialized_chars = 0
    structure_items = 0
    pending = [(value, 0)]

    def check_limits() -> None:
        if structure_items > MAX_NAI_EVENT_STRUCTURE_ITEMS:
            raise OverflowError("too many NAI event items")
        if serialized_chars > MAX_NAI_EVENT_TEXT_CHARS:
            raise OverflowError("NAI event is too large")

    while pending:
        current, depth = pending.pop()
        if depth > MAX_NAI_EVENT_DEPTH:
            raise OverflowError("NAI event nesting is too deep")
        if isinstance(current, dict):
            structure_items += len(current)
            check_limits()
            if not all(isinstance(key, str) for key in current):
                raise ValueError("event object keys must be strings")
            serialized_chars += 2 + max(0, len(current) - 1) + len(current)
            check_limits()
            for key, child in current.items():
                serialized_chars += _scalar_serialized_length(key)
                check_limits()
                pending.append((child, depth + 1))
        elif isinstance(current, list):
            structure_items += len(current)
            check_limits()
            serialized_chars += 2 + max(0, len(current) - 1)
            check_limits()
            pending.extend((child, depth + 1) for child in current)
        else:
            serialized_chars += _scalar_serialized_length(current)
            check_limits()


def _nai_event_payload_error(payload: dict[str, Any]) -> web.Response | None:
    try:
        _validate_nai_event_structure(payload)
    except OverflowError as exc:
        return _json_error(str(exc), 413)
    except (TypeError, ValueError) as exc:
        return _json_error(str(exc))
    return None


def _nai_target_payload(node_class: str) -> dict[str, str]:
    return {
        "node_class": node_class,
        "target_mode": "nai",
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


async def handle_anima_to_nai(request: web.Request) -> web.Response:
    """Convert Anima/ComfyUI prompt weights for NovelAI copy/send actions."""

    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("json body must be object")

    texts = data.get("texts")
    if texts is not None:
        if not isinstance(texts, list) or not all(
            isinstance(text, str) for text in texts
        ):
            return _json_error("texts must be a string array")
        if len(texts) > 100 or sum(len(text) for text in texts) > 2_000_000:
            return _json_error("too much prompt text", 413)
        try:
            converted = convert_anima_to_nai_prompts(
                texts,
                max_output_chars=MAX_CONVERSION_OUTPUT_CHARS,
            )
        except PromptOutputLimitError as exc:
            return _json_error(
                tr("Anima 权重转换结果过大：{error}", error=exc),
                413,
            )
        except (AnimaPromptSyntaxError, ValueError) as exc:
            return _json_error(tr("Anima 权重转换失败：{error}", error=exc))
        return web.json_response(
            {
                "success": True,
                "results": [{"text": text} for text in converted],
            }
        )

    text = data.get("text")
    if not isinstance(text, str):
        return _json_error("text must be string")
    if len(text) > 2_000_000:
        return _json_error("too much prompt text", 413)
    try:
        converted = convert_anima_to_nai_prompt(
            text,
            max_output_chars=MAX_CONVERSION_OUTPUT_CHARS,
        )
    except PromptOutputLimitError as exc:
        return _json_error(
            tr("Anima 权重转换结果过大：{error}", error=exc),
            413,
        )
    except (AnimaPromptSyntaxError, ValueError) as exc:
        return _json_error(tr("Anima 权重转换失败：{error}", error=exc))
    return web.json_response({"success": True, "text": converted})


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


async def handle_nai_append_slot(request: web.Request) -> web.Response:
    """Broadcast a Browser slot update only to NAI Prompt Scheduler nodes."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("json body must be object")

    slot = data.get("slot")
    value = data.get("value")
    mode = data.get("mode", "append")
    if not isinstance(slot, str):
        return _json_error("slot must be string")
    if slot not in SLOT_WIDGETS:
        return _json_error(f"slot must be one of {list(SLOT_WIDGETS)}")
    if not isinstance(value, str):
        return _json_error("value must be string")
    if len(value) > MAX_NAI_EVENT_TEXT_CHARS:
        return _json_error("too much prompt text", 413)
    if not isinstance(mode, str):
        return _json_error("mode must be string")
    if mode not in {"append", "replace"}:
        return _json_error("mode must be append or replace")
    try:
        node_ids = _optional_nai_node_ids(data)
    except OverflowError as exc:
        return _json_error(str(exc), 413)
    except ValueError as exc:
        return _json_error(str(exc))

    payload: dict[str, Any] = {
        "slot": slot,
        "widget_name": SLOT_WIDGETS[slot],
        "value": value,
        "mode": mode,
        **_nai_target_payload(NAI_SCHEDULER_NODE_CLASS),
    }
    if node_ids is not None:
        payload["node_ids"] = node_ids
    payload_error = _nai_event_payload_error(payload)
    if payload_error is not None:
        return payload_error

    try:
        from server import PromptServer  # ComfyUI runtime

        PromptServer.instance.send_sync("pm4a_nai_widget_update", payload)
    except Exception as exc:
        logger.exception("NAI append-slot send_sync failed")
        return _json_error(tr("发送失败：{error}", error=exc), 500)
    return web.json_response({"success": True, "payload": payload})


async def handle_nai_document_apply(request: web.Request) -> web.Response:
    """Broadcast one bounded raw NAI document as a replacement."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("json body must be object")

    document = data.get("document")
    if not isinstance(document, dict):
        return _json_error("document must be object")
    tracks = document.get("tracks")
    positive = document.get("positive")
    negative = document.get("negative")
    characters = document.get("characters")
    if not isinstance(tracks, list) or not all(
        isinstance(item, dict) for item in tracks
    ):
        return _json_error("document.tracks must be an object array")
    if not isinstance(positive, str):
        return _json_error("document.positive must be string")
    if not isinstance(negative, str):
        return _json_error("document.negative must be string")
    if not isinstance(characters, list) or not all(
        isinstance(item, dict) for item in characters
    ):
        return _json_error("document.characters must be an object array")
    if (
        len(tracks) > MAX_NAI_EVENT_ITEMS
        or len(characters) > MAX_NAI_EVENT_ITEMS
    ):
        return _json_error("too many NAI document items", 413)
    mode = data.get("mode", "replace")
    if not isinstance(mode, str):
        return _json_error("mode must be string")
    if mode != "replace":
        return _json_error("mode must be replace")
    try:
        node_ids = _optional_nai_node_ids(data)
    except OverflowError as exc:
        return _json_error(str(exc), 413)
    except ValueError as exc:
        return _json_error(str(exc))

    payload: dict[str, Any] = {
        "document": document,
        "mode": "replace",
        **_nai_target_payload(NAI_SCHEDULER_NODE_CLASS),
    }
    if node_ids is not None:
        payload["node_ids"] = node_ids
    payload_error = _nai_event_payload_error(payload)
    if payload_error is not None:
        return payload_error

    try:
        from server import PromptServer  # ComfyUI runtime

        PromptServer.instance.send_sync("pm4a_nai_document_update", payload)
    except Exception as exc:
        logger.exception("NAI document-apply send_sync failed")
        return _json_error(tr("发送失败：{error}", error=exc), 500)
    return web.json_response({"success": True, "payload": payload})


async def handle_nai_settings_apply(request: web.Request) -> web.Response:
    """Broadcast normalized NAI card settings and ratio hints to NAI Samplers."""
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("json body must be object")
    if "nai" not in data or not isinstance(data["nai"], dict):
        return _json_error("nai must be object")

    try:
        nai = normalize_nai_payload(data["nai"])
    except ValueError as exc:
        return _json_error(str(exc))
    if "resolution_mode" in data:
        if not isinstance(data["resolution_mode"], str):
            return _json_error("resolution_mode must be string")
        if data["resolution_mode"] != "ratio":
            return _json_error("resolution_mode must be ratio")
    source_resolution = None
    if "source_resolution" not in data:
        parameters = nai.get("parameters") if isinstance(nai.get("parameters"), dict) else {}
        raw_width = parameters.get("width")
        raw_height = parameters.get("height")
        if (
            isinstance(raw_width, (int, float))
            and isinstance(raw_height, (int, float))
            and not isinstance(raw_width, bool)
            and not isinstance(raw_height, bool)
            and raw_width > 0
            and raw_height > 0
        ):
            source_resolution = {
                "width": int(raw_width),
                "height": int(raw_height),
            }
    if "source_resolution" in data:
        raw_resolution = data["source_resolution"]
        if not isinstance(raw_resolution, dict):
            return _json_error("source_resolution must be object")
        if "width" not in raw_resolution or "height" not in raw_resolution:
            return _json_error("source_resolution requires width and height")
        source_resolution = {}
        for key in ("width", "height"):
            raw = raw_resolution[key]
            if isinstance(raw, bool):
                return _json_error(f"source_resolution.{key} must be positive number")
            try:
                number = float(raw)
            except (TypeError, ValueError, OverflowError):
                return _json_error(f"source_resolution.{key} must be positive number")
            if not math.isfinite(number) or number <= 0:
                return _json_error(f"source_resolution.{key} must be positive number")
            source_resolution[key] = int(number)
    try:
        node_ids = _optional_nai_node_ids(data)
        scheduler_node_ids = _optional_nai_node_ids(
            {
                "node_ids": data.get(
                    "scheduler_node_ids",
                    data.get("sampler_node_ids"),
                )
            }
            if "sampler_node_ids" in data or "scheduler_node_ids" in data
            else {}
        )
    except OverflowError as exc:
        return _json_error(str(exc), 413)
    except ValueError as exc:
        return _json_error(str(exc))

    payload: dict[str, Any] = {
        "nai": nai,
        **_nai_target_payload(NAI_SAMPLER_NODE_CLASS),
    }
    if node_ids is not None:
        payload["node_ids"] = node_ids
    payload_error = _nai_event_payload_error(payload)
    if payload_error is not None:
        return payload_error

    resolution_payload = None
    if source_resolution is not None:
        resolution_payload = {
            "source_resolution": source_resolution,
            "resolution_mode": "ratio",
            **_nai_target_payload(NAI_SCHEDULER_NODE_CLASS),
        }
        if scheduler_node_ids is not None:
            resolution_payload["node_ids"] = scheduler_node_ids
        payload_error = _nai_event_payload_error(resolution_payload)
        if payload_error is not None:
            return payload_error

    try:
        from server import PromptServer  # ComfyUI runtime

        PromptServer.instance.send_sync("pm4a_nai_settings_update", payload)
        if resolution_payload is not None:
            PromptServer.instance.send_sync(
                "pm4a_nai_resolution_update",
                resolution_payload,
            )
    except Exception as exc:
        logger.exception("NAI settings-apply send_sync failed")
        return _json_error(tr("发送失败：{error}", error=exc), 500)
    response: dict[str, Any] = {"success": True, "payload": payload}
    if resolution_payload is not None:
        response["resolution_payload"] = resolution_payload
    return web.json_response(response)


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
