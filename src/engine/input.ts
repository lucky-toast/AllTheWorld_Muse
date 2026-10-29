import type { Dir } from "./api";
import type { Engine } from "./engine";
import { TUNING } from "../tuning";

const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
const GAME_KEYS = new Set([...Object.keys(KEY_DIR), "Space", "KeyE", "KeyQ", "KeyT", "Backquote"]);

/** Keyboard -> input.* events. Tap a new direction to turn; hold to walk at TUNING pace. Own timer, never OS repeat. */
export class Input {
  held: Dir[] = []; // last-pressed wins (last element)
  holdTicks = 0; stepTimer = 0; startedFacing: Dir | null = null;
  swallowed = false;
  constructor(private eng: Engine) {}
  attach(onDevKey: (code: string, shift: boolean) => void) {
    window.addEventListener("keydown", (e) => {
      if (GAME_KEYS.has(e.code) || e.code.startsWith("Arrow")) e.preventDefault();
      if (e.code === "Backquote" || (e.code === "KeyR" && e.shiftKey) || e.code === "KeyT") { onDevKey(e.code, e.shiftKey); return; }
      if (this.swallowed) return;
      const dir = KEY_DIR[e.code];
      if (dir && !e.repeat) {
        this.held = this.held.filter((d) => d !== dir); this.held.push(dir);
        const p = this.eng.player(); const facing = p?.get<string>("facing") ?? "down";
        this.holdTicks = 0; this.stepTimer = 0; this.startedFacing = dir;
        if (dir !== facing) this.eng.emitInput("input.turn", { dir });
        else { this.eng.emitInput("input.move", { dir }); this.stepTimer = TUNING.stepTicks; }
      }
      if ((e.code === "Space" || e.code === "KeyE") && !e.repeat) this.eng.emitInput("input.interact", {});
      if (e.code === "KeyQ" && !e.repeat) this.eng.emitInput("input.secondary", {});
    });
    window.addEventListener("keyup", (e) => {
      const dir = KEY_DIR[e.code]; if (dir) this.held = this.held.filter((d) => d !== dir);
    });
  }
  /** Called every game tick. */
  tick() {
    if (this.swallowed || this.held.length === 0) return;
    const dir = this.held[this.held.length - 1];
    const p = this.eng.player(); if (!p) return;
    const facing = p.get<string>("facing") ?? "down";
    this.holdTicks++;
    if (dir !== facing) { this.eng.emitInput("input.turn", { dir }); this.holdTicks = 0; return; }
    if (this.startedFacing === dir && this.holdTicks === 1 && false) return;
    // New-direction taps: wait tapTurnTicks before first step. Same-direction presses already stepped on keydown.
    if (this.stepTimer > 0) { this.stepTimer--; if (this.stepTimer === 0) { this.eng.emitInput("input.move", { dir }); this.stepTimer = TUNING.stepTicks; } return; }
    if (this.holdTicks === TUNING.tapTurnTicks) { this.eng.emitInput("input.move", { dir }); this.stepTimer = TUNING.stepTicks; }
  }
}
