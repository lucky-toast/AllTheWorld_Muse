// World lookups for the designer (tool calling). Read-only: they report what the world has
// registered and never change it.
import type { Engine } from "../../engine/engine";
import { ENGINE_OWNER, WORLD_OWNER } from "../../engine/types";
import { capped, closest } from "./catalog";

const ownerText = (o: string | undefined) => (o === WORLD_OWNER ? "the base map" : o === ENGINE_OWNER || !o ? "the engine" : `system ${o}`);

/**
 * The registered entity types: one line each with its sprite, tags, who registered it and how many
 * are in the world now. `match` keeps types whose name or sprite contains it; `tag` keeps types
 * carrying that tag. Alphabetical.
 */
export function entityTypesText(eng: Engine, args: { match?: unknown; tag?: unknown }): string {
  if (args.match !== undefined && typeof args.match !== "string") return "match must be a string.";
  if (args.tag !== undefined && typeof args.tag !== "string") return "tag must be a string.";
  const m = String(args.match ?? "").trim().toLowerCase();
  const tag = String(args.tag ?? "").trim();
  const counts = new Map<string, number>();
  for (const r of eng.entities.values()) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const rows = [...eng.types.entries()]
    .filter(([name, t]) => (!m || name.toLowerCase().includes(m) || t.sprite.toLowerCase().includes(m)) && (!tag || t.tags.includes(tag)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const filter = [m && `matching "${m}"`, tag && `tagged ${tag}`].filter(Boolean).join(" and ");
  if (!rows.length) {
    const near = m ? closest(m, eng.types.keys()) : [];
    return [
      `No registered entity type${filter ? ` ${filter}` : "s"}.${near.length ? ` Closest types: ${near.join(", ")}.` : ""}`,
      "To use a catalog sprite as a new type, declare it in your manifest's entities.",
    ].join(" ");
  }
  const lines = rows.map(([name, t]) => `- ${name} — sprite ${t.sprite} · tags [${t.tags.join(", ")}] · from ${ownerText(eng.typeOwner.get(name))} · ${counts.get(name) ?? 0} in the world`);
  return capped([`${rows.length} registered entity type${rows.length === 1 ? "" : "s"}${filter ? ` ${filter}` : ""}:`, ...lines].join("\n"), "use match or tag to narrow it");
}
