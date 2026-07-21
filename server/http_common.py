"""Shared HTTP localization, errors, request keys, and operation progress."""

from __future__ import annotations

import re
import threading
import time
from functools import wraps
from typing import Any
from urllib.parse import unquote

from aiohttp import web

try:
    from ..support.i18n import reset_locale, set_locale, tr
except ImportError:  # standalone preview
    from support.i18n import reset_locale, set_locale, tr  # type: ignore


PROGRESS_STATE_TTL_SECONDS = 10 * 60
PROGRESS_UPDATE_INTERVAL_SECONDS = 0.06
_PROGRESS_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_progress_lock = threading.Lock()
_progress_states: dict[str, dict[str, Any]] = {}


def localized_handler(handler):
    @wraps(handler)
    async def wrapped(request, *args, **kwargs):
        token = set_locale(request.headers.get("X-PM4A-Locale"))
        try:
            return await handler(request, *args, **kwargs)
        finally:
            reset_locale(token)

    return wrapped


def _validated_progress_id(value: object) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not _PROGRESS_ID_RE.fullmatch(value):
        raise ValueError("progress_id is invalid")
    return value


def _clean_progress_states_locked(now: float) -> None:
    stale = [
        progress_id
        for progress_id, state in _progress_states.items()
        if now - float(state.get("updated_at", now)) > PROGRESS_STATE_TTL_SECONDS
    ]
    for progress_id in stale:
        _progress_states.pop(progress_id, None)


def _begin_progress(progress_id: str | None):
    if not progress_id:
        return None
    preparing = tr("正在准备")
    processing = tr("正在处理")
    now = time.monotonic()
    with _progress_lock:
        _clean_progress_states_locked(now)
        _progress_states[progress_id] = {
            "current": 0,
            "total": 0,
            "summary": preparing,
            "done": False,
            "error": "",
            "updated_at": now,
        }

    last_update = 0.0

    def report(current: int, total: int, summary: str = "") -> None:
        nonlocal last_update
        current = max(0, int(current))
        total = max(0, int(total))
        current = min(current, total) if total else 0
        now = time.monotonic()
        if current not in {0, total} and now - last_update < PROGRESS_UPDATE_INTERVAL_SECONDS:
            return
        last_update = now
        with _progress_lock:
            state = _progress_states.get(progress_id)
            if not state:
                return
            state.update(
                current=current,
                total=total,
                summary=str(summary or state.get("summary") or processing),
                updated_at=now,
            )

    return report


def _finish_progress(progress_id: str | None, error: str = "") -> None:
    if not progress_id:
        return
    now = time.monotonic()
    with _progress_lock:
        state = _progress_states.get(progress_id)
        if not state:
            return
        if not error and state.get("total"):
            state["current"] = state["total"]
        state["done"] = True
        state["error"] = error
        state["updated_at"] = now


async def handle_operation_progress(request: web.Request) -> web.Response:
    try:
        progress_id = _validated_progress_id(
            request.rel_url.query.get("progress_id", "")
        )
    except ValueError as exc:
        return _json_error(str(exc))
    if not progress_id:
        return _json_error("progress_id is required")
    now = time.monotonic()
    with _progress_lock:
        _clean_progress_states_locked(now)
        state = _progress_states.get(progress_id)
        if not state:
            return _json_error("progress not found", 404)
        public_state = {
            key: state[key]
            for key in ("current", "total", "summary", "done", "error")
        }
    return web.json_response({"success": True, **public_state})


def _json_error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"success": False, "error": message}, status=status)


def _key_from_request(request: web.Request) -> str:
    """Read a wildcard key from the current query-string API."""
    key = request.rel_url.query.get("key", "")
    return unquote(key).strip()
