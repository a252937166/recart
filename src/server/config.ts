import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(4060),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("postgres://recart:recart-dev@127.0.0.1:5434/recart"),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:4060"),
  PAYPAL_API_BASE: z.string().url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_SDK_ORIGIN: z.string().url().default("https://www.sandbox.paypal.com"),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  /** "fake" uses the in-process PayPal simulator (tests and offline UI work only). */
  PAYPAL_MODE: z.enum(["sandbox", "fake"]).default("sandbox"),
  /** Local PP04 recording only: lets a test discard one real PayPal response. Refused unless the app runs on loopback. */
  PAYPAL_FAULT_INJECTION: z.enum(["0", "1"]).default("0"),
  // Backup language endpoint (the Astropods-hosted agent). Used only when the Codex gateway cannot answer.
  LANGUAGE_URL: z.string().default(""),
  LANGUAGE_TOKEN: z.string().default(""),
  // Primary language provider: the owner's Codex API gateway (OpenAI-compatible chat completions, one request at a time).
  CODEX_API_URL: z.string().default(""),
  CODEX_API_KEY: z.string().default(""),
  CODEX_MODEL: z.string().default(""),
  CODEX_EFFORT: z.string().default(""),
  // Seconds a buyer-facing draft may take (the gateway refuses at once if its queue cannot meet it), and for the
  // background explanation. Keep the first under the proxy's request timeout.
  CODEX_DEADLINE_SECONDS: z.coerce.number().int().min(5).max(600).default(100),
  CODEX_EXPLAIN_DEADLINE_SECONDS: z.coerce.number().int().min(5).max(900).default(150),
  // "auto": Codex first, the hosted endpoint as backup; "codex" or "hosted" pins one provider.
  LANGUAGE_PROVIDER: z.enum(["auto", "codex", "hosted"]).default("auto"),
  // After a Codex failure, how long the backup answers before Codex is tried again (a status probe may end it sooner).
  LANGUAGE_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  TIMING_PRESET: z.enum(["judge", "test"]).default("judge"),
  WORKER_ENABLED: z.enum(["true", "false"]).default("true"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  /** Dedicated Sandbox Personal buyer logins shown in the judge guide (test-access category, not merchant secrets). */
  JUDGE_BUYERS: z.string().default(""),
  /** Tests only: lets merchant webhooks target loopback URLs. Production callbacks must be public HTTPS. */
  WEBHOOK_ALLOW_LOOPBACK: z.enum(["true", "false"]).default("false"),
  /** Self-serve sandbox merchants (public developer explorer) and how long they live. */
  SANDBOX_SIGNUP: z.enum(["true", "false"]).default("true"),
  SANDBOX_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  SANDBOX_SIGNUPS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(30),
  // Who may set X-Forwarded-For: "loopback" (a reverse proxy on this host), proxy IPs or CIDRs separated by commas,
  // or "none" (the socket address is the client). Anything else lets callers choose their own rate-limit identity.
  TRUST_PROXY: z.string().default("loopback"),
  // Quotas per client address and hour. Demo sessions, AI calls and sandbox sign-ups are counted separately.
  DEMO_SESSIONS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(100),
  LANGUAGE_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(200),
  // Shutdown (SIGTERM): in-flight HTTP requests get SHUTDOWN_DRAIN_SECONDS before their connections are closed, and a
  // running job gets SHUTDOWN_JOB_GRACE_SECONDS before its lease is handed back for the next process. Both run at once;
  // the whole shutdown is bounded well inside the service's stop timeout (TimeoutStopSec in deploy/recart.service).
  SHUTDOWN_DRAIN_SECONDS: z.coerce.number().min(0.1).max(60).default(15),
  SHUTDOWN_JOB_GRACE_SECONDS: z.coerce.number().min(0.1).max(60).default(10),
  // The language lane's grace is short: a model call can run for minutes, and an explanation is safe to resume in the
  // next process, so waiting longer would only keep the server unreachable during a restart.
  SHUTDOWN_LANGUAGE_GRACE_SECONDS: z.coerce.number().min(0).max(60).default(1),
  /** "true" when stdout/stderr go to the systemd journal: error and warning lines get <3>/<4> priority prefixes. */
  LOG_PRIORITY_PREFIX: z.enum(["true", "false"]).default("false"),
  /** Operator merchants whose aggregate integration status is public (e.g. the Shopify reference store), comma-separated. */
  REFERENCE_MERCHANT_IDS: z.string().default(""),
  /** Release identifier shown in the footer and health check (set at deploy time). */
  RELEASE_ID: z.string().default("dev"),
  REPO_URL: z.string().default(""),
  VIDEO_URL: z.string().default(""),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

/** Fastify's trustProxy from TRUST_PROXY. "all" is accepted for odd deployments but lets clients forge their address. */
export function trustProxySetting(v: string): boolean | string {
  const s = v.trim().toLowerCase();
  if (["none", "false", "0", ""].includes(s)) return false;
  if (["all", "true", "1"].includes(s)) return true;
  return v.trim();
}

export function judgeBuyers(cfg: Config): { email: string; password: string }[] {
  return cfg.JUDGE_BUYERS.split(";").map((p) => p.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf(":");
    return { email: pair.slice(0, i), password: pair.slice(i + 1) };
  });
}

/** Timing presets from spec v1.2.1 §9. Minutes. */
export const TIMING = {
  judge: { quoteAcceptMinutes: 5, approvalMinutes: 15, confirmationMinutes: 60 },
  test: { quoteAcceptMinutes: 5, approvalMinutes: 15, confirmationMinutes: 15 },
} as const;
export type TimingPreset = keyof typeof TIMING;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** PP04 fault injection may only run on a loopback-only local server; returns the refusal reason, or null if allowed. */
export function faultInjectionRefusal(cfg: Pick<Config, "PAYPAL_FAULT_INJECTION" | "PUBLIC_BASE_URL" | "HOST">): string | null {
  if (cfg.PAYPAL_FAULT_INJECTION !== "1") return null;
  const host = new URL(cfg.PUBLIC_BASE_URL).hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK.has(host) || !LOOPBACK.has(cfg.HOST)) return "PAYPAL_FAULT_INJECTION is only allowed for a loopback-only local server";
  return null;
}
