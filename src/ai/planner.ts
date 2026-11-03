// The planner (spec 13.4): builds its prompt from src/ai/prompts/planner.md with the same
// section format and cache split as the designer, cleans the wish, and parses its reply.
import templateRaw from "./prompts/planner.md?raw";
import type { Host } from "../engine/host";
import { LIMITS } from "../tuning";
import { catalogGet } from "../engine/catalog";
import { entityCounts, groundTagsText, isCatalogTag, playerText, systemSlots, tagIndexText, terrainCounts } from "./blocks";
import pillarsRaw from "./pillars.md?raw";
import { replyMessage, type AiProvider, type ChatMessage } from "./provider";
import { buildSplit, normalizeEol, promptMessages, section, type BuiltPrompt } from "./template";

export const PLANNER_TEMPLATE = normalizeEol(templateRaw);
export const PILLARS = normalizeEol(pillarsRaw).trim();

/**
 * Clean a wish before it fills {{WISH}}: letters, digits and . , ' ! ? - only, spaces collapsed,
 * cut to WISH_MAX_CHARS. This protects the prompt's structure only; the sandbox is the real boundary.
 */
export function cleanWish(wish: string): string {
  return wish.replace(/[^\p{L}\p{N} .,'!?-]/gu, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.WISH_MAX_CHARS);
}

/** The planner's system message for a cleaned wish, split for caching. */
export function buildPlannerPrompt(host: Host, wish: string): BuiltPrompt {
  return buildSplit(section(PLANNER_TEMPLATE, "System message"), {
    PILLARS,
    CATALOG_TAGS: tagIndexText(),
    GROUND_TAGS: groundTagsText(),
    MAX_STEPS: String(LIMITS.PLAN_MAX_STEPS),
    ...systemSlots(host),
    ENTITY_COUNTS: entityCounts(host.eng),
    TERRAIN_COUNTS: terrainCounts(host.eng),
    PLAYER: playerText(host.eng),
    WISH: wish,
  });
}

export type PlanParse = { ok: true; steps: string[]; tags: string[][]; warnings: string[] } | { ok: false; problem: string };

/**
 * Parse a planner reply: one fenced json block { "steps": [{ "task": string, "tags": string[] }] }.
 * A step may also be a plain string (no tags). Empty steps are ignored. `tags[i]` are the catalog
 * tags or entry ids for steps[i]; unknown names are dropped with a warning, and at most
 * LIMITS.STEP_MAX_TAGS are kept per step.
 */
export function parsePlannerReply(reply: string): PlanParse {
  const text = normalizeEol(reply);
  const fences = [...text.matchAll(/^[ \t]*```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)];
  if (fences.length > 1) return { ok: false, problem: `the reply has ${fences.length} fenced blocks; it needs exactly one json block` };
  const body = fences.length ? fences[0][2] : text;
  let v: unknown;
  try { v = JSON.parse(body); } catch (e) { return { ok: false, problem: fences.length ? `the json block isn't valid JSON: ${(e as Error).message}` : "the reply has no fenced json block" }; }
  const raw = (v as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return { ok: false, problem: 'the json block needs a "steps" list' };
  const isStep = (s: unknown) => typeof s === "string"
    || (typeof s === "object" && s !== null && typeof (s as { task?: unknown }).task === "string"
      && ((s as { tags?: unknown }).tags === undefined || (Array.isArray((s as { tags: unknown[] }).tags) && (s as { tags: unknown[] }).tags.every((t) => typeof t === "string"))));
  if (!raw.every(isStep)) return { ok: false, problem: 'each step must be { "task": string, "tags": [string, ...] }' };
  const warnings: string[] = [];
  const steps: string[] = []; const tags: string[][] = [];
  for (const s of raw as (string | { task: string; tags?: string[] })[]) {
    const task = (typeof s === "string" ? s : s.task).trim();
    if (!task) continue;
    const picked = [...new Set((typeof s === "string" ? [] : s.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    const unknown = picked.filter((t) => !isCatalogTag(t) && !catalogGet(t));
    if (unknown.length) warnings.push(`step ${steps.length + 1}: dropped unknown tag${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`);
    const known = picked.filter((t) => !unknown.includes(t));
    if (known.length > LIMITS.STEP_MAX_TAGS) {
      warnings.push(`step ${steps.length + 1} picked ${known.length} tags; kept the first ${LIMITS.STEP_MAX_TAGS}`);
      known.length = LIMITS.STEP_MAX_TAGS;
    }
    steps.push(task); tags.push(known);
  }
  if (steps.length > LIMITS.PLAN_MAX_STEPS) {
    warnings.push(`the plan had ${steps.length} steps; kept the first ${LIMITS.PLAN_MAX_STEPS}`);
    steps.length = LIMITS.PLAN_MAX_STEPS; tags.length = LIMITS.PLAN_MAX_STEPS;
  }
  return { ok: true, steps, tags, warnings };
}

/** The one re-ask after an unreadable reply. Not in planner.md, which has only the system message. */
export function plannerReask(problem: string): string {
  return `Your reply couldn't be read: ${problem}. Reply again with exactly one fenced \`json\` block { "steps": [{ "task": "...", "tags": ["..."] }] } and nothing outside it.`;
}

export type PlanResult = { ok: true; steps: string[]; tags: string[][]; warnings: string[] } | { ok: false; reason: string };

/** Send the planner prompt, parse the reply, and re-ask once if it can't be read. */
export async function runPlanner(opts: {
  host: Host; provider: AiProvider; wish: string;
  hooks?: { onSend?(attempt: number, text: string): void; onReply?(attempt: number, text: string): void; onProblem?(attempt: number, problem: string): void };
}): Promise<PlanResult> {
  const { hooks = {} } = opts;
  const messages: ChatMessage[] = promptMessages(buildPlannerPrompt(opts.host, opts.wish));
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) messages.push({ role: "user", content: plannerReask(problem) });
    hooks.onSend?.(attempt, attempt === 0 ? messages.map((m) => m.content).join("") : messages.at(-1)!.content);
    const reply = await opts.provider.send(messages.map((m) => ({ ...m })));
    hooks.onReply?.(attempt, reply);
    messages.push(replyMessage(opts.provider, reply));
    const p = parsePlannerReply(reply);
    if (p.ok) return p;
    problem = p.problem; hooks.onProblem?.(attempt, problem);
  }
  return { ok: false, reason: `the planner's reply couldn't be read after one re-ask: ${problem}` };
}
