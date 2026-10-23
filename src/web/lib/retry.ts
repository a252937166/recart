/** "You can try again at 3:42 PM (in 38 min)." from a server-reported reset time, or null. */
export function retryAtText(iso: string | null | undefined, now = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.max(1, Math.round((t - now) / 60_000));
  return `You can try again at ${new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (in ${min} min).`;
}
