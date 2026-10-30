import { describe, it, expect } from "vitest";
import { buildDirectorPrompt, buildSystemsText, buildSpritesText, buildJournalText, parseDirectorReply, currentDirectorPrompt, HAND_TASK_NOTE } from "../src/ai/director";
import { tileCenterPx, MAP_MARGIN_LEFT, MAP_MARGIN_TOP, MAP_SCALE } from "../src/ai/mapimage";
import { buildWorld } from "../src/world/map";
import { BASE_SYSTEMS } from "../src/systems/base/index";
import { evalSystem } from "../src/pipeline/eval";
import campfire from "../fixtures/campfire.ts?raw";
import type { JournalLike } from "../src/pipeline/persistence";

const entry = (over: Partial<JournalLike> = {}): JournalLike => ({ title: "T", summary: "S", changes: [], journal: "built journal", systemId: "x", timestamp: "2026-01-01", director: null, ...over });
const dirJson = (over: Record<string, unknown> = {}) => "```json\n" + JSON.stringify({ title: "Fire", brief: "B", experience: "Warm", buildsOn: ["carry"], sprites: ["branch"], journal: "Why not.", ...over }) + "\n```";

describe("director prompt", () => {
  it("is complete, systems in same form with hooks and no code", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const def = evalSystem(campfire as unknown as string); eng.loadSystem(def);
    const p = currentDirectorPrompt(eng, [...BASE_SYSTEMS, def], { campfire: campfire as unknown as string }, []);
    expect(p.includes("{{")).toBe(false);
    expect(p).toContain("(See the attached map image.)");
    expect(p).toContain("(No entries yet. This is the first update.)");
    for (const s of [...BASE_SYSTEMS, def]) {
      expect(p).toContain("## " + s.id);
      for (const h of s.contract.hooks) expect(p).toContain(h);
    }
    const systems = buildSystemsText([def], { campfire: campfire as unknown as string });
    expect(systems).toContain("firepit");
    expect(systems).not.toContain("defineSystem");
    expect(systems).not.toContain("component");
  });
  it("sprites are grouped and marked in use or not", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const text = buildSpritesText(new Set(["grass", "tree_round"]));
    expect(text).toContain("## terrain");
    expect(text).toMatch(/grass — .* · in use/);
    expect(text).toMatch(/axe — .* · not yet used/);
  });
  it("journal shows one copy when unchanged, both when revised, oldest first", () => {
    const plain = buildJournalText([entry({ title: "One", journal: "same", director: { title: "One", brief: "", experience: "", buildsOn: [], sprites: [], journal: "same" } })]);
    expect(plain).toContain("## One\nsame");
    expect(plain).not.toContain("Planned:");
    const revised = buildJournalText([
      entry({ title: "One", journal: "built v", journalRevised: true, director: { title: "One", brief: "", experience: "", buildsOn: [], sprites: [], journal: "planned v" } }),
      entry({ title: "Two", journal: "second" }),
    ]);
    expect(revised).toContain("Planned: planned v\nBuilt: built v");
    expect(revised.indexOf("## One")).toBeLessThan(revised.indexOf("## Two"));
  });
  it("buildDirectorPrompt fills every slot", () => {
    const p = buildDirectorPrompt({ systemsText: "SYS", spritesText: "SPR", journalText: "JRN" });
    expect(p.includes("{{")).toBe(false);
    expect(p).toContain("SYS");
  });
});

describe("director reply parsing", () => {
  const inCat = (id: string) => ["branch", "fx_fire"].includes(id);
  it("parses a good reply", () => { const r = parseDirectorReply(dirJson(), inCat, ["carry"]); expect(r.problems).toEqual([]); expect(r.entry?.title).toBe("Fire"); });
  it("names a missing field", () => { const j = JSON.parse(dirJson().slice(8, -4)); delete j.experience; const r = parseDirectorReply("```json\n" + JSON.stringify(j) + "\n```", inCat, ["carry"]); expect(r.problems.join(" ")).toMatch(/missing required field: experience/); });
  it("warns but does not block on unknown sprite or buildsOn", () => {
    const r = parseDirectorReply(dirJson({ sprites: ["dragon_huge"], buildsOn: ["nope"] }), inCat, ["carry"]);
    expect(r.problems).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/dragon_huge/);
    expect(r.warnings.join(" ")).toMatch(/nope/);
  });
  it("hand-typed tasks still get a journal note line", () => { expect(HAND_TASK_NOTE).toContain("no director journal entry"); });
});

describe("map image geometry", () => {
  it("labels line up with tile centres", () => {
    expect(tileCenterPx(0, 0)).toEqual({ px: MAP_MARGIN_LEFT + 8 * MAP_SCALE, py: MAP_MARGIN_TOP + 8 * MAP_SCALE });
    expect(tileCenterPx(3, 16).px).toBe(MAP_MARGIN_LEFT + (3 * 16 + 8) * MAP_SCALE); // stream row
    expect(tileCenterPx(3, 16).py).toBe(MAP_MARGIN_TOP + (16 * 16 + 8) * MAP_SCALE);
  });
});
