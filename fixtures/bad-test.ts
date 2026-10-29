import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_test",
  why: "Broken fixture: its test expects a spark the system never makes.",
  buildsOn: ["use"],
  contract: {
    claims: [],
    emits: {},
    hooks: [],
  },
  tests: [
    {
      name: "using a branch on a rock makes a spark",
      ticks: 1,
      setup(w: any, sim: any) {
        sim.teleport(10, 10);
        w.spawn("rock_brown_small", { x: 10, y: 11 });
        sim.give("branch");
        sim.face("down");
        sim.interact();
      },
      expect(w: any, check: any) {
        check(w.query("spark").length > 0, "a spark appeared when the branch was used on the rock");
        check(w.query("player").length === 1, "the player is still there");
      },
    },
  ],
});
