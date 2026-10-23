"""Integration tests for the sample store's declared capabilities against a running ReCart server.

    RECART_BASE_URL=http://127.0.0.1:4060 python3 -m unittest -v test_sample_store.py
"""
import os
import time
import unittest

from sample_store import ORDERS, HarborStore, ReCart, ReCartError, simulate_buyer, verify_signature

BASE = os.environ.get("RECART_BASE_URL", "http://127.0.0.1:4060")


class SampleStoreIntegration(unittest.TestCase):
    def setUp(self):
        ORDERS["ORD-5001"]["lines"] = {"hps-if-duo-c": 1, "hps-mic-dyn-01": 2, "hps-xlr-2m": 2, "hps-hp-closed": 2, "hps-usb-cc": 1, "hps-stand-desk": 2}
        self.store = HarborStore(ReCart(BASE), log=lambda *_: None)
        self.store.provision_sandbox()
        self.store.declare_integration()
        self.store.sync_catalog()
        self.store.sync_stock()

    def test_catalog_sync_is_idempotent_and_status_reports_the_integration(self):
        first = self.store.sync_catalog(run_id="run-2")
        self.assertEqual((first["created"], first["unchanged"]), (0, 10))  # a new run over unchanged data changes nothing
        replay = self.store.sync_catalog(run_id="run-2")  # a retried run replays the stored result
        self.assertEqual(replay, first)
        status = self.store.recart.call("GET", "/v1/merchant/status")
        self.assertEqual(status["catalog"]["active"], 10)
        self.assertEqual(status["integration"]["platform"], "custom")
        self.assertIn("execution_acknowledgement", status["integration"]["capabilities"])

    def test_recovery_uses_this_stores_own_products_and_tax_rule(self):
        rec = self.store.open_recovery("ORD-5001", damaged="hps-if-duo-c")
        p = rec["proposal"]
        self.assertEqual(p["outcome"], "proposal_ready")
        added = sorted(i["product_id"] for i in p["replacement"]["items"] if i["change"] == "added")
        self.assertEqual(added, ["hps-if-duo-b", "hps-usb-bc"])  # direct USB-B to USB-C cable: no adapter needed
        self.assertEqual(p["replacement"]["totals"]["tax_cents"], 0)
        self.assertEqual(p["replacement"]["difference_cents"], 14900 - 13900 + 1200 - 900)
        same = self.store.open_recovery("ORD-5001", damaged="hps-if-duo-c")  # retried with the same Idempotency-Key
        self.assertEqual(same["id"], rec["id"])

    def test_stock_change_revises_the_open_proposal(self):
        rec = self.store.open_recovery("ORD-5001", damaged="hps-if-duo-c")
        self.store.sync_stock({"hps-if-duo-b": 0})  # the last USB-B interfaces were sold
        deadline = time.time() + 20
        while time.time() < deadline:
            now = self.store.recart.call("GET", f"/v1/recoveries/{rec['id']}")
            if now["proposal"]["version"] > 1:
                break
            time.sleep(0.4)
        self.assertEqual(now["proposal"]["version"], 2)
        self.assertEqual(now["proposal"]["outcome"], "no_supported_bundle")
        types = [e["type"] for e in self.store.poll_events()]
        self.assertIn("proposal.revised", types)

    def test_approval_execution_and_acknowledgement(self):
        rec = self.store.open_recovery("ORD-5001", damaged="hps-if-duo-c")
        link = self.store.recart.call("POST", f"/v1/recoveries/{rec['id']}/review-links", {"expires_in_minutes": 30})
        with self.assertRaises(ReCartError) as denied:  # nothing can be executed before the buyer approves
            self.store.recart.call("POST", f"/v1/recoveries/{rec['id']}/executions", {"proposal_id": rec["proposal"]["id"], "proposal_hash": rec["proposal"]["hash"]})
        self.assertEqual(denied.exception.body["error"]["code"], "not_approved")
        simulate_buyer(BASE, link["url"], "approve")
        done = self.store.execute(rec["id"])
        self.assertEqual(done["status"], "completed")
        self.assertIn("hps-if-duo-b", ORDERS["ORD-5001"]["lines"])
        self.assertNotIn("hps-if-duo-c", ORDERS["ORD-5001"]["lines"])
        types = [e["type"] for e in self.store.poll_events()]
        for t in ["recovery.created", "proposal.approved", "execution.started", "execution.succeeded"]:
            self.assertIn(t, types)

    def test_signed_callbacks_verify_with_this_stores_own_code(self):
        self.store.open_recovery("ORD-5001", damaged="hps-if-duo-c")
        deadline = time.time() + 20
        inbox = []
        while time.time() < deadline and not inbox:
            inbox = self.store.recart.call("GET", "/v1/sandbox/inbox?limit=20")["data"]
            time.sleep(0.4)
        self.assertTrue(inbox, "the hosted inbox received no callbacks")
        m = inbox[0]
        body = m["raw_body"].encode()  # verify the exact bytes that were signed
        self.assertTrue(verify_signature(self.store.webhook_secret, body, m["headers"]["recart-signature"]))
        self.assertFalse(verify_signature("whsec_wrong", body, m["headers"]["recart-signature"]))
        self.assertFalse(verify_signature(self.store.webhook_secret, body + b" ", m["headers"]["recart-signature"]))


if __name__ == "__main__":
    unittest.main()
