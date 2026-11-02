// Phase 5b: map images for the designer, placement guards (the player's tile, nearest free,
// space.find, tile.stamp) and the World check run again at Load.
import { readFileSync } from "node:fs";
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { footprintTiles } from "../src/engine/catalog";
import { loadBaseSystems } from "../src/systems/base";
import { BASE_AREA } from "../src/engine/types";
import { Pipeline } from "../src/pipeline/client";
import { inProcessWorker } from "../src/pipeline/inprocess";
import { LiveLoader } from "../src/pipeline/live";
import { LocalStore, type ModuleCache } from "../src/pipeline/store";
import { buildPrompt, runStep, MAP_IMAGE_NOTE } from "../src/ai/designer";
import { mapAreas, mapSize, renderMaps, type CanvasLike } from "../src/ai/mapimage";
import { outgoingText, type AiProvider, type ChatMessage } from "../src/ai/provider";
import { LIMITS } from "../src/tuning";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

function setup() {
  const eng = buildWorld();
  const host = new Host(eng);
  host.addSystem({ id: "tester", entities: { pit: { sprite: "firepit", tags: ["solid"] }, flower: { sprite: "daisy", tags: [] } } }, false);
  const player = eng.player()!;
  const call = (req: Record<string, unknown>) => host.call("tester", req as { op: string });
  const ok = <T>(req: Record<string, unknown>): T => { const r = call(req); if (!r.ok) throw new Error(`${req.op} refused: ${r.msg}`); return r.r as T; };
  return { eng, host, player, call, ok, area: BASE_AREA };
}
const denied = (res: { ok: boolean }) => expect(res).toMatchObject({ ok: false, code: "denied" });
const d2 = (a: { x: number; y: number }, x: number, y: number) => (a.x - x) ** 2 + (a.y - y) ** 2;

// ---------------------------------------------------------------------------
// The designer prompt's map slot
// ---------------------------------------------------------------------------
describe("map slot", () => {
  test("{{MAP_IMAGE}} is filled, no {{ remains, and it sits below the cache line", () => {
    const host = new Host(buildWorld()); loadBaseSystems(host);
    const a = buildPrompt(host, "first task"); const b = buildPrompt(host, "another task");
    expect(a.slots.MAP_IMAGE).toBe("(See the attached map image.)");
    expect(MAP_IMAGE_NOTE).toBe("(See the attached map image.)");
    expect(a.rest).toContain("(attached separately): (See the attached map image.)");
    expect(a.cached + a.rest).not.toContain("{{");
    expect(b.cached).toBe(a.cached);
  });
});

// ---------------------------------------------------------------------------
// Map images
// ---------------------------------------------------------------------------
/** A canvas stand-in for Node: every 2D call is a no-op. */
const fakeCanvas = (w: number, h: number): CanvasLike => {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  return { width: w, height: h, getContext: () => ctx };
};

describe("map images", () => {
  test("with six areas, exactly MAP_IMAGE_MAX_AREAS (4) come back: the current area first, then the newest", () => {
    const { host, eng, ok } = setup();
    for (const n of ["a1", "a2", "a3", "a4", "a5"]) ok({ op: "area.create", name: n, fill: "grass" });
    expect(eng.areas.size).toBe(6);
    expect(LIMITS.MAP_IMAGE_MAX_AREAS).toBe(4);
    const maps = renderMaps(eng, fakeCanvas);
    expect(maps.map((m) => m.area)).toEqual([BASE_AREA, "tester.a5", "tester.a4", "tester.a3"]);
    const { w, h } = mapSize(eng);
    for (const m of maps) expect([m.canvas.width, m.canvas.height]).toEqual([w, h]);
    expect(w).toBe(16 + 30 * 17 + 1); // left margin, 16 px tiles with a 1 px grid line between
    // Travel into an older area: it comes first, the newest others follow.
    host.addSystem({ id: "mover" }, false);
    expect(host.call("mover", { op: "travel", area: "tester.a2", x: 5, y: 5 }).ok).toBe(true);
    expect(mapAreas(eng)).toEqual(["tester.a2", "tester.a5", "tester.a4", "tester.a3"]);
  });

  test("rendering a map changes nothing in the world", () => {
    const { eng } = setup();
    const before = eng.serialize(); const hour = eng.hour;
    renderMaps(eng, fakeCanvas);
    expect(eng.serialize()).toBe(before); expect(eng.hour).toBe(hour);
  });
});

// ---------------------------------------------------------------------------
// The player's tile is never covered
// ---------------------------------------------------------------------------
describe("the player's tile", () => {
  test("a crate spawned onto the player's tile lands beside the player; with exact: true it is denied", () => {
    const { eng, player, call, ok } = setup();
    const p = player.pos!;
    const id = ok<number>({ op: "spawn", type: "crate", x: p.x, y: p.y });
    const at = eng.rec(id)!.pos!;
    expect(Math.abs(at.x - p.x) + Math.abs(at.y - p.y)).toBe(1);
    expect(eng.at(p.area, p.x, p.y)).toEqual([player.id]);
    const n = eng.entities.size;
    denied(call({ op: "spawn", type: "crate", x: p.x, y: p.y, exact: true }));
    expect(eng.entities.size).toBe(n);
  });

  test("move onto the player is denied; place goes beside the player; nothing can turn blocking on the player's tile", () => {
    const { eng, player, call, ok } = setup();
    const p = player.pos!;
    const crate = ok<number>({ op: "spawn", type: "crate", x: 20, y: 9 });
    denied(call({ op: "move", id: crate, x: p.x, y: p.y, instant: true }));
    expect(eng.rec(crate)!.pos).toMatchObject({ x: 20, y: 9 });
    ok({ op: "lift", id: crate });
    const went = ok<{ x: number; y: number }>({ op: "place", id: crate, x: p.x, y: p.y });
    expect(Math.abs(went.x - p.x) + Math.abs(went.y - p.y)).toBe(1);
    expect(eng.rec(crate)!.pos).toMatchObject(went);
    ok({ op: "lift", id: crate });
    denied(call({ op: "place", id: crate, x: p.x, y: p.y, exact: true }));
    // A flower may sit on the player's tile (it doesn't block); making it solid there is denied.
    const flower = ok<number>({ op: "spawn", type: "flower", x: p.x, y: p.y });
    expect(eng.rec(flower)!.pos).toMatchObject({ x: p.x, y: p.y });
    denied(call({ op: "tag", id: flower, tag: "solid" }));
  });

  test("tile.set and tile.stamp never make the player's tile unwalkable", () => {
    const { eng, player, call, ok } = setup();
    const p = player.pos!;
    denied(call({ op: "tile.set", x: p.x, y: p.y, sprite: "pond" }));
    denied(call({ op: "tile.stamp", x: p.x, y: p.y, rows: [["pond"]], exact: true }));
    const o = ok<{ x: number; y: number }>({ op: "tile.stamp", x: p.x, y: p.y, rows: [["pond"]] });
    expect([o.x, o.y]).not.toEqual([p.x, p.y]);
    expect(eng.tileAt(p.area, p.x, p.y)).not.toBe("pond");
  });
});

// ---------------------------------------------------------------------------
// Nearest free
// ---------------------------------------------------------------------------
describe("nearest free", () => {
  test("spawn onto an occupied tile lands on the nearest spot where a 2x2 footprint fits; with exact: true it is denied", () => {
    const { eng, call, ok, area } = setup();
    ok({ op: "spawn", type: "crate", x: 10, y: 5, exact: true });
    const before = eng.serialize();
    denied(call({ op: "spawn", type: "pit", x: 10, y: 5, exact: true }));
    expect(eng.serialize()).toBe(before);
    const pit = ok<number>({ op: "spawn", type: "pit", x: 10, y: 5 });
    const at = eng.rec(pit)!.pos!;
    const fits = (x: number, y: number) => footprintTiles("firepit", x, y).every((t) => eng.inMap(t.x, t.y) && eng.isFreeFor(area, t.x, t.y, pit));
    expect(fits(at.x, at.y)).toBe(true);
    expect([at.x, at.y]).not.toEqual([10, 5]);
    // Nothing closer fits (checked against the world without the pit).
    for (let y = 0; y < eng.height; y++) for (let x = 0; x < eng.width; x++)
      if (d2(at, 10, 5) > (x - 10) ** 2 + (y - 5) ** 2) expect(footprintTiles("firepit", x, y).every((t) => eng.inMap(t.x, t.y) && eng.isFreeFor(area, t.x, t.y))).toBe(false);
  });

  test("space.find gives the top-left of the closest w x h block where every tile is free", () => {
    const { eng, ok, area } = setup();
    ok({ op: "spawn", type: "crate", x: 9, y: 5, exact: true });
    const b = ok<{ x: number; y: number; area: string }>({ op: "space.find", x: 8, y: 4, w: 3, h: 3 });
    const free = (ox: number, oy: number) => { for (let y = oy; y < oy + 3; y++) for (let x = ox; x < ox + 3; x++) if (!eng.inMap(x, y) || !eng.isFreeFor(area, x, y)) return false; return true; };
    expect(free(b.x, b.y)).toBe(true);
    expect(b.area).toBe(area);
    for (let y = 0; y < eng.height; y++) for (let x = 0; x < eng.width; x++) if ((x - 8) ** 2 + (y - 4) ** 2 < d2(b, 8, 4)) expect(free(x, y)).toBe(false);
    expect(ok({ op: "space.find", x: 0, y: 0, w: 30, h: 20 })).toBeNull();
  });

  test("tile.stamp of a 3x3 pond onto a partly blocked spot moves as a whole and never splits", () => {
    const { eng, call, ok, area } = setup();
    ok({ op: "spawn", type: "crate", x: 9, y: 5, exact: true });
    const pond = [["pond", "pond", "pond"], ["pond", "pond", "pond"], ["pond", "pond", "pond"]];
    const before = eng.serialize();
    denied(call({ op: "tile.stamp", x: 8, y: 4, rows: pond, exact: true }));
    expect(eng.serialize()).toBe(before);
    const tilesBefore = eng.areas.get(area)!.tiles.map((r) => [...r]);
    const o = ok<{ x: number; y: number }>({ op: "tile.stamp", x: 8, y: 4, rows: pond });
    expect([o.x, o.y]).not.toEqual([8, 4]);
    const changed: string[] = [];
    for (let y = 0; y < eng.height; y++) for (let x = 0; x < eng.width; x++) if (eng.tileAt(area, x, y) !== tilesBefore[y][x]) changed.push(`${x},${y}`);
    const block: string[] = []; for (let y = o.y; y < o.y + 3; y++) for (let x = o.x; x < o.x + 3; x++) { block.push(`${x},${y}`); expect(eng.tileAt(area, x, y)).toBe("pond"); }
    expect(changed.sort()).toEqual(block.filter((k) => { const [x, y] = k.split(",").map(Number); return tilesBefore[y][x] !== "pond"; }).sort());
    expect(eng.tileAt(area, 9, 5)).toBe(tilesBefore[5][9]); // the crate's tile is untouched
    expect(eng.invariantProblems()).toEqual([]);
  });

  test("tile.stamp leaves null cells as they are and only needs the changing tiles free", () => {
    const { eng, ok, area } = setup();
    ok({ op: "spawn", type: "crate", x: 9, y: 4, exact: true });
    const was = eng.tileAt(area, 9, 4);
    const o = ok<{ x: number; y: number }>({ op: "tile.stamp", x: 8, y: 4, rows: [["dirt", null, "dirt"], ["dirt", "dirt", "dirt"]] });
    expect([o.x, o.y]).toEqual([8, 4]);
    expect(eng.tileAt(area, 9, 4)).toBe(was);
    expect(eng.tileAt(area, 8, 4)).toBe("dirt"); expect(eng.tileAt(area, 10, 5)).toBe("dirt");
  });
});

// ---------------------------------------------------------------------------
// Load runs the World check again on the live world
// ---------------------------------------------------------------------------
// A well on (20, 9). Its migrate insists on that exact tile and fails when it is taken.
const WELL_MANIFEST = JSON.stringify({ id: "well", why: "A well to draw water from.", entities: { well: { sprite: "rock_gray_small", tags: ["solid", "well"] } } });
const wellSource = (exact: boolean) => `import { spawn, query, check, lastError } from "sdk";
export function migrate(): void {
  if (query("well").length) return;
  if (!spawn("well", 20, 9, "", ${exact})) throw new Error("the well's spot is taken: " + lastError());
}
export function test_there_is_one_well(): void { check(query("well").length == 1, "one well"); }
`;
const reply = (exact: boolean) => "```json\n" + WELL_MANIFEST + "\n```\n```ts\n" + wellSource(exact) + "```\n```json\n" + JSON.stringify({ title: "A well", summary: "A well.", changes: ["A well"], journal: "Water." }) + "\n```";

class Scripted implements AiProvider {
  sent: ChatMessage[][] = [];
  constructor(private replies: string[]) {}
  async send(messages: ChatMessage[]) { this.sent.push(messages); const r = this.replies.shift(); if (r === undefined) throw new Error("no scripted reply left"); return r; }
}

function liveGame() {
  const host = new Host(buildWorld());
  loadBaseSystems(host);
  host.interactions.refresh(true);
  const ls = new Map<string, string>();
  const mem: ModuleCache = { get: async () => null, put: async () => {}, clear: async () => {} };
  const store = new LocalStore({ getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => void ls.set(k, v), removeItem: (k) => void ls.delete(k) }, mem);
  const live = new LiveLoader(host, store, { wait: async () => {} });
  const pipeline = new Pipeline({ createWorker: inProcessWorker, live });
  return { host, eng: host.eng, live, pipeline };
}
/** The player walks onto the well's tile while the designer's system is being checked. */
const standOnTheSpot = (g: ReturnType<typeof liveGame>) => { const p = g.eng.player()!; g.eng.setPos(p.id, { x: 20, y: 9, area: p.pos!.area }); };

describe("Load re-runs the World check", () => {
  test("a Load whose live world changed so the World check now fails is refused, and the world is left as it was", async () => {
    const g = liveGame();
    const r = await g.pipeline.checkSystem(WELL_MANIFEST, wellSource(true));
    expect(r.ok).toBe(true);
    standOnTheSpot(g);
    const before = g.eng.serialize();
    const out = await g.pipeline.loadChecked(r);
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("World check");
    expect(out.errors[0].message).toMatch(/the world changed while your system was being checked/);
    expect(out.errors.map((e) => e.message).join("\n")).toMatch(/the well's spot is taken: denied: \(20, 9\) isn't free/);
    expect(g.host.systems.has("well")).toBe(false);
    expect(g.live.index).toEqual([]);
    expect(g.eng.serialize()).toBe(before);
  }, 60_000);

  test("the designer gets a World check repair message for it, which counts as one of its repairs", async () => {
    const g = liveGame();
    const pipeline = {
      checkSystem: async (m: string, s: string) => { const r = await g.pipeline.checkSystem(m, s); if (r.ok && s.includes("true")) standOnTheSpot(g); return r; },
      loadChecked: (r: Parameters<Pipeline["loadChecked"]>[0]) => g.pipeline.loadChecked(r),
    };
    const designer = new Scripted([reply(true), reply(false)]);
    const res = await runStep({ host: g.host, provider: designer, pipeline, task: "A well by the path." });
    expect(res).toMatchObject({ ok: true, systemId: "well", attempts: 2 });
    const repair = outgoingText(designer.sent[1]);
    expect(repair).toContain("Your system failed at the **World check** stage.");
    expect(repair).toMatch(/the world changed while your system was being checked/);
    // The second try used the default: the well went to the nearest free tile, beside the player.
    const well = g.eng.rec(g.eng.query("well")[0])!.pos!;
    expect(Math.abs(well.x - 20) + Math.abs(well.y - 9)).toBe(1);
  }, 120_000);
});
