// @ts-nocheck
import { defineConfig } from "vite";
import { resolve, sep } from "node:path";

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

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

/** Storage/systems middleware shell. Only id validation and path checks exist in Phase 1. */
export function systemsHandler(dataDir) {
  const root = resolve(dataDir);
  return async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const queryId = url.searchParams.get("id");
      if (req.method === "GET") {
        if (queryId !== null && resolveDataPath(root, queryId, "manifest.json") === null) {
          return sendJson(res, 400, { error: "invalid system id" });
        }
        return sendJson(res, 200, { systems: [] });
      }
      if (req.method === "POST") {
        let body = {};
        const raw = await readBody(req);
        if (raw) {
          try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
        }
        const id = body.id ?? queryId;
        if (resolveDataPath(root, id, "manifest.json") === null) {
          return sendJson(res, 400, { error: "invalid system id" });
        }
        return sendJson(res, 501, { error: "storage endpoints arrive in a later phase" });
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
});
