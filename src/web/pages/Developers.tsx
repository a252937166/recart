import { useMemo, useRef, useState } from "react";
import { Page } from "../components/Shell";
import { Code, ErrorBlock, Notice, Pill, Spinner } from "../components/ui";
import { CopyButton, Link, retryAtText, useFetch, useNow, when, type Config } from "../lib/core";
import { authorizationHeader, curlExample, expiryOf, maskKey, mcpUrl } from "../lib/trial";

const store = { get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string | null) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* storage unavailable: the explorer still works for this page view */ } } };

const OUTCOMES: [string, string, string][] = [
  ["proposal_ready", "A complete replacement passes every check.", "Buyer reviews and approves on the review page."],
  ["no_change_needed", "Enough stock exists to fulfil the original items.", "Merchant fulfils the original order."],
  ["budget_conflict", "The closest complete setup costs more than the buyer's limit.", "Buyer may raise the limit or decline."],
  ["deadline_conflict", "The closest complete setup is ready later than needed.", "Buyer may accept the later time or decline."],
  ["no_supported_bundle", "No sellable combination meets every requirement.", "Merchant resolves the order under its policy."],
  ["evidence_incomplete", "A setup would work only if undocumented facts hold.", "Merchant documents the attributes; ReCart recomputes."],
  ["inventory_stale", "A setup needs stock counts older than the freshness window.", "Merchant sends fresh counts; ReCart recomputes."],
  ["needs_clarification", "Hard requirements are missing.", "Merchant asks the buyer and updates requirements."],
  ["unsupported_requirements", "The request is outside the domain pack.", "Merchant handles it manually."],
  ["search_incomplete", "The search stopped at its limit, so there is no conclusion.", "Recompute later."],
];

type Preset = { id: string; label: string; method: "GET" | "POST" | "PUT"; path: string; body?: (ctx: { tryNext: any }) => unknown };
const PRESETS: Preset[] = [
  { id: "create", label: "Open a recovery", method: "POST", path: "/v1/recoveries", body: ({ tryNext }) => ({ ...tryNext, external_order_id: `order-${Math.floor(Date.now() / 1000) % 100000}` }) },
  { id: "preview400", label: "Preview with a $400 limit", method: "POST", path: "/v1/recovery-previews", body: ({ tryNext }) => ({ ...tryNext, requirements: { ...tryNext.requirements, budget: { max_total_cents: 40000, currency: "USD" } } }) },
  { id: "get", label: "Get the recovery", method: "GET", path: "/v1/recoveries/{recovery_id}" },
  { id: "link", label: "Create a buyer link", method: "POST", path: "/v1/recoveries/{recovery_id}/review-links", body: () => ({ expires_in_minutes: 60 }) },
  { id: "sellout", label: "Sell out the USB-B interfaces", method: "POST", path: "/v1/inventory/levels", body: () => ({ levels: ["IF-2B-LB", "IF-4C-LB"].map((product_id) => ({ product_id, location_id: "main", available: 0, as_of: new Date().toISOString() })) }) },
  { id: "restock", label: "Restock them", method: "POST", path: "/v1/inventory/levels", body: () => ({ levels: [{ product_id: "IF-2B-LB", location_id: "main", available: 2, as_of: new Date().toISOString() }] }) },
  { id: "history", label: "Proposal versions", method: "GET", path: "/v1/recoveries/{recovery_id}/proposals" },
  { id: "events", label: "Events", method: "GET", path: "/v1/events?limit=20" },
  { id: "inbox", label: "Signed webhook inbox", method: "GET", path: "/v1/sandbox/inbox?limit=10" },
  { id: "status", label: "Integration status", method: "GET", path: "/v1/merchant/status" },
];

interface Trial { key: string; expiresAt: string | null; merchantId: string | null; tryNext: any; rec: string | null }
const TRIAL_KEYS = ["recart.explorer.key", "recart.explorer.expires", "recart.explorer.merchant", "recart.explorer.trynext", "recart.explorer.rec"];

/**
 * The trial key: an isolated sandbox store in ReCart's testing environment with a temporary all-scope test key,
 * created with the public sandbox endpoint and kept in this browser tab. One key serves the explorer and MCP.
 */
function useTrialKey() {
  const [trial, setTrial] = useState<Trial | null>(() => {
    const key = store.get("recart.explorer.key");
    if (!key) return null;
    let tryNext: any = null;
    try { tryNext = JSON.parse(store.get("recart.explorer.trynext") ?? "null"); } catch { /* keep null */ }
    return { key, expiresAt: store.get("recart.explorer.expires"), merchantId: store.get("recart.explorer.merchant"), tryNext, rec: store.get("recart.explorer.rec") };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false); // the server refused the key as expired or revoked
  const now = useNow(30_000);
  const create = async (): Promise<any | null> => {
    setBusy(true); setError(null); setRefused(false);
    try {
      const r = await fetch("/v1/sandbox/merchants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Trial store" }) });
      const j = await r.json();
      if (!r.ok) throw new Error([j.error?.message ?? `HTTP ${r.status}`, retryAtText(j.error?.details?.retry_at)].filter(Boolean).join(" "));
      const t: Trial = { key: j.api_key, expiresAt: j.expires_at ?? null, merchantId: j.merchant?.id ?? null, tryNext: j.try_next?.body ?? null, rec: null };
      setTrial(t);
      store.set("recart.explorer.key", t.key); store.set("recart.explorer.expires", t.expiresAt); store.set("recart.explorer.merchant", t.merchantId);
      store.set("recart.explorer.trynext", JSON.stringify(t.tryNext)); store.set("recart.explorer.rec", null);
      return j;
    } catch (e: any) { setError(e.message); return null; } finally { setBusy(false); }
  };
  const forget = () => { setTrial(null); setRefused(false); setError(null); TRIAL_KEYS.forEach((k) => store.set(k, null)); };
  const setRec = (rec: string | null) => { setTrial((t) => (t ? { ...t, rec } : t)); store.set("recart.explorer.rec", rec); };
  const expiry = expiryOf(trial?.expiresAt, now);
  return { trial, busy, error, create, forget, setRec, expired: refused || expiry.expired, refused, expiryLabel: expiry.label, markRefused: () => setRefused(true) };
}
type TrialState = ReturnType<typeof useTrialKey>;

/** The MCP section's trial key card: where the key comes from, when it expires, what to copy, and a live connection test. */
function TrialKey({ t, origin }: { t: TrialState; origin: string }) {
  // A result is tagged with the key it was made for: a new key never shows the old key's result, and a late answer
  // for an old key is ignored.
  const [test, setTest] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const key = t.trial?.key ?? null;
  const keyNow = useRef(key); keyNow.current = key;
  const result = test && test.key === key ? test : null;
  const connect = async () => {
    const k = key;
    if (!k) return;
    setTesting(true); setTest(null);
    try {
      const r = await fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const j = await r.json().catch(() => null);
      const tools: any[] = j?.result?.tools ?? [];
      if (!r.ok || !tools.length) {
        if ((r.status === 401 || r.status === 403) && keyNow.current === k) t.markRefused();
        throw new Error(j?.error?.message ?? j?.error?.data?.message ?? `HTTP ${r.status}`);
      }
      setTest({ key: k, ok: true, text: `Connected to ${mcpUrl(origin)} with your key. ${tools.length} tools: ${tools.map((x) => x.name).join(", ")}.` });
    } catch (e: any) { setTest({ key: k, ok: false, text: e.message }); } finally { setTesting(false); }
  };
  if (!t.trial || !key) return (
    <div className="panel trial" id="trial-key">
      <div className="panel-head"><h3>Try it without an account</h3><Pill tone="action">No sign-up</Pill></div>
      <p>Select <b>Get a trial key</b> and ReCart creates an isolated test store for you in its own testing environment, with the same <code>POST /v1/sandbox/merchants</code> call as the quickstart: 18 fictional audio products with stock, a reference order whose interface went missing, and a hosted inbox for signed webhooks. No sign-up, no email and no payment details. The key is a test key (<code>rk_test_…</code>) for that store only; it reaches no real merchant, and no real money is involved.</p>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => void t.create()} disabled={t.busy}>{t.busy ? <Spinner label="Creating your store" /> : "Get a trial key"}</button>
        <span className="small muted">Valid for 72 hours. Kept only in this browser tab; the Sandbox explorer above uses the same key.</span>
      </div>
      {t.error && <Notice tone="danger" title="Could not create a trial store">{t.error}</Notice>}
    </div>
  );
  const { expiresAt, merchantId } = t.trial;
  return (
    <div className="panel trial" id="trial-key">
      <div className="panel-head"><h3>Your trial key</h3><Pill tone={t.expired ? "attention" : "confirmed"}>{t.refused ? "Not accepted" : t.expired ? "Expired" : `Expires ${t.expiryLabel}`}</Pill></div>
      {t.expired ? (
        <Notice tone="attention" title={t.refused && !expiryOf(expiresAt, Date.now()).expired ? "The server no longer accepts this key" : `This key expired${expiresAt ? ` ${when(expiresAt)}` : ""}`}>A trial store and its key live for 72 hours. Select <b>Get a new trial key</b> below: it creates a fresh store with a new key, and the explorer's saved recovery is cleared. Nothing on the old store can be reached again.</Notice>
      ) : (
        <p className="small muted">A test key for sandbox store <code>{merchantId ?? "?"}</code> in ReCart's testing environment, created with <code>POST /v1/sandbox/merchants</code>. It expires {expiresAt ? when(expiresAt) : "with the store"} ({t.expiryLabel}) and stays only in this browser tab. The Sandbox explorer above uses the same key.</p>
      )}
      <div className="key-row"><span className="small muted">Key</span><code>{maskKey(key)}</code><span className="small muted">MCP URL</span><code>{mcpUrl(origin)}</code></div>
      <div className="key-actions">
        <CopyButton text={key} label="Copy key" what="key" className="btn btn-primary btn-sm" />
        <CopyButton text={mcpUrl(origin)} label="Copy MCP URL" what="MCP URL" />
        <CopyButton text={authorizationHeader(key)} label="Copy Authorization header" what="Authorization header" />
      </div>
      <Code label="Connection example with your key filled in: paste it into a terminal" code={curlExample(origin, key)} />
      <div className="btn-row">
        <button className="btn btn-secondary" onClick={() => void connect()} disabled={testing}>{testing ? <Spinner label="Connecting" /> : "Test the connection from this page"}</button>
        <button className="btn btn-quiet btn-sm" onClick={() => void t.create()} disabled={t.busy}>{t.busy ? <Spinner label="Creating" /> : "Get a new trial key"}</button>
        <button className="btn btn-quiet btn-sm" onClick={t.forget}>Forget this key</button>
      </div>
      {t.error && <Notice tone="danger" title="Could not create a trial store">{t.error}</Notice>}
      {result && <Notice tone={result.ok ? "confirmed" : "danger"} title={result.ok ? "The MCP connection works" : "The connection failed"}>{result.text}</Notice>}
    </div>
  );
}

function Explorer({ t }: { t: TrialState }) {
  const key = t.trial?.key ?? null;
  const tryNext = t.trial?.tryNext ?? null;
  const rec = t.trial?.rec ?? null;
  const keyNow = useRef(key); keyNow.current = key;
  const [preset, setPreset] = useState<string>("create");
  const [method, setMethod] = useState<"GET" | "POST" | "PUT">("POST");
  const [path, setPath] = useState("/v1/recoveries");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Responses and errors are tagged with the key they belong to, so a new key starts with a clean pane and a late
  // answer for an old key is never shown or attached to the new store.
  const [respFor, setResp] = useState<{ key: string; status: number; ms: number; requestId: string | null; replayed: boolean; json: any } | null>(null);
  const [errFor, setErr] = useState<{ key: string; text: string } | null>(null);
  const resp = respFor && respFor.key === key ? respFor : null;
  const err = errFor && errFor.key === key ? errFor.text : null;
  const fail = (k: string | null, text: string) => setErr(k ? { key: k, text } : null);
  const choose = (p: Preset, next = tryNext) => {
    setPreset(p.id); setMethod(p.method); setPath(p.path);
    setBody(p.body && next ? JSON.stringify(p.body({ tryNext: next }), null, 2) : "");
  };
  const createSandbox = async () => {
    setErr(null);
    const j = await t.create();
    if (!j) return;
    choose(PRESETS[0]!, j.try_next.body);
    setResp({ key: j.api_key, status: 201, ms: 0, requestId: null, replayed: false, json: { ...j, api_key: `${maskKey(j.api_key)} (kept in this tab only)` } });
  };
  const forget = () => { t.forget(); setResp(null); };
  const send = async () => {
    const k = key;
    if (!k) return;
    setBusy("send"); setErr(null);
    const url = path.replace("{recovery_id}", rec ?? "{recovery_id}");
    if (url.includes("{recovery_id}")) { fail(k, "Open a recovery first: its ID fills {recovery_id}."); setBusy(null); return; }
    let parsed: unknown = undefined;
    if (method !== "GET" && body.trim()) { try { parsed = JSON.parse(body); } catch { fail(k, "The request body is not valid JSON."); setBusy(null); return; } }
    const started = performance.now();
    try {
      const r = await fetch(url, { method, headers: { Authorization: `Bearer ${k}`, ...(parsed !== undefined ? { "Content-Type": "application/json" } : {}), ...(method === "POST" ? { "Idempotency-Key": `explorer-${Date.now()}` } : {}) }, body: parsed !== undefined ? JSON.stringify(parsed) : undefined });
      const json = await r.json().catch(() => null);
      setResp({ key: k, status: r.status, ms: Math.round(performance.now() - started), requestId: r.headers.get("recart-request-id"), replayed: r.headers.get("idempotent-replayed") === "true", json });
      if (keyNow.current === k) {
        if (json?.id?.startsWith?.("rec_")) t.setRec(json.id);
        if (r.status === 401 || r.status === 403) t.markRefused();
      }
    } catch (e: any) { fail(k, e.message); } finally { setBusy(null); }
  };
  const reviewUrl: string | null = resp?.json?.url && String(resp.json.url).includes("/review/") ? resp.json.url : null;
  const p = resp?.json?.proposal ?? (resp?.json?.object === "recovery_preview" ? resp.json : null);
  return (
    <div>
      {!key ? (
        <div className="panel">
          <p style={{ marginTop: 0 }}>Get a trial key: a temporary sandbox store in ReCart's testing environment with 18 fictional audio products, stock, an all-scope test key and a hosted inbox that verifies signed webhooks. No sign-up or payment details; it expires after 72 hours. The same key serves the <a href="#trial-key">MCP section</a>.</p>
          <button className="btn btn-primary" onClick={() => void createSandbox()} disabled={t.busy}>{t.busy ? <Spinner label="Creating your store" /> : "Get a trial key"}</button>
          {t.error && <Notice tone="danger" title="Could not create a trial store">{t.error}</Notice>}
        </div>
      ) : (
        <>
          <div className="copy-field" style={{ marginBottom: 12 }}><span className="small muted">Trial key</span><code>{maskKey(key)}</code><span className="small muted" style={{ whiteSpace: "nowrap" }}>{t.expired ? "expired" : `expires ${t.expiryLabel}`}</span><CopyButton text={key} label="Copy key" what="key" /><button className="btn btn-quiet btn-sm" onClick={forget}>Forget</button></div>
          {t.expired && <Notice tone="attention" title="This trial key has expired">Its store is gone. Select Forget, then Get a trial key for a fresh store and key.</Notice>}
          <div className="explorer">
            <div className="panel">
              <div className="presets" role="group" aria-label="Example requests">{PRESETS.map((x) => <button key={x.id} aria-pressed={preset === x.id} onClick={() => choose(x)}>{x.label}</button>)}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select className="input" style={{ width: 96 }} value={method} onChange={(e) => setMethod(e.target.value as any)} aria-label="Method"><option>GET</option><option>POST</option><option>PUT</option></select>
                <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Path" />
              </div>
              {rec && <p className="small muted" style={{ margin: "8px 0 0" }}>{"{recovery_id}"} = <code>{rec}</code></p>}
              {method !== "GET" && <textarea className="input" style={{ marginTop: 10 }} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Request body (JSON)" spellCheck={false} />}
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" onClick={send} disabled={!!busy}>{busy === "send" ? <Spinner label="Sending" /> : "Send request"}</button>
                <span className="small muted">POST requests get a fresh Idempotency-Key.</span>
              </div>
              {err && <Notice tone="danger">{err}</Notice>}
            </div>
            <div className="panel response" aria-live="polite">
              {!resp ? <p className="muted">Responses appear here. Try "Open a recovery", then "Sell out the USB-B interfaces" and "Get the recovery" to watch the proposal revise.</p> : (
                <>
                  <div className="btn-row" style={{ marginBottom: 10 }}>
                    <span className={`status-badge ${resp.status < 400 ? "ok" : "err"}`}>{resp.status}</span>
                    {resp.ms > 0 && <span className="small muted">{resp.ms} ms</span>}
                    {resp.replayed && <Pill>replayed</Pill>}
                    {resp.requestId && <span className="small muted mono">{resp.requestId}</span>}
                  </div>
                  {p?.outcome && <p style={{ margin: "0 0 10px" }}><Pill tone={p.outcome === "proposal_ready" ? "confirmed" : "attention"}>{p.outcome}</Pill> {p.version ? <span className="small muted">version {p.version}</span> : null}<br /><span className="small">{p.summary}</span></p>}
                  {reviewUrl && <p><a href={reviewUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">Open the buyer's review page</a></p>}
                  <pre className="code" style={{ whiteSpace: "pre-wrap", maxHeight: 420 }}>{JSON.stringify(resp.json, null, 2)}</pre>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// header = ReCart-Signature, rawBody = the exact request body string
export function verifyReCart(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;
const PY_VERIFY = `import hashlib, hmac, time

def verify_recart(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > tolerance or "v1" not in parts:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])`;

export function Developers({ cfg }: { cfg: Config | null }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://recart.axiqo.xyz";
  const caps = useFetch<any>("/v1/capabilities");
  const spec = useFetch<any>("/v1/openapi.json");
  const ops = useMemo(() => {
    if (!spec.data) return [];
    const out: { tag: string; method: string; path: string; summary: string; scope: string | null }[] = [];
    for (const [path, m] of Object.entries<any>(spec.data.paths)) for (const [method, op] of Object.entries<any>(m)) out.push({ tag: op.tags?.[0] ?? "", method, path, summary: op.summary, scope: op["x-recart-scope"] ?? null });
    return out;
  }, [spec.data]);
  const repo = cfg?.repoUrl;
  const trial = useTrialKey();
  const ex = (p: string) => (repo ? <a href={`${repo.replace(/\/$/, "")}/tree/main/recart/${p}`}>{p}</a> : <code>{p}</code>);
  return (
    <Page cfg={cfg}>
      <div className="wrap" style={{ paddingTop: 48 }}>
        <div className="doc-grid">
          <nav className="toc" aria-label="On this page">
            {[["overview", "Overview"], ["quickstart", "Quickstart"], ["explorer", "Sandbox explorer"], ["outcomes", "Recoveries and outcomes"], ["execution", "Approval and execution"], ["webhooks", "Webhooks"], ["errors", "Errors and retries"], ["mcp", "MCP for AI agents"], ["examples", "Examples"], ["reference", "Endpoint reference"]].map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}
          </nav>
          <div className="doc">
            <section id="overview">
              <h1 style={{ marginBottom: 12 }}>Developers</h1>
              <p>ReCart exposes one planning contract three ways: a versioned REST API, signed status webhooks and a remote MCP server. All three use the same services, keys and scopes, so they return the same proposals.</p>
              <dl className="facts" style={{ margin: "18px 0" }}>
                <dt>Base URL</dt><dd><code>{origin}</code></dd>
                <dt>Authentication</dt><dd><code>Authorization: Bearer rk_test_…</code> with scopes {caps.data ? caps.data.authentication.scopes.map((s: string) => <code key={s} style={{ marginRight: 6 }}>{s}</code>) : "…"}</dd>
                <dt>Contract</dt><dd>{caps.data ? `${caps.data.api_version} (${caps.data.contract_version})` : "…"} · <a href="/v1/openapi.json">OpenAPI 3.1</a> · <a href={`/v1/domains/audio-recording-v1`}>domain pack</a> · <a href="/v1/capabilities">capabilities</a></dd>
                <dt>Money and time</dt><dd>Integer minor units with an explicit currency; ISO 8601 timestamps with offset</dd>
              </dl>
              {caps.data && <Notice tone="action" title="Planning and execution are separate">{caps.data.boundary}</Notice>}
              {caps.error && <ErrorBlock error={caps.error} retry={caps.reload} />}
            </section>

            <section id="quickstart">
              <h2>Quickstart</h2>
              <p>Create a sandbox store. The response contains a test key and a ready-to-send recovery request for its reference order, whose interface went missing.</p>
              <Code label="1. Create a sandbox store" code={`curl -X POST ${origin}/v1/sandbox/merchants \\\n  -H 'Content-Type: application/json' -d '{"name":"My test store"}'`} />
              <Code label="2. Open a recovery (body: the response's try_next.body)" code={`curl -X POST ${origin}/v1/recoveries \\\n  -H "Authorization: Bearer $RECART_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-1001-recovery' \\\n  -d @recovery.json`} />
              <Code label="3. Give the buyer a review link" code={`curl -X POST ${origin}/v1/recoveries/$RECOVERY_ID/review-links \\\n  -H "Authorization: Bearer $RECART_KEY" -H 'Content-Type: application/json' -d '{}'`} />
              <p>The same flow runs end to end in {ex("examples/quickstart/quickstart.mjs")} (Node 20+, no dependencies), including a stock change that revises the proposal.</p>
            </section>

            <section id="explorer">
              <h2>Sandbox explorer</h2>
              <p>Send real requests to this server with a temporary sandbox key. The key stays in this browser tab.</p>
              <Explorer t={trial} />
            </section>

            <section id="outcomes">
              <h2>Recoveries and outcomes</h2>
              <p>A recovery belongs to one of your orders. Each computation produces a proposal version with an outcome. Business outcomes are successful responses, never errors, and ReCart never turns missing facts or an incomplete search into a no-solution claim.</p>
              <div className="table-wrap"><table className="data"><thead><tr><th>Outcome</th><th>Meaning</th><th>Who acts next</th></tr></thead><tbody>
                {OUTCOMES.map(([o, m, n]) => <tr key={o}><td><code>{o}</code></td><td>{m}</td><td>{n}</td></tr>)}
              </tbody></table></div>
              <p style={{ marginTop: 12 }}>Every proposal carries the changed items with a reason per role, every compatibility check with its evidence modes, single-item swap analysis, totals (items, shipping, tax) and the difference from the original order. Open proposals are re-planned automatically when your catalog or stock changes; a changed plan becomes a new version and a <code>proposal.revised</code> event.</p>
            </section>

            <section id="execution">
              <h2>Approval and execution</h2>
              <ol>
                <li>Only the buyer approves, on the review page, and only the exact version and hash they saw. ReCart re-plans just before recording the approval.</li>
                <li>You call <code>POST /v1/recoveries/{"{id}"}/executions</code> with the approved proposal ID and hash. ReCart revalidates it against current stock and prices and returns exactly what to apply, or a revised proposal for the buyer if it no longer passes.</li>
                <li>You apply the change in your own systems, including any payment difference, and acknowledge <code>succeeded</code>, <code>failed</code> or <code>unknown</code>. An unknown outcome blocks retries until you reconcile it.</li>
              </ol>
            </section>

            <section id="webhooks">
              <h2>Webhooks</h2>
              <p>Set an HTTPS endpoint with <code>PUT /v1/webhook-endpoint</code>. Each event is POSTed with <code>ReCart-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, an HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> with your signing secret. Reply 2xx; anything else is retried after 30 s, 2 min, 10 min, 30 min, 2 h and 6 h. Deliveries can repeat, so de-duplicate by event ID. Sandbox stores get a hosted inbox at <code>GET /v1/sandbox/inbox</code>.</p>
              {caps.data && <div className="cap-list" style={{ marginBottom: 12 }}>{caps.data.features.webhooks.events.map((e: string) => <code key={e} className="pill">{e}</code>)}</div>}
              <Code label="Verify in Node.js" code={NODE_VERIFY} />
              <Code label="Verify in Python" code={PY_VERIFY} />
            </section>

            <section id="errors">
              <h2>Errors and retries</h2>
              <p>Errors share one shape with a stable code and the request ID from the <code>ReCart-Request-Id</code> header.</p>
              <Code code={`{\n  "error": {\n    "type": "conflict",\n    "code": "proposal_superseded",\n    "message": "A newer version of this proposal exists. Review the current version.",\n    "request_id": "req_…",\n    "details": { "current_proposal_id": "prop_…" }\n  }\n}`} />
              <p>Send an <code>Idempotency-Key</code> with every create. The same key and request within 24 hours replays the stored response (header <code>Idempotent-Replayed: true</code>); the same key with a different request is rejected with <code>idempotency_key_reused</code>.</p>
            </section>

            <section id="mcp">
              <h2>MCP for AI agents</h2>
              <p>A remote MCP server gives agents the planning tools. It uses the same keys, scopes and services as REST. No tool can approve a proposal, change an order or move money; agents hand the buyer a review link instead.</p>
              <TrialKey t={trial} origin={origin} />
              <dl className="facts" style={{ margin: "14px 0" }}>
                <dt>URL</dt><dd><code>{origin}/mcp</code></dd>
                <dt>Transport</dt><dd>Streamable HTTP (stateless, JSON responses)</dd>
                <dt>Authentication</dt><dd><code>Authorization: Bearer rk_test_…</code></dd>
                <dt>Tested client</dt><dd>Official TypeScript SDK 1.32.1, protocol 2025-11-25, in this project's automated tests</dd>
              </dl>
              {caps.data && (
                <div className="table-wrap"><table className="data"><thead><tr><th>Tool</th><th>What it does</th><th>Scope</th></tr></thead><tbody>
                  {caps.data.features.mcp.tools.map((t: any) => <tr key={t.name}><td><code>{t.name}</code></td><td>{t.description}</td><td><code>{t.scope}</code></td></tr>)}
                </tbody></table></div>
              )}
              <Code label="Connect with the official TypeScript SDK" code={`import { Client } from "@modelcontextprotocol/sdk/client/index.js";\nimport { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";\n\nconst client = new Client({ name: "my-agent", version: "1.0.0" });\nawait client.connect(new StreamableHTTPClientTransport(new URL("${origin}/mcp"), {\n  requestInit: { headers: { Authorization: \`Bearer \${process.env.RECART_API_KEY}\` } },\n}));\nconst { tools } = await client.listTools();\nconst preview = await client.callTool({ name: "preview_recovery", arguments: recoveryRequest });`} />
              <Code label="Or call it with plain JSON-RPC" code={`curl ${origin}/mcp \\\n  -H "Authorization: Bearer $RECART_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`} />
              <p>In both examples, <code>RECART_API_KEY</code> is your trial key. A runnable client is in {ex("examples/mcp-client/client.mjs")}.</p>
            </section>

            <section id="examples">
              <h2>Examples</h2>
              <p>Each example uses only the published API and passes its own tests against an unmodified ReCart server in this project's test suite.</p>
              <div className="table-wrap"><table className="data"><thead><tr><th>Example</th><th>Shows</th></tr></thead><tbody>
                <tr><td>{ex("examples/quickstart")}</td><td>Sandbox store, recovery, buyer link, stock-change revisions, events and verified webhooks. Node, no dependencies.</td></tr>
                <tr><td>{ex("examples/sample-store-python")}</td><td>An independently written store with its own catalog, tax rule and order book: sync, recovery, approval, execution and acknowledgement. Python standard library.</td></tr>
                <tr><td>{ex("examples/shopify-sync")}</td><td>Read-only Shopify reference: maps products and stock to the standard format, watches stock and creates a reference recovery. No Shopify checkout, order or payment integration.</td></tr>
                <tr><td>{ex("examples/mcp-client")}</td><td>Remote MCP client with the official SDK.</td></tr>
              </tbody></table></div>
            </section>

            <section id="reference">
              <h2>Endpoint reference</h2>
              <p>Generated from the live <a href="/v1/openapi.json">OpenAPI document</a>.</p>
              {spec.loading && <Spinner label="Loading the specification" />}
              {spec.error && <ErrorBlock error={spec.error} retry={spec.reload} />}
              {ops.length > 0 && (
                <div className="table-wrap"><table className="data"><thead><tr><th>Endpoint</th><th>Purpose</th><th>Scope</th></tr></thead><tbody>
                  {ops.map((o) => <tr key={o.method + o.path}><td style={{ whiteSpace: "nowrap" }}><span className={`method ${o.method}`}>{o.method.toUpperCase()}</span> <code>{o.path}</code></td><td>{o.summary}</td><td>{o.scope ? <code>{o.scope}</code> : <span className="muted">public</span>}</td></tr>)}
                </tbody></table></div>
              )}
              <p style={{ marginTop: 16 }}>Prefer to see it working first? <Link to="/demo">Run the guided demo</Link>.</p>
            </section>
          </div>
        </div>
      </div>
    </Page>
  );
}
