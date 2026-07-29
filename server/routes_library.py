"""Prompt library, folders, import/export, images, and favorites routes."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
from io import BytesIO

from aiohttp import web

try:
    from ..integrations.comfyui.external_wildcards import (
        resolve_external_wildcard_files,
        scan_external_wildcards,
    )
    from ..services import prompt_library as wc
    from ..support.i18n import get_locale, tr
    from ..support.image_metadata import extract_image_metadata
except ImportError:  # standalone preview
    from integrations.comfyui.external_wildcards import (  # type: ignore
        resolve_external_wildcard_files,
        scan_external_wildcards,
    )
    from services import prompt_library as wc  # type: ignore
    from support.i18n import get_locale, tr  # type: ignore
    from support.image_metadata import extract_image_metadata  # type: ignore

from .http_common import (
    _begin_progress,
    _finish_progress,
    _json_error,
    _key_from_request,
    _validated_progress_id,
)


logger = logging.getLogger("ComfyUI4APromptManager")
MAX_PREVIEW_IMAGE_BYTES = 32 * 1024 * 1024


async def handle_reload(_request: web.Request) -> web.Response:
    try:
        # Fingerprint check first; only reread card bodies that changed.
        await asyncio.to_thread(wc.reload, force=False)
        return web.json_response({"success": True, **wc.list_sources_and_tree()})
    except Exception as exc:
        logger.exception("reload failed")
        return _json_error(tr("刷新提示词库失败：{error}", error=exc), 500)


async def handle_models_align_preview(_request: web.Request) -> web.Response:
    try:
        payload = await asyncio.to_thread(wc.preview_local_model_alignments)
        return web.json_response({"success": True, **payload})
    except Exception as exc:
        logger.exception("model align preview failed")
        return _json_error(tr("扫描本地模型对齐失败：{error}", error=exc), 500)


async def handle_models_align_apply(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        return _json_error("invalid json")
    keys = data.get("keys")
    if keys is not None and not isinstance(keys, list):
        return _json_error("keys must be an array")
    try:
        progress_id = _validated_progress_id(data.get("progress_id", ""))
    except ValueError as exc:
        return _json_error(str(exc))
    progress_callback = _begin_progress(progress_id)
    try:
        payload = await asyncio.to_thread(
            wc.apply_local_model_alignments,
            keys,
            progress_callback,
        )
    except Exception as exc:
        message = tr("写回本地模型对齐失败：{error}", error=exc)
        _finish_progress(progress_id, message)
        logger.exception("model align apply failed")
        return _json_error(message, 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **payload})


async def handle_list(request: web.Request) -> web.Response:
    try:
        prefix = request.rel_url.query.get("prefix", "")
        search = request.rel_url.query.get("search", "")
        sort_by = request.rel_url.query.get("sort", "path:asc")
        if sort_by not in wc.LIST_SORT_MODES:
            return _json_error("invalid sort mode")
        # Default: all files under folder (library is deeply nested).
        # Pass immediate=1 to restrict to direct children only, including search.
        immediate = request.rel_url.query.get("immediate", "0") == "1"
        favorites_only = request.rel_url.query.get("favorites", "0") == "1"
        try:
            limit = max(1, min(500, int(request.rel_url.query.get("limit", "100"))))
            offset = max(0, int(request.rel_url.query.get("offset", "0")))
        except ValueError:
            return _json_error("invalid limit/offset")

        items, total = wc.list_entries(
            prefix=prefix,
            search=search,
            limit=limit,
            offset=offset,
            immediate_only=immediate,
            sort_by=sort_by,
            favorites_only=favorites_only,
        )
        return web.json_response(
            {
                "success": True,
                "items": items,
                "total": total,
                "limit": limit,
                "offset": offset,
                "prefix": prefix,
                "sort": sort_by,
            }
        )
    except Exception as exc:
        logger.exception("list failed")
        return _json_error(tr("读取提示词列表失败：{error}", error=exc), 500)


async def handle_tree(_request: web.Request) -> web.Response:
    try:
        return web.json_response({"success": True, **wc.build_folder_tree()})
    except Exception as exc:
        logger.exception("tree failed")
        return _json_error(tr("读取提示词树失败：{error}", error=exc), 500)


async def handle_entry(request: web.Request) -> web.Response:
    key = _key_from_request(request)
    if not key:
        return _json_error("missing key")
    entry = wc.get_entry(key)
    if not entry:
        return _json_error("not found", 404)
    return web.json_response({"success": True, "entry": entry})


async def handle_open_txt_entry(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("invalid json")
    key = data.get("key")
    action = data.get("action")
    if not isinstance(key, str) or not isinstance(action, str):
        return _json_error("key and action must be strings")
    try:
        await asyncio.to_thread(wc.open_txt_entry, key, action)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("open TXT wildcard failed")
        return _json_error(tr("打开传统 TXT Wildcard 失败：{error}", error=exc), 500)
    return web.json_response({"success": True})


async def handle_update_entry(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    key = data.get("key")
    if not isinstance(key, str) or not key.strip():
        return _json_error("missing key")

    name = data.get("name") if "name" in data else None
    content = data.get("content") if "content" in data else None
    negative = data.get("negative") if "negative" in data else None
    note = data.get("note") if "note" in data else None
    lora = data.get("lora") if "lora" in data else None
    models = data.get("models") if "models" in data else None
    parameters = data.get("parameters") if "parameters" in data else None
    double_sample_parameters = (
        data.get("double_sample_parameters")
        if "double_sample_parameters" in data
        else None
    )
    if name is not None and not isinstance(name, str):
        return _json_error("name must be string")
    if content is not None and not isinstance(content, str):
        return _json_error("content must be string")
    if negative is not None and not isinstance(negative, str):
        return _json_error("negative must be string")
    if note is not None and not isinstance(note, str):
        return _json_error("note must be string")
    if lora is not None and not isinstance(lora, dict):
        return _json_error("lora must be object")
    if models is not None and not isinstance(models, list):
        return _json_error("models must be array")
    if parameters is not None and not isinstance(parameters, dict):
        return _json_error("parameters must be object")
    if double_sample_parameters is not None and not isinstance(
        double_sample_parameters, dict
    ):
        return _json_error("double_sample_parameters must be object")

    try:
        entry = await asyncio.to_thread(
            wc.update_entry,
            key,
            name=name,
            content=content,
            negative=negative,
            note=note,
            lora=lora,
            models=models,
            parameters=parameters,
            double_sample_parameters=double_sample_parameters,
        )
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except FileExistsError as exc:
        return _json_error(str(exc), 409)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("entry update failed")
        return _json_error(tr("保存失败：{error}", error=exc), 500)

    return web.json_response(
        {"success": True, "old_key": wc.normalize_key(key), "entry": entry}
    )


async def handle_create_entry(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    folder = data.get("folder", "")
    name = data.get("name")
    content = data.get("content")
    negative = data.get("negative", "")
    note = data.get("note", "")
    lora = data.get("lora", None)
    models = data.get("models", None)
    parameters = data.get("parameters", None)
    double_sample_parameters = data.get("double_sample_parameters", None)
    if not all(isinstance(value, str) for value in (folder, name, content, negative, note)):
        return _json_error("folder, name, content, negative and note must be strings")
    if lora is not None and not isinstance(lora, dict):
        return _json_error("lora must be object")
    if models is not None and not isinstance(models, list):
        return _json_error("models must be array")
    if parameters is not None and not isinstance(parameters, dict):
        return _json_error("parameters must be object")
    if double_sample_parameters is not None and not isinstance(
        double_sample_parameters, dict
    ):
        return _json_error("double_sample_parameters must be object")

    try:
        entry = await asyncio.to_thread(
            wc.create_entry,
            folder,
            name,
            content,
            negative=negative,
            note=note,
            lora=lora,
            models=models,
            parameters=parameters,
            double_sample_parameters=double_sample_parameters,
        )
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except FileExistsError as exc:
        return _json_error(str(exc), 409)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("entry create failed")
        return _json_error(tr("创建失败：{error}", error=exc), 500)
    return web.json_response({"success": True, "entry": entry})


async def handle_create_folder(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    parent = data.get("parent", "")
    name = data.get("name")
    if not isinstance(parent, str) or not isinstance(name, str):
        return _json_error("parent and name must be strings")
    try:
        folder = await asyncio.to_thread(wc.create_folder, parent, name)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except FileExistsError as exc:
        return _json_error(str(exc), 409)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("folder create failed")
        return _json_error(tr("创建文件夹失败：{error}", error=exc), 500)
    return web.json_response({"success": True, "folder": folder})


async def handle_rename_folder(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    folder = data.get("folder")
    name = data.get("name")
    if not isinstance(folder, str) or not isinstance(name, str):
        return _json_error("folder and name must be strings")
    try:
        result = await asyncio.to_thread(wc.rename_folder, folder, name)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except FileExistsError as exc:
        return _json_error(str(exc), 409)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("folder rename failed")
        return _json_error(tr("重命名文件夹失败：{error}", error=exc), 500)
    return web.json_response(
        {"success": True, "folder": result, "favorites": wc.get_favorites()}
    )


async def handle_operate_entries(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    action = data.get("action")
    items = data.get("items")
    destination = data.get("destination", "")
    if action not in {"delete", "copy", "move"}:
        return _json_error("action must be delete, copy, or move")
    if not isinstance(items, list) or not items or len(items) > 500:
        return _json_error("items must contain 1 to 500 entries")
    if not all(isinstance(item, dict) for item in items):
        return _json_error("items must be objects")
    if not isinstance(destination, str):
        return _json_error("destination must be string")
    try:
        progress_id = _validated_progress_id(data.get("progress_id"))
    except ValueError as exc:
        return _json_error(str(exc))
    progress_callback = _begin_progress(progress_id)
    try:
        result = await asyncio.to_thread(
            wc.operate_items,
            action,
            items,
            destination,
            progress_callback,
        )
    except FileNotFoundError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404)
    except FileExistsError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 409)
    except ValueError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc))
    except Exception as exc:
        _finish_progress(progress_id, tr("操作失败：{error}", error=exc))
        logger.exception("entry operation failed")
        return _json_error(tr("操作失败：{error}", error=exc), 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def handle_export_prompts(request: web.Request) -> web.Response:
    folder = request.rel_url.query.get("folder", "")
    try:
        progress_id = _validated_progress_id(
            request.rel_url.query.get("progress_id", "")
        )
    except ValueError as exc:
        return _json_error(str(exc))
    progress_callback = _begin_progress(progress_id)
    try:
        bundle = await asyncio.to_thread(
            wc.export_prompt_bundle, folder, progress_callback
        )
    except FileNotFoundError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404)
    except ValueError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc))
    except Exception as exc:
        _finish_progress(progress_id, tr("导出失败：{error}", error=exc))
        logger.exception("prompt export failed")
        return _json_error(tr("导出失败：{error}", error=exc), 500)

    _finish_progress(progress_id)
    source_name = str(bundle.get("source_folder") or "全部提示词").rsplit("/", 1)[-1]
    safe_name = "".join(
        character if character not in '<>:"/\\|?*' else "-"
        for character in source_name
    ).strip(" .") or "全部提示词"
    filename_suffix = "PM4A-Prompts" if get_locale() == "en" else "PM4A提示词"
    return web.json_response(
        {
            "success": True,
            "bundle": bundle,
            "filename": f"{safe_name}-{filename_suffix}.json",
        }
    )


async def handle_external_wildcards_scan(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("invalid json")
    try:
        progress_id = _validated_progress_id(data.get("progress_id"))
    except ValueError as exc:
        return _json_error(str(exc))

    progress_callback = _begin_progress(progress_id)
    try:
        result = await asyncio.to_thread(
            scan_external_wildcards,
            progress_callback=progress_callback,
        )
    except FileNotFoundError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404)
    except Exception as exc:
        message = tr("检测其他节点 Wildcards 失败：{error}", error=exc)
        _finish_progress(progress_id, message)
        logger.exception("external wildcard scan failed")
        return _json_error(message, 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def _read_txt_pool_request(
    request: web.Request,
) -> tuple[str, str, str, str | None] | web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("invalid json")
    folder = data.get("folder", "")
    name = data.get("name", "")
    content = data.get("content", "")
    if not all(isinstance(value, str) for value in (folder, name, content)):
        return _json_error("folder, name and content must be strings")
    try:
        progress_id = _validated_progress_id(data.get("progress_id"))
    except ValueError as exc:
        return _json_error(str(exc))
    return folder, name, content, progress_id


async def handle_import_txt_preview(request: web.Request) -> web.Response:
    parsed = await _read_txt_pool_request(request)
    if isinstance(parsed, web.Response):
        return parsed
    folder, name, content, progress_id = parsed
    try:
        result = await asyncio.to_thread(
            wc.preview_txt_wildcard_import, folder, name, content
        )
    except (FileNotFoundError, ValueError) as exc:
        return _json_error(str(exc), 404 if isinstance(exc, FileNotFoundError) else 400)
    except Exception as exc:
        logger.exception("TXT wildcard import preview failed")
        return _json_error(tr("解析失败：{error}", error=exc), 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def handle_import_txt(request: web.Request) -> web.Response:
    parsed = await _read_txt_pool_request(request)
    if isinstance(parsed, web.Response):
        return parsed
    folder, name, content, progress_id = parsed
    progress_callback = _begin_progress(progress_id)
    try:
        result = await asyncio.to_thread(
            wc.import_txt_wildcard, folder, name, content, progress_callback
        )
    except (FileNotFoundError, ValueError) as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404 if isinstance(exc, FileNotFoundError) else 400)
    except Exception as exc:
        message = tr("导入失败：{error}", error=exc)
        _finish_progress(progress_id, message)
        logger.exception("TXT wildcard import failed")
        return _json_error(message, 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def _read_external_import_request(
    request: web.Request,
) -> tuple[str, list[str], str | None] | web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    if not isinstance(data, dict):
        return _json_error("invalid json")
    folder = data.get("folder", "")
    file_ids = data.get("file_ids")
    if not isinstance(folder, str) or not isinstance(file_ids, list):
        return _json_error("folder must be string and file_ids must be an array")
    try:
        progress_id = _validated_progress_id(data.get("progress_id"))
    except ValueError as exc:
        return _json_error(str(exc))
    return folder, file_ids, progress_id


async def _handle_external_import(
    request: web.Request,
    *,
    preview: bool,
) -> web.Response:
    parsed = await _read_external_import_request(request)
    if isinstance(parsed, web.Response):
        return parsed
    folder, file_ids, progress_id = parsed
    progress_callback = _begin_progress(progress_id)
    try:
        files = await asyncio.to_thread(resolve_external_wildcard_files, file_ids)
        function = (
            wc.preview_external_txt_import
            if preview
            else wc.import_external_txt_files
        )
        arguments = (folder, files) if preview else (folder, files, progress_callback)
        result = await asyncio.to_thread(function, *arguments)
    except (FileNotFoundError, ValueError) as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404 if isinstance(exc, FileNotFoundError) else 400)
    except Exception as exc:
        message = tr("导入失败：{error}", error=exc)
        _finish_progress(progress_id, message)
        logger.exception("external TXT wildcard import failed")
        return _json_error(message, 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def handle_external_wildcards_preview(request: web.Request) -> web.Response:
    return await _handle_external_import(request, preview=True)


async def handle_external_wildcards_import(request: web.Request) -> web.Response:
    return await _handle_external_import(request, preview=False)


async def _read_bulk_import_request(
    request: web.Request,
) -> tuple[str, str, list, str | None] | web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")
    folder = data.get("folder", "")
    source_type = data.get("source_type")
    prompts = data.get("prompts")
    if not isinstance(folder, str):
        return _json_error("folder must be string")
    if source_type not in {"txt", "json"}:
        return _json_error("source_type must be txt or json")
    if not isinstance(prompts, list):
        return _json_error("prompts must be an array")
    try:
        progress_id = _validated_progress_id(data.get("progress_id"))
    except ValueError as exc:
        return _json_error(str(exc))
    return folder, source_type, prompts, progress_id


async def handle_import_preview(request: web.Request) -> web.Response:
    parsed = await _read_bulk_import_request(request)
    if isinstance(parsed, web.Response):
        return parsed
    folder, source_type, prompts, progress_id = parsed
    progress_callback = _begin_progress(progress_id)
    try:
        result = await asyncio.to_thread(
            wc.preview_bulk_import,
            folder,
            prompts,
            source_type,
            progress_callback,
        )
    except FileNotFoundError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404)
    except ValueError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc))
    except Exception as exc:
        _finish_progress(progress_id, tr("解析失败：{error}", error=exc))
        logger.exception("prompt import preview failed")
        return _json_error(tr("解析失败：{error}", error=exc), 500)
    _finish_progress(progress_id)
    return web.json_response({"success": True, **result})


async def handle_import_prompts(request: web.Request) -> web.Response:
    parsed = await _read_bulk_import_request(request)
    if isinstance(parsed, web.Response):
        return parsed
    folder, source_type, prompts, progress_id = parsed
    progress_callback = _begin_progress(progress_id)
    try:
        result = await asyncio.to_thread(
            wc.import_prompt_bundle,
            folder,
            prompts,
            source_type,
            progress_callback,
        )
    except FileNotFoundError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc), 404)
    except ValueError as exc:
        _finish_progress(progress_id, str(exc))
        return _json_error(str(exc))
    except Exception as exc:
        _finish_progress(progress_id, tr("导入失败：{error}", error=exc))
        logger.exception("prompt import failed")
        return _json_error(tr("导入失败：{error}", error=exc), 500)
    _finish_progress(progress_id)
    return web.json_response(
        {"success": True, **result, "favorites": wc.get_favorites()}
    )


async def handle_image(request: web.Request) -> web.Response:
    key = _key_from_request(request)
    if not key:
        return _json_error("missing key")
    path = wc.get_image_path(key)
    if not path or not path.is_file():
        return _json_error("image not found", 404)
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return web.FileResponse(
        path,
        headers={"Content-Type": ctype, "Cache-Control": "no-cache"},
    )


async def handle_update_image(request: web.Request) -> web.Response:
    if not request.content_type.startswith("multipart/"):
        return _json_error(tr("图片上传格式无效"))

    key = ""
    image_data: bytes | None = None
    try:
        reader = await request.multipart()
        async for part in reader:
            if part.name == "key":
                key = (await part.text()).strip()
            elif part.name == "image":
                chunks: list[bytes] = []
                size = 0
                while True:
                    chunk = await part.read_chunk(size=64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_PREVIEW_IMAGE_BYTES:
                        return _json_error(tr("图片不能超过 32 MB"), 413)
                    chunks.append(chunk)
                image_data = b"".join(chunks)
    except Exception:
        return _json_error(tr("图片上传格式无效"))

    if not key:
        return _json_error("missing key")
    if not image_data:
        return _json_error(tr("请选择图片"))

    try:
        entry = await asyncio.to_thread(wc.update_entry_image, key, image_data)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("preview image update failed")
        return _json_error(tr("示例图保存失败：{error}", error=exc), 500)

    return web.json_response({"success": True, "entry": entry})


async def handle_image_metadata(request: web.Request) -> web.Response:
    """Read PNG text plus JPEG/WebP EXIF, XMP and IPTC metadata."""
    if not request.content_type.startswith("multipart/"):
        return _json_error(tr("图片上传格式无效"))
    image_data: bytes | None = None
    try:
        reader = await request.multipart()
        async for part in reader:
            if part.name != "image":
                continue
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = await part.read_chunk(size=64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_PREVIEW_IMAGE_BYTES:
                    return _json_error(tr("图片不能超过 32 MB"), 413)
                chunks.append(chunk)
            image_data = b"".join(chunks)
    except Exception:
        return _json_error(tr("图片上传格式无效"))
    if not image_data:
        return _json_error(tr("请选择图片"))

    try:
        from PIL import Image

        with Image.open(BytesIO(image_data)) as image:
            metadata_payload = extract_image_metadata(image)
    except Exception as exc:
        logger.info("image metadata read failed: %s", exc)
        metadata_payload = {}
    return web.json_response({"success": True, "metadata": metadata_payload})


async def handle_favorites(_request: web.Request) -> web.Response:
    try:
        return web.json_response({"success": True, "favorites": wc.get_favorites()})
    except Exception as exc:
        logger.exception("favorites load failed")
        return _json_error(tr("收藏读取失败：{error}", error=exc), 500)


async def handle_update_favorites(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return _json_error("invalid json")

    try:
        key = data.get("key")
        favorite = data.get("favorite")
        if not isinstance(key, str) or not key.strip():
            return _json_error("missing key")
        if not isinstance(favorite, bool):
            return _json_error("favorite must be boolean")
        wc.set_favorite(key, favorite)
        return web.json_response(
            {
                "success": True,
                "key": wc.normalize_key(key),
                "favorite": favorite,
                "favorites": wc.get_favorites(),
            }
        )
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except ValueError as exc:
        return _json_error(str(exc))
    except Exception as exc:
        logger.exception("favorites update failed")
        return _json_error(tr("收藏保存失败：{error}", error=exc), 500)
