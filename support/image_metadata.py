"""Extract text-oriented generation metadata from Pillow images.

Pillow exposes PNG text chunks through ``image.info`` but JPEG/WebP generation
data commonly lives in EXIF or XMP.  This module flattens those containers into
the same small dictionary consumed by the browser-side prompt parser.
"""

from __future__ import annotations

from typing import Any
from xml.etree import ElementTree


_RAW_BINARY_INFO_KEYS = {
    "exif",
    "icc_profile",
    "transparency",
}
_MAX_TEXT_BYTES = 16 * 1024 * 1024


def _clean_decoded_text(value: str) -> str:
    return value.replace("\x00", "").strip("\ufeff\ufffe\x00 \t\r\n")


def decode_user_comment(value: bytes) -> str:
    """Decode EXIF 0x9286, including Civitai's big-endian UNICODE payload."""
    raw = bytes(value)
    prefix = raw[:8]
    body = raw[8:]
    if prefix.startswith(b"ASCII"):
        return _clean_decoded_text(body.decode("utf-8", errors="replace"))
    if prefix.startswith(b"JIS"):
        return _clean_decoded_text(body.decode("shift_jis", errors="replace"))
    if prefix.startswith(b"UNICODE"):
        if body.startswith((b"\xff\xfe", b"\xfe\xff")):
            return _clean_decoded_text(body.decode("utf-16", errors="replace"))
        even_zeros = body[0::2].count(0)
        odd_zeros = body[1::2].count(0)
        encoding = "utf-16-be" if even_zeros > odd_zeros else "utf-16-le"
        return _clean_decoded_text(body.decode(encoding, errors="replace"))
    return decode_metadata_bytes(raw)


def decode_metadata_bytes(value: bytes, key: str = "") -> str:
    raw = bytes(value)
    if len(raw) > _MAX_TEXT_BYTES:
        return ""
    if key.lower().replace(" ", "") == "usercomment":
        return decode_user_comment(raw)
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return _clean_decoded_text(raw.decode("utf-16", errors="replace"))
    try:
        return _clean_decoded_text(raw.decode("utf-8"))
    except UnicodeDecodeError:
        even_zeros = raw[0::2].count(0)
        odd_zeros = raw[1::2].count(0)
        if max(even_zeros, odd_zeros) >= max(2, len(raw) // 8):
            encoding = "utf-16-be" if even_zeros > odd_zeros else "utf-16-le"
            return _clean_decoded_text(raw.decode(encoding, errors="replace"))
        return _clean_decoded_text(raw.decode("latin-1", errors="replace"))


def _json_safe(value: Any, key: str = "") -> Any:
    if isinstance(value, bytes):
        return decode_metadata_bytes(value, key)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, key) for item in value]
    return str(value)


def _put(payload: dict[str, Any], key: str, value: Any) -> None:
    name = str(key).strip()
    if not name:
        return
    safe = _json_safe(value, name)
    if safe in (None, "", [], {}):
        return
    payload.setdefault(name, safe)


def _local_xml_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _flatten_xmp(payload: dict[str, Any]) -> None:
    candidates = [
        value
        for key, value in list(payload.items())
        if "xmp" in key.lower() or (isinstance(value, str) and "<x:xmpmeta" in value)
    ]
    for candidate in candidates:
        if not isinstance(candidate, str) or "<" not in candidate:
            continue
        start = candidate.find("<")
        try:
            root = ElementTree.fromstring(candidate[start:])
        except (ElementTree.ParseError, ValueError):
            continue
        for element in root.iter():
            for attr, value in element.attrib.items():
                _put(payload, _local_xml_name(attr), value)
            text = (element.text or "").strip()
            if text:
                _put(payload, _local_xml_name(element.tag), text)


def _flatten_exif(image: Any, payload: dict[str, Any]) -> None:
    try:
        from PIL import ExifTags

        exif = image.getexif()
    except Exception:
        return
    if not exif:
        return

    def add_ifd(values: Any) -> None:
        for tag, value in dict(values or {}).items():
            _put(payload, ExifTags.TAGS.get(tag, str(tag)), value)

    add_ifd(exif)
    if not hasattr(exif, "get_ifd"):
        return
    ifd_ids = {0x8769, 0x8825, 0xA005}
    ifd_enum = getattr(ExifTags, "IFD", None)
    if ifd_enum is not None:
        for name in ("Exif", "GPSInfo", "Interop"):
            value = getattr(ifd_enum, name, None)
            if value is not None:
                ifd_ids.add(value)
    for ifd_id in ifd_ids:
        try:
            add_ifd(exif.get_ifd(ifd_id))
        except Exception:
            continue


def _flatten_iptc(image: Any, payload: dict[str, Any]) -> None:
    try:
        from PIL.IptcImagePlugin import getiptcinfo

        iptc = getiptcinfo(image) or {}
    except Exception:
        return
    aliases = {
        (2, 5): "Title",
        (2, 25): "Keywords",
        (2, 80): "Artist",
        (2, 120): "Description",
    }
    for tag, value in iptc.items():
        _put(payload, aliases.get(tag, f"IPTC {tag}"), value)


def extract_image_metadata(image: Any) -> dict[str, Any]:
    """Return useful text/number metadata across PNG, JPEG, WebP, GIF and TIFF."""
    payload: dict[str, Any] = {}
    for key, value in dict(getattr(image, "info", {}) or {}).items():
        if str(key).lower() in _RAW_BINARY_INFO_KEYS:
            continue
        _put(payload, str(key), value)
    _flatten_exif(image, payload)
    _flatten_iptc(image, payload)
    _flatten_xmp(payload)
    return payload

