"""Contract tests for read-only Anima/ComfyUI to NovelAI weight display."""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from domain.anima_to_nai import PromptSyntaxError, convert_prompt, convert_prompts
from domain.nai_to_anima import (
    convert_prompt as convert_nai_to_anima,
    convert_prompt_tolerant as convert_nai_to_anima_tolerant,
)


class AnimaToNaiConversionTests(unittest.TestCase):
    def test_converts_explicit_and_default_parenthesis_weights(self) -> None:
        self.assertEqual(convert_prompt("(text:1.2)"), "1.2::text::")
        self.assertEqual(convert_prompt("(text)"), "1.1::text::")

    def test_compact_closer_does_not_insert_space_for_unspaced_source(self) -> None:
        self.assertEqual(
            convert_prompt("1girl, (detailed eyes:1.3), ((warm rim light)), city street"),
            "1girl, 1.3::detailed eyes::, 1.1::1.1::warm rim light::::, city street",
        )
        self.assertEqual(
            convert_prompt("lowres, (bad hands:1.2), blurry"),
            "lowres, 1.2::bad hands::, blurry",
        )
        self.assertNotIn(" ::", convert_prompt("(detailed eyes:1.3)"))
        self.assertNotIn(" ::", convert_prompt("(bad hands:1.2)"))

    def test_normalizes_numeric_output_without_float_approximation(self) -> None:
        cases = {
            "(a:1.0500)": "1.05::a::",
            "(b:+1.200)": "1.2::b::",
            "(c:-2.000)": "-2::c::",
            "(d:-0.000)": "0::d::",
            "(e:1e2)": "100::e::",
            "(f:1e-2)": "0.01::f::",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(convert_prompt(prompt), expected)

    def test_preserves_nested_group_structure_and_authored_spacing(self) -> None:
        prompt = "(outer, ( inner :1.25),\n tail:0.5)"
        self.assertEqual(
            convert_prompt(prompt),
            "0.5::outer, 1.25:: inner ::,\n tail::",
        )

    def test_preserves_square_curly_and_wildcard_syntax_verbatim(self) -> None:
        prompt = "[(scheduled:1.2)], {(inside:1.3)}, __wildcard__, [from:(to):0.5]"
        self.assertEqual(convert_prompt(prompt), prompt)

    def test_preserves_escaped_literal_parentheses_like_existing_converter(self) -> None:
        prompt = r"\(literal\), \(x:1.2\), (weighted)"
        expected = r"\(literal\), \(x:1.2\), 1.1::weighted::"
        self.assertEqual(convert_prompt(prompt), expected)
        self.assertEqual(convert_nai_to_anima(r"\(literal\)"), r"\(literal\)")

    def test_only_unescaped_colon_can_delimit_an_explicit_weight(self) -> None:
        self.assertEqual(
            convert_prompt(r"(x\:1.2)"),
            r"1.1::x\:1.2::",
        )
        self.assertEqual(
            convert_prompt(r"(x\\:1.2)"),
            r"1.2::x\\::",
        )

    def test_compact_closer_keeps_numeric_text_parseable(self) -> None:
        cases = {
            "(version 1.2)": (
                "1.1::version 1.2::",
                "(version 1.2:1.25)",
            ),
            "(year 2026)": (
                "1.1::year 2026::",
                "(year 2026:1.25)",
            ),
            r"(x\:1.2)": (
                r"1.1::x\:1.2::",
                r"(x\:1.2:1.25)",
            ),
            "(outer (inner 2026):1.2)": (
                "1.2::outer 1.1::inner 2026::::",
                "(outer (inner 2026:1.25):1.30)",
            ),
        }
        for prompt, (expected_nai, expected_roundtrip) in cases.items():
            with self.subTest(prompt=prompt):
                nai_prompt = convert_prompt(prompt)
                self.assertEqual(nai_prompt, expected_nai)
                self.assertEqual(
                    convert_nai_to_anima(nai_prompt),
                    expected_roundtrip,
                )
                tolerant = convert_nai_to_anima_tolerant(nai_prompt)
                self.assertFalse(tolerant.repaired)
                self.assertEqual(tolerant.text, expected_roundtrip)

    def test_safe_opener_separator_only_follows_ambiguous_characters(self) -> None:
        cases = {
            "foo2(bar)": (
                "foo2 1.1::bar::",
                "foo2 (bar:1.25)",
            ),
            "foo-(bar)": (
                "foo- 1.1::bar::",
                "foo- (bar:1.25)",
            ),
            "foo.(bar)": (
                "foo. 1.1::bar::",
                "foo. (bar:1.25)",
            ),
            "(outer2(inner))": (
                "1.1::outer2 1.1::inner::::",
                "(outer2 (inner:1.25):1.25)",
            ),
            "foo,(bar)": (
                "foo,1.1::bar::",
                "foo,(bar:1.25)",
            ),
            "foo (bar)": (
                "foo 1.1::bar::",
                "foo (bar:1.25)",
            ),
        }
        for prompt, (expected_nai, expected_roundtrip) in cases.items():
            with self.subTest(prompt=prompt):
                nai_prompt = convert_prompt(prompt)
                self.assertEqual(nai_prompt, expected_nai)
                self.assertEqual(
                    convert_nai_to_anima(nai_prompt),
                    expected_roundtrip,
                )

    def test_rejects_literal_nai_closer_but_preserves_escaped_colons(self) -> None:
        with self.assertRaisesRegex(PromptSyntaxError, "unescaped.*::"):
            convert_prompt("(x::y)")
        with self.assertRaisesRegex(PromptSyntaxError, "unescaped.*::"):
            convert_prompt(r"(x\::y)")

        nai_prompt = convert_prompt(r"(x\:\:y:1.2)")
        self.assertEqual(nai_prompt, r"1.2::x\:\:y::")
        self.assertEqual(
            convert_nai_to_anima(nai_prompt),
            r"(x\:\:y:1.30)",
        )

    def test_preserves_control_characters_verbatim(self) -> None:
        self.assertEqual(
            convert_prompt("\x1b, (weighted)"),
            "\x1b, 1.1::weighted::",
        )

    def test_only_last_top_level_finite_number_is_an_explicit_weight(self) -> None:
        cases = {
            "(artist:foo)": "1.1::artist:foo::",
            "(artist:foo:1.2)": "1.2::artist:foo::",
            "(outer:(inner:1.25):0.5)": "0.5::outer:1.25::inner::::",
            "(zero:0)": "0::zero::",
            "(negative:-0.75)": "-0.75::negative::",
            "(x:NaN)": "1.1::x:NaN::",
            "(x:Inf)": "1.1::x:Inf::",
            "(x:-Infinity)": "1.1::x:-Infinity::",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(convert_prompt(prompt), expected)

    def test_scientific_zero_is_stable_and_large_nonzero_weight_is_rejected(
        self,
    ) -> None:
        self.assertEqual(
            convert_prompt("(x:0e999999999999999999999999)"),
            "0::x::",
        )
        self.assertEqual(convert_prompt("(x:1.25e2)"), "125::x::")
        reducible = "1" + ("0" * 300) + "e-300"
        self.assertEqual(convert_prompt(f"(x:{reducible})"), "1::x::")
        with self.assertRaisesRegex(PromptSyntaxError, "256"):
            convert_prompt("(x:1e256)")
        with self.assertRaisesRegex(PromptSyntaxError, "256"):
            convert_prompt("(x:1e999999999999999999999999)")

    def test_rejects_unbalanced_or_empty_parenthesis_groups(self) -> None:
        cases = {
            "text)": "unexpected closing",
            "(text": "missing closing",
            "()": "empty weighted group",
            "(   )": "empty weighted group",
            "(:1.2)": "empty weighted group",
            "(outer, ())": "empty weighted group",
        }
        for prompt, message in cases.items():
            with self.subTest(prompt=prompt):
                with self.assertRaisesRegex(PromptSyntaxError, message):
                    convert_prompt(prompt)

    def test_batch_helper_preserves_order_and_length(self) -> None:
        prompts = ["plain", "(cat:1.2)", "[scheduled]", "(dog)"]
        self.assertEqual(
            convert_prompts(prompts),
            ["plain", "1.2::cat::", "[scheduled]", "1.1::dog::"],
        )

    def test_single_and_batch_conversion_enforce_configurable_output_budget(
        self,
    ) -> None:
        self.assertEqual(
            convert_prompt("(abcd)", max_output_chars=11),
            "1.1::abcd::",
        )
        with self.assertRaisesRegex(ValueError, "output.*limit"):
            convert_prompt("(abcd)", max_output_chars=10)

        self.assertEqual(
            convert_prompts(["(a)", "(b)"], max_output_chars=16),
            ["1.1::a::", "1.1::b::"],
        )
        with self.assertRaisesRegex(ValueError, "output.*limit"):
            convert_prompts(["(a)", "(b)"], max_output_chars=15)

    def test_roundtrip_keeps_nested_explicit_weight_structure(self) -> None:
        nai_prompt = convert_prompt("(outer, (inner:1.2):0.5)")
        self.assertEqual(nai_prompt, "0.5::outer, 1.2::inner::::")
        self.assertEqual(
            convert_nai_to_anima(nai_prompt),
            "(outer, (inner:1.30):0.25)",
        )


class Request:
    def __init__(self, body=None, *, error: Exception | None = None) -> None:
        self.body = body
        self.error = error

    async def json(self):
        if self.error is not None:
            raise self.error
        return self.body


class AnimaToNaiApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_route_is_registered_as_a_separate_post_endpoint(self) -> None:
        from server import routes, routes_tools

        matching = [
            (method, handler)
            for method, path, handler in routes._API_ROUTES
            if path == "/pm4a/api/convert/anima-to-nai"
        ]
        self.assertEqual(matching, [("POST", routes_tools.handle_anima_to_nai)])
        self.assertIn(
            ("POST", "/pm4a/api/convert/nai-to-anima", routes_tools.handle_nai_to_anima),
            routes._API_ROUTES,
        )

    async def test_single_conversion_returns_text_without_mutating_request(self) -> None:
        from server import routes_tools

        body = {"text": "(cat:1.2)"}
        response = await routes_tools.handle_anima_to_nai(Request(body))

        self.assertEqual(response.status, 200)
        self.assertEqual(
            json.loads(response.text),
            {"success": True, "text": "1.2::cat::"},
        )
        self.assertEqual(body, {"text": "(cat:1.2)"})

    async def test_batch_conversion_is_ordered_and_matches_existing_shape(self) -> None:
        from server import routes_tools

        response = await routes_tools.handle_anima_to_nai(
            Request({"texts": ["plain", "(cat)", "(dog:0.75)"]})
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            json.loads(response.text),
            {
                "success": True,
                "results": [
                    {"text": "plain"},
                    {"text": "1.1::cat::"},
                    {"text": "0.75::dog::"},
                ],
            },
        )

    async def test_syntax_errors_are_localized_bad_requests(self) -> None:
        from server import routes_tools

        response = await routes_tools.handle_anima_to_nai(
            Request({"text": "(broken"})
        )
        payload = json.loads(response.text)

        self.assertEqual(response.status, 400)
        self.assertFalse(payload["success"])
        self.assertIn("Anima 权重转换失败", payload["error"])
        self.assertIn("missing closing", payload["error"])

    async def test_delimiter_and_weight_syntax_errors_return_400(self) -> None:
        from server import routes_tools

        delimiter = await routes_tools.handle_anima_to_nai(
            Request({"text": "(x::y)"})
        )
        huge_weight = await routes_tools.handle_anima_to_nai(
            Request({"text": "(x:1e256)"})
        )

        self.assertEqual(delimiter.status, 400)
        self.assertEqual(huge_weight.status, 400)

    async def test_rejects_invalid_json_and_payload_types(self) -> None:
        from server import routes_tools

        invalid_json = await routes_tools.handle_anima_to_nai(
            Request(error=ValueError("bad json"))
        )
        invalid_text = await routes_tools.handle_anima_to_nai(
            Request({"text": 123})
        )
        invalid_texts = await routes_tools.handle_anima_to_nai(
            Request({"texts": ["ok", 123]})
        )

        self.assertEqual(invalid_json.status, 400)
        self.assertEqual(invalid_text.status, 400)
        self.assertEqual(invalid_texts.status, 400)

    async def test_enforces_same_single_and_batch_limits(self) -> None:
        from server import routes_tools

        too_long = await routes_tools.handle_anima_to_nai(
            Request({"text": "x" * 2_000_001})
        )
        too_many = await routes_tools.handle_anima_to_nai(
            Request({"texts": ["x"] * 101})
        )
        too_large_batch = await routes_tools.handle_anima_to_nai(
            Request({"texts": ["x" * 1_000_001, "y" * 1_000_000]})
        )

        self.assertEqual(too_long.status, 413)
        self.assertEqual(too_many.status, 413)
        self.assertEqual(too_large_batch.status, 413)

    async def test_single_and_batch_output_budget_errors_return_413(self) -> None:
        from server import routes_tools

        with patch.object(
            routes_tools,
            "MAX_CONVERSION_OUTPUT_CHARS",
            10,
            create=True,
        ):
            single = await routes_tools.handle_anima_to_nai(
                Request({"text": "(abcd)"})
            )
        with patch.object(
            routes_tools,
            "MAX_CONVERSION_OUTPUT_CHARS",
            15,
            create=True,
        ):
            batch = await routes_tools.handle_anima_to_nai(
                Request({"texts": ["(a)", "(b)"]})
            )

        self.assertEqual(single.status, 413)
        self.assertEqual(batch.status, 413)


if __name__ == "__main__":
    unittest.main()
