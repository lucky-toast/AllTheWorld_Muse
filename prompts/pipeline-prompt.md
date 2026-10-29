Later, an AI will write new gameplay systems as TypeScript source text, and the game will check and hot-load them while it runs. Build that pipeline now, and test it with hand-written fixtures that stand in for the AI's output. No AI is involved yet.

The pipeline (src/pipeline/)
Two entry points. checkSystem(source: string): Promise<Report> runs every stage except Load and never touches the live game. loadChecked(report) runs the Load stage for a report that passed, and refuses anything else. Each report records the exact source and the list of loaded systems at check time; loadChecked also refuses a report if either has changed since, because the check no longer applies. submitSystem(source) is just the two in a row, for the fixtures. Keeping them separate lets an AI look at its shots before anything loads.

Every stage except Load runs in one Web Worker, which has its own copy of the engine with the base systems and every loaded system. Checking happens there in the background while the game runs. The worker is killed if a stage goes over its time limit, so an infinite loop can never freeze the game.

checkSystem takes a system's source code as a plain string, exactly as an AI would return it, and runs these stages in order. It stops at the first failure.

Static rules: runs first, on the parsed source, so its errors are clearer than type errors. Reject code that uses anything outside the world API: window, document, fetch, eval, Function, timers, any import except import { defineSystem } from "engine/define", or assigning to e.pos. Also reject sprite ids that aren't in the catalog, and a system id that's already loaded or belongs to a base system.
Compile: type-check the source against src/engine/api.d.ts and transpile it, in the worker, using the TypeScript compiler.
Sandbox run: load the system into a copy of the current world (from snapshot()), run its migrate, then run a few hundred ticks. Fail on any thrown error, or if a tick goes over the time budget from tuning.ts.
Tests: run the system's own tests on a fresh world built from the real map, from the fixed seed, with the new system loaded (not on the sandbox copy, so each test starts clean). Then run every base system's tests in their empty arena, also with the new system loaded, so a new system can't break old ones.
Invariants: check the system's contract against what actually happened during its tests and sandbox run: every event it emitted is listed in emits, and it only set handled on inputs listed in claims. Report any mismatch with the event or input name. Also, after the run, the player still exists, every entity on the map (not lifted) has its footprint on walkable tiles, the occupancy lookup matches every entity's position, and the world still serializes. Also replay a short scripted run with sim (walk, pick up, drop, push, use), using real map items like a branch and a log, with the new system loaded: the base systems must behave exactly as they do without it.
Load: only now, take a snapshot() of the real world, loadSystem into the live game, and emit system.loaded. If the live load throws, restore that snapshot and fail the stage. Loading is a moment in the game, not a page change: pause the game (no ticks, no input), play a transition of about 2 seconds with leaves (fx_leaf) swirling across a soft fade, load the system while the screen is covered, then fade back and show the banner "The world feels different". Only this step pauses the game.
After Invariants and before Load, the Shots stage renders the system's shots. It passes when every shot renders. A shot whose setup throws fails the stage, with the error in the Report like any other stage, because shot code is AI code too. For each shot, run its setup and ticks on a fresh sandbox copy, then draw the world to an OffscreenCanvas in the worker, with lighting, cropped to about 9×7 tiles around focus and zoomed 3×. Return each one as a PNG data URL. Later, an AI will look at these to check its own work.

The Report is structured so an AI can read it later and fix its code, so give it as much detail as possible at the point of failure: { ok, stage, systemId, errors: [...], shots: [{ name, png }], durationMs }.

Each error has a message, and line when there is one. For failures in Compile, Static rules and Sandbox run, also include the offending source line's text. For a failed test or invariant, the error also has:

test: the test's name.
checks: every named check, with label and passed, so it's clear which ones failed.
events: every event fired during the test, in order, as { tick, name, payload }. Keep payloads short, and cap the list at the last 100 events.
inputs: every input event, the system that set handled on it (or "none"), and every system that received it.
entities: the type, position and components of each entity the new system spawned, plus the player, at the end of the test.
thrown: any error thrown, with the system and handler it came from.

Engine changes
You may change the engine where this pipeline needs it.

Saving accepted systems
Accepted systems must survive a page refresh.

When a system loads, save its source to data/systems/<id>.ts and add it to data/systems.json (id, order, buildsOn, timestamp) through a small Vite dev-server endpoint.
There is no undo. Start fresh (in the dev panel) deletes the saved world, then reloads the page with only the base game; to rebuild, load systems again one by one.
On startup, load every saved system in order through loadSystem, after the base systems and before the saved world is restored. No transition on startup.
If a saved system fails to load, skip it and any system that builds on it, show which were skipped in the dev panel, and keep the game running.
When there's no dev server (a built or deployed copy), save to localStorage instead, so a playable demo link still keeps its systems.
Fixtures (fixtures/)
These files are not part of the game and are never loaded at startup. Import each one as raw text (Vite ?raw) and send it through submitSystem, the same way AI code will arrive.

One good fixture, campfire.ts. It's written like a real AI-made system, with a why, buildsOn, a contract and good tests:

Dropping a third branch on tiles next to each other turns the branches into a campfire whose 2x2 footprint covers the middle branch's tile (pick a placement where all 4 tiles are free). The fire must read as a real campfire sitting on the ground: a firepit (stone ring with logs, solid) with a small fx_fire flame on the same tile, using a higher z so it draws over the logs: the flame plays ignite, then loops burn, never floating on its own. Center the 8x12 flame horizontally on the 2x2 pit, with its bottom edge 18 px below the pit area's top edge, where the logs meet. Don't use fx_flame; it's a one-shot burst.
The campfire has a warm, flickering light and emits fire.lit.
It burns for part of a night, then the flame plays die, the light fades, the pit turns into its becomes.burnedOut sprite (firepit_ash) (not solid), and it emits fire.out.
Tests: three branches make a fire, two don't; the fire has a light; it burns out and leaves ash; the player can't walk through a lit fire.
Shots: the fire just lit at night, and the ash ring after it burns out. Build the fire in setup with sim, the way a player would: give a branch, face a free tile, interact, three times in a row.
Broken fixtures. Each one must be stopped at the stage named:

File	What's wrong	Must fail at
bad-sprite.ts	declares an entity type whose sprite is "dragon_huge", which isn't in the catalog	Static rules
bad-types.ts	calls world.spawnAt(), which doesn't exist	Compile
bad-loop.ts	on its 50th tick, onTick enters an infinite loop	Sandbox run (worker killed, game keeps running)
bad-test.ts	its test uses a branch on a rock and checks for a spark, but the system never spawns one, so a named check fails	Tests
bad-contract.ts	emits rock.kicked when the player walks into a rock, during its own passing test, but its contract doesn't list it	Invariants
bad-ignores-handled.ts	on every input.interact, ignoring handled, destroys any branch in the player's hands. It only touches branches, so the base tests (which use test items) still pass and the replay catches it	Invariants (replay)
bad-shot.ts	passes its tests, but its shot setup reads w.query("campfire")[0].pos when no campfire exists, so it throws	Shots
Dev panel
Toggle with the backtick key. It's a small overlay listing every fixture, with a button to submit each one. At the top, show the pipeline as a row of boxes, one per stage in order (Static rules, Compile, Sandbox run, Tests, Invariants, Shots, Load). Every box starts grey, turns amber while its stage runs, then green when it passes or red when it fails; stages after a failure stay grey. Each box shows its time taken, and clicking a red box shows its errors. Below that, it shows the Report (stage reached, errors, time taken, and the rendered shots), lists loaded systems, and has a Start fresh button. The game keeps running underneath the whole time.

Done when
Check every item yourself before you stop, and tell me how you verified each one:

 campfire.ts passes every stage and loads while the game is running, without a page reload, and making a campfire works in play.
 Start fresh returns to the base game with nothing saved, and the campfire can then be submitted and loaded again.
 loadChecked refuses a passed report once another system has loaded since it was checked.
 The campfire's two shots render as cropped, zoomed images in the dev panel, and they look like a lit campfire at night and an ash ring.
 A failing test's report lists which named checks failed, the events fired, which system handled each input, and the final entities.
 Every broken fixture is stopped at exactly the stage in the table, with a clear error in its report.
 bad-loop.ts never freezes the game.
 The live game is never touched until a system has passed every stage.
 Submitting a fixture lights up the stage boxes one by one, grey to amber to green, and a broken fixture turns exactly its failing stage red.
 Loading pauses the game, plays the leaf transition, and shows the banner.
 After a page refresh, the campfire system is still loaded and the world is as it was.
 npm test also runs the pipeline against every fixture and checks the expected outcome.
