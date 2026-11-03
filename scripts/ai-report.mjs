// AI usage report (spec 13.5): reads data/ai-usage.jsonl and data/ai-wishes.jsonl (src/ai/stats.ts)
// and prints, per wish, the steps the planner gave, the designer failures before each system
// loaded and the wish's token totals, then totals per role and model.
//
//   npm run ai-report                 every wish
//   npm run ai-report -- --last 5     the last 5 wishes
//   npm run ai-report -- --requests   also list every API request
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const lastN = args.includes("--last") ? Number(args[args.indexOf("--last") + 1]) : 0;
const showRequests = args.includes("--requests");
const dataDir = resolve(process.cwd(), "data");

function lines(file) {
  const p = resolve(dataDir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const pct = (t) => (t.input ? `${Math.round((t.cachedInput / t.input) * 100)}%` : "-");
const tok = (t) => `in ${n(t.input)} (cached ${n(t.cachedInput)}, ${pct(t)}) · out ${n(t.output)}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

let wishes = lines("ai-wishes.jsonl");
const usage = lines("ai-usage.jsonl");
if (lastN > 0) wishes = wishes.slice(-lastN);
const ids = new Set(wishes.map((w) => w.wishId));

if (!wishes.length) { console.log("No wishes logged yet (data/ai-wishes.jsonl is empty). Run a wish in the AI tab first."); process.exit(0); }

// Wishes logged before manual mode was removed carry mode "manual" and no real token counts.
const viaApi = (w) => w.mode !== "manual";

for (const w of wishes) {
  console.log(`\n${w.startedAt.replace("T", " ").slice(0, 19)}  "${w.wish}"  ${viaApi(w) ? "" : "[manual] "}${w.status} in ${secs(w.durationMs)}`);
  console.log(`  planner: ${w.stepsPlanned} step${w.stepsPlanned === 1 ? "" : "s"} after ${w.plannerAttempts} attempt${w.plannerAttempts === 1 ? "" : "s"}${viaApi(w) ? ` · ${tok(w.planner)}` : ""}`);
  for (const s of w.steps) {
    const result = s.systemId ? `loaded ${s.systemId}` : "not loaded";
    const fails = s.failures ? `${s.failures} failure${s.failures === 1 ? "" : "s"} (${s.failedAt.join(", ")})` : "no failures";
    console.log(`  step ${s.step}: ${result} after ${fails}${viaApi(w) ? ` · ${s.tokens.requests} req · ${tok(s.tokens)}` : ""}`);
    console.log(`          ${s.task}`);
  }
  if (viaApi(w)) console.log(`  wish total: ${w.tokens.requests} requests · ${tok(w.tokens)}`);
  if (showRequests) {
    for (const u of usage.filter((x) => x.wishId === w.wishId)) {
      console.log(`    ${u.timestamp.slice(11, 19)} ${u.role.padEnd(8)} ${u.step ? `step ${u.step}` : "      "} try ${u.attempt + 1}  ${u.model.padEnd(16)} ${u.ok ? "ok  " : "FAIL"} ${secs(u.ms).padStart(8)}  ${tok(u)}${u.error ? `  ${u.error}` : ""}`);
    }
  }
}

// Totals over the wishes shown.
const api = wishes.filter((w) => viaApi(w));
const steps = wishes.flatMap((w) => w.steps);
const loadedSteps = steps.filter((s) => s.systemId);
console.log(`\n=== ${wishes.length} wish${wishes.length === 1 ? "" : "es"} (${api.length} via API) ===`);
console.log(`statuses: ${Object.entries(wishes.reduce((m, w) => ({ ...m, [w.status]: (m[w.status] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`steps planned: ${n(wishes.reduce((a, w) => a + w.stepsPlanned, 0))} · loaded: ${loadedSteps.length} · avg per wish: ${(wishes.reduce((a, w) => a + w.stepsPlanned, 0) / wishes.length).toFixed(1)}`);
if (loadedSteps.length) console.log(`designer failures before a system loaded: avg ${(loadedSteps.reduce((a, s) => a + s.failures, 0) / loadedSteps.length).toFixed(2)}, max ${Math.max(...loadedSteps.map((s) => s.failures))}; first-try loads ${loadedSteps.filter((s) => !s.failures).length} of ${loadedSteps.length}`);
const stageCounts = steps.flatMap((s) => s.failedAt).reduce((m, st) => ({ ...m, [st]: (m[st] ?? 0) + 1 }), {});
if (Object.keys(stageCounts).length) console.log(`failures by stage: ${Object.entries(stageCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (api.length) {
  const sum = (key) => api.reduce((t, w) => ({ requests: t.requests + w[key].requests, input: t.input + w[key].input, cachedInput: t.cachedInput + w[key].cachedInput, output: t.output + w[key].output }), { requests: 0, input: 0, cachedInput: 0, output: 0 });
  const all = sum("tokens");
  console.log(`planner: ${sum("planner").requests} req · ${tok(sum("planner"))}`);
  console.log(`designer: ${sum("designer").requests} req · ${tok(sum("designer"))}`);
  console.log(`all: ${all.requests} req · ${tok(all)} · avg per wish: in ${n(Math.round(all.input / api.length))} · out ${n(Math.round(all.output / api.length))}`);
  const byModel = {};
  for (const u of usage.filter((x) => ids.has(x.wishId))) {
    const m = (byModel[u.model] ??= { requests: 0, failed: 0, input: 0, cachedInput: 0, output: 0, ms: 0 });
    m.requests++; if (!u.ok) m.failed++; m.input += u.input; m.cachedInput += u.cachedInput; m.output += u.output; m.ms += u.ms;
  }
  for (const [model, m] of Object.entries(byModel)) console.log(`${model}: ${m.requests} req (${m.failed} failed) · ${tok(m)} · avg ${secs(m.ms / m.requests)} per request`);
}
