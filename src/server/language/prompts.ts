/** Prompts and response contracts for the two bounded language tasks (spec v1.2.1 §8). Versioned in this repository. */
/**
 * lang-prompts-v3 (2026-10-09): conflicting values leave the field null and are listed in conflicts; one exact span per
 * field (eval case C06 produced invalid JSON by joining two spans). lang-prompts-v2 was tried and reverted because its
 * date examples made plain weekdays resolve a week late; dates are now read deterministically in dates.ts.
 */
export const PROMPT_VERSION = "lang-prompts-v3";
export const SCHEMA_VERSION = "lang-schema-v1";

export function extractGoalMessages(text: string, referenceTimeIso: string, timezone: string) {
  const system = [
    "You extract a podcast-equipment buyer's stated requirements into JSON for a store's checkout assistant.",
    "Return ONLY one JSON object, no prose, no markdown fences.",
    "Never guess. If the buyer did not state a value, use null and list the field in \"unknowns\".",
    "Quote the exact words that support each value in \"span\" (a substring of the buyer text).",
    "Fields and allowed values:",
    "- localPeople: integer people recording in the same room (\"two of us\" = 2). Include the buyer only if implied.",
    "- remoteGuests: integer remote participants joining by call; 0 only if the buyer says nobody joins remotely.",
    "- hostPort: \"usb-c\" | \"usb-a\" (the computer's port) — \"USB-C laptop\" means usb-c.",
    "- os: \"macos\" | \"windows\" | \"linux\" — a MacBook implies macos; a USB-C connector alone does NOT imply an OS.",
    "- callApp: \"zoom\" | \"google-meet\" | \"riverside\" | \"other\" — only if named.",
    "- budgetCents: integer US cents for the all-in maximum (\"$450\" = 45000). Set allIn true unless the buyer says before tax.",
    "- recordingDate: YYYY-MM-DD resolved from the reference time and timezone (e.g. \"Friday\" = the next Friday strictly after the reference date unless the buyer says today). null if no day given.",
    "- recordingTime: HH:MM 24h local time if stated, otherwise null (do not invent a time).",
    "- owned: counts of items the buyer already owns: headphones, micCables, stands (0 when not mentioned).",
    "- negations: list fields the buyer explicitly ruled out (e.g. \"no remote guests\" -> remoteGuests 0 with span).",
    "- conflicts: list of {field, detail} when the buyer states two incompatible values (e.g. two budgets). Do not resolve them: set that field to null, quote both values in detail, and ask which one applies.",
    "- Every span is one exact substring of the buyer text. Never join two quotes in one span and never put two values in one field.",
    "- questions: at most three short clarifying questions for the most important unknowns or conflicts.",
    "Output shape:",
    '{"localPeople":{"value":2,"span":"two people in the room"}|null,"remoteGuests":{...}|null,"hostPort":{...}|null,"os":{...}|null,"callApp":{...}|null,"budgetCents":{"value":45000,"span":"$450","allIn":true}|null,"recordingDate":{"value":"2026-10-16","span":"Friday"}|null,"recordingTime":{"value":"10:00","span":"at 10"}|null,"owned":{"headphones":0,"micCables":0,"stands":0},"unknowns":["os"],"conflicts":[],"questions":["Which operating system does the laptop run?"]}',
  ].join("\n");
  const user = `Reference time: ${referenceTimeIso}\nBuyer timezone: ${timezone}\nBuyer text:\n"""${text}"""`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function explainChangeMessages(facts: unknown) {
  const system = [
    "You explain a store's recomputed equipment bundle to a non-expert podcast buyer.",
    "Use ONLY the facts provided. Do not add products, prices, compatibility claims, or promises.",
    "Mention money only using the exact dollar strings given in the facts.",
    "Return ONLY JSON: {\"summary\":\"<= 60 words explaining what changed and why\",\"options\":[{\"index\":0,\"tradeoff\":\"<= 30 words\"}]}",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: "Facts (JSON):\n" + JSON.stringify(facts) }];
}
