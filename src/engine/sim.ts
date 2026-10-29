import type { Dir, Entity, Sim, World } from "./api";
import type { Engine } from "./engine";
import { TUNING } from "../tuning";
/** Create the sim driver for a test/shot against an engine. Plays through real input events. */
export function makeSim(eng: Engine, world: World): Sim {
  const tickN = (n: number) => { for (let i = 0; i < n; i++) eng.tick(); };
  const sim: Sim = {
    walk(dir: Dir, steps = 1) { for (let i = 0; i < steps; i++) { eng.emitInput("input.move", { dir }); tickN(2); } },
    face(dir: Dir) { eng.emitInput("input.turn", { dir }); tickN(1); },
    interact() { eng.emitInput("input.interact", {}); tickN(1); },
    secondary() { eng.emitInput("input.secondary", {}); tickN(1); },
    teleport(x, y) { world.query("player")[0]?.moveTo(x, y, { instant: true }); },
    give(type: string): Entity {
      const p = world.query("player")[0];
      const item = world.spawn(type, p.pos ? { ...p.pos } : { x: 0, y: 0 });
      item.lift(); p.set("held", { id: item.id }); return item;
    },
    wait(ticks) { tickN(ticks); },
    press(name, data) { eng.emitInput(name, data ?? {}); tickN(1); },
  };
  void TUNING; void world;
  return sim;
}
