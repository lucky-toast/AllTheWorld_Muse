// Dev-server storage (spec 13.2), mounted at /__data. Files live under data/:
//
//   data/systems/<id>/manifest.json, source.as, module.wasm, module.sha256
//   data/systems.json   [{ id, order, buildsOn, replacedBy, timestamp }]
//   data/world.json     the saved world
//   data/journal.json   journal entries
//   data/ai-log.jsonl   one JSON line per AI message
//   data/ai-usage.jsonl one JSON line per API request (src/ai/stats.ts)
//   data/ai-wishes.jsonl one JSON line per wish: steps, failures, token totals
//
// Routes:
//   GET|PUT          /systems.json, /world.json, /journal.json
//   GET|PUT          /systems/<id>/<file>        (the four files above)
//   DELETE           /systems/<id>               (the folder)
//   GET, POST        /ai-log.jsonl, /ai-usage.jsonl, /ai-wishes.jsonl   (POST appends one line)
//   POST             /world.json                 (same as PUT, for sendBeacon on unload)
//   POST             /fresh                      (Start fresh: deletes all of the above but the
//                                                 usage and wish stats, kept to compare test rounds)
//
// Every route with an id validates it against ^[a-z][a-z0-9_]{0,39}$ before any file
// operation and answers 400 otherwise. Every final path is resolved and must stay inside
// data/, and nothing Vite would treat as code is ever written. JSON bodies must parse.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const SYSTEM_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The only files a system folder may hold. */
export const SYSTEM_FILES = new Set(["manifest.json", "source.as", "module.wasm", "module.sha256"]);
/** The top-level data files. */
const DATA_FILES = new Set(["systems.json", "world.json", "journal.json", "ai-log.jsonl", "ai-usage.jsonl", "ai-wishes.jsonl"]);
/** Append-only JSON-lines files. */
const LINE_FILES = new Set(["ai-log.jsonl", "ai-usage.jsonl", "ai-wishes.jsonl"]);
/** Files Start fresh keeps. */
const KEPT_BY_FRESH = new Set(["ai-usage.jsonl", "ai-wishes.jsonl"]);
/** Extensions Vite would treat as code or config. Never written. */
const CODE_EXT = /\.(c|m)?(j|t)sx?$|\.(vue|svelte|html?|css|json5|cjs|mjs)$|(^|[\\/])(vite|vitest|tsconfig|package)[^\\/]*$/i;
/** Largest request body (16 MB). */
export const MAX_BODY = 16 * 1024 * 1024;

export interface StorageResult { status: number; body: unknown; type?: string }

/** Resolve a path under `dataDir`, or null if it escapes data/ or names a code file. */
export function safeDataPath(dataDir: string, ...parts: string[]): string | null {
  const root = resolve(dataDir);
  const full = resolve(root, ...parts);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (CODE_EXT.test(full)) return null;
  return full;
}

const json = (status: number, body: unknown): StorageResult => ({ status, body });
const bad = (error: string) => json(400, { error });
const isJsonFile = (f: string) => f.endsWith(".json");
const contentType = (f: string) => (f.endsWith(".json") ? "application/json" : f.endsWith(".wasm") ? "application/wasm" : "text/plain; charset=utf-8");

function readFile(path: string, file: string): StorageResult {
  if (!existsSync(path)) return file === "systems.json" ? { status: 200, body: "[]", type: "application/json" } : json(404, { error: "not found" });
  return { status: 200, body: new Uint8Array(readFileSync(path)), type: contentType(file) };
}
function writeFile(path: string, file: string, body: Uint8Array | undefined): StorageResult {
  if (!body) return bad("missing body");
  if (body.length > MAX_BODY) return json(413, { error: "body too large" });
  if (isJsonFile(file)) { try { JSON.parse(new TextDecoder().decode(body)); } catch { return bad("the body isn't JSON"); } }
  if (file === "systems.json") {
    const rows = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && SYSTEM_ID_RE.test(String((r as { id?: unknown }).id)))) return bad("systems.json is a list of { id, ... } with valid ids");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return json(200, { ok: true });
}

/** Handle one storage request. Every file operation is under `dataDir`. */
export function handleStorage(dataDir: string, method: string, url: string, body?: Uint8Array): StorageResult {
  const path = url.split("?")[0];
  // ---- top-level files ----
  const top = /^\/([a-z-]+\.(?:json|jsonl))$/.exec(path);
  if (top) {
    const file = top[1];
    if (!DATA_FILES.has(file)) return json(404, { error: "unknown route" });
    const target = safeDataPath(dataDir, file);
    if (!target) return bad("bad path");
    if (method === "GET") return LINE_FILES.has(file) && !existsSync(target) ? { status: 200, body: "", type: "text/plain" } : readFile(target, file);
    if (LINE_FILES.has(file)) {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      if (!body) return bad("missing body");
      const line = new TextDecoder().decode(body).replace(/\r?\n/g, " ");
      try { JSON.parse(line); } catch { return bad("a log line is one JSON value"); }
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, line + "\n");
      return json(200, { ok: true });
    }
    if (method === "PUT" || (method === "POST" && file === "world.json")) return writeFile(target, file, body);
    return json(405, { error: "method not allowed" });
  }
  if (path === "/fresh") {
    if (method !== "POST") return json(405, { error: "method not allowed" });
    for (const f of ["systems", ...[...DATA_FILES].filter((d) => !KEPT_BY_FRESH.has(d))]) { const t = safeDataPath(dataDir, f); if (t) rmSync(t, { recursive: true, force: true }); }
    return json(200, { ok: true });
  }
  // ---- system folders ----
  const m = /^\/systems\/(.*)$/.exec(path);
  if (!m) return json(404, { error: "unknown route" });
  // Everything after /systems/ is <id> or <id>/<file>; validate the id before touching any file.
  let rest: string;
  try { rest = decodeURIComponent(m[1]); } catch { return bad("bad id"); }
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const file = slash < 0 ? undefined : rest.slice(slash + 1);
  if (!SYSTEM_ID_RE.test(id)) return bad("bad id");
  if (file !== undefined && !SYSTEM_FILES.has(file)) return bad("bad file name");
  const target = safeDataPath(dataDir, "systems", id, ...(file ? [file] : []));
  if (!target) return bad("bad path");
  if (file === undefined) {
    if (method !== "DELETE") return json(405, { error: "method not allowed" });
    rmSync(target, { recursive: true, force: true });
    return json(200, { ok: true });
  }
  if (method === "GET") return readFile(target, file);
  if (method === "PUT") return writeFile(target, file, body);
  return json(405, { error: "method not allowed" });
}

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { rej(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => res(n ? new Uint8Array(Buffer.concat(chunks)) : undefined));
    req.on("error", rej);
  });
}

/** The Vite plugin: mounts the handler at /__data. */
export function storagePlugin(dataDir = resolve(process.cwd(), "data")): Plugin {
  return {
    name: "atw-storage",
    configureServer(server) {
      server.middlewares.use("/__data", (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          let out: StorageResult;
          try {
            const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
            out = handleStorage(dataDir, req.method ?? "GET", req.url ?? "/", body);
          } catch (e) { out = json(500, { error: e instanceof Error ? e.message : String(e) }); }
          res.statusCode = out.status;
          res.setHeader("content-type", out.type ?? "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(out.body instanceof Uint8Array || typeof out.body === "string" ? out.body : JSON.stringify(out.body));
        })();
      });
    },
  };
}
