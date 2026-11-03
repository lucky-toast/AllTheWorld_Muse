# Example systems

Each folder here holds a `manifest.json` and a `module.ts`, and each is also a fixture
(`fixtures/<name>/`, the same files) that `npm test` runs through the whole pipeline. The ones named
in `PROMPT_EXAMPLES` (src/ai/examples.ts) go into the designer's prompt as `{{SYSTEM_EXAMPLES}}`:

| Example | In the prompt | What it shows |
|---|---|---|
| `campfire` | yes | Reacting to an event, timers and anim callbacks, a tween, a light, states as tags |
| `cottage` | yes | A building with a room in its own area: `doorOf`, going in with `travel` and out by stepping on a doorway (`player.moved`), furniture laid out exactly in the room, a `migrate` that is safe to run again |
| `fishing` | yes | A mini-game that takes the controls: `focus("borrow")` in `perform`, `onInput` keys and kinds, Escape, the overlay panel, a round kept in saved state, tunable numbers on the rod |
| `chop` | no | A held-tool interaction |

The designer copies what it sees, so every example should be a good reference for these habits:

- **Read positions back, never assume them.** `spawn`, `place` and `tileStamp` use the nearest
  free spot when the asked one is taken. Use `posOf(id)` after a spawn (or `place`'s return) in
  code, and check against that in tests instead of the coordinates migrate asked for.
- **`travel` needs a free tile.** It is refused unless that exact tile is free: find one first
  (`isFree`, then `spaceFind(x, y, 1, 1, area)`), as the cottage does going in and out.
- **Keys come as (key, kind).** `kind` is "down", "up" or "repeat" while held. The E that started a
  mini-game is still held when it begins, so its "up" arrives at `onInput` too: act on "down".
- **Anything that must outlive a reload goes in saved state or components.** A round of a mini-game
  in module globals would be lost on a reload while the controls stay taken.
