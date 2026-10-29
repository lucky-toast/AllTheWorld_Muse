import { describe, it, expect } from "vitest";
import { buildPrompt, buildWorldText, catalogText, parseReply, parseVisualReply, estTokens } from "../src/ai/designer";
import { ManualProvider } from "../src/ai/provider";
import { buildWorld } from "../src/world/map";
import { BASE_SYSTEMS } from "../src/systems/base/index";
import { evalSystem } from "../src/pipeline/eval";
import campfire from "../fixtures/campfire.ts?raw";

describe("designer prompt", () => {
  it("is complete with no slots left", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const p = buildPrompt("Make something cozy", buildWorldText(eng, BASE_SYSTEMS));
    expect(p.includes("{{")).toBe(false);
    expect(p).toContain("A place you want to stay");
    expect(p).toContain("spawn(type: string, pos: Pos): Entity");
    expect(p).toContain("src/systems/base/movement.ts");
    expect(p).toContain("(See the attached art board image.)");
    expect(p).toContain("Make something cozy");
    expect(p.length).toBeGreaterThan(5000);
    expect(estTokens(400)).toBe(100);
  });
  it("catalog lines are compact and per sprite", () => {
    const lines = catalogText().split("\n");
    expect(lines.length).toBeGreaterThan(100);
    expect(lines[0]).toMatch(/^grass — .* · .* · 1x1 tiles · .* · anims: /);
  });
  it("WORLD describes base systems with verbatim contracts and counts", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    eng.world().emit("player.moved", { from: { x: 1, y: 1 }, to: { x: 2, y: 1 }, dir: "right" });
    const text = buildWorldText(eng, BASE_SYSTEMS);
    for (const s of BASE_SYSTEMS) {
      expect(text).toContain("## System: " + s.id);
      for (const c of s.contract.claims) expect(text).toContain(c);
      for (const h of s.contract.hooks) expect(text).toContain(h);
    }
    expect(text).toContain("player.moved");
    expect(text).toContain('"dir":"right"'); // one real example payload
    expect(text).toContain("- player: 1");
  });
  it("WORLD describes a loaded AI system the same way", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const def = evalSystem(campfire as unknown as string);
    eng.loadSystem(def);
    const text = buildWorldText(eng, [...BASE_SYSTEMS, def]);
    expect(text).toContain("## System: campfire");
    expect(text).toContain("fire.lit");
    expect(text).toContain("campfire: sprite firepit");
  });
});

describe("reply parsing", () => {
  const good = "```ts\nexport default 1;\n```\n```json\n{\"title\":\"T\",\"summary\":\"S\",\"changes\":[\"c\"],\"journal\":\"J\"}\n```";
  it("parses a good reply", () => { const r = parseReply(good); expect(r.problems).toEqual([]); expect(r.meta?.title).toBe("T"); expect(r.source).toContain("export default"); });
  it("reports a missing ts block clearly", () => { expect(parseReply("no code here").problems.join(" ")).toMatch(/no ```ts block/); });
  it("reports missing json fields", () => { const r = parseReply("```ts\nx\n```\n```json\n{\"title\":\"T\"}\n```"); expect(r.problems.join(" ")).toMatch(/summary/); });
  it("parses visual replies", () => { expect(parseVisualReply('{ "ok": true }').ok).toBe(true); expect(parseVisualReply("```ts\ncode\n```").source).toBe("code"); });
});

describe("ManualProvider", () => {
  it("hands the message to the UI and waits for the pasted reply", async () => {
    const p = new ManualProvider();
    let shown = "";
    p.onShow = (t) => { shown = t; };
    const pending = p.send([{ role: "system", content: "hello AI" }]);
    expect(shown).toBe("hello AI");
    expect(p.waiting).toBe(true);
    p.deliver("reply text");
    await expect(pending).resolves.toBe("reply text");
  });
});
