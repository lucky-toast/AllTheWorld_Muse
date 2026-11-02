// Focus: borrow and freeze, with every guard from spec 7.
import { TUNING } from "../tuning";

export type FocusMode = "borrow" | "freeze";
export interface FocusHost {
  tickNow: () => number;
  onEscape: (systemId: string) => void;
}
/** Tracks the one focus holder, its time limit and per-system cooldowns. */
export class FocusManager {
  holder: string | null = null;
  mode: FocusMode | null = null;
  private startedTick = 0;
  private fromPerform = false;
  private cooldownUntil = new Map<string, number>();
  /** Set by the runtime while a perform call runs; taking focus then waives the cooldown. */
  inPerform = false;

  constructor(private host: FocusHost) {}

  get held(): boolean { return this.holder !== null; }
  isHolder(id: string): boolean { return this.holder === id; }
  cooldownRemaining(id: string): number { return Math.max(0, (this.cooldownUntil.get(id) ?? 0) - this.host.tickNow()); }

  /** Returns null on success, or a denial message. */
  take(systemId: string, mode: FocusMode): string | null {
    if (this.holder !== null) return `focus is already held by ${this.holder}`;
    if (!this.fromPerformWaiver(systemId) && this.cooldownRemaining(systemId) > 0) return `focus for ${systemId} is on cooldown`;
    this.holder = systemId; this.mode = mode; this.startedTick = this.host.tickNow(); this.fromPerform = this.inPerform;
    return null;
  }
  private fromPerformWaiver(systemId: string): boolean {
    // Waived when the focus was taken inside a perform (the player started it with E).
    void systemId; return this.inPerform;
  }
  /** End focus. `byRelease` suppresses the escape notification; every other end sends it. */
  end(reason: "release" | "escape" | "timeout" | "fault" | "unload" | "reload"): void {
    if (!this.holder) return;
    const holder = this.holder;
    const wasFromPerform = this.fromPerform;
    this.holder = null; this.mode = null; this.fromPerform = false;
    const cooldownTicks = TUNING.limits.focusCooldownSeconds * TUNING.ticksPerSecond;
    if (!wasFromPerform) this.cooldownUntil.set(holder, this.host.tickNow() + cooldownTicks);
    if (reason !== "release") this.host.onEscape(holder);
  }
  releaseBy(systemId: string): string | null {
    if (this.holder !== systemId) return "this system does not hold focus";
    this.end("release"); return null;
  }
  escape(): void { this.end("escape"); }
  /** Called every tick; returns the holder if its time limit just expired. */
  checkTimeout(): string | null {
    if (!this.holder || !this.mode) return null;
    const limitSec = this.mode === "borrow" ? TUNING.limits.focusBorrowSeconds : TUNING.limits.focusFreezeSeconds;
    if (this.host.tickNow() - this.startedTick >= limitSec * TUNING.ticksPerSecond) { const h = this.holder; this.end("timeout"); return h; }
    return null;
  }
  clearCooldown(id: string): void { this.cooldownUntil.delete(id); }
  reset(): void { this.holder = null; this.mode = null; this.fromPerform = false; this.cooldownUntil.clear(); }
}
