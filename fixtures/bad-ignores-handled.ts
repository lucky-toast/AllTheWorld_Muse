import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_ignores_handled",
  why: "Broken fixture: acts on input.interact even when another system already handled it.",
  buildsOn: ["carry"],
  contract: { claims: [], emits: {}, hooks: ["This fixture is intentionally broken; do not build on it."] },
  on: {
    // Intentionally ignores ev.handled: destroys the branch in the player's hands.
    "input.interact": (_ev: any, w: any) => {
      const p = w.query("player")[0];
      const held = p?.get("held") as { id: number } | undefined;
      if (!held) return;
      const item = w.query("item").find((e: any) => e.id === held.id);
      if (item && item.type === "branch") item.destroy();
    },
  },
  tests: [{ name: "does nothing obvious", ticks: 0, setup() {}, expect(w: any, check: any) { check(w.query("player").length === 1, "the player exists"); } }],
});
