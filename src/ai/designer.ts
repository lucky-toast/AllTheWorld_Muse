// The designer (spec 13.3): builds its prompt from src/ai/prompts/designer.md, parses its
// three-block reply, and runs one planner step through the pipeline with up to 3 repairs.
import templateRaw from "./prompts/designer.md?raw";
import pillarsRaw from "./pillars.md?raw";
import apiRaw from "../sdk/index.ts?raw";
import type { Host } from "../engine/host";
import { reportText } from "../pipeline/report";
import type { Report, StageEvent } from "../pipeline/types";
import { LIMITS } from "../tuning";
import { entityCounts, stepCatalogText, systemSlots, tagsInText, worldSprites } from "./blocks";
import { examplesText } from "./examples";
import { outgoingText, replyMessage, type AiProvider, type ChatImage, type ChatMessage } from "./provider";
import { buildSplit, fill, normalizeEol, promptMessages, section, type BuiltPrompt } from "./template";

export const DESIGNER_TEMPLATE = normalizeEol(templateRaw);
export const PILLARS = normalizeEol(pillarsRaw).trim();
/** The maps go as images (src/ai/mapimage.ts): attached by hand with Download maps, or sent with the message in API mode. */
export const MAP_IMAGE_NOTE = "(See the attached map image.)";

/** The slots that only change when a system loads, or never. */
function fixedSlots(host: Host): Record<string, string> {
  return {
    PILLARS,
    API: normalizeEol(apiRaw).trim(),
    MAP_IMAGE: MAP_IMAGE_NOTE,
    SYSTEM_EXAMPLES: examplesText(),
    ...systemSlots(host),
  };
}

/**
 * The designer's system message for one task, split for caching. `tags` are the catalog tags or
 * entry ids the planner picked for the step; with none, the tags the task names are used.
 */
export function buildPrompt(host: Host, task: string, tags: readonly string[] = []): BuiltPrompt {
  return buildSplit(section(DESIGNER_TEMPLATE, "System message"), {
    ...fixedSlots(host),
    ENTITY_COUNTS: entityCounts(host.eng),
    CATALOG: stepCatalogText(tags.length ? tags : tagsInText(task), worldSprites(host.eng)),
    TASK: task,
  });
}

/** The repair message: the stage that failed and the report as readable text. */
export function buildRepairMessage(stage: string, report: string): string {
  return fill(section(DESIGNER_TEMPLATE, "Repair message"), { STAGE: stage, REPORT: report });
}

export interface UpdateMeta { title: string; summary: string; changes: string[]; journal: string }
export interface DesignerReply { manifestJson: string; source: string; meta: UpdateMeta }

/** Every fenced block in a reply, with its language tag. */
export function fencedBlocks(reply: string): { lang: string; body: string }[] {
  return [...normalizeEol(reply).matchAll(/^[ \t]*```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
}

/** Parse a designer reply: exactly three fenced blocks, json manifest, ts module, json meta. */
export function parseDesignerReply(reply: string): { ok: true; value: DesignerReply } | { ok: false; problems: string[] } {
  const blocks = fencedBlocks(reply);
  const problems: string[] = [];
  if (blocks.length !== 3) problems.push(`the reply has ${blocks.length} fenced block${blocks.length === 1 ? "" : "s"}; it needs exactly three: json manifest, ts module, json { title, summary, changes, journal }`);
  const [a, b, c] = blocks;
  if (a && a.lang !== "json") problems.push(`the first block must be \`\`\`json (the manifest), not \`\`\`${a.lang || "(no language)"}`);
  if (b && b.lang !== "ts") problems.push(`the second block must be \`\`\`ts (the module), not \`\`\`${b.lang || "(no language)"}`);
  if (c && c.lang !== "json") problems.push(`the third block must be \`\`\`json ({ title, summary, changes, journal }), not \`\`\`${c.lang || "(no language)"}`);
  if (a?.lang === "json") { try { JSON.parse(a.body); } catch (e) { problems.push(`the manifest block isn't valid JSON: ${(e as Error).message}`); } }
  if (b && !b.body.trim()) problems.push("the module block is empty");
  let meta: UpdateMeta | null = null;
  if (c?.lang === "json") {
    try {
      const v = JSON.parse(c.body) as Record<string, unknown>;
      const bad: string[] = [];
      for (const k of ["title", "summary", "journal"]) if (typeof v?.[k] !== "string" || !(v[k] as string).trim()) bad.push(k);
      if (!Array.isArray(v?.changes) || !v.changes.every((x) => typeof x === "string")) bad.push("changes");
      if (bad.length) problems.push(`the third block needs ${bad.map((k) => (k === "changes" ? "changes (a list of strings)" : `${k} (a string)`)).join(", ")}`);
      else meta = { title: v.title as string, summary: v.summary as string, changes: [...(v.changes as string[])], journal: v.journal as string };
    } catch (e) { problems.push(`the third block isn't valid JSON: ${(e as Error).message}`); }
  }
  if (problems.length || !meta) return { ok: false, problems: problems.length ? problems : ["the reply couldn't be read"] };
  return { ok: true, value: { manifestJson: a.body.trim(), source: b.body.replace(/\s+$/, "") + "\n", meta } };
}

/** What the designer needs from the pipeline. */
export interface DesignerPipeline {
  checkSystem(manifestJson: string, source: string): Promise<Report>;
  loadChecked(report: Report): Promise<Report>;
}

/** Hooks the AI tab and the log use. All optional. */
export interface DesignerHooks {
  /** A message is about to be sent (attempt 0 is the first, 1 to 3 are repairs). */
  onAttempt?(attempt: number, text: string): void;
  /** A reply came back for this attempt. */
  onReply?(attempt: number, text: string): void;
  /** The reply couldn't be parsed. */
  onParseFailed?(attempt: number, problems: string[]): void;
  /** The pipeline ran on this attempt and gave this report (failed or loaded). */
  onReport?(attempt: number, report: Report): void;
  onStage?(attempt: number, e: StageEvent): void;
}

export type StepResult =
  | { ok: true; systemId: string; meta: UpdateMeta; report: Report; attempts: number }
  | { ok: false; reason: string; attempts: number };

/**
 * Run one planner step: send the prompt, then parse, check and load the reply. A reply that
 * doesn't parse, or fails any stage, gets the repair message; after LIMITS.repairsPerStep repairs
 * the step is dropped.
 */
export async function runStep(opts: {
  host: Host; provider: AiProvider; pipeline: DesignerPipeline; task: string; hooks?: DesignerHooks;
  /** Catalog tags or entry ids the planner picked for this step. */
  tags?: readonly string[];
  /** Lets the caller route the pipeline's stage events to this attempt while it runs. */
  routeStages?(fn: ((e: StageEvent) => void) | null): void;
  /**
   * The map images, drawn once per step before the first attempt (the world changes between
   * steps). They go with the second system message, so every repair sends the same images.
   */
  mapImages?(): Promise<ChatImage[]>;
}): Promise<StepResult> {
  const { host, provider, pipeline, task, hooks = {} } = opts;
  const messages: ChatMessage[] = promptMessages(buildPrompt(host, task, opts.tags));
  const images = opts.mapImages ? await opts.mapImages() : [];
  if (images.length) messages[1].images = images;
  let lastReason = "";
  for (let attempt = 0; attempt <= LIMITS.repairsPerStep; attempt++) {
    hooks.onAttempt?.(attempt, outgoingText(messages));
    const reply = await provider.send(messages.map((m) => ({ ...m })));
    hooks.onReply?.(attempt, reply);
    messages.push(replyMessage(provider, reply));
    const parsed = parseDesignerReply(reply);
    let stage: string; let report: string;
    if (!parsed.ok) {
      hooks.onParseFailed?.(attempt, parsed.problems);
      stage = "Reply format"; report = parsed.problems.map((p) => `- ${p}`).join("\n");
    } else {
      opts.routeStages?.((e) => hooks.onStage?.(attempt, e));
      let r: Report;
      try {
        r = await pipeline.checkSystem(parsed.value.manifestJson, parsed.value.source);
        if (r.ok) r = await pipeline.loadChecked(r);
      } finally { opts.routeStages?.(null); }
      hooks.onReport?.(attempt, r);
      if (r.ok && r.systemId) return { ok: true, systemId: r.systemId, meta: parsed.value.meta, report: r, attempts: attempt + 1 };
      stage = r.stage; report = reportText(r);
    }
    lastReason = `failed at ${stage}`;
    if (attempt < LIMITS.repairsPerStep) messages.push({ role: "user", content: buildRepairMessage(stage, report) });
  }
  return { ok: false, reason: `${lastReason} after ${LIMITS.repairsPerStep} repairs`, attempts: LIMITS.repairsPerStep + 1 };
}
