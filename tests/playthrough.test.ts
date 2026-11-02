import { expect, it } from "vitest";
import { buildWorld } from "../src/world/map";
import { createGame } from "../src/systems/base/index";
it("real map playthrough", () => {
  const eng = buildWorld(); const game = createGame(eng); game.testMode = true;
  const sim = (op: string, e: Record<string, unknown> = {}) => { const r = game.call("test", { op, ...e }); if (!r.ok) throw new Error(r.msg); };
  // Player at (15,11) facing down; stone at (14,11) is left, branch at (11,10).
  sim("sim.teleport", { x: 11, y: 9 }); sim("sim.face", { dir: "down" }); game.interactions.refresh();
  expect(eng.interactionPrompt).toBe("E: Pick up");
  sim("sim.interact"); expect(eng.playerRec()!.comps.get("held")).toBeTruthy();
  game.interactions.refresh(); expect(eng.interactionPrompt).toBe("E: Drop");
  sim("sim.interact"); expect(eng.playerRec()!.comps.get("held")).toBeUndefined();
  // Crate push: crate at (17,9); stand left of it.
  sim("sim.teleport", { x: 16, y: 9 }); sim("sim.walk", { dir: "right" });
  expect(eng.atIds(18, 9).some((id) => eng.recById(id)?.type === "crate")).toBe(true);
  // Clock runs and player glows.
  expect(eng.playerRec()!.comps.has("light")).toBe(true);
  sim("sim.time", { phaseOrHour: "night" }); sim("sim.wait", { ticks: 5 });
  expect(eng.phase()).toBe("night");
  expect(game.eventLog.some((e) => e.name === "time.jumped")).toBe(true);
});
