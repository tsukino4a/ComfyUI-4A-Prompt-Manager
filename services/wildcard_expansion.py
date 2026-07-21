"""Stateless wildcard resolution and expansion."""

from __future__ import annotations

import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Iterable, Mapping

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


@dataclass(frozen=True)
class LibraryWildcardResolver:
    """Immutable, structured view of one loaded wildcard-library snapshot."""

    file_dict: Mapping[str, tuple[str, ...]]
    folder_entry_keys: Mapping[str, tuple[str, ...]]
    negative_dict: Mapping[str, str]
    display_paths: Mapping[str, str]
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


def join_positive_parts(*parts: str) -> str:
    """Join non-empty prompt parts with a blank line between sections."""
    cleaned = [p.strip() for p in parts if isinstance(p, str) and p.strip()]
    if not cleaned:
        return ""

    joined = cleaned[0]
    for part in cleaned[1:]:
        # Keep a comma between tag groups; blank line is only for readability.
        glue = "\n\n" if joined.rstrip().endswith(",") else ",\n\n"
        joined += glue + part
    return joined
