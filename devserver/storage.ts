// Dev-server storage plugin (spec 13.2). Phase 1 ships only the guards: every
// endpoint validates the system id before any file operation (400 otherwise),
// every final path is resolved and must stay inside data/, and nothing Vite would
// treat as code is ever written. The endpoints themselves are filled in Phase 5.
import { isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const SYSTEM_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The only files a system folder may hold. */
export const SYSTEM_FILES = new Set(["manifest.json", "source.as", "module.wasm", "module.sha256"]);
/** Extensions Vite would treat as code or config. Never written. */
const CODE_EXT = /\.(c|m)?(j|t)sx?$|\.(vue|svelte|html?|css|json5|cjs|mjs)$|(^|[\\/])(vite|vitest|tsconfig|package)[^\\/]*$/i;

export interface StorageResult { status: number; body: unknown }

/** Resolve a path under `dataDir`, or null if it escapes data/ or names a code file. */
export function safeDataPath(dataDir: string, ...parts: string[]): string | null {
  const root = resolve(dataDir);
  const full = resolve(root, ...parts);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (CODE_EXT.test(full)) return null;
  return full;
}

/** Handle one storage request. Pure apart from (later) file operations under `dataDir`. */
export function handleStorage(dataDir: string, method: string, url: string): StorageResult {
  const path = url.split("?")[0];
  const m = /^\/systems(?:\/(.*))?$/.exec(path);
  if (!m) return { status: 404, body: { error: "unknown route" } };
  if (m[1] === undefined || m[1] === "") {
    if (method === "GET") return { status: 200, body: { systems: [] } };
    return { status: 405, body: { error: "method not allowed" } };
  }
  // Everything after /systems/ is <id> or <id>/<file>; validate the id before touching any file.
  let rest: string;
  try { rest = decodeURIComponent(m[1]); } catch { return { status: 400, body: { error: "bad id" } }; }
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const file = slash < 0 ? undefined : rest.slice(slash + 1);
  if (!SYSTEM_ID_RE.test(id)) return { status: 400, body: { error: "bad id" } };
  if (file !== undefined && !SYSTEM_FILES.has(file)) return { status: 400, body: { error: "bad file name" } };
  const target = safeDataPath(dataDir, "systems", id, ...(file ? [file] : []));
  if (!target) return { status: 400, body: { error: "bad path" } };
  return { status: 501, body: { error: "not yet: system storage arrives in Phase 5" } };
}

/** The Vite plugin: mounts the handler at /__data. */
export function storagePlugin(dataDir = resolve(process.cwd(), "data")): Plugin {
  return {
    name: "atw-storage",
    configureServer(server) {
      server.middlewares.use("/__data", (req: IncomingMessage, res: ServerResponse) => {
        const out = handleStorage(dataDir, req.method ?? "GET", req.url ?? "/");
        res.statusCode = out.status; res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.body));
      });
    },
  };
}
