"""Stateless wildcard resolution and expansion."""

from __future__ import annotations

import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Iterable, Mapping

try:
    from ..domain import wildcard_syntax
except ImportError:  # standalone preview
    from domain import wildcard_syntax  # type: ignore


_ROOT_WILDCARD_KEY = "*"


def normalize_key(value: str) -> str:
    return value.strip().replace("\\", "/").replace(" ", "-").strip("/").lower()


def _natural_display_key(value: str) -> tuple[tuple[int, object], ...]:
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"(\d+)", value.replace("\\", "/"))
        if part
    )


def _lora_text_of(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        text = value.get("text", "")
        return text.strip() if isinstance(text, str) else ""
    return ""


def _settings_of(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"models": (), "parameters": {}, "double_sample_parameters": {}}
    models_raw = value.get("models") or []
    models = tuple(dict(entry) for entry in models_raw if isinstance(entry, dict))
    parameters = (
        dict(value["parameters"])
        if isinstance(value.get("parameters"), dict)
        else {}
    )
    double_sample = (
        dict(value["double_sample_parameters"])
        if isinstance(value.get("double_sample_parameters"), dict)
        else {}
    )
    return {
        "models": models,
        "parameters": parameters,
        "double_sample_parameters": double_sample,
    }


@dataclass(frozen=True)
class LibraryWildcardResolver:
    """Immutable, structured view of one loaded wildcard-library snapshot."""

    file_dict: Mapping[str, tuple[str, ...]]
    folder_entry_keys: Mapping[str, tuple[str, ...]]
    negative_dict: Mapping[str, str]
    display_paths: Mapping[str, str]
    lora_dict: Mapping[str, Any]
    settings_dict: Mapping[str, Any]
    candidate_dict: Mapping[str, tuple[wildcard_syntax.WildcardCandidate, ...]]
    folder_candidate_dict: Mapping[
        str, tuple[wildcard_syntax.WildcardCandidate, ...]
    ]

    @classmethod
    def from_indexes(
        cls,
        file_dict: Mapping[str, Iterable[str]],
        folder_keys: Iterable[str],
        negative_dict: Mapping[str, str],
        display_paths: Mapping[str, str],
        lora_dict: Mapping[str, Any] | None = None,
        settings_dict: Mapping[str, Any] | None = None,
    ) -> "LibraryWildcardResolver":
        files = {
            key: tuple(values)
            for key, values in file_dict.items()
            if values
        }
        displays = {
            key: display_paths.get(key, key)
            for key in files
        }
        negatives = {
            key: negative_dict.get(key, "")
            for key in files
        }
        loras = {
            key: lora_dict.get(key, "") if lora_dict is not None else ""
            for key in files
        }
        settings = {
            key: (
                settings_dict.get(key, {})
                if settings_dict is not None
                else {}
            )
            for key in files
        }
        candidate_keys = list(files)
        candidate_keys.sort(
            key=lambda key: (_natural_display_key(displays.get(key, key)), key)
        )
        folders: dict[str, tuple[str, ...]] = {}
        for raw_folder in dict.fromkeys((*folder_keys, _ROOT_WILDCARD_KEY)):
            folder = normalize_key(raw_folder)
            if not folder:
                continue
            if folder == _ROOT_WILDCARD_KEY:
                entries = candidate_keys
            else:
                prefix = folder + "/"
                entries = [key for key in candidate_keys if key.startswith(prefix)]
            folders[folder] = tuple(entries)
        candidates = {
            key: tuple(
                wildcard_syntax.WildcardCandidate(
                    key=key,
                    content=content,
                    negative=negatives.get(key, ""),
                    lora_text=_lora_text_of(loras.get(key)),
                    models=_settings_of(settings.get(key)).get("models") or (),
                    parameters=dict(
                        _settings_of(settings.get(key)).get("parameters") or {}
                    ),
                    double_sample_parameters=dict(
                        _settings_of(settings.get(key)).get(
                            "double_sample_parameters"
                        )
                        or {}
                    ),
                )
                for content in options
            )
            for key, options in files.items()
        }
        folder_candidates = {
            folder: tuple(
                candidate
                for entry_key in entries
                for candidate in candidates.get(entry_key, ())
            )
            for folder, entries in folders.items()
        }
        return cls(
            file_dict=MappingProxyType(files),
            folder_entry_keys=MappingProxyType(folders),
            negative_dict=MappingProxyType(negatives),
            display_paths=MappingProxyType(displays),
            lora_dict=MappingProxyType(loras),
            settings_dict=MappingProxyType(settings),
            candidate_dict=MappingProxyType(candidates),
            folder_candidate_dict=MappingProxyType(folder_candidates),
        )

    def option_count(self, key: str) -> int:
        normalized = normalize_key(key)
        if normalized in self.candidate_dict:
            return len(self.candidate_dict[normalized])
        return len(self.folder_candidate_dict.get(normalized, ()))

    def resolve(
        self, key: str
    ) -> tuple[wildcard_syntax.WildcardCandidate, ...]:
        normalized = normalize_key(key)
        if normalized.startswith("*/"):
            requested = normalized[2:].rsplit("/", 1)[-1]
            matches = [
                entry_key
                for entry_key in self.file_dict
                if entry_key.rsplit("/", 1)[-1] == requested
            ]
            matches.sort(
                key=lambda entry_key: (
                    _natural_display_key(
                        self.display_paths.get(entry_key, entry_key)
                    ),
                    entry_key,
                )
            )
            return tuple(
                candidate
                for entry_key in matches
                for candidate in self.candidate_dict.get(entry_key, ())
            )
        candidates = self.candidate_dict.get(normalized)
        if candidates is not None:
            return candidates
        folder_candidates = self.folder_candidate_dict.get(normalized)
        if folder_candidates is not None:
            return folder_candidates
        return ()


def expand_prompt(
    text: str,
    *,
    resolver: wildcard_syntax.WildcardResolver,
    seed: int = 0,
    mode: str = "random",
    execution_index: int = 0,
    track_id: str = "",
    max_depth: int = 100,
) -> wildcard_syntax.ExpansionResult:
    """Expand one prompt through an explicitly supplied resolver."""
    return wildcard_syntax.expand(
        text,
        resolver,
        wildcard_syntax.ExpansionContext(
            seed=int(seed),
            mode=mode,
            execution_index=int(execution_index),
            track_id=track_id,
            max_depth=int(max_depth),
        ),
    )


def cleanup_prompt_commas(text: str) -> str:
    """Drop empty comma slots (e.g. 'a,,b' / 'a, , b'); keep author newlines.

    Leading empty commas are removed; a single trailing comma is left alone.
    """
    if not isinstance(text, str) or not text.strip():
        return ""
    cleaned = re.sub(r",(?:\s*,)+", ",", text)
    cleaned = re.sub(r"^(?:\s*,\s*)+", "", cleaned)
    return cleaned


def join_positive_parts(*parts: str) -> str:
    """Join non-empty prompt parts; keep author newlines, no extra blank lines."""
    cleaned = [
        part
        for part in (cleanup_prompt_commas(p) for p in parts if isinstance(p, str))
        if part.strip()
    ]
    if not cleaned:
        return ""
    joined = cleaned[0]
    for part in cleaned[1:]:
        glue = " " if joined.rstrip().endswith(",") else ", "
        joined += glue + part
    return cleanup_prompt_commas(joined)
