"""Tests for sparse NovelAI (nai) JSON-card storage contract."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from storage.prompt_documents import (
    PromptDocument,
    _read_json_prompt,
    _write_json_prompt,
    card_has_positive_prompt,
    copy_nai_payload,
    empty_nai_payload,
    nai_from_document,
    normalize_nai_payload,
    read_prompt_document,
)


FULL_NAI = {
    "parameters": {
        "steps": 28,
        "cfg": 5.0,
        "sampler": "k_euler",
        "scheduler": "native",
        "cfg_rescale": 0.2,
    },
}


class NormalizeNaiPayloadTests(unittest.TestCase):
    def test_full_payload_preserved(self) -> None:
        result = normalize_nai_payload(dict(FULL_NAI))
        self.assertEqual(result, FULL_NAI)

    def test_integer_field(self) -> None:
        result = normalize_nai_payload(
            {"parameters": {"steps": 28}}
        )
        self.assertEqual(result, {"parameters": {"steps": 28}})

    def test_float_fields(self) -> None:
        result = normalize_nai_payload(
            {"parameters": {"cfg": 5.0, "cfg_rescale": 0.2}}
        )
        self.assertEqual(
            result,
            {"parameters": {"cfg": 5.0, "cfg_rescale": 0.2}},
        )

    def test_string_fields(self) -> None:
        result = normalize_nai_payload(
            {
                "parameters": {
                    "sampler": "k_euler",
                    "scheduler": "native",
                },
            }
        )
        self.assertEqual(
            result,
            {
                "parameters": {
                    "sampler": "k_euler",
                    "scheduler": "native",
                },
            },
        )

    def test_unknown_top_level_keys_discarded(self) -> None:
        payload = {
            **FULL_NAI,
            "version": 1,
            "enabled": True,
            "reference": "ref",
            "network": "net",
            "token": "tok",
            "limit_opus_free": True,
            "keep_alpha": False,
            "extra": "drop",
        }
        self.assertEqual(normalize_nai_payload(payload), FULL_NAI)

    def test_deprecated_model_and_parameter_keys_discarded(self) -> None:
        payload = {
            "model": "nai-diffusion-5-full",
            "parameters": {
                "width": 832,
                "height": 1216,
                "seed": 42,
                "smea": "SMEA+DYN",
                "decrisper": True,
                "variety": False,
                "uncond_scale": 1.0,
                "denoise": 0.5,
                "unknown": "x",
                "steps": 23,
            }
        }
        self.assertEqual(
            normalize_nai_payload(payload),
            {"parameters": {"width": 832, "height": 1216, "steps": 23}},
        )

    def test_none_and_empty_string_omitted(self) -> None:
        payload = {
            "model": "",
            "parameters": {
                "width": None,
                "height": "",
                "steps": 28,
                "sampler": "  ",
            },
        }
        self.assertEqual(normalize_nai_payload(payload), {"parameters": {"steps": 28}})

    def test_empty_parameters_omitted(self) -> None:
        self.assertEqual(normalize_nai_payload({"parameters": {}}), {})

    def test_empty_nai_returns_empty_dict(self) -> None:
        for value in (None, "", {}):
            self.assertEqual(normalize_nai_payload(value), {})

    def test_whole_block_omitted_when_only_empty_fields(self) -> None:
        self.assertEqual(
            normalize_nai_payload({"model": "", "parameters": {"width": None}}),
            {},
        )

    def test_no_defaults_added(self) -> None:
        result = normalize_nai_payload({"parameters": {"steps": 42}})
        self.assertEqual(result, {"parameters": {"steps": 42}})
        self.assertNotIn("model", result)
        self.assertNotIn("width", result["parameters"])

    def test_non_object_nai_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "nai 必须是对象"):
            normalize_nai_payload([])

    def test_non_object_parameters_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "nai.parameters 必须是对象"):
            normalize_nai_payload({"parameters": []})

    def test_non_finite_number_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "cfg 必须是有效数字"):
            normalize_nai_payload({"parameters": {"cfg": float("nan")}})

    def test_huge_integer_is_normalized_to_value_error(self) -> None:
        try:
            normalize_nai_payload({"parameters": {"steps": 10**10_000}})
        except Exception as exc:
            self.assertIsInstance(exc, ValueError)
            self.assertRegex(str(exc), "steps 必须是有效数字")
        else:
            self.fail("huge integer must be rejected")


class CopyNaiPayloadTests(unittest.TestCase):
    def test_copy_keeps_content_negative_characters_and_drops_unknown(self) -> None:
        original = {
            "content": "nai positive",
            "negative": "nai negative",
            "model": "drop",
            "characters": [
                {
                    "id": "c1",
                    "name": "Hero",
                    "enabled": True,
                    "use_coords": True,
                    "positive": "hero",
                    "negative": "bad",
                    "x": 0.0,
                    "y": 1.0,
                },
                {"positive": "sidekick"},
            ],
            "parameters": {"steps": 28, "seed": 99, "width": 832},
        }
        copied = copy_nai_payload(original)
        self.assertEqual(
            copied,
            {
                "content": "nai positive",
                "negative": "nai negative",
                "characters": [
                    {
                        "positive": "hero",
                        "negative": "bad",
                        "x": 0.0,
                        "y": 1.0,
                    },
                    {"positive": "sidekick"},
                ],
                "parameters": {"steps": 28, "width": 832},
            },
        )
        copied["content"] = "mutated"
        copied["characters"][0]["positive"] = "mutated"
        copied["parameters"]["steps"] = 1
        self.assertEqual(original["content"], "nai positive")
        self.assertEqual(original["characters"][0]["positive"], "hero")
        self.assertEqual(original["parameters"]["steps"], 28)

    def test_copy_empty_and_non_object_values(self) -> None:
        self.assertEqual(copy_nai_payload(None), {})
        self.assertEqual(copy_nai_payload([]), {})
        self.assertEqual(copy_nai_payload({}), {})


class NaiDocumentHelperTests(unittest.TestCase):
    def test_empty_nai_payload(self) -> None:
        self.assertEqual(empty_nai_payload(), {})

    def test_nai_from_document(self) -> None:
        document = PromptDocument(
            format="json_card",
            options=("hello",),
            raw_content="hello",
            nai={"parameters": {"steps": 23}},
        )
        self.assertEqual(
            nai_from_document(document),
            {"parameters": {"steps": 23}},
        )


class NaiJsonRoundTripTests(unittest.TestCase):
    def _card_path(self, tmp: str) -> Path:
        return Path(tmp) / "card.json"

    def test_write_read_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            nai = dict(FULL_NAI)
            _write_json_prompt(
                path,
                content="positive prompt",
                negative="negative",
                note="note",
                nai=nai,
            )
            document = _read_json_prompt(path)
            self.assertEqual(document["nai"], FULL_NAI)

    def test_read_prompt_document_includes_nai(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            _write_json_prompt(
                path,
                content="positive prompt",
                negative="",
                note="",
                nai={"parameters": {"cfg": 7.0}},
            )
            document = read_prompt_document(path)
            self.assertEqual(
                document.nai,
                {"parameters": {"cfg": 7.0}},
            )

    def test_write_without_nai_preserves_legacy_json(self) -> None:
        legacy = {
            "content": "positive prompt",
            "negative": "negative prompt",
            "note": "my note",
            "parameters": {"seed": 99, "steps": 20},
            "models": [{"type": "checkpoint", "name": "model.safetensors"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps(legacy, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            _write_json_prompt(
                path,
                content="positive prompt",
                negative="negative prompt",
                note="my note",
                models=legacy["models"],
                parameters=legacy["parameters"],
            )
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn("nai", written)
            self.assertEqual(written["parameters"], legacy["parameters"])
            self.assertEqual(written["models"], legacy["models"])

    def test_read_legacy_json_without_nai(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps(
                    {
                        "content": "positive prompt",
                        "negative": "",
                        "note": "",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            document = read_prompt_document(path)
            self.assertEqual(document.nai, {})

    def test_txt_document_has_empty_nai(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wildcard.txt"
            path.write_text("line one\nline two\n", encoding="utf-8")
            document = read_prompt_document(path)
            self.assertEqual(document.nai, {})


class NaiIndependenceTests(unittest.TestCase):
    def test_nai_and_comfy_parameters_are_independent(self) -> None:
        payload = {
            "model": "nai-diffusion-4-5-full",
            "parameters": {
                "width": 832,
                "denoise": 0.5,
                "seed": 1,
                "steps": 23,
            },
        }
        nai = normalize_nai_payload(payload)
        self.assertEqual(nai, {"parameters": {"width": 832, "steps": 23}})

    def test_comfy_parameters_unaffected_by_nai_in_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "card.json"
            path.write_text(
                json.dumps(
                    {
                        "content": "positive prompt",
                        "negative": "",
                        "note": "",
                        "parameters": {"seed": 10, "steps": 25},
                        "nai": FULL_NAI,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            document = _read_json_prompt(path)
            self.assertEqual(document["parameters"], {"seed": 10, "steps": 25})
            self.assertEqual(document["nai"], FULL_NAI)


class NaiPromptFieldTests(unittest.TestCase):
    def test_content_and_negative_are_preserved_and_empties_omitted(self) -> None:
        result = normalize_nai_payload(
            {
                "content": "  nai positive  ",
                "negative": "  nai negative  ",
                "parameters": {"steps": 23},
            }
        )
        self.assertEqual(
            result,
            {
                "content": "nai positive",
                "negative": "nai negative",
                "parameters": {"steps": 23},
            },
        )
        self.assertEqual(
            normalize_nai_payload({"content": "", "negative": "   ", "parameters": {}}),
            {},
        )

    def test_comment_only_nai_content_is_omitted(self) -> None:
        self.assertEqual(
            normalize_nai_payload({"content": "# comment only", "negative": ""}),
            {},
        )

    def test_non_string_nai_prompts_raise(self) -> None:
        with self.assertRaisesRegex(ValueError, "nai.content 必须是字符串"):
            normalize_nai_payload({"content": ["not", "text"]})
        with self.assertRaisesRegex(ValueError, "nai.negative 必须是字符串"):
            normalize_nai_payload({"negative": 12})

    def test_unknown_and_deprecated_prompt_keys_discarded(self) -> None:
        result = normalize_nai_payload(
            {
                "content": "keep",
                "negative": "neg",
                "model": "nai-diffusion-5-full",
                "version": 1,
                "enabled": True,
                "uc": "legacy",
                "parameters": {"steps": 23, "seed": 1, "width": 832},
            }
        )
        self.assertEqual(
            result,
            {
                "content": "keep",
                "negative": "neg",
                "parameters": {"steps": 23, "width": 832},
            },
        )
        self.assertNotIn("model", result)
        self.assertNotIn("uc", result)


class NaiCharacterSchemaTests(unittest.TestCase):
    def test_auto_position_characters_have_no_xy(self) -> None:
        result = normalize_nai_payload(
            {
                "characters": [
                    {
                        "id": "c1",
                        "name": "Hero",
                        "enabled": True,
                        "use_coords": False,
                        "positive": "hero",
                        "negative": "bad",
                        "selected": True,
                    },
                    {"positive": "sidekick"},
                ]
            }
        )
        self.assertEqual(
            result,
            {
                "characters": [
                    {"positive": "hero", "negative": "bad"},
                    {"positive": "sidekick"},
                ]
            },
        )
        self.assertNotIn("x", result["characters"][0])
        self.assertNotIn("y", result["characters"][0])

    def test_manual_coords_are_paired_finite_and_clamped(self) -> None:
        result = normalize_nai_payload(
            {
                "characters": [
                    {"positive": "hero", "x": -0.2, "y": 1.7},
                    {"positive": "sidekick", "x": 0, "y": 1},
                ]
            }
        )
        self.assertEqual(
            result["characters"],
            [
                {"positive": "hero", "x": 0.0, "y": 1.0},
                {"positive": "sidekick", "x": 0.0, "y": 1.0},
            ],
        )

    def test_zero_coords_are_kept(self) -> None:
        result = normalize_nai_payload(
            {"characters": [{"positive": "hero", "x": 0.0, "y": 0.0}]}
        )
        self.assertEqual(
            result["characters"],
            [{"positive": "hero", "x": 0.0, "y": 0.0}],
        )

    def test_coord_only_character_is_kept(self) -> None:
        result = normalize_nai_payload(
            {"characters": [{"x": 0.25, "y": 0.75}]}
        )
        self.assertEqual(result["characters"], [{"x": 0.25, "y": 0.75}])

    def test_empty_characters_and_unknown_only_items_omitted(self) -> None:
        self.assertEqual(
            normalize_nai_payload(
                {
                    "characters": [
                        {},
                        {"id": "x", "name": "Hero", "enabled": False},
                    ]
                }
            ),
            {},
        )

    def test_unpaired_xy_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "x 与 y 必须成对出现"):
            normalize_nai_payload({"characters": [{"positive": "hero", "x": 0.5}]})
        with self.assertRaisesRegex(ValueError, "x 与 y 必须成对出现"):
            normalize_nai_payload({"characters": [{"positive": "hero", "y": 0.5}]})

    def test_mixed_coords_stay_sparse_per_character(self) -> None:
        result = normalize_nai_payload(
            {
                "characters": [
                    {"positive": "hero", "x": 0.2, "y": 0.8},
                    {"positive": "sidekick"},
                ]
            }
        )
        self.assertEqual(
            result["characters"],
            [
                {"positive": "hero", "x": 0.2, "y": 0.8},
                {"positive": "sidekick"},
            ],
        )

    def test_non_finite_coords_raise(self) -> None:
        with self.assertRaisesRegex(ValueError, "x 必须是有效数字"):
            normalize_nai_payload(
                {"characters": [{"positive": "hero", "x": float("nan"), "y": 0.5}]}
            )

    def test_characters_must_be_object_array(self) -> None:
        with self.assertRaisesRegex(ValueError, "nai.characters 必须是数组"):
            normalize_nai_payload({"characters": {}})
        with self.assertRaisesRegex(ValueError, "nai.characters 项必须是对象"):
            normalize_nai_payload({"characters": ["hero"]})

    def test_character_prompt_types_validated(self) -> None:
        with self.assertRaisesRegex(ValueError, "nai.characters.positive 必须是字符串"):
            normalize_nai_payload({"characters": [{"positive": 1}]})
        with self.assertRaisesRegex(ValueError, "nai.characters.negative 必须是字符串"):
            normalize_nai_payload({"characters": [{"negative": False}]})


class NaiPositiveValidityTests(unittest.TestCase):
    def test_legacy_top_level_content_is_enough(self) -> None:
        self.assertTrue(card_has_positive_prompt("comfy", {}))
        self.assertTrue(card_has_positive_prompt("comfy", {"parameters": {"steps": 23}}))

    def test_nai_content_is_enough(self) -> None:
        self.assertTrue(card_has_positive_prompt("", {"content": "nai positive"}))
        self.assertTrue(card_has_positive_prompt("   ", {"content": "nai positive"}))

    def test_both_empty_is_invalid(self) -> None:
        self.assertFalse(card_has_positive_prompt("", {}))
        self.assertFalse(card_has_positive_prompt("", {"parameters": {"steps": 23}}))
        self.assertFalse(
            card_has_positive_prompt("", {"characters": [{"positive": "hero"}]})
        )

    def _card_path(self, tmp: str) -> Path:
        return Path(tmp) / "card.json"

    def test_read_legacy_card_without_nai_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps(
                    {
                        "content": "legacy positive",
                        "negative": "legacy negative",
                        "note": "legacy note",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            document = _read_json_prompt(path)
            self.assertEqual(document["content"], "legacy positive")
            self.assertEqual(document["negative"], "legacy negative")
            self.assertEqual(document["nai"], {})

    def test_read_nai_only_card_allows_empty_top_level_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps(
                    {
                        "content": "",
                        "negative": "",
                        "note": "",
                        "nai": {"content": "nai positive", "negative": "nai negative"},
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            document = _read_json_prompt(path)
            self.assertEqual(document["content"], "")
            self.assertEqual(
                document["nai"],
                {"content": "nai positive", "negative": "nai negative"},
            )

    def test_read_nai_only_card_missing_top_level_content_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps({"nai": {"content": "nai only"}}, ensure_ascii=False)
                + "\n",
                encoding="utf-8",
            )
            document = _read_json_prompt(path)
            self.assertEqual(document["content"], "")
            self.assertEqual(document["nai"], {"content": "nai only"})

    def test_read_rejects_empty_content_and_empty_nai_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            path.write_text(
                json.dumps(
                    {
                        "content": "",
                        "nai": {
                            "parameters": {"steps": 23},
                            "characters": [{"positive": "hero"}],
                        },
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError, "content 或 nai.content 至少一个不能为空"
            ):
                _read_json_prompt(path)

    def test_write_keeps_top_level_fields_and_omits_empty_nai_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            _write_json_prompt(
                path,
                content="",
                negative="",
                note="kept note",
                nai={
                    "content": "nai positive",
                    "negative": "",
                    "characters": [],
                    "parameters": {},
                    "model": "drop",
                },
            )
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(written["content"], "")
            self.assertEqual(written["negative"], "")
            self.assertEqual(written["note"], "kept note")
            self.assertEqual(written["nai"], {"content": "nai positive"})
            self.assertNotIn("negative", written["nai"])
            self.assertNotIn("characters", written["nai"])
            self.assertNotIn("parameters", written["nai"])
            self.assertNotIn("model", written["nai"])

    def test_round_trip_full_nai_card(self) -> None:
        nai = {
            "content": "nai positive",
            "negative": "nai negative",
            "characters": [
                {"positive": "hero", "negative": "villain", "x": 0.25, "y": 0.75},
                {"positive": "sidekick", "x": 0.0, "y": 1.0},
            ],
            "parameters": {
                "steps": 28,
                "cfg": 5.0,
                "sampler": "k_euler",
                "scheduler": "native",
                "cfg_rescale": 0.2,
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            _write_json_prompt(
                path,
                content="comfy positive",
                negative="comfy negative",
                note="note",
                nai={
                    **nai,
                    "model": "drop",
                    "characters": [
                        {
                            **nai["characters"][0],
                            "id": "c1",
                            "name": "Hero",
                            "enabled": True,
                            "use_coords": True,
                        },
                        {
                            **nai["characters"][1],
                            "uc": "drop",
                        },
                    ],
                    "parameters": {**nai["parameters"], "seed": 99, "smea": "SMEA"},
                },
            )
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(written["content"], "comfy positive")
            self.assertEqual(written["negative"], "comfy negative")
            self.assertEqual(written["nai"], nai)
            document = read_prompt_document(path)
            self.assertEqual(document.raw_content, "comfy positive")
            self.assertEqual(document.negative, "comfy negative")
            self.assertEqual(document.nai, nai)

    def test_round_trip_nai_only_and_auto_position_characters(self) -> None:
        nai = {
            "content": "nai only",
            "characters": [
                {"positive": "hero"},
                {"positive": "sidekick", "negative": "crowd"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            _write_json_prompt(path, content="", negative="", note="", nai=nai)
            document = _read_json_prompt(path)
            self.assertEqual(document["content"], "")
            self.assertEqual(document["nai"], nai)
            self.assertNotIn("x", document["nai"]["characters"][0])

    def test_write_rejects_empty_positive_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = self._card_path(tmp)
            with self.assertRaisesRegex(
                ValueError, "content 或 nai.content 至少一个不能为空"
            ):
                _write_json_prompt(
                    path,
                    content="",
                    negative="neg",
                    note="",
                    nai={"parameters": {"steps": 23}},
                )


if __name__ == "__main__":
    unittest.main()
