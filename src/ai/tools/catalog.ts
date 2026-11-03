// Catalog lookups for the designer (tool calling): the designer prompt no longer carries catalog
// entries in API mode; the designer asks for what it needs with these three tools. Pure functions
// over CATALOG, never changing anything. Each returns plain text for the model, and bad arguments
// come back as a readable message rather than an exception, so the model can correct itself.
import { CATALOG, catalogGet } from "../../engine/catalog";
import type { CatalogEntry } from "../../engine/types";
import { LIMITS } from "../../tuning";
import { BY_TAG, CATALOG_LEGEND, catalogLine, groupKey } from "../blocks";

const KINDS = ["sprite", "sound", "music", "font"] as const;
const LAYERS = ["terrain", "ground", "object", "above", "overlay"] as const;
type Kind = (typeof KINDS)[number];
type Layer = (typeof LAYERS)[number];

const kindOf = (s: CatalogEntry): Kind => s.kind ?? "sprite";
/** The layer as a catalog line shows it: terrain tiles have none in the data. */
const layerOf = (s: CatalogEntry): Layer | null => (kindOf(s) === "sprite" ? s.layer ?? "terrain" : null);
const lower = (x: string) => x.toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Edit distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Up to `n` names from `pool` closest to `q`: shared words first, then edit distance. */
export function closest(q: string, pool: Iterable<string>, n = 5): string[] {
  const ql = lower(q); const qWords = new Set(ql.split(/[^a-z0-9]+/).filter(Boolean));
  const scored: [string, number][] = [];
  for (const name of pool) {
    const nl = lower(name);
    const nWords = nl.split(/[^a-z0-9]+/).filter(Boolean);
    // A shared word, or one word the start of the other ("logg" and "log_fallen").
    const shared = nWords.filter((w) => qWords.has(w) || (w.length >= 3 && [...qWords].some((q) => q.length >= 3 && (q.startsWith(w) || w.startsWith(q))))).length;
    const stem = ql.slice(0, Math.max(4, ql.length - 2));
    const contains = nl.includes(ql) || ql.includes(nl) || (stem.length >= 4 && nl.startsWith(stem)) ? 1 : 0;
    const d = distance(ql, nl);
    if (!shared && !contains && d > Math.max(2, Math.floor(ql.length / 3))) continue;
    scored.push([name, -shared * 10 - contains * 5 + d]);
  }
  return scored.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([x]) => x);
}

/** Cut a result to LIMITS.TOOL_RESULT_MAX_CHARS at a line break, with a note. */
export function capped(text: string, note = "narrow the request to see the rest"): string {
  const max = LIMITS.TOOL_RESULT_MAX_CHARS;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 120);
  return `${text.slice(0, cut > 0 ? cut : max - 120)}\n(cut here to keep this result short: ${note})`;
}

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : null);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

// ------------------------------------------------------------------------------------------
// catalog_tags

/** `tag (count)` lines, alphabetical; with `match`, only tags containing it. */
export function catalogTags(args: { match?: unknown }): string {
  if (args.match !== undefined && typeof args.match !== "string") return "match must be a string.";
  const m = lower(String(args.match ?? "").trim());
  const tags = [...BY_TAG.keys()].sort().filter((t) => !m || t.includes(m));
  if (!tags.length) {
    const near = closest(m, BY_TAG.keys());
    return `No tag contains "${m}".${near.length ? ` Closest tags: ${near.join(", ")}.` : ""} Call catalog_tags with no match to list them all.`;
  }
  return capped(`${plural(tags.length, "tag")}${m ? ` containing "${m}"` : ""} (tag (entries)):\n${tags.map((t) => `${t} (${BY_TAG.get(t)!.length})`).join(", ")}`);
}

// ------------------------------------------------------------------------------------------
// catalog_search

/** One short line for search results: id — desc · layer or kind · size · tags. */
export function shortLine(s: CatalogEntry): string {
  const parts = catalogLine(s).split(" · ");
  const tags = parts.find((p) => p.startsWith("tags: "));
  return [...parts.slice(0, 3).filter((p) => p !== "-"), ...(tags ? [tags] : [])].join(" · ");
}

export interface SearchArgs { tags?: unknown; any_tags?: unknown; text?: unknown; kind?: unknown; layer?: unknown; limit?: unknown; offset?: unknown }

/**
 * Entries with every tag in `tags`, at least one tag in `any_tags`, every word of `text` in their
 * id, description or tags, of `kind`, on `layer`. Results are grouped by variant group (one line,
 * then the other members' ids), in catalog order, and paged by `offset` and `limit` over groups.
 * A name in `tags` or `any_tags` that isn't a tag is searched as a word instead (with a note
 * naming the closest tags), so a near miss costs no extra round.
 */
export function catalogSearch(args: SearchArgs): string {
  const all = stringList(args.tags ?? []); const any = stringList(args.any_tags ?? []);
  if (!all) return "tags must be a list of strings.";
  if (!any) return "any_tags must be a list of strings.";
  if (args.text !== undefined && typeof args.text !== "string") return "text must be a string.";
  const words = lower(String(args.text ?? "")).split(/\s+/).filter(Boolean);
  if (!all.length && !any.length && !words.length) return "Give at least one of tags, any_tags or text.";
  // Names that aren't tags become words: required ones join `words`, any-of ones form their own group.
  const notes: string[] = [];
  const asWord = (t: string) => { const near = closest(t, BY_TAG.keys()); notes.push(`"${t}" is not a tag, so it was searched as a word${near.length ? ` (closest tags: ${near.join(", ")})` : ""}.`); return lower(t); };
  const allTags = all.filter((t) => BY_TAG.has(t)); const anyTags = any.filter((t) => BY_TAG.has(t));
  words.push(...all.filter((t) => !BY_TAG.has(t)).map(asWord));
  const anyWords = any.filter((t) => !BY_TAG.has(t)).map(asWord);
  if (args.kind !== undefined && !KINDS.includes(args.kind as Kind)) return `kind must be one of ${KINDS.join(", ")}.`;
  if (args.layer !== undefined && !LAYERS.includes(args.layer as Layer)) return `layer must be one of ${LAYERS.join(", ")} (layer applies to sprites only).`;
  const limit = whole(args.limit ?? LIMITS.CATALOG_SEARCH_LIMIT); const offset = whole(args.offset ?? 0);
  if (limit === null || limit < 1) return "limit must be a whole number of at least 1.";
  if (offset === null || offset < 0) return "offset must be a whole number, 0 or more.";
  const take = Math.min(limit, LIMITS.CATALOG_SEARCH_MAX);

  const has = (s: CatalogEntry, w: string) => lower(s.id).includes(w) || lower(s.desc ?? "").includes(w) || s.tags.some((t) => t.includes(w));
  const matches = CATALOG.sprites.filter((s) =>
    allTags.every((t) => s.tags.includes(t))
    && (!any.length || anyTags.some((t) => s.tags.includes(t)) || anyWords.some((w) => has(s, w)))
    && (args.kind === undefined || kindOf(s) === args.kind)
    && (args.layer === undefined || layerOf(s) === args.layer)
    && words.every((w) => has(s, w)));
  if (!matches.length) return [...notes, "No entries match. Try fewer tags, any_tags instead of tags, or other words."].join("\n");

  const groups = new Map<string, CatalogEntry[]>();
  for (const s of matches) { const g = groupKey(s); const a = groups.get(g); if (a) a.push(s); else groups.set(g, [s]); }
  const list = [...groups.values()];
  if (offset >= list.length) return `Only ${plural(list.length, "group")} match; offset ${offset} is past the end.`;
  const page = list.slice(offset, offset + take);
  const lines = page.map((g) => {
    const others = g.slice(1).map((s) => s.id);
    const more = others.length > 6 ? `${others.slice(0, 6).join(", ")}, +${others.length - 6} more` : others.join(", ");
    return `- ${shortLine(g[0])}${others.length ? `\n  variants: ${more}` : ""}`;
  });
  const end = offset + page.length;
  return capped([
    ...notes,
    `${plural(matches.length, "entry", "entries")} in ${plural(list.length, "group")} match; groups ${offset + 1}–${end}:`,
    ...lines,
    end < list.length ? `(${list.length - end} more groups: call again with offset ${end}.)` : "(that is all of them.)",
    "Call catalog_get with ids for their full entries (anims, footprint, door, variants) before using them.",
  ].join("\n"), `call again with a higher offset or a smaller limit`);
}

// ------------------------------------------------------------------------------------------
// catalog_get

/** The full catalog lines for `ids`, with the legend; unknown ids get the closest ids. */
export function catalogGetText(args: { ids?: unknown }): string {
  const ids = stringList(args.ids);
  if (!ids || !ids.length) return "ids must be a non-empty list of entry ids.";
  const uniq = [...new Set(ids)];
  if (uniq.length > LIMITS.CATALOG_GET_MAX_IDS) return `Ask for at most ${LIMITS.CATALOG_GET_MAX_IDS} ids per call (you asked for ${uniq.length}); split them over several calls in the same reply.`;
  const lines: string[] = []; const missing: string[] = [];
  for (const id of uniq) {
    const s = catalogGet(id);
    if (s) lines.push(catalogLine(s));
    else { const near = closest(id, CATALOG.sprites.map((x) => x.id)); missing.push(`${id}: not in the catalog.${near.length ? ` Closest ids: ${near.join(", ")}.` : ""}`); }
  }
  return capped([CATALOG_LEGEND, ...lines, ...missing].join("\n"), "ask for fewer ids per call");
}
