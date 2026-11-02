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

Phase 1 of 7: engine, host and the map on screen.

- `src/engine/engine.ts`: world state (areas, entities, types, tiles, occupancy, clock, per-system RNG, ownership records, serialize/snapshot) with an undo journal.
- `src/engine/host.ts`: `host.call(systemId, request)`, the one dispatcher, with the five checks, transactions and the denial and near-limit logs. Requests that need later phases answer "not yet".
- `src/engine/render.ts`: the renderer ported from the old game. `src/world/`: the forest clearing, identical to commit `24531c5`.
- `devserver/storage.ts`: the dev-server storage plugin. Only the id and path guards exist so far.

Keys: T cycles time speed 1x/4x/16x, backtick opens the dev panel (Sprites tab). URL aids: `?dev=1`, `?time=night|dusk|dawn|day`.

## Decisions the original kickoff didn't specify (kept)

- Footprints extend upward from `pos` (the bottom-left tile), matching bottom-left sprite anchoring.
- The clock advances only while `daynight` is loaded; the day count goes up when the clock crosses dawn (05:00).
- Phase hours: dawn 05-07, day 07-17, dusk 17-20, night 20-05. A full day is 144 real seconds at 1x.
- If a window is smaller than the native 480x348, the canvas scales fractionally below 1x instead of cropping (whole-number scale otherwise).
- The pack copy in `public/assets/` has no `Ui/Font/NormalFont.ttf`, so the HUD tries that path and falls back to monospace; digit cells are fixed-width either way.
