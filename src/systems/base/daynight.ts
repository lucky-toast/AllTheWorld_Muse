// daynight: the clock runs through dawn, day, dusk and night, starting mid-morning.
import { defineSystem } from 'engine/define';
import type { Phase, World } from 'engine/api';
import { DAY_LENGTH_SECONDS, PHASES, PLAYER_LIGHT, TICKS_PER_SECOND } from '../../tuning';
import { playerOf } from './util';

/** Game-hours per tick: a full day takes DAY_LENGTH_SECONDS of real time. */
const HOURS_PER_TICK = 24 / (DAY_LENGTH_SECONDS * TICKS_PER_SECOND);

/** Phase boundaries, read from tuning (never hard-coded here). */
function phaseOf(h: number): Phase {
  if (h >= PHASES.dawn.start && h < PHASES.dawn.end) return 'dawn';
  if (h >= PHASES.day.start && h < PHASES.day.end) return 'day';
  if (h >= PHASES.dusk.start && h < PHASES.dusk.end) return 'dusk';
  return 'night';
}

/** Time speed from our own state (dev tools cycle 1/4/16); garbage reads as 1x. */
function speedOf(world: World): number {
  const s: unknown = world.state.speed;
  return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
}

function migrate(world: World): void {
  if (world.state.speed === undefined) world.state.speed = 1;
  const p = playerOf(world);
  if (p && !p.has('light')) p.set('light', { ...PLAYER_LIGHT });
}

export default defineSystem({
  id: 'daynight',
  why: 'The clearing lives through dawn, day, dusk and night.',
  buildsOn: [],
  contract: {
    claims: [],
    emits: {
      'time.phase': {
        payload: '{ phase, previous, day }',
        when: 'whenever the phase changes, by smooth advance or by time.set',
      },
      'time.dawn': { payload: '{ phase, previous, day }', when: 'when the phase becomes dawn' },
      'time.daytime': { payload: '{ phase, previous, day }', when: 'when the phase becomes day' },
      'time.dusk': { payload: '{ phase, previous, day }', when: 'when the phase becomes dusk' },
      'time.night': { payload: '{ phase, previous, day }', when: 'when the phase becomes night' },
      'time.newDay': {
        payload: '{ day }',
        when: 'when the day number goes up at dawn, by smooth advance or by time.set',
      },
      'time.hour': {
        payload: '{ hour, day }',
        when: 'at every whole hour crossed by smooth advance, never for jumps',
      },
    },
    hooks: [
      'To react to the time of day, listen for time.phase or its shortcut (time.dawn, time.daytime, time.dusk, time.night).',
      'To run daily setup, listen for time.newDay.',
      'To skip the clock in tests and shots, call time.set; jumps never emit time.hour.',
    ],
  },
  components: {
    light: '{ radius, color, strength, flicker? } on the player; the renderer cuts a warm glow out of the darkness',
  },
  entities: {},
  migrate,
  onTick(world) {
    const prevHour = world.time.hour;
    const prevDay = world.time.day;
    const prevPhase = world.time.phase;
    world.time.advance(HOURS_PER_TICK * speedOf(world));
    const hour = world.time.hour;
    const day = world.time.day;
    const phase = world.time.phase;
    // Whole hours crossed by this step. Steps are far below an hour, so at most one.
    const wrapped = hour < prevHour;
    if (wrapped || Math.floor(hour) > Math.floor(prevHour)) {
      world.emit('time.hour', { hour: wrapped ? 0 : Math.floor(hour), day });
    }
    if (phase !== prevPhase) world.emit('time.phase', { phase, previous: prevPhase, day });
    if (day > prevDay) world.emit('time.newDay', { day });
  },
  on: {
    // Every phase change, smooth or jumped, also fires its shortcut with the same payload.
    'time.phase': (ev, world) => {
      const phase = ev.phase as Phase;
      const name = phase === 'day' ? 'time.daytime' : `time.${phase}`;
      world.emit(name, { phase: ev.phase, previous: ev.previous, day: ev.day });
    },
    // A jump that lands in dawn with a higher day number is a new day too.
    'time.jumped': (ev, world) => {
      const from = ev.from as { day: number; hour: number };
      const to = ev.to as { day: number; hour: number };
      if (phaseOf(to.hour) === 'dawn' && to.day > from.day) world.emit('time.newDay', { day: to.day });
    },
  },
  tests: [
    {
      name: 'starts on the morning of day 1',
      ticks: 0,
      expect: (w, check) => {
        check(w.time.day === 1, 'a fresh world is on day 1');
        check(w.time.phase === 'day', 'a fresh world starts in the day phase');
        check(w.time.hour === 9, 'a fresh world starts at 9 in the morning');
      },
    },
    {
      name: 'migrate gives the player a faint light, safely twice',
      ticks: 0,
      expect: (w, check) => {
        const [p] = w.query('player');
        check(p.has('light'), 'the player has a light after migrate');
        check(
          JSON.stringify(p.get('light')) === JSON.stringify({ ...PLAYER_LIGHT }),
          'the player light matches tuning',
        );
        const before = JSON.stringify(p.get('light'));
        migrate(w);
        check(JSON.stringify(p.get('light')) === before, 'migrate stays a no-op when run again');
      },
    },
    {
      name: 'runs the full phase cycle with a shortcut for each phase',
      ticks: Math.ceil(23 / HOURS_PER_TICK),
      setup: (w) => {
        w.state.phases = [] as Array<{ phase: unknown; previous: unknown; day: unknown }>;
        w.state.shortcuts = [] as Array<{ name: string; phase: unknown; day: unknown }>;
        w.on('time.phase', (ev) => {
          const list = w.state.phases as Array<{ phase: unknown; previous: unknown; day: unknown }>;
          list.push({ phase: ev.phase, previous: ev.previous, day: ev.day });
        });
        for (const name of ['time.dawn', 'time.daytime', 'time.dusk', 'time.night']) {
          w.on(name, (ev) => {
            const list = w.state.shortcuts as Array<{ name: string; phase: unknown; day: unknown }>;
            list.push({ name, phase: ev.phase, day: ev.day });
          });
        }
      },
      expect: (w, check) => {
        const phases = w.state.phases as Array<{ phase: Phase; previous: Phase; day: number }>;
        check(
          JSON.stringify(phases.map((p) => p.phase)) === JSON.stringify(['dusk', 'night', 'dawn', 'day']),
          'the phases run dusk, night, dawn, day from a morning start',
        );
        check(
          JSON.stringify(phases.map((p) => p.previous)) === JSON.stringify(['day', 'dusk', 'night', 'dawn']),
          'each phase names the one before it',
        );
        check(
          JSON.stringify(phases.map((p) => p.day)) === JSON.stringify([1, 1, 2, 2]),
          'the day number goes up at dawn',
        );
        const shortcuts = w.state.shortcuts as Array<{ name: string; phase: Phase; day: number }>;
        check(
          JSON.stringify(shortcuts.map((s) => s.name)) ===
            JSON.stringify(['time.dusk', 'time.night', 'time.dawn', 'time.daytime']),
          'each phase change fires its own shortcut in order',
        );
        check(
          shortcuts.length === 4 && shortcuts[3].phase === 'day' && shortcuts[3].day === 2,
          'shortcuts carry the same phase and day payload',
        );
      },
    },
    {
      name: 'night passes faster than day',
      ticks: Math.ceil(24.5 / HOURS_PER_TICK),
      setup: (w) => {
        w.time.set('dawn'); // start clean at 5:00 so every segment is whole
        w.state.stamps = {} as Record<string, number>;
        for (const name of ['time.dawn', 'time.daytime', 'time.dusk', 'time.night']) {
          w.on(name, () => {
            (w.state.stamps as Record<string, number>)[name] = w.ticks;
          });
        }
      },
      expect: (w, check) => {
        const stamps = w.state.stamps as Record<string, number>;
        const dayTicks = stamps['time.dusk'] - stamps['time.daytime']; // 11 game-hours
        const nightTicks = stamps['time.dawn'] - stamps['time.night']; // 9 game-hours
        check(nightTicks < dayTicks, 'night takes fewer ticks than day');
        check(Math.abs(dayTicks - 11 / HOURS_PER_TICK) <= 2, 'day lasts its 11 game-hours');
        check(Math.abs(nightTicks - 9 / HOURS_PER_TICK) <= 2, 'night lasts its 9 game-hours');
      },
    },
    {
      name: 'emits time.newDay at dawn with the new day number',
      ticks: Math.ceil(20.5 / HOURS_PER_TICK),
      setup: (w) => {
        w.state.newDays = [] as Array<unknown>;
        w.on('time.newDay', (ev) => {
          (w.state.newDays as Array<unknown>).push(ev.day);
        });
      },
      expect: (w, check) => {
        check(
          JSON.stringify(w.state.newDays) === JSON.stringify([2]),
          'exactly one newDay fires, for day 2',
        );
        check(w.time.day === 2, 'the clock reads day 2 after dawn');
      },
    },
    {
      name: 'ticks every whole hour crossed',
      ticks: Math.ceil(3.5 / HOURS_PER_TICK),
      setup: (w) => {
        w.state.hours = [] as Array<{ hour: unknown; day: unknown }>;
        w.on('time.hour', (ev) => {
          (w.state.hours as Array<{ hour: unknown; day: unknown }>).push({ hour: ev.hour, day: ev.day });
        });
      },
      expect: (w, check) => {
        check(
          JSON.stringify(w.state.hours) ===
            JSON.stringify([
              { hour: 10, day: 1 },
              { hour: 11, day: 1 },
              { hour: 12, day: 1 },
            ]),
          'hours 10, 11 and 12 tick once each on day 1 (starting at 9 ticks nothing)',
        );
      },
    },
    {
      name: 'time.set jumps with from/to, plus phase and shortcut when changed',
      ticks: 0,
      setup: (w) => {
        w.state.jumps = [] as Array<unknown>;
        w.state.phases = [] as Array<unknown>;
        w.state.nights = 0;
        w.on('time.jumped', (ev) => {
          (w.state.jumps as Array<unknown>).push({ from: ev.from, to: ev.to });
        });
        w.on('time.phase', (ev) => {
          (w.state.phases as Array<unknown>).push({ phase: ev.phase, previous: ev.previous, day: ev.day });
        });
        w.on('time.night', () => {
          w.state.nights = (w.state.nights as number) + 1;
        });
        w.time.set('night');
      },
      expect: (w, check) => {
        check(
          JSON.stringify(w.state.jumps) ===
            JSON.stringify([{ from: { day: 1, hour: 9 }, to: { day: 1, hour: 20 } }]),
          'jumped names the old and new clock readings',
        );
        check(
          JSON.stringify(w.state.phases) === JSON.stringify([{ phase: 'night', previous: 'day', day: 1 }]),
          'a jump across a boundary emits time.phase',
        );
        check(w.state.nights === 1, 'the jump also fires the night shortcut');
        check(w.time.hour === 20, 'the clock reads the jumped-to hour');
      },
    },
    {
      name: 'jumps within one phase emit no phase event',
      ticks: 0,
      setup: (w, sim) => {
        w.state.jumps = 0;
        w.state.phases = 0;
        w.on('time.jumped', () => {
          w.state.jumps = (w.state.jumps as number) + 1;
        });
        w.on('time.phase', () => {
          w.state.phases = (w.state.phases as number) + 1;
        });
        w.time.set(10);
        sim.wait(2);
        w.time.set(12);
        sim.wait(2);
      },
      expect: (w, check) => {
        check(w.state.jumps === 2, 'both jumps emit time.jumped');
        check(w.state.phases === 0, 'no phase event fires when the phase never changes');
        check(w.time.phase === 'day', 'the clock is still in the day phase');
      },
    },
    {
      name: 'jumping to a new dawn emits time.newDay',
      ticks: 1,
      setup: (w) => {
        w.state.order = [] as Array<string>;
        w.state.newDays = [] as Array<unknown>;
        w.on('time.jumped', () => void (w.state.order as Array<string>).push('jumped'));
        w.on('time.newDay', (ev) => {
          (w.state.order as Array<string>).push('newDay');
          (w.state.newDays as Array<unknown>).push(ev.day);
        });
        w.on('time.phase', () => void (w.state.order as Array<string>).push('phase'));
        w.time.set(29); // day 2 at 5:00, dawn
      },
      expect: (w, check) => {
        check(JSON.stringify(w.state.newDays) === JSON.stringify([2]), 'the jump to day 2 emits newDay');
        check(
          JSON.stringify(w.state.order) === JSON.stringify(['jumped', 'newDay', 'phase']),
          'newDay fires during the jump, before the phase event',
        );
      },
    },
    {
      name: 'midnight passes without rolling the day',
      ticks: 500,
      setup: (w) => {
        w.state.newDays = 0;
        w.state.hours = [] as Array<unknown>;
        w.on('time.newDay', () => {
          w.state.newDays = (w.state.newDays as number) + 1;
        });
        w.on('time.hour', (ev) => {
          (w.state.hours as Array<unknown>).push({ hour: ev.hour, day: ev.day });
        });
        w.time.set(23.9);
      },
      expect: (w, check) => {
        check(w.time.day === 1, 'the day is still 1 after midnight');
        check(w.state.newDays === 0, 'no newDay fires at midnight');
        check(
          JSON.stringify(w.state.hours) === JSON.stringify([{ hour: 0, day: 1 }]),
          'the midnight crossing ticks hour 0 on the same day',
        );
      },
    },
  ],
  shots: [
    {
      name: 'dusk over the clearing',
      setup: (w) => void w.time.set('dusk'),
      ticks: 5,
      focus: { x: 15, y: 10 },
    },
    {
      name: 'night with the player glow',
      setup: (w) => void w.time.set('night'),
      ticks: 5,
      focus: { x: 15, y: 10 },
    },
  ],
});
