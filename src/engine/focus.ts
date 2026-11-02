// Focus (spec 7): a system can take the controls. Borrow sends arrows, E and Q to its
// onInput; freeze ignores every key but Escape. Guards: Escape always ends focus, a
// time limit per mode, a cooldown per system after its focus ends (waived when the
// focus was taken inside that system's own perform), one holder at a time, released
// when the holder faults or unloads. When focus ends for any reason other than
// `release`, the holder gets onInput("escape", "down") so it can tidy up.
import type { Engine } from "./engine";
import { LIMITS } from "../tuning";

export type FocusMode = "borrow" | "freeze";
export type FocusEnd = "release" | "escape" | "timeout" | "fault" | "unload";
interface Held { system: string; mode: FocusMode; since: number; inPerform: boolean }

export class Focus {
  private held: Held | null = null;
  /** System id -> first tick it may take focus again. */
  private cooldownUntil = new Map<string, number>();
  /** How the most recent focus ended (for the dev panel and tests). */
  lastEnd: { system: string; reason: FocusEnd; tick: number } | null = null;
  /** Called when focus ends for any reason but release: deliver onInput("escape", "down") to the old holder. */
  onForcedEnd: (system: string) => void = () => {};

  constructor(private eng: Engine) {}

  get holder(): string | null { return this.held?.system ?? null; }
  get mode(): FocusMode | null { return this.held?.mode ?? null; }

  /** Take focus. Returns why it is denied, or null. Journaled, so a rolled-back call gives it back. */
  take(system: string, mode: FocusMode, inPerform: boolean): string | null {
    if (this.held) return this.held.system === system ? `"${system}" already holds focus` : `"${this.held.system}" holds focus; one holder at a time`;
    const until = this.cooldownUntil.get(system) ?? 0;
    if (!inPerform && this.eng.tickCount < until) return `focus cooldown: "${system}" may take focus again in ${until - this.eng.tickCount} ticks (no cooldown inside its own perform)`;
    this.set({ system, mode, since: this.eng.tickCount, inPerform });
    return null;
  }

  /** The holder gives focus back. Returns why it is denied, or null. */
  release(system: string): string | null {
    if (this.held?.system !== system) return `"${system}" doesn't hold focus`;
    this.finish();
    this.lastEnd = { system, reason: "release", tick: this.eng.tickCount };
    return null;
  }

  /** End focus for a reason other than release (Escape, time limit, fault, unload). */
  end(reason: Exclude<FocusEnd, "release">): void {
    const h = this.held; if (!h) return;
    this.finish();
    this.lastEnd = { system: h.system, reason, tick: this.eng.tickCount };
    this.onForcedEnd(h.system);
  }

  /** End focus if `system` holds it (fault or unload). */
  endIfHolder(system: string, reason: "fault" | "unload") { if (this.held?.system === system) this.end(reason); }

  /** Called every tick: take the controls back when the holder is over its time limit. */
  tick() {
    const h = this.held; if (!h) return;
    const limit = h.mode === "borrow" ? LIMITS.focusBorrowTicks : LIMITS.focusFreezeTicks;
    if (this.eng.tickCount - h.since >= limit) this.end("timeout");
  }

  /** Forget everything (a fresh world). */
  reset() { this.held = null; this.cooldownUntil.clear(); }

  private finish() {
    const h = this.held!;
    this.set(null);
    // The cooldown is waived when the player started the focus with E (it was taken in perform).
    if (!h.inPerform) {
      const before = this.cooldownUntil.get(h.system);
      this.cooldownUntil.set(h.system, this.eng.tickCount + LIMITS.focusCooldownTicks);
      this.eng.recordUndo(() => { if (before === undefined) this.cooldownUntil.delete(h.system); else this.cooldownUntil.set(h.system, before); });
    }
  }
  private set(v: Held | null) {
    const old = this.held; this.held = v;
    this.eng.recordUndo(() => { this.held = old; });
  }
}
