"""Bounded language endpoint for ReCart (spec v1.2.1 section 8).

The ReCart backend sends repository-owned prompts for exactly two tasks. This service only authenticates,
bounds, and forwards them to the platform-injected model gateway. It runs no tools, reads no inventory,
writes no ReCart data, and never sees payment credentials. Buyer text and model output are never logged.
"""

import re
import sqlite3
import threading
import time
from pathlib import Path

from .gateway import ProbeFailure, complete, message_from, safe_usage

TASKS = {"extract_goal": 1024, "explain_change": 768}
MAX_MESSAGES = 4
MAX_MESSAGE_CHARS = 16_000
MAX_TOTAL_CHARS = 24_000
REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
CONCURRENCY = 2
QUEUE = 4
QUEUE_WAIT_SECONDS = 10
PER_MINUTE = 60


class LanguageRejected(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


class LanguageBudget:
    """Durable lifetime request budget shared by this single-instance service."""

    def __init__(self, path, limit):
        self.limit = limit
        self.lock = threading.Lock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS language_counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)")
        for name in ("started", "succeeded", "failed", "prompt_tokens", "completion_tokens"):
            self.db.execute("INSERT OR IGNORE INTO language_counts VALUES (?, 0)", (name,))
        self.db.commit()

    def reserve(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.db.execute("SELECT value FROM language_counts WHERE name='started'").fetchone()[0]
            if current >= self.limit:
                self.db.rollback()
                return False
            self.db.execute("UPDATE language_counts SET value=value+1 WHERE name='started'")
            self.db.commit()
            return True

    def add(self, name, amount=1):
        if name not in {"succeeded", "failed", "prompt_tokens", "completion_tokens"}:
            raise ValueError("invalid_counter")
        with self.lock:
            self.db.execute("UPDATE language_counts SET value=value+? WHERE name=?", (int(amount), name))
            self.db.commit()

    def snapshot(self):
        with self.lock:
            result = dict(self.db.execute("SELECT name, value FROM language_counts"))
        return {**result, "request_limit": self.limit, "remaining": max(0, self.limit - result["started"])}

    def close(self):
        self.db.close()


def validate(payload):
    if not isinstance(payload, dict) or payload.get("protocol") != 1:
        raise LanguageRejected(400, "unsupported_protocol")
    task = payload.get("task")
    if task not in TASKS:
        raise LanguageRejected(400, "task_not_allowed")
    request_id = payload.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise LanguageRejected(400, "invalid_request_id")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_MESSAGES:
        raise LanguageRejected(400, "invalid_messages")
    clean, total = [], 0
    for m in messages:
        if not isinstance(m, dict) or m.get("role") not in ("system", "user") or not isinstance(m.get("content"), str):
            raise LanguageRejected(400, "invalid_messages")
        if len(m["content"]) > MAX_MESSAGE_CHARS:
            raise LanguageRejected(413, "message_too_large")
        total += len(m["content"])
        clean.append({"role": m["role"], "content": m["content"]})
    if total > MAX_TOTAL_CHARS:
        raise LanguageRejected(413, "payload_too_large")
    max_tokens = payload.get("maxTokens", TASKS[task])
    if type(max_tokens) is not int or not 1 <= max_tokens <= TASKS[task]:
        raise LanguageRejected(400, "invalid_max_tokens")
    return task, request_id, clean, max_tokens


class LanguageGate:
    """Admission control: authenticated callers, two concurrent model calls, a short bounded queue, a rate cap."""

    def __init__(self, budget, transport=None):
        self.budget = budget
        self.transport = transport or (lambda endpoint, key, payload: complete(endpoint, key, payload, timeout=14))
        self.slots = threading.BoundedSemaphore(CONCURRENCY)
        self.waiting = 0
        self.waiting_lock = threading.Lock()
        self.minute = (0, 0)

    def _rate_ok(self):
        with self.waiting_lock:
            window = int(time.time() // 60)
            start, count = self.minute
            if start != window:
                self.minute = (window, 1)
                return True
            if count >= PER_MINUTE:
                return False
            self.minute = (start, count + 1)
            return True

    def run(self, payload, endpoint, key, model):
        task, request_id, messages, max_tokens = validate(payload)
        if not self._rate_ok():
            raise LanguageRejected(429, "rate_limited")
        with self.waiting_lock:
            if self.waiting >= QUEUE:
                raise LanguageRejected(503, "busy")
            self.waiting += 1
        acquired = self.slots.acquire(timeout=QUEUE_WAIT_SECONDS)
        with self.waiting_lock:
            self.waiting -= 1
        if not acquired:
            raise LanguageRejected(503, "busy")
        try:
            if not self.budget.reserve():
                raise LanguageRejected(429, "request_budget_exhausted")
            started = time.monotonic()
            try:
                response = self.transport(endpoint, key, {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0, "stream": False})
                message = message_from(response)
                content = message.get("content")
                if not isinstance(content, str):
                    raise ProbeFailure("invalid_final_content")
            except ProbeFailure as error:
                self.budget.add("failed")
                raise LanguageRejected(502, error.code) from None
            usage = safe_usage(response)
            self.budget.add("succeeded")
            self.budget.add("prompt_tokens", usage.get("prompt_tokens", 0))
            self.budget.add("completion_tokens", usage.get("completion_tokens", 0))
            return {"ok": True, "task": task, "requestId": request_id, "model": model, "content": content, "usage": usage,
                    "durationMs": int((time.monotonic() - started) * 1000)}
        finally:
            self.slots.release()
