// push: the player can shove crates and logs out of the way.
import { defineSystem } from 'engine/define';
import type { Entity, Pos } from 'engine/api';
import { DELTAS, footprintTiles, isDir } from './util';

export default defineSystem({
  id: 'push',
  why: 'The player can shove crates and logs out of the way.',
  buildsOn: [],
  contract: {
    claims: [],
    emits: {
      'entity.bumped': {
        payload: '{ entity, dir }',
        when: 'when the player is blocked by a pushable entity, before push tries to move it',
      },
    },
    hooks: [
      'To react to pushing, listen for entity.bumped.',
      "Push never handles input; it only answers movement's player.blocked.",
    ],
  },
  components: {},
  entities: {},
  on: {
    'player.blocked': (ev, world) => {
      const dir: unknown = ev.dir;
      const target = ev.target as Pos | undefined;
      if (
        !isDir(dir) ||
        !target ||
        typeof target.x !== 'number' ||
        typeof target.y !== 'number'
      ) {
        return;
      }
      const pushable = world.at(target.x, target.y).find((e) => e.has('pushable'));
      if (!pushable || !pushable.pos) return;
      world.emit('entity.bumped', { entity: pushable, dir });
      const d = DELTAS[dir];
      const dest: Pos = { x: pushable.pos.x + d.x, y: pushable.pos.y + d.y };
      if (world.tiles.get(dest.x, dest.y) === null) return;
      const sprite = pushable.get('sprite') as { id: string } | undefined;
      if (!sprite) return;
      if (footprintTiles(world, sprite.id, dest).every((t) => world.isFree(t.x, t.y, pushable))) {
        pushable.moveTo(dest.x, dest.y);
        world.fx.particles('fx_grass', dest); // dust where it lands
      }
    },
  },
  tests: [
    {
      name: 'pushes a crate one tile when the way is clear',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('test_pushable', { x: 7, y: 6 });
        w.on('entity.bumped', (bumped) => {
          w.state.bumpedId = (bumped.entity as Entity).id;
          w.state.bumpDir = bumped.dir;
        });
        w.emit('player.blocked', { dir: 'right', target: { x: 7, y: 6 } });
      },
      expect: (w, check) => {
        const box = w.query('pushable')[0];
        check(box.pos !== null && box.pos.x === 8 && box.pos.y === 6, 'the crate slid one tile right');
        check(w.state.bumpedId === box.id, 'entity.bumped names the crate');
        check(w.state.bumpDir === 'right', 'entity.bumped names the push direction');
      },
    },
    {
      name: 'the whole 2-tile log moves when pushed',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('log_fallen', { x: 7, y: 6 }); // covers (7,6) and (7,5)
        w.emit('player.blocked', { dir: 'right', target: { x: 7, y: 6 } });
      },
      expect: (w, check) => {
        const log = w.query('pushable').find((e) => e.type === 'log_fallen');
        check(
          log !== undefined && log.pos !== null && log.pos.x === 8 && log.pos.y === 6,
          'the log moved one tile right',
        );
        check(
          log !== undefined &&
            w.at(8, 6).some((e) => e.id === log.id) &&
            w.at(8, 5).some((e) => e.id === log.id),
          'both log tiles moved together',
        );
        check(w.at(7, 6).length === 0 && w.at(7, 5).length === 0, 'the old tiles are empty');
      },
    },
    {
      name: 'pushing a log into a rock leaves it in place',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('log_fallen', { x: 7, y: 6 });
        w.spawn('test_block', { x: 8, y: 6 });
        w.state.bumps = 0;
        w.on('entity.bumped', () => {
          w.state.bumps = (w.state.bumps as number) + 1;
        });
        w.emit('player.blocked', { dir: 'right', target: { x: 7, y: 6 } });
      },
      expect: (w, check) => {
        const log = w.query('pushable').find((e) => e.type === 'log_fallen');
        check(
          log !== undefined && log.pos !== null && log.pos.x === 7 && log.pos.y === 6,
          'the log did not move',
        );
        check(w.state.bumps === 1, 'the bump still fired against the rock');
      },
    },
    {
      name: 'every new footprint tile must be free',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('log_fallen', { x: 7, y: 6 });
        w.spawn('test_block', { x: 8, y: 5 }); // only the upper landing tile
        w.emit('player.blocked', { dir: 'right', target: { x: 7, y: 6 } });
      },
      expect: (w, check) => {
        const log = w.query('pushable').find((e) => e.type === 'log_fallen');
        check(
          log !== undefined && log.pos !== null && log.pos.x === 7 && log.pos.y === 6,
          'one blocked landing tile stops the whole log',
        );
      },
    },
    {
      name: 'ignores blocked steps with no pushable on the target',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('test_block', { x: 7, y: 6 });
        w.state.bumps = 0;
        w.on('entity.bumped', () => {
          w.state.bumps = (w.state.bumps as number) + 1;
        });
        w.emit('player.blocked', { dir: 'right', target: { x: 7, y: 6 } });
      },
      expect: (w, check) => {
        check(w.state.bumps === 0, 'no bump fired without a pushable');
        const block = w.query('solid')[0];
        check(block.pos !== null && block.pos.x === 7 && block.pos.y === 6, 'the rock stayed put');
      },
    },
    {
      name: 'pushes along the blocked direction',
      ticks: 0,
      setup: (w, _sim) => {
        w.spawn('test_pushable', { x: 6, y: 5 });
        w.emit('player.blocked', { dir: 'up', target: { x: 6, y: 5 } });
      },
      expect: (w, check) => {
        const box = w.query('pushable')[0];
        check(box.pos !== null && box.pos.x === 6 && box.pos.y === 4, 'the crate slid one tile up');
      },
    },
    {
      name: 'ignores input events entirely',
      ticks: 0,
      setup: (_w, sim) => {
        sim.walk('up');
        sim.interact();
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(
          p.pos !== null && p.pos.x === 6 && p.pos.y === 6,
          'input alone moves nothing in a push-only world',
        );
      },
    },
  ],
  shots: [
    {
      name: 'pushing',
      setup: (w, sim) => {
        sim.teleport(15, 10);
        sim.face('right');
        w.spawn('crate', { x: 16, y: 10 });
        sim.walk('right');
      },
      ticks: 0,
      focus: { x: 16, y: 10 },
    },
  ],
});
