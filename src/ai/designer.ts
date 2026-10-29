import templateRaw from "./prompts/designer.md?raw";
import pillarsRaw from "./pillars.md?raw";
import apiRaw from "../engine/api.d.ts?raw";
import movementRaw from "../systems/base/movement.ts?raw";
import carryRaw from "../systems/base/carry.ts?raw";
import campfireRaw from "../../fixtures/campfire.ts?raw";
import { CATALOG } from "../engine/catalog";
import type { Engine } from "../engine/engine";
import type { SystemDef } from "../engine/api";
import type { Report, StageEvent } from "../pipeline/types";
import { checkSystem, loadChecked } from "../pipeline/client";
import type { AiProvider, ChatMessage } from "./provider";

export interface UpdateMeta { title: string; summary: string; changes: string[]; journal: string }
export interface JournalEntry extends UpdateMeta { systemId: string; timestamp: string }
export interface AiLogEntry { kind: "sent" | "reply"; text: string; chars: number; tokensEst: number; timestamp: string }

const template = templateRaw as unknown as string;
export const estTokens = (chars: number) => Math.ceil(chars / 4);

/** Extract one markdown section ("# System message" up to the next "# " heading). */
export function templateSection(name: string): string {
  const start = template.indexOf("# " + name);
  if (start < 0) throw new Error(`designer template is missing its "${name}" section`);
  const rest = template.slice(start + name.length + 2);
  const next = rest.indexOf("\n# ");
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function fill(text: string, slots: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(slots)) out = out.split("{{" + k + "}}").join(v);
  return out;
}

/** One compact catalog line per sprite: id — desc · layer · WxH tiles · materials · anims: a, b */
export function catalogText(): string {
  return CATALOG.sprites.map((s) => {
    const pxW = s.w ?? s.frameW ?? 16, pxH = s.h ?? s.frameH ?? 16;
    const tiles = `${Math.max(1, Math.ceil(pxW / 16))}x${Math.max(1, Math.ceil(pxH / 16))}`;
    const anims = s.anims ? Object.keys(s.anims).join(", ") : "-";
    const mats = (s as unknown as { materials?: string[] }).materials?.join(", ") ?? "-";
    return `${s.id} — ${s.desc ?? ""} · ${s.layer ?? "terrain"} · ${tiles} tiles · ${mats} · anims: ${anims}`;
  }).join("\n");
}

export function examplesText(): string {
  const block = (name: string, src: string) => "```ts\n// " + name + "\n" + (src as unknown as string).trim() + "\n```";
  return [block("src/systems/base/movement.ts", movementRaw), block("src/systems/base/carry.ts", carryRaw), block("fixtures/campfire.ts", campfireRaw)].join("\n\n");
}

/** {{WORLD}}: base and accepted AI systems described the same way, plus entity counts. */
export function buildWorldText(eng: Engine, defs: SystemDef[]): string {
  const parts: string[] = [];
  for (const def of defs) {
    const lines: string[] = [];
    lines.push(`## System: ${def.id}`);
    lines.push(`why: ${def.why}`);
    lines.push(`buildsOn: [${def.buildsOn.join(", ")}]`);
    lines.push("contract:");
    lines.push("  claims:");
    for (const c of def.contract.claims) lines.push(`    - ${c}`);
    lines.push("  emits:");
    for (const [name, e] of Object.entries(def.contract.emits)) lines.push(`    - ${name}: payload ${e.payload}, when ${e.when}`);
    lines.push("  hooks:");
    for (const h of def.contract.hooks) lines.push(`    - ${h}`);
    lines.push("components:");
    const comps = Object.entries(def.components);
    if (!comps.length) lines.push("  (none)");
    for (const [n, shape] of comps) lines.push(`  - ${n}: ${shape}`);
    lines.push("events emitted (with one real example payload each, recorded the first time the event fired):");
    const emits = Object.keys(def.contract.emits);
    if (!emits.length) lines.push("  (none)");
    for (const name of emits) {
      const ex = eng.eventExamples.get(name);
      lines.push(`  - ${name}: ${ex ? JSON.stringify(ex) : "(no example recorded yet)"}`);
    }
    lines.push("entity types added:");
    const ents = Object.entries(def.entities);
    if (!ents.length) lines.push("  (none; it uses existing types)");
    for (const [n, e] of ents) lines.push(`  - ${n}: sprite ${e.sprite}, tags [${e.tags.join(", ")}]`);
    parts.push(lines.join("\n"));
  }
  const counts = new Map<string, number>();
  for (const r of eng.entities.values()) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  parts.push("## Entity counts by type\n" + [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `- ${t}: ${n}`).join("\n"));
  return parts.join("\n\n");
}

/** Build the full designer prompt for a task. Throws if any slot is left unfilled. */
export function buildPrompt(task: string, worldText: string): string {
  const out = fill(templateSection("System message"), {
    PILLARS: (pillarsRaw as unknown as string).trim(),
    API: (apiRaw as unknown as string).trim(),
    EXAMPLES: examplesText(),
    WORLD: worldText,
    CATALOG: catalogText(),
    ART_BOARD: "(See the attached art board image.)",
    TASK: task,
  });
  if (out.includes("{{")) throw new Error("prompt still contains an unfilled {{slot}}");
  return out;
}

export function buildRepairMessage(stage: string, report: Report): string {
  const slim: Record<string, unknown> = { ...report, shots: report.shots.map((s) => ({ name: s.name })), source: undefined };
  return fill(templateSection("Repair message"), { STAGE: stage, REPORT: JSON.stringify(slim, null, 1) });
}

export function buildVisualMessage(meta: UpdateMeta, report: Report): string {
  return fill(templateSection("Visual check message"), {
    TITLE: meta.title, SUMMARY: meta.summary,
    SHOTS: report.shots.map((s) => s.name).join(", ") || "(none)",
  });
}

/** Parse an AI reply: a ```ts block and a ```json block. Returns clear problems instead of throwing. */
export function parseReply(reply: string): { source?: string; meta?: UpdateMeta; problems: string[] } {
  const problems: string[] = [];
  const tsMatch = reply.match(/```ts\s*\n([\s\S]*?)```/);
  const jsonMatch = reply.match(/```json\s*\n([\s\S]*?)```/);
  if (!tsMatch) problems.push("the reply has no ```ts block with the system module");
  if (!jsonMatch) problems.push("the reply has no ```json block with { title, summary, changes, journal }");
  let meta: UpdateMeta | undefined;
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Partial<UpdateMeta>;
      const missing = (["title", "summary", "changes", "journal"] as const).filter((k) => parsed[k] === undefined || parsed[k] === "" || (k === "changes" && !Array.isArray(parsed[k])));
      if (missing.length) problems.push("the ```json block is missing field(s): " + missing.join(", "));
      else meta = parsed as UpdateMeta;
    } catch (e) { problems.push("the ```json block is not valid JSON: " + (e as Error).message); }
  }
  return { source: tsMatch?.[1]?.trim(), meta, problems };
}

export function parseVisualReply(reply: string): { ok: boolean; source?: string } {
  try { const p = JSON.parse(reply.trim()) as { ok?: boolean }; if (p.ok === true) return { ok: true }; } catch { /* not the ok reply */ }
  const tsMatch = reply.match(/```ts\s*\n([\s\S]*?)```/);
  return { ok: false, source: tsMatch?.[1]?.trim() };
}

export interface DesignerDeps {
  provider: AiProvider;
  getWorldText: () => string;
  onAttemptStart: (index: number) => void;
  /** Route the pipeline client's stage events to this attempt's row while it is checked (null restores the fixture row). */
  routeStage: (handler: ((ev: StageEvent) => void) | null) => void;
  onStage: (index: number, ev: StageEvent) => void;
  onShots: (index: number, report: Report) => void;
  onLog: (entry: AiLogEntry) => void;
  onStatus: (text: string) => void;
  appendJournal: (entry: JournalEntry) => void | Promise<void>;
}

const MAX_REPAIRS = 3;

/** The designer loop: prompt -> reply -> check -> repair/visual -> (only then) load. */
export class Designer {
  constructor(private deps: DesignerDeps) {}

  async runUpdate(task: string): Promise<{ status: "loaded" | "stopped"; systemId?: string }> {
    const d = this.deps;
    const prompt = buildPrompt(task, d.getWorldText());
    const messages: ChatMessage[] = [{ role: "system", content: prompt }];
    let repairs = 0;
    let attempt = -1;
    let meta: UpdateMeta | null = null;
    let report: Report | null = null;
    let source: string | null = null;
    let awaitingVisual = false;
    let visualUsed = false;

    const sendAndLog = async (): Promise<string> => {
      const whole = messages.map((m) => m.content).join("\n");
      d.onLog({ kind: "sent", text: messages[messages.length - 1].content, chars: whole.length, tokensEst: estTokens(whole.length), timestamp: new Date().toISOString() });
      const reply = await d.provider.send(messages);
      d.onLog({ kind: "reply", text: reply, chars: reply.length, tokensEst: estTokens(reply.length), timestamp: new Date().toISOString() });
      return reply;
    };

    for (;;) {
      const reply = await sendAndLog();

      if (awaitingVisual) {
        const v = parseVisualReply(reply);
        if (v.ok && report && meta) {
          attempt = attempt; // load the already-passed report
          d.onStage(attempt, { stage: "Load", status: "start" });
          const loaded = await loadChecked(report);
          d.onStage(attempt, { stage: "Load", status: loaded.ok ? "pass" : "fail" });
          if (!loaded.ok) { d.onStatus("Load was refused: " + loaded.errors.map((e) => e.message).join("; ")); return { status: "stopped" }; }
          await d.appendJournal({ ...meta, systemId: loaded.systemId ?? report.systemId ?? "", timestamp: new Date().toISOString() });
          d.onStatus(`Loaded "${loaded.systemId}" — the transition played and the journal was updated.`);
          return { status: "loaded", systemId: loaded.systemId ?? undefined };
        }
        if (!v.source) { d.onStatus("Visual reply was neither { \"ok\": true } nor a corrected ```ts module. Paste one of those; nothing was loaded."); continue; }
        // Corrected module: brand-new unchecked code. Full pipeline again as a new attempt.
        source = v.source; awaitingVisual = false; visualUsed = true;
      } else {
        const parsed = parseReply(reply);
        if (parsed.problems.length || !parsed.source || !parsed.meta) {
          d.onStatus("Reply problem: " + parsed.problems.join("; ") + ". Fix the reply in the box and submit again — nothing was checked or loaded.");
          continue;
        }
        source = parsed.source; meta = parsed.meta;
      }

      // Run the full check for this attempt. The live game is not touched.
      attempt++;
      d.onAttemptStart(attempt);
      d.routeStage((ev) => d.onStage(attempt, ev));
      report = await checkSystem(source);
      d.routeStage(null);
      if (report.shots.length) d.onShots(attempt, report);

      if (!report.ok) {
        if (repairs >= MAX_REPAIRS) { d.onStatus(`Stopped after ${MAX_REPAIRS} repairs. Last failure at ${report.stage}. The game is untouched.`); return { status: "stopped" }; }
        repairs++;
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: buildRepairMessage(report.stage, report) });
        d.onStatus(`Attempt ${attempt + 1} failed at ${report.stage} (repair ${repairs}/${MAX_REPAIRS}). The repair message is in the message box at the top of the AI tab — use its Copy repair message button, then paste the AI's reply below.`);
        continue;
      }

      if (visualUsed) {
        // The corrected module passed everything itself: show its shots, then load it. No second visual round.
        d.onStage(attempt, { stage: "Load", status: "start" });
        const loaded = await loadChecked(report);
        d.onStage(attempt, { stage: "Load", status: loaded.ok ? "pass" : "fail" });
        if (!loaded.ok) { d.onStatus("Load was refused: " + loaded.errors.map((e) => e.message).join("; ")); return { status: "stopped" }; }
        if (meta) await d.appendJournal({ ...meta, systemId: loaded.systemId ?? "", timestamp: new Date().toISOString() });
        d.onStatus(`Corrected module passed and was loaded as "${loaded.systemId}".`);
        return { status: "loaded", systemId: loaded.systemId ?? undefined };
      }

      // Passed: visual check next. Still nothing loaded.
      messages.push({ role: "assistant", content: reply });
      messages.push({ role: "user", content: buildVisualMessage(meta!, report) });
      awaitingVisual = true;
      d.onStatus(`Attempt ${attempt + 1} passed every stage. Look at the shots, copy the visual check message, and paste either { "ok": true } or a corrected module. Nothing is loaded yet.`);
    }
  }
}
