/** Timezone helpers built on Intl only (no external date library). */

export const STORE_TIMEZONE = "America/Los_Angeles";

/** Offset in minutes of `tz` at `instant` (e.g. -420 for PDT). */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in `tz` to an absolute Date. */
export function zonedWallTimeToDate(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  const second = guess - tzOffsetMinutes(new Date(first), tz) * 60000;
  return new Date(second);
}

/** Calendar date (y, m, d) of `instant` in `tz`. */
export function zonedDate(instant: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(fmt.formatToParts(instant).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday };
}

export function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Fixture store pickup policy (simulated store, Pacific time): two-hour pickup slots starting at
 * 10:00, 12:00, 14:00, 16:00 and 18:00, first slot starting at least `leadHours` after `now`.
 */
export interface PickupWindow { start: string; end: string; timezone: string; label: string }
export const PICKUP_POLICY = { slotStartHours: [10, 12, 14, 16, 18], slotHours: 2, leadHours: 2, timezone: STORE_TIMEZONE, version: "pickup-policy-v1" } as const;

export function firstPickupWindow(now: Date, leadHours: number = PICKUP_POLICY.leadHours, tz: string = PICKUP_POLICY.timezone): PickupWindow {
  const today = zonedDate(now, tz);
  for (let i = 0; i < 14; i++) {
    const day = addDays(today.y, today.m, today.d, i);
    for (const h of PICKUP_POLICY.slotStartHours) {
      const start = zonedWallTimeToDate(day.y, day.m, day.d, h, 0, tz);
      if (start.getTime() - now.getTime() >= leadHours * 3600_000) {
        const end = zonedWallTimeToDate(day.y, day.m, day.d, h + PICKUP_POLICY.slotHours, 0, tz);
        const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(start);
        const fmtH = (x: number) => `${((x + 11) % 12) + 1}${x < 12 ? " am" : " pm"}`;
        return { start: start.toISOString(), end: end.toISOString(), timezone: tz, label: `${dayLabel}, ${fmtH(h)}–${fmtH(h + PICKUP_POLICY.slotHours)} PT` };
      }
    }
  }
  throw new Error("no pickup window found");
}

/** Next occurrence (strictly after `now`'s calendar day) of `weekday` (0=Sun) at hh:mm in tz. */
export function nextWeekdayAt(now: Date, weekday: number, hh: number, mm: number, tz: string): Date {
  const today = zonedDate(now, tz);
  let delta = (weekday - today.weekday + 7) % 7;
  if (delta === 0) delta = 7;
  const day = addDays(today.y, today.m, today.d, delta);
  return zonedWallTimeToDate(day.y, day.m, day.d, hh, mm, tz);
}

export function formatInZone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
