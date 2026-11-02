import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleStorage, safeDataPath } from "../devserver/storage";
import { handleAiRequest } from "../devserver/ai";

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }) as string[];
}

describe("dev server storage guards (13.2)", () => {
  test("rejects ids like ../vite.config and a/b with 400 and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "atw-"));
    const data = join(root, "data");
    try {
      const before = listAll(root);
      for (const method of ["PUT", "POST", "DELETE", "GET"]) {
        for (const id of ["../vite.config", "a/b", "..%2Fvite.config", "a%2Fb", "Bad", "1abc", "", "a".repeat(41), "%E0%A4%A"]) {
          const url = `/systems/${id}${id === "" ? "x/" : ""}`;
          const res = handleStorage(data, method, url);
          expect(res.status, `${method} ${url}`).toBe(400);
        }
        expect(handleStorage(data, method, "/systems/ok_id/../../vite.config.ts").status).toBe(400);
        expect(handleStorage(data, method, "/systems/ok_id/module.ts").status).toBe(400);
      }
      expect(listAll(root)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a valid id passes the guards and the files round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "atw-"));
    const data = join(root, "data");
    const enc = (s: string) => new TextEncoder().encode(s);
    const text = (r: { body: unknown }) => new TextDecoder().decode(r.body as Uint8Array);
    try {
      expect(handleStorage(data, "GET", "/systems.json")).toMatchObject({ status: 200, body: "[]" });
      expect(handleStorage(data, "PUT", "/systems/campfire/manifest.json", enc(`{"id":"campfire"}`)).status).toBe(200);
      expect(handleStorage(data, "PUT", "/systems/campfire/manifest.json", enc(`not json`)).status).toBe(400);
      expect(handleStorage(data, "PUT", "/systems/campfire/module.wasm", new Uint8Array([0, 97, 115, 109])).status).toBe(200);
      expect(text(handleStorage(data, "GET", "/systems/campfire/manifest.json"))).toBe(`{"id":"campfire"}`);
      expect(handleStorage(data, "GET", "/systems/campfire/source.as").status).toBe(404);
      expect(handleStorage(data, "PUT", "/systems.json", enc(`[{"id":"../x"}]`)).status).toBe(400);
      expect(handleStorage(data, "PUT", "/systems.json", enc(`[{"id":"campfire","order":0}]`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/world.json", enc(`{"v":1}`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/ai-log.jsonl", enc(`{"role":"user"}`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/ai-log.jsonl", enc(`{"role":"model"}`)).status).toBe(200);
      expect(text(handleStorage(data, "GET", "/ai-log.jsonl"))).toBe(`{"role":"user"}\n{"role":"model"}\n`);
      expect(handleStorage(data, "PUT", "/main.ts", enc("x")).status).toBe(404);
      expect(handleStorage(data, "DELETE", "/systems/campfire").status).toBe(200);
      expect(listAll(data).sort()).toEqual(["ai-log.jsonl", "systems", "systems.json", "world.json"]);
      expect(handleStorage(data, "POST", "/fresh").status).toBe(200);
      expect(listAll(data)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("paths must stay inside data/ and never be code files", () => {
    expect(safeDataPath("/x/data", "systems", "a", "manifest.json")).toBe(resolve("/x/data", "systems", "a", "manifest.json")); // C:\x\data\... on Windows
    expect(safeDataPath("/x/data", "..", "vite.config.ts")).toBeNull();
    expect(safeDataPath("/x/data", "systems", "..", "..", "src", "main.ts")).toBeNull();
    expect(safeDataPath("/x/data", "systems", "a", "evil.js")).toBeNull();
    expect(safeDataPath("/x/data", "/etc/passwd")).toBeNull();
    expect(safeDataPath("/x/data")).toBeNull();
  });
});

describe("dev server Muse API proxy (13.5)", () => {
  const KEY = "sk-test-SECRET-1234567890";
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const good = { role: "designer", model: "muse-wonder-1.0", max_tokens: 32000, reasoning_effort: "high", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
  const completion = { choices: [{ message: { role: "assistant", content: "the reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 1000 } } };
  function fake(answers: { status: number; body: unknown; headers?: Record<string, string> }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answers.shift() ?? { status: 500, body: { error: { message: "no answer left" } } };
      return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: a.headers });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const deps = (f: typeof fetch, key: string | undefined = KEY) => ({ key, baseUrl: "https://api.example.test/v1", fetch: f, sleep: async () => {} });

  test("status says whether a key is set", async () => {
    const { f } = fake([]);
    expect(await handleAiRequest("GET", "/status", undefined, deps(f))).toEqual({ status: 200, body: { configured: true } });
    expect(await handleAiRequest("GET", "/status", undefined, deps(f, ""))).toEqual({ status: 200, body: { configured: false } });
  });
  test("503 without a key, and nothing is sent", async () => {
    const { f, calls } = fake([]);
    const r = await handleAiRequest("POST", "/chat", enc(good), { fetch: f, sleep: async () => {} });
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toBe("MUSE_API_KEY isn't set; add it to .env.local and restart npm run dev");
    expect(calls).toHaveLength(0);
  });
  test("400 on a bad role, an empty model or empty messages", async () => {
    const { f, calls } = fake([]);
    for (const b of [{ ...good, role: "player" }, { ...good, model: "" }, { ...good, messages: [] }, { ...good, messages: "hi" }, { ...good, max_tokens: 0 }]) {
      expect((await handleAiRequest("POST", "/chat", enc(b), deps(f))).status).toBe(400);
    }
    expect((await handleAiRequest("POST", "/chat", new TextEncoder().encode("{nope"), deps(f))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test("forwards to chat/completions with the Bearer header and returns { text, finishReason, usage }", async () => {
    const { f, calls } = fake([{ status: 200, body: completion }]);
    const r = await handleAiRequest("POST", "/chat", enc(good), deps(f));
    expect(r).toEqual({ status: 200, body: { text: "the reply", finishReason: "stop", usage: { input: 1200, cachedInput: 1000, output: 300 } } });
    expect(calls[0].url).toBe("https://api.example.test/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toMatchObject({ model: "muse-wonder-1.0", max_completion_tokens: 32000, reasoning_effort: "high", messages: good.messages, stream: false });
    expect(sent.role).toBeUndefined();
  });
  test("retries a 429 once, honouring retry-after, then succeeds", async () => {
    const { f, calls } = fake([{ status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2" } }, { status: 200, body: completion }]);
    const waits: number[] = [];
    const r = await handleAiRequest("POST", "/chat", enc(good), { ...deps(f), sleep: async (ms: number) => { waits.push(ms); } });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });
  test("gives up after two retries; other API errors pass back with the API's message", async () => {
    const busy = { status: 503, body: { error: { message: "overloaded" } } };
    const a = fake([busy, busy, busy, busy]);
    expect(await handleAiRequest("POST", "/chat", enc(good), deps(a.f))).toEqual({ status: 503, body: { error: "overloaded", status: 503 } });
    expect(a.calls).toHaveLength(3);
    const b = fake([{ status: 400, body: { error: { message: "reasoning_effort none is not supported", type: "invalid_request_error" } } }]);
    expect(await handleAiRequest("POST", "/chat", enc(good), deps(b.f))).toEqual({ status: 400, body: { error: "reasoning_effort none is not supported", status: 400 } });
    expect(b.calls).toHaveLength(1);
  });
  test("the key never appears in any response body", async () => {
    const echo = { status: 401, body: { error: { message: `invalid key ${KEY}` } } };
    const { f } = fake([echo, { status: 200, body: completion }]);
    const bodies = [
      await handleAiRequest("GET", "/status", undefined, deps(f)),
      await handleAiRequest("POST", "/chat", enc(good), deps(f)),
      await handleAiRequest("POST", "/chat", enc(good), deps(f)),
      await handleAiRequest("POST", "/chat", enc({ ...good, role: "x" }), deps(f)),
      await handleAiRequest("POST", "/chat", enc(good), deps((async () => { throw new Error(`socket closed for ${KEY}`); }) as unknown as typeof fetch)),
    ].map((r) => JSON.stringify(r));
    for (const b of bodies) expect(b).not.toContain(KEY);
  });
});
