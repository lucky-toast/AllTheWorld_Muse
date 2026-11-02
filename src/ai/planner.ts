// The planner (spec 13.4): builds its prompt from src/ai/prompts/planner.md with the same
// section format and cache split as the designer, cleans the wish, and parses its reply.
import templateRaw from "./prompts/planner.md?raw";
import type { Host } from "../engine/host";
import { LIMITS } from "../tuning";
import { catalogText, entityCounts, playerText, systemSlots, terrainCounts } from "./blocks";
import { PILLARS } from "./designer";
import type { AiProvider, ChatMessage } from "./provider";
import { buildSplit, normalizeEol, promptMessages, section, type BuiltPrompt } from "./template";

export const PLANNER_TEMPLATE = normalizeEol(templateRaw);

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
    CATALOG: catalogText(),
    MAX_STEPS: String(LIMITS.PLAN_MAX_STEPS),
    ...systemSlots(host),
    ENTITY_COUNTS: entityCounts(host.eng),
    TERRAIN_COUNTS: terrainCounts(host.eng),
    PLAYER: playerText(host.eng),
    WISH: wish,
  });
}

export type PlanParse = { ok: true; steps: string[]; warnings: string[] } | { ok: false; problem: string };

/** Parse a planner reply: one fenced json block { "steps": string[] }. Empty steps are ignored. */
export function parsePlannerReply(reply: string): PlanParse {
  const text = normalizeEol(reply);
  const fences = [...text.matchAll(/^[ \t]*```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)];
  if (fences.length > 1) return { ok: false, problem: `the reply has ${fences.length} fenced blocks; it needs exactly one json block` };
  const body = fences.length ? fences[0][2] : text;
  let v: unknown;
  try { v = JSON.parse(body); } catch (e) { return { ok: false, problem: fences.length ? `the json block isn't valid JSON: ${(e as Error).message}` : "the reply has no fenced json block" }; }
  const steps = (v as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return { ok: false, problem: 'the json block needs a "steps" list' };
  if (!steps.every((s) => typeof s === "string")) return { ok: false, problem: '"steps" must be a list of strings' };
  const kept = steps.map((s: string) => s.trim()).filter((s) => s.length > 0);
  const warnings: string[] = [];
  if (kept.length > LIMITS.PLAN_MAX_STEPS) {
    warnings.push(`the plan had ${kept.length} steps; kept the first ${LIMITS.PLAN_MAX_STEPS}`);
    kept.length = LIMITS.PLAN_MAX_STEPS;
  }
  return { ok: true, steps: kept, warnings };
}

/** The one re-ask after an unreadable reply. Not in planner.md, which has only the system message. */
export function plannerReask(problem: string): string {
  return `Your reply couldn't be read: ${problem}. Reply again with exactly one fenced \`json\` block { "steps": [...] } and nothing outside it.`;
}

export type PlanResult = { ok: true; steps: string[]; warnings: string[] } | { ok: false; reason: string };

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
    messages.push({ role: "assistant", content: reply });
    const p = parsePlannerReply(reply);
    if (p.ok) return p;
    problem = p.problem; hooks.onProblem?.(attempt, problem);
  }
  return { ok: false, reason: `the planner's reply couldn't be read after one re-ask: ${problem}` };
}
