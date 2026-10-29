import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_shot",
  why: "Broken fixture: its shot setup assumes a campfire that was never built.",
  buildsOn: [],
  contract: { claims: [], emits: {}, hooks: ["This fixture is intentionally broken; do not build on it."] },
  tests: [{ name: "the player exists", ticks: 0, setup() {}, expect(w: any, check: any) { check(w.query("player").length === 1, "the player exists"); } }],
  shots: [
    {
      name: "campfire close-up",
      ticks: 0,
      focus: { x: 5, y: 5 },
      setup(w: any) {
        const fire = w.query("campfire")[0];
        // Throws: there is no campfire in this world.
        void fire.pos.x;
      },
    },
  ],
});
