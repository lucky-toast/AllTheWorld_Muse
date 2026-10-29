import { defineSystem } from "engine/define";

// Burns for part of a night once lit (ticks at 60/s).
const BURN_TICKS = 900;
const DIE_TICKS = 40;

function tileFreeForFire(w: any, x: number, y: number): boolean {
  const tid = w.tiles.get(x, y);
  if (tid === null) return false;
  const entry = w.catalog.get(tid);
  if (!entry || !entry.tags.includes("walkable") || entry.tags.includes("water")) return false;
  return w.at(x, y).every((e: any) => e.type === "branch" || !(e.has("player") || e.has("solid") || e.has("pushable") || e.has("item")));
}

function buildFire(w: any, sim: any) {
  sim.teleport(15, 9);
  sim.give("branch"); sim.face("down"); sim.interact();
  sim.give("branch"); sim.face("right"); sim.interact();
  sim.teleport(16, 11);
  sim.give("branch"); sim.face("up"); sim.interact();
}

export default defineSystem({
  id: "campfire",
  why: "Three branches dropped together become a campfire that lights the night, then burns to ash.",
  buildsOn: ["carry", "movement"],
  contract: {
    claims: [],
    emits: {
      "fire.lit": { payload: "{ pos }", when: "when three branches become a campfire" },
      "fire.out": { payload: "{ pos }", when: "when the fire burns out and leaves ash" },
    },
    hooks: [
      "To react when a fire is lit, listen for fire.lit.",
      "To react when a fire dies, listen for fire.out; the pit is then firepit_ash and no longer solid.",
    ],
  },
  components: {
    fireAge: "ticks since this campfire was lit (number, on the campfire entity)",
    burned: "true once the fire is out (on the campfire entity)",
    campfireId: "id of the campfire a flame belongs to (on the flame entity)",
  },
  entities: {
    campfire: { sprite: "firepit", tags: ["solid", "campfire"] },
    campfire_flame: { sprite: "fx_fire", tags: ["campfire_flame"] },
  },
  migrate(_w: any) {},
  onTick(w: any) {
    for (const fire of w.query("campfire")) {
      if (fire.get("burned")) continue;
      const age = (fire.get("fireAge") ?? 0) + 1;
      fire.set("fireAge", age);
      const flame = w.query("campfire_flame").find((f: any) => f.get("campfireId") === fire.id);
      if (age === BURN_TICKS + DIE_TICKS) {
        fire.set("sprite", { id: "firepit_ash" });
        fire.untag("solid");
        fire.remove("light");
        fire.set("burned", true);
        if (flame) flame.destroy();
        w.emit("fire.out", { pos: fire.pos });
        continue;
      }
      if (!flame) continue;
      const anim = age < 40 ? "ignite" : age < BURN_TICKS ? "burn" : "die";
      const cur = flame.get("sprite");
      if (cur?.anim !== anim) flame.set("sprite", { id: "fx_fire", anim, z: 5, offset: { x: 12, y: -14 } });
      if (age >= BURN_TICKS) {
        const l = fire.get("light");
        if (l) fire.set("light", { ...l, strength: Math.max(0, 0.9 * (1 - (age - BURN_TICKS) / DIE_TICKS)) });
      }
    }
  },
  on: {
    "item.dropped": (ev: any, w: any) => {
      const item = ev.item;
      if (!item || item.type !== "branch" || !item.pos) return;
      const branches = w.query("item").filter((e: any) => e.type === "branch" && e.pos);
      const b = item.pos;
      for (const minX of [b.x - 1, b.x]) {
        for (const bottom of [b.y, b.y + 1]) {
          const tiles = [
            { x: minX, y: bottom }, { x: minX + 1, y: bottom },
            { x: minX, y: bottom - 1 }, { x: minX + 1, y: bottom - 1 },
          ];
          const inBlock = branches.filter((e: any) => tiles.some((t) => t.x === e.pos.x && t.y === e.pos.y));
          if (inBlock.length < 3) continue;
          const branchTiles = new Set(inBlock.map((e: any) => e.pos.x + "," + e.pos.y));
          if (!tiles.every((t) => branchTiles.has(t.x + "," + t.y) || tileFreeForFire(w, t.x, t.y))) continue;
          for (const e of inBlock) e.destroy();
          const fire = w.spawn("campfire", { x: minX, y: bottom });
          fire.set("fireAge", 0);
          fire.set("light", { radius: 46, color: "#ffb347", strength: 0.9, flicker: 1 });
          const flame = w.spawn("campfire_flame", { x: minX, y: bottom });
          flame.set("campfireId", fire.id);
          flame.set("sprite", { id: "fx_fire", anim: "ignite", z: 5, offset: { x: 12, y: -14 } });
          w.emit("fire.lit", { pos: { x: minX, y: bottom } });
          return;
        }
      }
    },
  },
  tests: [
    {
      name: "three branches make a fire, two do not",
      ticks: 2,
      setup(w: any, sim: any) {
        sim.teleport(15, 9);
        sim.give("branch"); sim.face("down"); sim.interact();
        sim.give("branch"); sim.face("right"); sim.interact();
        (w.state as any).__two = w.query("campfire").length;
        sim.teleport(16, 11);
        sim.give("branch"); sim.face("up"); sim.interact();
      },
      expect(w: any, check: any) {
        check((w.state as any).__two === 0, "two branches did not make a fire");
        check(w.query("campfire").length === 1, "three branches made a campfire");
        check(w.query("campfire_flame").length === 1, "the fire has a flame");
      },
    },
    {
      name: "the fire has a light",
      ticks: 2,
      setup(w: any, sim: any) { buildFire(w, sim); },
      expect(w: any, check: any) {
        const fire = w.query("campfire")[0];
        check(!!fire && fire.has("light"), "campfire has a light component");
        check((fire?.get("light")?.radius ?? 0) > 20, "the light has a useful radius");
      },
    },
    {
      name: "it burns out and leaves ash",
      ticks: 2,
      setup(w: any, sim: any) { buildFire(w, sim); sim.wait(1000); },
      expect(w: any, check: any) {
        const fire = w.query("campfire")[0];
        check(!!fire && fire.get("sprite")?.id === "firepit_ash", "the pit became firepit_ash");
        check(!!fire && !fire.has("solid"), "the ash is not solid");
        check(w.query("campfire_flame").length === 0, "the flame is gone");
      },
    },
    {
      name: "the player cannot walk through a lit fire",
      ticks: 2,
      setup(w: any, sim: any) { buildFire(w, sim); sim.teleport(15, 11); sim.face("up"); sim.walk("up"); },
      expect(w: any, check: any) {
        check(w.query("player")[0].pos?.y === 11, "the solid campfire blocked the player");
      },
    },
  ],
  shots: [
    { name: "lit at night", ticks: 50, focus: { x: 16, y: 9 }, setup(w: any, sim: any) { buildFire(w, sim); w.time.set("night"); } },
    { name: "ash after burn out", ticks: 5, focus: { x: 16, y: 9 }, setup(w: any, sim: any) { buildFire(w, sim); sim.wait(1000); } },
  ],
});
