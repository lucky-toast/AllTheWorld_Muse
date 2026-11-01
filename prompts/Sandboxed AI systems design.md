# Sandboxed AI systems: design

Nov 1, 2026 · @Toast

## Principles

The game designer AI writes new systems, and they go live in the running game with no person reviewing them. That is only safe if the worst a system can do is small, visible and easy to undo. Each principle below takes away one thing a person would otherwise have to check.

1. **No way out.** A system is an AssemblyScript program compiled to WebAssembly. Its only import is a single host call. It can't touch the page, the network, storage, the dev server or the disk, so there is nothing outside the game for a reviewer to protect.
2. **Every effect is a request.** A system can't change the world directly. It asks the host, and the host checks each request against fixed rules and can say no. Bad code gets denied instead of crashing the game.
3. **Open by default, with a short block list.** New systems exist to build on old ones, so any system may read and change any entity, component, tile or event. Only a handful of game-breaking actions are blocked, such as removing the player. Nobody has to grant permissions.
4. **Match as data, act as code.** What a system responds to (which button press, which event) is plain data in a manifest. The engine can read it and rank it without running any code. What a system does is ordinary code.
5. **One press, one action, nothing hidden.** E is the only action key, and the engine, not the systems, decides what it does. A new system can change the default action, but every other action stays reachable with Q. A system can't take over a key or hide another system's action.
6. **Bounded work.** Every call has a fixed computation budget counted in instructions, plus caps on how much it can spawn or show. A system can't hang the game or flood it.
7. **Automatic recovery.** Each call is a transaction that rolls back if anything goes wrong. A system that keeps failing is unloaded with its dependents. A snapshot taken at load can undo a whole system. These replace a human safety net.

## Architecture

There are two flows: running systems while the game plays, and building a new system. They share no code path; the only link is the Load step at the end of the build flow.

### Running systems

&#91;embedded content: registry, resolver, validator, event bus\]

Each system is a pair: a **manifest** (data) and a **module** (WebAssembly code). Everything else belongs to the engine and can't be changed by systems.

| Part | Owned by | Job |
| --- | --- | --- |
| Manifest | System | What the system responds to (fields under System package). Read once at load and frozen |
| Module | System | The system's behaviour. Runs in a WebAssembly sandbox whose only way out is `host.call` |
| Registry | Engine | Built from every manifest at load: the interaction table, the reactions for each event, and who owns each event |
| Interaction resolver | Engine | When the player faces something, looks up matching interactions in the table, picks the default, and lets Q cycle the rest. No system code runs |
| Host validator | Engine | Every request from a module passes through here. Checks shape, blocked actions, budgets and invariants; applies the request; keeps an undo log |
| Event bus | Engine | When an event is emitted, calls the `onEvent` of every system that registered for it, in load order |
| World state | Engine | Entities, tiles and the clock. Only the validator writes to it |

### Building a new system

&#91;embedded content: pipeline · 7 stages, repair loop\]

| Part | Job |
| --- | --- |
| Director brief | Asks for a new piece of gameplay |
| Designer AI | One API request per attempt. Returns a manifest and AssemblyScript source, never a binary |
| Pipeline | Runs in a Web Worker with its own copy of the engine and world, under a watchdog. It never touches the live game. Stages 1 to 5 must all pass, in order |
| 1. Manifest | Valid schema; id matches `^[a-z][a-z0-9_]{0,39}$` and is unused; sprites, types and components exist; emitted event names carry the system's prefix; every event in `reactions` exists; every system in `buildsOn` is loaded |
| 2. Compile | The host runs the AssemblyScript compiler with fixed settings |
| 3. Module | Import and export checks, fuel metering, instantiation |
| 4. Tests | The system's own tests on a fresh map, then every existing system's tests with it loaded |
| 5. World check | Loads into a copy of the current world, runs `migrate` (one-time setup) and several hundred ticks; any trap or limit breach fails. Then: the player can still walk, pick up and drop; footprints sit on walkable tiles; the world saves and loads; the module can be re-created mid-run from saved state. Two systems writing the same entity for one event is logged, not failed |
| 6. Shots | Screenshot setups render to the log. Never sent back to the AI; a render failure doesn't block |
| Repair message | Any failure goes back to the designer AI with what failed. Up to 3 repairs |
| Dropped, logged | Still failing after 3 repairs: nothing loads and the attempt is logged |
| 7. Load live | Snapshot the live world, add the system to the registry, instantiate it, save it, show "The world feels different" |

Passing every stage is the approval; no person signs off.

## How systems work

A system is one new piece of gameplay, such as woodcutting, a campfire or fishing. It builds on what already exists: the base game and every system loaded before it.

**How it gets triggered.** There are four ways:

- **The player presses E.** The system listed an interaction in its manifest, for example "Chop" on a fallen log while holding an axe. When that's the highlighted action and the player presses E, the engine calls the system's `perform`.
- **Something happens.** The system listed event names in its manifest, for example `item.dropped`. Whenever that event fires, the engine calls its `onEvent`.
- **Time passes.** `onTick` runs every tick for continuous behaviour, and `onTimer` runs when a timer the system set, or an animation it started, finishes.
- **It holds the controls.** While a system has borrowed the controls for a mini-game, key presses go to its `onInput`.

**How systems build on each other.** A new system can use any existing entity type, tag, component or event. It can add a new action to an existing thing, react to another system's events, or change components that other systems read. When two systems offer an action on the same thing, the more specific or newer one becomes the default on E and the other stays on Q.

**Example: chopping a log.** The woodcutting manifest says "Chop, on `log_fallen`, while holding an axe". The player faces a log with an axe and sees "E: Chop". On E, `perform` freezes the controls and starts the chop animation with a callback named "chopped". When the animation ends, `onTimer("chopped")` checks the log is still there, destroys it, spawns a wood pile, emits `woodcutting.chopped` and gives the controls back. Each of those steps is a request the host checked. A later system could react to `woodcutting.chopped` to drop an acorn sometimes, without touching woodcutting.

## Implementation and rules

### System package

**Manifest.** JSON, read once at load and frozen. Example:

```json
{
  "id": "woodcutting",
  "why": "Chop fallen logs with an axe to get a wood pile.",
  "buildsOn": ["carry"],
  "entities": { "wood_pile": { "sprite": "wood_pile", "tags": ["item"] } },
  "components": {},
  "interactions": [
    { "verb": "chop", "label": "Chop", "target": "log_fallen", "held": "axe" }
  ],
  "reactions": [],
  "emits": { "woodcutting.chopped": { "pos": "pos" } },
  "shots": [ ... ]
}
```

| Field | Meaning |
| --- | --- |
| `id`, `why`, `buildsOn` | Identity, one-line purpose, systems it builds on |
| `entities`, `components` | New entity types and component shapes it adds |
| `interactions` | Actions it adds to E: `verb`, `label`, `target`, optional `held` |
| `reactions` | Event names it responds to; each one goes to its `onEvent` |
| `emits` | Events it owns, with payload shapes; names start with the system id |
| `shots` | Screenshot setups, rendered and logged by the pipeline |

**Module.** Exports `perform` (interactions), `onEvent` (reactions), `onTick` (things over time), `onTimer` (timers and animation ends), `onInput` (while holding focus), `migrate` (one-time setup on the existing world), and its tests, as needed. Its one import is `host.call`, plus a memory the host creates. All lasting state goes through `state.set`. The module is re-created on every load, so globals don't survive.

**SDK.** An AssemblyScript library with typed helpers for every request (`world.query`, `world.spawn`, `anim`, `timer`, `state.set`, a small JSON reader and writer). It is compiled into the module, so it runs inside the sandbox with no extra power.

**Tests** are normal code in the module, written against the SDK with sim steps (walk, face, interact, cycle, give, teleport, wait) and checks.

**No revisions.** A loaded system is never edited or replaced. To change how something works, the designer adds a new system that builds on it.

### Interactions on E

E is the only action key. Systems register interactions in their manifest, the engine picks one, and only that one runs.

1. **Register.** At load, every manifest's interactions go into one table, indexed by target and held item. Each entry keeps its owner, so two systems can use the same verb or label.
2. **Look up.** When the player faces something, the engine queries the table. No system code runs, so the lookup is fast and deterministic and can't be abused.
3. **Show.** A one-line prompt above the target shows "E: Chop". When more than one interaction matches, it adds a cycle marker, for example "E: Chop ‹1/3› Q".
4. **Cycle.** Q moves to the next match and wraps around. Turning or stepping away resets to the default. The engine owns Q.
5. **Run.** E calls `perform(verb, target, held)` on the owner of the highlighted entry, as one transaction. Afterwards the engine emits `interaction.performed` (verb, target, held, owner).

**What E applies to.** Every match from all three kinds goes into the same list.

| Kind | `target` written as | Matches | Example |
| --- | --- | --- | --- |
| Entity | `"log_fallen"`, or a tag such as `"#choppable"` | The entity on the faced tile | Chop a log |
| Tile | `"tile:water"` (a terrain tag) | The faced tile's terrain, when no entity is in the way | Fish at water, plant on grass |
| Held | `"held"` | The item in hand, whatever is faced | Eat an apple |

**Which action is the default.** Matches are compared one rule at a time, and the first rule that tells them apart decides:

1. **What it acts on:** an action on what the player faces beats an action on the held item alone. The order is faced entity, then faced tile, then held item only. Dropping the held item is the base fallback and always comes last.
2. **What must be held:** an exact item type beats an item tag, which beats empty hands (`held: "none"`), which beats anything (`held` left out).
3. **How exactly it names the target:** an exact entity type beats an entity tag.
4. **Age:** the newer system wins, so building on something changes the default. The older action stays on Q.

**Base actions.** Pick up and drop are base interactions like any other. The old `use` system is retired.

### Conditions and timing in code

There is no extra syntax for conditions or timed steps. Matching uses only the target and the held item, and everything else is plain code.

- **Only sometimes available.** If an action should appear only in some states, a system adds or removes a tag, and the interaction targets that tag (for example `#ripe`). Otherwise `perform` checks the world and, when the action doesn't apply, does nothing and shows a short float such as "Needs 3 branches".
- **Reactions filter in code.** A reaction names only an event. `onEvent` reads what it needs and returns early when the event isn't relevant.
- **Steps over time.** `timer(ticks, name)` calls `onTimer(name)` later. `anim` takes an optional callback name and calls `onTimer(name)` when the animation ends, so steps can follow an animation instead of a guessed tick count. Anything continuous uses `onTick`.
- **Holding the player still.** When an action needs the player to wait, such as during a chop, `perform` takes focus in freeze mode and releases it when done.
- **Things that disappear in between.** A request on an entity that no longer exists is denied, not a fault. Code checks before acting.

### Input focus

Walking belongs to the engine, and pushing is a side effect of blocked movement. On top of that, a system can take the controls for a while, in one of two ways:

- **Borrow:** the arrow keys, E and Q go to the system's `onInput` instead of to movement. For mini-games with an overlay, or steering a fish on the line.
- **Freeze:** no key does anything except Escape, while something plays out. For cutscenes and actions like chopping.

Either can start from anything: a player action, an event, a time of day, reaching a tile. These guarantees stop abuse:

- **Escape always ends it.** It skips a cutscene or leaves a mini-game, and no system can block it.
- **Time limit.** By default 60 s for borrowing and 30 s for freezing, then the engine takes the controls back.
- **Cooldown.** After focus ends, the same system can't take it again for 10 s, unless the player starts it with E. Fishing again right away works; chaining cutscenes doesn't.
- **One at a time.** If another system holds focus, the request is denied.
- **Released on failure.** If the system faults or is unloaded, the engine takes the controls back.

The world keeps ticking during both. An optional overlay, a small panel the engine draws, is set through `ui.overlay`; systems can't draw freely. Terrain that only changes how walking feels (ice, mud) doesn't need focus: base movement reads components such as `slippery` or `moveDelay`, which any system can set.

Example, fishing: E at water calls `perform`, which starts a cast animation and checks for a bite each second in `onTick`. On a bite, it borrows focus and shows a tension bar. The arrow keys steer through `onInput` until the fish is landed or lost; then it releases focus and, if landed, spawns the fish into the player's hands.

### Events

Events tell systems what happened. They are open broadcasts: every matching reaction runs and may act. Deciding what a button press does is the job of interactions, not events.

- **Ownership.** Each system owns the events in its `emits`, named with its id as a prefix (`campfire.lit`). Only the owner may emit them. The engine and base systems own `player.*`, `item.*`, `entity.*`, `interaction.*`, `time.*` and `system.*`. Player input never travels as an event.
- **Payloads.** Each owned event declares a payload shape in a basic schema (number, string, bool, entity, pos, list, object), extended when needed. On emit, the host checks the payload. Entity fields carry ids only, and the host fills in each entity's real type and position, so a payload can't lie about an entity.
- **Reactions.** A system lists the event names it responds to. Its `onEvent` reads what it needs and returns early when an event isn't relevant. The campfire, for example, reacts to `item.dropped` and checks in code that the item is a branch and three branches lie together.
- **Delivery.** On emit, the event bus calls `onEvent` on every system registered for that event, in load order. Every match is called, and nothing is passed along or claimed.
- **Limits.** Nesting is capped, so systems can't ping-pong events forever. Emits count toward the caller's budget.

**When two systems react to the same event.** Delivery is one at a time, so each sees the world as the previous one left it; most clashes settle themselves or fail tests. Two systems that both succeed and double up are logged for review.

### Host API and validation

Every request from a module goes through `host.call`, which checks it, applies it and returns the result before the module continues. Entities are numeric ids, never handles. Systems read what they need through requests; the host passes in only the ids a call is about (target, held, event fields). No world snapshots are pushed to systems.

| Kind | Requests |
| --- | --- |
| Read | `query` (by tag or component), `at` (entities on a tile), `get` (a component), `tile.get`, `tile.find`, `catalog.get`, `catalog.find`, `time`, `rand` (the system's own seeded stream) |
| Write | `spawn`, `destroy`, `move`, `lift`, `place`, `set`, `remove`, `tag`, `untag`, `anim` (optional callback name), `tile.set`, `state.set` |
| Event | `emit` |
| Timer | `timer` (calls `onTimer` after n ticks) |
| Controls | `focus` (borrow or freeze), `release` |
| Effect | `fx.particles`, `fx.float`, `fx.tint`, `fx.tween`, `ui.banner`, `ui.hud.add`, `ui.hud.remove`, `ui.overlay` |
| Test only | `sim.walk`, `sim.face`, `sim.interact`, `sim.cycle`, `sim.give`, `sim.teleport`, `sim.wait`, `check` |

Responses are `{ "ok": true, "r": ... }` or `{ "ok": false, "code": "denied", "msg": "..." }`. A denial doesn't crash the module, but it is logged. Tweens report progress through an `onTween(id, value)` export, so the host never holds a function from the module.

**Checks on every request, in order:**

1. **Shape:** known request, right field types, integer tiles inside the map, strings and values within size caps.
2. **Phase:** `sim.*` and `check` only in tests; `state.set` only for the caller's own state; `onInput` only while holding focus.
3. **Blocked actions:** the table below.
4. **Budget:** fuel and action limits.
5. **Invariants:** the player exists, footprints sit on walkable tiles, occupancy matches.

**Blocked actions.** Everything else is allowed, on any entity, component, tile or event.

| Action | Blocked |
| --- | --- |
| `destroy`, `lift`, `move`, `place` | Removing, lifting or teleporting the player (only base movement and carry do that) |
| `tile.set` | Making the tile under the player unwalkable |
| `emit` | Events the system doesn't own |
| `fx.tint` | Alpha over 0.6, or longer than 3 s |
| `ui.*`, `fx.float` | Text over 60 characters, or outside printable characters |

**Ownership records.** The engine records which system spawned each entity and declared each component. They restrict nothing, but they make unloading clean and give a log of which system did what.

### Sandbox and limits

The host loads each module itself, under fixed rules the model can't change. If AssemblyScript repair rounds become a problem, TypeScript in QuickJS (also WebAssembly) is the fallback and loads the same way.

1. `WebAssembly.validate` the bytes.
2. Its imports must be exactly `host.call` and `env.memory`; anything else is rejected.
3. Its exports must match the expected names and kinds, and cover the manifest (every interaction needs `perform`, every reaction needs `onEvent`).
4. The host rewrites the binary to add fuel metering: a counter decremented at every function entry and loop, trapping at zero. It does this on every load, so a stored or tampered binary is metered too.
5. Instantiate with a fresh, capped `WebAssembly.Memory` and a `host.call` bound to this system.

The `.js` bindings file the compiler generates is never run.

**Two kinds of limit.** Fuel caps the computation one call may use, counted in instructions so it's the same on every machine; it stops hangs. Action limits cap spawns, entities, particles, banners and host calls; they stop floods. All start generous, the host logs any system above half a limit, and they're tightened only if needed.

| Limit | Starting value | When hit |
| --- | --- | --- |
| Fuel per `perform`, `onEvent`, `onTick`, `onTimer` or `onInput` (including nested emits) | 50M units | Trap, rollback, strike |
| Fuel per `migrate`, test or shot | 500M units | Check fails |
| Memory per module | 16 MB | Allocation fails, trap, rollback, strike |
| Host calls per invocation | 100,000 | Denied |
| Entities returned per `query` | 5,000 | Truncated, with a flag |
| Spawns per tick, per system | 200 | Denied |
| Live entities spawned per system | 5,000 | Denied |
| Particles and float texts per tick | 64 | Dropped |
| Banners | 1 per 2 s per system | Dropped |
| Emit nesting | 16 levels | Denied |
| Saved state per system | 1 MB | `state.set` denied |
| Compile time | 30 s | Check fails |

### Storage

- **Dev server.** Each system is saved in `data/systems/<id>/` as `manifest.json`, `source.as`, `module.wasm` and its SHA-256. The dev server validates the id, confirms the final path stays inside `data/`, and never writes a file it would treat as code.
- **Built copies.** Manifests and source go in `localStorage`; 100 systems at 10 to 20 KB of source each is about 1 to 2 MB, under the roughly 5 MB cap. Compiled modules are cached in IndexedDB and recompiled from source if the cache is missing. Screenshots are never stored there.
- **Startup.** Every stored module goes through the Module stage again (import checks and fresh metering) before it runs, in load order. A system that fails is skipped, along with anything that builds on it.

### Recovery and determinism

- **Rollback.** Each call into a module is one transaction. The host keeps an undo log of every write, including writes by other systems reached through `emit`. If anything traps, runs out of fuel or breaks a limit, the host replays the log backwards, and the world is as if that call never happened.
- **Strikes.** Each trap, timeout or limit breach is a strike. There is no disabled state; a system is loaded or not. Three strikes in one minute unloads the system and any system that builds on it. Its entities stay in the world without behaviour until it loads again. A banner and the dev panel log say what happened.
- **Whole-system undo.** The snapshot taken at Load can undo a whole system.
- **Random numbers.** Each system gets its own seeded stream, from the world seed and its id, so adding a system never changes another system's random outcomes, and tests stay stable.
- **Behaviour that changes later.** A system that acts differently on day 30 than on day 1 is a feature, not something the pipeline tries to catch. The guarantees above bound what it can do whenever it acts.

## Still open

These are small and each has a default, so building can start.

| Gap | Default |
| --- | --- |
| The request list is a first draft | Review it against the base game and the next few director briefs, and add requests as they come up |
| Key events while a system holds focus | `onInput(key, "down" or "up")`, plus key repeat while held |
| Camera during cutscenes | A `camera` request (follow an entity, pan to a tile, reset), only while the system holds focus |
| Request overhead (every request is a JSON round trip) | Start with JSON; switch to a binary encoding behind the SDK only if profiling shows it's slow |

Handled separately: the overlay layout (designed from the game's assets) and the designer prompt. Out of scope: sharing systems between players, which needs its own security review.
