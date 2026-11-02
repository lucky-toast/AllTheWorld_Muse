// AI test and shot runners (spec 5.2, 12 stages 4 and 6, Phase 3 scope).
// Each test or shot runs on a fresh real map from the fixed seed, with base
// systems loaded, under the test fuel limit (migrate/test/shot fuel).
import type { Manifest } from "../engine/manifest";
import type { Game } from "../engine/runtime";
import { buildWorld } from "../world/map";
import { createGame } from "../systems/base/index";
import { loadWasmModule, type WasmModuleHandle } from "./module";

export interface SystemTestResult { name: string; checks: { label: string; passed: boolean }[]; passed: boolean; faults: string[]; events?: { tick: number; name: string; payload: unknown }[]; denied?: { tick: number; system: string; op: string; code: string; msg: string }[]; entities?: { type: string; pos: { x: number; y: number; area: string } | null; components: Record<string, unknown> }[] }
export interface SystemShotResult { name: string; passed: boolean; faults: string[]; entities: { type: string; pos: { x: number; y: number; area: string } | null }[] }

function freshGame(): Game {
  const eng = buildWorld();
  const game = createGame(eng);
  game.testMode = true;
  return game;
}

function loadForRun(game: Game, manifest: Manifest, bytes: Uint8Array): WasmModuleHandle {
  const handle = loadWasmModule(game, manifest, bytes, { migrate: false });
  handle.strikesEnabled = false;
  if (handle.exportNames.includes("migrate")) handle.runNamed("migrate");
  return handle;
}

/** Run every test_* export, each on a fresh copy of the real map. A test passes when every check passed and at least one ran. */
export function runSystemTests(manifest: Manifest, bytes: Uint8Array): SystemTestResult[] {
  const probe = freshGame();
  const probeHandle = loadForRun(probe, manifest, bytes);
  const names = [...probeHandle.testNames];
  const out: SystemTestResult[] = [];
  for (const name of names) {
    const game = freshGame();
    game.checks = [];
    const handle = loadForRun(game, manifest, bytes);
    const faultsBefore = game.faults.length;
    const ran = handle.runNamed(name);
    const checks = [...game.checks];
    if (!checks.length) checks.push({ label: "at least one check ran", passed: false });
    const faults = game.faults.slice(faultsBefore).map((f) => f.message);
    const entities = [...game.eng.entities.values()]
      .filter((r) => game.eng.entityOwner.get(r.id) === manifest.id || r.tags.has("player"))
      .map((r) => ({ type: r.type, pos: r.pos ? { ...r.pos } : null, components: Object.fromEntries(r.comps.entries()) as Record<string, unknown> }));
    out.push({ name, checks, passed: ran && checks.every((c) => c.passed), faults, events: game.eventLog.slice(-100), denied: [...game.eng.deniedLog], entities });
  }
  return out;
}

/** Run every shot_* export on a fresh copy, then tick the world for the shot's ticks. */
export function runSystemShots(manifest: Manifest, bytes: Uint8Array): SystemShotResult[] {
  const out: SystemShotResult[] = [];
  for (const shot of manifest.shots) {
    const game = freshGame();
    const handle = loadForRun(game, manifest, bytes);
    const faultsBefore = game.faults.length;
    const ran = handle.runNamed(`shot_${shot.name}`);
    if (ran) for (let i = 0; i < shot.ticks; i++) game.tick();
    const faults = game.faults.slice(faultsBefore).map((f) => f.message);
    const entities = [...game.eng.entities.values()].map((r) => ({ type: r.type, pos: r.pos ? { ...r.pos } : null }));
    out.push({ name: shot.name, passed: ran && faults.length === 0, faults, entities });
  }
  return out;
}
