import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_contract",
  why: "Broken fixture: emits an event its contract does not list.",
  buildsOn: ["movement"],
  contract: { claims: [], emits: {}, hooks: ["This fixture is intentionally broken; do not build on it."] },
  on: {
    "player.blocked": (ev: any, w: any) => {
      const target = ev.target as { x: number; y: number };
      if (w.at(target.x, target.y).some((e: any) => e.has("solid"))) w.emit("rock.kicked", { target });
    },
  },
  tests: [
    {
      name: "walking into a rock is blocked",
      ticks: 1,
      setup(w: any, sim: any) {
        w.spawn("rock_brown_small", { x: 5, y: 6 });
        sim.teleport(5, 5);
        sim.face("down");
        sim.walk("down");
      },
      expect(w: any, check: any) { check(w.query("player")[0].pos?.y === 5, "the rock blocked the player"); },
    },
  ],
});
