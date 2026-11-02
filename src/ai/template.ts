// Prompt templates (spec 13.3, 13.4): the "# <name>" sections of a companion .md file, slot
// filling, and the cache split at the <!-- CACHE BREAKPOINT ... --> line.
//
// The template text is never edited. Line endings are read as \n, so a checkout with CRLF
// endings (Windows) builds the same prompt.

/** A built prompt: `cached` goes in the first system message (cache: true), `rest` in the second. */
export interface BuiltPrompt { cached: string; rest: string; slots: Record<string, string> }

const SLOT_RE = /\{\{([A-Z_]+)\}\}/g;
const MARKER_RE = /^<!-- CACHE BREAKPOINT\b.*-->[ \t]*$/m;

export const normalizeEol = (text: string) => text.replace(/\r\n?/g, "\n");

/** The body of one "# <name>" section, without its heading, trimmed. */
export function section(template: string, name: string): string {
  const lines = normalizeEol(template).split("\n");
  const start = lines.findIndex((l) => l === `# ${name}`);
  if (start < 0) throw new Error(`the template has no "# ${name}" section`);
  let end = lines.findIndex((l, i) => i > start && /^# /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** The slot names a text uses, in order of first use. */
export function slotNames(text: string): string[] { return [...new Set([...text.matchAll(SLOT_RE)].map((m) => m[1]))]; }

/**
 * Fill every {{SLOT}} in one pass, so a slot's value is never filled again. Throws when the text
 * uses a slot that has no value, so no "{{" from the template can reach the model.
 */
export function fill(text: string, slots: Record<string, string>): string {
  const missing = slotNames(text).filter((n) => !(n in slots));
  if (missing.length) throw new Error(`no value for slot(s) ${missing.map((n) => `{{${n}}}`).join(", ")}`);
  return text.replace(SLOT_RE, (_m, name: string) => slots[name]);
}

/**
 * Split a section at its CACHE BREAKPOINT line (removed), then fill both parts. `cached` is
 * everything above the line with trailing whitespace moved into `rest`, so cached + rest is the
 * whole prompt, and when a system loads (the system lists grow at their end) the old cached part
 * stays a prefix of the new one.
 */
export function buildSplit(text: string, slots: Record<string, string>): BuiltPrompt {
  const m = MARKER_RE.exec(text);
  if (!m) throw new Error("the template has no CACHE BREAKPOINT line");
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length).replace(/^\n/, "");
  const head = fill(before, slots);
  const cached = head.replace(/\s+$/, "");
  return { cached, rest: head.slice(cached.length) + fill(after, slots), slots };
}

/** The two system messages for a built prompt. */
export function promptMessages(p: BuiltPrompt) {
  return [
    { role: "system" as const, content: p.cached, cache: true },
    { role: "system" as const, content: p.rest },
  ];
}

export const estTokens = (chars: number) => Math.ceil(chars / 4);
