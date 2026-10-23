/**
 * The guided demo's stage model, derived only from durable server state: which step the purchase is in, who acts
 * (buyer, store, or ReCart while it waits on PayPal), which view that happens in, and what to do next. Every page
 * renders the same model, so progress survives reloads, tab switches and returning later.
 */
export type Actor = "buyer" | "store" | "system";
export interface Stage { id: string; title: string; actor: Actor; status: "done" | "current" | "upcoming" }
export interface StageModel {
  scenario: "A" | "B" | "C";
  stages: Stage[];
  current: { id: string; title: string; actor: Actor; view: "buyer" | "store"; instruction: string; waiting: string | null } | null;
  ending: null | { kind: "recovered" | "closed_no_solution" | "cancelled" | "completed_without_recovery"; message: string };
}

const AUTH_OR_LATER = ["AUTHORIZED", "CAPTURE_IN_FLIGHT", "PAID", "VOID_IN_FLIGHT", "VOIDED", "REFUND_IN_FLIGHT", "REFUNDED"];
const IN_FLIGHT: Record<string, string> = {
  AUTHORIZATION_IN_FLIGHT: "PayPal is confirming the authorization.",
  CAPTURE_IN_FLIGHT: "PayPal is processing the capture.",
  VOID_IN_FLIGHT: "ReCart is releasing the first PayPal hold.",
  REFUND_IN_FLIGHT: "PayPal is processing the refund.",
  STATUS_UNKNOWN: "ReCart is checking the last PayPal result before doing anything else.",
};

export function demoStage(s: any): StageModel {
  const scenario = (s.session?.scenario ?? "A") as "A" | "B" | "C";
  const attempts: any[] = s.attempts ?? [];
  const first = attempts[0];
  const second = attempts.find((a) => a.quoteId !== first?.quoteId);
  const rc = s.recoveryCase;
  const caseSolve = rc?.solve?.status;
  const tickets: any[] = s.tickets ?? [];
  const handedOver = (co: any) => !!co && tickets.some((t) => t.checkout_id === co.id && t.state === "HANDED_OVER");
  const closed = s.intent?.status === "CLOSED";
  const replacementQuote = s.quote?.kind === "REPLACEMENT";

  type Def = { id: string; title: string; actor: Actor; view: "buyer" | "store"; done: boolean; instruction: string };
  const defs: Def[] = [
    { id: "requirements", title: "Confirm what you need", actor: "buyer", view: "buyer", done: !!s.goal,
      instruction: "Keep the sample request and select [Read my request]. Fill anything marked missing, then select [Confirm requirements]." },
    { id: "quote", title: "Accept a checked setup", actor: "buyer", view: "buyer", done: attempts.length > 0 || s.quote?.status === "ACCEPTED",
      instruction: "Select [Choose this setup] on the recommended setup, then [Accept quote]. Accepting records your consent; it does not charge you." },
    { id: "approval", title: "Approve the hold in PayPal", actor: "buyer", view: "buyer", done: !!first && AUTH_OR_LATER.includes(first.state),
      instruction: "Copy the PayPal Sandbox test login shown above the PayPal button, then select [PayPal] and log in with it. PayPal places a hold; nothing is captured yet." },
    { id: "store_check", title: "Store checks the shelf", actor: "store", view: "store", done: !!rc || first?.state === "PAID",
      instruction: "Switch to the Store view. As the store associate, select [Report missing] on the 2-in USB-C interface." },
  ];
  if (first?.state === "PAID" && !rc) {
    defs.push({ id: "handover", title: "Store hands over the goods", actor: "store", view: "store", done: handedOver(first),
      instruction: "The goods were confirmed instead of reported missing, so no recovery happens. Select [Mark handed over], or start a new demo to see a recovery." });
  } else if (scenario === "C") {
    defs.push({ id: "no_solution", title: "Read why no setup works", actor: "buyer", view: "buyer", done: closed,
      instruction: "ReCart checked every combination and none keeps the remote guest's routing with parts in stock. Read why, then select [Close purchase]. Nothing was charged." });
  } else {
    if (scenario === "B") defs.push({ id: "decision", title: "Decide on the higher total", actor: "buyer", view: "buyer", done: caseSolve === "FEASIBLE" || closed || replacementQuote,
      instruction: "The only complete fix costs $422.28, over your $400 limit. ReCart will not raise it for you: select [Change my requirements], set the budget to $425 and select [Confirm requirements], or [Cancel order]." });
    defs.push(
      { id: "review", title: "Review the rebuilt setup", actor: "buyer", view: "buyer", done: !!second || (replacementQuote && s.quote?.status === "ACCEPTED"),
        instruction: "See why swapping only the interface fails, then select [Review this rebuilt setup], check the changed parts and the price difference, and select [Accept quote]." },
      { id: "reapproval", title: "Approve the new total", actor: "buyer", view: "buyer", done: !!second && AUTH_OR_LATER.includes(second.state),
        instruction: "The first hold was released. Copy the same Sandbox test login, select [PayPal] and approve the new total." },
      { id: "confirm", title: "Store confirms and hands over", actor: "store", view: "store", done: handedOver(second),
        instruction: "Switch to the Store view. Select [Confirm exact goods are here], which captures the payment, then [Mark handed over]." },
    );
  }

  let currentIndex = defs.findIndex((d) => !d.done);
  if (closed && currentIndex >= 0 && scenario !== "C") currentIndex = -1;
  const stages: Stage[] = defs.map((d, i) => ({ id: d.id, title: d.title, actor: d.actor, status: d.done ? "done" : i === currentIndex ? "current" : "upcoming" }));
  const inFlight = attempts.map((a) => IN_FLIGHT[a.state]).find(Boolean) ?? null;
  const reconciling = rc?.status === "RECONCILING" ? "ReCart is releasing the first PayPal hold before showing replacement options." : null;
  const cur = currentIndex >= 0 ? defs[currentIndex]! : null;
  const waiting = inFlight ?? reconciling;
  let ending: StageModel["ending"] = null;
  if (!cur) {
    if (rc?.status === "RESOLVED_RECOVERED" || handedOver(second)) ending = { kind: "recovered", message: "Recovered: the rebuilt setup was approved, captured and handed over. The first hold was voided, so you paid once." };
    else if (rc?.status === "CLOSED_NO_SOLUTION") ending = { kind: "closed_no_solution", message: "Closed with an explanation. The PayPal hold was voided; nothing was charged." };
    else if (closed) ending = { kind: "cancelled", message: "You cancelled the order. Every PayPal hold was released; nothing was charged." };
    else ending = { kind: "completed_without_recovery", message: "The purchase completed without a recovery." };
  }
  return {
    scenario, stages,
    current: cur ? { id: cur.id, title: cur.title, actor: waiting ? "system" : cur.actor, view: cur.view, instruction: cur.instruction, waiting } : null,
    ending,
  };
}
