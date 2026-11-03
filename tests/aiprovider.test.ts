// The Muse API provider (spec 13.5): the Responses input mapping, MuseProvider against a fake
// /__ai/chat, SwitchProvider, and the planner's re-ask and the designer's repairs sent through it.
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { loadBaseSystems } from "../src/systems/base";
import { runPlanner } from "../src/ai/planner";
import { LOOKUPS_USED_UP, runStep } from "../src/ai/designer";
import { CATALOG_LEGEND } from "../src/ai/blocks";
import { DESIGNER_TOOLS } from "../src/ai/tools";
import { LEAD_USER_TEXT, ManualProvider, MuseProvider, SwitchProvider, replyMessage, toResponsesInput, usageText, type ChatMessage } from "../src/ai/provider";
import { LIMITS } from "../src/tuning";

function liveHost() { const host = new Host(buildWorld()); loadBaseSystems(host); host.interactions.refresh(true); return host; }

type Item = { role?: string; type?: string; content?: unknown; [k: string]: unknown };
type Sent = { url: string; body: Record<string, unknown> & { input: Item[] } };
/** A fake fetch that answers /__ai/chat with each reply in turn and records every request. */
function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 500, body: { error: "no reply left" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, sent };
}
/** The output items the proxy passes back for a reply: encrypted reasoning, then the message. */
const outputFor = (text: string) => [
  { type: "reasoning", id: `rs_${text.length}`, summary: [], encrypted_content: `enc(${text})` },
  { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] },
];
const ok = (text: string, finishReason = "stop") => ({ body: { text, finishReason, output: outputFor(text), usage: { input: 100, cachedInput: 80, output: 20 } } });
/** A reply that only calls tools: reasoning, a commentary message, then the calls. The proxy's text leaves commentary out. */
const callsFor = (calls: [string, unknown][], round = 0) => [
  { type: "reasoning", id: `rs_t${round}`, summary: [], encrypted_content: `enc(round ${round})` },
  { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "looking it up." }] },
  ...calls.map(([name, args], i) => ({ type: "function_call", id: `fc_${round}_${i}`, call_id: `call_${round}_${i}`, name, arguments: JSON.stringify(args), status: "completed" })),
];
const toolReply = (calls: [string, unknown][], round = 0) => ({ body: { text: "", finishReason: "stop", output: callsFor(calls, round), usage: { input: 100, cachedInput: 80, output: 20 } } });
const neverPipeline = { checkSystem: () => { throw new Error("never"); }, loadChecked: () => { throw new Error("never"); } };
const sys: ChatMessage[] = [{ role: "system", content: "cached part", cache: true }, { role: "system", content: "\n\nrest part" }];
const png = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

describe("toResponsesInput", () => {
  test("keeps both system messages unchanged as developer items and adds the fixed leading user turn", () => {
    expect(toResponsesInput(sys)).toEqual([
      { role: "developer", content: "cached part" },
      { role: "developer", content: "\n\nrest part" },
      { role: "user", content: [{ type: "input_text", text: LEAD_USER_TEXT }] },
    ]);
  });
  test("moves images into the leading user turn as data URLs", () => {
    const out = toResponsesInput([sys[0], { ...sys[1], images: [png, png] }]);
    expect(out[1]).toEqual({ role: "developer", content: "\n\nrest part" });
    expect(out[2]).toEqual({ role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "input_text", text: LEAD_USER_TEXT },
    ] });
  });
  test("replays a reply's output items unchanged; a reply without them becomes an output_text message", () => {
    const out = toResponsesInput([...sys, { role: "assistant", content: "a1", output: outputFor("a1") }, { role: "user", content: "fix" }, { role: "assistant", content: "a2" }]);
    expect(out.slice(3)).toEqual([
      ...outputFor("a1"),
      { role: "user", content: "fix" },
      { role: "assistant", content: [{ type: "output_text", text: "a2" }] },
    ]);
  });
  test("replyMessage keeps the output items of the provider's last reply, when it has them", () => {
    expect(replyMessage({ send: async () => "", lastOutput: outputFor("x") }, "x")).toEqual({ role: "assistant", content: "x", output: outputFor("x") });
    expect(replyMessage(new ManualProvider(), "x")).toEqual({ role: "assistant", content: "x" });
    expect(replyMessage({ send: async () => "", lastOutput: [] }, "x")).toEqual({ role: "assistant", content: "x" });
  });
  test("usageText shows reasoning tokens when the API reports them", () => {
    expect(usageText({ input: 12345, cachedInput: 11000, output: 2100 })).toBe("in 12,345 (cached 11,000) · out 2,100 tokens");
    expect(usageText({ input: 12345, cachedInput: 11000, output: 2100, reasoning: 1500 })).toBe("in 12,345 (cached 11,000) · out 2,100 (reasoning 1,500) tokens");
  });
});

describe("MuseProvider", () => {
  test("posts role, model, max_tokens, effort and the mapped input; resolves with the text and keeps the output", async () => {
    const { f, sent } = fakeFetch([ok("hello")]);
    const p = new MuseProvider({ role: "planner", model: "muse-spark-1.3", maxTokens: 8000, reasoningEffort: "medium", fetch: f });
    const shown: string[] = []; const replies: unknown[] = [];
    p.onShow = (t) => shown.push(t); p.onReply = (t, u) => replies.push([t, u]);
    await expect(p.send(sys)).resolves.toBe("hello");
    expect(sent[0].url).toBe("/__ai/chat");
    expect(sent[0].body).toMatchObject({ role: "planner", model: "muse-spark-1.3", max_tokens: 8000, reasoning_effort: "medium" });
    expect(sent[0].body.input).toEqual(toResponsesInput(sys));
    expect(sent[0].body.messages).toBeUndefined();
    expect(p.lastOutput).toEqual(outputFor("hello"));
    expect(shown).toEqual(["cached part\n\nrest part"]);
    expect(replies).toEqual([["hello", { input: 100, cachedInput: 80, output: 20 }]]);
    expect(p.lastUsage).toEqual({ input: 100, cachedInput: 80, output: 20 });
    expect(p.lastCall).toMatchObject({ model: "muse-spark-1.3", ok: true, finishReason: "stop" });
  });
  test("rejects on a non-2xx answer with the server's message", async () => {
    const { f } = fakeFetch([{ status: 503, body: { error: "MUSE_API_KEY isn't set; add it to .env.local and restart npm run dev" } }]);
    const p = new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: f });
    await expect(p.send(sys)).rejects.toThrow("the designer request failed (503): MUSE_API_KEY isn't set");
  });
  test("rejects a reply cut off at max_tokens", async () => {
    const { f } = fakeFetch([ok("half a repl", "length")]);
    const p = new MuseProvider({ role: "designer", model: "muse-wonder-1.0", maxTokens: 32000, fetch: f });
    let replied = false; p.onReply = () => { replied = true; };
    await expect(p.send(sys)).rejects.toThrow("the designer's reply was cut off at max_tokens (32000)");
    expect(replied).toBe(false);
    expect(p.lastOutput).toBeNull();
    // The cut-off call still cost tokens, so it is reported for the usage log.
    expect(p.lastCall).toMatchObject({ model: "muse-wonder-1.0", ok: false, finishReason: "length", usage: { input: 100, cachedInput: 80, output: 20 } });
  });
  test("the planner's re-ask replays the first reply's reasoning and message, then the user turn", async () => {
    const { f, sent } = fakeFetch([ok("not json at all"), ok('```json\n{ "steps": [] }\n```')]);
    const r = await runPlanner({ host: liveHost(), provider: new MuseProvider({ role: "planner", model: "m", maxTokens: 10, fetch: f }), wish: "a pond" });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(2);
    const second = sent[1].body.input;
    expect(second.map((m) => m.role ?? m.type)).toEqual(["developer", "developer", "user", "reasoning", "assistant", "user"]);
    expect(second.slice(3, 5)).toEqual(outputFor("not json at all"));
    expect(second[5].content).toMatch(/^Your reply couldn't be read/);
    expect(JSON.stringify(second.slice(0, 3))).toBe(JSON.stringify(sent[0].body.input));
  });
  test("designer repairs: the same images every attempt, and each request extends the last byte for byte", async () => {
    const replies = Array.from({ length: LIMITS.repairsPerStep + 1 }, (_, i) => ok(`unreadable ${i}`));
    const { f, sent } = fakeFetch(replies);
    let drawn = 0;
    const r = await runStep({
      host: liveHost(), task: "a task", provider: new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: f }),
      pipeline: { checkSystem: () => { throw new Error("never"); }, loadChecked: () => { throw new Error("never"); } },
      mapImages: async () => { drawn++; return [png]; },
    });
    expect(r.ok).toBe(false);
    expect(drawn).toBe(1);
    expect(sent).toHaveLength(LIMITS.repairsPerStep + 1);
    for (let a = 1; a < sent.length; a++) {
      const prev = sent[a - 1].body.input; const cur = sent[a].body.input;
      expect(cur.length).toBe(prev.length + 3);
      expect(JSON.stringify(cur.slice(0, prev.length))).toBe(JSON.stringify(prev));
      expect(cur.slice(-3, -1)).toEqual(outputFor(`unreadable ${a - 1}`));
      expect(cur.at(-1)!.role).toBe("user");
      expect(String(cur.at(-1)!.content)).toContain("**Reply format**");
    }
    const lead = sent[0].body.input[2].content as { type: string }[];
    expect(lead.map((p) => p.type)).toEqual(["input_image", "input_text"]);
    expect(sent[0].body.input.slice(0, 2).every((m) => m.role === "developer" && typeof m.content === "string")).toBe(true);
  });
});

describe("tool calls", () => {
  test("toResponsesInput maps a tool message to a function_call_output for its call", () => {
    const out = toResponsesInput([...sys, { role: "assistant", content: "", output: callsFor([["catalog_tags", {}]]) }, { role: "tool", content: "12 tags", callId: "call_0_0" }]);
    expect(out.at(-1)).toEqual({ type: "function_call_output", call_id: "call_0_0", output: "12 tags" });
    expect(out.slice(3, -1)).toEqual(callsFor([["catalog_tags", {}]]));
  });
  test("MuseProvider sends the tools, reads the calls, and takes a reply with calls but no text", async () => {
    const { f, sent } = fakeFetch([toolReply([["catalog_get", { ids: ["firepit"] }], ["catalog_tags", { match: "fish" }]]), { body: { text: "", finishReason: "stop", output: [], usage: null } }]);
    const p = new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: f });
    expect(p.supportsTools).toBe(true);
    await expect(p.send(sys, { tools: DESIGNER_TOOLS })).resolves.toBe("");
    expect(sent[0].body.tools).toEqual(DESIGNER_TOOLS);
    expect(p.lastToolCalls).toEqual([
      { callId: "call_0_0", name: "catalog_get", arguments: '{"ids":["firepit"]}' },
      { callId: "call_0_1", name: "catalog_tags", arguments: '{"match":"fish"}' },
    ]);
    // No text and no calls is still an empty reply.
    await expect(p.send(sys)).rejects.toThrow("the designer's reply was empty");
    expect(sent[1].body.tools).toBeUndefined();
    expect(p.lastToolCalls).toEqual([]);
  });
  test("SwitchProvider says whether the picked provider takes tools", () => {
    const muse = new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: fakeFetch([]).f });
    let useApi = false;
    const sw = new SwitchProvider(() => (useApi ? muse : new ManualProvider()));
    expect(sw.supportsTools).toBe(false);
    useApi = true;
    expect(sw.supportsTools).toBe(true);
  });
  test("the designer looks things up, gets the results, and its final reply is the attempt", async () => {
    const { f, sent } = fakeFetch([
      toolReply([["catalog_search", { tags: ["fishing"] }], ["catalog_get", { ids: ["firepit"] }]], 1),
      toolReply([["catalog_get", { ids: ["camp_fire"] }]], 2),
      ok("not three blocks"),
      ...Array.from({ length: LIMITS.repairsPerStep }, (_, i) => ok(`unreadable ${i}`)),
    ]);
    const rounds: [number, number, string[]][] = []; const replies: [number, string][] = [];
    const r = await runStep({
      host: liveHost(), task: "a campfire", tags: ["fishing", "fire"], provider: new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: f }),
      pipeline: neverPipeline,
      hooks: { onToolRound: (a, n, calls) => rounds.push([a, n, calls.map((c) => c.name)]), onReply: (a, t) => replies.push([a, t]) },
    });
    expect(r.ok).toBe(false);
    expect(rounds).toEqual([[0, 1, ["catalog_search", "catalog_get"]], [0, 2, ["catalog_get"]]]);
    expect(replies[0]).toEqual([0, "not three blocks"]);
    // Every request carries the tools; the prompt explains them and lists no entries.
    for (const s of sent.slice(0, 3)) expect(s.body.tools).toEqual(DESIGNER_TOOLS);
    const prompt = sent[0].body.input.slice(0, 2).map((m) => String(m.content)).join("");
    expect(prompt).toContain("## Sprite catalog\n\nThe catalog isn't listed here: look up what you need with the catalog tools");
    expect(prompt).toContain("Tags the planner picked for this task: fishing, fire");
    expect(prompt).toContain("Check every entity type you spawn, give or target with `entity_types`");
    expect(prompt).not.toContain(CATALOG_LEGEND);
    // Round 2's request: the first reply replayed, then one result per call, in order.
    const second = sent[1].body.input;
    expect(second.slice(3, 7)).toEqual(callsFor([["catalog_search", { tags: ["fishing"] }], ["catalog_get", { ids: ["firepit"] }]], 1));
    expect(second.slice(7).map((m) => [m.type, m.call_id])).toEqual([["function_call_output", "call_1_0"], ["function_call_output", "call_1_1"]]);
    expect(String(second[7].output)).toMatch(/^\d+ entr(y|ies) in \d+ groups? match/);
    expect(String(second[8].output)).toContain("firepit — ");
    const third = sent[2].body.input;
    expect(JSON.stringify(third.slice(0, second.length))).toBe(JSON.stringify(second));
    expect(String(third.at(-1)!.output)).toMatch(/^camp_fire: not in the catalog/m);
    // The unreadable final reply gets the repair message, after the replayed reply.
    expect(String(sent[3].body.input.at(-1)!.content)).toContain("**Reply format**");
  });
  test("past the lookup rounds calls get LOOKUPS_USED_UP, and an attempt still calling tools fails", async () => {
    const max = LIMITS.LOOKUP_ROUNDS_PER_STEP + LIMITS.LOOKUP_GRACE_ROUNDS + 1;
    const replies = [...Array.from({ length: max }, (_, i) => toolReply([["catalog_tags", {}]], i)), ...Array.from({ length: LIMITS.repairsPerStep }, (_, i) => ok(`unreadable ${i}`))];
    const { f, sent } = fakeFetch(replies);
    let limited = -1;
    const r = await runStep({
      host: liveHost(), task: "t", provider: new MuseProvider({ role: "designer", model: "m", maxTokens: 10, fetch: f }), pipeline: neverPipeline,
      hooks: { onLookupLimit: (a) => { limited = a; } },
    });
    expect(r.ok).toBe(false);
    expect(limited).toBe(0);
    const outputs = (i: number) => sent[i].body.input.filter((m) => m.type === "function_call_output").map((m) => String(m.output));
    expect(outputs(LIMITS.LOOKUP_ROUNDS_PER_STEP).at(-1)).toMatch(/^\d+ tags/);
    expect(outputs(LIMITS.LOOKUP_ROUNDS_PER_STEP + 1).at(-1)).toBe(LOOKUPS_USED_UP);
    // The request after the last tool round is the repair for attempt 0.
    const repair = sent[max].body.input.at(-1)!;
    expect(repair.role).toBe("user");
    expect(String(repair.content)).toContain("**Lookups**");
    expect(sent).toHaveLength(max + LIMITS.repairsPerStep);
  });
  test("a provider without tools gets the old catalog listing and no tools", async () => {
    const manual = new ManualProvider();
    const shownAll: string[] = [];
    manual.onShow = (t) => { shownAll.push(t); queueMicrotask(() => manual.deliver("unreadable")); };
    await runStep({ host: liveHost(), task: "a campfire", tags: ["firepit"], provider: manual, pipeline: neverPipeline });
    const shown = shownAll[0];
    expect(shown).toContain(CATALOG_LEGEND);
    expect(shown).toContain("These are the sprites with the tags picked for this task");
  });
});

describe("SwitchProvider", () => {
  test("uses whichever provider pick() returns at send time", async () => {
    const manual = new ManualProvider();
    const { f } = fakeFetch([ok("from api")]);
    const muse = new MuseProvider({ role: "planner", model: "m", maxTokens: 10, fetch: f });
    let useApi = false;
    const sw = new SwitchProvider(() => (useApi ? muse : manual));
    const first = sw.send(sys);
    expect(manual.waiting).toBe(true);
    manual.deliver("from manual");
    await expect(first).resolves.toBe("from manual");
    expect(sw.lastUsage).toBeNull();
    useApi = true;
    await expect(sw.send(sys)).resolves.toBe("from api");
    expect(sw.lastUsage).toEqual({ input: 100, cachedInput: 80, output: 20 });
  });
});
