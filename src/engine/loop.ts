// Fixed-step loop (spec section 3): logic runs at a fixed 60 ticks per second,
// rendering runs separately on each animation frame. All logic is in ticks.
import { TUNING } from "../tuning";

export class FixedLoop {
  readonly stepMs = 1000 / TUNING.ticksPerSecond;
  private acc = 0;
  /** Add `dtMs` of real time and run as many whole ticks as it covers. Returns the ticks run. */
  advance(dtMs: number, step: () => void): number {
    this.acc += Math.min(TUNING.maxFrameMs, Math.max(0, dtMs));
    let n = 0;
    while (this.acc >= this.stepMs) { step(); this.acc -= this.stepMs; n++; }
    return n;
  }
  /** Drop banked time (while paused, e.g. during a load transition). */
  reset() { this.acc = 0; }
}
