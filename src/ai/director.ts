import templateRaw from "./prompts/director.md?raw";
import pillarsRaw from "./pillars.md?raw";
import movementRaw from "../systems/base/movement.ts?raw";
import carryRaw from "../systems/base/carry.ts?raw";
import pushRaw from "../systems/base/push.ts?raw";
import useRaw from "../systems/base/use.ts?raw";
import daynightRaw from "../systems/base/daynight.ts?raw";
import { CATALOG, catalogGet } from "../engine/catalog";
import type { Engine } from "../engine/engine";
import type { SystemDef } from "../engine/api";
import type { DirectorEntry, JournalLike } from "../pipeline/persistence";

export type { DirectorEntry };
const template = templateRaw as unknown as string;
const BASE_SOURCES: Record<string, string> = {
  movement: movementRaw as unknown as string, carry: carryRaw as unknown as string,
  push: pushRaw as unknown as string, use: useRaw as unknown as string, daynight: daynightRaw as unknown as string,
};
export const HAND_TASK_NOTE = "There is no director journal entry for this update. Write one yourself: 2 to 4 sentences on why this was added and what it could lead to.";

function section(name: string): string {
  const start = template.indexOf("# " + name);
  if (start < 0) throw new Error(`director template is missing its "${name}" section`);
  const rest = template.slice(start + name.length + 2);
  const next = rest.indexOf("\n# ");
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/** Sprites a system uses or adds: declared entity sprites, plus every catalog sprite id appearing as a string in its source. */
export function systemSprites(def: SystemDef, source: string | undefined): string[] {
  const used = new Set<string>();
  for (const e of Object.values(def.entities)) used.add(e.sprite);
  if (source) {
    for (const m of source.matchAll(/["'`]([a-z0-9_]+)["'`]/g)) if (catalogGet(m[1])) used.add(m[1]);
  }
  return CATALOG.sprites.filter((s) => used.has(s.id)).map((s) => s.id);
}

/** {{SYSTEMS}}: one entry per loaded system, base and AI alike, in load order. No code. */
export function buildSystemsText(defs: SystemDef[], sources: Record<string, string>): string {
  return defs.map((def) => {
    const sprites = systemSprites(def, sources[def.id] ?? BASE_SOURCES[def.id]);
    return [
      `## ${def.id}`,
      `name: ${def.id}`,
      `what it does: ${def.why}`,
      `sprites it uses or adds: ${sprites.length ? sprites.join(", ") : "(none)"}`,
      "hooks:",
      ...(def.contract.hooks.length ? def.contract.hooks.map((h) => `  - ${h}`) : ["  (none)"]),
    ].join("\n");
  }).join("\n\n");
}

/** Every sprite currently shown by a tile/entity, plus every sprite listed under some system. */
export function spritesInUse(eng: Engine, defs: SystemDef[], sources: Record<string, string>): Set<string> {
  const used = new Set<string>();
  for (const row of eng.tilesGrid) for (const id of row) used.add(id);
  for (const r of eng.entities.values()) used.add(eng.spriteIdOf(r));
  for (const def of defs) for (const id of systemSprites(def, sources[def.id] ?? BASE_SOURCES[def.id])) used.add(id);
  return used;
}

/** {{SPRITES}}: grouped under a heading per first tag, each marked in use or not yet used. */
export function buildSpritesText(inUse: Set<string>): string {
  const groups = new Map<string, string[]>();
  for (const s of CATALOG.sprites) {
    const tag = s.tags[0] ?? "other";
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(`${s.id} — ${s.desc ?? ""} · ${inUse.has(s.id) ? "in use" : "not yet used"}`);
  }
  return [...groups.entries()].map(([tag, lines]) => `## ${tag}\n${lines.join("\n")}`).join("\n\n");
}

/** {{JOURNAL}}: every entry, oldest first; Planned/Built when the designer revised the director's entry. */
export function buildJournalText(entries: JournalLike[]): string {
  if (!entries.length) return "(No entries yet. This is the first update.)";
  return entries.map((e) => {
    if (e.director && e.journalRevised) return `## ${e.title}\nPlanned: ${e.director.journal}\nBuilt: ${e.journal}`;
    return `## ${e.title}\n${e.journal}`;
  }).join("\n\n");
}

/** Build the full director prompt. Throws if any slot is left unfilled. */
export function buildDirectorPrompt(opts: { systemsText: string; spritesText: string; journalText: string }): string {
  let out = section("System message");
  const fill = (k: string, v: string) => { out = out.split("{{" + k + "}}").join(v); };
  fill("PILLARS", (pillarsRaw as unknown as string).trim());
  fill("SYSTEMS", opts.systemsText);
  fill("MAP_IMAGE", "(See the attached map image.)");
  fill("SPRITES", opts.spritesText);
  fill("JOURNAL", opts.journalText);
  if (out.includes("{{")) throw new Error("director prompt still contains an unfilled {{slot}}");
  return out;
}

/** Current-world director prompt from a live engine, its system defs/sources and the journal. */
export function currentDirectorPrompt(eng: Engine, defs: SystemDef[], sources: Record<string, string>, journal: JournalLike[]): string {
  return buildDirectorPrompt({
    systemsText: buildSystemsText(defs, sources),
    spritesText: buildSpritesText(spritesInUse(eng, defs, sources)),
    journalText: buildJournalText(journal),
  });
}

const REQUIRED = ["title", "brief", "experience", "buildsOn", "sprites", "journal"] as const;
/** Parse a director reply: one ```json block with the required fields. Warnings never block. */
export function parseDirectorReply(reply: string, catalogIds: (id: string) => boolean, loadedIds: string[]): { entry?: DirectorEntry; problems: string[]; warnings: string[] } {
  const problems: string[] = []; const warnings: string[] = [];
  const m = reply.match(/```json\s*\n([\s\S]*?)```/);
  if (!m) return { problems: ["the reply has no ```json block"], warnings };
  let parsed: Partial<DirectorEntry>;
  try { parsed = JSON.parse(m[1]) as Partial<DirectorEntry>; } catch (e) { return { problems: ["the ```json block is not valid JSON: " + (e as Error).message], warnings }; }
  for (const k of REQUIRED) {
    const v = parsed[k];
    if (v === undefined || v === "" || ((k === "buildsOn" || k === "sprites") && !Array.isArray(v))) problems.push(`missing required field: ${k}`);
  }
  if (problems.length) return { problems, warnings };
  const entry = parsed as DirectorEntry;
  for (const id of entry.sprites) if (!catalogIds(id)) warnings.push(`warning: sprite "${id}" is not in the catalog`);
  for (const id of entry.buildsOn) if (!loadedIds.includes(id)) warnings.push(`warning: buildsOn "${id}" does not name a loaded system`);
  return { entry, problems, warnings };
}
