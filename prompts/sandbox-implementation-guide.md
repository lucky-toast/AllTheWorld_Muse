# Sandboxed systems: implementation guide

Nov 1, 2026

## Brief for the agent

**Goal.** Systems written by the AI designer currently run as TypeScript, evaluated with `new Function` on the page, with full page access. Replace that with AssemblyScript compiled to WebAssembly. Each module talks to the game only through one validated host call. Interactions, events, input focus, the pipeline and storage change to match the design.

**Source of truth.** [Sandboxed AI systems: design](https://claude.ai/artifact/1RMJty1TtJ5PEXuzN67twb). If this guide and the design disagree, follow the design and flag the conflict.

**Repository.** `lucky-toast/AllTheWorld_Muse`, branch `muse-wonder-1.0`. Work on a new branch from it.

**Rules of engagement**

- Work phase by phase, in order. Each phase ends with `npm run typecheck` and `npm test` green, and one commit.
- Don't add features the design doesn't ask for.
- No human approval step anywhere. The pipeline is the approval.
- Keep the game playable at the end of every phase.
- Base systems (movement, carry, push, daynight) stay in TypeScript, but they go through the same host dispatcher as AI systems. Only AI-written systems move to WebAssembly.
- Fix the two existing security holes first (Phase 0), before anything else.
- Every new limit and value goes in `src/tuning.ts`.
- Out of scope: the designer prompt wording (owned separately), the overlay layout (waits on an asset review)

## Current code map

What exists on `muse-wonder-1.0` today, and what happens to it.

| Area | Files today | What changes |
| --- | --- | --- |
| System contract | `src/engine/api.d.ts`, `src/engine/define.ts` | `SystemDef` with `on` handlers, `contract.claims` and live `Entity` handles is replaced by a manifest plus module exports. Systems get numeric ids only, never handles |
| Engine | `src/engine/engine.ts` | `facade()` and `emitAs()` hand systems direct world access, and every handler runs with `handled` as a convention. All world access moves behind one host dispatcher with validation and an undo log. The event bus delivers only to registered reactions |
| Input | `src/engine/input.ts` | Space/E emits `input.interact` and Q emits `input.secondary` to every system. The engine handles E and Q itself (interaction resolver) and adds input focus. Player input is no longer an event |
| Base systems | `src/systems/base/*.ts` | `use.ts` is retired. Carry's pick up and drop become base interactions. All base systems call the host dispatcher instead of the facade |
| Pipeline | `src/pipeline/static.ts`, `compile.ts`, `eval.ts`, `core.ts`, `worker.ts`, `client.ts`, `types.ts` | The denylist static check (bypassable via `({}).constructor.constructor`), the TS transpile and the `new Function` eval are removed. Stages become the 7 in the design |
| Live load | `src/pipeline/live.ts` | `performLoad` and `loadSaved` evaluate source on the main thread. They become "instantiate a validated, metered module" |
| Storage | `src/pipeline/persistence.ts`, `vite.config.ts` | `/__systems/save` writes `join(sysDir, body.id + ".ts")` with an unchecked id, a path traversal that can overwrite `vite.config.ts`. The layout becomes `data/systems/<id>/` with id and path checks. Built copies keep manifests and source in localStorage and cache compiled modules in IndexedDB |
| Designer | `src/ai/designer.ts`, `src/ai/prompts/designer.md` | The reply format changes to manifest + AssemblyScript source. `buildVisualMessage` sends screenshots back to the model, so remove it: shots are logged only. Repair messages stay, up to 3 |
| Fixtures and tests | `fixtures/*.ts`, `tests/*.test.ts` | Campfire is ported to the new format. The bad-* fixtures are rewritten as new-format failure cases. Tests that assert `handled` or claims are replaced |
| Tuning | `src/tuning.ts` | Gains every limit from the design (fuel, memory, host calls, spawns, focus timers and so on) |

## Phases

Build the host API and interaction model in TypeScript first, with base systems on it. Then put the WebAssembly sandbox underneath. Each phase lists its files, tasks and a done-when check.

### Phase 0: Close the existing holes

Files: `vite.config.ts`, `src/pipeline/persistence.ts`

- Validate every system id against `^[a-z][a-z0-9_]{0,39}$` on the dev server before any file operation. Reject anything else with 400.
- Resolve the final path and confirm it stays inside `data/`. Never write a file Vite would treat as code (`.ts`, `.js`, `.mjs`, config files).
- Main-thread evaluation is closed in Phase 4, when `eval.ts` goes away.

Done when: a test posts ids such as `../vite.config` and `a/b` and gets 400 with nothing written.

### Phase 1: Host dispatcher

Files: new `src/engine/host.ts`; `src/engine/engine.ts`, `src/tuning.ts`, `src/systems/base/*.ts`

- One entry point, `host.call(systemId, request) → response`, that every world access goes through. Requests and responses are JSON: `{ "ok": true, "r": ... }` or `{ "ok": false, "code": "denied", "msg": "..." }`.
- Implement the request list from Reference. Entities are numeric ids everywhere; remove `Entity` handles from anything a system can see.
- Run the checks on every request, in order: shape, phase, blocked actions, budget, invariants (see Reference).
- Transactions: one per call into a system. Keep an undo log of every write, including writes by other systems reached through `emit`. On a trap, fuel exhaustion or limit breach, replay the log backwards.
- Ownership records: which system spawned each entity and declared each component. Use them for unloading and logging only, never to restrict.
- Per-system RNG: seed each system's stream from the world seed and its id. Replace the shared `rand()` for systems.
- Port movement, carry, push and daynight to call the dispatcher instead of the facade. They are trusted TypeScript but use the same path.
- Add a log for denied requests and for any system using more than half of a limit.

Done when: base gameplay works unchanged through the dispatcher; there is one test per blocked action; a rollback test shows the world unchanged after a forced trap mid-call.

### Phase 2: Manifest, registry and event bus

Files: new `src/engine/manifest.ts`, `src/engine/registry.ts`; `src/engine/engine.ts`, `src/engine/api.d.ts`, `src/engine/define.ts`

- Manifest schema (JSON): `id`, `why`, `buildsOn`, `entities`, `components`, `interactions` (`verb`, `label`, `target`, optional `held`), `reactions` (event names), `emits` (event name → payload shape), `shots`. Read once at load and freeze it.
- Registry, built at load from every manifest: the interaction table (indexed by target and held, each entry keeps its owner), the reactions for each event, and the owner of each event.
- Event ownership: a system may emit only its own `emits`, which must carry its id as a prefix. The engine and base systems own `player.*`, `item.*`, `entity.*`, `interaction.*`, `time.*` and `system.*`.
- Payload check on emit against the declared shape (number, string, bool, entity, pos, list, object). Entity fields are ids; the host fills in each entity's real type and position.
- Delivery: call `onEvent` on every system registered for the event, in load order. Every match runs. Remove `handled`, `contract.claims` and `contract.hooks`.
- Cap emit nesting (16 levels). Emits count toward the caller's budget.

Done when: campfire (still TypeScript for now) reacts to `item.dropped` through the registry; emitting an unowned event is denied; a payload with a fake entity type is corrected by the host.

### Phase 3: Interactions on E, timers and input focus

Files: new `src/engine/interactions.ts`, `src/engine/focus.ts`; `src/engine/input.ts`, `src/engine/render.ts`, `src/systems/base/carry.ts`, `src/systems/base/use.ts` (delete)

- Resolver: when the player faces something, look up matches in the table for the faced entity, the faced tile (when no entity is in the way) and the held item. No system code runs.
- Default ranking and the Q cycle exactly as in Reference. Turning or stepping resets the cycle.
- Prompt above the target: "E: Chop", plus "‹1/3› Q" when there is more than one match.
- On E, call `perform(verb, target, held)` on the owner of the highlighted entry as one transaction, then emit `interaction.performed` (verb, target, held, owner).
- Convert pick up and drop into base interactions. Drop is always last. Delete `use.ts` and `entity.used`.
- Stop emitting `input.interact` and `input.secondary`. Player input never travels as an event.
- Timers: a `timer(ticks, name)` request, plus an optional callback name on `anim`, both call `onTimer(name)` later. Each callback is its own transaction.
- A request on an entity that no longer exists is denied, not a fault.
- Input focus: `focus` (borrow or freeze) and `release`. Borrow sends arrows, E and Q to `onInput`; freeze ignores every key except Escape. Guards: Escape always ends it; time limit 60 s for borrow and 30 s for freeze; 10 s cooldown per system unless the player started it with E; one holder at a time; released when the holder faults or unloads. The world keeps ticking.

Done when: tests cover each ranking rule, the Q cycle and reset, pick up and drop as interactions, and each focus guard (including Escape during freeze and the cooldown exception).

### Phase 4: AssemblyScript sandbox

Files: new `src/sdk/` (AssemblyScript library), `src/pipeline/compile-as.ts`, `src/pipeline/module.ts`, `src/pipeline/meter.ts`; delete `src/pipeline/eval.ts`, `src/pipeline/compile.ts`, `src/pipeline/static.ts`

- SDK: an AssemblyScript library with a typed helper for every request, a small JSON reader and writer, and the export glue. It is compiled into each module.
- ABI: one import, `host.call(reqPtr, reqLen)`, with the request as UTF-8 JSON in the module's memory. The SDK exports an allocator so the host can write the response back. Document the exact ABI in `src/sdk/README.md`.
- Compile in the worker with the AssemblyScript compiler and fixed host settings: imported memory, a capped maximum, and no other imports. By default asc emits `env.abort`, `env.trace` and `env.seed`; point them at SDK functions so the only imports left are `host.call` and `env.memory`. Check the flag names against the asc version you install.
- Module loader, run on every load, including from storage: `WebAssembly.validate`; imports must be exactly `host.call` and `env.memory`; exports must match the expected names and cover the manifest (every interaction needs `perform`, every reaction needs `onEvent`); rewrite the binary to add fuel metering (a counter decremented at every function entry and loop header, trapping at zero); instantiate with a fresh capped `WebAssembly.Memory` and a `host.call` bound to this system. Never run the `.js` bindings asc generates.
- Module exports: `perform`, `onEvent`, `onTick`, `onTimer`, `onInput`, `migrate`, `onTween`, tests, as needed. All lasting state goes through `state.set`; the module is re-created on every load.
- Strikes: each trap, fuel exhaustion or limit breach is a strike. Three in one minute unloads the system and every system that builds on it. Entities stay without behaviour. Show a banner and log it in the dev panel.
- Port `fixtures/campfire.ts` to a manifest plus AssemblyScript module. Write the chop example from the design as a second fixture.

Done when: campfire and chop work as WebAssembly modules; a module with an extra import, a missing export, an infinite loop or a memory blow-up is rejected or trapped and rolled back; no `new Function` or `eval` is left in `src/`.

### Phase 5: Pipeline and designer

Files: `src/pipeline/core.ts`, `types.ts`, `worker.ts`, `client.ts`, `devpanel.ts`; `src/ai/designer.ts`; `fixtures/bad-*.ts`; `tests/pipeline.test.ts`, `tests/designer.test.ts`

- Replace the stages with the 7 in the design: Manifest, Compile, Module, Tests, World check, Shots, Load. Everything before Load runs in the worker with its own engine copy, under the existing watchdog.
- Manifest stage: schema; id format and unused; sprites, types and components exist; emitted names carry the prefix; every event in `reactions` exists; every system in `buildsOn` is loaded.
- Tests stage: the system's own tests on a fresh map, then every existing system's tests with it loaded. Tests are normal module code using the `sim.*` requests and `check`.
- World check: load into a copy of the current world, run `migrate` and several hundred ticks. Then check the player can still walk, pick up and drop, footprints sit on walkable tiles, the world saves and loads, and the module can be re-created mid-run from saved state. Log (don't fail) two systems writing the same entity for one event. Remove the old replay check and the old contract and handled checks.
- Shots: render to the log. A render failure is logged and doesn't block. Never send images to the model.
- Designer: parse the reply as a manifest plus AssemblyScript source. Keep repair messages (up to 3) with what failed. After 3 failed repairs, drop the attempt and log it. Remove `buildVisualMessage` and `parseVisualReply`.
- Rewrite the bad-* fixtures as new-format failures, one per stage.

Done when: each bad fixture fails at the expected stage with a readable repair message; campfire and chop pass every stage; no screenshot reaches the model.

### Phase 6: Live load, storage and recovery

Files: `src/pipeline/live.ts`, `src/pipeline/persistence.ts`, `vite.config.ts`, `src/main.ts`

- Load: snapshot the live world, add the system to the registry, instantiate it, save it, show "The world feels different". The snapshot can undo the whole system.
- No revisions: a loaded system is never edited or replaced. Reject a load whose id already exists.
- Dev server storage: `data/systems/<id>/` holding `manifest.json`, `source.as`, `module.wasm` and its SHA-256.
- Built copies: manifests and source in localStorage. Compiled modules cached in IndexedDB, recompiled from source when missing. No screenshots in localStorage.
- Startup: every stored module goes through the Module stage again (validation and fresh metering) before it runs, in load order. A system that fails is skipped along with everything that builds on it.

Done when: a reload restores every system; a tampered `module.wasm` is still metered or rejected; deleting the IndexedDB cache triggers a recompile and the game still loads.

## Reference

### Manifest example

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

`target` is an entity type, a tag (`"#choppable"`), a terrain tag (`"tile:water"`) or `"held"`. `held` is an item type, a tag, `"none"`, or left out for anything.

### Default action ranking

Compare matches one rule at a time; the first rule that tells them apart decides. The rest follow on the Q cycle in the same order.

1. What it acts on: faced entity, then faced tile, then held item only. Drop is always last.
2. What must be held: exact type, then tag, then `"none"`, then left out.
3. How exactly it names the target: exact type, then tag.
4. Age: the newer system wins.

### Host requests

| Kind | Requests |
| --- | --- |
| Read | `query` (by tag or component), `at` (entities on a tile), `get` (a component), `tile.get`, `tile.find`, `catalog.get`, `catalog.find`, `time`, `rand` (the system's own stream) |
| Write | `spawn`, `destroy`, `move`, `lift`, `place`, `set`, `remove`, `tag`, `untag`, `anim` (optional callback name), `tile.set`, `state.set` |
| Event | `emit` |
| Timer | `timer` (calls `onTimer` after n ticks) |
| Controls | `focus` (borrow or freeze), `release` |
| Effect | `fx.particles`, `fx.float`, `fx.tint`, `fx.tween` (progress via `onTween(id, value)`), `ui.banner`, `ui.hud.add`, `ui.hud.remove`, `ui.overlay` |
| Test only | `sim.walk`, `sim.face`, `sim.interact`, `sim.cycle`, `sim.give`, `sim.teleport`, `sim.wait`, `check` |

The host passes in only the ids a call is about (target, held, event fields). No world snapshots are pushed to systems.

### Checks on every request, in order

1. Shape: known request, right field types, integer tiles inside the map, strings and values within size caps.
2. Phase: `sim.*` and `check` only in tests; `state.set` only for the caller's own state; `onInput` only while holding focus.
3. Blocked actions (table below).
4. Budget: fuel and action limits.
5. Invariants: the player exists, footprints sit on walkable tiles, occupancy matches.

| Action | Blocked |
| --- | --- |
| `destroy`, `lift`, `move`, `place` | Removing, lifting or teleporting the player (only base movement and carry do that) |
| `tile.set` | Making the tile under the player unwalkable |
| `emit` | Events the system doesn't own |
| `fx.tint` | Alpha over 0.6, or longer than 3 s |
| `ui.*`, `fx.float` | Text over 60 characters, or outside printable characters |

### Limits (starting values, in `src/tuning.ts`)

| Limit | Value | When hit |
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
| Focus time limit | 60 s borrow, 30 s freeze | Engine takes controls back |
| Focus cooldown | 10 s per system (waived when started with E) | `focus` denied |
| Strikes before unload | 3 in one minute | System and dependents unloaded |
| Repairs per attempt | 3 | Attempt dropped and logged |

## Acceptance

The work is done when all of these hold:

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] No `new Function`, `eval` or dynamic `import()` of system code anywhere in `src/`.
- [ ] Every AI system loads as a metered WebAssembly module whose only imports are `host.call` and `env.memory`, including after a reload from storage.
- [ ] Base gameplay (walk, push, pick up, drop, day and night) works, and pick up and drop are base interactions.
- [ ] E runs the default action, Q cycles the rest with the ‹n/m› marker, and the ranking tests pass.
- [ ] Campfire and chop pass every pipeline stage and play correctly in the live game.
- [ ] Each bad fixture fails at the expected stage, and its repair message names the problem.
- [ ] A trap, an infinite loop and a memory blow-up each roll back cleanly and count as a strike; three strikes unload the system and its dependents.
- [ ] Escape always ends focus, and every focus guard has a test.
- [ ] The dev server rejects bad ids and paths outside `data/`.
- [ ] No screenshot is ever sent to the model; shots appear only in the log.
- [ ] Every limit lives in `src/tuning.ts`, and near-limit usage is logged.

If something in the design turns out to be impossible or much harder than expected, stop and report it rather than inventing a workaround.
