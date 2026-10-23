import { zonedWallTimeToDate } from "../domain/time.js";
import { clock } from "../server/clock.js";
import type { PlatformCtx } from "./core.js";
import type { MerchantRow } from "./merchants.js";
import { assertTimezone } from "./recoveries.js";

/**
 * Turn a buyer's own words into draft requirements in the standard format. The draft quotes the words each value
 * came from and lists what is missing; it is never a confirmation. The buyer confirms (and corrects) before any plan.
 */
export async function draftRequirements(ctx: PlatformCtx, merchant: MerchantRow, a: { text: string; reference_time?: string | undefined; timezone: string }) {
  assertTimezone(a.timezone);
  const referenceTime = a.reference_time ? new Date(a.reference_time) : clock.now();
  const r = await ctx.language.extractGoal({ sessionId: null, intentId: null, merchantId: merchant.id, text: a.text, referenceTime, timezone: a.timezone });
  const x = r.extraction;
  const quote = (f: { span: string } | null) => (f ? { quote: f.span } : null);
  let neededBy: string | null = null;
  const questions = [...x.questions];
  if (x.recordingDate && x.recordingTime) {
    const [y, m, d] = x.recordingDate.value.split("-").map(Number) as [number, number, number];
    const [hh, mm] = x.recordingTime.value.split(":").map(Number) as [number, number];
    neededBy = zonedWallTimeToDate(y, m, d, hh, mm, a.timezone).toISOString();
  } else if (x.recordingDate && !questions.some((q) => /time/i.test(q))) questions.push("What time does the recording start?");
  const requirements = {
    local_people: x.localPeople?.value ?? null,
    remote_guests: x.remoteGuests?.value ?? null,
    host_port: x.hostPort?.value ?? null,
    os: x.os?.value ?? null,
    call_app: x.callApp?.value ?? null,
    budget: x.budgetCents ? { max_total_cents: x.budgetCents.value, currency: merchant.currency } : null,
    needed_by: neededBy,
    timezone: a.timezone,
    owned: { headphones: x.owned.headphones, mic_cables: x.owned.micCables, stands: x.owned.stands },
  };
  const missing: string[] = [];
  if (requirements.local_people === null) missing.push("local_people");
  if (requirements.remote_guests === null) missing.push("remote_guests");
  if (requirements.host_port === null) missing.push("host_port");
  if (requirements.os === null) missing.push("os");
  if ((requirements.remote_guests ?? 0) > 0 && requirements.call_app === null) missing.push("call_app");
  if (requirements.budget === null) missing.push("budget");
  return {
    object: "requirement_draft",
    confirmed: false,
    source: r.source, model: r.model, provider: r.provider, fallback_reason: r.status === "FALLBACK" ? r.error : null,
    requirements,
    quotes: {
      local_people: quote(x.localPeople), remote_guests: quote(x.remoteGuests), host_port: quote(x.hostPort), os: quote(x.os), call_app: quote(x.callApp),
      budget: x.budgetCents ? { quote: x.budgetCents.span } : null, needed_by: x.recordingDate ? { quote: [x.recordingDate.span, x.recordingTime?.span].filter(Boolean).join(" … ") } : null,
    },
    missing_fields: missing,
    conflicts: x.conflicts,
    questions: questions.slice(0, 3),
    note: "A draft is not a confirmation. Show it to the buyer, let them correct it, then send the confirmed requirements in a recovery request.",
  };
}
