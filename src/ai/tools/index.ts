// The designer's tools (tool calling): their definitions as the Responses API takes them, and
// runTool, which turns one function call into its text result. The definitions are sent on every
// designer request in the same order and byte for byte, so they stay part of the cached prefix.
import { CATALOG } from "../../engine/catalog";
import { LIMITS } from "../../tuning";
import { catalogGetText, catalogSearch, catalogTags } from "./catalog";

/** A function tool in the Responses API's flat shape. */
export interface ToolSpec { type: "function"; name: string; description: string; parameters: Record<string, unknown> }
/** A function call the model made: arguments are a JSON string. */
export interface ToolCall { callId: string; name: string; arguments: string }

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
];

const RUN: Record<string, (args: Record<string, unknown>) => string> = {
  catalog_search: (a) => catalogSearch(a),
  catalog_get: (a) => catalogGetText(a),
  catalog_tags: (a) => catalogTags(a),
};

/** Run one call and return its text result. Never throws: a bad call gets a message the model can act on. */
export function runTool(call: Pick<ToolCall, "name" | "arguments">): string {
  const run = RUN[call.name];
  if (!run) return `There is no tool named "${call.name}". The tools are ${Object.keys(RUN).join(", ")}.`;
  let args: unknown;
  try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch (e) { return `The arguments aren't valid JSON (${(e as Error).message}); send them as one JSON object.`; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return "The arguments must be one JSON object.";
  try { return run(args as Record<string, unknown>); } catch (e) { return `The lookup failed: ${(e as Error).message}`; }
}
