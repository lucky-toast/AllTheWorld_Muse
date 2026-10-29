// Test-only CLI: runs the pipeline core for one fixture file and prints the
// worker protocol ({type:"stage"} lines, then {type:"done", report}) as JSONL.
// Usage: vite-node scripts/pipeline-cli.ts <sourceFile>
import { readFileSync } from "node:fs";
import { runCheck } from "../src/pipeline/core";
import { buildWorld } from "../src/world/map";
import { BASE_SYSTEMS } from "../src/systems/base/index";

const file = process.argv[2];
const source = readFileSync(file, "utf-8");
const eng = buildWorld();
for (const s of BASE_SYSTEMS) eng.loadSystem(s);
const snapshot = eng.snapshot();
const FALLBACK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

const report = await runCheck({ source, loaded: [], snapshot, baseUrl: "" }, {
  onStage: (stage, status, ms) => console.log(JSON.stringify({ type: "stage", stage, status, ms })),
  renderShot: async () => FALLBACK_PNG,
});
console.log(JSON.stringify({ type: "done", report }));
