// The Muse API provider (spec 13.5): the Chat Completions mapping, MuseProvider against a fake
// /__ai/chat, SwitchProvider, and the planner's re-ask and the designer's repairs sent through it.
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { loadBaseSystems } from "../src/systems/base";
import { runPlanner } from "../src/ai/planner";
import { runStep } from "../src/ai/designer";
import { LEAD_USER_TEXT, ManualProvider, MuseProvider, SwitchProvider, toChatCompletions, type ChatMessage } from "../src/ai/provider";
import { LIMITS } from "../src/tuning";

function liveHost() { const host = new Host(buildWorld()); loadBaseSystems(host); host.interactions.refresh(true); return host; }

type Sent = { url: string; body: Record<string, unknown> & { messages: { role: string; content: unknown }[] } };
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
const ok = (text: string, finishReason = "stop") => ({ body: { text, finishReason, usage: { input: 100, cachedInput: 80, output: 20 } } });
const sys: ChatMessage[] = [{ role: "system", content: "cached part", cache: true }, { role: "system", content: "\n\nrest part" }];
const png = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

describe("toChatCompletions", () => {
  test("keeps both system messages unchanged and adds the fixed leading user turn", () => {
    const out = toChatCompletions(sys);
    expect(out).toEqual([
      { role: "system", content: "cached part" },
      { role: "system", content: "\n\nrest part" },
      { role: "user", content: [{ type: "text", text: LEAD_USER_TEXT }] },
    ]);
  });
  test("moves images into the leading user turn as data URIs", () => {
    const out = toChatCompletions([sys[0], { ...sys[1], images: [png, png] }]);
    expect(out[1]).toEqual({ role: "system", content: "\n\nrest part" });
    expect(out[2].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "text", text: LEAD_USER_TEXT },
    ]);
  });
  test("maps replies and follow-ups one to one after the leading turn", () => {
    const out = toChatCompletions([...sys, { role: "assistant", content: "a1" }, { role: "user", content: "fix" }, { role: "assistant", content: "a2" }]);
    expect(out.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user", "assistant"]);
    expect(out.slice(3)).toEqual([{ role: "assistant", content: "a1" }, { role: "user", content: "fix" }, { role: "assistant", content: "a2" }]);
  });
});

describe("MuseProvider", () => {
  test("posts role, model, max_tokens, effort and the mapped messages; resolves with the text", async () => {
    const { f, sent } = fakeFetch([ok("hello")]);
    const p = new MuseProvider({ role: "planner", model: "muse-spark-1.3", maxTokens: 8000, reasoningEffort: "medium", fetch: f });
    const shown: string[] = []; const replies: unknown[] = [];
    p.onShow = (t) => shown.push(t); p.onReply = (t, u) => replies.push([t, u]);
    await expect(p.send(sys)).resolves.toBe("hello");
    expect(sent[0].url).toBe("/__ai/chat");
    expect(sent[0].body).toMatchObject({ role: "planner", model: "muse-spark-1.3", max_tokens: 8000, reasoning_effort: "medium" });
    expect(sent[0].body.messages).toEqual(toChatCompletions(sys));
    expect(shown).toEqual(["cached part\n\nrest part"]);
    expect(replies).toEqual([["hello", { input: 100, cachedInput: 80, output: 20 }]]);
    expect(p.lastUsage).toEqual({ input: 100, cachedInput: 80, output: 20 });
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
  });
  test("the planner's re-ask alternates user and assistant after the leading turn", async () => {
    const { f, sent } = fakeFetch([ok("not json at all"), ok('```json\n{ "steps": [] }\n```')]);
    const r = await runPlanner({ host: liveHost(), provider: new MuseProvider({ role: "planner", model: "m", maxTokens: 10, fetch: f }), wish: "a pond" });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(2);
    const second = sent[1].body.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    expect(second[3].content).toBe("not json at all");
    expect(second[4].content).toMatch(/^Your reply couldn't be read/);
    expect(JSON.stringify(second.slice(0, 3))).toBe(JSON.stringify(sent[0].body.messages));
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
      const prev = sent[a - 1].body.messages; const cur = sent[a].body.messages;
      expect(cur.length).toBe(prev.length + 2);
      expect(JSON.stringify(cur.slice(0, prev.length))).toBe(JSON.stringify(prev));
      expect(cur.at(-2)).toEqual({ role: "assistant", content: `unreadable ${a - 1}` });
      expect(cur.at(-1)!.role).toBe("user");
      expect(String(cur.at(-1)!.content)).toContain("**Reply format**");
    }
    const lead = sent[0].body.messages[2].content as { type: string }[];
    expect(lead.map((p) => p.type)).toEqual(["image_url", "text"]);
    expect(sent[0].body.messages.slice(0, 2).every((m) => typeof m.content === "string")).toBe(true);
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
