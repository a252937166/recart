import { Page } from "../components/Shell";
import { ErrorBlock, Notice, Pill, Spinner } from "../components/ui";
import { Link, useFetch, when, type Config } from "../lib/core";

const CAP: Record<string, string> = { catalog_sync: "Catalog sync", inventory_sync: "Stock sync", stock_change_watch: "Stock-change watch", recovery_requests: "Recovery requests", buyer_review_links: "Buyer review links", webhook_receiver: "Signed webhooks", execution_acknowledgement: "Execution acknowledgement" };

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 172800 ? `${Math.round(s / 3600)} hours ago` : when(iso);
}

/** Live integration status of the reference stores, then how any store connects. */
const OUTCOME: Record<string, string> = { no_change_needed: "No change needed", proposal_ready: "Replacement proposed" };

export function Merchants({ cfg }: { cfg: Config | null }) {
  const { data, error, loading, reload } = useFetch<{ data: any[]; stock_change_evidence: any }>("/api/integrations/reference");
  const ev = data?.stock_change_evidence;
  return (
    <Page cfg={cfg}>
      <div className="wrap" style={{ paddingTop: 48 }}>
        <div className="section-head">
          <h1>For merchants</h1>
          <p>Keep selling the way you do. ReCart plans the recovery when an ordered item becomes unavailable and records the buyer's approval; your store keeps inventory, orders and checkout.</p>
        </div>

        <section aria-labelledby="ref-h">
          <div className="panel-head"><h2 id="ref-h">Reference integration status</h2><button className="btn btn-quiet btn-sm" onClick={reload}>Refresh</button></div>
          {loading && !data && <Spinner label="Checking the integration" />}
          {error && <ErrorBlock error={error} retry={reload} />}
          {data && data.data.length === 0 && <Notice>No reference integration is configured on this server.</Notice>}
          {data?.data.map((s) => (
            <div key={s.name} className="panel">
              <div className="panel-head">
                <div>
                  <h3 style={{ fontSize: "var(--s2)" }}>{s.integration?.name ?? s.name}</h3>
                  <div className="small muted">{s.integration?.platform === "shopify" ? "Shopify development store" : s.integration?.platform ?? "custom"} · {s.integration?.source ?? s.name} · reported {ago(s.integration?.reported_at ?? null)}</div>
                </div>
                <Pill tone={s.health === "ok" ? "confirmed" : "attention"} dot>{s.health === "ok" ? "Healthy" : s.health === "attention" ? "Needs attention" : "Not connected"}</Pill>
              </div>
              <div className="compare">
                <div><div className="k">Products synced</div><div className="v num">{s.catalog.active} active</div><div className="small muted">catalog version {s.catalog.catalog_version}</div></div>
                <div><div className="k">Units in stock (fresh counts)</div><div className="v num">{s.inventory.fresh_units}</div><div className="small muted">{s.inventory.locations} location{s.inventory.locations === 1 ? "" : "s"} · {s.inventory.stale_levels} stale</div></div>
                <div><div className="k">Last stock count</div><div className="v" style={{ fontSize: "var(--s1)" }}>{ago(s.inventory.newest_count_at)}</div><div className="small muted">counts older than {Math.round(s.inventory.max_age_seconds / 3600)} h are not used</div></div>
              </div>
              {s.integration && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 18 }}>
                  <div><div className="small muted" style={{ marginBottom: 6 }}>Supported by this integration</div><div className="cap-list">{s.integration.capabilities.map((c: string) => <Pill key={c} tone="confirmed">{CAP[c] ?? c}</Pill>)}</div></div>
                  <div><div className="small muted" style={{ marginBottom: 6 }}>Deliberately not supported</div><div className="cap-list">{s.integration.not_supported.map((c: string) => <Pill key={c}>{c}</Pill>)}</div></div>
                </div>
              )}
              {s.warnings.length > 0 && <Notice tone="attention" title="Warnings">{s.warnings.map((w: string) => <div key={w} className="small">{w}</div>)}</Notice>}
              {s.notes?.length > 0 && <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>{s.notes.join(" ")}</p>}
              <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>This store reads catalog and stock through a read-only Shopify app and sends them to ReCart's public API. It does not change Shopify orders, run Shopify checkout or take payments. Its products are fictional demonstration items.</p>
            </div>
          ))}
        </section>

        {ev?.versions?.length > 1 && (
          <section aria-labelledby="ev-h" style={{ marginTop: 24 }}>
            <div className="panel">
              <h3 id="ev-h" style={{ fontSize: "var(--s1)" }}>Recorded: a stock change in Shopify revised an open recovery</h3>
              <p className="small muted" style={{ margin: "6px 0 14px" }}>{when(ev.recorded_at)}. The {ev.product} was set to 0 and back to 1 in Shopify admin; the sync read each count and ReCart re-planned the open reference recovery.</p>
              <ol className="timeline">
                {ev.versions.map((v: any) => (
                  <li key={v.version}>
                    <span className="dot" style={{ color: v.outcome === "proposal_ready" ? "var(--action)" : "var(--confirmed)" }} aria-hidden />
                    <div>
                      <strong>Version {v.version}: {OUTCOME[v.outcome] ?? v.outcome}</strong> <span className="small muted">at {new Date(v.observed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}, Shopify stock {v.available}</span>
                      {v.outcome === "proposal_ready" && <div className="small">New total ${(v.total_cents / 100).toFixed(2)} (+${(v.difference_cents / 100).toFixed(2)}): {v.added.join(", ")}</div>}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>Evidence file <code>{ev.file}</code>{ev.correction ? ". It includes a correction note about the recorded event labels." : "."}</p>
            </div>
          </section>
        )}

        <section className="section" aria-labelledby="how-h" style={{ paddingTop: 64 }}>
          <div className="section-head"><h2 id="how-h">How a store connects</h2><p>One published contract for any platform. The Shopify example and an independent sample store both use it unchanged.</p></div>
          <ol className="flow">
            <li><span className="n">01</span><h3>Describe products</h3><p>Send each product in the standard format: role, attributes and how each fact is known (documented, tested, or unknown).</p></li>
            <li><span className="n">02</span><h3>Stream stock</h3><p>Send counts with the time they were true. Old counts are ignored; stale counts are never planned with.</p></li>
            <li><span className="n">03</span><h3>Open a recovery</h3><p>When an ordered item is missing, send the order and the buyer's confirmed needs. ReCart returns a versioned proposal.</p></li>
            <li><span className="n">04</span><h3>Send the buyer a link</h3><p>The buyer reviews what changes and why, and approves one exact version. Stock changes revise open proposals automatically.</p></li>
            <li><span className="n">05</span><h3>Apply and acknowledge</h3><p>ReCart revalidates the approved version; you apply it in your own system and report the outcome.</p></li>
          </ol>
          <div className="btn-row" style={{ marginTop: 28 }}>
            <Link to="/developers#explorer" className="btn btn-primary">Try it in the sandbox</Link>
            <Link to="/developers" className="btn btn-secondary">Read the API guide</Link>
          </div>
        </section>
      </div>
    </Page>
  );
}
