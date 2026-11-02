// The top bar above the map. Idle it shows the area's name and the latest "What changed" title.
// While a wish waits on the planner or the designer it shows "The world is listening…" or "The
// world is shaping…" in a stream of drifting fx_leaf pieces, so the player can see the world is
// thinking without anything covering the map. Screen-only: no sim state, nothing saved. The load
// itself keeps the full-map leaf transition and the "The world feels different" banner.
import { drawSprite, NATIVE_W } from "./render";

export const TOP_H = 18;

export type ThinkingPhase = "planner" | "designer";

export interface TopBarState {
  /** The area the player is in (an area id such as "clearing"). */
  area: string;
  /** The title of the newest journal entry, if any. */
  last: string | null;
  /** What the wish is waiting on, or null when no wish is being built (or a load is running). */
  thinking: ThinkingPhase | null;
}

const BG = "#202812", EDGE = "#3a4a24", CREAM = "#f2ecd0", TAN = "#cdbf8a", DIM = "#7d8a62";
const CELL = 5; // fixed-width text cells, as in the bottom HUD
const WORDS: Record<ThinkingPhase, string> = { planner: "The world is listening…", designer: "The world is shaping…" };
const LEAVES: Record<ThinkingPhase, number> = { planner: 18, designer: 28 };

function fixedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  for (let i = 0; i < text.length; i++) ctx.fillText(text[i], x + i * CELL, y);
}

/** "dark_cave" -> "Dark Cave". */
export function areaLabel(area: string): string {
  return area.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** Draw the bar at the top of the canvas (y 0 to TOP_H). `now` is in ms. */
export function drawTopBar(ctx: CanvasRenderingContext2D, s: TopBarState, now: number) {
  ctx.save();
  ctx.fillStyle = BG; ctx.fillRect(0, 0, NATIVE_W, TOP_H);
  ctx.fillStyle = EDGE; ctx.fillRect(0, TOP_H - 1, NATIVE_W, 1);
  ctx.font = "8px monospace"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  if (s.thinking) drawThinking(ctx, s.thinking, now);
  else drawIdle(ctx, s);
  ctx.restore();
}

function drawIdle(ctx: CanvasRenderingContext2D, s: TopBarState) {
  const area = `~ ${areaLabel(s.area)} ~`;
  ctx.fillStyle = TAN; fixedText(ctx, area, Math.round(NATIVE_W / 2 - (area.length * CELL) / 2), 12);
  if (s.last) {
    const last = `Last: ${s.last}`.slice(0, 26);
    const x = NATIVE_W - 6 - last.length * CELL;
    drawSprite(ctx, "book", x - 20, 17, 0);
    ctx.fillStyle = DIM; fixedText(ctx, last, x, 12);
  }
}

function drawThinking(ctx: CanvasRenderingContext2D, phase: ThinkingPhase, now: number) {
  // Leaves drift left to right along the whole bar at a few speeds, bobbing gently.
  const span = NATIVE_W + 24;
  for (let i = 0; i < LEAVES[phase]; i++) {
    const x = ((i * 97.3 + now * (0.012 + (i % 4) * 0.005)) % span) - 12;
    const y = 9 + Math.round(Math.sin(now / 420 + i * 2.1) * 3);
    ctx.globalAlpha = 0.55 + 0.45 * ((i * 7) % 3) / 2;
    drawSprite(ctx, "fx_leaf", Math.round(x), y, 0, { frame: i % 6 });
  }
  ctx.globalAlpha = 1;
  // A clear patch behind the words, fading out to the leaves on both sides.
  const words = WORDS[phase];
  const w = words.length * CELL, x0 = Math.round(NATIVE_W / 2 - w / 2);
  const left = x0 - 8, right = x0 + w + 8, fade = 18;
  ctx.fillStyle = BG; ctx.fillRect(left, 0, right - left, TOP_H - 1);
  for (const [a, b] of [[left - fade, left], [right + fade, right]] as const) {
    const g = ctx.createLinearGradient(a, 0, b, 0);
    g.addColorStop(0, "rgba(32,40,18,0)"); g.addColorStop(1, "rgba(32,40,18,1)");
    ctx.fillStyle = g; ctx.fillRect(Math.min(a, b), 0, fade, TOP_H - 1);
  }
  ctx.fillStyle = CREAM; fixedText(ctx, words, x0, 12);
}
