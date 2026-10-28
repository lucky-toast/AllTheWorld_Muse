Build the base of a small 2D top-down browser game called All the World. Later, an AI will write new gameplay systems for it at runtime, so the most important thing is a clean, narrow Systems API. Keep the code small and readable.

**Stack:** Vite + TypeScript, plain Canvas 2D, no game framework. 16 px tiles. Render into a native-resolution canvas and scale it up, setting `imageSmoothingEnabled = false` again after every resize.

## Build order

Build in these stages, and make sure each one runs before starting the next. Write each system's tests and contract in the same stage as the system.
1. Engine core and rendering of the map from the catalog
2. Movement and collision
3. Carry, push and use
4. Day/night and lighting
5. HUD and screen fit
6. Dev tools, then the checklist at the end

## Engine core (`src/engine/`)

This is the only code that isn't a system. All game logic runs in ticks, never wall-clock time.
- Fixed-step game loop (60 ticks/s) and render loop, with entities y-sorted so things lower on screen draw in front.
- Entity store: entities have an id, a `type` (from the entity type registry below), `pos` (the tile of the sprite's bottom-left corner, or `null` while off the map), tags, and components (plain JSON data). Tags and components share one namespace.
- Tile map: a 2D grid of terrain sprite ids, plus tile tags (`walkable`, `water`). The map edge always blocks.
- **Occupancy:** an entity occupies the tiles in its catalog `footprint` (`{x?, w, h}` in tiles, measured from `pos`; `x` shifts it right by that many columns, default 0; default footprint 1x1). For example, a 3-wide tree has `{x: 1, w: 1, h: 1}`: only the trunk tile in the middle of the bottom row blocks. The engine keeps a lookup from tile to entities, updated whenever an entity moves or its sprite changes, and every collision check goes through it. Entities change position only through `e.moveTo(x, y, { instant? })` (slides by default; `instant` for teleports), `e.lift()` (takes it off the map) and `e.place(x, y)` (puts it back). These don't check collision; systems do.
- **Free tiles:** a tile is free for an entity X when it is walkable and holds no player, `solid`, `pushable` or `item` entity other than X. Decorations don't count.
- Input: arrow keys/WASD, Space/E for `input.interact`, Q for `input.secondary` (a spare key no base system uses). A quick tap on a new direction emits `input.turn { dir }`; a tap in the direction already faced takes one step. Holding a key emits one `input.move { dir }` per step, at the walking pace from `tuning.ts`, timed by our own timer and never by OS key repeat. The last-pressed direction wins. Facing is stored in one place only, a `facing` component on the player; the input layer reads it and never keeps its own copy. Systems never read the keyboard directly.
- Every input event carries a `handled` flag: base systems get it first, then later systems in load order. A handler that acts sets `ev.handled = true`, and a handler must do nothing if it's already true.
- Event bus: `on(name, handler)`, `emit(name, data)`.
- Seeded RNG and a world clock. The engine holds the clock; the `daynight` system advances it and emits every `time.*` event.
- `serialize()` / `deserialize()` for the whole world (entities, tiles, per-system state), plus `snapshot()` / `restore()`.
- System loader: `loadSystem(module)` registers a system, runs its `migrate(world)`, and wires its `onTick` and `on` handlers. `migrate` must be safe to run more than once. `unloadSystem(id)` removes it. Handler order survives a reload.

## Systems API

Every system is a module like this:

```ts
import { defineSystem } from "engine/define";

export default defineSystem({
  id: "movement",
  why: "The player can walk the clearing.",   // one line: what this gives the player
  buildsOn: [],                                // ids of systems this one relies on
  contract: {
    claims: ["input.move: always, for the player"],
    emits: {
      "player.moved": { payload: "{ from, to, dir }", when: "after every completed step" },
      "player.blocked": { payload: "{ dir, target: {x, y} }", when: "when a step is blocked, before movement re-checks the tile" },
    },
    hooks: ["To react to walking, listen for player.moved.", "To clear the way when the player is blocked, handle player.blocked."],
  },
  components: {},   // new component shapes this system adds
  entities: {},     // new entity types: { name: { sprite: catalogId, tags } }
  migrate(world) {},
  onTick(world, dt) {},
  on: { "input.move": (ev, world) => {} },
  tests: [],        // { name, setup?(w, sim), ticks, expect(w, check) }
  shots: [],        // { name, setup?(w, sim), ticks, focus: {x, y} }: stored now, rendered by a later pipeline
});
```

The `world` object passed to systems exposes only the calls below. Write its types in `src/engine/api.d.ts`, with a one-line doc comment on every call. That file is the contract a future AI will read, so keep it clean and complete.
- `at(x, y)`: the entities whose footprint covers that tile. This is the only way systems test collision.
- `query(tagOrComponent)`, `spawn(type, pos)`, `e.id`, `e.type`, `e.has(tagOrComponent)`, `e.tag(name)` / `e.untag(name)`, `e.get/set/add/remove(component)`, `e.pos` (read-only), `e.moveTo(x, y, { instant? })`, `e.lift()`, `e.place(x, y)`, `e.destroy()`
- **Entity types** live in one shared registry: the base map's types (declared in `src/world/types.ts` with their sprites and tags) plus every loaded system's `entities`. `spawn` only accepts a registered name and throws a clear error on anything else, including a bare catalog sprite id. A system may spawn types other systems registered.
- `tiles.get(x, y)`, `tiles.set(x, y, spriteId)`, `tiles.find(tag)`
- `on`, `emit`, and the `handled` flag on input events
- `time`: `time.day` (starts at 1, goes up at each dawn), `time.phase` (`"dawn" | "day" | "dusk" | "night"`), `time.hour` (0–24, fractional), and `time.set(phaseOrHour)` to jump the clock (for tests and shots).
- `rand()`: the seeded RNG. Systems must use it instead of `Math.random`.
- `catalog.find(tag)` returns matching sprite ids so systems can pick art by meaning; `catalog.get(id)` returns a sprite's catalog entry.
- `fx.tween`, `fx.particles(spriteId, pos)`, `fx.floatText(text, pos, color?)`, `fx.tint(color, alpha, durationMs)` for short screen effects. Simple versions are fine.
- `ui.banner(text)` (shown briefly at the top of the map, then fades), `ui.hud.add(id, { icon?: spriteId, text, width })` (`width` is the characters to reserve) and `ui.hud.remove(id)`
- `state`: a per-system plain object that gets saved with the world

## Base systems (`src/systems/base/`)

Write each one with `defineSystem`, using only the world API above. The faced entity is the one on the tile in front of the player; if there are several, prefer an `item`, then `pushable`, then anything else. While the player has a `busy` tag, no base system acts on input, so a later system can take over the controls.
1. `movement`: `input.turn` sets `facing`. `input.move` faces that direction and steps if the tile is free for the player; otherwise it emits `player.blocked { dir, target: {x, y} }`, then re-checks and steps if the tile is free now. Emits `player.moved { from, to, dir }`.
2. `carry`: `input.interact` facing an `item` lifts it into the player's hands. The player's `held` component (`{ id }`, or absent) is the one place that says what's in hand; the engine draws the held item above the player. Interact while holding places the item in front of the player, footprint adjacent in the facing direction, only if every tile of it is free. Otherwise carry leaves the input alone so `use` gets it. Emits `item.picked { item }` / `item.dropped { item, pos }`.
3. `push`: not an input handler. It reacts to `player.blocked`: if the target tile is covered by a `pushable` entity, it moves the whole entity one tile, only if every tile of its new footprint is free for it. Emits `entity.bumped { entity, dir }`. Systems never re-emit `input.*` events.
4. `use`: `input.interact` facing a non-item entity emits `entity.used { entity, held }`, where `held` is the item in hand or `null`. Hook: "To make something usable, listen for `entity.used` and check `ev.entity`; never handle `input.interact` for non-items yourself."
5. `daynight`: runs the clock through dawn, day, dusk and night, starting in the morning. Night is shorter than day so it isn't a chore. It emits:
   - `time.phase { phase, previous, day }` whenever the phase changes, plus a shortcut event for each phase with the same payload: `time.dawn`, `time.daytime`, `time.dusk`, `time.night`.
   - `time.newDay { day }` at dawn, when the day number goes up.
   - `time.hour { hour, day }` at every whole in-game hour.
   - `time.jumped { from, to }` when `time.set` moves the clock, followed by `time.phase` if the phase changed.

   Its `migrate` gives the player a faint `light`.

Some entities are both `item` and `pushable` (fallen logs). That's on purpose: interact picks them up, and walking into them pushes them.

**Contracts.** Every system's `contract` lets other systems (and a future AI) build on it without reading its code: `claims` lists each input it sets `handled` on and when (`"event: situation"`), `emits` each event with its payload and when it fires, and `hooks` one-line instructions for building on it. `npm test` checks that every event a system emits is in its own `emits` (attributed to the emitting system, not the running test) and that it only sets `handled` on inputs named in its `claims`.

**Tests.** `npm test` runs every system's `tests` headlessly, with no rendering. Each test starts a fresh world from the same fixed seed. Base tests run in an empty, walkable arena so later map changes can't break them, and use test-only types (`test_item`, `test_block`, `test_pushable`, drawn with neutral catalog sprites, registered only during tests) rather than real items. Each base system needs tests that prove its own promise, including the blocked cases: walking into a wall, pushing a log into a rock, dropping onto an occupied tile, both tiles of a log blocking. A test's `setup`, `expect` and the system's handlers share the same world, and `w.state` is that system's own `state`. `expect(w, check)` calls `check(condition, "what it means")` once per thing it verifies; a test passes only if every check passes and at least one ran.

**The `sim` helper.** Tests and shots get `sim` as a second `setup` argument. It plays the game through real input events, so every system reacts as in play:
- `sim.walk(dir, steps?)`, `sim.face(dir)` (sends `input.turn`), `sim.interact()`, `sim.secondary()`: send the input and run enough ticks for it to finish.
- `sim.teleport(x, y)`: put the player on a tile instantly.
- `sim.give(type)`: spawn a new item and put it in the player's hands, exactly as `carry` does.
- `sim.wait(ticks)`.
- `sim.press(inputEvent, data?)`: send any input event by name, so inputs added later are covered too.

Document `sim` in `api.d.ts` too.

## World

A hand-made forest clearing of about 30x20 tiles. This map is a blank canvas that the AI designer will fill in over time, so it should start sparse and calm. Most of the inside should be open, walkable ground, with a wide meadow in the middle. Lay it out the way a real clearing looks. The forest doesn't stop at a hard ring: the open space has an organic shape, not a rectangle. Put everything where it would naturally be: stumps and fallen logs near trees, rocks along the stream, flowers in the sunny open patches. Group things in small natural clusters (odd numbers read best), never on a grid, in rows, or mirrored. The picture should feel like a calm, real place with room to grow. When in doubt, leave it out.
- Ground: lighter `grass` (with `grass_detail` sprinkled in) forms a sunlit area in the open middle of the clearing, and `grass_dark` is the shade toward the trees. Skip `dirt` paths for now.
- Border: dense `tree_pine_cluster` and `tree_cluster` close off the map so the player can't leave. Vary the depth so the edge reads as forest, not a ring.
- Water: one short straight stream near an edge (`stream_h_left`, `stream_h` repeated, `stream_h_right`). The `pond` is optional.
- Trees and rocks inside (optional, use sparingly): a few `tree_round`, `tree_big_green`, `stump_big`, `rock_brown` and `rock_gray`. All of these are `solid`.
- Decoration (optional, light touch, not solid): `bush`, `fern`, `grass_tuft`, `daisy`, `flower_red`.
- Things to interact with, kept to a handful: 2 `log_fallen` (`item`, `pushable`), 1 `crate` (`pushable`), and a few `branch` and `stone` (`item`).
- The player is the `player` sprite.
- There is no hunger, health or survival stat.
- There are no light sources besides the player's faint glow: no fires, torches, lanterns or glowing things. Those are for the AI to add later.

## Presentation

**Art.** `src/catalog.json` lists every sprite we use; nothing outside it is drawn. Load the sheets once and draw by sprite id. Things to know beyond what the file shows:
- Sprites bigger than 16x16 anchor at their bottom-left tile and draw upward, so a tall tree's canopy covers the player walking behind it. `offset` is a pixel nudge applied when drawing.
- Entries with `frameW` and `frames` are horizontal strips: `anims` names frame ranges; `pieces: true` means each frame is a separate particle piece, not an animation.
- The `player` uses `dirs` (columns: down, up, left, right), `anims` by `rows`, and single-frame `poses` (`[col, row]`).
- `layer` is `ground` (flat, under everything), `object` (y-sorted with the player), `above` (over objects) or `overlay` (whole screen).
- Terrain tiles tagged `water` are not walkable.

**Rendering order:** terrain, then entities with a `sprite` component (`{ id, anim?, frame?, z? }`) sorted by layer, then by y, then by `z` for things on the same tile; then lighting, overlays, and the HUD. The engine plays a sprite's `anim` by name. When an entity moves without `instant`, its sprite slides to the new tile over the step time; for sprites with `dirs`, the engine plays the walk anim and picks the column from `facing`.

**Lighting.** A darkness layer covers the whole map, with its strength and color set by the time of day: a pale dawn, a neutral day, a warm golden dusk and a deep blue night. Night should be dark enough that you genuinely want light, like a real forest at night: the player's faint glow shows the ground right around them, but not much else. Any entity with a `light` component (`{ radius, color, strength, flicker? }`) cuts a soft, warm glow out of the darkness, and overlapping lights add together. The renderer handles this; systems only add or remove `light` components.

**HUD.** A bar directly below the map, at the same width and scale, so it never covers the play area. It uses the pack's pixel font (`Ui/Font/NormalFont.ttf`) at its native pixel size, in colors that match the art. On the left: a clock in 10-minute steps, like Stardew Valley (7:40 PM); the phase name (Dawn, Day, Dusk or Night), with the time speed beside it when it isn't 1x; and a small day bar with the phases shaded in their own colors and a marker for now. Leave the right side empty for things systems add later.

**Screen fit.** The whole map and the HUD are always visible, with no camera movement and no page scrolling. Use the largest whole-number scale at which both fit the window, recompute on resize, and center the canvas. Set the page to `overflow: hidden`.

**UI rules** (including anything systems add later): text never shifts layout. Every text slot reserves room for its widest possible value and anchors its text within it, and digits draw in fixed-width cells because the pixel font's digits vary in width. The map is never covered except by short banners that fade.

## Feel and tuning

Choose the numbers yourself. The game should feel calm and deliberate, like walking through a quiet forest in a classic top-down adventure such as early Zelda, Pokémon or Stardew Valley, not twitchy or arcade-fast. Put every feel value in `src/tuning.ts`: walking pace, slide time, tap-to-turn delay, the length of each day phase, the darkness and color of each phase, and the player's light. Give each a one-line comment saying what it controls and why you picked it. Nothing else should hard-code these values.

## Dev tools

All dev hotkeys call `preventDefault()`, as do the arrow keys, WASD and Space, so the page never scrolls or reloads.
- **T** cycles the time speed: 1x, 4x, 16x.
- **Shift+R** unloads and reloads all systems without losing world state.
- **Backtick** opens a dev panel, which swallows game input while open. Its first tab, "sprites", draws every catalog sprite at 4× zoom on a grass tile with the tile outline shown, and plays each named anim.

## Unspecified behaviour

Where this prompt doesn't specify a behaviour, pick the simplest choice that fits a classic top-down adventure, and write it into the system's contract. When you finish, list the decisions you made that this prompt didn't cover.

## Done when

Check every item yourself before you stop, and tell me which ones you verified and how. Mark anything you couldn't actually see as "needs human check".
- [ ] `npm test` passes, with tests for every base system, and gives the same result every run.
- [ ] Every base system has a contract, and `src/engine/api.d.ts` documents every call on `world` and `sim`.
- [ ] `spawn` with a type that isn't registered throws a clear error.
- [ ] A quick tap turns the player without moving; holding walks at a calm pace, with a smooth slide between tiles.
- [ ] Both tiles of a fallen log block the player, the whole log moves when pushed, and it only drops where both of its tiles are free.
- [ ] A test proves that a second handler on the same key does nothing once the first acts.
- [ ] Holding a branch and pressing interact facing a rock emits `entity.used` with the branch as `held`, and the branch stays in hand.
- [ ] While the player has the `busy` tag, no base system reacts to input.
- [ ] The player can walk behind a tree's canopy and stand beside its trunk, but not walk through the trunk, and can't leave the map.
- [ ] Shift+R reloads all systems without losing the world or duplicating anything.
- [ ] The whole map and the HUD fit the window, and nothing in the HUD moves when the clock changes.
- [ ] Night is dark enough that you want light, and dusk and dawn each have their own color.
- [ ] The middle of the map is open, sunlit meadow, and the border reads as forest, not a ring.
- [ ] In the sprites tab, every sprite draws whole and every anim plays cleanly, with no neighbouring frames bleeding in.
