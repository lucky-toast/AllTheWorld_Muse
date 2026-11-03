// Dev-server Muse API proxy (spec 13.5), mounted at /__ai. The browser never sees the key: it
// posts Responses API input items here, and this file adds the key and forwards them to the
// Meta Muse API (Model API) at /v1/responses. Every Muse-specific detail (URL, field names,
// usage parsing) lives here and in toResponsesInput (src/ai/provider.ts), so swapping providers
// touches two places.
//
// Calls are stateless: store is false and the reasoning comes back encrypted
// (include: reasoning.encrypted_content). The browser keeps each reply's `output` items and
// replays them, unchanged, in the next request's input, so reasoning carries across turns
// without anything being stored at Muse.
//
// Routes:
//   GET   /status   { configured: boolean }
//   POST  /chat     { role, model, max_tokens, reasoning_effort?, input, tools? }
//                   -> { text, finishReason, output, usage: { input, cachedInput, output, reasoning } }
//                   or { error, status } with the API's message
//   finishReason is "stop" for a completed response, "length" when max_output_tokens ran out,
//   "content_filter" when the filter stopped it, or the API's own incomplete reason. A reply that
//   calls tools has function_call items in `output` (and often empty text); the browser runs them.
//
// The key is MUSE_API_KEY, read with Vite's loadEnv so a git-ignored .env.local works. It has no
// VITE_ prefix, so it can never reach the client bundle. No response or log line includes it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";

export const DEFAULT_MUSE_BASE_URL = "https://api.meta.ai/v1";
/** Largest request body (32 MB). Muse takes inline images up to 50 MB each; our maps are far smaller. */
export const MAX_BODY = 32 * 1024 * 1024;
/** How long one call may take before it's abandoned. The designer reasons long. */
export const TIMEOUT_MS = { planner: 5 * 60_000, designer: 10 * 60_000 } as const;
/** Retries after a 429 or a retryable 5xx (not 504: Muse says the same request will time out again). */
export const MAX_RETRIES = 2;
/** Longest wait honoured from a retry-after header. */
const MAX_RETRY_AFTER_MS = 60_000;
const ROLES = new Set(["planner", "designer"]);
/** Roles an input message item may have. Items without a role (reasoning, function_call, ...) need a type. */
const INPUT_ROLES = new Set(["developer", "system", "user", "assistant"]);
/** Upstream status / incomplete reason -> the finishReason the browser reads. */
const INCOMPLETE_REASONS: Record<string, string> = { max_output_tokens: "length", content_filter: "content_filter" };
export const NO_KEY_ERROR = "MUSE_API_KEY isn't set; add it to .env.local and restart npm run dev";

export interface AiDeps {
  key?: string;
  baseUrl?: string;
  fetch: typeof fetch;
  /** Waits between retries; tests pass a no-op. */
  sleep?(ms: number): Promise<void>;
}
export interface AiResult { status: number; body: unknown }
export interface AiUsage { input: number; cachedInput: number; output: number; reasoning: number }

const json = (status: number, body: unknown): AiResult => ({ status, body });
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Never let the key out, even inside an echoed error message. */
const scrub = (text: string, key?: string) => (key ? text.split(key).join("[key]") : text);

/** The wait before retry `n` (0-based): retry-after when given, else 1 s, 2 s, ... with jitter. */
export function retryDelay(n: number, retryAfter: string | null): number {
  const s = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  const when = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
  return 1000 * 2 ** n + Math.floor(Math.random() * 500);
}
const retryable = (status: number) => status === 429 || status === 500 || status === 502 || status === 503;

/** Read Muse's Responses usage into { input, cachedInput, output, reasoning } (output includes reasoning). */
export function normalizeUsage(u: unknown): AiUsage {
  const o = (u ?? {}) as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown }; output_tokens_details?: { reasoning_tokens?: unknown } };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(o.input_tokens), cachedInput: n(o.input_tokens_details?.cached_tokens), output: n(o.output_tokens), reasoning: n(o.output_tokens_details?.reasoning_tokens) };
}

/**
 * The reply text: every output_text part of every message item in `output`, joined. Messages
 * marked phase "commentary" are left out: the model sends those as narration before a tool call
 * ("checking now."), and they are not part of the answer. They stay in `output` for replay.
 */
export function outputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output as { type?: unknown; phase?: unknown; content?: unknown }[]) {
    if (item?.type !== "message" || item.phase === "commentary" || !Array.isArray(item.content)) continue;
    for (const part of item.content as { type?: unknown; text?: unknown }[]) if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("");
}

/** The finishReason for a response's status: "stop", "length", "content_filter", or the API's reason. */
export function finishReason(status: unknown, incomplete: unknown): string | null {
  if (status === "completed") return "stop";
  if (status !== "incomplete") return typeof status === "string" ? status : null;
  const reason = (incomplete as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" ? INCOMPLETE_REASONS[reason] ?? reason : "incomplete";
}

/** The API's own error message, from its { error: { message } } envelope or the raw text. */
function apiError(status: number, raw: string): string {
  try {
    const v = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof v.error === "string" ? v.error : v.error?.message ?? v.message;
    if (typeof m === "string" && m.trim()) return m;
  } catch { /* not JSON */ }
  return raw.trim().slice(0, 500) || `the Muse API answered ${status} with no message`;
}

function validate(v: unknown): string | null {
  if (!v || typeof v !== "object") return "the body must be a JSON object";
  const b = v as Record<string, unknown>;
  if (typeof b.role !== "string" || !ROLES.has(b.role)) return 'role must be "planner" or "designer"';
  if (typeof b.model !== "string" || !b.model.trim()) return "model must be a non-empty string";
  if (!Number.isInteger(b.max_tokens) || (b.max_tokens as number) < 1) return "max_tokens must be a positive whole number";
  if (b.reasoning_effort !== undefined && typeof b.reasoning_effort !== "string") return "reasoning_effort must be a string";
  if (b.tools !== undefined && (!Array.isArray(b.tools) || !b.tools.every((t) => t && typeof t === "object" && typeof (t as { type?: unknown }).type === "string"))) return "tools must be a list of tool objects";
  if (!Array.isArray(b.input) || !b.input.length) return "input must be a non-empty list";
  for (const it of b.input as unknown[]) {
    if (!it || typeof it !== "object" || Array.isArray(it)) return "each input item must be an object";
    const { role: r, content: c, type: t } = it as { role?: unknown; content?: unknown; type?: unknown };
    if (r === undefined) {
      if (typeof t !== "string" || !t) return "each input item needs a role or a type";
      continue;
    }
    if (typeof r !== "string" || !INPUT_ROLES.has(r)) return "each input message needs a role of developer, system, user or assistant";
    if (typeof c !== "string" && !Array.isArray(c)) return "each input message's content must be a string or a list of parts";
  }
  return null;
}

/** Handle one /__ai request. Pure apart from deps.fetch and deps.sleep. */
export async function handleAiRequest(method: string, url: string, body: Uint8Array | undefined, deps: AiDeps): Promise<AiResult> {
  const path = url.split("?")[0];
  const key = deps.key?.trim() || undefined;
  if (path === "/status") {
    if (method !== "GET") return json(405, { error: "method not allowed" });
    return json(200, { configured: !!key });
  }
  if (path !== "/chat") return json(404, { error: "unknown route" });
  if (method !== "POST") return json(405, { error: "method not allowed" });
  if (!key) return json(503, { error: NO_KEY_ERROR, status: 503 });
  if (!body?.length) return json(400, { error: "missing body", status: 400 });
  if (body.length > MAX_BODY) return json(413, { error: "body too large", status: 413 });
  let req: { role: "planner" | "designer"; model: string; max_tokens: number; reasoning_effort?: string; input: unknown[]; tools?: unknown[] };
  try { req = JSON.parse(new TextDecoder().decode(body)); } catch { return json(400, { error: "the body isn't JSON", status: 400 }); }
  const problem = validate(req);
  if (problem) return json(400, { error: problem, status: 400 });

  // Responses API, stateless: store false, and the reasoning comes back encrypted so the browser
  // can replay it. max_output_tokens covers reasoning and the visible reply together. Caching is
  // automatic on a stable prefix; prompt_cache_key only routes a role's calls to the same cache.
  const upstream = JSON.stringify({
    model: req.model,
    input: req.input,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_output_tokens: req.max_tokens,
    ...(req.reasoning_effort ? { reasoning: { effort: req.reasoning_effort } } : {}),
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: `atw-${req.role}`,
    stream: false,
  });
  const target = `${(deps.baseUrl || DEFAULT_MUSE_BASE_URL).replace(/\/+$/, "")}/responses`;
  const sleep = deps.sleep ?? sleepMs;
  const timeout = TIMEOUT_MS[req.role];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: upstream,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      const msg = timedOut ? `the Muse API didn't answer within ${timeout / 60_000} minutes` : `the Muse API couldn't be reached: ${e instanceof Error ? e.message : String(e)}`;
      return json(timedOut ? 504 : 502, { error: scrub(msg, key), status: timedOut ? 504 : 502 });
    }
    const raw = await res.text();
    if (!res.ok) {
      if (retryable(res.status) && attempt < MAX_RETRIES) { await sleep(retryDelay(attempt, res.headers.get("retry-after"))); continue; }
      let msg = apiError(res.status, raw);
      if (res.status === 504) msg = `${msg} (the Muse API timed out on a long non-streaming request; try a lower reasoning effort or max_tokens)`;
      return json(res.status, { error: scrub(msg, key), status: res.status });
    }
    let data: { status?: unknown; incomplete_details?: unknown; error?: { message?: unknown } | null; output?: unknown; usage?: unknown };
    try { data = JSON.parse(raw); } catch { return json(502, { error: "the Muse API's answer isn't JSON", status: 502 }); }
    if (data.status === "failed") {
      const m = typeof data.error?.message === "string" && data.error.message.trim() ? data.error.message : "the response failed with no message";
      return json(502, { error: scrub(`the Muse API's response failed: ${m}`, key), status: 502 });
    }
    if (!Array.isArray(data.output)) return json(502, { error: "the Muse API's answer has no output", status: 502 });
    return json(200, {
      text: outputText(data.output),
      finishReason: finishReason(data.status, data.incomplete_details),
      output: data.output,
      usage: normalizeUsage(data.usage),
    });
  }
}

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { rej(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => res(n ? new Uint8Array(Buffer.concat(chunks)) : undefined));
    req.on("error", rej);
  });
}

/** The Vite plugin: mounts the handler at /__ai, with the key from .env.local or the environment. */
export function aiPlugin(): Plugin {
  return {
    name: "atw-ai",
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), "");
      const deps: AiDeps = { key: env.MUSE_API_KEY, baseUrl: env.MUSE_BASE_URL || DEFAULT_MUSE_BASE_URL, fetch: globalThis.fetch.bind(globalThis) };
      server.middlewares.use("/__ai", (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          let out: AiResult;
          try {
            const body = req.method === "POST" ? await readBody(req) : undefined;
            out = await handleAiRequest(req.method ?? "GET", req.url ?? "/", body, deps);
          } catch (e) { out = json(500, { error: scrub(e instanceof Error ? e.message : String(e), deps.key), status: 500 }); }
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(out.body));
        })();
      });
    },
  };
}
