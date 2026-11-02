// World text shared by the planner and designer prompts (spec 13.3, 13.4): system blocks,
// entity and terrain counts, the player's situation and the catalog lines. Everything here
// reads the world and never changes it.
import { CATALOG } from "../engine/catalog";
import type { Engine } from "../engine/engine";
import type { Host } from "../engine/host";
import { readFacing } from "../engine/interactions";
import type { Manifest } from "../engine/manifest";

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
export const CATALOG_LEGEND = "Fields: id — description · layer, or kind for audio and fonts · size of ONE entity in tiles (WxH, not a grid of copies) · then, when present: footprint (tiles it occupies from its bottom-left; 1x1 when absent) · tags · materials · anims (names for anim()) · variants (related entries by name) · becomes (what it turns into after an event) · faceset (dialog portrait id)";

const pairs = (m: Record<string, string> | undefined) => m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(", ") : "-";

/** {{CATALOG}}: the legend, then one line per entry, its fields in legend order; named fields are left out when absent. */
export function catalogText(): string {
  return [CATALOG_LEGEND, ...CATALOG.sprites.map((s) => {
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
    const named: [string, string][] = [["footprint", fp], ["tags", list(s.tags)], ["materials", list(s.materials)], ["anims", anims], ["variants", pairs(s.variants)], ["becomes", pairs(s.becomes)], ["faceset", s.faceset ?? "-"]];
    return [`${s.id} — ${s.desc ?? ""}`, layer, size, ...named.filter(([, v]) => v !== "-").map(([k, v]) => `${k}: ${v}`)].join(" · ");
  })].join("\n");
}
