// The in-game wish box, drawn in the bottom HUD. Closed, it is a small key cap ("F") with "Wish"
// next to it, just right of the day bar; F, Enter or a click on it opens it. Open, it takes over
// the whole HUD strip as a text field, and a hidden <input> holds the focus, so every key goes to
// the text and none to the game (attachKeyboard ignores keys typed into an input). Enter sends
// the wish, Escape or clicking away closes it and keeps the draft. Screen-only: no sim state.
import { MAP_PX_H, HUD_H, NATIVE_W } from "./render";
import { LIMITS } from "../tuning";

/** The letter shown on the key cap and the key code that opens the box. */
export const WISH_KEY = { letter: "F", code: "KeyF" } as const;

const CELL = 5;
const BG = "#202812", FIELD = "#141a0e", EDGE = "#5a6b42", CAP = "#3a4a24", CAP_HI = "#6f8450";
const CREAM = "#f2ecd0", TAN = "#cdbf8a", DIM = "#7d8a62", RUST = "#e0a080";

/** Where the closed chip sits, in game-frame coordinates (y 0 is the top of the map). */
export const CHIP = { x: 270, y: MAP_PX_H + 5, w: 44, h: 13 } as const;
/** The text field while open: left edge, width and how many characters fit. */
const FIELD_X = 52, FIELD_W = NATIVE_W - FIELD_X - 6, FIELD_CHARS = Math.floor((FIELD_W - 6) / CELL);

/** The first character to show so the caret stays in view, given the previous one. */
export function scrollStart(prev: number, caret: number, length: number, visible: number): number {
  let s = Math.min(prev, Math.max(0, length - visible + 1));
  if (caret < s) s = caret;
  if (caret > s + visible - 1) s = caret - visible + 1;
  return Math.max(0, s);
}

function fixedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  for (let i = 0; i < text.length; i++) ctx.fillText(text[i], x + i * CELL, y);
}

function keyCap(ctx: CanvasRenderingContext2D, x: number, y: number, lit: boolean) {
  // A raised key: a darker bottom edge under a lighter face, the letter in the middle.
  ctx.fillStyle = "#141a0e"; ctx.fillRect(x, y + 1, 11, 11);
  ctx.fillStyle = lit ? CAP_HI : CAP; ctx.fillRect(x, y, 11, 10);
  ctx.fillStyle = lit ? "#8fa468" : EDGE; ctx.fillRect(x, y, 11, 1);
  ctx.fillStyle = CREAM; ctx.fillText(WISH_KEY.letter, x + 3, y + 8);
}

export interface WishBoxOpts {
  /** Send the wish. Returns why it can't go now (shown in the box), or null when it was sent. */
  submit(wish: string): string | null;
  /** Called when the box opens, so held game keys can be released. */
  onOpen?(): void;
}

export class WishBox {
  readonly input: HTMLInputElement;
  private scroll = 0;
  /** A short line in the box, such as why the wish couldn't be sent. */
  private hint: { text: string; start: number } | null = null;

  constructor(private opts: WishBoxOpts, parent: HTMLElement = document.body) {
    const i = document.createElement("input");
    i.type = "text"; i.maxLength = LIMITS.WISH_MAX_CHARS; i.className = "wishinput"; i.autocomplete = "off"; i.spellcheck = false;
    i.setAttribute("aria-label", "Your wish");
    i.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.send(); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    i.addEventListener("blur", () => { this.hint = null; });
    parent.append(i);
    this.input = i;
  }

  get isOpen() { return document.activeElement === this.input; }

  open() {
    if (this.isOpen) return;
    this.opts.onOpen?.();
    this.input.focus();
    const n = this.input.value.length; this.input.setSelectionRange(n, n);
  }
  close() { this.input.blur(); }

  private send() {
    const wish = this.input.value.trim();
    if (!wish) { this.close(); return; }
    const why = this.opts.submit(wish);
    if (why) { this.hint = { text: why, start: performance.now() }; return; }
    this.input.value = ""; this.scroll = 0; this.close();
  }

  /** Whether a point in game-frame coordinates is on the closed chip. */
  hitChip(x: number, y: number) { return x >= CHIP.x && x < CHIP.x + CHIP.w && y >= CHIP.y && y < CHIP.y + CHIP.h; }

  /** Draw over the bottom HUD (game-frame coordinates). `busy` dims the chip while a wish is being built. */
  draw(ctx: CanvasRenderingContext2D, now: number, busy: boolean) {
    ctx.save();
    ctx.font = "8px monospace"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    if (this.isOpen) this.drawOpen(ctx, now); else this.drawChip(ctx, busy);
    ctx.restore();
  }

  private drawChip(ctx: CanvasRenderingContext2D, busy: boolean) {
    const { x, y } = CHIP;
    ctx.globalAlpha = busy ? 0.5 : 1;
    keyCap(ctx, x, y, false);
    ctx.fillStyle = this.input.value ? CREAM : TAN; fixedText(ctx, this.input.value ? "Wish…" : "Wish", x + 15, y + 8);
    ctx.globalAlpha = 1;
  }

  private drawOpen(ctx: CanvasRenderingContext2D, now: number) {
    const y0 = MAP_PX_H;
    ctx.fillStyle = BG; ctx.fillRect(0, y0, NATIVE_W, HUD_H);
    ctx.fillStyle = "#3a4a24"; ctx.fillRect(0, y0, NATIVE_W, 1);
    keyCap(ctx, 6, y0 + 4, true);
    ctx.fillStyle = CREAM; fixedText(ctx, "Wish", 21, y0 + 12);
    // The field: a dark box with a lit border, the text in fixed cells, a blinking caret.
    const fy = y0 + 3, fh = 13;
    ctx.fillStyle = EDGE; ctx.fillRect(FIELD_X - 1, fy - 1, FIELD_W + 2, fh + 2);
    ctx.fillStyle = FIELD; ctx.fillRect(FIELD_X, fy, FIELD_W, fh);
    const v = this.input.value, caret = this.input.selectionStart ?? v.length, end = this.input.selectionEnd ?? caret;
    this.scroll = scrollStart(this.scroll, caret, v.length, FIELD_CHARS);
    const tx = FIELD_X + 3, ty = fy + 9;
    if (!v) { ctx.fillStyle = DIM; fixedText(ctx, "What should the world do?", tx, ty); }
    if (end > caret) {
      const a = Math.max(caret, this.scroll) - this.scroll, b = Math.min(end, this.scroll + FIELD_CHARS) - this.scroll;
      if (b > a) { ctx.fillStyle = "#4f6236"; ctx.fillRect(tx + a * CELL, fy + 2, (b - a) * CELL, fh - 4); }
    }
    ctx.fillStyle = CREAM; fixedText(ctx, v.slice(this.scroll, this.scroll + FIELD_CHARS), tx, ty);
    if (Math.floor(now / 530) % 2 === 0) { ctx.fillStyle = CREAM; ctx.fillRect(tx + (caret - this.scroll) * CELL - 1, fy + 2, 1, fh - 4); }
    // Under the field: why the last send didn't go, or the keys.
    const hint = this.hint && now - this.hint.start < 5000 ? this.hint.text : null;
    ctx.fillStyle = hint ? RUST : DIM;
    const line = hint ?? "Enter: make the wish    Esc: close (keeps the text)";
    fixedText(ctx, line.slice(0, Math.floor((FIELD_W - 6) / CELL)), tx, y0 + 25);
    if (!hint && v.length > LIMITS.WISH_MAX_CHARS - 60) {
      const left = `${v.length}/${LIMITS.WISH_MAX_CHARS}`; ctx.fillStyle = v.length >= LIMITS.WISH_MAX_CHARS ? RUST : DIM;
      fixedText(ctx, left, NATIVE_W - 6 - left.length * CELL - 3, y0 + 25);
    }
  }
}
