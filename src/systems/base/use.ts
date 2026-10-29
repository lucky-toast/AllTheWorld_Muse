// use: the player can use things in the clearing.
import { defineSystem } from 'engine/define';
import type { Entity } from 'engine/api';
import { byId, facedEntity, playerOf } from './util';

export default defineSystem({
  id: 'use',
  why: 'The player can use things in the clearing.',
  buildsOn: [],
  contract: {
    claims: ['input.interact: when facing a non-item entity'],
    emits: {
      'entity.used': {
        payload: '{ entity, held }',
        when: 'when interact faces a non-item entity; held is the item in hand or null',
      },
    },
    hooks: [
      'To make something usable, listen for `entity.used` and check `ev.entity`; never handle `input.interact` for non-items yourself.',
    ],
  },
  components: {},
  entities: {},
  on: {
    'input.interact': (ev, world) => {
      if (ev.handled) return;
      const p = playerOf(world);
      if (!p || !p.pos || p.has('busy')) return;
      const faced = facedEntity(world, p);
      if (!faced || faced.has('item')) return; // items belong to carry
      const heldComp = p.get('held') as { id: number } | undefined;
      const held: Entity | null = heldComp !== undefined ? (byId(world, heldComp.id) ?? null) : null;
      world.emit('entity.used', { entity: faced, held });
      ev.handled = true;
    },
  },
  tests: [
    {
      name: 'interact facing a rock emits entity.used with held null',
      ticks: 0,
      setup: (w, sim) => {
        const rock = w.spawn('test_block', { x: 6, y: 7 }); // in front; the player faces down
        w.state.rockId = rock.id;
        w.on('entity.used', (used) => {
          w.state.usedId = (used.entity as Entity).id;
          w.state.usedHeld = used.held as Entity | null;
        });
        sim.interact();
      },
      expect: (w, check) => {
        check(w.state.usedId === w.state.rockId, 'entity.used names the rock');
        check(w.state.usedHeld === null, 'held is null with empty hands');
      },
    },
    {
      name: 'holding a branch and facing a rock emits entity.used with the branch, which stays in hand',
      ticks: 0,
      setup: (w, sim) => {
        const branch = sim.give('branch');
        w.state.branchId = branch.id;
        const rock = w.spawn('test_block', { x: 6, y: 7 });
        w.state.rockId = rock.id;
        w.on('entity.used', (used) => {
          w.state.usedId = (used.entity as Entity).id;
          const held = used.held as Entity | null;
          w.state.usedHeldId = held ? held.id : null;
        });
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        const [p] = w.query('player');
        check(w.state.wasHandled === true, 'use claims interact facing a rock');
        check(w.state.usedId === w.state.rockId, 'entity.used names the rock');
        check(w.state.usedHeldId === w.state.branchId, 'entity.used carries the branch as held');
        const branch = w.query('item')[0];
        check(branch.pos === null, 'the branch stays lifted');
        check(
          (p.get('held') as { id: number } | undefined)?.id === w.state.branchId,
          'the branch stays in hand',
        );
      },
    },
    {
      name: 'facing an item or nothing leaves the input alone',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_item', { x: 6, y: 7 });
        w.state.uses = 0;
        w.on('entity.used', () => {
          w.state.uses = (w.state.uses as number) + 1;
        });
        w.state.vsItem = sim.press('input.interact', {}).handled;
        sim.face('up'); // front (6,5) is empty
        w.state.vsEmpty = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        check(w.state.vsItem === false, 'facing an item leaves interact alone for carry');
        check(w.state.vsEmpty === false, 'facing empty ground leaves interact alone');
        check(w.state.uses === 0, 'entity.used never fired');
      },
    },
    {
      name: 'an item outranks a pushable when choosing the faced entity',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_pushable', { x: 6, y: 7 });
        w.spawn('test_item', { x: 6, y: 7 });
        w.state.uses = 0;
        w.on('entity.used', () => {
          w.state.uses = (w.state.uses as number) + 1;
        });
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        check(w.state.wasHandled === false, 'the faced item belongs to carry, not use');
        check(w.state.uses === 0, 'entity.used never fired');
      },
    },
    {
      name: 'a busy player uses nothing',
      ticks: 0,
      setup: (w, sim) => {
        w.spawn('test_block', { x: 6, y: 7 });
        w.query('player')[0].tag('busy');
        w.state.uses = 0;
        w.on('entity.used', () => {
          w.state.uses = (w.state.uses as number) + 1;
        });
        w.state.wasHandled = sim.press('input.interact', {}).handled;
      },
      expect: (w, check) => {
        check(w.state.wasHandled === false, 'busy leaves interact unhandled');
        check(w.state.uses === 0, 'entity.used never fired');
      },
    },
  ],
  shots: [
    {
      name: 'using',
      setup: (w, sim) => {
        sim.teleport(15, 10);
        sim.face('right');
        sim.give('branch');
        w.spawn('rock_brown', { x: 16, y: 10 });
      },
      ticks: 0,
      focus: { x: 16, y: 10 },
    },
  ],
});
