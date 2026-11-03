// The designer's tools (tool calling): their definitions as the Responses API takes them, and
// runTool, which turns one function call into its text result. The definitions are sent on every
// designer request in the same order and byte for byte, so they stay part of the cached prefix.
import { CATALOG } from "../../engine/catalog";
import type { Engine } from "../../engine/engine";
import { LIMITS } from "../../tuning";
import { catalogGetText, catalogSearch, catalogTags } from "./catalog";
import { entityTypesText } from "./world";

/** A function tool in the Responses API's flat shape. */
export interface ToolSpec { type: "function"; name: string; description: string; parameters: Record<string, unknown> }
/** A function call the model made: arguments are a JSON string. */
export interface ToolCall { callId: string; name: string; arguments: string }
/** What a tool may read. */
export interface ToolContext { eng: Engine }

/** The result every tool call gets once a step's lookup rounds are used up. */
export const LOOKUPS_USED_UP = "No more lookups for this step: you have used them all. Write the system now with the entries you already have.";

const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const DESIGNER_TOOLS: readonly ToolSpec[] = [
  {
    type: "function",
    name: "catalog_search",
    description: `Find entries in the art and sound catalog (${CATALOG.sprites.length} entries: sprites, terrain, sounds, music, fonts). Returns one short line per entry (id, description, layer or kind, size in tiles, tags), with variants of the same thing grouped under one line. Give at least one of tags, any_tags or text. Use catalog_get for the full entries of the ids you will use.`,
    parameters: {
      type: "object",
      properties: {
        tags: strs("Entries must have every one of these tags, e.g. [\"fish\"] or [\"terrain\", \"water\"]."),
        any_tags: strs("Entries must have at least one of these tags, e.g. [\"axe\", \"tool\"]."),
        text: str("Words that must all appear in the entry's id, description or tags, e.g. \"camp fire\"."),
        kind: { type: "string", enum: ["sprite", "sound", "music", "font"], description: "Only entries of this kind." },
        layer: { type: "string", enum: ["terrain", "ground", "object", "above", "overlay"], description: "Only sprites drawn on this layer (terrain = map tiles)." },
        limit: { type: "integer", description: `Groups per page (default ${LIMITS.CATALOG_SEARCH_LIMIT}, at most ${LIMITS.CATALOG_SEARCH_MAX}).` },
        offset: { type: "integer", description: "Groups to skip, for the next page." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "catalog_get",
    description: `The full catalog entries for ids: size in tiles, footprint, door, tags, materials, anims (names for anim()), variants, becomes and faceset. Unknown ids come back with the closest ids. Every sprite, sound and anim you name in the manifest or module must come from these entries. At most ${LIMITS.CATALOG_GET_MAX_IDS} ids per call.`,
    parameters: {
      type: "object",
      properties: { ids: strs("Catalog entry ids, e.g. [\"campfire\", \"log_fallen\"].") },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "catalog_tags",
    description: "The catalog's tags with how many entries carry each, alphabetical. With match, only tags containing that text.",
    parameters: {
      type: "object",
      properties: { match: str("Text the tag must contain, e.g. \"fish\".") },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "entity_types",
    description: "The entity types registered in the world now (by the base map or a loaded system), each with its sprite, tags, who registered it and how many are in the world. Only these names, and the ones your manifest's entities declares, can be spawned, given or targeted.",
    parameters: {
      type: "object",
      properties: {
        match: str("Text the type's name or sprite must contain, e.g. \"log\"."),
        tag: str("Only types carrying this tag, e.g. \"item\"."),
      },
      additionalProperties: false,
    },
  },
];

const RUN: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => string> = {
  catalog_search: (a) => catalogSearch(a),
  catalog_get: (a) => catalogGetText(a),
  catalog_tags: (a) => catalogTags(a),
  entity_types: (a, ctx) => entityTypesText(ctx.eng, a),
};

/** Run one call and return its text result. Never throws: a bad call gets a message the model can act on. */
export function runTool(call: Pick<ToolCall, "name" | "arguments">, ctx: ToolContext): string {
  const run = RUN[call.name];
  if (!run) return `There is no tool named "${call.name}". The tools are ${Object.keys(RUN).join(", ")}.`;
  let args: unknown;
  try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch (e) { return `The arguments aren't valid JSON (${(e as Error).message}); send them as one JSON object.`; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return "The arguments must be one JSON object.";
  try { return run(args as Record<string, unknown>, ctx); } catch (e) { return `The lookup failed: ${(e as Error).message}`; }
}

/** A few words on what a result held, for the AI tab and log: "14 entries", "3 found, 1 not in the catalog". */
export function resultSummary(name: string, result: string): string {
  if (result === LOOKUPS_USED_UP) return "no more lookups";
  const first = (result.split("\n").find((l) => !l.startsWith('"')) ?? "").trim();
  const short = (t: string) => (t.length > 70 ? `${t.slice(0, 69)}…` : t);
  const n = (re: RegExp) => re.exec(result)?.[1];
  if (name === "catalog_search") { const c = n(/^(\d+) entr(?:y|ies) in /m); return c ? `${c} entr${c === "1" ? "y" : "ies"}` : short(first); }
  if (name === "catalog_get" && result.startsWith("Fields: ")) {
    const lines = result.split("\n").slice(1);
    const missing = lines.filter((l) => / not in the catalog\./.test(l)).length;
    const found = lines.filter((l) => / — /.test(l) && !/ not in the catalog\./.test(l)).length;
    return `${found} found${missing ? `, ${missing} not in the catalog` : ""}`;
  }
  if (name === "catalog_tags") { const c = n(/^(\d+) tags? /m); return c ? `${c} tag${c === "1" ? "" : "s"}` : short(first); }
  if (name === "entity_types") { const c = n(/^(\d+) registered entity types?/m); return c ? `${c} type${c === "1" ? "" : "s"}` : short(first); }
  return short(first);
}
