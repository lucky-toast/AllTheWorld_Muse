# All the World: rebuild spec

Nov 1, 2026 · single source of truth for the rebuild

This file merges every architecture decision made so far: the original kickoff and pipeline prompts, the sandbox design, the sandbox implementation guide, the planner and designer guide, and the later decisions (no director, player wishes, succession with `replaces`). Where those older documents disagree with this one, this one wins. If something here turns out to be impossible or much harder than expected, stop and report it rather than inventing a workaround.

Three companion files live in the game source, and the game reads them as they are:

- `src/ai/prompts/designer.md`: the designer prompt template.
- `src/ai/prompts/planner.md`: the planner prompt template.
- `src/ai/pillars.md`: the design pillars.

Toast owns the wording of all three. Don't reword them. If a slot or instruction doesn't fit the code, flag it in your final report instead of editing the text.

---

## 1. What the game is

"All the World" is a small 2D top-down browser game that grows while it is played. The player types a wish. A planner AI splits it into a few small systems, a designer AI writes each one as a manifest plus an AssemblyScript module, an automatic pipeline checks it, and it goes live in the running game. No person reviews anything. The pipeline and the sandbox are the approval.

### Principles

1. **No way out.** An AI system is AssemblyScript compiled to WebAssembly. Its only import is one host call, so it can't touch the page, network, storage, dev server or disk.
2. **Every effect is a request.** A system asks the host for every read and write. The host checks each request and can say no. Bad code gets denied, not crashed.
3. **Open by default.** Any system may read and change any entity, component, tile or event, including ones other systems made. Building on earlier systems is the point. Only a short list of game-breaking actions is blocked.
4. **Match as data, act as code.** What triggers a system is plain data in its manifest. What it does is ordinary code. There is no condition syntax.
5. **One press, one action, nothing hidden.** E is the only action key and the engine decides what it does. Q cycles every other matching action, so none is ever hidden. Systems never claim keys.
6. **Bounded work.** Every call has an instruction budget (fuel) and caps on what it can spawn or show.
7. **Automatic recovery.** Every call is a transaction that rolls back on failure. A system that keeps failing is unloaded with its dependents. A snapshot taken at load can undo a whole system.

### Rules for the coding agent

- Work one phase at a time, in the order of the phase prompts. Each phase ends with `npm run typecheck` and `npm test` green, the game playable in `npm run dev`, and one commit pushed.
- Keep it minimal. Don't add features this spec doesn't ask for.
- Every limit and feel value goes in `src/tuning.ts`, each with a one-line comment.
- The old code at commit `24531c5` on `muse-wonder-1.0` is reference material. Reuse it wherever this spec doesn't change the behaviour (read it with `git show 24531c5:<path>`). Section 2 lists what to carry over.
- Tests are deterministic: the same result on every run.

---

## 2. Carry over from commit `24531c5`

| Keep | How |
| --- | --- |
| `public/assets/**` (Ninja Adventure pack, CC0) | Unchanged |
| `src/catalog.json` (106 sprites) | Unchanged. Nothing outside it is ever drawn |
| `src/world/map.ts`, `src/world/types.ts` | Same layout, same types, same seed. Port the calls to the new engine. The map must look identical |
| `src/tuning.ts` feel values | Same values (walk pace, slide, tap-to-turn, phases, lighting, player light, banner). Add the new limits from section 15 |
| `src/engine/render.ts` | Port sprite drawing, y-sorting, lighting, HUD and sprites tab. Add the E prompt and the overlay |
| `src/engine/input.ts` tap/hold timing | Same feel. The routing changes (section 7) |
| `src/engine/catalog.ts` | Unchanged apart from imports |
| `index.html`, `src/style.css` | Reuse |
| `src/ai/provider.ts` (`MuseProvider`) | Reuse, add `cache?: boolean` to `ChatMessage` |
| `src/ai/changed.ts` ("What changed" panel) | Reuse |
| The README's "Decisions the kickoff didn't specify" | Keep those behaviours (footprints extend upward from `pos`, day count goes up at dawn, phase hours, fractional scale below 1x, font fallback) |

Dropped, and must not come back: `SystemDef` with `on` handlers, `contract.claims`, `contract.hooks`, the `handled` flag, `input.*` events, the `busy` tag, the `use` system and `entity.used`, `new Function` and `eval`, the TypeScript transpile of AI code, the static denylist, the replay check, the visual check (screenshots sent to the model), the director (`director.ts`, `director.md`, `mapimage.ts`, `DirectorEntry`), and `data/systems/<id>.ts` storage.

---

## 3. Base game

These requirements come from the original kickoff and still hold.

**Stack.** Vite, TypeScript, plain Canvas 2D, no game framework, Vitest. 16 px tiles, a native 480x348 canvas (320 px map plus a 28 px HUD) scaled up with `imageSmoothingEnabled = false` set again after every resize.

**Loop.** Fixed 60 ticks per second for logic, separate render loop. All game logic runs in ticks, never wall-clock time.

**World state** (engine-owned, only the host dispatcher writes it):

- Entities: numeric id (from 1, never reused), `type`, `pos` (bottom-left tile, or `null` while lifted), tags, components (plain JSON). Tags and components share one namespace.
- Entity types: one registry. Base map types (from `src/world/types.ts`) plus every loaded system's `entities`. `spawn` only accepts a registered type. Footprints come from the catalog (`{x?, w, h}` from `pos`, extending upward; default 1x1).
- Tiles: a grid of terrain sprite ids. Walkability and `water` come from catalog tags. The map edge always blocks.
- Occupancy: a tile-to-entities lookup, updated on every move, place, lift, destroy and sprite change. All collision goes through it.
- Free tile for entity X: walkable terrain and no `player`, `solid`, `pushable` or `item` entity other than X. Decorations don't count.
- Clock: day (starts at 1, increments at dawn), hour (0 to 24, fractional), phase (dawn 05 to 07, day 07 to 17, dusk 17 to 20, night 20 to 05). A full day is 144 real seconds at 1x. The clock advances only while `daynight` is loaded.
- RNG: one seeded stream per system (section 4.6). The engine's own randomness uses its own stream.
- `serialize()`/`deserialize()` of the whole world (entities, tiles, clock, per-system state, RNG positions, ownership records), plus `snapshot()`/`restore()`.

**Rendering order:** terrain, then entities with a `sprite` component (`{ id, anim?, frame?, z?, offset? }`) sorted by catalog layer (ground, object, above, overlay), then by y, then by `z`; then the held item drawn above the player; then particles and float text; then lighting; then screen tint; then the E prompt; then the overlay panel; then the banner; then the HUD. Moving without `instant` slides over the step time. Sprites with `dirs` play the walk anim and pick the column from `facing`.

**Lighting.** A darkness layer whose strength and colour follow the time of day: a pale dawn, a neutral day, a warm golden dusk and a deep blue night that is dark enough to want light. Any entity with a `light` component (`{ radius, color, strength, flicker? }`) cuts a soft glow, and overlapping lights add up. Port the old renderer's approach.

**HUD.** A bar below the map. On the left a clock in 10-minute steps (7:40 PM), the phase name with the time speed when not 1x, the day number, and a day bar with phases shaded and a marker. On the right, slots systems add with `ui.hud.add`. Text never shifts layout: every slot reserves its widest value and digits draw in fixed-width cells. Pixel font from the pack path with a monospace fallback.

**Screen fit.** Map and HUD always fully visible, no camera, no scrolling, the largest whole-number scale that fits (fractional below 1x), centered, re-fit on resize and when the dev panel opens (the panel sits to the right and never covers the map). `overflow: hidden`.

**World.** The same hand-made 30x20 forest clearing as today: an organic sunlit meadow, a forest border of varying depth, one short stream near the south edge, sparse interior trees and rocks, light decoration, 2 `log_fallen` (item and pushable), 1 `crate` (pushable), a few `branch` and `stone` items, and the player at (15, 11) facing down. No light sources except the player's faint glow. No hunger, health or survival stat.

**Areas.** The world is a set of areas, and systems can add new ones (a cave, a grove, a house inside). The clearing is the base area, `clearing`. Every area is the same 30x20 size, so the screen fit, renderer and HUD stay as they are and there is no camera. Only the player's current area is drawn and used by the E resolver; every area keeps simulating, and the clock and lighting are shared.

- An entity's position is `{ x, y, area }`. Requests that take a tile accept an optional `area`, defaulting to the player's current area.
- `area.create` makes a new area filled with one terrain sprite. Its id must start with the creating system's id (`cave.entrance`), like event names. A system then shapes it with `tile.set` and `spawn`.
- `travel` moves the player to a tile in another area (or the same one). It is the only way any system moves the player, and it is denied unless the target tile is free for the player. A door is just an entity with an "Enter" interaction whose `perform` calls `travel`.
- The engine emits `player.traveled` after every travel. Holding focus doesn't block travel.
- Serialize, snapshot, invariants and occupancy cover every area. Unloading a system keeps its areas.

**Feel.** Calm and deliberate, like early Zelda, Pokémon or Stardew Valley. Keep the old tuning values.

**Dev keys** (all call `preventDefault()`, as do arrows, WASD, Space, E, Q and Escape):

- T cycles time speed 1x, 4x, 16x.
- Shift+R re-instantiates every system module from storage without losing the world or duplicating anything.
- Backtick toggles the dev panel (section 13.6).
- C toggles the "What changed" panel. Clicking the game also opens it.
- URL aids: `?dev=1` opens the panel, `?time=night|dusk|dawn|day` jumps the clock on load, `?submit=<fixture>` sends a fixture through the pipeline on load.

---

## 4. Engine and host

### 4.1 One dispatcher

Every world access, by AI modules and by base systems, goes through one entry point: `host.call(systemId, request) → response`. Base systems are trusted TypeScript and call it with plain objects. AI modules call it through the WebAssembly import with UTF-8 JSON. Both take the same path, with the same checks.

Requests are `{ "op": "<name>", ...fields }`. Responses are `{ "ok": true, "r": <result> }` or `{ "ok": false, "code": "<code>", "msg": "<readable reason>" }`. Codes: `bad_request`, `denied`, `missing` (entity gone), `limit`, `phase`. A denial never crashes the module; it is logged.

Entities are numeric ids everywhere. No handle or object reference ever reaches a system. The host passes in only the ids a call is about (target, held, event fields). No world snapshot is ever pushed to a system.

### 4.2 Requests

Additions beyond the original design draft are marked ⁺. They fill gaps the draft left.

| Kind | Request | Fields → result |
| --- | --- | --- |
| Read | `query` | `with` (tag or component) → `{ ids, truncated }` |
| | `at` | `x, y` → ids whose footprint covers the tile |
| | `info`⁺ | `id` → `{ type, pos, tags }` |
| | `get` | `id, comp` → value or `null` |
| | `tile.get` | `x, y` → `{ sprite, tags }` or `null` outside the map |
| | `tile.find` | `tag` → positions |
| | `catalog.get` | `id` → catalog entry |
| | `catalog.find` | `tag` → sprite ids |
| | `time` | → `{ day, hour, phase }` |
| | `rand` | → number in [0, 1) from the caller's own stream |
| | `state.get`⁺ | → the caller's saved state (JSON) or `null` |
| | `state.getReplaced` | `id` → saved state of a system this one replaces. Only during `migrate` (section 11) |
| Write | `spawn` | `type, x, y` → id |
| | `destroy` | `id` |
| | `move` | `id, x, y, instant?` (slides unless `instant`) |
| | `lift`, `place` | `id` / `id, x, y` |
| | `set`, `remove` | `id, comp, value` / `id, comp` |
| | `tag`, `untag` | `id, tag` |
| | `anim` | `id, name, callback?` (plays a sprite anim; `onTimer(callback)` when a non-looping anim ends, or after one loop of a looping one) |
| | `tile.set` | `x, y, sprite` |
| | `state.set` | `value` (replaces the caller's whole state) |
| Event | `emit` | `name, payload` |
| Timer | `timer` | `ticks, name` → `onTimer(name)` later |
| Controls | `focus`, `release` | `mode: "borrow" \| "freeze"` / none |
| Areas⁺ | `area.create` | `name, fill` → area id (`<systemId>.<name>`) |
| | `area.list` | → area ids |
| | `area.current` | → the player's area id |
| | `travel` | `area, x, y` (moves the player; target tile must be free) |
| Effect | `fx.particles` | `sprite, x, y, count?` |
| | `fx.float` | `text, x, y, color?` |
| | `fx.tint` | `color, alpha, ms` |
| | `fx.tween` | `from, to, ticks` → tween id; progress via `onTween(id, value)` |
| | `ui.banner` | `text` |
| | `ui.hud.add`, `ui.hud.remove` | `key, text, width, icon?` / `key` |
| | `ui.overlay` | `{ title?, lines: string[], bar?: { value, label? } }` or `null`. A small engine-drawn panel at the bottom of the map. The final layout waits on Toast's asset review, so keep it plain |
| Test only | `sim.walk` | `dir, steps?` |
| | `sim.face`, `sim.interact`, `sim.cycle` | `dir` / none / none (same paths as real keys) |
| | `sim.give` | `type` → id (spawns and puts it in the player's hands, exactly as pick up does) |
| | `sim.teleport`, `sim.wait` | `x, y, area?` / `ticks` |
| | `sim.time`⁺ | `phaseOrHour` (jumps the clock, emits `time.jumped`, then runs one tick so `time.phase` has fired when it returns) |
| | `sim.key`⁺ | `key, kind` (sends a key to whoever holds focus) |
| | `check` | `cond, label` |

Putting something in the player's hands outside tests is ordinary writes: `lift` the item, then `set` the player's `held` to `{ id }`. The SDK wraps that as a helper.

### 4.3 Checks on every request, in order

1. **Shape:** known `op`, right field types, integer tiles inside the map, strings and JSON within size caps.
2. **Phase:** `sim.*` and `check` only while running tests or shots; `state.set` only for the caller's own state; `state.getReplaced` only during `migrate` of a system that lists that id in `replaces`.
3. **Blocked actions:**

| Action | Blocked |
| --- | --- |
| `destroy`, `lift`, `move`, `place` | Removing, lifting or moving the player. Only base `movement`, `travel` and the engine's `sim.teleport` move the player |
| `tile.set` | Making the tile under the player unwalkable |
| `emit` | Events the caller doesn't own |
| `fx.tint` | Alpha over 0.6, or longer than 3 s |
| `ui.*`, `fx.float` | Text over 60 characters, or non-printable characters |

4. **Budget:** fuel and the action limits in section 15.
5. **Invariants** (checked after each write): the player exists, footprints of placed entities sit on walkable tiles, occupancy matches positions. A write that would break one is denied.

A request on an entity that no longer exists returns `missing`. It is not a fault.

### 4.4 Transactions and rollback

Each call into a system (`perform`, `onEvent`, `onTick`, `onTimer`, `onInput`, `onTween`, `migrate`) is one transaction. The host keeps an undo log of every write, including writes by other systems reached through `emit` during the call. If the call traps, runs out of fuel or breaks a limit, the host replays the log backwards, drops queued effects and timers from that call, and the world is as if the call never happened. Then it records a strike (section 10.4).

### 4.5 Ownership records

The engine records which system spawned each entity and declared each entity type and component. These restrict nothing. They are used for unloading, succession and the log.

### 4.6 Randomness

Each system's stream is seeded from the world seed and a hash of its id, so adding a system never changes another system's random outcomes. Stream positions are saved with the world. Systems never see `Math.random`.

### 4.7 Logging

Log every denied request (system, op, code, msg) and any system that uses more than half of a limit in one call. Show both in the dev panel.

---

## 5. Systems

A system is a manifest (data) plus a module (code). Base systems are TypeScript objects with the same manifest and the same handler names. AI systems are a manifest JSON plus an AssemblyScript module.

### 5.1 Manifest

JSON, read once at load and frozen.

```json
{
  "id": "chop",
  "why": "Chop fallen logs with an axe to get branches.",
  "buildsOn": ["carry"],
  "replaces": [],
  "entities": { "axe": { "sprite": "axe", "tags": ["item"] } },
  "components": { "chopTicks": "number: ticks a chop takes, on the axe" },
  "interactions": [
    { "verb": "chop", "label": "Chop", "target": "log_fallen", "held": "axe" }
  ],
  "reactions": [],
  "emits": { "chop.chopped": { "pos": "pos", "log": "entity" } },
  "shots": [ { "name": "mid_chop", "ticks": 30, "focus": { "x": 12, "y": 8 }, "time": "day" } ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | `^[a-z][a-z0-9_]{0,39}$`, unique, never reused |
| `why` | One line: what this gives the player |
| `buildsOn` | Ids of loaded systems it relies on |
| `replaces` | Ids of loaded AI systems it retires (section 11). Default `[]` |
| `entities` | New entity types: `{ sprite, tags }` |
| `components` | New component names with a one-line shape description |
| `interactions` | Actions it adds to E (section 6) |
| `reactions` | Event names it responds to through `onEvent` |
| `emits` | Events it owns, each with a payload shape. Names start with `<id>.`, or belong to a system it replaces |
| `shots` | Screenshot setups: `name`, `ticks`, `focus` (with optional `area`), optional `time`. Each needs an export `shot_<name>` |

Payload shapes use `number`, `string`, `bool`, `entity`, `pos`, `list`, `object`. Entity fields may be `null`.

### 5.2 Module exports

All optional except as the manifest requires. These are the user-facing signatures in AssemblyScript. The host translates to and from the low-level ABI (section 10.2).

| Export | Called when |
| --- | --- |
| `perform(verb: string, target: i32, held: i32): void` | The player presses E and this system owns the highlighted action. `target` is the faced entity id, `0` for a tile target (use the SDK's faced-tile helper), or the held id for a `"held"` target. `held` is the held item id or `0` |
| `onEvent(name: string, payload: string): void` | An event in `reactions` fires. `payload` is JSON; entity fields arrive as `{ id, type, pos }` filled in by the host |
| `onTick(): void` | Every tick |
| `onTimer(name: string): void` | A `timer` or `anim` callback fires |
| `onInput(key: string, kind: string): void` | While holding borrow focus. `key` is `up`, `down`, `left`, `right`, `e` or `q`; `kind` is `down`, `up` or `repeat` (repeat at the walking pace while held, from the engine's own timer) |
| `onTween(id: i32, value: f64): void` | Each tick of a running tween |
| `migrate(): void` | Once, when the system loads into a world (one-time setup; must be safe to run again) |
| `test_<name>(): void` | One test each. Runs on a fresh copy of the real map from the fixed seed. Passes when every `check` passed and at least one ran |
| `shot_<name>(): void` | Setup for the shot of that name |

The module is re-created on every load, so globals don't survive. Lasting state lives in components, tags or `state.set`.

### 5.3 SDK (`src/sdk/`)

An AssemblyScript library compiled into every module, so it runs inside the sandbox with no extra power. AI code imports only from `"sdk"`. It provides:

- A typed helper for every request in 4.2 (for example `query("item")`, `spawn("branch", x, y)`, `anim(id, "burn", "lit")`, `timer(60, "done")`, `focus("freeze")`).
- A small JSON reader and writer.
- Helpers built from requests: `player()`, `facing()`, `facedTile()`, `isFree(x, y, selfId)`, `footprintFree(id, x, y)`, `giveToPlayer(id)`.
- The export glue and the `abort`, `trace` and `seed` replacements (section 10.1).

`src/sdk/index.ts` is what the designer prompt shows as `{{API}}`, so it must read as a clean reference: one-line doc comment on every exported helper, nothing internal at the top level. Document the exact ABI in `src/sdk/README.md`.

---

## 6. Interactions on E and Q

E is the only action key and the engine owns Q.

1. **Register.** At load, every manifest's interactions go into one table, indexed by target and held. Each entry keeps its owner, so two systems may use the same verb or label.
2. **Look up.** Whenever the player's position, facing, held item or the faced tile changes, the resolver queries the table. No system code runs.
3. **Show.** A one-line prompt above the target: "E: Chop". With more than one match it adds a marker: "E: Chop ‹1/3› Q".
4. **Cycle.** Q moves to the next match and wraps. Turning or stepping resets to the default.
5. **Run.** E calls `perform(verb, target, held)` on the owner of the highlighted entry, as one transaction. Afterwards the engine emits `interaction.performed`.

**Targets.** `target` is an entity type (`"log_fallen"`), an entity tag (`"#choppable"`), a terrain tag (`"tile:water"`) or `"held"`. A tile target matches when no `solid`, `pushable` or `item` entity is on the faced tile. A `"held"` target matches the item in hand whatever is faced. An entity target matches any entity on the faced tile (never the player), so decoration on the same tile never hides it; when several fit, an `item` comes first, then `pushable`, then the rest in the order they are on the tile. The faced entity (for `{{PLAYER}}` and the prompt) is the first of them in that order.

**Held.** An item type, an item tag (`"#tool"`), `"none"` for empty hands, or left out for anything.

**Default ranking.** Compare matches one rule at a time; the first rule that separates them decides. The rest follow on Q in the same order.

1. What it acts on: faced entity, then faced tile, then held item only. Drop is always last.
2. What must be held: exact type, then tag, then `"none"`, then left out.
3. How it names the target: exact type, then tag.
4. Age: the newer system wins.

**Base actions.** `carry` owns two interactions: "Pick up" on `#item` with `held: "none"`, and "Drop" on `"held"` (always ranked last). Drop places the held item in front of the player only if every tile of its footprint is free; otherwise it does nothing and floats "No room".

---

## 7. Input and focus

The engine reads the keyboard. Player input never travels as an event.

**Without focus:** arrows and WASD go to base `movement` (same tap-to-turn and hold-to-walk timing as the old `input.ts`, own timer, last-pressed wins, facing stored only in the player's `facing` component). E and Space run the highlighted action. Q cycles.

**Focus.** A system can take the controls from any handler:

- **Borrow:** arrows, E and Q go to its `onInput` instead of movement and the resolver. For mini-games.
- **Freeze:** every key except Escape is ignored. For cutscenes and waits such as a chop.

Guards: Escape always ends focus and no system can block it. Time limit 60 s for borrow and 30 s for freeze, then the engine takes the controls back. Cooldown 10 s per system after its focus ends, waived when the focus was taken inside a `perform` (the player started it with E). One holder at a time; a second request is denied. Released when the holder faults or unloads. The world keeps ticking. When focus ends for any reason other than `release`, the engine calls the holder's `onInput("escape", "down")` so it can tidy up.

**Movement feel components.** Base movement reads `moveDelay` (extra ticks per step) on the player and treats an entity tagged `slippery` under the player as "keep going one more step if free". Any system may set these.

---

## 8. Events

- **Ownership.** A system may emit only the events in its own `emits`, named with its id as a prefix, plus events it inherited by replacing a system. The engine and base systems own `player.*`, `item.*`, `entity.*`, `interaction.*`, `time.*` and `system.*`.
- **Payload check.** On emit, the host checks the payload against the declared shape. Entity fields carry ids; the host fills in each entity's real type and position before delivery, so a payload can't lie about an entity. A bad payload is denied.
- **Delivery.** Every system that lists the event in `reactions` gets `onEvent`, in load order, one at a time, inside the emitter's transaction. Nothing is claimed or passed along.
- **Nesting** is capped at 16 levels. Emits count toward the caller's budget.
- **Overlap log.** If two systems write the same entity while handling one event, log it (don't fail).

Base and engine events:

| Event | Payload | Fires |
| --- | --- | --- |
| `player.moved` | `from: pos, to: pos, dir: string` | After every completed step |
| `player.blocked` | `dir: string, target: pos` | When a step is blocked, before movement re-checks the tile |
| `item.picked` | `item: entity` | After pick up |
| `item.dropped` | `item: entity, pos: pos` | After drop |
| `entity.bumped` | `entity: entity, dir: string` | After push moves something |
| `time.phase` (+ `time.dawn`, `time.daytime`, `time.dusk`, `time.night`) | `phase, previous: string, day: number` | Phase change |
| `time.newDay` | `day: number` | At dawn when the day goes up |
| `time.hour` | `hour: number, day: number` | Every whole hour |
| `time.jumped` | `from: number, to: number` | When the clock is jumped |
| `player.traveled` | `from: string, to: string, pos: pos` | After every travel |
| `interaction.performed` | `verb: string, target: entity, held: entity, owner: string, pos: pos` | After every E action |
| `system.loaded`, `system.unloaded` | `id: string` (+ `reason: string` on unload) | Load, unload, succession |

---

## 9. Base systems (`src/systems/base/`)

Trusted TypeScript, same manifest format, same dispatcher. They have privileges only where section 4.3 says so (movement moves the player). Their tests run in an empty walkable 12x12 arena with test-only types (`test_item`, `test_block`, `test_pushable`) so map changes can't break them. Load order: movement, carry, push, daynight.

1. **movement.** Turn sets `facing`. A step faces that way and moves if the tile is free for the player; otherwise it emits `player.blocked`, then re-checks and steps if the tile is free now. Emits `player.moved`. Reads `moveDelay` and `slippery`. Tests: walk, turn only, water blocks, solid blocks, map edge blocks, focus blocks walking, a 1x2 log blocks on both tiles.
2. **carry.** Pick up and Drop as interactions (section 6). The player's `held` component (`{ id }` or absent) is the one place that says what is in hand, and the renderer draws the held item above the player. Emits `item.picked` and `item.dropped`. Tests: picks up a faced item, drops on a free tile, drop onto an occupied tile keeps it in hand, a log drops only where both tiles are free, Drop ranks last.
3. **push.** Reacts to `player.blocked`. If the target tile holds a `pushable` entity, it moves the whole entity one tile if its whole new footprint is free. Emits `entity.bumped`. Tests: pushes a crate, crate into a rock stays, whole log moves, log into a rock stays.
4. **daynight.** Advances the clock and emits every `time.*` event. Its `migrate` gives the player a faint `light`. Tests: phase change emits `time.phase` and the shortcut, `sim.time` emits `time.jumped`, whole hours emit `time.hour`, the player has a light, day 1 starts in the morning.

Engine-level tests (not tied to a system): the resolver ranking rules one by one, the Q cycle and its reset, every focus guard (including Escape during freeze and the cooldown waiver), one test per blocked action, rollback after a forced trap mid-call, payload correction, unowned emit denied, emit nesting cap.

---

## 10. Sandbox

### 10.1 Compile

The AssemblyScript compiler (`assemblyscript` npm package, its programmatic `asc` API with in-memory files) runs in the pipeline worker, and in Node for tests. Fixed settings, which the model can't change: imported memory with a capped maximum (16 MB), no SIMD, threads or other optional features beyond what the meter understands, the SDK as the only library, `--exportRuntime` if the ABI needs it, and `abort`, `trace` and `seed` redirected to SDK functions so the only imports left are `host.call` and `env.memory`. Check the flag names against the asc version you install and pin that version. Compile time cap 30 s.

### 10.2 ABI

One import, `host.call`, taking a pointer and length of a UTF-8 JSON request in the module's memory and returning the response the same way (the host writes it into memory through an allocator the module exports). The host calls the user-facing exports in 5.2 and handles string passing itself. You choose the exact encoding. Write it down in `src/sdk/README.md`. The `.js` bindings asc generates are never run.

### 10.3 Module loader

Runs on every load, including from storage and from the IndexedDB cache:

1. `WebAssembly.validate` the bytes.
2. Imports must be exactly `host.call` and `env.memory`.
3. Exports must have the expected names and kinds and cover the manifest: every interaction needs `perform`, every reaction needs `onEvent`, every shot needs its `shot_<name>`.
4. Rewrite the binary to add fuel metering: append a mutable i64 fuel global, and at every function entry and loop header subtract a deterministic static cost and trap at zero. Don't add or reorder functions, so indices stay valid. Reject any opcode the rewriter doesn't understand. The host sets fuel before each call and reads it after.
5. Instantiate with a fresh capped `WebAssembly.Memory` and a `host.call` bound to this system id.

Because metering is applied at load, a tampered stored binary is still metered.

### 10.4 Strikes and unloading

Each trap, fuel exhaustion or limit breach during live play is a strike. Three strikes in one minute unload the system and every system that builds on it (transitively, through `buildsOn`). There is no disabled state. Unloaded systems' entities stay in the world without behaviour. Show a banner and log it in the dev panel. Their focus, timers, tweens, HUD slots and overlay are cleared.

---

## 11. Succession (`replaces`)

Loaded code is never edited. To change behaviour an earlier AI system owns, a new system can retire it and take over.

- **Manifest checks.** Every id in `replaces` is a loaded AI system (base systems can't be replaced). Every event the replaced system emitted is in the new `emits` under the same name. Ownership of those events, including events the replaced system had itself inherited, passes to the new system.
- **Registry.** A replaced id counts as satisfied in other systems' `buildsOn` and resolves to its replacement. The replaced system's interactions, reactions, timers and focus are removed when the new one loads.
- **Tests stage.** The replaced system's own tests are dropped. Every remaining system's tests, including those of systems that built on the replaced one, run with the replacement loaded instead.
- **World check** runs on a world copy where the replaced system is unloaded and the new one loaded.
- **Load**, in one step: snapshot, unload the old module (its entities, components and tags stay, and their ownership records move to the new system), add the new system, run its `migrate`, save. The snapshot undoes the whole succession.
- **State hand-over.** During `migrate` only, `state.getReplaced(id)` returns the replaced system's saved state. Afterwards that state is deleted.
- **Storage.** Keep the replaced system's files marked `replacedBy`, so the journal and undo still work. Don't instantiate it at startup.
- **Prompts.** A replaced system's block leaves `{{AI_SYSTEMS}}`.

---

## 12. Pipeline

Everything before Load runs in a Web Worker with its own engine copy and the current world, under a watchdog that kills the worker if a stage goes over its time limit. The live game is never touched before Load. `checkSystem(manifestJson, source)` returns a Report; `loadChecked(report)` runs Load only for a passed report and refuses it if the set of loaded systems changed since the check. `submitSystem` is the two in a row.

| # | Stage | Passes when |
| --- | --- | --- |
| 1 | Manifest | Valid schema; id format and unused; sprites, types and components named exist or are declared; emitted names carry the prefix (or are inherited through `replaces`); every event in `reactions` exists (base, engine or some loaded system's `emits`, or this system's own); every id in `buildsOn` and `replaces` is loaded; the `replaces` checks in section 11 |
| 2 | Compile | asc compiles the source with the fixed settings. Type errors fail here with line and source text |
| 3 | Module | The loader in 10.3 accepts it |
| 4 | Tests | The system's own `test_*` exports, each on a fresh real map from the fixed seed, under the test fuel limit. Then every existing system's tests (base ones in their arena) with it loaded |
| 5 | World check | Load into a copy of the current world, run `migrate` and `worldCheckTicks` ticks. Any trap or exhausted budget fails. Then the player can still walk, pick up and drop (scripted with sim on that world), every placed footprint sits on walkable tiles, occupancy matches, the world serializes and deserializes, and the module can be re-created mid-run from saved state and keep ticking. Overlapping writes are logged, not failed |
| 6 | Shots | Each shot's setup and ticks run on a fresh copy, then render with lighting to an OffscreenCanvas, cropped to about 9x7 tiles around `focus` and zoomed 3x, as PNG data URLs for the log. A render failure is logged and doesn't block. Shots are never sent to the model |
| 7 | Load | Section 13.1 |

**Report:** `{ ok, stage, systemId, errors, shots, durationMs }`. Each error has `message`, and where it applies `line`, `sourceLine`, `test`, `checks` (every named check with `label` and `passed`), `events` (last 100 as `{ tick, name, payload }`), `denied` (requests denied during the test), `entities` (type, pos and components of what the system spawned, plus the player, at the end). The repair message renders this as readable text.

---

## 13. Live game, storage and AI

### 13.1 Load

Pause ticks and input, play the ~2 s leaf transition (`fx_leaf` swirling across a soft fade), and while the screen is covered: snapshot the live world, add the system to the registry, instantiate it, run `migrate`, save it, emit `system.loaded`. Fade back and show "The world feels different". If anything throws, restore the snapshot and fail the stage. Reject a load whose id already exists. The dev panel's Undo button restores the most recent load's snapshot, unloads that system (or brings back the system it replaced), and removes it from storage.

### 13.2 Storage

- **Dev server:** `data/systems/<id>/` holding `manifest.json`, `source.as`, `module.wasm` and `module.sha256`, plus `data/systems.json` (order, buildsOn, replacedBy, timestamp), `data/world.json`, `data/journal.json`, `data/ai-log.jsonl`, and the AI stats `data/ai-usage.jsonl` and `data/ai-wishes.jsonl` (section 13.5). Every endpoint validates the id against `^[a-z][a-z0-9_]{0,39}$` before any file operation and returns 400 otherwise. Resolve each final path and confirm it stays inside `data/`. Never write a file Vite would treat as code (`.ts`, `.js`, `.mjs`, config files).
- **Built copies:** manifests, source and order in `localStorage`. Compiled modules cached in IndexedDB keyed by source hash, recompiled from source when missing. No screenshots in `localStorage`.
- **Startup:** base systems, then every stored AI system in order (skipping ones marked `replacedBy`), each through the Module stage again (validation and fresh metering) before it runs, with no transition. A system that fails is skipped along with everything that builds on it, and the skipped list shows in the dev panel. Then restore the saved world. The world autosaves every 5 s and on unload.
- **Start fresh** (dev panel) deletes saved systems, world, journal and log (not the AI stats), then reloads with only the base game.

### 13.3 Designer (`src/ai/designer.ts`)

Builds the prompt from `src/ai/prompts/designer.md` (the companion file; it has a `# System message` section and a `# Repair message` section). Slots:

| Slot | Content |
| --- | --- |
| `{{PILLARS}}` | `src/ai/pillars.md` |
| `{{API}}` | The text of `src/sdk/index.ts` |
| `{{PICKED_TAGS}}` | After the cache breakpoint: the step's planner tags or entry ids, comma-separated, as hints for the designer's lookups; `(none)` without any. A step with no tags uses the tags and ids its text names. |
| `{{WORLD_SPRITES}}` | After the cache breakpoint: the ids of the sprites already in the world (entity sprites and map terrain). |
| `{{SYSTEM_EXAMPLES}}` | Every manifest and module pair in `src/ai/examples/`, sorted by name, as a fenced `json` and a fenced `ts` block. Seed it with the campfire and chop fixtures until Toast writes the final three examples. These are never loaded into the world |
| `{{BASE_SYSTEMS}}` | One system block per base system, in load order |
| `{{AI_SYSTEMS}}` | One block per loaded, not-replaced AI system in load order, except the newest |
| `{{NEWEST_AI_SYSTEM}}` | The newest AI system's block, or an empty string |
| `{{ENTITY_COUNTS}}` | `- type: n` per entity type, sorted by count descending, then by name, under one `area <id>:` line per area (current area first, then the rest in creation order) |
| `{{TASK}}` | The planner step being built |
| `{{STAGE}}`, `{{REPORT}}` | Repair message only |

**Catalog tools.** The designer prompt lists no catalog entries; its "Looking things up" section, above the cache breakpoint, says to look them up. Every designer request carries four function tools (`src/ai/tools/`), always the same definitions in the same order so they stay in the cached prefix. `catalog_search` finds entries by tags (all of), `any_tags` (one of), words in the id, description or tags, kind and layer; it returns one short line per variant group, paged by `offset` and `limit` (default `CATALOG_SEARCH_LIMIT`, at most `CATALOG_SEARCH_MAX`), and searches a name that isn't a tag as a word. `catalog_get` returns the legend and the full catalog line for up to `CATALOG_GET_MAX_IDS` ids; unknown ids get the closest ids. `catalog_tags` lists tags with counts, optionally those containing a text. `entity_types` lists the entity types registered in the world (name, sprite, tags, who registered it, how many exist), optionally by name or sprite text and by tag; the prompt tells the designer to check every type it spawns, gives or targets with it. Results are cut at `TOOL_RESULT_MAX_CHARS`, and bad arguments get a message, never an error. A reply that calls tools gets one result per call and is sent again, until a reply calls none; that reply is the attempt's. Each tool round is one API call in the usage log, a note in the AI log, and a line in the AI tab's attempt box listing each call and a short summary of its result; the box keeps the attempt's message and shows only the final reply. Rounds are counted per step: past `LOOKUP_ROUNDS_PER_STEP` every call gets "no more lookups" instead of a result, and an attempt still calling tools `LOOKUP_GRACE_ROUNDS` rounds later fails at the "Lookups" stage and gets the repair message.

**System block.** Built from the manifest only, byte-identical every time for the same manifest. Write `(none)` for an empty list.

```
## System: <id>
why: <why>
buildsOn: [<ids>]
replaces: [<ids>]
interactions:
  - <verb> "<label>" on <target>, held <held or "anything">
reactions: [<event names>]
emits:
  - <event>: <payload shape as compact JSON>
components:
  - <name>: <shape>
entity types added:
  - <type>: sprite <sprite>, tags [<tags>]
```

**Cache split.** `buildPrompt` returns `cached` (everything above the `<!-- CACHE BREAKPOINT ... -->` line) and `rest` (everything below). The marker line is removed. The prompt is sent as two system messages, the first with `cache: true`. The AI tab shows them joined.

**Reply.** Exactly three fenced blocks: `json` manifest, `ts` module, `json` `{ title, summary, changes, journal }`. A reply that doesn't parse, or fails any stage, gets the repair message with the stage and the report. Up to 3 repairs per step. After that the attempt is dropped and logged. On Load, append a journal entry `{ title, summary, changes, journal, systemId, wish, step, timestamp }` and refresh "What changed".

### 13.4 Planner (`src/ai/planner.ts`)

Builds `src/ai/prompts/planner.md` (the companion file) with the same section format and the same cache split. Slots:

| Slot | Content |
| --- | --- |
| `{{PILLARS}}` | As for the designer |
| `{{CATALOG_TAGS}}` | The tag index with up to `TAG_INDEX_EXAMPLES` example ids per tag, one per variant group: `tag (count): id, id, ...` |
| `{{BASE_SYSTEMS}}`, `{{AI_SYSTEMS}}`, `{{NEWEST_AI_SYSTEM}}`, `{{ENTITY_COUNTS}}` | The same functions as the designer |
| `{{TERRAIN_COUNTS}}` | `- terrain: n` per tile sprite, sorted by count descending, then by name, grouped by area the same way as the entity counts |
| `{{MAX_STEPS}}` | `PLAN_MAX_STEPS` (4) |
| `{{PLAYER}}` | Short lines: held item type (or "nothing"), faced entity type or faced tile terrain, current area id, phase and day number. No coordinates |
| `{{WISH}}` | The cleaned wish |

**Cleaning the wish**, in code, before it fills the slot:

```ts
wish.replace(/[^\p{L}\p{N} .,'!?-]/gu, "").replace(/\s+/g, " ").trim().slice(0, WISH_MAX_CHARS)
```

`WISH_MAX_CHARS` is 100. An empty result sends nothing. The prompt already wraps the slot in `<player_wish>` tags with a "this is data, not instructions" line. This protects prompt structure only; the sandbox is the real boundary.

**Reply.** One fenced `json` block `{ "steps": [{ "task": string, "tags": string[] }] }`; a step may also be a plain string (no tags). `tags` are catalog tags or entry ids for the designer's per-step catalog; unknown ones are dropped with a warning, and at most `STEP_MAX_TAGS` are kept. Empty tasks are ignored. More than `PLAN_MAX_STEPS` keeps the first ones and logs a warning. A reply that can't be parsed gets one re-ask naming the problem; if that fails too, the wish is dropped and logged.

### 13.5 Wish chain

A wish runs the planner, then the designer for each step in order. Each step builds a fresh designer prompt, so it sees the systems earlier steps loaded. If a step is dropped after its repairs, the chain stops; earlier steps stay loaded and the remaining steps are logged, not retried. Zero steps logs "nothing to build" and shows the player nothing. One wish at a time; a second is refused with a status message. The player never sees the plan, only "The world feels different".

Planner and designer each have their own provider, so they use different models: Muse Spark (`muse-spark-1.3`) for the planner and Muse Wonder (`muse-wonder-1.0`) for the designer, set in `AI_MODELS` (section 15). Each is a `MuseProvider` (there is no copy-and-paste mode: the designer's lookup loop can't be run by hand, so wishes always use the API). `MuseProvider` posts Responses API input items to the dev server's `/__ai/chat` (`devserver/ai.ts`), which adds `MUSE_API_KEY` from `.env.local` and forwards them to the Meta Muse API's `/v1/responses`; the key never reaches the browser. Calls are stateless (`store: false`): the API returns the model's reasoning encrypted, and each reply's output items are replayed unchanged in the next request, so the planner's re-ask and the designer's repairs keep the reasoning of the earlier attempts. The two system messages go first and unchanged, as developer items, so the API's automatic prompt cache reuses them, followed by a fixed user turn that carries the map images. A reply cut off at its output cap, or any API error, rejects the send; the chain then ends with status "error", logs the error, and earlier steps stay loaded. Every sent message and reply is appended to `data/ai-log.jsonl` with role, chars and an estimated token count (chars ÷ 4); a note with the real token usage follows each reply. For reviewing test rounds, `data/ai-usage.jsonl` gets one line per API request (role, step, attempt, model, input, cached input, output and reasoning tokens, time, failed or not), and `data/ai-wishes.jsonl` gets one line per wish when it ends (status, steps planned and loaded, designer failures before each system loaded and at which stage, and token totals for the wish). `npm run ai-report` summarizes both.

### 13.6 Dev panel

Backtick toggles it. It swallows game input while open and sits to the right of the map.

- **Sprites tab:** every catalog sprite at 4x on a grass tile with its outline, playing its first anim (the old `renderSpritesTab`).
- **Pipeline tab:** one button per fixture, a row of 7 stage boxes (grey, amber while running, green, red; time on each; a red box shows its errors on click), the report with shots, loaded systems, skipped systems, the denial, near-limit, strike and overlap log, Undo, and Start fresh.
- **AI tab:** a "Player wish" box and Start, and a "What changed" on/off setting. Start is disabled, with a hint to set `MUSE_API_KEY` in `.env.local`, when the dev server has no key. Then the planner's message and its reply; then for each step and attempt the designer's message, its lookup rounds (each call with a short summary of its result, and the round's token usage), its reply and a row of stage boxes. Everything is read-only, and the real token usage shows next to each message's size. The in-game wish box takes the same path. The plan shows here only.

---

## 14. Fixtures (`fixtures/`)

Each fixture is a folder with `manifest.json` and `module.ts` (AssemblyScript). They are never loaded at startup; they go through `submitSystem` as text, as AI output would. `npm test` runs every fixture through the pipeline and checks its expected outcome.

**campfire** (good). Reacts to `item.dropped`. When a third `branch` lies on adjacent tiles, the branches become a 2x2 `firepit` (solid) whose footprint covers the middle branch's tile, placed where all 4 tiles are free, with an `fx_fire` flame on the same tile at a higher z (8x12 flame centered on the pit, bottom edge 18 px below the pit's top edge), playing ignite then looping burn. Warm flickering `light`. Emits `campfire.lit`. Burns for part of a night (a component, not a constant), then the flame plays die, the light fades, the pit becomes `firepit_ash` (not solid), and it emits `campfire.out`. Tests: three branches make a fire, two don't, the fire has a light, it burns out to ash, the player can't walk through a lit fire. Shots: just lit at night, and the ash ring. Shot setups build the fire with sim like a player would.

**chop** (good). Declares an `axe` item type; `migrate` places one axe beside the `stump_big` if there is none. Interaction "Chop" on `log_fallen` while holding `axe`. `perform` takes freeze focus, plays a short chop with `fx_wood` particles and a timer callback; `onTimer` checks the log still exists, destroys it, spawns two `branch` items on free tiles nearby, emits `chop.chopped`, and releases focus. Tests: chopping turns a log into branches, without the axe "Chop" isn't offered (Pick up is the default), Escape during the chop leaves the log intact and focus released, and with an axe in hand facing a log the default is Chop with Drop on Q (Pick up isn't offered because the hands are full).

**Bad fixtures**, one per stage. Each must fail at exactly that stage with a readable message:

| Fixture | What's wrong | Fails at |
| --- | --- | --- |
| `bad_manifest` | Declares an entity whose sprite `dragon_huge` isn't in the catalog | Manifest |
| `bad_prefix` | Emits `fire.lit` without owning it | Manifest |
| `bad_types` | Calls a helper that doesn't exist in the SDK | Compile |
| `bad_export` | Lists an interaction but has no `perform` | Module |
| `bad_test` | Its test checks for a spark the system never spawns | Tests |
| `bad_breaks_base` | Its `migrate` turns the four tiles around the player into water, so the player can't walk | World check |
| `bad_loop` | `onTick` enters an infinite loop on its 50th tick | World check (fuel trap, game keeps running) |
| `bad_memory` | Allocates without bound in `onTick` | World check (memory trap) |

Also test the Module stage directly with hand-built binaries: an extra import, and a missing export, are both rejected.

---

## 15. Tuning (`src/tuning.ts`)

Keep every old feel value. Add:

| Name | Value | When hit |
| --- | --- | --- |
| Fuel per live call (`perform`, `onEvent`, `onTick`, `onTimer`, `onInput`, `onTween`, including nested emits) | 50M units | Trap, rollback, strike |
| Fuel per `migrate`, test or shot | 500M units | Check fails |
| Memory per module | 16 MB | Allocation fails, trap, rollback, strike |
| Host calls per invocation | 100,000 | Denied |
| Request and response size | 64 KB each | `bad_request` |
| Entities returned per `query` | 5,000 | Truncated, with a flag |
| Spawns per tick per system | 200 | Denied |
| Live entities spawned per system | 5,000 | Denied |
| Particles and float texts per tick | 64 | Dropped |
| Banners | 1 per 2 s per system | Dropped |
| Emit nesting | 16 levels | Denied |
| Saved state per system | 1 MB | `state.set` denied |
| Compile time | 30 s | Check fails |
| Other stage time | 20 s | Worker killed, stage fails |
| World check ticks | 300 | |
| Focus time limit | 60 s borrow, 30 s freeze | Engine takes controls back |
| Focus cooldown | 10 s per system, waived when started in `perform` | `focus` denied |
| Strikes before unload | 3 in 60 s | System and dependents unloaded |
| Repairs per step | 3 | Step dropped, chain stops |
| `PLAN_MAX_STEPS` | 4 | Extra steps dropped with a warning |
| `WISH_MAX_CHARS` | 100 | Wish cut |
| Near-limit log threshold | 50% | Logged |
| `AI_MODELS` planner | `muse-spark-1.3`, 8,000 output tokens, reasoning effort `medium` | Reply cut off: API error, chain stops |
| `AI_MODELS` designer | `muse-wonder-1.0`, 32,000 output tokens, reasoning effort `high` | Reply cut off: API error, chain stops |

All limits start generous and are tightened only if needed.

---

## 16. Out of scope

The in-game chat box (wishes are typed in the dev panel for now), manifest size caps, the final overlay layout, Toast's three final example systems, sharing systems between players, and a camera. QuickJS is the fallback only if AssemblyScript repair rounds become a problem; don't build it.
