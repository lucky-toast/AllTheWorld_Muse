# All the World

A small 2D top-down browser game that grows while it is played (Vite + TypeScript, plain Canvas 2D, no game framework, Vitest). The rebuild follows [docs/spec.md](docs/spec.md), one phase at a time.

## Run

```sh
npm install
npm run dev        # http://127.0.0.1:5173/
npm test
npm run typecheck
```

## State of the rebuild

Phase 2 of 7: manifests, events, base systems, interactions on E and Q, input and focus.

- `src/engine/engine.ts`: world state (areas, entities, types, tiles, occupancy, clock, per-system RNG, ownership records, timers and tweens, serialize/snapshot) with an undo journal.
- `src/engine/host.ts`: `host.call(systemId, request)`, the one dispatcher, with the five checks, transactions, and the denial, near-limit, overlap and fault logs. It also loads systems, delivers events, fires timers and tweens, and runs the test-only `sim.*` and `check` requests.
- `src/engine/manifest.ts` (schema and context checks), `registry.ts` (interaction table, reactions, event ownership), `events.ts` (payload checks), `interactions.ts` (the E resolver and Q cycle), `input.ts` (keyboard routing), `focus.ts` (borrow and freeze with their guards), `testrun.ts` (the arena test runner).
- `src/systems/base/`: movement, carry, push and daynight, as TypeScript systems that only use `host.call`. Their tests are `test_*` handlers run in a 12x12 arena.
- `src/engine/render.ts`: the renderer ported from the old game, plus the E prompt and the overlay panel. `src/world/`: the forest clearing, identical to commit `24531c5`.
- `devserver/storage.ts`: the dev-server storage plugin. Only the id and path guards exist so far.

Keys: arrows/WASD (tap to turn, hold to walk), E or Space runs the highlighted action, Q cycles actions, Escape ends a system's focus. T cycles time speed 1x/4x/16x, Shift+R re-creates every system without losing the world, backtick opens the dev panel (Sprites tab). URL aids: `?dev=1`, `?time=night|dusk|dawn|day`.

## Decisions the original kickoff didn't specify (kept)

- Footprints extend upward from `pos` (the bottom-left tile), matching bottom-left sprite anchoring.
- The clock advances only while `daynight` is loaded; the day count goes up when the clock crosses dawn (05:00).
- Phase hours: dawn 05-07, day 07-17, dusk 17-20, night 20-05. A full day is 144 real seconds at 1x.
- If a window is smaller than the native 480x348, the canvas scales fractionally below 1x instead of cropping (whole-number scale otherwise).
- The pack copy in `public/assets/` has no `Ui/Font/NormalFont.ttf`, so the HUD tries that path and falls back to monospace; digit cells are fixed-width either way.
