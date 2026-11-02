// World text shared by the planner and designer prompts (spec 13.3, 13.4): system blocks,
// entity and terrain counts, the player's situation and the catalog lines. Everything here
// reads the world and never changes it.
import { CATALOG, catalogGet } from "../engine/catalog";
import type { Engine } from "../engine/engine";
import type { Host } from "../engine/host";
import { readFacing } from "../engine/interactions";
import type { Manifest } from "../engine/manifest";
import type { CatalogEntry } from "../engine/types";
import { LIMITS } from "../tuning";

const list = (xs: readonly string[]) => (xs.length ? `[${xs.join(", ")}]` : "(none)");
const sub = (lines: string[]) => (lines.length ? lines : ["  (none)"]);

/** One system block, built from the manifest only: byte-identical every time for the same manifest. */
export function systemBlock(m: Manifest): string {
  return [
    `## System: ${m.id}`,
    `why: ${m.why}`,
    `buildsOn: ${list(m.buildsOn)}`,
    `replaces: ${list(m.replaces)}`,
    "interactions:",
    ...sub(m.interactions.map((it) => `  - ${it.verb} "${it.label}" on ${it.target}, held ${it.held ?? "anything"}`)),
    `reactions: ${list(m.reactions)}`,
    "emits:",
    ...sub(Object.entries(m.emits).map(([name, shape]) => `  - ${name}: ${JSON.stringify(shape)}`)),
    "components:",
    ...sub(Object.entries(m.components).map(([name, shape]) => `  - ${name}: ${shape}`)),
    "entity types added:",
    ...sub(Object.entries(m.entities).map(([name, t]) => `  - ${name}: sprite ${t.sprite}, tags ${list(t.tags)}`)),
  ].join("\n");
}

/** Ids some loaded system replaces. */
function replacedIds(host: Host): Set<string> {
  return new Set([...host.systems.values()].flatMap((s) => s.manifest.replaces));
}

/** Loaded, not-replaced AI systems in load order. */
export function aiManifests(host: Host): Manifest[] {
  const replaced = replacedIds(host);
  return [...host.systems.values()].filter((s) => !s.base && !replaced.has(s.id)).map((s) => s.manifest);
}

/** {{BASE_SYSTEMS}}, {{AI_SYSTEMS}} (all but the newest) and {{NEWEST_AI_SYSTEM}}. */
export function systemSlots(host: Host): { BASE_SYSTEMS: string; AI_SYSTEMS: string; NEWEST_AI_SYSTEM: string } {
  const base = [...host.systems.values()].filter((s) => s.base).map((s) => systemBlock(s.manifest));
  const ai = aiManifests(host).map(systemBlock);
  return { BASE_SYSTEMS: base.join("\n\n"), AI_SYSTEMS: ai.slice(0, -1).join("\n\n"), NEWEST_AI_SYSTEM: ai.at(-1) ?? "" };
}

/** Areas in order: the current one first, then the rest in creation order. */
function areaOrder(eng: Engine): string[] {
  const current = eng.player()?.pos?.area;
  const ids = [...eng.areas.keys()];
  return current && ids.includes(current) ? [current, ...ids.filter((a) => a !== current)] : ids;
}

/** `- name: n` lines, by count descending, then by name. */
function countLines(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([n, c]) => `- ${n}: ${c}`);
}

function grouped(eng: Engine, per: (area: string) => Map<string, number>): string {
  return areaOrder(eng).map((a) => [`area ${a}:`, ...countLines(per(a))].join("\n")).join("\n\n");
}

/**
 * {{ENTITY_COUNTS}}: `- type: n` per entity type under one `area <id>:` line per area. An entity
 * with no position (the held item) counts in the player's area.
 */
export function entityCounts(eng: Engine): string {
  const current = eng.player()?.pos?.area ?? null;
  return grouped(eng, (area) => {
    const c = new Map<string, number>();
    for (const r of eng.entities.values()) if ((r.pos?.area ?? current) === area) c.set(r.type, (c.get(r.type) ?? 0) + 1);
    return c;
  });
}

/** {{TERRAIN_COUNTS}}: `- terrain: n` per tile sprite, grouped by area the same way. */
export function terrainCounts(eng: Engine): string {
  return grouped(eng, (area) => {
    const c = new Map<string, number>();
    for (const row of eng.areas.get(area)!.tiles) for (const t of row) c.set(t, (c.get(t) ?? 0) + 1);
    return c;
  });
}

/** {{PLAYER}}: held item, what is faced, area, phase and day. No coordinates. */
export function playerText(eng: Engine): string {
  const f = readFacing(eng);
  const held = f?.held?.type ?? "nothing";
  const terrain = f ? eng.tileAt(f.area, f.tile.x, f.tile.y) : null;
  const faced = f?.entity ? f.entity.type : terrain ? `terrain ${terrain}` : "the edge of the map";
  return [
    `- holding: ${held}`,
    `- facing: ${faced}`,
    `- area: ${eng.player()?.pos?.area ?? "(none)"}`,
    `- time: ${eng.phase}, day ${eng.day}`,
  ].join("\n");
}

/** The first line of {{CATALOG}}: what each field of a sprite line is. */
export const CATALOG_LEGEND = "Fields: id — description · layer, or kind for audio and fonts · size of ONE entity in tiles (WxH, not a grid of copies) · then, when present: footprint (tiles it occupies from its bottom-left; 1x1 when absent) · door (a building's door column; doorOf(id) gives the tile in front of it) · tags · materials · anims (names for anim()) · variants (related entries by name) · becomes (what it turns into after an event) · faceset (dialog portrait id)";

const pairs = (m: Record<string, string> | undefined) => m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(", ") : "-";

/** One catalog line: the entry's fields in legend order; named fields are left out when absent. */
export function catalogLine(s: CatalogEntry): string {
  const pxW = s.w ?? s.frameW ?? 16, pxH = s.h ?? s.frameH ?? 16;
  const tiles = `${Math.max(1, Math.ceil(pxW / 16))}x${Math.max(1, Math.ceil(pxH / 16))}`;
  const kind = s.kind ?? "sprite";
  const audio = kind === "sound" || kind === "music";
  const layer = kind === "sprite" ? (s.layer ?? "terrain")
    : `${kind}${audio && s.durationMs !== undefined ? ` ${s.durationMs}ms` : ""}${audio && s.loop ? " loop" : ""}`;
  const size = kind === "sprite" ? `${tiles} tiles` : "-";
  const fp = kind !== "sprite" ? "-" : s.footprint ? `${s.footprint.x ? `+${s.footprint.x} ` : ""}${s.footprint.w}x${s.footprint.h}` : "-";
  const list = (a: string[] | undefined) => a?.length ? a.join(", ") : "-";
  const anims = s.anims ? Object.keys(s.anims).join(", ") : "-";
  const named: [string, string][] = [["footprint", fp], ["door", s.door ? `column ${s.door.x}` : "-"], ["tags", list(s.tags)], ["materials", list(s.materials)], ["anims", anims], ["variants", pairs(s.variants)], ["becomes", pairs(s.becomes)], ["faceset", s.faceset ?? "-"]];
  return [`${s.id} — ${s.desc ?? ""}`, layer, size, ...named.filter(([, v]) => v !== "-").map(([k, v]) => `${k}: ${v}`)].join(" · ");
}

/** The whole catalog: the legend, then one line per entry. No prompt sends this any more (it is ~720k chars); kept for tools and tests. */
export function catalogText(): string {
  return [CATALOG_LEGEND, ...CATALOG.sprites.map(catalogLine)].join("\n");
}

// ----------------------------------------------------------------------------------------
// Tag index and per-step catalog (the full catalog is too big to send). The planner sees the
// tag index and names the tags each step needs; the designer then gets only those entries.

/** Entries per tag, in catalog order. */
const BY_TAG: Map<string, CatalogEntry[]> = (() => {
  const m = new Map<string, CatalogEntry[]>();
  for (const s of CATALOG.sprites) for (const t of s.tags) { const a = m.get(t); if (a) a.push(s); else m.set(t, [s]); }
  return m;
})();

/** The variant group an entry belongs to (all members carry the same variants map), or its own id. */
function groupKey(s: CatalogEntry): string {
  return s.variants ? (s.variants.sheet ?? Object.values(s.variants).sort()[0]) : s.id;
}

/** True when this is a catalog tag. */
export const isCatalogTag = (t: string) => BY_TAG.has(t);

/**
 * {{CATALOG_TAGS}}: one line per catalog tag, alphabetical: `tag (count): example ids`. The
 * examples are the first `examples` entries with that tag, one per variant group.
 */
export function tagIndexText(examples: number = LIMITS.TAG_INDEX_EXAMPLES): string {
  return [...BY_TAG.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([tag, xs]) => {
    if (examples <= 0) return `${tag} (${xs.length})`;
    const seen = new Set<string>(); const ids: string[] = [];
    for (const s of xs) {
      const g = groupKey(s);
      if (seen.has(g)) continue;
      seen.add(g); ids.push(s.id);
      if (ids.length >= examples) break;
    }
    return `${tag} (${xs.length}): ${ids.join(", ")}${xs.length > ids.length ? ", ..." : ""}`;
  }).join("\n");
}

/** Tags that say how terrain behaves or is drawn, not what the ground is. */
const TERRAIN_MECHANICS = new Set(["terrain", "walkable", "autotile", "region", "pattern", "overlay", "animated", "hazard", "solid"]);

/**
 * What ground the catalog has: every tag carried by at least two terrain entries, with how many,
 * worked out from the catalog so it stays right as the catalog changes. It reminds the planner
 * that a new place needs ground; which tags fit is left to it.
 */
export function groundTagsText(): string {
  const n = new Map<string, number>();
  for (const s of CATALOG.sprites) if (s.tags.includes("terrain")) for (const t of s.tags) if (!TERRAIN_MECHANICS.has(t)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= 2).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([t, c]) => `${t} (${c})`).join(", ");
}

/** Sprite ids already in use: the sprites of entity types present in the world, and terrain on the maps. */
export function worldSprites(eng: Engine): string[] {
  const out = new Set<string>();
  for (const r of eng.entities.values()) { const sp = eng.types.get(r.type)?.sprite; if (sp) out.add(sp); }
  for (const a of eng.areas.values()) for (const row of a.tiles) for (const t of row) out.add(t);
  return [...out];
}

/** Words of a task, lower case, for the fallback match when a step names no tags. */
const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length > 2));

/** The catalog tags and entry ids a task mentions as whole words. Used only when the planner gave a step no tags. */
export function tagsInText(text: string): string[] {
  const ws = words(text);
  const named = (t: string) => ws.has(t) || ws.has(`${t}s`) || ws.has(`${t}es`);
  return [...[...BY_TAG.keys()].filter(named), ...CATALOG.sprites.map((s) => s.id).filter((id) => !BY_TAG.has(id) && named(id))];
}

/**
 * {{CATALOG}} for one designer step: the legend, then the entries the step needs, cut to
 * LIMITS.STEP_CATALOG_MAX_CHARS. `picks` are catalog tags or entry ids. Order: entries named by id,
 * then entries already in the world (`always`), then tagged entries, those matching more of the
 * picked tags first. Each entry appears once. When the budget runs out, a last line says how many
 * entries were left out and for which tags.
 */
export function stepCatalogText(picks: readonly string[], always: readonly string[] = []): string {
  const max = LIMITS.STEP_CATALOG_MAX_CHARS;
  const tags = picks.filter(isCatalogTag);
  const ids = picks.filter((p) => !isCatalogTag(p) && catalogGet(p));
  const score = new Map<CatalogEntry, number>();
  for (const t of tags) for (const s of BY_TAG.get(t)!) score.set(s, (score.get(s) ?? 0) + 1);
  const order = CATALOG.sprites;
  const ranked = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || order.indexOf(a) - order.indexOf(b));
  const chosen: CatalogEntry[] = []; const seen = new Set<string>();
  const add = (s: CatalogEntry | undefined) => { if (s && !seen.has(s.id)) { seen.add(s.id); chosen.push(s); } };
  ids.forEach((id) => add(catalogGet(id)));
  always.forEach((id) => add(catalogGet(id)));
  ranked.forEach(add);
  const lines = [CATALOG_LEGEND]; let size = CATALOG_LEGEND.length;
  const left: CatalogEntry[] = [];
  for (const s of chosen) {
    const l = catalogLine(s);
    if (left.length || size + 1 + l.length > max) { left.push(s); continue; }
    lines.push(l); size += 1 + l.length;
  }
  if (left.length) {
    const lt = [...new Set(left.flatMap((s) => s.tags.filter((t) => tags.includes(t))))];
    lines.push(`(${left.length} more entr${left.length === 1 ? "y" : "ies"}${lt.length ? ` tagged ${lt.join(", ")}` : ""} left out to keep this list short. Pick from the entries above.)`);
  }
  if (lines.length === 1) lines.push("(no entries were picked for this task; use the tag index above and the sprites already in the world)");
  return lines.join("\n");
}
