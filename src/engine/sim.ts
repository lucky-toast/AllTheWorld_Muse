// sim: the test/shoot helper. Plays the game through real input events plus
// ticks, so every system reacts exactly as in play.
import { STEPS_PER_SECOND, TICKS_PER_SECOND } from '../tuning';
import type { Entity, Sim, World } from './api';

const STEP_TICKS = Math.round(TICKS_PER_SECOND / STEPS_PER_SECOND); // ticks per walked step
const SETTLE_TICKS = 1; // ticks after a one-shot input so handlers settle

export function createSim(world: World): Sim {
  const player = (): Entity => {
    const p = world.query('player')[0];
    if (!p) throw new Error('sim needs a player in this world');
    return p;
  };
  const run = (n: number): void => {
    for (let i = 0; i < n; i++) world.tick();
  };
  return {
    walk: (dir, steps = 1) => {
      for (let i = 0; i < steps; i++) {
        world.emit('input.move', { dir });
        run(STEP_TICKS);
      }
    },
    face: (dir) => {
      world.emit('input.turn', { dir });
      run(SETTLE_TICKS);
    },
    interact: () => {
      world.emit('input.interact', {});
      run(SETTLE_TICKS);
    },
    secondary: () => {
      world.emit('input.secondary', {});
      run(SETTLE_TICKS);
    },
    teleport: (x, y) => {
      player().moveTo(x, y, { instant: true });
    },
    give: (type) => {
      const p = player();
      if (!p.pos) throw new Error('sim.give needs the player on the map');
      const item = world.spawn(type, { ...p.pos });
      item.lift();
      p.set('held', { id: item.id });
      return item;
    },
    wait: (n) => run(n),
    press: (inputEvent, data) => {
      const ev = world.emit(inputEvent, data);
      run(SETTLE_TICKS);
      return ev;
    },
  };
}
