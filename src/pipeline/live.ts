import type { Engine } from "../engine/engine";
import type { SystemDef } from "../engine/api";
import { evalSystem } from "./eval";
import { saveSystem, saveWorld } from "./persistence";
import { drawSprite } from "../engine/render";
import type { Report } from "./types";

export interface RuntimeSystem { id: string; source: string; buildsOn: string[]; def: SystemDef }

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Live Load stage: pause, leaf transition (~2s), load while covered, banner. Plus persistence and startup restore. */
export class LiveLoader {
  runtime = new Map<string, RuntimeSystem>();
  skipped: string[] = [];
  transitionStart = 0; // performance.now() when the transition began, 0 = none
  private eng: Engine;
  constructor(eng: Engine) { this.eng = eng; }
  get transitioning(): boolean { return this.transitionStart !== 0; }

  loadedSources() {
    return this.eng.loadOrder.filter((id) => this.runtime.has(id)).map((id) => { const r = this.runtime.get(id)!; return { id: r.id, source: r.source, buildsOn: r.buildsOn }; });
  }
  allDefs(): SystemDef[] { return this.eng.loadOrder.map((id) => this.runtime.get(id)?.def).filter(Boolean) as SystemDef[]; }

  async performLoad(report: Report): Promise<Report> {
    const eng = this.eng;
    const snapshot = eng.snapshot();
    this.transitionStart = performance.now();
    try {
      await delay(850); // fade to covered, leaves swirling
      const def = evalSystem(report.source);
      eng.loadSystem(def);
      this.runtime.set(def.id, { id: def.id, source: report.source, buildsOn: def.buildsOn, def });
      eng.world().emit("system.loaded", { id: def.id });
      await saveSystem({ id: def.id, source: report.source, buildsOn: def.buildsOn, order: this.runtime.size - 1, timestamp: new Date().toISOString() });
      await saveWorld(eng.serialize());
      await delay(1150); // fade back
      eng.world().ui.banner("The world feels different");
      return { ...report, ok: true, stage: "Load" };
    } catch (e) {
      try { eng.restore(snapshot); } catch { /* keep current world */ }
      this.runtime.delete(report.systemId ?? "");
      return { ...report, ok: false, stage: "Load", errors: [{ message: "live load failed, world restored from snapshot: " + (e as Error).message }] };
    } finally {
      this.transitionStart = 0;
    }
  }

  /** Load saved systems in order at startup. Skips failures and anything that builds on a skipped system. No transition. */
  async loadSaved(saved: { id: string; source: string; buildsOn: string[] }[], baseIds: string[]): Promise<void> {
    const bad = new Set<string>();
    for (const s of saved) {
      const missingDep = s.buildsOn.find((b) => bad.has(b) || (!baseIds.includes(b) && !this.runtime.has(b) && b !== s.id));
      if (missingDep) { bad.add(s.id); this.skipped.push(`${s.id} (builds on skipped/missing ${missingDep})`); continue; }
      try {
        const def = evalSystem(s.source);
        this.eng.loadSystem(def);
        this.runtime.set(def.id, { id: def.id, source: s.source, buildsOn: def.buildsOn, def });
      } catch (e) { bad.add(s.id); this.skipped.push(`${s.id} (${(e as Error).message})`); }
    }
  }

  /** Draw the leaf transition over the (paused) world. Call after render() while transitioning. */
  drawTransition(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.transitionStart) return;
    const t = (now - this.transitionStart) / 2000; // ~2 seconds total
    const fade = t < 0.42 ? t / 0.42 : t > 0.58 ? Math.max(0, 1 - (t - 0.58) / 0.42) : 1;
    ctx.fillStyle = `rgba(24,32,16,${(fade * 0.88).toFixed(3)})`;
    ctx.fillRect(0, 0, 480, 320);
    // Leaves (fx_leaf pieces) swirling across the screen.
    const tick = Math.floor(now / 16);
    for (let i = 0; i < 42; i++) {
      const seed = i * 37.7;
      const x = ((seed * 13 + now * (0.03 + (i % 5) * 0.008)) % 520) - 20;
      const y = 160 + Math.sin(now / 350 + seed) * 130 + ((i * 53) % 60) - 30;
      ctx.save();
      ctx.globalAlpha = Math.min(1, fade * 1.4);
      drawSprite(ctx, "fx_leaf", Math.round(x), Math.round(y), tick + i * 7, { frame: i % 6 });
      ctx.restore();
    }
  }
}
