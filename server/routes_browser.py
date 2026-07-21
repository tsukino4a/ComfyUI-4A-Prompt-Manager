"""Browser page and static asset route helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from aiohttp import web

try:
    from ..support.config import PLUGIN_ROOT
    from ..support.i18n import reset_locale, set_locale, tr
except ImportError:  # standalone preview
    from support.config import PLUGIN_ROOT  # type: ignore
    from support.i18n import reset_locale, set_locale, tr  # type: ignore


BROWSER_DIR = PLUGIN_ROOT / "web" / "browser"


async def handle_index(
    request: web.Request,
    *,
    browser_dir: Path | None = None,
) -> web.Response:
    browser_dir = BROWSER_DIR if browser_dir is None else browser_dir
    index = browser_dir / "index.html"
    if not index.is_file():
        locale = request.rel_url.query.get("lang")
        if locale is None:
            locale = request.headers.get("X-PM4A-Locale")
        token = set_locale(locale)
        try:
            text = tr("4A 提示词管理器浏览器界面文件缺失")
        finally:
            reset_locale(token)
        return web.Response(text=text, status=500)
    resp = web.FileResponse(index)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def add_static_route(
    app: web.Application,
    *,
    get_browser_dir: Callable[[], Path] = lambda: BROWSER_DIR,
) -> None:
    app.router.add_static("/pm4a/static", str(get_browser_dir()), show_index=False)
