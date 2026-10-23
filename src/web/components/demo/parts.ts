import type { DiagramGoal, DiagramPart, PartStatus } from "../SetupDiagram";

export const PORTS = [["usb-c", "USB-C"], ["usb-a", "USB-A"]] as const;
export const OSES = [["macos", "macOS"], ["windows", "Windows"], ["linux", "Linux"]] as const;
export const APPS = [["zoom", "Zoom"], ["google-meet", "Google Meet"], ["riverside", "Riverside"], ["other", "Another app"]] as const;
export const ROLE_LABEL: Record<string, string> = { mic: "Microphones", interface: "Audio interface", headphones: "Headphones", micCable: "Mic cables", hostCable: "Computer cable", adapter: "Adapter", stand: "Stands", splitter: "Headphone splitter" };

export function goalOf(g: any): DiagramGoal {
  return { localPeople: g?.localPeople ?? null, remoteGuests: g?.remoteGuests ?? null, hostPort: g?.hostPort ?? null, os: g?.os ?? null, callApp: g?.callApp ?? null };
}

/** Demo quote lines -> diagram parts, marking what is missing, new, or leaving compared with the original. */
export function partsFromLines(lines: any[], catalog: any[], opts: { missingSku?: string | null; original?: any[] | null } = {}): DiagramPart[] {
  const facts = new Map(catalog.map((c) => [c.sku, c.facts]));
  const originalSkus = new Set((opts.original ?? []).map((l) => l.sku));
  const status = (sku: string): PartStatus => (sku === opts.missingSku ? "missing" : opts.original && !originalSkus.has(sku) ? "added" : "kept");
  const parts: DiagramPart[] = lines.map((l) => ({ id: l.sku, name: l.name, role: l.role, qty: l.qty, status: status(l.sku), attrs: facts.get(l.sku) }));
  if (opts.original) {
    const now = new Set(lines.map((l) => l.sku));
    for (const o of opts.original) if (!now.has(o.sku)) parts.push({ id: o.sku, name: o.name, role: o.role, qty: o.qty, status: "removed", attrs: facts.get(o.sku) });
  }
  return parts;
}

export const PAYMENT_TEXT: Record<string, { tone: "neutral" | "action" | "confirmed" | "attention" | "danger"; label: string; detail: string }> = {
  READY_FOR_APPROVAL: { tone: "action", label: "Waiting for your approval", detail: "Approve the hold in the PayPal window." },
  AUTHORIZATION_IN_FLIGHT: { tone: "attention", label: "Authorizing", detail: "PayPal is confirming the hold." },
  AUTHORIZED: { tone: "action", label: "Hold placed", detail: "PayPal holds the amount. Nothing is captured until the store confirms the exact goods." },
  CAPTURE_IN_FLIGHT: { tone: "attention", label: "Capturing", detail: "The store confirmed the goods; PayPal is capturing the payment." },
  PAID: { tone: "confirmed", label: "Paid", detail: "Captured once for this exact quote." },
  VOID_IN_FLIGHT: { tone: "attention", label: "Releasing the hold", detail: "ReCart is voiding this hold." },
  VOIDED: { tone: "confirmed", label: "Hold released", detail: "Voided. You were not charged." },
  REFUND_IN_FLIGHT: { tone: "attention", label: "Refunding", detail: "PayPal is processing the refund." },
  REFUNDED: { tone: "confirmed", label: "Refunded", detail: "Refunded in full." },
  STATUS_UNKNOWN: { tone: "attention", label: "Checking with PayPal", detail: "ReCart is confirming the last result before doing anything else." },
  CLOSED_NO_PAYMENT: { tone: "neutral", label: "Closed", detail: "Closed before any payment was authorized." },
  REVIEW_REQUIRED: { tone: "danger", label: "Needs review", detail: "The store must review this payment." },
};
