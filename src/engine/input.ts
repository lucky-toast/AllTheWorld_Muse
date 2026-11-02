// Input (spec 7). The engine reads the keyboard; player input never travels as an event.
//
// The browser layer (`attachKeyboard`) turns key codes into logical keys and queues them
// on `Controls`; Controls handles the queue at the start of the next tick, so the same
// path serves real keys and the test-only sim.* requests.
//
// Without focus: arrows/WASD go to base movement's onInput (movement does the old
// tap-to-turn and hold-to-walk timing on its own timer), E and Space run the highlighted
// action, Q cycles. With borrow focus: arrows, E and Q go to the holder's onInput, with
// "repeat" at the walking pace from the engine's own timer. With freeze focus: every key
// but Escape is ignored. Escape always ends focus.
import type { Host } from "./host";
import { TUNING } from "../tuning";

export type Key = "up" | "down" | "left" | "right" | "e" | "q" | "escape";
export const KEYS: readonly Key[] = ["up", "down", "left", "right", "e", "q", "escape"];
const DIRS = new Set<Key>(["up", "down", "left", "right"]);
/** The base system that gets arrow keys when nobody holds focus. */
export const MOVEMENT_ID = "movement";

export class Controls {
  private queue: { key: Key; kind: "down" | "up" }[] = [];
  /** Keys held right now, oldest first. */
  private held: Key[] = [];
  /** Ticks each key has been held, for borrow-focus repeats. */
  private heldTicks = new Map<Key, number>();
  /** Direction keys movement was told are down (so it can be told they are up). */
  private toMovement = new Set<Key>();

  constructor(private host: Host) {}

  /** Queue a key press. It takes effect at the start of the next tick. */
  press(key: Key) { this.queue.push({ key, kind: "down" }); }
  /** Queue a key release. */
  release(key: Key) { this.queue.push({ key, kind: "up" }); }
  /** Release every held key (window blur, dev panel opened). */
  releaseAll() { for (const k of this.held) this.release(k); }
  isHeld(key: Key) { return this.held.includes(key); }

  /** Handle queued keys, then borrow-focus repeats. Called once per tick by Host.tick. */
  tick() {
    const q = this.queue; this.queue = [];
    for (const ev of q) { if (ev.kind === "down") this.down(ev.key); else this.up(ev.key); this.syncMovement(); }
    if (this.host.focus.mode === "borrow") {
      const holder = this.host.focus.holder!;
      for (const k of [...this.held]) {
        if (k === "escape") continue;
        const n = (this.heldTicks.get(k) ?? 0) + 1; this.heldTicks.set(k, n);
        if (n % TUNING.stepTicks === 0 && this.host.focus.holder === holder) this.host.deliverInput(holder, k, "repeat");
      }
    }
    this.syncMovement();
  }

  private down(key: Key) {
    if (this.held.includes(key)) return;
    this.held.push(key); this.heldTicks.set(key, 0);
    const focus = this.host.focus;
    if (key === "escape") { if (focus.holder) focus.end("escape"); return; }
    if (focus.mode === "freeze") return;
    if (focus.mode === "borrow") { this.host.deliverInput(focus.holder!, key, "down"); return; }
    if (DIRS.has(key)) { this.toMovement.add(key); this.host.deliverInput(MOVEMENT_ID, key, "down"); return; }
    if (key === "e") this.host.interactions.perform();
    if (key === "q") this.host.interactions.cycle();
  }

  private up(key: Key) {
    if (!this.held.includes(key)) return;
    this.held = this.held.filter((k) => k !== key); this.heldTicks.delete(key);
    if (key === "escape") return;
    if (this.toMovement.delete(key)) { this.host.deliverInput(MOVEMENT_ID, key, "up"); return; }
    if (this.host.focus.mode === "borrow") this.host.deliverInput(this.host.focus.holder!, key, "up");
  }

  /** While anyone holds focus, movement must think every key is up, so it can't keep walking. */
  private syncMovement() {
    if (!this.host.focus.holder || !this.toMovement.size) return;
    const keys = [...this.toMovement]; this.toMovement.clear();
    for (const k of keys) this.host.deliverInput(MOVEMENT_ID, k, "up");
  }
}

const CODE_KEY: Record<string, Key> = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
  KeyE: "e", Space: "e", KeyQ: "q", Escape: "escape",
};
/** Every game and dev key calls preventDefault (spec 3). */
const PREVENT = new Set([...Object.keys(CODE_KEY), "KeyT", "KeyC", "Backquote"]);

export interface DevKeys { onTimeSpeed(): void; onDevPanel(): void; onReloadSystems(): void; /** C: the "What changed" panel. */ onChanged?(): void }

/** Browser keyboard: dev keys, and game keys queued on `controls` unless `swallowed()` (dev panel open). */
export function attachKeyboard(controls: Controls, dev: DevKeys, swallowed: () => boolean, target: Window = window) {
  target.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // typing in the dev panel
    if (PREVENT.has(e.code)) e.preventDefault();
    if (e.repeat) return; // the engine paces held keys itself, never the OS repeat
    if (e.code === "Backquote") { dev.onDevPanel(); return; }
    if (e.code === "KeyT") { dev.onTimeSpeed(); return; }
    if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey) { dev.onChanged?.(); return; }
    if (e.code === "KeyR" && e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); dev.onReloadSystems(); return; }
    const key = CODE_KEY[e.code];
    if (key && !swallowed()) controls.press(key);
  });
  target.addEventListener("keyup", (e) => {
    const key = CODE_KEY[e.code];
    if (key) controls.release(key); // releases always go through, so nothing sticks down
  });
  target.addEventListener("blur", () => controls.releaseAll());
}
