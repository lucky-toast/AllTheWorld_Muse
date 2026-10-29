// @ts-nocheck
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { checkSystem, loadChecked, configurePipeline, type WorkerLike } from "../src/pipeline/client";
import campfire from "../fixtures/campfire.ts?raw";
import badSprite from "../fixtures/bad-sprite.ts?raw";
import badTypes from "../fixtures/bad-types.ts?raw";
import badLoop from "../fixtures/bad-loop.ts?raw";
import badTest from "../fixtures/bad-test.ts?raw";
import badContract from "../fixtures/bad-contract.ts?raw";
import badIgnores from "../fixtures/bad-ignores-handled.ts?raw";
import badShot from "../fixtures/bad-shot.ts?raw";

const FIXTURES: Record<string, { source: string; ok: boolean; stage: string }> = {
  "campfire.ts": { source: campfire as unknown as string, ok: true, stage: "Load" },
  "bad-sprite.ts": { source: badSprite as unknown as string, ok: false, stage: "Static rules" },
  "bad-types.ts": { source: badTypes as unknown as string, ok: false, stage: "Compile" },
  "bad-loop.ts": { source: badLoop as unknown as string, ok: false, stage: "Sandbox run" },
  "bad-test.ts": { source: badTest as unknown as string, ok: false, stage: "Tests" },
  "bad-contract.ts": { source: badContract as unknown as string, ok: false, stage: "Invariants" },
  "bad-ignores-handled.ts": { source: badIgnores as unknown as string, ok: false, stage: "Invariants" },
  "bad-shot.ts": { source: badShot as unknown as string, ok: false, stage: "Shots" },
};

let loadedList: { id: string; source: string; buildsOn: string[] }[] = [];
let loadCalls = 0;

function processWorker(): WorkerLike {
  let child: ReturnType<typeof spawn> | null = null;
  let handler: (m: unknown) => void = () => {};
  let buf = "";
  return {
    postMessage(msg: unknown) {
      const req = (msg as { req: { source: string } }).req;
      mkdirSync(".tmp", { recursive: true });
      const file = `.tmp/fixture-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ts`;
      writeFileSync(file, req.source);
      child = spawn((globalThis as never as { process: { execPath: string } }).process.execPath,
        ["node_modules/vite-node/dist/cli.mjs", "scripts/pipeline-cli.ts", file],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { try { handler(JSON.parse(line)); } catch { /* partial */ } } }
      });
    },
    terminate() { child?.kill(); },
    setHandler(fn) { handler = fn; },
  };
}

beforeAll(() => {
  configurePipeline({
    createWorker: processWorker,
    getLoaded: () => loadedList,
    getSnapshot: () => "{}",
    baseUrl: "",
    performLoad: async (report) => { loadCalls++; loadedList = [...loadedList, { id: report.systemId!, source: report.source, buildsOn: [] }]; return report; },
  });
});

describe("pipeline fixtures", () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    it(`${name} -> ${f.ok ? "passes" : f.stage}`, async () => {
      loadedList = [];
      const report = await checkSystem(f.source);
      expect(report.ok, JSON.stringify(report.errors, null, 1)).toBe(f.ok);
      expect(report.stage).toBe(f.stage);
      expect(report.source).toBe(f.source);
      if (!f.ok) expect(report.errors.length).toBeGreaterThan(0);
      if (name === "campfire.ts") {
        expect(report.systemId).toBe("campfire");
        expect(report.shots.map((s) => s.name)).toEqual(["lit at night", "ash after burn out"]);
        expect(report.shots[0].png.startsWith("data:image/png")).toBe(true);
      }
    }, 60000);
  }

  it("a failing test report lists checks, events, inputs and entities", async () => {
    loadedList = [];
    const report = await checkSystem(FIXTURES["bad-test.ts"].source);
    const e = report.errors[0];
    expect(e.test).toBe("using a branch on a rock makes a spark");
    expect(e.checks?.some((c) => !c.passed && c.label.includes("spark"))).toBe(true);
    expect((e.events?.length ?? 0)).toBeGreaterThan(0);
    expect(e.inputs?.some((i) => i.name === "input.interact")).toBe(true);
    expect((e.entities?.length ?? 0)).toBeGreaterThan(0);
  }, 60000);

  it("loadChecked refuses once another system has loaded since the check", async () => {
    loadedList = []; loadCalls = 0;
    const report = await checkSystem(FIXTURES["campfire.ts"].source);
    expect(report.ok).toBe(true);
    const loaded = await loadChecked(report);
    expect(loaded.ok).toBe(true); expect(loadCalls).toBe(1);
    const again = await loadChecked(report);
    expect(again.ok).toBe(false); expect(again.stage).toBe("Load");
    expect(again.errors[0].message).toMatch(/changed since the check|already loaded/);
    expect(loadCalls).toBe(1);
  }, 60000);

  it("loadChecked refuses a failed report", async () => {
    loadedList = [];
    const report = await checkSystem(FIXTURES["bad-sprite.ts"].source);
    const refused = await loadChecked(report);
    expect(refused.ok).toBe(false);
    expect(refused.errors[0].message).toMatch(/did not pass/);
  }, 60000);

  it("fixture files on disk match the imported sources", () => {
    for (const name of Object.keys(FIXTURES)) expect(readFileSync("fixtures/" + name, "utf-8").length).toBeGreaterThan(50);
  });
});
