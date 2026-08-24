"""Tests for NovelAI-isolated wildcard parsing and expansion."""

from __future__ import annotations

import unittest
from typing import Sequence

from domain.nai_wildcard_syntax import (
    copy_nai_payload,
    expand,
    merge_nai_payloads,
    parse,
    reference_keys,
    sequential_leaf_count,
    sequential_reference_keys,
)
from domain.wildcard_syntax import (
    ExpansionContext,
    WildcardCandidate,
    WildcardResolutionError,
    WildcardSyntaxError,
)


class DictResolver:
    def __init__(self, mapping: dict[str, Sequence[WildcardCandidate]]) -> None:
        self._mapping = mapping

    def resolve(self, key: str) -> Sequence[WildcardCandidate]:
        return self._mapping.get(key, ())


def _candidate(
    key: str,
    content: str,
    *,
    negative: str = "",
    lora_text: str = "",
    models: tuple[dict, ...] = (),
    parameters: dict | None = None,
    double_sample_parameters: dict | None = None,
    nai: dict | None = None,
) -> WildcardCandidate:
    return WildcardCandidate(
        key=key,
        content=content,
        negative=negative,
        lora_text=lora_text,
        models=models,
        parameters=parameters or {},
        double_sample_parameters=double_sample_parameters or {},
        nai=nai or {},
    )


class NaiLiteralPreservationTests(unittest.TestCase):
    def test_braces_pipes_and_weights_stay_literal(self) -> None:
        text = "{a|b} [tag] 1.5::foo:: | $$"
        result = expand(
            text,
            DictResolver({}),
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, text)

    def test_n_hash_reference_stays_literal_one_digit(self) -> None:
        resolver = DictResolver({"foo": (_candidate("foo", "expanded"),)})
        result = expand(
            "3#__foo__",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "3#__foo__")
        self.assertEqual(result.selected_keys, ())

    def test_n_hash_reference_stays_literal_multi_digit(self) -> None:
        resolver = DictResolver({"bar": (_candidate("bar", "expanded"),)})
        result = expand(
            "12#__bar__",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "12#__bar__")

    def test_malformed_n_hash_unclosed_stays_literal_on_expand(self) -> None:
        resolver = DictResolver({"open": (_candidate("open", "expanded"),)})
        result = expand(
            "3#__open",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "3#__open")
        self.assertEqual(result.selected_keys, ())

    def test_malformed_n_hash_empty_key_stays_literal_on_expand(self) -> None:
        result = expand(
            "12#____",
            DictResolver({}),
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "12#____")
        self.assertEqual(result.selected_keys, ())

    def test_reference_inside_braces_expands(self) -> None:
        resolver = DictResolver({"scene": (_candidate("scene", "forest"),)})
        result = expand(
            "{__scene__}",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "{forest}")


class NaiReferenceParsingTests(unittest.TestCase):
    def test_reference_keys_in_order(self) -> None:
        self.assertEqual(reference_keys("__a__ and __b__"), ("a", "b"))

    def test_sequential_reference_keys_includes_brace_and_bracket_refs(self) -> None:
        self.assertEqual(
            sequential_reference_keys("__a__ {__b__} [__c__] 3#__d__"),
            ("a", "b", "c"),
        )

    def test_malformed_n_hash_unclosed_stays_literal_on_parse(self) -> None:
        nodes = parse("3#__open")
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0].text, "3#__open")

    def test_malformed_n_hash_empty_key_stays_literal_on_parse(self) -> None:
        nodes = parse("12#____")
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0].text, "12#____")

    def test_empty_reference_raises(self) -> None:
        with self.assertRaises(WildcardSyntaxError):
            parse("____")

    def test_unclosed_reference_raises(self) -> None:
        with self.assertRaises(WildcardSyntaxError):
            parse("__open")

    def test_whitespace_stripped_from_key(self) -> None:
        resolver = DictResolver({"foo": (_candidate("foo", "ok"),)})
        result = expand(
            "__  foo  __",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "ok")


class NaiRecursiveExpansionTests(unittest.TestCase):
    def test_nested_reference_in_candidate_content(self) -> None:
        resolver = DictResolver(
            {
                "outer": (_candidate("outer", "see __inner__"),),
                "inner": (_candidate("inner", "deep"),),
            }
        )
        result = expand(
            "__outer__",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "see deep")
        self.assertEqual(result.selected_keys, ("outer", "inner"))

    def test_nai_braces_in_candidate_content_stay_literal(self) -> None:
        resolver = DictResolver(
            {
                "card": (_candidate("card", "{a|b} __leaf__"),),
                "leaf": (_candidate("leaf", "x"),),
            }
        )
        result = expand(
            "__card__",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "{a|b} x")


class NaiSequenceModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.resolver = DictResolver(
            {
                "a": (
                    _candidate("a", "A1"),
                    _candidate("a", "A2"),
                ),
                "b": (
                    _candidate("b", "B1"),
                    _candidate("b", "B2"),
                    _candidate("b", "B3"),
                ),
            }
        )

    def test_leaf_count_sums_branches_and_multiplies_top_level(self) -> None:
        self.assertEqual(sequential_leaf_count("__a__ __b__", self.resolver), 6)

    def test_sequence_rightmost_varies_fastest(self) -> None:
        context = ExpansionContext(seed=1, mode="sequence", execution_index=0)
        self.assertEqual(
            expand("__a__ __b__", self.resolver, context).text,
            "A1 B1",
        )
        context = ExpansionContext(seed=1, mode="sequence", execution_index=1)
        self.assertEqual(
            expand("__a__ __b__", self.resolver, context).text,
            "A1 B2",
        )
        context = ExpansionContext(seed=1, mode="sequence", execution_index=3)
        self.assertEqual(
            expand("__a__ __b__", self.resolver, context).text,
            "A2 B1",
        )

    def test_brace_wrapped_refs_share_sequence_leaf_space(self) -> None:
        self.assertEqual(sequential_leaf_count("__a__ {__b__}", self.resolver), 6)
        context = ExpansionContext(seed=1, mode="sequence", execution_index=0)
        self.assertEqual(
            expand("__a__ {__b__}", self.resolver, context).text,
            "A1 {B1}",
        )
        context = ExpansionContext(seed=1, mode="sequence", execution_index=1)
        self.assertEqual(
            expand("__a__ {__b__}", self.resolver, context).text,
            "A1 {B2}",
        )
        context = ExpansionContext(seed=1, mode="sequence", execution_index=3)
        self.assertEqual(
            expand("__a__ {__b__}", self.resolver, context).text,
            "A2 {B1}",
        )

    def test_bracket_wrapped_single_ref_sequence(self) -> None:
        resolver = DictResolver(
            {
                "x": (
                    _candidate("x", "X1"),
                    _candidate("x", "X2"),
                ),
            }
        )
        self.assertEqual(sequential_leaf_count("[__x__]", resolver), 2)
        self.assertEqual(
            expand(
                "[__x__]",
                resolver,
                ExpansionContext(seed=1, mode="sequence", execution_index=0),
            ).text,
            "[X1]",
        )
        self.assertEqual(
            expand(
                "[__x__]",
                resolver,
                ExpansionContext(seed=1, mode="sequence", execution_index=1),
            ).text,
            "[X2]",
        )

    def test_brace_wrapped_single_ref_sequence(self) -> None:
        resolver = DictResolver(
            {
                "x": (
                    _candidate("x", "only"),
                    _candidate("x", "other"),
                ),
            }
        )
        self.assertEqual(sequential_leaf_count("{__x__}", resolver), 2)
        self.assertEqual(
            expand(
                "{__x__}",
                resolver,
                ExpansionContext(seed=1, mode="sequence", execution_index=0),
            ).text,
            "{only}",
        )
        self.assertEqual(
            expand(
                "{__x__}",
                resolver,
                ExpansionContext(seed=1, mode="sequence", execution_index=1),
            ).text,
            "{other}",
        )


class NaiRandomModeTests(unittest.TestCase):
    def test_same_seed_is_deterministic(self) -> None:
        resolver = DictResolver(
            {
                "pick": tuple(
                    _candidate("pick", f"v{i}") for i in range(5)
                ),
            }
        )
        ctx_a = ExpansionContext(seed=42, mode="random", track_id="t1")
        ctx_b = ExpansionContext(seed=42, mode="random", track_id="t1")
        self.assertEqual(
            expand("__pick__", resolver, ctx_a).text,
            expand("__pick__", resolver, ctx_b).text,
        )

    def test_different_seed_can_differ(self) -> None:
        resolver = DictResolver(
            {
                "pick": tuple(
                    _candidate("pick", f"v{i}") for i in range(20)
                ),
            }
        )
        results = {
            expand(
                "__pick__",
                resolver,
                ExpansionContext(seed=seed, mode="random"),
            ).text
            for seed in range(8)
        }
        self.assertGreater(len(results), 1)


class NaiShuffleModeTests(unittest.TestCase):
    def test_shuffle_cycles_through_permutation(self) -> None:
        resolver = DictResolver(
            {
                "s": tuple(_candidate("s", f"v{i}") for i in range(3)),
            }
        )
        context = ExpansionContext(
            seed=7,
            mode="shuffle",
            track_id="track",
            execution_index=0,
        )
        seen = [
            expand("__s__", resolver, replace_context(context, i)).text
            for i in range(6)
        ]
        for start in (0, 3):
            cycle = seen[start : start + 3]
            self.assertEqual(len(set(cycle)), 3)

    def test_shuffle_differs_from_sequence_over_full_cycle(self) -> None:
        resolver = DictResolver(
            {
                "s": tuple(_candidate("s", f"v{i}") for i in range(4)),
            }
        )
        seq = [
            expand(
                "__s__",
                resolver,
                ExpansionContext(seed=99, mode="sequence", execution_index=i),
            ).text
            for i in range(4)
        ]
        shuf = [
            expand(
                "__s__",
                resolver,
                ExpansionContext(
                    seed=99, mode="shuffle", track_id="t", execution_index=i
                ),
            ).text
            for i in range(4)
        ]
        self.assertNotEqual(seq, shuf)

    def test_brace_wrapped_single_ref_shuffle(self) -> None:
        resolver = DictResolver(
            {
                "s": tuple(_candidate("s", f"v{i}") for i in range(3)),
            }
        )
        context = ExpansionContext(
            seed=7,
            mode="shuffle",
            track_id="track",
            execution_index=0,
        )
        seen = [
            expand("{__s__}", resolver, replace_context(context, i)).text
            for i in range(6)
        ]
        self.assertEqual(seen[0], "{v1}")
        for start in (0, 3):
            cycle = [value[1:-1] for value in seen[start : start + 3]]
            self.assertEqual(len(set(cycle)), 3)


def replace_context(context: ExpansionContext, execution_index: int) -> ExpansionContext:
    return ExpansionContext(
        seed=context.seed,
        mode=context.mode,
        execution_index=execution_index,
        track_id=context.track_id,
        max_depth=context.max_depth,
    )


class NaiMetadataTests(unittest.TestCase):
    def test_companion_negatives_record_parallel_owner_keys(self) -> None:
        resolver = DictResolver(
            {
                "a": (
                    _candidate(
                        "a",
                        "__inner__",
                        negative="neg-a",
                    ),
                ),
                "inner": (
                    _candidate(
                        "inner",
                        "inner",
                        negative="neg-inner",
                    ),
                ),
                "b": (
                    _candidate(
                        "b",
                        "B",
                        negative="neg-b",
                    ),
                ),
            }
        )

        result = expand(
            "__a__ __b__",
            resolver,
            ExpansionContext(seed=1, mode="sequence"),
        )

        self.assertEqual(result.negatives, ("neg-a", "neg-inner", "neg-b"))
        self.assertEqual(
            getattr(result, "negative_keys", None),
            ("a", "inner", "b"),
        )

    def test_accumulates_metadata_first_value_wins_for_parameters(self) -> None:
        resolver = DictResolver(
            {
                "a": (
                    _candidate(
                        "a",
                        "__b__",
                        negative="neg-a",
                        lora_text="<lora:a:1>",
                        models=({"type": "checkpoint", "name": "ckpt-a"},),
                        parameters={"width": 832, "steps": 28, "cfg": 5},
                        nai={
                            "model": "nai-a",
                            "parameters": {"width": 832, "steps": 28},
                        },
                    ),
                ),
                "b": (
                    _candidate(
                        "b",
                        "done",
                        negative="neg-b",
                        lora_text="<lora:b:1>",
                        models=({"type": "vae", "name": "vae-b"},),
                        parameters={"width": 1024, "height": 1216, "seed": 1},
                        double_sample_parameters={"steps": 35},
                        nai={
                            "model": "nai-b",
                            "parameters": {
                                "height": 1216,
                                "steps": 30,
                                "cfg": 5.0,
                            },
                        },
                    ),
                ),
            }
        )
        result = expand(
            "__a__",
            resolver,
            ExpansionContext(seed=1),
        )
        self.assertEqual(result.text, "done")
        self.assertEqual(result.negatives, ("neg-a", "neg-b"))
        self.assertEqual(result.selected_keys, ("a", "b"))
        self.assertEqual(result.lora_texts, ("<lora:a:1>", "<lora:b:1>"))
        self.assertEqual(len(result.models), 2)
        self.assertEqual(result.parameters["width"], 832)
        self.assertNotIn("height", result.parameters)
        self.assertEqual(result.parameters["steps"], 28)
        self.assertEqual(result.parameters["seed"], 1)
        self.assertEqual(result.double_sample_parameters["steps"], 35)
        self.assertEqual(
            result.nai,
            {
                "parameters": {"width": 832, "steps": 28, "cfg": 5.0},
            },
        )


class NaiCopyMergeTests(unittest.TestCase):
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

    def test_merge_first_wins_prompts_appends_characters_and_parameters(self) -> None:
        first = {
            "content": "first content",
            "negative": "first negative",
            "characters": [{"positive": "hero"}],
            "parameters": {"steps": 28, "cfg": 5.0},
        }
        second = {
            "content": "second content",
            "negative": "second negative",
            "characters": [{"positive": "sidekick", "x": 0.2, "y": 0.8}],
            "parameters": {"steps": 30, "sampler": "k_euler", "cfg_rescale": 0.2},
        }
        self.assertEqual(
            merge_nai_payloads(first, second),
            {
                "content": "first content",
                "negative": "first negative",
                "characters": [
                    {"positive": "hero"},
                    {"positive": "sidekick", "x": 0.2, "y": 0.8},
                ],
                "parameters": {
                    "steps": 28,
                    "cfg": 5.0,
                    "sampler": "k_euler",
                    "cfg_rescale": 0.2,
                },
            },
        )

    def test_merge_does_not_drop_later_content_when_first_omits_it(self) -> None:
        merged = merge_nai_payloads(
            {"parameters": {"steps": 23}},
            {
                "content": "later content",
                "negative": "later negative",
                "characters": [{"positive": "later"}],
            },
        )
        self.assertEqual(
            merged,
            {
                "content": "later content",
                "negative": "later negative",
                "characters": [{"positive": "later"}],
                "parameters": {"steps": 23},
            },
        )

    def test_expand_merges_nai_content_and_appends_characters(self) -> None:
        resolver = DictResolver(
            {
                "a": (
                    _candidate(
                        "a",
                        "__b__",
                        nai={
                            "content": "nai-a",
                            "negative": "neg-a",
                            "characters": [{"positive": "char-a"}],
                            "parameters": {"steps": 28},
                        },
                    ),
                ),
                "b": (
                    _candidate(
                        "b",
                        "done",
                        nai={
                            "content": "nai-b",
                            "characters": [{"positive": "char-b", "x": 0.1, "y": 0.9}],
                            "parameters": {"steps": 30, "cfg": 5.0},
                        },
                    ),
                ),
            }
        )
        result = expand("__a__", resolver, ExpansionContext(seed=1))
        self.assertEqual(result.text, "done")
        self.assertEqual(
            result.nai,
            {
                "content": "nai-a",
                "negative": "neg-a",
                "characters": [
                    {"positive": "char-a"},
                    {"positive": "char-b", "x": 0.1, "y": 0.9},
                ],
                "parameters": {"steps": 28, "cfg": 5.0},
            },
        )


class NaiErrorHandlingTests(unittest.TestCase):
    def test_missing_reference_raises(self) -> None:
        with self.assertRaises(WildcardResolutionError):
            expand(
                "__missing__",
                DictResolver({}),
                ExpansionContext(seed=1),
            )

    def test_recursive_cycle_raises(self) -> None:
        resolver = DictResolver(
            {
                "loop": (_candidate("loop", "__loop__"),),
            }
        )
        with self.assertRaises(WildcardResolutionError):
            expand(
                "__loop__",
                resolver,
                ExpansionContext(seed=1),
            )

    def test_max_depth_raises(self) -> None:
        resolver = DictResolver(
            {
                "a": (_candidate("a", "__b__"),),
                "b": (_candidate("b", "__c__"),),
                "c": (_candidate("c", "end"),),
            }
        )
        with self.assertRaises(WildcardResolutionError):
            expand(
                "__a__",
                resolver,
                ExpansionContext(seed=1, max_depth=2),
            )

    def test_invalid_mode_raises(self) -> None:
        with self.assertRaises(WildcardSyntaxError):
            expand(
                "plain",
                DictResolver({}),
                ExpansionContext(seed=1, mode="invalid"),
            )


if __name__ == "__main__":
    unittest.main()
