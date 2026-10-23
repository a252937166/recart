import type { Db } from "./pool.js";

/** Ordered, append-only schema migrations. Kept in TypeScript so the compiled server carries them. */
export const MIGRATIONS: { version: string; sql: string }[] = [
  {
    version: "001_init",
    sql: `
create table demo_sessions (
  id uuid primary key,
  scenario text not null check (scenario in ('A','B','C')),
  preset text not null check (preset in ('judge','test')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSING','CLOSED')),
  csrf_token text not null,
  buyer_timezone text not null default 'America/Los_Angeles',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closing_at timestamptz
);

create table inventory (
  session_id uuid not null references demo_sessions(id),
  sku text not null,
  on_hand int not null check (on_hand >= 0),
  updated_at timestamptz not null default now(),
  primary key (session_id, sku)
);

create table intents (
  id uuid primary key,
  session_id uuid not null references demo_sessions(id),
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  closed_reason text,
  current_goal_id uuid,
  current_quote_id uuid,
  active_checkout_id uuid,
  original_quote_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index intents_session on intents(session_id);

create table goal_versions (
  id uuid primary key,
  intent_id uuid not null references intents(id),
  version int not null,
  data jsonb not null,
  source text not null,
  confirmed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (intent_id, version)
);

create table solve_runs (
  id uuid primary key,
  intent_id uuid not null references intents(id),
  goal_id uuid not null references goal_versions(id),
  purpose text not null,
  status text not null,
  result jsonb not null,
  availability jsonb not null,
  combinations int not null,
  feasible_count int not null,
  duration_ms numeric not null,
  created_at timestamptz not null default now()
);

create table language_runs (
  id uuid primary key,
  session_id uuid references demo_sessions(id),
  intent_id uuid references intents(id),
  task text not null,
  status text not null,
  model text,
  prompt_version text,
  schema_version text,
  request jsonb not null,
  response jsonb,
  usage jsonb,
  duration_ms int,
  error text,
  created_at timestamptz not null default now()
);

create table quotes (
  id uuid primary key,
  intent_id uuid not null references intents(id),
  version int not null,
  predecessor_id uuid references quotes(id),
  solve_run_id uuid references solve_runs(id),
  goal_id uuid not null references goal_versions(id),
  kind text not null default 'ORIGINAL' check (kind in ('ORIGINAL','REPLACEMENT')),
  data jsonb not null,
  total_cents int not null,
  hash text not null,
  status text not null default 'PUBLISHED' check (status in ('PUBLISHED','ACCEPTED','SUPERSEDED','EXPIRED','DECLINED')),
  accept_by timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (intent_id, version)
);

create table consents (
  id uuid primary key,
  quote_id uuid not null unique references quotes(id),
  quote_hash text not null,
  actor text not null,
  displayed_terms jsonb not null,
  accepted_at timestamptz not null default now()
);

create table checkouts (
  id uuid primary key,
  intent_id uuid not null references intents(id),
  quote_id uuid not null references quotes(id),
  payment_state text not null,
  paypal_order_id text unique,
  authorization_id text,
  capture_id text,
  refund_id text,
  approval_deadline timestamptz not null,
  release_by timestamptz,
  confirmation_minutes int not null,
  release_blocks jsonb not null default '[]',
  cancel_intent text,
  terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_open_checkout_per_intent on checkouts(intent_id) where not terminal;

create table reservations (
  id uuid primary key,
  session_id uuid not null references demo_sessions(id),
  intent_id uuid not null references intents(id),
  checkout_id uuid references checkouts(id),
  sku text not null,
  qty int not null check (qty > 0),
  status text not null check (status in ('RESERVED','COMMITTED','FROZEN','RELEASED','FULFILLED')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reservations_active on reservations(session_id, sku) where status in ('RESERVED','COMMITTED','FROZEN');

create table payment_operations (
  id uuid primary key,
  checkout_id uuid not null references checkouts(id),
  kind text not null check (kind in ('CREATE_ORDER','AUTHORIZE','CAPTURE','VOID','REFUND')),
  request_id uuid not null unique,
  payload_hash text not null,
  payload jsonb not null,
  status text not null check (status in ('PENDING','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN')),
  provider_ref text,
  provider_status text,
  http_status int,
  debug_id text,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_live_operation_per_kind on payment_operations(checkout_id, kind) where status in ('PENDING','IN_FLIGHT','SUCCEEDED','UNKNOWN');

create table webhook_events (
  id uuid primary key,
  event_id text not null unique,
  event_type text not null,
  resource_type text,
  resource_id text,
  verification text not null,
  payload jsonb not null,
  status text not null default 'RECEIVED',
  checkout_id uuid,
  note text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table recovery_cases (
  id uuid primary key,
  session_id uuid not null references demo_sessions(id),
  intent_id uuid not null references intents(id),
  checkout_id uuid references checkouts(id),
  original_quote_id uuid references quotes(id),
  reason text not null,
  detail jsonb not null default '{}',
  status text not null,
  solve_run_id uuid references solve_runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key,
  session_id uuid not null references demo_sessions(id),
  case_id uuid references recovery_cases(id),
  kind text not null,
  title text not null,
  body text not null,
  link text,
  status text not null default 'PENDING' check (status in ('PENDING','DELIVERED','FAILED')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table fulfillment_tickets (
  id uuid primary key,
  intent_id uuid not null references intents(id),
  checkout_id uuid not null unique references checkouts(id),
  quote_id uuid not null references quotes(id),
  state text not null check (state in ('NOT_RELEASED','BLOCKED','READY_FOR_HANDOFF','HANDED_OVER','CANCELED')),
  blocks jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  dedupe_key text unique,
  run_at timestamptz not null default now(),
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','DONE','FAILED')),
  lease_owner text,
  lease_until timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_due on jobs(status, run_at);

create table audit_events (
  id bigserial primary key,
  session_id uuid,
  intent_id uuid,
  actor text not null,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb,
  at timestamptz not null default now()
);
create index audit_by_session on audit_events(session_id, at);
`,
  },
  {
    // A job that asks to run again while it is running (e.g. a pending capture poll) keeps that request here;
    // the worker turns it into the next run when the current one finishes (readiness review 2026-10-09, P1).
    version: "002_job_rerun",
    sql: `alter table jobs add column rerun_at timestamptz;`,
  },
  {
    // Merchant planning platform (public API and MCP). Every row is owned by one merchant; every query filters by it.
    // Payload columns are json (not jsonb) so API responses keep their documented field order.
    version: "003_platform",
    sql: `
create table merchants (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('sandbox','operator')),
  domain text not null default 'audio-recording-v1',
  currency text not null default 'USD',
  tax_rate_bps int not null default 0 check (tax_rate_bps between 0 and 5000),
  inventory_max_age_seconds int not null default 86400,
  proposal_ttl_seconds int not null default 86400,
  webhook_url text,
  webhook_secret text,
  catalog_version int not null default 0,
  integration json,
  integration_reported_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  disabled_at timestamptz
);
create table api_keys (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  prefix text not null,
  key_hash text not null unique,
  scopes text[] not null,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table catalog_products (
  merchant_id text not null references merchants(id) on delete cascade,
  product_id text not null,
  sku text,
  name text not null,
  role text not null,
  description text,
  attributes json not null,
  price_cents int not null,
  currency text not null,
  status text not null check (status in ('active','draft','archived')),
  source_updated_at timestamptz,
  updated_at timestamptz not null,
  primary key (merchant_id, product_id)
);
create table inventory_levels (
  merchant_id text not null references merchants(id) on delete cascade,
  product_id text not null,
  location_id text not null,
  available int not null check (available >= 0),
  as_of timestamptz not null,
  received_at timestamptz not null,
  primary key (merchant_id, product_id, location_id)
);
create table recoveries (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  external_order_id text not null,
  status text not null,
  currency text not null,
  requirements json not null,
  original_items json not null,
  shipping_cents int not null default 0,
  unavailable_items json not null,
  fulfillment json,
  buyer_reference text,
  metadata json,
  current_proposal_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index recoveries_by_merchant on recoveries(merchant_id, created_at desc);
create table proposals (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  recovery_id text not null references recoveries(id) on delete cascade,
  version int not null,
  status text not null check (status in ('active','superseded','approved','declined','expired')),
  outcome text not null,
  approvable boolean not null,
  body json not null,
  plan_signature text not null,
  hash text not null,
  catalog_version int not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  unique (recovery_id, version)
);
create table review_links (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  recovery_id text not null references recoveries(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  first_opened_at timestamptz,
  revoked_at timestamptz
);
create table approvals (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  recovery_id text not null references recoveries(id) on delete cascade,
  proposal_id text not null references proposals(id) on delete cascade,
  proposal_version int not null,
  proposal_hash text not null,
  decision text not null check (decision in ('approved','declined')),
  review_link_id text,
  decided_at timestamptz not null
);
create unique index one_decision_per_proposal on approvals(proposal_id);
create table executions (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  recovery_id text not null references recoveries(id) on delete cascade,
  proposal_id text not null references proposals(id) on delete cascade,
  proposal_hash text not null,
  status text not null check (status in ('pending','succeeded','failed','unknown')),
  valid_until timestamptz not null,
  external_reference text,
  message text,
  created_at timestamptz not null,
  acknowledged_at timestamptz,
  updated_at timestamptz not null
);
-- At most one execution per recovery may be in progress or unresolved: unknown outcomes are reconciled before any retry.
create unique index one_open_execution on executions(recovery_id) where status in ('pending','unknown');
create table platform_events (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  type text not null,
  data json not null,
  created_at timestamptz not null
);
create index events_by_merchant on platform_events(merchant_id, created_at desc);
create table webhook_deliveries (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  event_id text not null references platform_events(id) on delete cascade,
  url text not null,
  status text not null check (status in ('pending','delivered','failed')),
  attempts int not null default 0,
  last_status_code int,
  last_error text,
  created_at timestamptz not null,
  delivered_at timestamptz,
  next_attempt_at timestamptz
);
create index deliveries_by_merchant on webhook_deliveries(merchant_id, created_at desc);
create table idempotency_records (
  merchant_id text not null references merchants(id) on delete cascade,
  idem_key text not null,
  route text not null,
  request_hash text not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null,
  primary key (merchant_id, idem_key)
);
create table sandbox_inbox (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  received_at timestamptz not null,
  headers json not null,
  body text not null,
  signature_valid boolean
);
create index inbox_by_merchant on sandbox_inbox(merchant_id, received_at desc);
alter table language_runs add column merchant_id text;
`,
  },
  {
    // Operator-controlled fault simulation for one demo session or one merchant: the language service delays or fails
    // its providers for that scope only, so a production timeout or failover check never touches other callers or the
    // shared cooldown. Rows are written by the admin CLI and expire on their own.
    version: "004_language_faults",
    sql: `
create table language_faults (
  scope text primary key,
  fault jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
`,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await db.query("select version from schema_migrations")).rows.map((r) => r.version));
  const done: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("select pg_advisory_xact_lock(424242)");
      const again = await client.query("select 1 from schema_migrations where version=$1", [m.version]);
      if (!again.rowCount) {
        await client.query(m.sql);
        await client.query("insert into schema_migrations(version) values ($1)", [m.version]);
        done.push(m.version);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return done;
}
