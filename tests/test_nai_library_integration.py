"""Cross-layer tests for NovelAI prompt-card library integration."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from domain import nai_wildcard_syntax, wildcard_syntax
from server import routes_library
from services import prompt_library
from services.wildcard_expansion import LibraryWildcardResolver
from storage import library_index_cache


FULL_NAI = {
    "parameters": {
        "steps": 28,
        "cfg": 5.0,
        "sampler": "k_euler",
        "scheduler": "native",
        "cfg_rescale": 0.2,
    },
}


class NaiResolverIntegrationTests(unittest.TestCase):
    def test_nai_parser_imports_as_real_package_submodule(self) -> None:
        root = Path(__file__).resolve().parents[1]
        script = """
import importlib
import pathlib
import sys
import types

root = pathlib.Path(sys.argv[1])
package_name = "_pm4a_package_smoke"
package = types.ModuleType(package_name)
package.__path__ = [str(root)]
sys.modules[package_name] = package
domain_name = package_name + ".domain"
domain_package = types.ModuleType(domain_name)
domain_package.__path__ = [str(root / "domain")]
sys.modules[domain_name] = domain_package
module = importlib.import_module(domain_name + ".nai_wildcard_syntax")
assert module.reference_keys("__card__") == ("card",)
"""
        with tempfile.TemporaryDirectory() as isolated_cwd:
            completed = subprocess.run(
                [sys.executable, "-I", "-c", script, str(root)],
                cwd=isolated_cwd,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_legacy_positional_resolver_construction_keeps_field_order(self) -> None:
        candidate = wildcard_syntax.WildcardCandidate("card", "content")
        candidates = {"card": (candidate,)}
        folder_candidates = {"*": (candidate,)}

        resolver = LibraryWildcardResolver(
            {"card": ("content",)},
            {"*": ("card",)},
            {"card": ""},
            {"card": "Card"},
            {"card": {}},
            {"card": {}},
            candidates,
            folder_candidates,
        )

        self.assertIs(resolver.candidate_dict, candidates)
        self.assertIs(resolver.folder_candidate_dict, folder_candidates)
        self.assertEqual(resolver.nai_dict, {})

    def test_resolver_snapshots_normalized_nai_and_nai_expand_merges_it(self) -> None:
        source_nai = {
            "outer": {
                "model": " nai-diffusion-4-5-full ",
                "parameters": {"sampler": "k_euler", "steps": 28},
                "reference": {"drop": True},
                "network": {"drop": True},
            },
            "inner": {
                "model": "later-model",
                "parameters": {"scheduler": "native", "steps": 30, "cfg": 5.0},
            },
        }
        resolver = LibraryWildcardResolver.from_indexes(
            {"outer": ["__inner__"], "inner": ["done"]},
            (),
            {"outer": "neg"},
            {"outer": "Outer", "inner": "Inner"},
            settings_dict={
                "outer": {"parameters": {"seed": 7}},
                "inner": {"parameters": {"steps": 25}},
            },
            nai_dict=source_nai,
        )

        source_nai["outer"]["model"] = "mutated"
        source_nai["outer"]["parameters"]["sampler"] = "mutated"
        outer = resolver.resolve("outer")[0]
        self.assertEqual(
            outer.nai,
            {
                "parameters": {"sampler": "k_euler", "steps": 28},
            },
        )

        result = nai_wildcard_syntax.expand(
            "__outer__",
            resolver,
            wildcard_syntax.ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "done")
        self.assertEqual(result.negatives, ("neg",))
        self.assertEqual(result.parameters, {"seed": 7, "steps": 25})
        self.assertEqual(
            result.nai,
            {
                "parameters": {
                    "sampler": "k_euler",
                    "steps": 28,
                    "scheduler": "native",
                    "cfg": 5.0,
                },
            },
        )
        self.assertNotIn("model", result.nai)
        self.assertNotIn("reference", result.nai)
        self.assertNotIn("network", result.nai)

    def test_resolver_copy_merge_keeps_nai_content_and_appends_characters(self) -> None:
        source_nai = {
            "outer": {
                "content": "outer nai",
                "negative": "outer neg",
                "characters": [{"positive": "outer-char"}],
                "parameters": {"sampler": "k_euler", "steps": 28},
            },
            "inner": {
                "content": "inner nai",
                "characters": [{"positive": "inner-char", "x": 0.3, "y": 0.7}],
                "parameters": {"scheduler": "native", "steps": 30, "cfg": 5.0},
            },
        }
        resolver = LibraryWildcardResolver.from_indexes(
            {"outer": ["__inner__"], "inner": ["done"]},
            (),
            {"outer": "neg"},
            {"outer": "Outer", "inner": "Inner"},
            nai_dict=source_nai,
        )
        source_nai["outer"]["content"] = "mutated"
        source_nai["outer"]["characters"][0]["positive"] = "mutated"
        outer = resolver.resolve("outer")[0]
        self.assertEqual(outer.nai["content"], "outer nai")
        self.assertEqual(outer.nai["characters"][0]["positive"], "outer-char")

        result = nai_wildcard_syntax.expand(
            "__outer__",
            resolver,
            wildcard_syntax.ExpansionContext(seed=1),
        )
        self.assertEqual(
            result.nai,
            {
                "content": "outer nai",
                "negative": "outer neg",
                "characters": [
                    {"positive": "outer-char"},
                    {"positive": "inner-char", "x": 0.3, "y": 0.7},
                ],
                "parameters": {
                    "sampler": "k_euler",
                    "steps": 28,
                    "scheduler": "native",
                    "cfg": 5.0,
                },
            },
        )

    def test_legacy_resolver_call_and_impact_expand_keep_empty_nai(self) -> None:
        resolver = LibraryWildcardResolver.from_indexes(
            {"card": ["content"]},
            (),
            {},
            {"card": "Card"},
        )
        candidate = resolver.resolve("card")[0]
        self.assertEqual(candidate.nai, {})

        result = wildcard_syntax.expand(
            "__card__",
            resolver,
            wildcard_syntax.ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "content")
        self.assertEqual(result.nai, {})
        self.assertEqual(getattr(result, "negative_keys", None), ())


class NaiLibraryIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        prompt_library.reload(self.root, force=True)

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def _write_card(
        self,
        relative: str,
        *,
        content: str = "positive",
        nai: object = None,
    ) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, object] = {
            "content": content,
            "negative": "",
            "note": "",
        }
        if nai is not None:
            payload["nai"] = nai
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    def test_reload_get_entry_capabilities_and_txt_isolation(self) -> None:
        self._write_card("Card.json", nai=FULL_NAI)
        (self.root / "Pool.txt").write_text("one\ntwo\n", encoding="utf-8")
        prompt_library.reload(self.root, force=True)

        card = prompt_library.get_entry("card")
        pool = prompt_library.get_entry("pool")
        self.assertIsNotNone(card)
        self.assertIsNotNone(pool)
        assert card is not None
        assert pool is not None
        self.assertEqual(card["nai"], FULL_NAI)
        self.assertTrue(card["capabilities"]["nai"])
        self.assertEqual(pool["nai"], {})
        self.assertFalse(pool["capabilities"]["nai"])
        self.assertEqual(pool["parameters"], {})

    def test_nai_only_card_uses_converted_text_in_comfy_index(self) -> None:
        self._write_card(
            "NaiOnly.json",
            content="",
            nai={
                "content": "1.2::hero::",
                "negative": "[bad]",
            },
        )
        prompt_library.reload(self.root, force=True)

        entry = prompt_library.get_entry("naionly")
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(entry["content"], "")
        self.assertEqual(entry["negative"], "")
        self.assertEqual(entry["nai"]["content"], "1.2::hero::")
        self.assertEqual(entry["nai"]["negative"], "[bad]")
        expanded = prompt_library.expand_prompt("__naionly__")
        self.assertEqual(expanded.text, "(hero:1.30)")
        self.assertEqual(expanded.negatives, ("(bad:0.88)",))
        stored = json.loads((self.root / "NaiOnly.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["content"], "")

    def test_v2_index_cache_roundtrip_preserves_nai(self) -> None:
        self._write_card("Card.json", nai=FULL_NAI)
        prompt_library.reload(self.root, force=True)
        self.assertEqual(
            library_index_cache.cache_path(self.root).name,
            "index-cache-v2.json",
        )
        snapshot = library_index_cache.read_snapshot(self.root)
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["version"], 2)
        self.assertEqual(snapshot["entries"]["card"]["nai"], FULL_NAI)

        with patch(
            "services.prompt_library.read_prompt_document",
            side_effect=AssertionError("cache hit must not read card bodies"),
        ):
            prompt_library.reload(self.root, force=False)
        self.assertEqual(prompt_library.get_entry("card")["nai"], FULL_NAI)

    def test_v2_write_removes_only_lower_version_cache_files(self) -> None:
        metadata_root = library_index_cache.cache_path(self.root).parent
        legacy_v1 = metadata_root / "index-cache-v1.json"
        future_v3 = metadata_root / "index-cache-v3.json"
        unrelated = metadata_root / "index-cache-vold.json"
        for path in (legacy_v1, future_v3, unrelated):
            path.write_text("sentinel", encoding="utf-8")

        self._write_card("Card.json", nai=FULL_NAI)
        prompt_library.reload(self.root, force=True)

        self.assertFalse(legacy_v1.exists())
        self.assertTrue(library_index_cache.cache_path(self.root).is_file())
        self.assertTrue(future_v3.is_file())
        self.assertTrue(unrelated.is_file())

        legacy_v1.write_text("sentinel", encoding="utf-8")
        self.assertIsNotNone(library_index_cache.read_snapshot(self.root))
        self.assertFalse(legacy_v1.exists())
        self.assertTrue(future_v3.is_file())

    def test_v1_cache_is_ignored_and_reload_preserves_nai_everywhere(self) -> None:
        self._write_card("Card.json", nai=FULL_NAI)
        fingerprint = library_index_cache.collect_disk_fingerprint(self.root)
        active_cache = library_index_cache.cache_path(self.root)
        active_cache.unlink(missing_ok=True)
        legacy_path = active_cache.with_name("index-cache-v1.json")
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "root": str(self.root.resolve()),
                    "fingerprint": fingerprint,
                    "entries": {
                        "card": {
                            "path": "Card.json",
                            "display_path": "Card",
                            "options": ["positive"],
                            "negative": "",
                            "note": "",
                            "lora": {"text": "", "hashes": []},
                            "settings": {
                                "models": [],
                                "parameters": {},
                                "double_sample_parameters": {},
                            },
                        }
                    },
                    "empty_folders": {},
                    "conflict_keys": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        self.assertIsNone(library_index_cache.read_snapshot(self.root))
        original_reader = prompt_library.read_prompt_document
        with patch(
            "services.prompt_library.read_prompt_document",
            wraps=original_reader,
        ) as reader:
            prompt_library.reload(self.root, force=False)
        self.assertGreater(reader.call_count, 0)
        self.assertEqual(prompt_library.get_entry("card")["nai"], FULL_NAI)
        self.assertEqual(
            prompt_library.snapshot_resolver().resolve("card")[0].nai,
            FULL_NAI,
        )
        records = {
            record["title"]: record
            for record in prompt_library.export_prompt_bundle()["prompts"]
        }
        self.assertEqual(records["Card"]["nai"], FULL_NAI)

        prompt_library.create_folder("", "Copied")
        prompt_library.create_folder("", "Moved")
        copied = prompt_library.operate_items(
            "copy",
            [{"type": "file", "key": "card"}],
            "copied",
        )
        copied_key = copied["key_copies"]["card"]
        self.assertEqual(prompt_library.get_entry(copied_key)["nai"], FULL_NAI)
        moved = prompt_library.operate_items(
            "move",
            [{"type": "file", "key": copied_key}],
            "moved",
        )
        moved_key = moved["key_moves"][copied_key]
        self.assertEqual(prompt_library.get_entry(moved_key)["nai"], FULL_NAI)
        renamed = prompt_library.rename_folder("moved", "Renamed")
        renamed_key = renamed["key_moves"][moved_key]
        self.assertEqual(prompt_library.get_entry(renamed_key)["nai"], FULL_NAI)

    def test_create_and_update_distinguish_omitted_nai_from_explicit_empty(self) -> None:
        created = prompt_library.create_entry(
            "",
            "Card",
            "positive",
            nai=FULL_NAI,
        )
        self.assertEqual(created["nai"], FULL_NAI)

        updated = prompt_library.update_entry("card", note="changed")
        self.assertEqual(updated["nai"], FULL_NAI)
        on_disk = json.loads((self.root / "Card.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["nai"], FULL_NAI)

        cleared = prompt_library.update_entry("card", nai={})
        self.assertEqual(cleared["nai"], {})
        on_disk = json.loads((self.root / "Card.json").read_text(encoding="utf-8"))
        self.assertNotIn("nai", on_disk)

        empty = prompt_library.create_entry("", "Empty", "plain")
        self.assertEqual(empty["nai"], {})
        on_disk = json.loads((self.root / "Empty.json").read_text(encoding="utf-8"))
        self.assertNotIn("nai", on_disk)

    def test_create_nai_only_card_allows_empty_comfy_content(self) -> None:
        nai = {
            "content": "nai positive",
            "negative": "nai negative",
            "characters": [{"positive": "hero"}, {"positive": "sidekick"}],
            "parameters": {"steps": 23},
        }
        created = prompt_library.create_entry("", "Nai Only", "", nai=nai)
        self.assertEqual(created["content"], "")
        self.assertEqual(created["nai"], nai)
        on_disk = json.loads((self.root / "Nai Only.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["content"], "")
        self.assertEqual(on_disk["nai"], nai)

        updated = prompt_library.update_entry("nai-only", note="changed")
        self.assertEqual(updated["nai"], nai)
        cleared_comfy = prompt_library.update_entry("nai-only", content="")
        self.assertEqual(cleared_comfy["content"], "")
        self.assertEqual(cleared_comfy["nai"]["content"], "nai positive")

    def test_create_and_update_reject_empty_comfy_and_nai_content(self) -> None:
        with self.assertRaisesRegex(ValueError, "提示词内容不能为空"):
            prompt_library.create_entry("", "Bad", "", nai={"parameters": {"steps": 23}})
        prompt_library.create_entry("", "Card", "positive")
        with self.assertRaisesRegex(ValueError, "提示词内容不能为空"):
            prompt_library.update_entry("card", content="", nai={})

    def test_bundle_import_accepts_nai_only_records(self) -> None:
        prompt_library.create_folder("", "Imported")
        result = prompt_library.import_prompt_bundle(
            "imported",
            [
                {
                    "title": "Nai Only",
                    "storage": "json",
                    "nai": {
                        "content": "imported nai",
                        "characters": [{"positive": "hero", "x": 0.4, "y": 0.6}],
                    },
                }
            ],
            "json",
        )
        self.assertEqual(result["created"], 1)
        entry = prompt_library.get_entry("imported/nai-only")
        self.assertEqual(entry["content"], "")
        self.assertEqual(
            entry["nai"],
            {
                "content": "imported nai",
                "characters": [{"positive": "hero", "x": 0.4, "y": 0.6}],
            },
        )

    def test_update_omit_preserves_disk_nai_when_memory_index_lacks_it(self) -> None:
        card_path = self._write_card("Card.json", nai=FULL_NAI)
        prompt_library.reload(self.root, force=True)
        prompt_library._nai_dict["card"] = {}
        self.assertEqual(prompt_library.get_entry("card")["nai"], {})

        updated = prompt_library.update_entry("card", note="legacy client update")

        self.assertEqual(updated["nai"], FULL_NAI)
        self.assertEqual(
            json.loads(card_path.read_text(encoding="utf-8"))["nai"],
            FULL_NAI,
        )

    def test_update_explicit_nai_does_not_read_disk_for_preservation(self) -> None:
        prompt_library.create_entry("", "Card", "positive", nai=FULL_NAI)

        with patch(
            "services.prompt_library._read_json_prompt",
            side_effect=AssertionError("explicit nai must not read for preservation"),
        ):
            updated = prompt_library.update_entry("card", nai={})

        self.assertEqual(updated["nai"], {})
        on_disk = json.loads((self.root / "Card.json").read_text(encoding="utf-8"))
        self.assertNotIn("nai", on_disk)

    def test_update_explicit_empty_clears_disk_when_memory_nai_is_stale_empty(self) -> None:
        card_path = self._write_card("Card.json", nai=FULL_NAI)
        prompt_library.reload(self.root, force=True)
        prompt_library._nai_dict["card"] = {}

        with patch(
            "services.prompt_library._read_json_prompt",
            side_effect=AssertionError("explicit nai must not read for preservation"),
        ):
            updated = prompt_library.update_entry("card", nai={})

        self.assertEqual(updated["nai"], {})
        self.assertNotIn(
            "nai",
            json.loads(card_path.read_text(encoding="utf-8")),
        )

    def test_update_omit_same_name_preserves_nai_without_rewriting(self) -> None:
        prompt_library.create_entry("", "Card", "positive", nai=FULL_NAI)

        with patch(
            "services.prompt_library._write_json_prompt",
            side_effect=AssertionError("unchanged omitted nai must not rewrite"),
        ):
            updated = prompt_library.update_entry("card", name="Card")

        self.assertEqual(updated["nai"], FULL_NAI)

    def test_bundle_export_import_is_sparse_normalized_and_legacy_compatible(self) -> None:
        prompt_library.create_entry("", "With Nai", "one", nai=FULL_NAI)
        prompt_library.create_entry("", "Without Nai", "two")
        (self.root / "Pool.txt").write_text("alpha\nbeta\n", encoding="utf-8")
        prompt_library.reload(self.root, force=True)

        bundle = prompt_library.export_prompt_bundle()
        records = {record["title"]: record for record in bundle["prompts"]}
        self.assertEqual(records["With Nai"]["nai"], FULL_NAI)
        self.assertNotIn("nai", records["Without Nai"])
        self.assertNotIn("nai", records["Pool"])

        prompt_library.create_folder("", "Imported")
        imported_records = [
            {
                **records["With Nai"],
                "nai": {
                    **records["With Nai"]["nai"],
                    "reference": {"drop": True},
                    "network": {"drop": True},
                    "parameters": {
                        **records["With Nai"]["nai"]["parameters"],
                        "unknown": "drop",
                    },
                },
            },
            records["Without Nai"],
        ]
        result = prompt_library.import_prompt_bundle(
            "imported",
            imported_records,
            "json",
        )
        self.assertEqual(result["created"], 2)
        imported_nai = prompt_library.get_entry("imported/with-nai")["nai"]
        self.assertEqual(imported_nai, FULL_NAI)
        self.assertNotIn("reference", imported_nai)
        self.assertNotIn("network", imported_nai)
        self.assertEqual(prompt_library.get_entry("imported/without-nai")["nai"], {})

    def test_rename_copy_and_move_preserve_nai_indexes(self) -> None:
        prompt_library.create_folder("", "Source")
        prompt_library.create_folder("", "Target")
        prompt_library.create_entry(
            "source",
            "Card",
            "positive",
            nai={"parameters": {"steps": 9}},
        )

        copied = prompt_library.operate_items(
            "copy",
            [{"type": "file", "key": "source/card"}],
            "target",
        )
        copied_key = copied["key_copies"]["source/card"]
        self.assertEqual(
            prompt_library.get_entry(copied_key)["nai"],
            {"parameters": {"steps": 9}},
        )

        moved = prompt_library.operate_items(
            "move",
            [{"type": "file", "key": copied_key}],
            "",
        )
        moved_key = moved["key_moves"][copied_key]
        self.assertEqual(
            prompt_library.get_entry(moved_key)["nai"],
            {"parameters": {"steps": 9}},
        )

        renamed = prompt_library.rename_folder("source", "Renamed")
        renamed_key = renamed["key_moves"]["source/card"]
        self.assertEqual(
            prompt_library.get_entry(renamed_key)["nai"],
            {"parameters": {"steps": 9}},
        )


class _JsonRequest:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    async def json(self) -> dict[str, object]:
        return self._payload


class NaiLibraryRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_and_update_routes_reject_null_nai(self) -> None:
        update_response = await routes_library.handle_update_entry(
            _JsonRequest({"key": "card", "nai": None})
        )
        create_response = await routes_library.handle_create_entry(
            _JsonRequest(
                {
                    "folder": "",
                    "name": "Card",
                    "content": "positive",
                    "nai": None,
                }
            )
        )

        self.assertEqual(update_response.status, 400)
        self.assertEqual(create_response.status, 400)

    async def test_update_route_only_forwards_nai_when_field_is_present(self) -> None:
        with patch.object(
            routes_library.wc,
            "update_entry",
            return_value={"key": "card"},
        ) as update:
            response = await routes_library.handle_update_entry(
                _JsonRequest({"key": "card", "note": "changed"})
            )
            self.assertEqual(response.status, 200)
            self.assertNotIn("nai", update.call_args.kwargs)

        with patch.object(
            routes_library.wc,
            "update_entry",
            return_value={"key": "card"},
        ) as update:
            response = await routes_library.handle_update_entry(
                _JsonRequest({"key": "card", "nai": {}})
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(update.call_args.kwargs["nai"], {})

    async def test_create_route_only_forwards_nai_when_field_is_present(self) -> None:
        base = {"folder": "", "name": "Card", "content": "positive"}
        with patch.object(
            routes_library.wc,
            "create_entry",
            return_value={"key": "card"},
        ) as create:
            response = await routes_library.handle_create_entry(_JsonRequest(base))
            self.assertEqual(response.status, 200)
            self.assertNotIn("nai", create.call_args.kwargs)

        with patch.object(
            routes_library.wc,
            "create_entry",
            return_value={"key": "card"},
        ) as create:
            response = await routes_library.handle_create_entry(
                _JsonRequest({**base, "nai": {}})
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(create.call_args.kwargs["nai"], {})


if __name__ == "__main__":
    unittest.main()
