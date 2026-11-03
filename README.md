# All the World

A small 2D top-down browser game that grows while it is played. The player types a wish, a planner AI splits it into a few small systems, a designer AI writes each one as a manifest plus an AssemblyScript module, an automatic pipeline checks it, and it goes live in the running game. No person reviews anything: the pipeline and the sandbox are the approval.

Vite, TypeScript, plain Canvas 2D (no game framework), Vitest. The design is [docs/spec.md](docs/spec.md); the prompts are [src/ai/prompts/designer.md](src/ai/prompts/designer.md) and [src/ai/prompts/planner.md](src/ai/prompts/planner.md), and the pillars are [src/ai/pillars.md](src/ai/pillars.md).

## How to run

```sh
npm install
cp .env.example .env.local  # then set MUSE_API_KEY in .env.local
npm run dev         		# http://127.0.0.1:5173/
npm test            		# every test, including every fixture through the pipeline
npm run typecheck
npm run build       		# typecheck, then a static build in dist/
```

On the first `npm run dev` load the screen stays dark for a few seconds while Vite prepares the modules and startup re-checks stored systems; the first frame draws once that finishes.

## How to play

| Key | What it does |
| --- | --- |
| Arrows or WASD | Tap to turn, hold to walk. Walking into a crate or log pushes it |
| E or Space | Runs the highlighted action shown above what you face ("E: Pick up") |
| Q | Cycles the other matching actions ("E: Chop ‹1/2› Q"). Turning or stepping resets to the default |
| Escape | Ends any system's hold on the controls (a mini-game, a cutscene, a chop). Nothing can block it |
| F, Enter, or a click on "F Wish" in the bottom bar | Opens the wish box. While it is open every key types into it and none reach the game. Enter makes the wish (sent through the Muse API, the same path as the AI tab's Start), Escape closes it and keeps the text |
| C, or a click on the game | Opens and closes "What changed": the title, summary, changes and journal of each update. A setting in the AI tab turns it off |

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
| `devserver/` | The Vite plugins for `npm run dev`: `storage.ts` serves `/__data` for storage, `ai.ts` proxies the Muse API at `/__ai` and holds the key, and `sdkref.ts` builds the SDK reference text the designer reads |
| `fixtures/` | Systems sent through the pipeline as text, exactly as AI output would be. Never loaded at startup |
| `src/tuning.ts` | The feel values and the limits, each with a comment |

An AI system can only call `host.call` and use its own memory. Each call into it is a transaction with a fuel budget: if it traps, runs out of fuel or runs out of memory, the world is rolled back and the system gets a strike. Three strikes in a minute unload it and everything that builds on it.

## Storage

Under `npm run dev`, saved systems, the world, the journal, the AI log and the AI stats live in `data/` (git-ignored). In a built copy they live in the browser's `localStorage`, with compiled modules cached in IndexedDB.

## Dev

Everything below is for working on the game; players don't need it.

### Dev controls

| Key | What it does |
| --- | --- |
| Backtick | Opens and closes the dev panel (it sits to the right of the map and swallows game input while open) |
| T | Time speed 1x, 4x, 16x |
| Shift+R | Re-creates every loaded system module, keeping the world |

URL aids: `?dev=1` opens the dev panel, `?time=night|dusk|dawn|day` jumps the clock on load, `?submit=<fixture>` sends a fixture (`campfire`, `chop`, `bad_loop`, ...) through the pipeline on load.

### The pipeline

The Pipeline tab has one button per fixture and shows the six stages below as they run, with the report, the loaded and skipped systems, Undo and Start fresh. Start fresh deletes the saved systems, the world, the journal and the AI log, and reloads with only the base game; the two AI stats files are kept.

`submitSystem(manifestJson, source)` runs these stages in order and stops at the first failure. Stages 1 to 5 run in a Web Worker on a copy of the world; the live game is untouched until Load.

| # | Stage | Passes when |
| --- | --- | --- |
| 1 | Manifest | The schema is valid, the id is new, every named sprite, type, component and event exists or is declared, emitted events carry the system's prefix (or are inherited through `replaces`), and `buildsOn` and `replaces` name loaded systems |
| 2 | Compile | asc compiles the module with the fixed settings. Errors carry the line and source text |
| 3 | Module | The loader accepts it: valid WebAssembly, imports exactly `host.call` and `env.memory`, exports that cover the manifest, and the fuel meter understands every opcode |
| 4 | Tests | The system's own `test_*` exports pass on a fresh copy of the real map, then the tests of the loaded AI systems it could affect still pass with it loaded (systems it shares nothing with are skipped) |
| 5 | World check | It loads into a copy of the live world and runs 300 ticks without a trap; the player can still walk, pick up and drop; invariants hold; the world round-trips through save and load; and the module can be re-created mid-run |
| 6 | Load | The leaf transition plays, the world is snapshotted, the system is added and its `migrate` runs, it is saved, and the player sees "The world feels different". Undo in the dev panel reverses the most recent load |

A failure produces a Report. The designer gets it back as the repair message, which names the stage and the problem (for example `entities.dragon: sprite "dragon_huge" isn't in the catalog`).

A new system can retire a loaded AI system by listing it in `replaces`. It must emit every event the old one emitted, systems that built on the old one keep working against the new one, and Undo brings the old one back.

### The AI tab

The tab runs a wish through the Muse API (via the dev server) and shows everything behind the scenes. It is read-only apart from the "Player wish" box and Start, and the "What changed" on/off setting.

- The planner's message and reply: the plan, which appears nowhere in the game.
- For each step, the designer's message for every attempt (the first try and any repairs), its lookup rounds (each tool call with a short summary of its result), its reply, and a row of stage boxes that light up as the pipeline runs.
- Real token usage next to each message, such as `in 12,345 (cached 11,000) · out 2,100 (reasoning 1,500) tokens`.
- The AI log: every message and reply with an estimated token count, and a `usage:` note with the real counts after each reply.

### Reviewing test rounds

Every wish writes stats to two files in `data/` (`src/ai/stats.ts`). Start fresh keeps them, so several rounds can be compared; delete the files to start counting again.

- `ai-usage.jsonl`: one line per API request, with the wish, role, step, attempt, model, input tokens, cached input tokens (and the cached share), output tokens (reasoning included), the time it took, and whether it failed. A reply cut off at `maxTokens` still counts, since it cost tokens.
- `ai-wishes.jsonl`: one line per wish when it ends. It has the status, how many steps the planner gave, and for each step how many designer attempts failed before its system loaded, and at which stage. It also has the token totals for the planner, the designer and the whole wish, from the wish going in to its last system loading.

`npm run ai-report` prints a summary of every wish, then totals: average designer failures before a load, failures by stage, tokens per role and per model, and the cache hit rate. `-- --last 5` shows only the last 5 wishes, and `-- --requests` lists every request under its wish. In the AI tab, the AI log also shows a `wish total:` line when a wish ends. Wishes logged before the copy-and-paste mode was removed show as `[manual]`, with no token counts.
