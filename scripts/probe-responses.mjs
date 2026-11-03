#!/usr/bin/env node
// One-off probe of the Muse Responses API (POST /v1/responses), run by hand before relying on it:
//   node scripts/probe-responses.mjs [model]
// It confirms the shapes the dev-server proxy and src/ai/provider.ts assume, with a real key:
//   1. a flat function tool is called, and what the function_call item looks like
//   2. stateless replay (store: false + encrypted reasoning) of the output items, verbatim,
//      followed by a function_call_output, is accepted and answered
//   3. if verbatim replay is refused, whether replay with item ids stripped works instead
//   4. two developer items, then a user item with an input_image data URL, are accepted
//   5. the usage and status fields
// The key comes from MUSE_API_KEY (environment or .env.local) and is never printed. Everything
// it learns is printed and written to probe-responses.out.json (git-ignored data, no key in it),
// so the output can be pasted back as is. It costs a few cheap calls at low reasoning effort.
import { readFileSync, writeFileSync } from "node:fs";

function envKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env.local */ }
  return "";
}

const KEY = envKey("MUSE_API_KEY");
const BASE = (envKey("MUSE_BASE_URL") || "https://api.meta.ai/v1").replace(/\/+$/, "");
const MODEL = process.argv[2] || "muse-spark-1.3";
if (!KEY) { console.error("MUSE_API_KEY isn't set (environment or .env.local)"); process.exit(1); }

const scrub = (s) => String(s).split(KEY).join("[key]");
/** A copy with long strings (encrypted reasoning, images) cut short, for printing. */
const brief = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 80 ? `${x.slice(0, 40)}… (${x.length} chars)` : x)));
const results = { model: MODEL, base: BASE, steps: [] };
function record(name, data) {
  results.steps.push({ name, ...data });
  console.log(`\n=== ${name} ===\n${JSON.stringify(brief(data), null, 2)}`);
}

async function post(body) {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, json, raw: json ? undefined : scrub(raw.slice(0, 1000)) };
}

const common = { model: MODEL, store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "low" }, max_output_tokens: 4000, prompt_cache_key: "atw-probe" };
const tools = [{
  type: "function", name: "get_temperature", description: "Get the current temperature for a city.",
  parameters: { type: "object", properties: { city: { type: "string", description: "City name, such as Paris." } }, required: ["city"], additionalProperties: false },
}];
const shape = (r) => ({
  httpStatus: r.status, status: r.json?.status, incomplete_details: r.json?.incomplete_details, error: r.json?.error ?? r.raw,
  usage: r.json?.usage, outputTypes: r.json?.output?.map((o) => o.type + (o.role ? `/${o.role}` : "") + (o.phase ? `/${o.phase}` : "")), output: r.json?.output,
});
const textOf = (out) => (out ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
const stripIds = (items) => items.map(({ id: _id, ...rest }) => rest);

try {
  // 1. A tool call.
  const input = [
    { role: "developer", content: "You answer questions about the weather. Always use the tool for temperatures." },
    { role: "user", content: "What's the temperature in Paris right now?" },
  ];
  const first = await post({ ...common, input, tools });
  record("1. tool call", shape(first));
  const out = first.json?.output ?? [];
  const call = out.find((o) => o.type === "function_call");
  if (!call) throw new Error("no function_call item came back; see step 1");

  // 2. Verbatim replay of every output item, then the tool result.
  const result = { type: "function_call_output", call_id: call.call_id, output: "18°C" };
  const second = await post({ ...common, input: [...input, ...out, result], tools });
  record("2. replay verbatim + function_call_output", { ...shape(second), text: textOf(second.json?.output) });

  // 3. If refused, the same with ids stripped from the replayed items.
  if (second.status !== 200) {
    const third = await post({ ...common, input: [...input, ...stripIds(out), result], tools });
    record("3. replay with ids stripped", { ...shape(third), text: textOf(third.json?.output) });
  }

  // 4. Two developer items (our cache split), then a user item with an image and text.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const fourth = await post({
    ...common,
    input: [
      { role: "developer", content: "Part one of the instructions." },
      { role: "developer", content: "\n\nPart two: reply with one word." },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }, { type: "input_text", text: "Is this image a single pixel? Answer yes or no." }] },
    ],
  });
  record("4. developer x2 + input_image", { ...shape(fourth), text: textOf(fourth.json?.output) });

  // 5. A cut-off reply: how status and incomplete_details read when max_output_tokens runs out.
  const fifth = await post({ ...common, max_output_tokens: 16, input: [{ role: "user", content: "Count from 1 to 200, one number per line." }] });
  record("5. cut off at max_output_tokens", shape(fifth));
} catch (e) {
  record("error", { message: scrub(e instanceof Error ? e.message : String(e)) });
}

writeFileSync("probe-responses.out.json", scrub(JSON.stringify(results, null, 2)));
console.log("\nWrote probe-responses.out.json");
