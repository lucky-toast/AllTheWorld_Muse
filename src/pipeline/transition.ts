// The ~2 s leaf transition of a live load (spec 13.1): fx_leaf pieces swirl across a soft
// fade while ticks and input are paused. Ported from the old LiveLoader.drawTransition.
import { drawSprite, NATIVE_W, MAP_PX_H } from "../engine/render";
import { TUNING } from "../tuning";

/** Draw the transition over the paused world. `start` is when it began (ms), 0 for none. */
export function drawTransition(ctx: CanvasRenderingContext2D, start: number, now: number) {
  if (!start) return;
  const total = TUNING.transitionInMs + TUNING.transitionOutMs;
  const t = Math.min(1, (now - start) / total);
  const inEnd = TUNING.transitionInMs / total;
  // Fade up to covered, hold while the load runs, then fade back.
  const fade = t < inEnd ? t / inEnd : Math.max(0, 1 - (t - inEnd) / (1 - inEnd));
  ctx.save();
  ctx.fillStyle = `rgba(24,32,16,${(fade * TUNING.transitionFade).toFixed(3)})`;
  ctx.fillRect(0, 0, NATIVE_W, MAP_PX_H);
  const tick = Math.floor(now / 16);
  ctx.globalAlpha = Math.min(1, fade * 1.4);
  for (let i = 0; i < TUNING.transitionLeaves; i++) {
    const seed = i * 37.7;
    const x = ((seed * 13 + now * (0.03 + (i % 5) * 0.008)) % (NATIVE_W + 40)) - 20;
    const y = MAP_PX_H / 2 + Math.sin(now / 350 + i * 2.4) * (MAP_PX_H * 0.4) + ((i * 53) % 60) - 30;
    drawSprite(ctx, "fx_leaf", Math.round(x), Math.round(y), tick + i * 7, { frame: i % 6 });
  }
  ctx.restore();
}
