// Keyboard layer. Phase 1 handles the dev keys only; movement, E and Q routing
// (spec section 7) arrive with the base systems in Phase 2.
const GAME_CODES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyE", "KeyQ", "Escape", "KeyT", "Backquote"]);

export interface DevKeys { onTimeSpeed(): void; onDevPanel(): void }

/** Every game and dev key calls preventDefault. While `swallowed` (dev panel open), game input is ignored. */
export class Input {
  swallowed = false;
  attach(dev: DevKeys, target: Window = window) {
    target.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // typing in the dev panel
      if (GAME_CODES.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (e.code === "Backquote") { dev.onDevPanel(); return; }
      if (e.code === "KeyT") { dev.onTimeSpeed(); return; }
    });
  }
}
