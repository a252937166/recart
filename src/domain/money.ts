/**
 * Integer-cent money helpers. All commercial amounts in ReCart are integer USD cents.
 * The fixture tax rule is 8.00% of the subtotal, rounded half-up to the cent.
 */
export const CURRENCY = "USD" as const;
export const FIXTURE_TAX_BPS = 800; // 8.00%

export function assertCents(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer number of cents`);
  return value;
}

/** Half-up rounding of subtotal * bps / 10000, computed with integers only. */
export function taxCents(subtotalCents: number, bps: number = FIXTURE_TAX_BPS): number {
  assertCents(subtotalCents, "subtotal");
  return Math.floor((subtotalCents * bps + 5000) / 10000);
}

/** PayPal amount string, e.g. 37692 -> "376.92". */
export function toPayPalValue(cents: number): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** Parse a PayPal amount string ("376.92") into integer cents without floating point. */
export function fromPayPalValue(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export function formatUSD(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${(abs % 100).toString().padStart(2, "0")}`;
}
