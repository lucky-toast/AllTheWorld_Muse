// @ts-nocheck
import { defineConfig } from "vite";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export function isValidSystemId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** Resolve a file inside data/systems/<id>/, or return null if the id or path escapes. */
export function resolveDataPath(dataDir, id, file) {
  if (!isValidSystemId(id)) return null;
  if (typeof file !== "string" || !file || file.includes("/") || file.includes("\\") || file.includes("\0")) return null;
  const dataRoot = resolve(dataDir);
  const systemDir = resolve(dataRoot, "systems", id);
  const target = resolve(systemDir, file);
  if (target !== systemDir && !target.startsWith(systemDir + sep)) return null;
  if (!target.startsWith(dataRoot + sep)) return null;
  return target;
}

/** Files a system folder may hold. Nothing Vite would treat as code, ever. */
const SYSTEM_FILES = ["manifest.json", "source.as", "module.wasm", "module.sha256"];

function resolveDataFile(dataDir, name) {
  // Only the fixed top-level data files; the result must stay inside data/.
  if (!["systems.json", "world.json", "journal.json", "ai-log.jsonl"].includes(name)) return null;
  const dataRoot = resolve(dataDir);
  const target = resolve(dataRoot, name);
  if (!target.startsWith(dataRoot + sep)) return null;
  return target;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

function readSystemsIndex(root) {
  const file = resolveDataFile(root, "systems.json");
  try { const parsed = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function writeSystemsIndex(root, systems) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolveDataFile(root, "systems.json"), JSON.stringify(systems, null, 2));
}

/** Storage endpoints (spec 13.2). Every route validates the id before any file operation. */
export function systemsHandler(dataDir) {
  const root = resolve(dataDir);
  return async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      let path = url.pathname;
      if (path.startsWith("/__systems")) path = path.slice("/__systems".length) || "/";
      const queryId = url.searchParams.get("id");
      const invalidId = () => sendJson(res, 400, { error: "invalid system id" });

      if (req.method === "GET" && (path === "/" || path === "/systems.json")) {
        if (queryId !== null && !isValidSystemId(queryId)) return invalidId();
        return sendJson(res, 200, { systems: readSystemsIndex(root) });
      }

      if (path === "/system") {
        if (req.method === "GET") {
          const file = url.searchParams.get("file") ?? "";
          if (!isValidSystemId(queryId)) return invalidId();
          if (!SYSTEM_FILES.includes(file)) return sendJson(res, 400, { error: "invalid file" });
          const target = resolveDataPath(root, queryId, file);
          if (target === null) return invalidId();
          if (!existsSync(target)) return sendJson(res, 404, { error: "not found" });
          if (file === "module.wasm") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/octet-stream");
            return res.end(readFileSync(target));
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "text/plain");
          return res.end(readFileSync(target, "utf8"));
        }
        if (req.method === "POST") {
          const raw = await readBody(req);
          let body = {};
          if (raw) { try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "invalid JSON" }); } }
          const id = body.id ?? queryId;
          if (!isValidSystemId(id)) return invalidId();
          if (typeof body.manifestJson !== "string" || typeof body.source !== "string" || typeof body.wasmB64 !== "string") {
            return sendJson(res, 400, { error: "manifestJson, source and wasmB64 are required" });
          }
          const wasm = Buffer.from(body.wasmB64, "base64");
          const sha256 = createHash("sha256").update(wasm).digest("hex");
          const dir = resolve(root, "systems", id);
          mkdirSync(dir, { recursive: true });
          // Whitelisted names only: manifest.json, source.as, module.wasm, module.sha256.
          writeFileSync(resolveDataPath(root, id, "manifest.json"), body.manifestJson);
          writeFileSync(resolveDataPath(root, id, "source.as"), body.source);
          writeFileSync(resolveDataPath(root, id, "module.wasm"), wasm);
          writeFileSync(resolveDataPath(root, id, "module.sha256"), sha256);
          const systems = readSystemsIndex(root).filter((s) => s.id !== id);
          systems.push({ id, buildsOn: Array.isArray(body.buildsOn) ? body.buildsOn : [], replacedBy: body.replacedBy ?? null, sha256, timestamp: body.timestamp ?? Date.now() });
          writeSystemsIndex(root, systems);
          return sendJson(res, 200, { ok: true, id, sha256 });
        }
        if (req.method === "DELETE") {
          if (!isValidSystemId(queryId)) return invalidId();
          const dir = resolve(root, "systems", queryId);
          if (!dir.startsWith(resolve(root, "systems") + sep)) return invalidId();
          rmSync(dir, { recursive: true, force: true });
          writeSystemsIndex(root, readSystemsIndex(root).filter((s) => s.id !== queryId));
          return sendJson(res, 200, { ok: true });
        }
      }

      if (path === "/world") {
        const file = resolveDataFile(root, "world.json");
        if (req.method === "GET") {
          try { return sendJson(res, 200, { world: readFileSync(file, "utf8") }); } catch { return sendJson(res, 200, { world: null }); }
        }
        if (req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (typeof body.world !== "string") return sendJson(res, 400, { error: "world must be a string" });
          mkdirSync(root, { recursive: true });
          writeFileSync(file, body.world);
          return sendJson(res, 200, { ok: true });
        }
      }

      if (path === "/journal") {
        const file = resolveDataFile(root, "journal.json");
        if (req.method === "GET") {
          try { return sendJson(res, 200, { journal: JSON.parse(readFileSync(file, "utf8")) }); } catch { return sendJson(res, 200, { journal: [] }); }
        }
        if (req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}");
          let journal = [];
          try { journal = JSON.parse(readFileSync(file, "utf8")); } catch { /* start empty */ }
          if (!Array.isArray(journal)) journal = [];
          journal.push(body.entry ?? {});
          mkdirSync(root, { recursive: true });
          writeFileSync(file, JSON.stringify(journal, null, 2));
          return sendJson(res, 200, { ok: true });
        }
      }

      if (path === "/ai-log" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        mkdirSync(root, { recursive: true });
        appendFileSync(resolveDataFile(root, "ai-log.jsonl"), `${String(body.line ?? "")}\n`);
        return sendJson(res, 200, { ok: true });
      }

      if (path === "/fresh" && req.method === "POST") {
        rmSync(resolve(root, "systems"), { recursive: true, force: true });
        for (const name of ["systems.json", "world.json", "journal.json", "ai-log.jsonl"]) {
          rmSync(resolveDataFile(root, name), { force: true });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST") {
        // Legacy shape check (Phase 1 tests): a bad id is a 400 before anything else.
        const raw = await readBody(req);
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "invalid JSON" }); } }
        const id = body.id ?? queryId;
        if (!isValidSystemId(id)) return invalidId();
        return sendJson(res, 404, { error: "not found" });
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

export function systemsPlugin(dataDir = resolve(process.cwd(), "data")) {
  const handler = systemsHandler(dataDir);
  return {
    name: "systems",
    configureServer(server) {
      server.middlewares.use("/__systems", handler);
    },
  };
}

function assetHeaders() {
  return {
    name: "asset-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/assets/") || req.url?.startsWith("assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [systemsPlugin(resolve(process.cwd(), "data")), assetHeaders()],
  worker: { format: "es" },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
