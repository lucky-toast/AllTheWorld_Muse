// Test runner for base systems (spec 9): fresh 12x12 arena per test, driven through sim.* and check.
import { buildArena } from "../../world/map";
import type { Game } from "../../engine/runtime";
import { createGame } from "./index";

export interface BaseTestResult { system: string; name: string; checks: { label: string; passed: boolean }[]; passed: boolean }
interface Ctx { game: Game; spawn: (type: string, x: number, y: number) => number; sim: (op: string, extra?: Record<string, unknown>) => void; check: (cond: boolean, label: string) => void }
interface BaseTest { system: string; name: string; run: (c: Ctx) => void }

const playerPos = (g: Game) => g.eng.playerRec()!.pos!;
const facing = (g: Game) => g.eng.playerRec()!.comps.get("facing");
const held = (g: Game) => (g.eng.playerRec()!.comps.get("held") as { id: number } | undefined)?.id;

export const BASE_TESTS: BaseTest[] = [
  { system: "movement", name: "walk", run: ({ sim, check, game }) => { sim("sim.walk", { dir: "right" }); check(playerPos(game).x === 6 && playerPos(game).y === 5, "player stepped right"); check(facing(game) === "right", "facing follows walk"); } },
  { system: "movement", name: "turn only", run: ({ sim, check, game }) => { sim("sim.face", { dir: "left" }); check(playerPos(game).x === 5 && facing(game) === "left", "turn only faces left"); } },
  { system: "movement", name: "water blocks", run: ({ sim, check, game }) => { game.call("test", { op: "tile.set", x: 6, y: 5, sprite: "stream_h" }); sim("sim.walk", { dir: "right" }); check(playerPos(game).x === 5, "water blocked the step"); } },
  { system: "movement", name: "solid blocks", run: ({ sim, check, game, spawn }) => { spawn("test_block", 6, 5); sim("sim.walk", { dir: "right" }); check(playerPos(game).x === 5, "solid blocked the step"); } },
  { system: "movement", name: "map edge blocks", run: ({ sim, check, game }) => { sim("sim.teleport", { x: 0, y: 5 }); sim("sim.walk", { dir: "left" }); check(playerPos(game).x === 0, "map edge blocked the step"); } },
  { system: "movement", name: "focus blocks walking", run: ({ sim, check, game }) => { game.focus.take("movement", "freeze"); sim("sim.walk", { dir: "right" }); check(playerPos(game).x === 5, "focus blocked walking"); game.focus.escape(); } },
  { system: "movement", name: "1x2 log blocks on both tiles", run: ({ sim, check, game, spawn }) => { spawn("log_fallen", 6, 5); spawn("test_block", 7, 5); spawn("test_block", 6, 6); sim("sim.walk", { dir: "right" }); check(playerPos(game).x === 5, "lower tile of log blocked"); sim("sim.teleport", { x: 6, y: 3 }); sim("sim.walk", { dir: "down" }); check(playerPos(game).y === 3, "upper tile of log blocked"); } },
  { system: "carry", name: "picks up a faced item", run: ({ sim, check, game, spawn }) => { spawn("test_item", 5, 6); sim("sim.face", { dir: "down" }); sim("sim.interact"); check(held(game) !== undefined, "item is in hand"); check(game.eng.recById(held(game)!)!.pos === null, "held item is off the map"); } },
  { system: "carry", name: "drops on a free tile", run: ({ sim, check, game }) => { sim("sim.give", { type: "test_item" }); sim("sim.face", { dir: "down" }); sim("sim.interact"); check(held(game) === undefined, "hands empty after drop"); check(game.eng.atIds(5, 6).some((id) => game.eng.recById(id)?.tags.has("item")), "item sits on faced tile"); } },
  { system: "carry", name: "drop onto an occupied tile keeps it in hand", run: ({ sim, check, game, spawn }) => { spawn("test_block", 5, 6); sim("sim.give", { type: "test_item" }); sim("sim.face", { dir: "down" }); sim("sim.interact"); check(held(game) !== undefined, "item stays in hand"); } },
  { system: "carry", name: "a log drops only where both tiles are free", run: ({ sim, check, game }) => { sim("sim.give", { type: "log_fallen" }); sim("sim.face", { dir: "down" }); sim("sim.interact"); const log = [...game.eng.entities.values()].find((r) => r.type === "log_fallen" && r.pos); check(!!log && log.pos!.x === 5 && log.pos!.y === 7, "log placed with both tiles in front"); } },
  { system: "carry", name: "Drop ranks last", run: ({ sim, check, game }) => { sim("sim.give", { type: "test_item" }); const labels = game.interactions.matches.map((m) => m.entry.label); check(labels[labels.length - 1] === "Drop", "Drop is last"); void sim; } },
  { system: "push", name: "pushes a crate", run: ({ sim, check, game, spawn }) => { spawn("test_pushable", 6, 5); sim("sim.walk", { dir: "right" }); check(game.eng.atIds(7, 5).some((id) => game.eng.recById(id)?.tags.has("pushable")), "crate moved to x=7"); check(playerPos(game).x === 6, "player followed"); } },
  { system: "push", name: "crate into a rock stays", run: ({ sim, check, game, spawn }) => { spawn("test_pushable", 6, 5); spawn("test_block", 7, 5); sim("sim.walk", { dir: "right" }); check(game.eng.atIds(6, 5).some((id) => game.eng.recById(id)?.tags.has("pushable")), "crate stayed"); check(playerPos(game).x === 5, "player stayed"); } },
  { system: "push", name: "whole log moves", run: ({ sim, check, game, spawn }) => { spawn("log_fallen", 6, 5); sim("sim.walk", { dir: "right" }); const log = [...game.eng.entities.values()].find((r) => r.type === "log_fallen"); check(!!log && log.pos!.x === 7 && log.pos!.y === 5, "log moved whole"); } },
  { system: "push", name: "log into a rock stays", run: ({ sim, check, game, spawn }) => { spawn("log_fallen", 6, 5); spawn("test_block", 7, 5); sim("sim.walk", { dir: "right" }); const log = [...game.eng.entities.values()].find((r) => r.type === "log_fallen"); check(log!.pos!.x === 6, "log stayed"); } },
  { system: "daynight", name: "phase change emits time.phase and the shortcut", run: ({ sim, check, game }) => { const seen: string[] = []; game.registry; const orig = game.emit.bind(game); game.emit = (s: string, n: string, p: Record<string, unknown>) => { seen.push(n); return orig(s, n, p); }; sim("sim.time", { phaseOrHour: "dusk" }); sim("sim.wait", { ticks: 2 }); check(seen.includes("time.dusk") || game.eventLog.some((e) => e.name === "time.dusk"), "time.dusk fired"); } },
  { system: "daynight", name: "sim.time emits time.jumped", run: ({ sim, check, game }) => { sim("sim.time", { phaseOrHour: 12 }); check(game.eventLog.some((e) => e.name === "time.jumped"), "time.jumped fired"); check(game.eng.hour >= 12 && game.eng.hour < 13, "clock at noon"); } },
  { system: "daynight", name: "whole hours emit time.hour", run: ({ sim, check, game }) => { sim("sim.time", { phaseOrHour: 9 }); game.eventLog.length = 0; sim("sim.wait", { ticks: 370 }); check(game.eventLog.some((e) => e.name === "time.hour"), "time.hour fired"); } },
  { system: "daynight", name: "the player has a light", run: ({ check, game }) => { const l = game.eng.playerRec()!.comps.get("light") as { radius: number } | undefined; check(!!l && l.radius > 0, "player has a light"); } },
  { system: "daynight", name: "day 1 starts in the morning", run: ({ check, game }) => { check(game.eng.day === 1, "day is 1"); check(game.eng.phase() === "day", "starts in day phase"); } },
];

export function runBaseTests(filter?: string): BaseTestResult[] {
  const out: BaseTestResult[] = [];
  for (const t of BASE_TESTS) {
    if (filter && t.system !== filter) continue;
    const eng = buildArena();
    const game = createGame(eng);
    game.testMode = true;
    game.checks = [];
    const ctx: Ctx = {
      game,
      spawn: (type, x, y) => { const r = game.call("test", { op: "spawn", type, x, y }); if (!r.ok) throw new Error(r.msg); return r.r as number; },
      sim: (op, extra = {}) => { const r = game.call("test", { op, ...extra }); if (!r.ok) throw new Error(`${op}: ${r.msg}`); },
      check: (cond, label) => { game.call("test", { op: "check", cond, label }); },
    };
    try { t.run(ctx); } catch (e) { game.checks.push({ label: `threw: ${e instanceof Error ? e.message : String(e)}`, passed: false }); }
    const checks = [...game.checks];
    if (!checks.length) checks.push({ label: "at least one check ran", passed: false });
    out.push({ system: t.system, name: t.name, checks, passed: checks.every((c) => c.passed) });
    game.testMode = false;
  }
  return out;
}
