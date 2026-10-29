// @ts-nocheck
import { defineConfig } from "vite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Dev-server persistence for accepted AI systems: data/systems/<id>.ts plus
// data/systems.json (id, order, buildsOn, timestamp). Built copies fall back
// to localStorage in the browser (see src/pipeline/persistence.ts).
function systemsPlugin() {
  const dataDir = join(process.cwd(), "data");
  const sysDir = join(dataDir, "systems");
  const manifestPath = join(dataDir, "systems.json");
  const readManifest = () => { try { return JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { return []; } };
  const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
  return {
    name: "atw-systems",
    configureServer(server) {
      server.middlewares.use("/__systems", async (req, res) => {
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET") {
            const manifest = readManifest();
            const systems = manifest.map((m) => ({ ...m, source: readFileSync(join(sysDir, m.id + ".ts"), "utf-8") }));
            let world = null; try { world = readFileSync(join(dataDir, "world.json"), "utf-8"); } catch { /* none */ }
            res.end(JSON.stringify({ systems, world }));
          } else if (req.method === "POST" && req.url === "/save") {
            const body = JSON.parse(await readBody(req));
            mkdirSync(sysDir, { recursive: true });
            writeFileSync(join(sysDir, body.id + ".ts"), body.source);
            const manifest = readManifest().filter((m) => m.id !== body.id);
            manifest.push({ id: body.id, order: manifest.length, buildsOn: body.buildsOn ?? [], timestamp: body.timestamp ?? new Date().toISOString() });
            manifest.forEach((m, i) => (m.order = i));
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
            res.end(JSON.stringify({ ok: true }));
          } else if (req.method === "POST" && req.url === "/world") {
            const body = JSON.parse(await readBody(req));
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(join(dataDir, "world.json"), body.world);
            res.end(JSON.stringify({ ok: true }));
          } else if (req.method === "POST" && req.url === "/fresh") {
            mkdirSync(dataDir, { recursive: true });
            if (existsSync(sysDir)) for (const f of readdirSync(sysDir)) rmSync(join(sysDir, f));
            writeFileSync(manifestPath, "[]");
            try { rmSync(join(dataDir, "world.json")); } catch { /* none */ }
            res.end(JSON.stringify({ ok: true }));
          } else { res.statusCode = 404; res.end(JSON.stringify({ error: "unknown route" })); }
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
      });
    },
  };
}

export default defineConfig({
  plugins: [systemsPlugin()],
  test: { include: ["tests/**/*.test.ts"] },
});
