"""Small authenticated HTTP smoke test; no arbitrary prompts or tool execution."""

import hmac
import json
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .gateway import DEFAULT_MODEL, ProbeFailure, endpoint_for, run_probe
from .language import LanguageBudget, LanguageGate, LanguageRejected
from .relay import RelayCounts, RelayRejected, WebhookRelay


class Budget:
    """One durable budget shared by requests in this single-instance service."""

    def __init__(self, path, limit):
        self.limit = limit
        self.lock = threading.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)")
        for name in ("started", "passed", "failed", "upstream_calls"):
            self.db.execute("INSERT OR IGNORE INTO counts VALUES (?, 0)", (name,))
        self.db.commit()

    def reserve(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.db.execute("SELECT value FROM counts WHERE name='started'").fetchone()[0]
            if current >= self.limit:
                self.db.rollback()
                return False
            self.db.execute("UPDATE counts SET value=value+1 WHERE name='started'")
            self.db.commit()
            return True

    def increment(self, name):
        if name not in {"passed", "failed", "upstream_calls"}:
            raise ValueError("invalid_counter")
        with self.lock:
            self.db.execute("UPDATE counts SET value=value+1 WHERE name=?", (name,))
            self.db.commit()

    def snapshot(self):
        with self.lock:
            result = dict(self.db.execute("SELECT name, value FROM counts"))
        return {**result, "request_limit": self.limit,
                "remaining": max(0, self.limit - result["started"])}

    def close(self):
        self.db.close()


class ProbeService:
    def __init__(self, environ, transport=None, relay_transport=None):
        self.api_key = environ.get("RECART_PROBE_API_KEY", "")
        if len(self.api_key) < 32 or any(c.isspace() for c in self.api_key):
            raise ValueError("missing_or_invalid_probe_auth")
        self.model = environ.get("MODEL_DEFAULT", DEFAULT_MODEL)
        if self.model != DEFAULT_MODEL:
            raise ValueError("model_not_allowlisted")
        self.gateway_key = environ.get("ASTRO_GATEWAY_API_KEY", "")
        self.gateway_url = environ.get("ASTRO_GATEWAY_URL", "")
        self.endpoint = None
        if self.gateway_url:
            try:
                self.endpoint = endpoint_for(self.gateway_url)
            except ProbeFailure:
                pass
        self.gateway_ready = bool(self.endpoint and self.gateway_key
                                  and not any(c.isspace() for c in self.gateway_key))
        limit = int(environ.get("RECART_PROBE_REQUEST_LIMIT", "20"))
        if not 1 <= limit <= 100:
            raise ValueError("invalid_request_limit")
        db_path = environ.get("RECART_PROBE_DB", "/data/recart-probe.sqlite3")
        self.budget = Budget(db_path, limit)
        self.gate = threading.BoundedSemaphore(1)
        self.transport = transport
        language_limit = int(environ.get("RECART_LANGUAGE_REQUEST_LIMIT", "2500"))
        if not 1 <= language_limit <= 10000:
            raise ValueError("invalid_language_limit")
        self.language_budget = LanguageBudget(db_path, language_limit)
        self.language_gate = LanguageGate(self.language_budget, transport)
        self.relay_counts = RelayCounts(db_path)
        forward = environ.get("RECART_WEBHOOK_FORWARD_URL", "").strip()
        self.relay = WebhookRelay(forward, self.relay_counts, relay_transport) if forward else None

    def authorized(self, value):
        expected = ("Bearer " + self.api_key).encode("utf-8")
        return isinstance(value, str) and hmac.compare_digest(value.encode("utf-8"), expected)

    def configuration(self):
        return {"probe_auth_configured": bool(self.api_key),
                "gateway_url_configured": bool(self.gateway_url),
                "gateway_key_configured": bool(self.gateway_key),
                "gateway_ready": self.gateway_ready,
                "model_allowlisted": self.model == DEFAULT_MODEL,
                "webhook_relay_configured": self.relay is not None}

    def language(self, payload):
        if not self.gateway_ready:
            return 503, {"ok": False, "error": "gateway_not_configured"}
        request_id = payload.get("requestId") if isinstance(payload, dict) else None
        try:
            return 200, self.language_gate.run(payload, self.endpoint, self.gateway_key, self.model)
        except LanguageRejected as rejected:
            return rejected.status, {"ok": False, "error": rejected.code, "requestId": request_id if isinstance(request_id, str) else None}

    def probe(self, mode):
        if not self.gateway_ready:
            return 503, {"status": "fail", "error": "gateway_not_configured", "stage": "configuration",
                         "configuration": self.configuration()}
        if not self.gate.acquire(blocking=False):
            return 429, {"status": "fail", "error": "probe_busy", "stage": "admission"}
        try:
            if not self.budget.reserve():
                return 429, {"status": "fail", "error": "request_budget_exhausted", "stage": "admission"}
            result = run_probe(mode, self.endpoint, self.gateway_key, self.model,
                               transport=self.transport,
                               before_call=lambda: self.budget.increment("upstream_calls"))
            self.budget.increment("passed" if result["status"] == "pass" else "failed")
            return (200 if result["status"] == "pass" else 502), result
        finally:
            self.gate.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "ReCartProbe/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        pass

    def reply(self, status, payload):
        raw = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def authenticated(self):
        headers = self.headers.get_all("Authorization", [])
        if len(headers) != 1 or not self.server.service.authorized(headers[0]):
            self.reply(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path in ("/", "/health"):
            self.reply(200, {"ok": True, "configuration": self.server.service.configuration()})
        elif self.path == "/probe/status":
            if self.authenticated():
                self.reply(200, {"configuration": self.server.service.configuration(),
                                 "budget": self.server.service.budget.snapshot()})
        elif self.path == "/v1/paypal/relay/status":
            if self.authenticated():
                service = self.server.service
                self.reply(200, {"configuration": {**service.configuration(), **(service.relay.configuration() if service.relay else {})},
                                 "relay": service.relay_counts.snapshot()})
        elif self.path == "/v1/language/status":
            if self.authenticated():
                self.reply(200, {"configuration": self.server.service.configuration(),
                                 "budget": self.server.service.language_budget.snapshot()})
        else:
            self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/v1/language":
            self.language_post()
            return
        if self.path == "/v1/paypal/webhook":
            self.relay_post()
            return
        modes = {"/probe/basic": "basic", "/probe/tool-loop": "tool_loop"}
        if self.path not in modes:
            self.reply(404, {"error": "not_found"})
            return
        if not self.authenticated():
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) > 1:
            self.reply(400, {"error": "invalid_body_framing"})
            return
        try:
            size = int(lengths[0]) if lengths else 0
            if not 0 <= size <= 1024:
                self.reply(413, {"error": "body_too_large"})
                return
            raw = self.rfile.read(size)
            if len(raw) != size or (raw and json.loads(raw) != {}):
                raise ValueError
        except (ValueError, UnicodeDecodeError, TimeoutError, OSError):
            self.reply(400, {"error": "body_must_be_empty_object"})
            return
        try:
            status, result = self.server.service.probe(modes[self.path])
        except Exception:
            status, result = 500, {"status": "fail", "error": "internal_error", "stage": "server"}
        self.reply(status, result)


def _language_post(self):
    if not self.authenticated():
        return
    lengths = self.headers.get_all("Content-Length", [])
    if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
        self.reply(400, {"ok": False, "error": "invalid_body_framing"})
        return
    try:
        size = int(lengths[0])
        if not 2 <= size <= 65536:
            self.reply(413, {"ok": False, "error": "body_too_large"})
            return
        payload = json.loads(self.rfile.read(size))
    except (ValueError, UnicodeDecodeError, TimeoutError, OSError):
        self.reply(400, {"ok": False, "error": "invalid_json"})
        return
    try:
        status, result = self.server.service.language(payload)
    except Exception:
        status, result = 500, {"ok": False, "error": "internal_error"}
    self.reply(status, result)


Handler.language_post = _language_post


def _relay_post(self):
    """Unauthenticated by design: PayPal cannot send our bearer. ReCart verifies each event with PayPal."""
    service = self.server.service
    if service.relay is None:
        self.reply(503, {"ok": False, "error": "relay_not_configured"})
        return
    try:
        status, result = service.relay.handle_request(self.headers, self.rfile)
    except RelayRejected as rejected:
        status, result = rejected.status, {"ok": False, "error": rejected.code}
    except (TimeoutError, OSError):
        status, result = 400, {"ok": False, "error": "invalid_body"}
    except Exception:
        status, result = 500, {"ok": False, "error": "internal_error"}
    self.reply(status, result)


Handler.relay_post = _relay_post


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, service):
        self.service = service
        super().__init__(address, Handler)

    def handle_error(self, request, client_address):
        pass


def main():
    try:
        service = ProbeService(os.environ)
        port = int(os.environ.get("PORT", "80"))
        if not 1 <= port <= 65535:
            raise ValueError
        server = Server(("0.0.0.0", port), service)
    except Exception:
        print(json.dumps({"status": "startup_failed", "error": "invalid_configuration"}), flush=True)
        return 1
    print(json.dumps({"status": "ready", "configuration": service.configuration()}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        service.budget.close()
        service.language_budget.close()
        service.relay_counts.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
