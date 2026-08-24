"""Contract tests for Browser-to-Comfy dedicated NAI event routes."""

from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class Request:
    def __init__(self, body=None, *, error: Exception | None = None) -> None:
        self.body = body
        self.error = error

    async def json(self):
        if self.error is not None:
            raise self.error
        return self.body


class SendRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def send_sync(self, event: str, payload: dict) -> None:
        self.calls.append((event, payload))


class NaiEventRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        from server import routes_tools

        self.routes_tools = routes_tools
        self.recorder = SendRecorder()
        self.prompt_server = SimpleNamespace(
            instance=SimpleNamespace(send_sync=self.recorder.send_sync)
        )
        self.prompt_server_patch = patch(
            "server.PromptServer",
            self.prompt_server,
            create=True,
        )
        self.prompt_server_patch.start()

    def tearDown(self) -> None:
        self.prompt_server_patch.stop()

    @staticmethod
    def payload(response) -> dict:
        return json.loads(response.text)

    async def test_registers_dedicated_nai_routes_without_removing_legacy_routes(
        self,
    ) -> None:
        from server import routes

        for name in (
            "handle_nai_append_slot",
            "handle_nai_document_apply",
            "handle_nai_settings_apply",
        ):
            self.assertTrue(
                callable(getattr(self.routes_tools, name, None)),
                f"{name} must exist",
            )
        expected = {
            (
                "POST",
                "/pm4a/api/nai/append-slot",
                self.routes_tools.handle_nai_append_slot,
            ),
            (
                "POST",
                "/pm4a/api/nai/document/apply",
                self.routes_tools.handle_nai_document_apply,
            ),
            (
                "POST",
                "/pm4a/api/nai/settings/apply",
                self.routes_tools.handle_nai_settings_apply,
            ),
        }
        self.assertTrue(expected.issubset(set(routes._API_ROUTES)))
        self.assertIn(
            (
                "POST",
                "/pm4a/api/append-slot",
                self.routes_tools.handle_append_slot,
            ),
            routes._API_ROUTES,
        )
        self.assertIn(
            (
                "POST",
                "/pm4a/api/settings/apply",
                self.routes_tools.handle_settings_apply,
            ),
            routes._API_ROUTES,
        )

    async def test_append_slot_sends_only_the_dedicated_nai_event(self) -> None:
        response = await self.routes_tools.handle_nai_append_slot(
            Request(
                {
                    "slot": "quality",
                    "value": "best quality",
                    "mode": "replace",
                    "node_ids": [12, "13"],
                }
            )
        )

        expected = {
            "slot": "quality",
            "widget_name": "quality",
            "value": "best quality",
            "mode": "replace",
            "node_class": "NAI Prompt Scheduler (4A Prompt Manager)",
            "target_mode": "nai",
            "node_ids": [12, "13"],
        }
        self.assertEqual(response.status, 200)
        self.assertEqual(self.payload(response), {"success": True, "payload": expected})
        self.assertEqual(
            self.recorder.calls,
            [("pm4a_nai_widget_update", expected)],
        )

    async def test_append_slot_rejects_invalid_json_types_and_limits(self) -> None:
        cases = [
            (Request(error=ValueError("bad json")), 400),
            (Request([]), 400),
            (Request({"slot": "unknown", "value": "x"}), 400),
            (Request({"slot": "scene", "value": 1}), 400),
            (
                Request({"slot": "scene", "value": "x", "mode": "merge"}),
                400,
            ),
            (
                Request({"slot": "scene", "value": "x", "node_ids": "1"}),
                400,
            ),
            (
                Request({"slot": "scene", "value": "x" * 2_000_001}),
                413,
            ),
            (
                Request(
                    {
                        "slot": "scene",
                        "value": "x",
                        "node_ids": list(range(101)),
                    }
                ),
                413,
            ),
        ]

        for request, expected_status in cases:
            with self.subTest(body=request.body, status=expected_status):
                response = await self.routes_tools.handle_nai_append_slot(request)
                self.assertEqual(response.status, expected_status)
        self.assertEqual(self.recorder.calls, [])

    async def test_append_slot_membership_fields_reject_containers_as_400(
        self,
    ) -> None:
        cases = [
            {"slot": [], "value": "x"},
            {"slot": {}, "value": "x"},
            {"slot": "scene", "value": "x", "mode": []},
            {"slot": "scene", "value": "x", "mode": {}},
            {"slot": "scene", "value": "x", "node_ids": [[]]},
            {"slot": "scene", "value": "x", "node_ids": [{}]},
        ]

        for body in cases:
            with self.subTest(body=body):
                try:
                    response = await self.routes_tools.handle_nai_append_slot(
                        Request(body)
                    )
                except Exception as exc:
                    self.fail(f"invalid type escaped route validation: {exc!r}")
                self.assertEqual(response.status, 400)
        self.assertEqual(self.recorder.calls, [])

    async def test_document_apply_sends_replace_document_without_normalizing_it(
        self,
    ) -> None:
        document = {
            "tracks": [
                {
                    "id": "scene",
                    "name": "场景",
                    "text": "outside",
                    "custom_node_field": {"preserved": True},
                }
            ],
            "positive": "best quality",
            "negative": "lowres",
            "characters": [
                {
                    "id": "hero",
                    "name": "Hero",
                    "positive": "hero",
                    "negative": "",
                }
            ],
        }
        response = await self.routes_tools.handle_nai_document_apply(
            Request(
                {
                    "document": document,
                    "mode": "replace",
                    "node_ids": [21],
                }
            )
        )

        expected = {
            "document": document,
            "mode": "replace",
            "node_class": "NAI Prompt Scheduler (4A Prompt Manager)",
            "target_mode": "nai",
            "node_ids": [21],
        }
        self.assertEqual(response.status, 200)
        self.assertEqual(self.recorder.calls, [("pm4a_nai_document_update", expected)])

    async def test_document_apply_rejects_bad_shapes_and_oversized_events(self) -> None:
        valid = {
            "tracks": [],
            "positive": "",
            "negative": "",
            "characters": [],
        }
        invalid_documents = [
            None,
            [],
            {**valid, "tracks": {}},
            {**valid, "tracks": ["not-an-object"]},
            {**valid, "positive": []},
            {**valid, "negative": None},
            {**valid, "characters": {}},
            {**valid, "characters": ["not-an-object"]},
        ]
        for document in invalid_documents:
            with self.subTest(document=document):
                response = await self.routes_tools.handle_nai_document_apply(
                    Request({"document": document})
                )
                self.assertEqual(response.status, 400)

        append_mode = await self.routes_tools.handle_nai_document_apply(
            Request({"document": valid, "mode": "append"})
        )
        too_many_tracks = await self.routes_tools.handle_nai_document_apply(
            Request({"document": {**valid, "tracks": [{} for _ in range(101)]}})
        )
        too_many_characters = await self.routes_tools.handle_nai_document_apply(
            Request({"document": {**valid, "characters": [{} for _ in range(101)]}})
        )
        too_much_text = await self.routes_tools.handle_nai_document_apply(
            Request(
                {
                    "document": {
                        **valid,
                        "tracks": [{"text": "x" * 2_000_001}],
                    }
                }
            )
        )

        self.assertEqual(append_mode.status, 400)
        self.assertEqual(too_many_tracks.status, 413)
        self.assertEqual(too_many_characters.status, 413)
        self.assertEqual(too_much_text.status, 413)
        self.assertEqual(self.recorder.calls, [])

    async def test_document_budget_counts_nested_keys_and_scalar_serialization(
        self,
    ) -> None:
        base = {
            "positive": "",
            "negative": "",
            "characters": [],
        }
        with patch.object(
            self.routes_tools,
            "MAX_NAI_EVENT_TEXT_CHARS",
            64,
        ):
            oversized_key = await self.routes_tools.handle_nai_document_apply(
                Request(
                    {
                        "document": {
                            **base,
                            "tracks": [{"custom": {"k" * 65: "x"}}],
                        }
                    }
                )
            )
            oversized_scalar = await self.routes_tools.handle_nai_document_apply(
                Request(
                    {
                        "document": {
                            **base,
                            "tracks": [{"custom": 10**100}],
                        }
                    }
                )
            )

        self.assertEqual(oversized_key.status, 413)
        self.assertEqual(oversized_scalar.status, 413)
        self.assertEqual(self.recorder.calls, [])

    async def test_document_budget_accepts_exact_serialized_scalar_boundary(
        self,
    ) -> None:
        document = {
            "tracks": [{"custom": 999}],
            "positive": "",
            "negative": "",
            "characters": [],
        }
        event_payload = {
            "document": document,
            "mode": "replace",
            "node_class": "NAI Prompt Scheduler (4A Prompt Manager)",
            "target_mode": "nai",
        }
        budget = len(
            json.dumps(
                event_payload,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

        with patch.object(
            self.routes_tools,
            "MAX_NAI_EVENT_TEXT_CHARS",
            budget,
        ):
            response = await self.routes_tools.handle_nai_document_apply(
                Request({"document": document})
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            self.recorder.calls,
            [("pm4a_nai_document_update", event_payload)],
        )

    async def test_document_budget_rejects_excessive_depth_and_items(self) -> None:
        nested = {"leaf": "x"}
        for _ in range(40):
            nested = {"child": nested}
        base = {
            "positive": "",
            "negative": "",
            "characters": [],
        }

        too_deep = await self.routes_tools.handle_nai_document_apply(
            Request(
                {
                    "document": {
                        **base,
                        "tracks": [{"custom": nested}],
                    }
                }
            )
        )
        too_many_items = await self.routes_tools.handle_nai_document_apply(
            Request(
                {
                    "document": {
                        **base,
                        "tracks": [{"custom": [0] * 10_001}],
                    }
                }
            )
        )

        self.assertEqual(too_deep.status, 413)
        self.assertEqual(too_many_items.status, 413)
        self.assertEqual(self.recorder.calls, [])

    async def test_append_slot_rejects_oversized_node_id_string(self) -> None:
        response = await self.routes_tools.handle_nai_append_slot(
            Request(
                {
                    "slot": "scene",
                    "value": "x",
                    "node_ids": ["n" * 257],
                }
            )
        )

        self.assertEqual(response.status, 413)
        self.assertEqual(self.recorder.calls, [])

    async def test_settings_apply_targets_sampler_parameters_and_scheduler_ratio(
        self,
    ) -> None:
        response = await self.routes_tools.handle_nai_settings_apply(
            Request(
                {
                    "nai": {
                        "model": " nai-diffusion-5-full ",
                        "parameters": {
                            "width": 640,
                            "height": 1280,
                            "steps": 28,
                            "cfg": 5.0,
                            "sampler": "k_euler",
                            "scheduler": "native",
                            "cfg_rescale": 0.2,
                            "decrisper": True,
                            "denoise": 0.5,
                            "unknown": "drop",
                        },
                        "token": "drop",
                    },
                    "source_resolution": {"width": 640, "height": 1280},
                    "resolution_mode": "ratio",
                    "node_ids": [31],
                    "scheduler_node_ids": [41],
                }
            )
        )

        expected_settings = {
            "nai": {
                "parameters": {
                    "width": 640,
                    "height": 1280,
                    "steps": 28,
                    "cfg": 5.0,
                    "sampler": "k_euler",
                    "scheduler": "native",
                    "cfg_rescale": 0.2,
                },
            },
            "node_class": "NovelAI4ASampler",
            "target_mode": "nai",
            "node_ids": [31],
        }
        expected_resolution = {
            "source_resolution": {"width": 640, "height": 1280},
            "resolution_mode": "ratio",
            "node_class": "NAI Prompt Scheduler (4A Prompt Manager)",
            "target_mode": "nai",
            "node_ids": [41],
        }
        self.assertEqual(response.status, 200)
        self.assertEqual(
            self.recorder.calls,
            [
                ("pm4a_nai_settings_update", expected_settings),
                ("pm4a_nai_resolution_update", expected_resolution),
            ],
        )

    async def test_settings_apply_derives_ratio_from_nai_width_and_height(self) -> None:
        response = await self.routes_tools.handle_nai_settings_apply(
            Request(
                {
                    "nai": {
                        "parameters": {
                            "steps": 28,
                            "width": 832,
                            "height": 1216,
                        },
                    }
                }
            )
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            self.recorder.calls,
            [
                (
                    "pm4a_nai_settings_update",
                    {
                        "nai": {
                            "parameters": {
                                "steps": 28,
                                "width": 832,
                                "height": 1216,
                            },
                        },
                        "node_class": "NovelAI4ASampler",
                        "target_mode": "nai",
                    },
                ),
                (
                    "pm4a_nai_resolution_update",
                    {
                        "source_resolution": {"width": 832, "height": 1216},
                        "resolution_mode": "ratio",
                        "node_class": "NAI Prompt Scheduler (4A Prompt Manager)",
                        "target_mode": "nai",
                    },
                ),
            ],
        )

    async def test_settings_apply_broadcasts_an_explicit_empty_nai_object(self) -> None:
        response = await self.routes_tools.handle_nai_settings_apply(
            Request({"nai": {}})
        )

        expected = {
            "nai": {},
            "node_class": "NovelAI4ASampler",
            "target_mode": "nai",
        }
        self.assertEqual(response.status, 200)
        self.assertEqual(
            self.recorder.calls,
            [("pm4a_nai_settings_update", expected)],
        )

    async def test_settings_apply_rejects_invalid_shapes_and_runtime_mode(self) -> None:
        cases = [
            Request(error=ValueError("bad json")),
            Request([]),
            Request({}),
            Request({"nai": None}),
            Request({"nai": []}),
            Request({"nai": {"parameters": []}}),
            Request({"nai": {}, "resolution_mode": "absolute"}),
            Request({"nai": {}, "source_resolution": []}),
            Request({"nai": {}, "source_resolution": {"width": 640}}),
            Request({"nai": {}, "source_resolution": {"width": 0, "height": 960}}),
            Request({"nai": {}, "node_ids": [True]}),
            Request({"nai": {}, "sampler_node_ids": [True]}),
        ]

        for request in cases:
            with self.subTest(body=request.body):
                response = await self.routes_tools.handle_nai_settings_apply(request)
                self.assertEqual(response.status, 400)
        self.assertEqual(self.recorder.calls, [])

    async def test_settings_apply_maps_huge_integer_overflow_to_400(self) -> None:
        try:
            response = await self.routes_tools.handle_nai_settings_apply(
                Request(
                    {
                        "nai": {},
                        "source_resolution": {
                            "width": 10**10_000,
                            "height": 960,
                        },
                    }
                )
            )
        except Exception as exc:
            self.fail(f"numeric overflow escaped route validation: {exc!r}")

        self.assertEqual(response.status, 400)
        self.assertEqual(self.recorder.calls, [])


if __name__ == "__main__":
    unittest.main()
