// Keyboard routing (spec 7): tap-to-turn and hold-to-walk with the old timing. Player input never travels as an event.
import { TUNING } from "../tuning";
import type { Game } from "./runtime";
import type { Dir } from "./interactions";

const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
const GAME_KEYS = new Set([...Object.keys(KEY_DIR), "Space", "KeyE", "KeyQ", "KeyT", "Backquote", "Escape"]);

export class Input {
  held: Dir[] = []; // last-pressed wins (last element)
  holdTicks = 0; stepTimer = 0; startedFacing: Dir | null = null;
  swallowed = false;
  private focusRepeat = 0;
  onDevKey: ((code: string, shift: boolean) => void) | null = null;

  constructor(private game: Game) { game.input = this; }

  reset(): void { this.held = []; this.holdTicks = 0; this.stepTimer = 0; this.startedFacing = null; this.focusRepeat = 0; }

  attach(): void {
    window.addEventListener("keydown", (e) => {
      if (GAME_KEYS.has(e.code) || e.code.startsWith("Arrow")) e.preventDefault();
      if (e.code === "Escape") { this.game.focus.escape(); e.preventDefault(); return; }
      if (e.code === "Backquote" || (e.code === "KeyR" && e.shiftKey) || e.code === "KeyT") { this.onDevKey?.(e.code, e.shiftKey); return; }
      if (this.swallowed) return;
      this.keyDown(e.code, e.repeat);
      if ((e.code === "Space" || e.code === "KeyE") && !e.repeat) this.pressInteract();
      if (e.code === "KeyQ" && !e.repeat) this.pressCycle();
    });
    window.addEventListener("keyup", (e) => { this.keyUp(e.code); });
  }

  private focusSystem() {
    const id = this.game.focus.holder;
    return id ? this.game.registry.byId(id) : undefined;
  }
  private sendFocus(key: string, kind: "down" | "up" | "repeat"): void {
    const s = this.focusSystem();
    if (s?.onInput) this.game.invoke(s, "onInput", () => s.onInput!(key, kind));
  }

  keyDown(code: string, repeat = false): void {
    const dir = KEY_DIR[code];
    // Freeze: every key except Escape (handled by the caller) is ignored.
    if (this.game.focus.mode === "freeze") return;
    if (this.game.focus.mode === "borrow") {
      if (repeat) return;
      if (dir) this.sendFocus(dir, "down");
      else if (code === "KeyE" || code === "Space") this.sendFocus("e", "down");
      else if (code === "KeyQ") this.sendFocus("q", "down");
      if (dir) { this.held = this.held.filter((d) => d !== dir); this.held.push(dir); }
      return;
    }
    if (dir && !repeat) {
      this.held = this.held.filter((d) => d !== dir); this.held.push(dir);
      const facing = this.game.eng.playerRec()?.comps.get("facing") ?? "down";
      this.holdTicks = 0; this.stepTimer = 0; this.startedFacing = dir;
      if (dir !== facing) this.game.movementApi?.turn(dir);
      else { this.game.movementApi?.step(dir); this.stepTimer = TUNING.stepTicks; }
      this.game.interactions.refresh();
    }
  }
  keyUp(code: string): void {
    const dir = KEY_DIR[code]; if (!dir) return;
    this.held = this.held.filter((d) => d !== dir);
    if (this.game.focus.mode === "borrow") this.sendFocus(dir, "up");
  }
  pressInteract(): void {
    if (this.game.focus.mode) {
      if (this.game.focus.mode === "borrow") this.sendFocus("e", "down");
      return;
    }
    this.game.interactions.performCurrent();
  }
  pressCycle(): void {
    if (this.game.focus.mode) {
      if (this.game.focus.mode === "borrow") this.sendFocus("q", "down");
      return;
    }
    this.game.interactions.cycle();
  }

  /** Called every game tick. Own timer, never OS repeat. */
  tick(): void {
    if (this.swallowed) return;
    if (this.game.focus.mode === "freeze") return;
    if (this.game.focus.mode === "borrow") {
      // Repeat at the walking pace while held, from the engine's own timer.
      if (!this.held.length) { this.focusRepeat = 0; return; }
      this.focusRepeat++;
      if (this.focusRepeat >= TUNING.stepTicks) { this.focusRepeat = 0; this.sendFocus(this.held[this.held.length - 1], "repeat"); }
      return;
    }
    if (!this.held.length) return;
    const dir = this.held[this.held.length - 1];
    const facing = this.game.eng.playerRec()?.comps.get("facing") ?? "down";
    this.holdTicks++;
    if (dir !== facing) { this.game.movementApi?.turn(dir); this.holdTicks = 0; this.game.interactions.refresh(); return; }
    if (this.stepTimer > 0) {
      this.stepTimer--;
      if (this.stepTimer === 0) { this.game.movementApi?.step(dir); this.stepTimer = TUNING.stepTicks; this.game.interactions.refresh(); }
      return;
    }
    if (this.holdTicks === TUNING.tapTurnTicks) { this.game.movementApi?.step(dir); this.stepTimer = TUNING.stepTicks; this.game.interactions.refresh(); }
  }
}
