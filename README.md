# All the World

A small 2D top-down browser game base (Vite + TypeScript, plain Canvas 2D, no game framework).
Later systems will be written against the Systems API in [src/engine/api.d.ts](src/engine/api.d.ts) — that file is the contract.

## Run

This machine has no system Node; a portable Node 22 lives in `.tools/` (git-ignored). With any Node 20+:

```sh
npm install
npm run dev      # http://127.0.0.1:5173/
npm test         # headless system tests + contract checks (35 tests)
npm run build    # typecheck + production build
```

On this machine, prefix PATH first: `$env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"`.

## Play

- Arrow keys / WASD: tap a new direction to turn, hold to walk. Space/E: interact (pick up, drop, use). Q: spare secondary key.
- T: cycle time speed 1x/4x/16x. Shift+R: reload all systems without losing the world. Backtick: dev panel (sprites tab).
- Shot aids: `?time=night|dusk|dawn|day` jumps the clock on load; `?dev=1` opens the dev panel.

## Pipeline (AI-written systems)

New systems arrive as TypeScript source text and are checked before they can touch the live game:

- `checkSystem(source)` runs Static rules, Compile, Sandbox run, Tests, Invariants and Shots in a Web Worker with its own engine copy; a stage over its time limit (in `src/tuning.ts`) gets the worker killed. It never touches the live game.
- `loadChecked(report)` runs Load only for a passed report, and refuses if the loaded systems have changed since the check. Load pauses the game for a ~2s leaf transition, then shows "The world feels different".
- `submitSystem(source)` is the two in a row. The dev panel (backtick) lists the fixtures in `fixtures/`, shows the stage boxes/report/shots, and has Start fresh.
- Accepted systems are saved to `data/systems/<id>.ts` + `data/systems.json` via a dev-server endpoint (localStorage fallback in built copies), loaded in order on startup (failures and their dependents are skipped and listed), and restored with the saved world. Start fresh deletes all of it.
- Browser aids: `?submit=campfire.ts` submits a fixture on load; `?dev=1` opens the panel; `?time=night` jumps the clock.
- `npm test` also runs the pipeline against every fixture (through the same client/watchdog, in Node worker processes) and checks each expected outcome.

## AI designer (manual messenger loop)

The backtick panel's AI tab runs an update with you as the messenger: type a task, Start builds the exact prompt an AI would get (`src/ai/designer.ts`, from `src/ai/prompts/designer.md` with pillars, the full Systems API, examples, a WORLD description, the catalog and an art-board line), you copy it (plus the downloadable art board PNG) into an AI chat, and paste the reply back. The two-block reply (```ts + ```json) is run through `checkSystem` only — nothing loads until the visual check: after a pass, you look at the shots and either reply `{ "ok": true }` (loads via `loadChecked`) or paste a corrected module, which is re-checked from stage one as a new attempt row and only loaded if it passes itself. Failures get a ready-to-copy repair message, up to 3 repairs. Every attempt row shows its stage boxes and estimated tokens (chars ÷ 4, whole conversation resent each time); the full message log goes to `data/ai-log.jsonl`. On load, the update's JSON block is appended to `data/journal.json` and shown in the "What changed" panel (C key or clicking the game; behind a setting in the AI tab). The send step sits behind `AiProvider` (`src/ai/provider.ts`); `ManualProvider` is the only provider for now, so a real API can replace it without touching the loop.

## Layout

- `src/engine/` — the only non-system code: engine core, catalog, renderer, input, sim, `api.d.ts`, `define.ts`.
- `src/systems/base/` — movement, carry, push, use, daynight, each with its contract and tests in the same file.
- `src/world/` — base entity types and the hand-made 30x20 forest clearing.
- `src/tuning.ts` — every feel value, each with a comment.
- `tests/harness.test.ts` — runs every system's tests in a walkable arena, plus contract/engine guarantees.

## Decisions the kickoff didn't specify

- Footprints extend upward from `pos` (the bottom-left tile), matching bottom-left sprite anchoring; a placed 1x2 log extends away from the player when facing down.
- The engine advances the clock only while `daynight` is loaded (it owns all `time.*` events); the day count goes up when the clock crosses dawn (05:00). `time.set` emits `time.jumped` immediately and `time.phase` on daynight's next tick.
- Phase hours: dawn 05-07, day 07-17, dusk 17-20, night 20-05 (night shorter than the waking day). A full day is 144 real seconds at 1x.
- If a window is smaller than the native 480x348, the canvas scales fractionally below 1x instead of cropping (whole-number scale otherwise).
- The pack copy in `public/assets/` has no `Ui/Font/NormalFont.ttf`, so the HUD tries that path and falls back to monospace; digit cells are fixed-width either way.
- `sim.walk` sends one `input.move` per step (the keyboard layer is what paces held keys); `fx` effects are renderer-owned transients and are not serialized.
