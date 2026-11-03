# All the World

A small 2D top-down browser game that grows while it is played. The player types a wish, a planner AI splits it into a few small systems, a designer AI writes each one as a manifest plus an AssemblyScript module, an automatic pipeline checks it, and it goes live in the running game. No person reviews anything: the pipeline and the sandbox are the approval.

Vite, TypeScript, plain Canvas 2D (no game framework), Vitest. The design is [docs/spec.md](docs/spec.md); the prompts are [src/ai/prompts/designer.md](src/ai/prompts/designer.md) and [src/ai/prompts/planner.md](src/ai/prompts/planner.md), and the pillars are [src/ai/pillars.md](src/ai/pillars.md).

## How to run

```sh
npm install
npm run dev         # http://127.0.0.1:5173/
npm test            # every test, including every fixture through the pipeline
npm run typecheck
npm run build       # typecheck, then a static build in dist/
```

URL aids: `?dev=1` opens the dev panel, `?time=night|dusk|dawn|day` jumps the clock on load, `?submit=<fixture>` sends a fixture (`campfire`, `chop`, `bad_loop`, ...) through the pipeline on load.

## How to play

| Key | What it does |
| --- | --- |
| Arrows or WASD | Tap to turn, hold to walk. Walking into a crate or log pushes it |
| E or Space | Runs the highlighted action shown above what you face ("E: Pick up") |
| Q | Cycles the other matching actions ("E: Chop ‹1/2› Q"). Turning or stepping resets to the default |
| Escape | Ends any system's hold on the controls (a mini-game, a cutscene, a chop). Nothing can block it |
| F, Enter, or a click on "F Wish" in the bottom bar | Opens the wish box. While it is open every key types into it and none reach the game. Enter makes the wish (sent through the Muse API, as the AI tab's Start does with "Send messages: API"), Escape closes it and keeps the text |
| T | Time speed 1x, 4x, 16x |
| Shift+R | Re-creates every system module from storage, keeping the world |
| Backtick | Opens and closes the dev panel (it swallows game input while open) |
| C, or a click on the game | Opens and closes "What changed" |

The base game is a 30x20 forest clearing with day and night. You can walk, push crates and logs, and pick up and drop items (Pick up and Drop are ordinary interactions owned by the base `carry` system). Everything else comes from wishes.

## Architecture

| Folder | What lives there |
| --- | --- |
| `src/engine/` | World state, the one dispatcher (`host.ts`: every read and write by every system goes through `host.call`), manifests, the registry, events, the E and Q resolver (`interactions.ts`), input and focus, the fixed-step loop and the renderer |
| `src/systems/base/` | The trusted base systems: `movement`, `carry`, `push`, `daynight`. They use the same manifest format and the same dispatcher as AI systems |
| `src/sdk/` | The AssemblyScript library compiled into every AI system. `index.ts` is the reference the designer sees; `README.md` documents the ABI |
| `src/sandbox/` | Compile (asc 0.28.20, fixed settings), the module loader and the fuel meter (a binary rewriter), and the test runners |
| `src/pipeline/` | `checkSystem`, `loadChecked` and `submitSystem`, the stages (run in a Web Worker under a watchdog), live Load and Undo, startup, autosave and storage |
| `src/ai/` | The planner, the designer, the prompt templates and the cache split, the wish chain, the journal and AI log, `MuseProvider`, the designer's lookup tools, the "What changed" panel and the example systems shown to the designer |
| `src/dev/` | The dev panel: Pipeline and AI tabs |
| `devserver/` | The Vite plugin that serves `/__data` for storage under `npm run dev` |
| `fixtures/` | Systems sent through the pipeline as text, exactly as AI output would be. Never loaded at startup |
| `src/tuning.ts` | Every feel value and every limit, each with a one-line comment |

An AI system can only call `host.call` and use its own memory. Each call into it is a transaction with a fuel budget: if it traps, runs out of fuel or runs out of memory, the world is rolled back and the system gets a strike. Three strikes in a minute unload it and everything that builds on it.

## The pipeline

`submitSystem(manifestJson, source)` runs these stages in order and stops at the first failure. Stages 1 to 5 run in a Web Worker on a copy of the world; the live game is untouched until Load.

| # | Stage | Passes when |
| --- | --- | --- |
| 1 | Manifest | The schema is valid, the id is new, every named sprite, type, component and event exists or is declared, emitted events carry the system's prefix (or are inherited through `replaces`), and `buildsOn` and `replaces` name loaded systems |
| 2 | Compile | asc compiles the module with the fixed settings. Errors carry the line and source text |
| 3 | Module | The loader accepts it: valid WebAssembly, imports exactly `host.call` and `env.memory`, exports that cover the manifest, and the fuel meter understands every opcode |
| 4 | Tests | The system's own `test_*` exports pass on a fresh copy of the real map, then every loaded system's tests still pass with it loaded |
| 5 | World check | It loads into a copy of the live world and runs 300 ticks without a trap; the player can still walk, pick up and drop; invariants hold; the world round-trips through save and load; and the module can be re-created mid-run |
| 6 | Load | The leaf transition plays, the world is snapshotted, the system is added and its `migrate` runs, it is saved, and the player sees "The world feels different". Undo in the dev panel reverses the most recent load |

A failure produces a Report. The designer gets it back as the repair message, which names the stage and the problem (for example `entities.dragon: sprite "dragon_huge" isn't in the catalog`).

A new system can retire a loaded AI system by listing it in `replaces`. It must emit every event the old one emitted, systems that built on the old one keep working against the new one, and Undo brings the old one back.

## The AI tab

Wishes go to the Meta Muse API through the dev server, with no clicks between steps:

1. Type a wish in "Player wish" and press Start, or use the in-game wish box. The wish is cleaned (letters, digits and simple punctuation, at most 100 characters).
2. The planner's message and reply appear. The reply is one fenced `json` block, `{ "steps": [{ "task": "...", "tags": [...] }] }`; at most 4 steps are kept, and an unreadable reply gets one re-ask.
3. For each step in order, the designer's message appears. The designer looks up the catalog and the world's entity types with tools before replying; each lookup round shows as a line under the message, listing every call with a short summary of its result. Its reply (a `json` manifest, a `ts` module and a `json` `{ title, summary, changes, journal }`) fills in, and the attempt row lights the stage boxes as the pipeline runs.
4. A failed attempt gets the repair message, up to 3 repairs per step. If a step still fails, the chain stops; earlier steps stay loaded.

The size line next to each message adds the real usage, such as `in 12,345 (cached 11,000) · out 2,100 (reasoning 1,500) tokens`. The map images go with each designer message. An API error ends the wish with the error in the status line; systems loaded by earlier steps stay loaded.

To set up the API:

1. Put your Model API key (from the Model API dashboard, "API keys") in a file named `.env.local` at the repo root: `MUSE_API_KEY=...`. The file is git-ignored. `MUSE_BASE_URL` is optional and defaults to `https://api.meta.ai/v1`.
2. Restart `npm run dev`. The key stays in the dev server (`devserver/ai.ts`, mounted at `/__ai`); the browser never sees it, and it has no `VITE_` prefix, so it can't end up in a build. Without a key, Start is disabled and the tab says to set `MUSE_API_KEY` in `.env.local`.

The planner uses Muse Spark (`muse-spark-1.3`) and the designer uses Muse Wonder (`muse-wonder-1.0`). Change the models, their output caps (`maxTokens`, which reasoning tokens count toward) and their reasoning effort in `AI_MODELS` in `src/tuning.ts`. A reply cut off at its cap is an error, not a repair round.

### Reviewing test rounds

Every wish writes stats to two files in `data/` (`src/ai/stats.ts`). Start fresh keeps them, so several rounds can be compared; delete the files to start counting again.

- `ai-usage.jsonl`: one line per API request, with the wish, role, step, attempt, model, input tokens, cached input tokens (and the cached share), output tokens (reasoning included), the time it took, and whether it failed. A reply cut off at `maxTokens` still counts, since it cost tokens.
- `ai-wishes.jsonl`: one line per wish when it ends. It has the status, how many steps the planner gave, and for each step how many designer attempts failed before its system loaded, and at which stage. It also has the token totals for the planner, the designer and the whole wish, from the wish going in to its last system loading.

`npm run ai-report` prints a summary of every wish, then totals: average designer failures before a load, failures by stage, tokens per role and per model, and the cache hit rate. `-- --last 5` shows only the last 5 wishes, and `-- --requests` lists every request under its wish. In the AI tab, the AI log also shows a `wish total:` line when a wish ends. Wishes logged before the copy-and-paste mode was removed show as `[manual]`, with no token counts.

The plan and the messages show only in the AI tab. The player sees only the leaf transition and "The world feels different". Each prompt is sent as two system messages, the first marked `cache: true`; the AI tab shows them joined, and the API gets them first and unchanged, so Muse's automatic prompt cache can reuse them. Every message and reply is appended to the AI log with an estimated token count; a `usage:` note with the real counts follows each reply, and a note per lookup round lists its calls.

## Storage

Under `npm run dev`, storage goes through the dev server into `data/` (git-ignored):

```
data/
  systems.json              order, buildsOn, replacedBy, timestamp per system
  systems/<id>/
    manifest.json
    source.as
    module.wasm
    module.sha256
  world.json                autosaved every 5 s and when the page closes
  journal.json              "What changed" entries
  ai-log.jsonl              every planner and designer message and reply
  ai-usage.jsonl            one line per API request: real tokens, cached tokens, time (kept by Start fresh)
  ai-wishes.jsonl           one line per wish: steps, designer failures, token totals (kept by Start fresh)
```

The dev server checks every id against `^[a-z][a-z0-9_]{0,39}$` and answers 400 otherwise, keeps every resolved path inside `data/`, and never writes a file Vite would treat as code or config.

In a built copy, manifests, sources, the world, the journal and the AI log live in `localStorage` (`atw.systems`, `atw.world`, `atw.journal`, `atw.aiLog`, plus `atw.aiUsage` and `atw.aiWishes` for the stats), and compiled modules are cached in IndexedDB (`atw`), keyed by source hash and recompiled from source when missing.

At startup the base systems load, then every stored AI system in order (skipping replaced ones), each through the Module stage again so a tampered binary is still validated and metered. A system that fails is skipped with everything that builds on it, and the dev panel lists it. "Start fresh" in the Pipeline tab deletes everything saved and reloads with only the base game.

## Decisions the original kickoff didn't specify (kept)

- Footprints extend upward from `pos` (the bottom-left tile), matching bottom-left sprite anchoring.
- The clock advances only while `daynight` is loaded; the day count goes up when the clock crosses dawn (05:00).
- Phase hours: dawn 05-07, day 07-17, dusk 17-20, night 20-05. A full day is 144 real seconds at 1x.
- If a window is smaller than the native 480x348, the canvas scales fractionally below 1x instead of cropping (whole-number scale otherwise).
- The pack copy in `public/assets/` has no `Ui/Font/NormalFont.ttf`, so the HUD tries that path and falls back to monospace; digit cells are fixed-width either way.

## Decisions the spec didn't cover

- **Placement guards.** `spawn`, `place` and `tile.stamp` move a blocked placement to the nearest spot where the whole footprint fits, unless the request passes `exact: true`, in which case it is denied. Nothing can be placed onto the player's tile, and a crate spawned there lands beside the player. `space.find` (closest free w x h block) and `tile.stamp` (a block of tiles at once, `null` cells left alone) were added for this.
- **Load re-runs the World check** on the live world. If the world changed since the check and it now fails, the Load is refused and the designer gets a World check repair message, which counts as one of its repairs.
- **Map images.** The designer also gets a `{{MAP_IMAGE}}` slot: daylight maps with a tile grid and coordinates of the current area and the newest ones, at most 4 (`MAP_IMAGE_MAX_AREAS`), offered as "Download maps" in the AI tab.
- **Re-creation in the World check** runs the re-created module for 60 more ticks (`worldCheckResumeTicks`).
- **Host-call limit outside a call.** The 100,000 host calls per invocation also apply per system per tick for anything not inside an invocation.
- **Extra request limits** for things the spec left open: names in requests at most 64 characters, the overlay at most 6 lines, one `fx.particles` request at most 32 particles, a HUD slot at most 30 characters wide, `sim.walk` at most 100 steps, module abort messages cut at 4,096 characters. All are in `src/tuning.ts`.
- **Fuel is shared down an emit.** A reactor reached through `emit` runs on the emitter's fuel, and a trap in the reactor rolls back the emitter's whole call; the strike goes to the system that trapped.
- **Traps during tests** fail the test instead of counting as strikes.
- **Fixture entity names.** The campfire fixture registers its pit as the entity type `campfire` (drawn with the `firepit` sprite) and its flame as `campfire_flame`.
- **Two extra fixtures** for succession: `campfire_v2` (replaces `campfire`: a wider, brighter fire that burns longer on later days) and `fireside_cat` (builds on `campfire`). `campfire` keeps a count of fires lit in its state for the hand-over.
- **Module start.** The binary has no start section; the host calls the exported `__atw_start` once, under fuel, right after instantiating, so the module's top-level code is metered too.
- **Cold start.** On the first `npm run dev` load the screen stays dark for a few seconds while Vite prepares the modules and startup re-checks stored systems; the first frame draws once that finishes.
