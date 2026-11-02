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

Phase 5 of 7: the planner and designer AIs, the wish chain, and the dev panel's AI tab (on top of Phase 4's pipeline, live load and storage).

- `src/engine/`: world state, the one dispatcher (`host.ts`), manifests, registry, events, the E resolver, input and focus, the renderer.
- `src/systems/base/`: movement, carry, push and daynight.
- `src/sdk/` and `src/sandbox/`: AI systems as AssemblyScript compiled to metered WebAssembly (compile, loader, meter, test and shot runners).
- `src/pipeline/`: `checkSystem`, `loadChecked`, `submitSystem` (`client.ts`, with the stage watchdog), stages 1 to 6 (`stages.ts`) run in a Web Worker (`worker.ts`), Load, Undo, the startup reload and autosave (`live.ts`), storage (`store.ts`: dev server, or localStorage plus an IndexedDB module cache), the leaf transition, and the report as text.
- `devserver/storage.ts`: the `/__data` endpoints for `data/systems/<id>/`, `systems.json`, `world.json`, `journal.json` and `ai-log.jsonl`, with the id and path guards.
- `src/ai/`: the planner and designer prompts (`prompts/*.md` and `pillars.md`, copied verbatim from `docs/`), prompt building and the cache split (`template.ts`, `blocks.ts`), `designer.ts` (reply parsing, up to 3 repairs), `planner.ts` (wish cleaning, one re-ask), the wish chain (`chain.ts`), the journal and AI log (`journal.ts`), `ManualProvider` (`provider.ts`), the "What changed" panel (`changed.ts`), and the example systems shown to the designer (`examples/`, never loaded).
- `src/dev/`: the dev panel (Sprites, Pipeline and AI tabs). `fixtures/`: campfire and chop, plus one bad fixture per stage.

Keys: arrows/WASD (tap to turn, hold to walk), E or Space runs the highlighted action, Q cycles actions, Escape ends a system's focus. T cycles time speed 1x/4x/16x, Shift+R re-creates every system without losing the world, backtick opens the dev panel, C (or a click on the game) opens "What changed". URL aids: `?dev=1`, `?time=night|dusk|dawn|day`, `?submit=<fixture>`.

Saved systems and the world are in `data/` (git-ignored) under `npm run dev`, and in the browser's localStorage and IndexedDB in a built copy. "Start fresh" in the Pipeline tab deletes them.

## Decisions the original kickoff didn't specify (kept)

- Footprints extend upward from `pos` (the bottom-left tile), matching bottom-left sprite anchoring.
- The clock advances only while `daynight` is loaded; the day count goes up when the clock crosses dawn (05:00).
- Phase hours: dawn 05-07, day 07-17, dusk 17-20, night 20-05. A full day is 144 real seconds at 1x.
- If a window is smaller than the native 480x348, the canvas scales fractionally below 1x instead of cropping (whole-number scale otherwise).
- The pack copy in `public/assets/` has no `Ui/Font/NormalFont.ttf`, so the HUD tries that path and falls back to monospace; digit cells are fixed-width either way.
