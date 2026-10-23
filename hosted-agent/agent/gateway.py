"""Bounded gateway calls. Responses intentionally exclude model text and secrets."""

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_TOKENS = 128
TIMEOUT_SECONDS = 25
MAX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_MODEL = "claude-haiku-4-5"
STOCK_ARGUMENTS = {"sku": "TEST-1"}
STOCK_RESULT = {"sku": "TEST-1", "available": True, "quantity": 3}
STOCK_TOOL = {"type": "function", "function": {
    "name": "lookup_stock", "description": "Return stock availability for a test SKU.",
    "parameters": {"type": "object", "properties": {"sku": {"type": "string", "enum": ["TEST-1"]}},
                   "required": ["sku"], "additionalProperties": False}}}


class ProbeFailure(Exception):
    def __init__(self, code, upstream_status=None, *, output_shape=None, output_length=None):
        super().__init__(code)
        self.code = code
        self.upstream_status = upstream_status
        self.output_shape = output_shape
        self.output_length = output_length


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProbeFailure("redirect_refused", code)


def endpoint_for(raw_url):
    try:
        parts = urllib.parse.urlsplit(raw_url)
        port = parts.port
    except (ValueError, TypeError):
        raise ProbeFailure("invalid_gateway_url") from None
    if (parts.scheme != "https" or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.query or parts.fragment
            or any(c.isspace() for c in raw_url) or port == 0):
        raise ProbeFailure("invalid_gateway_url")
    base = raw_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")


def safe_usage(response):
    usage = response.get("usage", {})
    if not isinstance(usage, dict):
        return {}
    return {key: value for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            if type(value := usage.get(key)) is int and value >= 0}


def message_from(response):
    choices = response.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise ProbeFailure("invalid_choices")
    choice = choices[0]
    if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
        raise ProbeFailure("invalid_message")
    message = choice["message"]
    if message.get("role") != "assistant":
        raise ProbeFailure("invalid_message_role")
    return message


def validated_tool_message(response):
    calls = message_from(response).get("tool_calls")
    if not isinstance(calls, list) or len(calls) != 1:
        raise ProbeFailure("expected_one_tool_call")
    call = calls[0]
    if not isinstance(call, dict) or call.get("type") != "function":
        raise ProbeFailure("invalid_tool_call")
    call_id = call.get("id")
    if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", call_id):
        raise ProbeFailure("invalid_tool_call_id")
    function = call.get("function")
    if not isinstance(function, dict) or function.get("name") != "lookup_stock":
        raise ProbeFailure("unexpected_tool")
    arguments = function.get("arguments")
    if not isinstance(arguments, str):
        raise ProbeFailure("invalid_tool_arguments")
    try:
        decoded = json.loads(arguments)
    except (ValueError, TypeError):
        raise ProbeFailure("invalid_tool_arguments") from None
    if decoded != STOCK_ARGUMENTS:
        raise ProbeFailure("unexpected_tool_arguments")
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": call_id, "type": "function",
        "function": {"name": "lookup_stock", "arguments": json.dumps(STOCK_ARGUMENTS)}}]}


def parse_json_envelope(content):
    """Accept JSON alone or one complete JSON/unlabelled Markdown code block."""
    stripped = content.strip()
    shape = "markdown_fence" if stripped.startswith("```") else "other"
    candidate = stripped
    if shape == "markdown_fence":
        match = re.fullmatch(r"```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```", stripped)
        if match is None or "```" in match.group(1):
            raise ProbeFailure("final_not_json", output_shape=shape, output_length=len(content))
        candidate = match.group(1)
    try:
        return json.loads(candidate)
    except ValueError:
        raise ProbeFailure("final_not_json", output_shape=shape, output_length=len(content)) from None


def validate_final(response, expected):
    message = message_from(response)
    if message.get("tool_calls"):
        raise ProbeFailure("unexpected_final_tool_call")
    content = message.get("content")
    if not isinstance(content, str):
        raise ProbeFailure("invalid_final_content")
    result = parse_json_envelope(content)
    if not isinstance(result, dict) or set(result) != set(expected):
        raise ProbeFailure("unexpected_final_json")
    if any(result[key] is not value for key, value in expected.items()):
        raise ProbeFailure("unexpected_final_json")


def complete(endpoint, key, payload, timeout=TIMEOUT_SECONDS):
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirects())
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProbeFailure("response_too_large")
        decoded = json.loads(raw)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        raise ProbeFailure("upstream_http_error", code) from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLError):
            raise ProbeFailure("tls_verification_failed") from None
        raise ProbeFailure("network_error") from None
    except (TimeoutError, OSError):
        raise ProbeFailure("network_or_timeout_error") from None
    except (ValueError, UnicodeDecodeError):
        raise ProbeFailure("response_not_json") from None
    if not isinstance(decoded, dict):
        raise ProbeFailure("invalid_response")
    return decoded


def run_probe(mode, endpoint, key, model, transport=None, before_call=None):
    started = time.monotonic()
    report = {"status": "fail", "mode": mode, "model": model, "calls": []}
    stage = "validation"
    send_request = transport or complete
    base = {"model": model, "max_tokens": MAX_TOKENS, "stream": False}

    def send(name, payload):
        nonlocal stage
        stage = name
        call_started = time.monotonic()
        call = {"stage": stage, "usage": {}}
        report["calls"].append(call)
        try:
            if before_call:
                before_call()
            response = send_request(endpoint, key, payload)
            call["usage"] = safe_usage(response)
            return response
        finally:
            call["duration_seconds"] = round(time.monotonic() - call_started, 3)

    try:
        if model != DEFAULT_MODEL or mode not in {"basic", "tool_loop"}:
            raise ProbeFailure("unsupported_probe_configuration")
        if mode == "basic":
            response = send("basic", {**base, "messages": [
                {"role": "system", "content": 'Return only one valid JSON object. '
                 'Do not include markdown, code fences, explanations, or any text outside the JSON.'},
                {"role": "user", "content":
                 'Reply with exactly this JSON object: {"ok":true}'}]})
            validate_final(response, {"ok": True})
        else:
            messages = [
                {"role": "system", "content": 'Use only the provided tool. After its result, '
                 'reply with exactly {"available":true} if available is true, otherwise '
                 '{"available":false}. Return only JSON, without markdown.'},
                {"role": "user", "content": 'Call lookup_stock with exactly {"sku":"TEST-1"} '
                 'and then report whether that item is available.'}]
            response = send("tool_request", {**base, "messages": messages, "tools": [STOCK_TOOL],
                "tool_choice": {"type": "function", "function": {"name": "lookup_stock"}}})
            assistant_message = validated_tool_message(response)
            messages = messages + [assistant_message, {"role": "tool",
                "tool_call_id": assistant_message["tool_calls"][0]["id"],
                "content": json.dumps(STOCK_RESULT)}]
            response = send("tool_result", {**base, "messages": messages, "tools": [STOCK_TOOL],
                                           "tool_choice": "none"})
            validate_final(response, {"available": True})
        report["status"] = "pass"
    except ProbeFailure as error:
        report.update({"error": error.code, "stage": stage})
        if error.upstream_status is not None:
            report["upstream_status"] = error.upstream_status
        if error.output_shape in {"markdown_fence", "other"}:
            report["output_shape"] = error.output_shape
            report["output_length"] = error.output_length
    except Exception:
        report.update({"error": "unexpected_client_error", "stage": stage})
    report["duration_seconds"] = round(time.monotonic() - started, 3)
    return report
