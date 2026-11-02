// Live Load (spec 13.1), Undo, and startup reload (spec 13.2).
import type { Manifest } from "../engine/manifest";
import type { Game } from "../engine/runtime";
import { TUNING } from "../tuning";
import { compileSystem } from "../sandbox/compile";
import { loadWasmModule } from "../sandbox/module";
import { sha256Hex, type StoredSystem, type SystemStorage } from "./storage";

export interface LoadedBytes { manifest: Manifest; manifestJson: string; source: string; wasm: Uint8Array }
const loadedByGame = new WeakMap<Game, Map<string, LoadedBytes>>();
export function loadedBytesFor(game: Game): LoadedBytes[] {
  return [...(loadedByGame.get(game)?.values() ?? [])];
}
function remember(game: Game, rec: LoadedBytes): void {
  if (!loadedByGame.has(game)) loadedByGame.set(game, new Map());
  loadedByGame.get(game)!.set(rec.manifest.id, rec);
}
function forget(game: Game, id: string): void { loadedByGame.get(game)?.delete(id); }

interface UndoEntry { id: string; snapshot: string; replaced: string[] }
const undoByGame = new WeakMap<Game, UndoEntry[]>();
export function canUndo(game: Game): boolean { return (undoByGame.get(game)?.length ?? 0) > 0; }
export function lastLoadedId(game: Game): string | null { const s = undoByGame.get(game); return s?.length ? s[s.length - 1].id : null; }

/**
 * Stage 7, the synchronous core: snapshot, register, instantiate, migrate.
 * The caller (client) owns the pause/transition/save wrapping. Throws on failure
 * after restoring the snapshot, so the live world is never half-loaded.
 */
export function performLoad(game: Game, rec: LoadedBytes): void {
  const { manifest } = rec;
  if (game.registry.byId(manifest.id)) throw new Error(`system "${manifest.id}" is already loaded`);
  const snapshot = game.eng.snapshot();
  const faultsBefore = game.faults.length;
  try {
    // Succession (spec 11): retire replaced systems first; their entities stay.
    for (const oldId of manifest.replaces) game.unloadSystem(oldId, `replaced by ${manifest.id}`);
    loadWasmModule(game, manifest, rec.wasm, { migrate: true });
    if (game.faults.length > faultsBefore) {
      const f = game.faults[game.faults.length - 1];
      throw new Error(`migrate failed: ${f.message}`);
    }
  } catch (e) {
    if (game.registry.byId(manifest.id)) game.unloadSystem(manifest.id, "load failed");
    game.eng.restore(snapshot);
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!undoByGame.has(game)) undoByGame.set(game, []);
  undoByGame.get(game)!.push({ id: manifest.id, snapshot, replaced: [...manifest.replaces] });
  remember(game, rec);
  game.emit("(engine)", "system.loaded", { id: manifest.id });
  game.eng.banner = { text: "The world feels different", t: TUNING.bannerTicks };
}

/** Undo the most recent load: restore its snapshot and remove it from storage. */
export function undoLastLoad(game: Game, storage?: SystemStorage): boolean {
  const stack = undoByGame.get(game);
  if (!stack?.length) return false;
  const entry = stack.pop()!;
  if (game.registry.byId(entry.id)) game.unloadSystem(entry.id, "undone");
  game.eng.restore(entry.snapshot);
  forget(game, entry.id);
  game.interactions.refresh();
  if (storage) void storage.removeSystem(entry.id).then(() => storage.saveWorld(game.eng.serialize())).catch(() => { /* best effort */ });
  return true;
}

export interface ReloadResult { loaded: string[]; skipped: { id: string; reason: string }[] }

/**
 * Startup reload (spec 13.2): every stored AI system in order, each through the
 * Module stage again (validation + fresh metering) before it runs. A failure is
 * skipped along with everything that builds on it. World restore is the caller's job.
 */
export async function reloadStoredSystems(game: Game, storage: SystemStorage): Promise<ReloadResult> {
  const loaded: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const skippedIds = new Set<string>();
  let records: StoredSystem[] = [];
  try { records = await storage.listRecords(); } catch { return { loaded, skipped }; }
  for (const rec of records) {
    if (rec.replacedBy) { skipped.push({ id: rec.id, reason: `replaced by ${rec.replacedBy}` }); skippedIds.add(rec.id); continue; }
    let manifest: Manifest;
    try { manifest = JSON.parse(rec.manifestJson) as Manifest; } catch { skipped.push({ id: rec.id, reason: "stored manifest is not valid JSON" }); skippedIds.add(rec.id); continue; }
    const blocker = (manifest.buildsOn ?? []).find((b) => skippedIds.has(b));
    if (blocker) { skipped.push({ id: rec.id, reason: `builds on skipped system "${blocker}"` }); skippedIds.add(rec.id); continue; }
    if (game.registry.byId(rec.id)) { loaded.push(rec.id); continue; }
    let wasm = rec.wasm;
    // A tampered stored binary is still metered below; if its hash no longer
    // matches, prefer a fresh compile from the stored source.
    const actual = await sha256Hex(wasm);
    if (rec.sha256 && actual !== rec.sha256) {
      const compiled = await compileSystem(manifest, rec.source);
      if (!compiled.ok) { skipped.push({ id: rec.id, reason: `stored module failed its hash check and recompiling failed: ${compiled.errors[0]?.message ?? "compile error"}` }); skippedIds.add(rec.id); continue; }
      wasm = compiled.bytes;
    }
    try {
      loadWasmModule(game, manifest, wasm, { migrate: false });
      remember(game, { manifest, manifestJson: rec.manifestJson, source: rec.source, wasm });
      loaded.push(rec.id);
    } catch (e) {
      skipped.push({ id: rec.id, reason: e instanceof Error ? e.message : String(e) });
      skippedIds.add(rec.id);
    }
  }
  return { loaded, skipped };
}

/** Shift+R for AI systems: re-instantiate every stored module, keeping the world. */
export async function reinstantiateAll(game: Game, storage: SystemStorage): Promise<ReloadResult> {
  const world = game.eng.serialize();
  for (const rec of loadedBytesFor(game)) if (game.registry.byId(rec.manifest.id)) game.unloadSystem(rec.manifest.id, "reinstantiate");
  loadedByGame.set(game, new Map());
  const result = await reloadStoredSystems(game, storage);
  game.eng.restore(world);
  game.interactions.refresh();
  return result;
}
