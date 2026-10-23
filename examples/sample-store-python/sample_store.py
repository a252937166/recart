#!/usr/bin/env python3
"""Harbor Podcast Supply: an independently implemented sample store that integrates with ReCart.

It has its own catalog, product IDs, prices, evidence sources, stock, tax rule and order book, and talks to ReCart
only through the published REST contract (no ReCart code, no SDK). Python 3.9+, standard library only.

    python3 sample_store.py --base-url https://recart.axiqo.xyz
    python3 sample_store.py --base-url http://127.0.0.1:4060 --simulate-buyer approve

Capabilities declared to ReCart: catalog_sync, inventory_sync, recovery_requests, buyer_review_links,
execution_acknowledgement. Payments for the price difference stay in this store's own checkout (simulated here).
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

SPEC = "https://harbor-podcast-supply.example/specs/"  # fictional store; the evidence sources are illustrative


def attr(value: Any, evidence: str = "documented", src: str = "") -> dict:
    return {"value": value, "evidence": evidence, "source": SPEC + src}


# The store's own catalog, written directly in ReCart's standard format (domain pack audio-recording-v1).
CATALOG = [
    {"product_id": "hps-mic-dyn-01", "sku": "HPS-1001", "name": "Harbor Dynamic Mic", "role": "mic", "price_cents": 5500,
     "attributes": {"output": attr("xlr", src="hps-mic-dyn-01"), "needs_phantom": attr(False, src="hps-mic-dyn-01")}},
    {"product_id": "hps-mic-cond-02", "sku": "HPS-1002", "name": "Harbor Condenser Mic", "role": "mic", "price_cents": 7500,
     "attributes": {"output": attr("xlr", src="hps-mic-cond-02"), "needs_phantom": attr(True, src="hps-mic-cond-02")}},
    {"product_id": "hps-if-duo-c", "sku": "HPS-2001", "name": "Duo Interface USB-C", "role": "interface", "price_cents": 13900,
     "attributes": {"preamps": attr(2, src="hps-if-duo-c"), "phantom": attr(True, src="hps-if-duo-c"), "headphone_outputs": attr(2, src="hps-if-duo-c"),
                    "host_port": attr("usb-c", src="hps-if-duo-c"), "loopback": attr(True, "merchant_tested", "bench-test-2026-09"), "os_support": attr(["macos", "windows"], src="hps-if-duo-c")}},
    {"product_id": "hps-if-duo-b", "sku": "HPS-2002", "name": "Duo Interface USB-B", "role": "interface", "price_cents": 14900,
     "attributes": {"preamps": attr(2, src="hps-if-duo-b"), "phantom": attr(True, src="hps-if-duo-b"), "headphone_outputs": attr(2, src="hps-if-duo-b"),
                    "host_port": attr("usb-b", src="hps-if-duo-b"), "loopback": attr(True, "merchant_tested", "bench-test-2026-09"), "os_support": attr(["macos", "windows"], src="hps-if-duo-b")}},
    {"product_id": "hps-if-solo-c", "sku": "HPS-2003", "name": "Solo Interface USB-C", "role": "interface", "price_cents": 7900,
     "attributes": {"preamps": attr(1, src="hps-if-solo-c"), "phantom": attr(True, src="hps-if-solo-c"), "headphone_outputs": attr(1, src="hps-if-solo-c"),
                    "host_port": attr("usb-c", src="hps-if-solo-c"), "loopback": attr(False, src="hps-if-solo-c"), "os_support": attr(["macos", "windows"], src="hps-if-solo-c")}},
    {"product_id": "hps-hp-closed", "sku": "HPS-3001", "name": "Closed Studio Headphones", "role": "headphones", "price_cents": 3500,
     "attributes": {"type": attr("closed", src="hps-hp-closed")}},
    {"product_id": "hps-xlr-2m", "sku": "HPS-4001", "name": "XLR Cable 2 m", "role": "mic_cable", "price_cents": 1000,
     "attributes": {"ends": attr(["xlr", "xlr"], src="hps-xlr-2m")}},
    {"product_id": "hps-usb-cc", "sku": "HPS-4101", "name": "USB-C Cable", "role": "host_cable", "price_cents": 900,
     "attributes": {"device_end": attr("usb-c", src="hps-usb-cc"), "host_end": attr("usb-c", src="hps-usb-cc")}},
    {"product_id": "hps-usb-bc", "sku": "HPS-4102", "name": "USB-B to USB-C Cable", "role": "host_cable", "price_cents": 1200,
     "attributes": {"device_end": attr("usb-b", src="hps-usb-bc"), "host_end": attr("usb-c", src="hps-usb-bc")}},
    {"product_id": "hps-stand-desk", "sku": "HPS-5001", "name": "Desk Stand", "role": "stand", "price_cents": 1400,
     "attributes": {"type": attr("desk", src="hps-stand-desk")}},
]
STOCK = {"hps-mic-dyn-01": 6, "hps-mic-cond-02": 2, "hps-if-duo-c": 0, "hps-if-duo-b": 3, "hps-if-solo-c": 4, "hps-hp-closed": 8,
         "hps-xlr-2m": 12, "hps-usb-cc": 5, "hps-usb-bc": 4, "hps-stand-desk": 7}
LOCATION = "harbor-warehouse"

# The store's own order book. ORD-5001's interface was found damaged at packing.
ORDERS = {
    "ORD-5001": {
        "lines": {"hps-if-duo-c": 1, "hps-mic-dyn-01": 2, "hps-xlr-2m": 2, "hps-hp-closed": 2, "hps-usb-cc": 1, "hps-stand-desk": 2},
        "paid_cents": None,
        "buyer": {"local_people": 2, "remote_guests": 1, "host_port": "usb-c", "os": "windows", "call_app": "google-meet",
                  "budget": {"max_total_cents": 50000, "currency": "USD"}, "needed_by": None, "timezone": "America/Los_Angeles"},
    }
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def verify_signature(secret: str, body: bytes, header: Optional[str], now: Optional[float] = None, tolerance: int = 300) -> bool:
    """Verify `ReCart-Signature: t=<unix>,v1=<hex HMAC-SHA256 over "<t>.<raw body>">` in constant time."""
    if not header:
        return False
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs((now if now is not None else time.time()) - t) > tolerance or "v1" not in parts:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])


class ReCartError(Exception):
    def __init__(self, status: int, body: dict):
        self.status, self.body = status, body
        err = body.get("error", {})
        super().__init__(f"HTTP {status} {err.get('code')}: {err.get('message')}")


class ReCart:
    """A minimal client for the published REST contract."""

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self.base, self.key = base_url.rstrip("/"), api_key

    def call(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None, auth: bool = True) -> dict:
        headers = {"Accept": "application/json"}
        if auth and self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise ReCartError(e.code, json.loads(e.read() or b"{}")) from None


class HarborStore:
    def __init__(self, recart: ReCart, log=print):
        self.recart, self.log = recart, log
        self.webhook_secret: Optional[str] = None
        self.seen_events: set[str] = set()
        self.last_event: Optional[str] = None

    def provision_sandbox(self) -> dict:
        sb = self.recart.call("POST", "/v1/sandbox/merchants", {"name": "Harbor Podcast Supply (sample)", "seed": "empty", "webhook_inbox": True, "tax_rate_bps": 0}, auth=False)
        self.recart.key = sb["api_key"]
        self.webhook_secret = sb["webhook"]["secret"]
        self.log(f"sandbox merchant {sb['merchant']['id']} (tax 0%, empty catalog)")
        return sb

    def declare_integration(self) -> dict:
        return self.recart.call("PUT", "/v1/merchant/integration", {
            "name": "Harbor Podcast Supply sample", "platform": "custom", "version": "1.0.0", "source": "harbor-podcast-supply.example",
            "capabilities": ["catalog_sync", "inventory_sync", "recovery_requests", "buyer_review_links", "execution_acknowledgement"],
            "not_supported": ["payments through ReCart"]})

    def sync_catalog(self, run_id: Optional[str] = None) -> dict:
        """One sync run = one Idempotency-Key: a retried run replays its result, a new run reports what changed."""
        products = [{**p, "currency": "USD", "status": "active", "description": None} for p in CATALOG]
        r = self.recart.call("POST", "/v1/catalog/products", {"products": products}, idempotency_key=f"harbor-catalog-{run_id or time.time_ns()}")
        self.log(f"catalog: {r['created']} created, {r['updated']} updated, version {r['catalog_version']}")
        return r

    def sync_stock(self, overrides: Optional[dict] = None) -> dict:
        stock = {**STOCK, **(overrides or {})}
        allocated: dict[str, int] = {}
        for order in ORDERS.values():
            for pid, qty in order["lines"].items():
                allocated[pid] = allocated.get(pid, 0) + qty
        levels = [{"product_id": pid, "location_id": LOCATION, "available": max(0, n - allocated.get(pid, 0)), "as_of": now_iso()} for pid, n in stock.items()]
        r = self.recart.call("POST", "/v1/inventory/levels", {"levels": levels})
        self.log(f"stock: {r['applied']} counts applied, {r['changed']} changed")
        return r

    def open_recovery(self, order_id: str, damaged: str) -> dict:
        order = ORDERS[order_id]
        body = {
            "external_order_id": order_id, "currency": "USD", "requirements": order["buyer"],
            "original_items": [{"product_id": pid, "quantity": q} for pid, q in order["lines"].items()],
            "unavailable_items": [{"product_id": damaged, "quantity": 1, "reason": "damaged"}],
            "fulfillment": {"location_ids": [LOCATION]}, "buyer_reference": "harbor-customer-77",
        }
        rec = self.recart.call("POST", "/v1/recoveries", body, idempotency_key=f"{order_id}-recovery-1")
        p = rec["proposal"]
        self.log(f"recovery {rec['id']}: {p['outcome']} — {p['summary']}")
        return rec

    def poll_events(self) -> list[dict]:
        """Read new events in order (the alternative to a public webhook endpoint)."""
        q = f"/v1/events?limit=100{'&after=' + self.last_event if self.last_event else ''}"
        page = self.recart.call("GET", q)
        fresh = [e for e in page["data"] if e["id"] not in self.seen_events]
        for e in fresh:
            self.seen_events.add(e["id"])
        if page["data"]:
            self.last_event = page["data"][-1]["id"]
        return fresh

    def wait_for(self, recovery_id: str, status: str, timeout: float = 20) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            rec = self.recart.call("GET", f"/v1/recoveries/{recovery_id}")
            if rec["status"] == status:
                return rec
            time.sleep(0.4)
        raise TimeoutError(f"recovery did not reach {status}")

    def execute(self, recovery_id: str) -> dict:
        """Apply the approved version to this store's own order, then acknowledge. Money stays in this store's checkout."""
        rec = self.recart.call("GET", f"/v1/recoveries/{recovery_id}")
        p = rec["proposal"]
        started = self.recart.call("POST", f"/v1/recoveries/{recovery_id}/executions", {"proposal_id": p["id"], "proposal_hash": p["hash"]}, idempotency_key=f"{recovery_id}-exec-{p['version']}")
        apply = started["apply"]
        order = ORDERS[rec["external_order_id"]]
        order["lines"] = {i["product_id"]: i["quantity"] for i in apply["items"]}
        order["paid_cents"] = apply["totals"]["total_cents"]
        self.log(f"applied {len(apply['items'])} lines to {rec['external_order_id']}; collect {apply['difference_cents'] / 100:+.2f} USD in our own checkout")
        return self.recart.call("POST", f"/v1/recoveries/{recovery_id}/executions/{started['execution']['id']}/acknowledgement",
                                {"outcome": "succeeded", "external_reference": f"{rec['external_order_id']}-edit-1"}, idempotency_key=f"{started['execution']['id']}-ack")


def simulate_buyer(base_url: str, review_url: str, decision: str) -> dict:
    """Test helper only: plays the buyer by calling the review page's API. In production only the buyer opens the link."""
    token = review_url.rsplit("/review/", 1)[1]
    client = ReCart(base_url)
    view = client.call("GET", f"/api/review/{token}", auth=False)
    p = view["proposal"]
    return client.call("POST", f"/api/review/{token}/decision", {"proposal_id": p["id"], "proposal_hash": p["hash"], "decision": decision}, auth=False)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base-url", default="https://recart.axiqo.xyz")
    ap.add_argument("--simulate-buyer", choices=["approve", "decline"], help="test only: act as the buyer on the review link")
    args = ap.parse_args()
    store = HarborStore(ReCart(args.base_url))
    store.provision_sandbox()
    store.declare_integration()
    store.sync_catalog()
    store.sync_stock()
    rec = store.open_recovery("ORD-5001", damaged="hps-if-duo-c")
    link = store.recart.call("POST", f"/v1/recoveries/{rec['id']}/review-links", {"expires_in_minutes": 120})
    print(f"buyer review link: {link['url']}")
    if not args.simulate_buyer:
        print("Open the link as the buyer to approve, then run this store's execute step.")
        return
    simulate_buyer(args.base_url, link["url"], args.simulate_buyer)
    if args.simulate_buyer == "approve":
        done = store.execute(rec["id"])
        print(f"recovery {done['id']}: {done['status']}")
    for e in store.poll_events():
        print(f"event {e['type']}")


if __name__ == "__main__":
    main()
