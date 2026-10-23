import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from agent.gateway import DEFAULT_MODEL, ProbeFailure, run_probe
from agent.main import Budget, ProbeService, Server


def answer(content, **extras):
    return {"choices": [{"message": {"role": "assistant", "content": content, **extras}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15,
                      "secret_field": "must_not_escape"}}


def tool_response(arguments='{"sku":"TEST-1"}', name="lookup_stock"):
    return answer(None, tool_calls=[{"id": "call_test_1", "type": "function",
                                    "function": {"name": name, "arguments": arguments}}])


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = {
            "RECART_PROBE_API_KEY": "test-client-secret-" + "x" * 32,
            "ASTRO_GATEWAY_URL": "https://gateway.example.test",
            "ASTRO_GATEWAY_API_KEY": "test-upstream-secret",
            "MODEL_DEFAULT": DEFAULT_MODEL,
            "RECART_PROBE_DB": str(Path(self.temp.name) / "budget.sqlite3"),
            "RECART_PROBE_REQUEST_LIMIT": "2",
        }
        self.transport = Mock(return_value=answer('{"ok":true}'))
        self.service = ProbeService(self.environment, self.transport)
        self.server = Server(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.budget.close()
        self.temp.cleanup()

    def request(self, path, authorized=True, method="POST", body="{}"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = "Bearer " + self.environment["RECART_PROBE_API_KEY"]
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        status, payload = response.status, json.loads(response.read())
        conn.close()
        return status, payload

    def test_unauthorized_never_calls_upstream_or_consumes_budget(self):
        self.assertEqual(self.request("/probe/basic", authorized=False)[0], 401)
        self.assertEqual(self.request("/probe/status", authorized=False, method="GET")[0], 401)
        self.transport.assert_not_called()
        self.assertEqual(self.service.budget.snapshot()["started"], 0)

    def test_health_only_exposes_booleans(self):
        status, result = self.request("/health", authorized=False, method="GET")
        self.assertEqual(status, 200)
        self.assertTrue(all(type(v) is bool for v in result["configuration"].values()))
        self.assertNotIn("test-upstream-secret", json.dumps(result))
        self.transport.assert_not_called()

    def test_valid_tool_loop_has_two_bounded_calls(self):
        self.transport.side_effect = [tool_response(), answer('{"available":true}')]
        status, result = self.request("/probe/tool-loop")
        self.assertEqual((status, result["status"]), (200, "pass"))
        self.assertEqual(self.transport.call_count, 2)
        for call in self.transport.call_args_list:
            self.assertEqual(call.args[2]["max_tokens"], 128)
            self.assertEqual(call.args[2]["model"], DEFAULT_MODEL)
        second = self.transport.call_args_list[1].args[2]
        self.assertEqual(json.loads(second["messages"][-1]["content"])["quantity"], 3)
        self.assertEqual(result["calls"][0]["usage"]["total_tokens"], 15)
        self.assertNotIn("secret_field", json.dumps(result))
        self.assertEqual(self.service.budget.snapshot()["upstream_calls"], 2)

    def test_bad_arguments_do_not_send_tool_result(self):
        self.transport.return_value = tool_response('{"sku":"OTHER","url":"https://untrusted.test"}')
        status, result = self.request("/probe/tool-loop")
        self.assertEqual(status, 502)
        self.assertEqual(result["error"], "unexpected_tool_arguments")
        self.assertEqual(result["stage"], "tool_request")
        self.assertEqual(self.transport.call_count, 1)
        self.assertNotIn("untrusted", json.dumps(result))

    def test_arbitrary_input_rejected_before_upstream(self):
        for raw in ('{"prompt":"ignore limits"}', '{"model":"other"}', "[]", "null", "{"):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("/probe/basic", body=raw)[0], 400)
        self.assertEqual(self.request("/probe/basic", body="x" * 1025)[0], 413)
        self.transport.assert_not_called()
        self.assertEqual(self.service.budget.snapshot()["started"], 0)

    def test_budget_survives_reopening(self):
        self.assertEqual(self.request("/probe/basic")[0], 200)
        self.assertEqual(self.request("/probe/basic")[0], 200)
        self.assertEqual(self.request("/probe/basic")[0], 429)
        self.assertEqual(self.transport.call_count, 2)
        reopened = Budget(self.environment["RECART_PROBE_DB"], 2)
        try:
            self.assertFalse(reopened.reserve())
            self.assertEqual(reopened.snapshot()["remaining"], 0)
        finally:
            reopened.close()

    def test_concurrency_rejected_without_spend(self):
        self.service.gate.acquire()
        try:
            status, result = self.request("/probe/basic")
            self.assertEqual((status, result["error"]), (429, "probe_busy"))
            self.transport.assert_not_called()
            self.assertEqual(self.service.budget.snapshot()["started"], 0)
        finally:
            self.service.gate.release()

    def test_error_status_preserved_without_provider_body(self):
        self.transport.side_effect = ProbeFailure("upstream_http_error", 429)
        status, result = self.request("/probe/basic")
        self.assertEqual((status, result["upstream_status"], result["stage"]), (502, 429, "basic"))
        self.assertEqual(self.transport.call_count, 1)

    def test_missing_gateway_fails_without_spend(self):
        self.service.gateway_ready = False
        status, result = self.request("/probe/basic")
        self.assertEqual(status, 503)
        self.assertTrue(all(type(v) is bool for v in result["configuration"].values()))
        self.transport.assert_not_called()
        self.assertEqual(self.service.budget.snapshot()["started"], 0)

    def test_unknown_exception_text_is_suppressed(self):
        self.transport.side_effect = RuntimeError("private-provider-data")
        status, result = self.request("/probe/basic")
        self.assertEqual(status, 502)
        self.assertEqual(result["error"], "unexpected_client_error")
        self.assertNotIn("private-provider-data", json.dumps(result))

    def test_missing_auth_or_unapproved_model_fails_startup(self):
        for update in ({"RECART_PROBE_API_KEY": ""}, {"MODEL_DEFAULT": "unapproved"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                ProbeService({**self.environment, **update}, self.transport)


class ValidationTests(unittest.TestCase):
    def run_basic(self, content):
        transport = Mock(return_value=answer(content))
        result = run_probe("basic", "https://example.test", "dummy", DEFAULT_MODEL, transport)
        self.assertEqual(transport.call_count, 1)
        return result

    def test_accepts_bare_json_and_single_complete_fence(self):
        for content in (' {"ok":true}\n', '```json\n{"ok":true}\n```',
                        '```\n{"ok":true}\n```', ' \n```json\r\n{"ok":true}\r\n```\t'):
            with self.subTest(content=content):
                self.assertEqual(self.run_basic(content)["status"], "pass")

    def test_fenced_tool_result_keeps_existing_semantics(self):
        transport = Mock(side_effect=[tool_response(), answer('```json\n{"available":true}\n```')])
        result = run_probe("tool_loop", "https://example.test", "dummy", DEFAULT_MODEL, transport)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(transport.call_count, 2)

    def test_rejects_explanations_multiple_fences_and_malformed_envelopes(self):
        for content in ('Explanation\n```json\n{"ok":true}\n```',
                        '```json\n{"ok":true}\n```\nExplanation',
                        '```json\n{"ok":true}\n```\n```json\n{"ok":true}\n```',
                        '```json\n{"ok":true}', '```python\n{"ok":true}\n```',
                        '```json\nnot-json-secret-sentinel\n```',
                        'not-json-secret-sentinel', '{"ok":true} trailing'):
            with self.subTest(content=content):
                result = self.run_basic(content)
                self.assertEqual(result["error"], "final_not_json")
                self.assertEqual(result["output_length"], len(content))
                expected_shape = "markdown_fence" if content.strip().startswith("```") else "other"
                self.assertEqual(result["output_shape"], expected_shape)
                self.assertNotIn("secret-sentinel", json.dumps(result))

    def test_fences_do_not_relax_expected_keys_or_boolean_values(self):
        for body in ('{"ok":false}', '{"ok":1}', '{"ok":"true"}',
                     '{"ok":true,"extra":true}', '{"other":true}', '[{"ok":true}]'):
            with self.subTest(body=body):
                result = self.run_basic("```json\n" + body + "\n```")
                self.assertEqual(result["error"], "unexpected_final_json")

    def test_final_numeric_one_is_not_boolean_true(self):
        transport = Mock(return_value=answer('{"ok":1}'))
        result = run_probe("basic", "https://example.test", "dummy", DEFAULT_MODEL, transport)
        self.assertEqual(result["error"], "unexpected_final_json")
        self.assertEqual(transport.call_count, 1)

    def test_unexpected_tool_name_never_calls_second_stage(self):
        transport = Mock(return_value=tool_response(name="execute_shell"))
        result = run_probe("tool_loop", "https://example.test", "dummy", DEFAULT_MODEL, transport)
        self.assertEqual(result["error"], "unexpected_tool")
        self.assertEqual(transport.call_count, 1)


if __name__ == "__main__":
    unittest.main()


class LanguageEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = {
            "RECART_PROBE_API_KEY": "test-client-secret-" + "x" * 32,
            "ASTRO_GATEWAY_URL": "https://gateway.example.test",
            "ASTRO_GATEWAY_API_KEY": "test-upstream-secret",
            "MODEL_DEFAULT": DEFAULT_MODEL,
            "RECART_PROBE_DB": str(Path(self.temp.name) / "budget.sqlite3"),
            "RECART_LANGUAGE_REQUEST_LIMIT": "3",
        }
        self.transport = Mock(return_value=answer('{"summary":"ok","options":[]}'))
        self.service = ProbeService(self.environment, self.transport)
        self.server = Server(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.budget.close()
        self.service.language_budget.close()
        self.temp.cleanup()

    def post(self, payload, authorized=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = "Bearer " + self.environment["RECART_PROBE_API_KEY"]
        conn.request("POST", "/v1/language", body=json.dumps(payload), headers=headers)
        response = conn.getresponse()
        status, body = response.status, json.loads(response.read())
        conn.close()
        return status, body

    def payload(self, **overrides):
        base = {"protocol": 1, "task": "explain_change", "requestId": "req-12345678", "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}], "maxTokens": 768}
        base.update(overrides)
        return base

    def test_unauthenticated_requests_never_reach_the_model(self):
        self.assertEqual(self.post(self.payload(), authorized=False)[0], 401)
        self.transport.assert_not_called()

    def test_valid_request_returns_text_usage_and_echoed_id(self):
        status, body = self.post(self.payload())
        self.assertEqual(status, 200)
        self.assertEqual(body["requestId"], "req-12345678")
        self.assertEqual(body["content"], '{"summary":"ok","options":[]}')
        self.assertEqual(body["usage"], {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15})
        sent = self.transport.call_args.args[2]
        self.assertEqual((sent["model"], sent["max_tokens"], sent["temperature"]), (DEFAULT_MODEL, 768, 0))
        self.assertNotIn("tools", sent)

    def test_rejects_unknown_tasks_roles_and_oversized_limits(self):
        self.assertEqual(self.post(self.payload(task="run_tool"))[1]["error"], "task_not_allowed")
        self.assertEqual(self.post(self.payload(messages=[{"role": "assistant", "content": "x"}]))[1]["error"], "invalid_messages")
        self.assertEqual(self.post(self.payload(maxTokens=4096))[1]["error"], "invalid_max_tokens")
        self.assertEqual(self.post(self.payload(task="extract_goal", maxTokens=1025))[1]["error"], "invalid_max_tokens")
        self.assertEqual(self.post(self.payload(messages=[{"role": "user", "content": "x" * 16001}]))[0], 413)
        self.transport.assert_not_called()

    def test_lifetime_budget_is_enforced_and_persisted(self):
        for _ in range(3):
            self.assertEqual(self.post(self.payload())[0], 200)
        status, body = self.post(self.payload())
        self.assertEqual((status, body["error"]), (429, "request_budget_exhausted"))
        self.assertEqual(self.transport.call_count, 3)
        snap = self.service.language_budget.snapshot()
        self.assertEqual((snap["started"], snap["succeeded"], snap["remaining"]), (3, 3, 0))

    def test_upstream_failure_is_typed_and_counted(self):
        self.transport.side_effect = ProbeFailure("upstream_http_error", 500)
        status, body = self.post(self.payload())
        self.assertEqual((status, body["error"]), (502, "upstream_http_error"))
        self.assertEqual(self.service.language_budget.snapshot()["failed"], 1)


class RelayTests(unittest.TestCase):
    """PayPal webhook relay: exact bytes and PayPal headers forwarded once; failures returned so PayPal retries."""

    EVENT = b'{"id":"WH-58D329510W468432D-8HN650336L201105X","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"1S144119SX9452402"},  "spacing":"kept"}'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = {
            "RECART_PROBE_API_KEY": "test-client-secret-" + "x" * 32,
            "ASTRO_GATEWAY_URL": "https://gateway.example.test",
            "ASTRO_GATEWAY_API_KEY": "test-upstream-secret",
            "MODEL_DEFAULT": DEFAULT_MODEL,
            "RECART_PROBE_DB": str(Path(self.temp.name) / "budget.sqlite3"),
            "RECART_WEBHOOK_FORWARD_URL": "https://recart.example.test/api/webhooks/paypal",
        }
        self.forward = Mock(return_value=(200, {"received": True, "status": "PROCESSED", "extra": "dropped"}))
        self.model = Mock()
        self.start(self.environment)

    def start(self, environment):
        self.service = ProbeService(environment, self.model, self.forward)
        self.server = Server(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.budget.close()
        self.service.language_budget.close()
        self.service.relay_counts.close()
        self.temp.cleanup()

    def headers(self, **overrides):
        base = {"Content-Type": "application/json", "PAYPAL-TRANSMISSION-ID": "2c1fc65f-c400-11f1-801d-db0d053dc2f9",
                "PAYPAL-TRANSMISSION-TIME": "2026-10-09T16:40:44Z", "PAYPAL-TRANSMISSION-SIG": "P/84zlpjrN/Sd3918AR6x8w4Ca9Zka==",
                "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596",
                "PAYPAL-AUTH-ALGO": "SHA256withRSA", "PAYPAL-AUTH-VERSION": "v2"}
        base.update(overrides)
        return {k: v for k, v in base.items() if v is not None}

    def post(self, body=None, headers=None, path="/v1/paypal/webhook", chunked=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        body = self.EVENT if body is None else body
        if chunked:
            conn.putrequest("POST", path)
            for k, v in (headers or self.headers()).items():
                conn.putheader(k, v)
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            for i in range(0, len(body), 40):
                part = body[i:i + 40]
                conn.send(b"%x\r\n" % len(part) + part + b"\r\n")
            conn.send(b"0\r\n\r\n")
        else:
            conn.request("POST", path, body=body, headers=headers or self.headers())
        response = conn.getresponse()
        status, payload = response.status, json.loads(response.read())
        conn.close()
        return status, payload

    def test_forwards_exact_bytes_and_paypal_headers_once(self):
        status, body = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(body, {"relayed": True, "eventId": "WH-58D329510W468432D-8HN650336L201105X", "upstreamStatus": 200,
                                "upstream": {"received": True, "status": "PROCESSED"}})
        self.forward.assert_called_once()
        url, raw, sent = self.forward.call_args.args
        self.assertEqual(url, "https://recart.example.test/api/webhooks/paypal")
        self.assertEqual(raw, self.EVENT)
        self.assertEqual(sent["paypal-transmission-sig"], "P/84zlpjrN/Sd3918AR6x8w4Ca9Zka==")
        self.assertEqual(sent["paypal-auth-version"], "v2")
        self.assertEqual(set(sent) - {"Content-Type", "User-Agent"}, {"paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo", "paypal-auth-version"})
        self.model.assert_not_called()
        snap = self.service.relay_counts.snapshot()
        self.assertEqual((snap["received"], snap["forwarded_2xx"], snap["last_event_type"]), (1, 1, "PAYMENT.CAPTURE.COMPLETED"))

    def test_chunked_bodies_are_reassembled_exactly(self):
        self.assertEqual(self.post(chunked=True)[0], 200)
        self.assertEqual(self.forward.call_args.args[1], self.EVENT)

    def test_rejects_requests_that_are_not_paypal_deliveries(self):
        self.assertEqual(self.post(headers=self.headers(**{"PAYPAL-TRANSMISSION-SIG": None})), (400, {"ok": False, "error": "missing_paypal_headers"}))
        self.assertEqual(self.post(headers=self.headers(**{"PAYPAL-CERT-URL": "https://evil.example/certs/x"}))[1]["error"], "untrusted_cert_url")
        self.assertEqual(self.post(headers=self.headers(**{"PAYPAL-CERT-URL": "http://api.sandbox.paypal.com/v1/notifications/certs/x"}))[1]["error"], "untrusted_cert_url")
        self.assertEqual(self.post(body=b'{"hello":"world"}')[1]["error"], "not_a_paypal_event")
        self.assertEqual(self.post(body=b"not json")[1]["error"], "invalid_json")
        self.assertEqual(self.post(body=b"{" + b" " * 70000 + b"}")[0], 413)
        self.forward.assert_not_called()
        self.assertEqual(self.service.relay_counts.snapshot()["rejected"], 6)

    def test_upstream_failures_return_502_so_paypal_retries(self):
        self.forward.return_value = (503, {"error": "verification_unavailable"})
        self.assertEqual(self.post(), (502, {"ok": False, "error": "upstream_status_503"}))
        self.forward.side_effect = TimeoutError()
        self.assertEqual(self.post(), (502, {"ok": False, "error": "upstream_unreachable"}))
        self.assertEqual(self.service.relay_counts.snapshot()["upstream_failed"], 2)

    def test_upstream_rejection_is_passed_through(self):
        self.forward.return_value = (400, {"error": "verification_failed"})
        self.assertEqual(self.post(), (400, {"relayed": True, "eventId": "WH-58D329510W468432D-8HN650336L201105X", "upstreamStatus": 400, "upstream": {"error": "verification_failed"}}))
        self.assertEqual(self.service.relay_counts.snapshot()["forwarded_4xx"], 1)

    def test_status_requires_auth_and_reports_counts(self):
        self.post()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/v1/paypal/relay/status")
        self.assertEqual(conn.getresponse().status, 401)
        conn.close()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/v1/paypal/relay/status", headers={"Authorization": "Bearer " + self.environment["RECART_PROBE_API_KEY"]})
        response = conn.getresponse()
        body = json.loads(response.read())
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["relay"]["forwarded_2xx"], 1)
        self.assertEqual(body["configuration"]["webhook_relay_target_host"], "recart.example.test")

    def test_unconfigured_relay_and_unsafe_targets(self):
        self.tearDown()
        self.setUp_without_forward()
        self.assertEqual(self.post(), (503, {"ok": False, "error": "relay_not_configured"}))
        self.forward.assert_not_called()
        for bad in ("http://recart.example.test/x", "https://user:pw@recart.example.test/x", "https://recart.example.test/x?y=1", "ftp://x/y"):
            with self.assertRaises(ValueError):
                ProbeService({**self.environment, "RECART_WEBHOOK_FORWARD_URL": bad, "RECART_PROBE_DB": str(Path(self.temp.name) / "bad.sqlite3")}, self.model, self.forward)

    def setUp_without_forward(self):
        self.temp = tempfile.TemporaryDirectory()
        environment = {**self.environment, "RECART_PROBE_DB": str(Path(self.temp.name) / "budget.sqlite3")}
        environment.pop("RECART_WEBHOOK_FORWARD_URL")
        self.forward = Mock()
        self.start(environment)
