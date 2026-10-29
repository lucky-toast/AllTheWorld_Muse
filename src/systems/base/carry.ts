// carry: the player can pick things up and put them down.
import { defineSystem } from 'engine/define';
import type { Dir, Entity, Pos, World } from 'engine/api';
import { byId, facedEntity, footprintTiles, isDir, playerOf } from './util';

/**
 * Where a held item lands: pos so its whole footprint sits ahead of the
 * player (below for facing down, since footprints extend upward from pos).
 */
function placementFor(world: World, player: Entity, spriteId: string): Pos | undefined {
  if (!player.pos) return undefined;
  const facing: unknown = player.get('facing');
  if (!isDir(facing)) return undefined;
  const fp = world.catalog.get(spriteId).footprint ?? { w: 1, h: 1 };
  const w = fp.w;
  const h = fp.h;
  const xoff = fp.x ?? 0;
  const { x, y } = player.pos;
  const dest: Record<Dir, Pos> = {
    up: { x: x - xoff, y: y - 1 },
    down: { x: x - xoff, y: y + h },
    left: { x: x - w - xoff, y },
    right: { x: x + 1 - xoff, y },
  };
  return dest[facing];
}

export default defineSystem({
  id: 'carry',
  why: 'The player can pick things up and put them down.',
  buildsOn: [],
  contract: {
    claims: ['input.interact: when picking an item up or putting it down'],
    emits: {
      'item.picked': { payload: '{ item }', when: 'after an item is lifted into the hands' },
      'item.dropped': { payload: '{ item, pos }', when: 'after a held item is placed back on the map' },
    },
    hooks: [
      'To react to pickups, listen for item.picked and item.dropped.',
      "The player's `held` component ({ id }) is the one place that says what's in hand; it is absent when hands are empty.",
      'Carry leaves input.interact alone when it cannot place, so `use` gets it.',
    ],
  },
  components: {
    held: '{ id } on the player while carrying; absent when hands are empty',
  },
  entities: {},
  on: {
    'input.interact': (ev, world) => {
      if (ev.handled) return;
      const p = playerOf(world);
      if (!p || !p.pos || p.has('busy')) return;
      const held = p.get('held') as { id: number } | undefined;
      if (held !== undefined) {
        const item = byId(world, held.id);
        if (!item) {
          p.remove('held'); // stale hands; fall through as empty-handed
        } else if (item.pos === null) {
          const sprite = item.get('sprite') as { id: string } | undefined;
          const dest = sprite ? placementFor(world, p, sprite.id) : undefined;
          if (
            sprite !== undefined &&
            dest !== undefined &&
            world.tiles.get(dest.x, dest.y) !== null &&
            footprintTiles(world, sprite.id, dest).every((t) => world.isFree(t.x, t.y, item))
          ) {
            item.place(dest.x, dest.y);
            p.remove('held');
            world.emit('item.dropped', { item, pos: { x: dest.x, y: dest.y } });
            world.fx.particles('fx_grass', dest); // settle dust on the landing tile
            ev.handled = true;
          }
          return; // holding: never pick up a second item; use gets the leftovers
        } else {
          return; // held item is somehow still on the map; leave the input alone
        }
      }
      const faced = facedEntity(world, p);
      if (faced && faced.has('item')) {
        const taken = faced.pos;
        faced.lift();
        p.set('held', { id: faced.id });
        world.emit('item.picked', { item: faced });
        if (taken) world.fx.particles('fx_spark', taken); // glint on the emptied tile
        ev.handled = true;
      }
      // else: leave the input alone so `use` gets it.
    },
  },
  tests: [
    {
      name: 'interact facing an item lifts it into hand',
      ticks: 0,
      setup: (w, sim) => {
        const item = w.spawn('test_item', { x: 6, y: 7 }); // in front; the player faces down
        w.state.itemId = item.id;
        w.on('item.picked', (picked) => {
          w.state.pickedId = (picked.item as Entity).id;
        });
        sim.interact();
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        const item = w.query('item')[0];
        check(item.pos === null, 'the item left the map');
        check(
          (p.get('held') as { id: number } | undefined)?.id === item.id,
          'held names the lifted item',
        );
        check(w.state.pickedId === item.id, 'item.picked names the item');
      },
    },
    {
      name: 'interact while holding places the item in front',
      ticks: 0,
      setup: (w, sim) => {
        sim.give('test_item');
        w.on('item.dropped', (dropped) => {
          w.state.dropped = dropped.pos;
        });
        sim.interact(); // facing down: the front tile (6,7) is free
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        const item = w.query('item')[0];
        check(
          item.pos !== null && item.pos.x === 6 && item.pos.y === 7,
          'the item lands on the front tile',
        );
        check(!p.has('held'), 'hands are empty after placing');
        const dropped = w.state.dropped as Pos | undefined;
        check(dropped !== undefined && dropped.x === 6 && dropped.y === 7, 'item.dropped names the landing tile');
      },
    },
    {
      name: 'dropping onto an occupied tile leaves the input alone',
      ticks: 0,
      setup: (w, sim) => {
        sim.give('test_item');
        w.spawn('test_block', { x: 6, y: 7 });
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        const item = w.query('item')[0];
        check(w.state.wasHandled === false, 'a blocked placement stays unhandled for use');
        check(item.pos === null, 'the item stays in hand');
        check(p.has('held'), 'held is untouched');
      },
    },
    {
      name: 'a log drops only where both of its tiles are free',
      ticks: 0,
      setup: (w, sim) => {
        sim.give('log_fallen'); // 1x2: facing down it lands on (6,7) and (6,8)
        const results: boolean[] = [];
        const far = w.spawn('test_block', { x: 6, y: 8 });
        results.push(sim.press('input.interact', {}).handled);
        far.destroy();
        const near = w.spawn('test_block', { x: 6, y: 7 });
        results.push(sim.press('input.interact', {}).handled);
        near.destroy();
        results.push(sim.press('input.interact', {}).handled);
        w.state.results = results;
      },
      expect: (w, check) => {
        const results = w.state.results as boolean[];
        check(results[0] === false, 'a blocked far tile stops the drop');
        check(results[1] === false, 'a blocked near tile stops the drop');
        check(results[2] === true, 'the drop lands when both tiles are free');
        const [p] = w.query('player');
        const log = w.query('item').find((e) => e.type === 'log_fallen');
        check(log !== undefined && log.pos !== null && log.pos.x === 6 && log.pos.y === 8, 'the log lands two tiles ahead');
        check(
          log !== undefined &&
            w.at(6, 7).some((e) => e.id === log.id) &&
            w.at(6, 8).some((e) => e.id === log.id),
          'both footprint tiles are covered',
        );
        check(!p.has('held'), 'hands are empty after the drop');
      },
    },
    {
      name: 'pickup prefers an item over a pushable on the faced tile',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_pushable', { x: 6, y: 7 });
        const item = w.spawn('test_item', { x: 6, y: 7 });
        w.state.itemId = item.id;
        sim.interact();
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(
          (p.get('held') as { id: number } | undefined)?.id === w.state.itemId,
          'the item was lifted, not the pushable',
        );
        const box = w.query('pushable')[0];
        check(box.pos !== null && box.pos.x === 6 && box.pos.y === 7, 'the pushable stays on its tile');
      },
    },
    {
      name: 'facing a non-item or nothing leaves the input alone',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_block', { x: 6, y: 7 });
        w.state.picks = 0;
        w.on('item.picked', () => {
          w.state.picks = (w.state.picks as number) + 1;
        });
        w.state.vsBlock = sim.press('input.interact', {}).handled;
        sim.face('up'); // front (6,5) is empty
        w.state.vsEmpty = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        check(w.state.vsBlock === false, 'facing a rock leaves interact unhandled');
        check(w.state.vsEmpty === false, 'facing empty ground leaves interact unhandled');
        check(w.state.picks === 0, 'nothing was picked up');
      },
    },
    {
      name: 'a busy player picks nothing up',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_item', { x: 6, y: 7 });
        w.query('player')[0].tag('busy');
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        const item = w.query('item')[0];
        check(w.state.wasHandled === false, 'busy leaves interact unhandled');
        check(item.pos !== null, 'the item stays on the ground');
        check(!p.has('held'), 'hands stay empty');
      },
    },
    {
      name: 'a busy player holding an item keeps holding it',
      ticks: 0,
      setup: (w, sim) => {
        sim.give('test_item'); // front (6,7) is free
        w.query('player')[0].tag('busy');
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        const item = w.query('item')[0];
        check(w.state.wasHandled === false, 'busy leaves interact unhandled');
        check(item.pos === null, 'the item stays lifted');
        check(p.has('held'), 'held is untouched');
      },
    },
  ],
  shots: [
    {
      name: 'carrying',
      setup: (_w, sim) => {
        sim.give('branch');
        sim.walk('left');
      },
      ticks: 0,
      focus: { x: 14, y: 10 },
    },
  ],
});
