import unittest
from unittest.mock import patch

import server


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.saved = (
            dict(server._source_cache),
            dict(server._source_cache_at),
            dict(server._source_errors),
            dict(server._source_latencies),
            list(server._critical_request_times),
            server._critical_backoff_until,
        )
        server._source_cache.clear()
        server._source_cache_at.clear()
        server._source_errors.clear()
        server._source_latencies.clear()
        server._critical_request_times.clear()
        server._critical_backoff_until = 0

    def tearDown(self):
        cache, cache_at, errors, latencies, requests, backoff = self.saved
        server._source_cache.clear()
        server._source_cache.update(cache)
        server._source_cache_at.clear()
        server._source_cache_at.update(cache_at)
        server._source_errors.clear()
        server._source_errors.update(errors)
        server._source_latencies.clear()
        server._source_latencies.update(latencies)
        server._critical_request_times[:] = requests
        server._critical_backoff_until = backoff

    def test_log_shapes_are_sanitized(self):
        payload = {
            "success": True,
            "data": {
                "items": [{
                    "id": 1,
                    "model_name": "gpt-test",
                    "is_stream": True,
                    "ip": "should-not-leave-server",
                    "content": "secret prompt",
                }]
            },
        }
        self.assertEqual(
            server.extract_logs(payload),
            [{"id": 1, "model_name": "gpt-test", "is_streamed": True}],
        )

    def test_daily_analytics_include_model_segments(self):
        now = int(server.time.time())
        result = server.summarize_logs([
            {"created_at": now, "model_name": "model-a", "prompt_tokens": 2},
            {"created_at": now, "model_name": "model-b", "completion_tokens": 3},
        ])
        segments = {row["model"]: row for row in result["daily"][-1]["models"]}
        self.assertEqual(segments["model-a"]["requests"], 1)
        self.assertEqual(segments["model-b"]["tokens"], 3)

    def test_dashboard_build_never_calls_upstream(self):
        server._source_cache.update({
            "usage": {"data": {"name": "test", "total_available": 10}},
            "models": {"data": [{"id": "gpt-test", "owned_by": "test"}]},
            "logs": [{
                "id": 1,
                "created_at": 1_700_000_000,
                "model_name": "gpt-test",
                "prompt_tokens": 2,
                "completion_tokens": 3,
                "is_streamed": True,
            }],
        })
        server._source_cache_at.update({"usage": 100, "models": 200, "logs": 300})
        with patch.object(server, "upstream_json", side_effect=AssertionError("network call")):
            result = server.build_dashboard()
        self.assertTrue(result["cached"])
        self.assertEqual(result["data_updated_at"], 300)
        self.assertEqual(result["analytics"]["totals"]["tokens"], 5)
        self.assertEqual(result["analytics"]["totals"]["streamed_requests"], 1)

    def test_critical_window_keeps_safety_margin(self):
        now = 10_000.0
        server._critical_request_times[:] = [now - 1_190 + index * 71 for index in range(16)]
        self.assertFalse(server.critical_request_allowed(now))
        self.assertTrue(server.critical_request_allowed(now + 1_191))


if __name__ == "__main__":
    unittest.main()
