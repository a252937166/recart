# Harbor Podcast Supply (independent sample store)

A store written without any ReCart code: its own 10 products (documented and bench-tested facts with sources), stock at `harbor-warehouse`, a 0% tax rule and an in-memory order book. It talks to ReCart only through the REST contract. Python 3.9+, standard library only.

```sh
python3 sample_store.py --base-url https://recart.axiqo.xyz                          # prints a buyer review link
python3 sample_store.py --base-url http://127.0.0.1:4060 --simulate-buyer approve   # also plays the buyer (testing only)
RECART_BASE_URL=http://127.0.0.1:4060 python3 -m unittest -v test_sample_store.py
```

Declared capabilities (reported to ReCart with `PUT /v1/merchant/integration`): catalog sync, inventory sync, recovery requests, buyer review links and execution acknowledgement. The price difference is collected in the store's own checkout; ReCart moves no money for it.

The tests check: an idempotent catalog sync and the reported integration status; a recovery that uses this store's own products and tax rule (a direct USB-B to USB-C cable, so no adapter: +$13.00); a stock change that revises the open proposal; that nothing can execute before the buyer approves, then approval, execution and acknowledgement; and that callbacks verify with this store's own HMAC code.
