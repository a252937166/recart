"""PayPal webhook relay for the ReCart demo deployment.

PayPal Sandbox's webhook sender refuses the demo server's domain before TLS starts, while it delivers to this
agent's public host. PayPal therefore posts here and the relay forwards the exact raw body plus PayPal's
transmission headers to the ReCart server. ReCart verifies every event with PayPal's verify-webhook-signature
API before using it, so the relay cannot alter or invent an event without failing verification. The relay holds
no PayPal credentials, never logs payloads, and returns failures to PayPal so PayPal retries delivery.
"""

import json
import re
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BODY = 64 * 1024
MAX_HEADER = 2048
REQUIRED = ("paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig",
            "paypal-cert-url", "paypal-auth-algo")
OPTIONAL = ("paypal-auth-version",)
CERT_HOSTS = {"api.sandbox.paypal.com", "api-m.sandbox.paypal.com", "api.paypal.com", "api-m.paypal.com"}
EVENT_ID = re.compile(r"WH-[A-Za-z0-9-]{8,80}")
EVENT_TYPE = re.compile(r"[A-Z][A-Z0-9_.]{2,80}")
PRINTABLE = re.compile(r"[\x21-\x7e]+")
PER_MINUTE = 120
CONCURRENCY = 4
FORWARD_TIMEOUT = 12
COUNTERS = ("received", "rejected", "forwarded_2xx", "forwarded_4xx", "upstream_failed")


class RelayRejected(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RelayRejected(502, "upstream_redirect_refused")


def forward_target(raw_url):
    try:
        parts = urllib.parse.urlsplit(raw_url)
        port = parts.port
    except (ValueError, TypeError):
        raise ValueError("invalid_forward_url") from None
    local = parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")
    if ((parts.scheme != "https" and not local) or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.query or parts.fragment or port == 0
            or any(c.isspace() for c in raw_url)):
        raise ValueError("invalid_forward_url")
    return raw_url


def https_transport(url, body, headers, timeout=FORWARD_TIMEOUT):
    """POST once, never follow redirects; return (status, small JSON body or None)."""
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context()), _NoRedirects())
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with opener.open(request, timeout=timeout) as response:
            status, raw = response.status, response.read(4096)
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read(4096)
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = None
    return status, parsed if isinstance(parsed, dict) else None


class RelayCounts:
    def __init__(self, path):
        self.lock = threading.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS relay_counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)")
        for name in COUNTERS:
            self.db.execute("INSERT OR IGNORE INTO relay_counts VALUES (?, 0)", (name,))
        self.db.execute("CREATE TABLE IF NOT EXISTS relay_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()

    def add(self, name):
        if name not in COUNTERS:
            raise ValueError("invalid_counter")
        with self.lock:
            self.db.execute("UPDATE relay_counts SET value=value+1 WHERE name=?", (name,))
            self.db.commit()

    def note(self, name, value):
        with self.lock:
            self.db.execute("INSERT INTO relay_meta VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (name, value))
            self.db.commit()

    def snapshot(self):
        with self.lock:
            counts = dict(self.db.execute("SELECT name, value FROM relay_counts"))
            meta = dict(self.db.execute("SELECT name, value FROM relay_meta"))
        return {**counts, **meta}

    def close(self):
        self.db.close()


def select_headers(get_all):
    """Each PayPal transmission header must appear exactly once, as short printable ASCII."""
    chosen = {}
    for name in REQUIRED:
        values = get_all(name)
        if len(values) != 1 or not isinstance(values[0], str) or len(values[0]) > MAX_HEADER:
            raise RelayRejected(400, "missing_paypal_headers")
        value = values[0].strip()
        if not PRINTABLE.fullmatch(value):
            raise RelayRejected(400, "invalid_paypal_headers")
        chosen[name] = value
    for name in OPTIONAL:
        values = get_all(name)
        if len(values) == 1 and isinstance(values[0], str) and len(values[0]) <= MAX_HEADER and PRINTABLE.fullmatch(values[0].strip()):
            chosen[name] = values[0].strip()
    cert = urllib.parse.urlsplit(chosen["paypal-cert-url"])
    if cert.scheme != "https" or cert.hostname not in CERT_HOSTS or cert.username or cert.password:
        raise RelayRejected(400, "untrusted_cert_url")
    return chosen


def check_event(raw):
    try:
        event = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise RelayRejected(400, "invalid_json") from None
    if (not isinstance(event, dict) or not isinstance(event.get("id"), str) or not EVENT_ID.fullmatch(event["id"])
            or not isinstance(event.get("event_type"), str) or not EVENT_TYPE.fullmatch(event["event_type"])):
        raise RelayRejected(400, "not_a_paypal_event")
    return event["id"], event["event_type"]


class WebhookRelay:
    def __init__(self, forward_url, counts, transport=None):
        self.url = forward_target(forward_url)
        self.counts = counts
        self.transport = transport or https_transport
        self.slots = threading.BoundedSemaphore(CONCURRENCY)
        self.window_lock = threading.Lock()
        self.window = (0, 0)

    def configuration(self):
        return {"webhook_relay_configured": True, "webhook_relay_target_host": urllib.parse.urlsplit(self.url).hostname}

    def _rate_ok(self):
        with self.window_lock:
            minute = int(time.time() // 60)
            start, count = self.window
            if start != minute:
                self.window = (minute, 1)
                return True
            if count >= PER_MINUTE:
                return False
            self.window = (start, count + 1)
            return True

    def handle_request(self, headers, stream):
        """Entry point for an HTTP request: read the bounded body, then validate and forward it."""
        try:
            raw = read_body(headers, stream)
        except RelayRejected:
            self.counts.add("received")
            self.counts.add("rejected")
            raise
        return self.handle(lambda name: headers.get_all(name, []), raw)

    def handle(self, get_all, raw):
        self.counts.add("received")
        try:
            headers = select_headers(get_all)
            event_id, event_type = check_event(raw)
            if not self._rate_ok():
                raise RelayRejected(429, "rate_limited")
            if not self.slots.acquire(blocking=False):
                raise RelayRejected(503, "busy")
        except RelayRejected:
            self.counts.add("rejected")
            raise
        try:
            outgoing = {**headers, "Content-Type": "application/json", "User-Agent": "recart-paypal-relay/1"}
            try:
                status, body = self.transport(self.url, raw, outgoing)
            except RelayRejected:
                self.counts.add("upstream_failed")
                raise
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                self.counts.add("upstream_failed")
                raise RelayRejected(502, "upstream_unreachable") from None
        finally:
            self.slots.release()
        if 200 <= status < 300:
            self.counts.add("forwarded_2xx")
            self.counts.note("last_forwarded_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            self.counts.note("last_event_type", event_type)
        elif 400 <= status < 500:
            self.counts.add("forwarded_4xx")
        else:
            self.counts.add("upstream_failed")
            raise RelayRejected(502, "upstream_status_%d" % status if 100 <= status < 600 else "upstream_failed")
        reply = {"relayed": True, "eventId": event_id, "upstreamStatus": status}
        if isinstance(body, dict):
            reply["upstream"] = {k: body[k] for k in ("received", "duplicate", "status", "error") if k in body and isinstance(body[k], (str, bool))}
        return status, reply


def read_body(headers, stream):
    """Read a bounded request body framed by one Content-Length or by chunked transfer encoding."""
    lengths = headers.get_all("Content-Length", [])
    encodings = headers.get_all("Transfer-Encoding", [])
    if encodings:
        if lengths or len(encodings) != 1 or encodings[0].strip().lower() != "chunked":
            raise RelayRejected(400, "invalid_body_framing")
        body = b""
        while True:
            line = stream.readline(64)
            if not line.endswith(b"\r\n"):
                raise RelayRejected(400, "invalid_body_framing")
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                raise RelayRejected(400, "invalid_body_framing") from None
            if size == 0:
                while stream.readline(1024) not in (b"\r\n", b""):
                    pass
                break
            if len(body) + size > MAX_BODY:
                raise RelayRejected(413, "body_too_large")
            chunk = stream.read(size)
            if len(chunk) != size or stream.read(2) != b"\r\n":
                raise RelayRejected(400, "invalid_body_framing")
            body += chunk
        return body
    if len(lengths) != 1:
        raise RelayRejected(400, "invalid_body_framing")
    try:
        size = int(lengths[0])
    except ValueError:
        raise RelayRejected(400, "invalid_body_framing") from None
    if not 2 <= size <= MAX_BODY:
        raise RelayRejected(413 if size > MAX_BODY else 400, "body_too_large" if size > MAX_BODY else "invalid_body_framing")
    body = stream.read(size)
    if len(body) != size:
        raise RelayRejected(400, "invalid_body_framing")
    return body
