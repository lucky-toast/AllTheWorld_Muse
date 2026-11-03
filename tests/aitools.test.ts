// The designer's catalog tools (tool calling): search, get and tags over the real catalog, their
// limits, the messages bad arguments get, and the tool definitions sent to the API.
import { CATALOG, catalogFind } from "../src/engine/catalog";
import { CATALOG_LEGEND, catalogLine } from "../src/ai/blocks";
import { catalogGetText, catalogSearch, catalogTags, closest, shortLine } from "../src/ai/tools/catalog";
import { DESIGNER_TOOLS, runTool } from "../src/ai/tools";
import { LIMITS } from "../src/tuning";

const call = (name: string, args: unknown) => runTool({ name, arguments: JSON.stringify(args) });
const grouped = CATALOG.sprites.find((s) => s.variants && Object.keys(s.variants).length > 2)!;

describe("catalog_search", () => {
  test("finds entries by tag, one short line per variant group, with the other members listed", () => {
    const tag = grouped.tags[0];
    const text = catalogSearch({ tags: [tag], limit: LIMITS.CATALOG_SEARCH_MAX });
    expect(text).toMatch(/^\d+ entr(y|ies) in \d+ groups? match; groups 1–\d+:/);
    expect(text).toContain("Call catalog_get");
    // Each line is a short line: no anims or variants fields, those are for catalog_get.
    for (const line of text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).not.toMatch(/ · anims: | · variants: | · footprint: /);
    }
  });
  test("tags must all match; any_tags needs one; text words must all appear", () => {
    const fishing = catalogFind("fishing");
    const both = catalogSearch({ tags: ["fishing", "fire"] });
    const either = catalogSearch({ any_tags: ["fishing", "firepit"] });
    expect(both).toMatch(/^No entries match/);
    for (const id of fishing) expect(either).toContain(id);
    expect(catalogSearch({ text: "stone fire ring" })).toContain("firepit");
    expect(catalogSearch({ text: "stone fire ring zebra" })).toMatch(/No entries match/);
  });
  test("a name that isn't a tag is searched as a word, with the closest tags named", () => {
    const text = catalogSearch({ tags: ["fish"] });
    expect(text.split("\n")[0]).toBe('"fish" is not a tag, so it was searched as a word (closest tags: fishing, ash, bush, fire).');
    expect(text).toMatch(/^- fish — /m);
  });
  test("kind and layer filter, and pages are over groups with an offset to continue", () => {
    const sounds = catalogSearch({ text: "fire", kind: "sound" });
    for (const line of sounds.split("\n").filter((l) => l.startsWith("- "))) expect(line).toMatch(/ · sound \d+ms/);
    const ground = catalogSearch({ text: "fire", layer: "ground" });
    for (const line of ground.split("\n").filter((l) => l.startsWith("- "))) expect(line).toContain(" · ground · ");
    const first = catalogSearch({ tags: ["npc"], limit: 3 });
    expect(first).toMatch(/groups 1–3:/);
    expect(first).toMatch(/call again with offset 3/);
    const second = catalogSearch({ tags: ["npc"], limit: 3, offset: 3 });
    expect(second).toMatch(/groups 4–6:/);
    expect(second.split("\n")[1]).not.toBe(first.split("\n")[1]);
  });
  test("bad arguments get a message, never a throw", () => {
    expect(catalogSearch({})).toBe("Give at least one of tags, any_tags or text.");
    expect(catalogSearch({ tags: "fishing" })).toBe("tags must be a list of strings.");
    expect(catalogSearch({ text: 3 })).toBe("text must be a string.");
    expect(catalogSearch({ text: "fire", kind: "smell" })).toMatch(/^kind must be one of sprite, sound, music, font/);
    expect(catalogSearch({ text: "fire", layer: "sky" })).toMatch(/^layer must be one of/);
    expect(catalogSearch({ text: "fire", limit: 0 })).toMatch(/^limit must be/);
    expect(catalogSearch({ text: "fire", offset: 999 })).toMatch(/offset 999 is past the end/);
  });
  test("a limit above the maximum is capped, and every result fits the result cap", () => {
    const text = catalogSearch({ tags: ["character"], limit: 1000 });
    expect(text).toMatch(new RegExp(`groups 1–${LIMITS.CATALOG_SEARCH_MAX}:`));
    expect(text.length).toBeLessThanOrEqual(LIMITS.TOOL_RESULT_MAX_CHARS);
  });
  test("shortLine is the start of the full catalog line plus its tags", () => {
    const line = shortLine(grouped);
    expect(catalogLine(grouped).startsWith(line.split(" · tags: ")[0])).toBe(true);
    expect(line).toContain(`tags: ${grouped.tags.join(", ")}`);
  });
});

describe("catalog_get", () => {
  test("gives the legend and the full catalog line for each id, once", () => {
    const text = catalogGetText({ ids: [grouped.id, "firepit", grouped.id] });
    const lines = text.split("\n");
    expect(lines[0]).toBe(CATALOG_LEGEND);
    expect(lines.slice(1)).toEqual([catalogLine(grouped), catalogLine(CATALOG.sprites.find((s) => s.id === "firepit")!)]);
  });
  test("unknown ids name the closest ids; too many ids or none get a message", () => {
    expect(catalogGetText({ ids: ["camp_fire"] })).toMatch(/^camp_fire: not in the catalog\. Closest ids: .*fx_fire/m);
    expect(catalogGetText({ ids: [] })).toBe("ids must be a non-empty list of entry ids.");
    expect(catalogGetText({})).toBe("ids must be a non-empty list of entry ids.");
    const many = CATALOG.sprites.slice(0, LIMITS.CATALOG_GET_MAX_IDS + 1).map((s) => s.id);
    expect(catalogGetText({ ids: many })).toMatch(/^Ask for at most \d+ ids per call/);
  });
});

describe("catalog_tags and closest", () => {
  test("lists every tag with its count, or those containing match", () => {
    const all = catalogTags({});
    const tags = new Set(CATALOG.sprites.flatMap((s) => s.tags));
    expect(all.split("\n")[0]).toBe(`${tags.size} tags (tag (entries)):`);
    expect(all).toContain(`fishing (${catalogFind("fishing").length})`);
    expect(catalogTags({ match: "fish" })).toBe(`1 tag containing "fish" (tag (entries)):\nfishing (${catalogFind("fishing").length})`);
    expect(catalogTags({ match: "zzzz" })).toMatch(/^No tag contains "zzzz"\./);
  });
  test("closest ranks shared words and stems before edit distance", () => {
    expect(closest("fishes", ["fishing", "fire", "bush"])).toEqual(["fishing"]);
    expect(closest("camp_fire", ["fx_fire", "camp", "zebra"])[0]).toBe("camp");
  });
});

describe("tool definitions and runTool", () => {
  test("three function tools in a fixed order, each with an object schema the API takes", () => {
    expect(DESIGNER_TOOLS.map((t) => t.name)).toEqual(["catalog_search", "catalog_get", "catalog_tags"]);
    for (const t of DESIGNER_TOOLS) {
      expect(t.type).toBe("function");
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(t.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(40);
    }
    // Byte-identical every time they're built, so they stay in the cached prefix.
    expect(JSON.stringify(DESIGNER_TOOLS)).toBe(JSON.stringify(DESIGNER_TOOLS));
  });
  test("runTool runs a call from its JSON arguments, and answers a bad call with a message", () => {
    expect(call("catalog_get", { ids: ["firepit"] })).toContain("firepit — ");
    expect(runTool({ name: "catalog_tags", arguments: "" })).toMatch(/^\d+ tags/);
    expect(call("catalog_burn", {})).toBe('There is no tool named "catalog_burn". The tools are catalog_search, catalog_get, catalog_tags.');
    expect(runTool({ name: "catalog_get", arguments: "{ids: [" })).toMatch(/^The arguments aren't valid JSON/);
    expect(runTool({ name: "catalog_get", arguments: "[1]" })).toBe("The arguments must be one JSON object.");
  });
});
