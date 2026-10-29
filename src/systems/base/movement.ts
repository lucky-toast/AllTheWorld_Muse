// movement: the player can walk the clearing.
import { defineSystem } from 'engine/define';
import type { Dir, Pos } from 'engine/api';
import { isDir, playerOf, stepFrom } from './util';

export default defineSystem({
  id: 'movement',
  why: 'The player can walk the clearing.',
  buildsOn: [],
  contract: {
    claims: ['input.turn: always, for the player', 'input.move: always, for the player'],
    emits: {
      'player.moved': { payload: '{ from, to, dir }', when: 'after every completed step' },
      'player.blocked': {
        payload: '{ dir, target: {x, y} }',
        when: 'when a step is blocked, before movement re-checks the tile',
      },
    },
    hooks: [
      'To react to walking, listen for player.moved.',
      'To clear the way when the player is blocked, handle player.blocked.',
    ],
  },
  components: {
    facing: 'Dir on the player; the one place facing is stored',
  },
  entities: {},
  migrate(world) {
    const p = playerOf(world);
    if (p && !p.has('facing')) p.set('facing', 'down');
  },
  on: {
    'input.turn': (ev, world) => {
      if (ev.handled) return;
      const dir: unknown = ev.dir;
      const p = playerOf(world);
      if (!p || p.has('busy') || !isDir(dir)) return;
      p.set('facing', dir);
      ev.handled = true;
    },
    'input.move': (ev, world) => {
      if (ev.handled) return;
      const dir: unknown = ev.dir;
      const p = playerOf(world);
      if (!p || !p.pos || p.has('busy') || !isDir(dir)) return;
      p.set('facing', dir);
      const from: Pos = { ...p.pos };
      const target = stepFrom(from, dir);
      if (!world.isFree(target.x, target.y, p)) {
        world.emit('player.blocked', { dir, target: { ...target } });
        if (!world.isFree(target.x, target.y, p)) {
          ev.handled = true;
          return;
        }
      }
      p.moveTo(target.x, target.y);
      world.emit('player.moved', { from, to: { ...target }, dir });
      ev.handled = true;
    },
  },
  tests: [
    {
      name: 'turn faces without moving',
      ticks: 0,
      setup: (_w, sim) => void sim.face('up'),
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.get('facing') === 'up', 'facing is up after input.turn');
        check(p.pos !== null && p.pos.x === 6 && p.pos.y === 6, 'turning does not move the player');
      },
    },
    {
      name: 'move faces and steps onto a free tile',
      ticks: 0,
      setup: (_w, sim) => void sim.walk('right'),
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.pos !== null && p.pos.x === 7 && p.pos.y === 6, 'the player stepped right to (7,6)');
        check(p.get('facing') === 'right', 'facing follows the step');
      },
    },
    {
      name: 'move emits player.moved with from, to, and dir',
      ticks: 0,
      setup: (w, sim) => {
        w.on('player.moved', (ev) => {
          w.state.seen = { from: ev.from, to: ev.to, dir: ev.dir };
        });
        sim.walk('up');
      },
      expect: (w, check) => {
        const seen = w.state.seen as { from: Pos; to: Pos; dir: Dir } | undefined;
        check(seen !== undefined, 'player.moved fired');
        check(seen !== undefined && seen.from.x === 6 && seen.from.y === 6, 'from is the old tile');
        check(seen !== undefined && seen.to.x === 6 && seen.to.y === 5, 'to is the new tile');
        check(seen !== undefined && seen.dir === 'up', 'dir names the step');
      },
    },
    {
      name: 'walking into the map edge stays put and emits player.blocked',
      ticks: 0,
      setup: (w, sim) => {
        w.on('player.blocked', (ev) => {
          const hits = (w.state.hits as Array<{ dir: unknown; target: unknown }>) ?? [];
          hits.push({ dir: ev.dir, target: ev.target });
          w.state.hits = hits;
        });
        sim.teleport(0, 5);
        sim.walk('left');
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.pos !== null && p.pos.x === 0 && p.pos.y === 5, 'a blocked step leaves the player in place');
        check(p.get('facing') === 'left', 'a blocked step still faces the direction');
        const hits = w.state.hits as Array<{ dir: Dir; target: Pos }> | undefined;
        check(hits !== undefined && hits.length === 1, 'player.blocked fired once');
        check(hits !== undefined && hits[0].dir === 'left', 'blocked names the direction');
        check(
          hits !== undefined && hits[0].target.x === -1 && hits[0].target.y === 5,
          'blocked names the tile beyond the edge',
        );
      },
    },
    {
      name: 'a step cleared during player.blocked completes on the re-check',
      ticks: 0,
      setup: (w, sim) => {
        const block = w.spawn('test_block', { x: 7, y: 6 });
        w.on('player.blocked', () => void block.destroy());
        w.on('player.moved', () => {
          w.state.moves = ((w.state.moves as number | undefined) ?? 0) + 1;
        });
        sim.walk('right');
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.pos !== null && p.pos.x === 7 && p.pos.y === 6, 'the step completed once the tile cleared');
        check(w.state.moves === 1, 'player.moved fired for the completed step');
      },
    },
    {
      name: 'both tiles of a fallen log block the player',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('log_fallen', { x: 7, y: 6 }); // covers (7,6) and (7,5)
        w.on('player.blocked', () => {
          w.state.blocks = ((w.state.blocks as number | undefined) ?? 0) + 1;
        });
        sim.walk('right'); // into the lower log tile
        sim.teleport(6, 5);
        sim.walk('right'); // into the upper log tile
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.pos !== null && p.pos.x === 6 && p.pos.y === 5, 'both blocked steps left the player in place');
        check(w.state.blocks === 2, 'both log tiles emitted player.blocked');
      },
    },
    {
      name: 'a busy player ignores turn and move input',
      ticks: 0,
      setup: (w, sim) => {
        w.query('player')[0].tag('busy');
        sim.face('up');
        sim.walk('right');
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.get('facing') === 'down', 'turn does nothing while busy');
        check(p.pos !== null && p.pos.x === 6 && p.pos.y === 6, 'move does nothing while busy');
      },
    },
    {
      name: 'a second handler on input.move does nothing once movement acts',
      ticks: 0,
      setup: (w, sim) => {
        w.loadSystem(
          defineSystem({
            id: 'probe',
            contract: { claims: ['input.move: test probe, never acts'], emits: {}, hooks: [] },
            on: {
              'input.move': (ev, inner) => {
                const [p] = inner.query('player');
                if (ev.handled) {
                  p.tag('probe-saw-handled');
                  return;
                }
                p.tag('probe-acted');
              },
            },
          }),
        );
        sim.walk('up');
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.pos !== null && p.pos.x === 6 && p.pos.y === 5, 'movement acted on the step');
        check(p.has('probe-saw-handled'), 'the second handler saw handled set');
        check(!p.has('probe-acted'), 'the second handler did nothing once the first acted');
      },
    },
  ],
  shots: [
    {
      name: 'walking',
      setup: (_w, sim) => void sim.walk('right', 2),
      ticks: 0,
      focus: { x: 17, y: 10 },
    },
  ],
});
