/** Server clock. Production uses wall time; automated tests may install a controllable clock. */
export interface Clock { now(): Date }

class WallClock implements Clock { now() { return new Date(); } }

export class TestClock implements Clock {
  private t: number;
  constructor(start: Date) { this.t = start.getTime(); }
  now() { return new Date(this.t); }
  advanceMinutes(m: number) { this.t += m * 60_000; }
  set(d: Date) { this.t = d.getTime(); }
}

let current: Clock = new WallClock();
export const clock = { now: () => current.now() };
/** Test-only: replace the clock. Never called by the hosted judge server. */
export function installClock(c: Clock) { current = c; }
export function resetClock() { current = new WallClock(); }
