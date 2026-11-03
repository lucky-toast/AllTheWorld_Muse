// The live side of the pipeline: Load (spec 13.1), Undo, the startup reload and autosave
// (spec 13.2). No DOM here; main.ts draws the transition (transition.ts) and wires the page.
//
// Load: pause ticks and input, fade in the leaf transition, and while the screen is covered:
// snapshot the live world, add the system to the registry, instantiate it (the Module stage
// runs again on the checked bytes), run migrate, save it, emit system.loaded. Then fade back
// and show "The world feels different". If anything throws, the snapshot is restored and Load
// fails. The player kept playing while the check ran, so before any of that, still under the
// leaf, the World check runs again on a copy of the live world as it is now; if it fails,
// nothing loads and the report fails at "World check" (the designer gets a repair message). Undo restores the latest load's snapshot, takes that system out and removes it from
// storage.
import type { Host } from "../engine/host";
import { aiSystem, moduleMemories, prepareModuleAsync, resetMemoryPeak, type AiSystemDef } from "../sandbox/module";
import { rerunWorldCheck } from "./worldcheck";
import { TUNING } from "../tuning";
import type { LiveSide } from "./client";
import type { LoadedModule, PipelineError, Report } from "./types";
import { sha256Hex, type IndexEntry, type Store } from "./store";

/** A loaded AI system with what it was built from. */
export interface AiRecord { id: string; manifestJson: string; manifest: unknown; source: string; wasm: Uint8Array<ArrayBuffer> }

export interface LiveOptions {
  /** Waits during the transition (tests pass a no-op). */
  wait?(ms: number): Promise<void>;
  /** Clock for the transition (ms). */
  now?(): number;
  /** Called after a load, an undo or the startup reload changed what is loaded. */
  onChange?(): void;
  /** Called after Undo took a system out. */
  onUndone?(id: string): void;
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LiveLoader implements LiveSide {
  /** Loaded AI systems by id. */
  records = new Map<string, AiRecord>();
  /** Every stored system (skipped ones too, so saving never drops them). */
  index: IndexEntry[] = [];
  /** Stored systems that didn't load at startup, with why. */
  skipped: { id: string; reason: string }[] = [];
  /** Startup notes (recompiles, a world that couldn't be restored). */
  notes: string[] = [];
  /** Snapshots taken before each live load this session, newest last, with the records of the systems that load retired (succession). */
  history: { id: string; snapshot: string; retired: AiRecord[] }[] = [];
  /** True while a load or undo runs: ticks, input and autosave pause. */
  busy = false;
  /** When the leaf transition started (ms), or 0. */
  transitionStart = 0;
  /** Set by Start fresh so nothing is saved again before the reload. */
  frozen = false;
  private wait: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(public host: Host, public store: Store, private opts: LiveOptions = {}) {
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => performance.now());
  }

  checkInputs(): { loaded: LoadedModule[]; loadedIds: string[]; world: string; successors: Record<string, string> } {
    const ids = [...this.host.systems.keys()];
    const loaded = ids.filter((id) => !this.host.systems.get(id)!.base).map((id) => {
      const r = this.records.get(id); if (!r) throw new Error(`"${id}" is loaded but its module isn't known`);
      return { manifest: r.manifest, wasm: r.wasm, source: r.source };
    });
    return { loaded, loadedIds: ids, world: this.host.eng.serialize(), successors: Object.fromEntries(this.host.successors) };
  }

  async load(report: Report): Promise<Report> {
    const fail = (message: string): Report => ({ ...report, ok: false, stage: "Load", errors: [{ message }] });
    const c = report.checked; const id = report.systemId;
    if (!c || !id) return fail("the report has nothing to load");
    if (this.busy) return fail("another load is running");
    if (this.host.systems.has(id)) return fail(`a system with id "${id}" already exists`);
    if (this.index.some((e) => e.id === id)) return fail(`a stored system already uses the id "${id}"`);
    const host = this.host; const eng = host.eng;
    this.busy = true; this.transitionStart = this.now();
    host.controls.releaseAll();
    try {
      let manifest: unknown;
      let def;
      try { manifest = JSON.parse(c.manifestJson); def = aiSystem(await prepareModuleAsync(c.wasm, manifest)); }
      catch (e) { return fail(`the module didn't load: ${msgOf(e)}`); }
      await this.wait(TUNING.transitionInMs); // the screen is covered now
      const snapshot = eng.snapshot();
      // The World check again, on a copy of the live world as it is now (the game is paused under the leaf).
      const recheck = await this.recheck(snapshot, def);
      if (recheck.errors.length) {
        eng.restore(snapshot); host.interactions.refresh(true);
        await this.wait(TUNING.transitionOutMs);
        return { ...report, ok: false, stage: "World check", errors: recheck.errors, log: [...report.log, ...recheck.log] };
      }
      const entry: IndexEntry = { id, order: this.index.reduce((m, e) => Math.max(m, e.order + 1), 0), buildsOn: [...((manifest as { buildsOn?: string[] }).buildsOn ?? [])], replacedBy: null, timestamp: new Date().toISOString() };
      const oldIndex = this.index;
      let retired: AiRecord[] = [];
      try {
        // One step (spec 11 and 13.1): the replaced systems retire (their entities, components and
        // tags stay and pass to the new system), it is added, its migrate runs, and it is saved.
        host.load(def, { announce: false });
        retired = host.retiredBy(id).map((r) => this.records.get(r)!).filter(Boolean);
        const gone = new Set(retired.map((r) => r.id));
        const index = [...this.index.map((e) => (gone.has(e.id) ? { ...e, replacedBy: id } : e)), entry];
        await this.store.save(entry, { manifestJson: c.manifestJson, source: c.source, wasm: c.wasm }, index);
        this.index = index;
        for (const r of retired) this.records.delete(r.id);
        this.records.set(id, { id, manifestJson: c.manifestJson, manifest, source: c.source, wasm: c.wasm });
        for (const r of retired) host.emitEngine("system.unloaded", { id: r.id, reason: `replaced by ${id}` });
        host.emitEngine("system.loaded", { id });
        await this.store.saveWorld(eng.serialize());
      } catch (e) {
        host.forget(id); eng.restore(snapshot); host.interactions.refresh(true);
        this.records.delete(id); for (const r of retired) this.records.set(r.id, r);
        this.index = oldIndex.filter((x) => x.id !== id);
        try { await this.store.remove(id, this.index); } catch { /* nothing more to undo */ }
        return fail(`loading failed, so the world was restored: ${msgOf(e)}`);
      }
      this.history.push({ id, snapshot, retired });
      host.interactions.refresh(true);
      this.opts.onChange?.();
      await this.wait(TUNING.transitionOutMs);
      eng.banner = { text: TUNING.loadBanner, t: TUNING.bannerTicks };
      return { ...report, ok: true, stage: "Load", errors: [] };
    } finally {
      this.busy = false; this.transitionStart = 0;
    }
  }

  /** The World check on a copy of `world` with the loaded AI systems and the candidate. Errors are empty when it passed. */
  private async recheck(world: string, candidate: AiSystemDef): Promise<{ errors: PipelineError[]; log: string[] }> {
    const lead = "the world changed while your system was being checked (the player kept playing), and the World check now fails on the world as it is:";
    const log: string[] = [];
    try {
      const loadedDefs: AiSystemDef[] = [];
      for (const m of this.checkInputs().loaded) loadedDefs.push(aiSystem(await prepareModuleAsync(m.wasm, m.manifest)));
      resetMemoryPeak();
      const errors = rerunWorldCheck(world, loadedDefs, candidate, log, new Map(this.host.successors));
      const m = moduleMemories();
      log.push(`module memories at Load: at most ${m.peak} held at once in this tab's main thread during the recheck (the live game's included), ${m.live} still held`);
      return { errors: errors.length ? [{ message: lead }, ...errors] : [], log };
    } catch (e) { return { errors: [{ message: `the World check couldn't run again on the live world: ${msgOf(e)}` }], log }; }
  }

  /** Undo the latest live load. Returns what happened, in words. */
  async undo(): Promise<string> {
    if (this.busy) return "a load is running";
    const last = this.history.at(-1);
    if (!last) return "nothing to undo (only loads made since the page opened can be undone)";
    this.busy = true;
    try {
      this.history.pop();
      this.host.forget(last.id); // a succession's retired systems come back in their old place
      this.host.eng.restore(last.snapshot);
      this.host.interactions.refresh(true);
      this.records.delete(last.id);
      for (const r of last.retired) this.records.set(r.id, r);
      this.index = this.index.filter((e) => e.id !== last.id).map((e) => (e.replacedBy === last.id ? { ...e, replacedBy: null } : e));
      await this.store.remove(last.id, this.index);
      await this.store.saveWorld(this.host.eng.serialize());
      this.opts.onUndone?.(last.id);
      this.opts.onChange?.();
      const back = last.retired.length ? ` and ${last.retired.map((r) => r.id).join(", ")} is back` : "";
      return `undid ${last.id}: the world is back to just before it loaded${back}`;
    } finally { this.busy = false; }
  }

  /**
   * Startup (spec 13.2): base systems are already loaded; load every stored AI system in order
   * (skipping replaced ones), each through the Module stage again, then restore the saved world.
   * A system that fails is skipped with everything that builds on it. `compile` rebuilds a
   * module from source when it is missing or doesn't match its hash.
   */
  async startup(compile: (manifest: unknown, source: string) => Promise<Uint8Array<ArrayBuffer>>): Promise<void> {
    const host = this.host;
    let world: string | null = null;
    try { world = await this.store.loadWorld(); if (world !== null) JSON.parse(world); }
    catch (e) { this.notes.push(`the saved world couldn't be read, so the world starts fresh: ${msgOf(e)}`); world = null; }
    this.index = (await this.store.index()).sort((a, b) => a.order - b.order);
    const failed = new Set<string>();
    const skip = (id: string, reason: string) => { failed.add(id); this.skipped.push({ id, reason }); };
    // Replaced systems are never instantiated (spec 11); a replaced id in buildsOn resolves to its replacement.
    for (const e of this.index) if (e.replacedBy) host.successors.set(e.id, e.replacedBy);
    const position = new Map(this.index.map((e, i) => [e.id, i]));
    /** Why `b` (from buildsOn of the entry at `i`) isn't met, or null when it is (or its replacement loads later). */
    const unmet = (b: string, i: number): string | null => {
      const r = host.resolve(b); const via = r === b ? b : `${b} (replaced by ${r})`;
      if (failed.has(r)) return `it builds on ${via}, which was skipped`;
      if (host.systems.has(r)) return null;
      const later = position.get(r);
      return r !== b && later !== undefined && later > i ? null : `it builds on ${via}, which isn't loaded`;
    };
    for (const [i, e] of this.index.entries()) {
      if (e.replacedBy) continue;
      const why = e.buildsOn.map((b) => unmet(b, i)).find((x) => x !== null);
      if (why) { skip(e.id, why); continue; }
      try {
        const files = await this.store.read(e.id);
        const manifest = JSON.parse(files.manifestJson) as unknown;
        let wasm = files.wasm;
        if (wasm && files.sha256 !== null && (await sha256Hex(wasm)) !== files.sha256) {
          this.notes.push(`${e.id}: module.wasm doesn't match module.sha256, so it was compiled again from its source`);
          wasm = null;
        } else if (!wasm) this.notes.push(`${e.id}: its compiled module was missing, so it was compiled again from its source`);
        if (!wasm) { wasm = await compile(manifest, files.source); await this.store.cacheModule(e.id, files.source, wasm); }
        const def = aiSystem(await prepareModuleAsync(wasm, manifest)); // the Module stage: validation and fresh metering
        host.load(def, { migrate: world === null, announce: false });
        this.records.set(e.id, { id: e.id, manifestJson: files.manifestJson, manifest, source: files.source, wasm });
      } catch (err) { skip(e.id, msgOf(err)); }
    }
    // A system that built on a replaced id whose replacement didn't load goes too.
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...this.records.keys()]) {
        const r = this.records.get(id)!; const dep = ((r.manifest as { buildsOn?: string[] }).buildsOn ?? []).find((b) => !host.systems.has(host.resolve(b)));
        if (dep) { host.forget(id); this.records.delete(id); skip(id, `it builds on ${dep}, which isn't loaded`); changed = true; }
      }
    }
    if (world !== null) {
      try { host.eng.restore(world); }
      catch (e) { this.notes.push(`the saved world couldn't be restored: ${msgOf(e)}`); }
    }
    host.interactions.refresh(true);
    this.opts.onChange?.();
  }

  /** Autosave (every few seconds, and when the page goes away). */
  async saveWorld(): Promise<void> {
    if (this.busy || this.frozen) return;
    await this.store.saveWorld(this.host.eng.serialize());
  }
  saveWorldOnExit() { if (!this.busy && !this.frozen) this.store.saveWorldOnExit(this.host.eng.serialize()); }

  /** Start fresh: delete everything saved. The caller reloads the page. */
  async startFresh(): Promise<void> {
    this.frozen = true;
    await this.store.clear();
  }
}
