Add a **design director** step to the AI tab's manual mode. The director is a second AI role that picks what to add next. Its reply becomes the designer's task. The flow is: director prompt → I paste its reply → designer prompt → the existing designer flow (repairs, visual check, load), unchanged.

Use the same `AiProvider` interface and `ManualProvider` as the designer.

## Building the prompt (`src/ai/director.ts`)
`buildDirectorPrompt()` builds the prompt from `src/ai/prompts/director.md` (imported `?raw`). Use only the **System message** part of the template, and fill its slots:
- `{{PILLARS}}`: `src/ai/pillars.md`.
- `{{SYSTEMS}}`: one entry per loaded system, base and AI-written alike, in load order. Each entry has:
  - its `id` and `name`, and its `why` as the plain description of what it does
  - the sprites it uses or adds: the sprites of the entity types it declares, plus every catalog sprite id that appears as a string in its source
  - its contract's `hooks`, verbatim
  
  No code, no component shapes, no event payloads.
- `{{MAP_IMAGE}}`: replace it with the line "(See the attached map image.)". Render the map image as described below.
- `{{SPRITES}}`: every catalog sprite, grouped under a heading per first tag (`tree`, `tool`, `animal`, ...). One line each: `id — desc · in use` or `id — desc · not yet used`. A sprite is **in use** if any tile or entity in the current world shows it, or it's listed under some system in `{{SYSTEMS}}`.
- `{{JOURNAL}}`: every entry in the journal, oldest first, one per update: its title, then its `journal` text. If the designer revised the director's entry, show both, labeled "Planned:" (the director's `journal`) and "Built:" (the designer's). If the journal is empty, write "(No entries yet. This is the first update.)"

Check that no `{{` is left in the final text.

## The map image
A PNG of the current world as the player would see it, but always in **daylight** (ignore the day/night darkness layer and time of day), with no HUD.
- Render at 3× scale.
- Draw a grid line around every tile, 1 px wide, white at about 25% opacity, over the sprites.
- Add a margin on the top and left edges, and label every column across the top and every row down the left side with its tile coordinate, exactly as the game uses it (the same `x` and `y` that `e.pos`, `tiles.get` and `moveTo` take), in a small, plain, readable font. The labels must line up with the tile centers.
- Keep it a pure function of the world (`renderMapImage(world): Promise<Blob>`), so tests can call it.

## The AI tab
1. **Two ways to start.** Next to the existing task box, add an **Ask the director** button. The task box stays as a manual fallback.
2. **Ask the director** builds the director prompt and shows it in a read-only text area, with a **Copy prompt** button, a **Download map** button (PNG), and the prompt's length in characters and estimated tokens (characters ÷ 4).
3. **Director reply box and Submit.** Take the ```json block from the pasted reply. Required fields: `title`, `brief`, `experience`, `buildsOn` (array), `sprites` (array) and `journal`. `where` and `later` are optional. If the block or a required field is missing, say exactly what's missing and keep the reply box open. Warn, without blocking, about any sprite id that isn't in the catalog, or any `buildsOn` entry that doesn't name a loaded system.
4. **Show the brief** as a small card with the title, experience, brief, and the other fields, and a **Send to designer** button.
5. **Send to designer** starts the existing designer flow, with `{{TASK}}` set to the director's whole reply, re-printed as a ```json block. Everything after that is unchanged.
6. **Task typed by hand:** append this line to the task, so the designer still writes a journal entry: "There is no director journal entry for this update. Write one yourself: 2 to 4 sentences on why this was added and what it could lead to."

## Journal and log
- On load, the journal entry saved to `data/journal.json` keeps everything it saves now (system id, timestamp, and the designer's `title`, `summary`, `changes`, `journal`), plus the director's whole reply under `director`, or `null` for a hand-typed task. When the designer's `journal` differs from the director's, keep both: the director's original stays in `director.journal`, and the designer's version is saved as `journal`, with `journalRevised: true`.
- If the designer gives up after 3 repairs, nothing is added to the journal.
- Log the director's prompt and reply in `data/ai-log.jsonl` as part of the same update as the designer's messages, with role `director` or `designer` on each message. Show the director's estimated tokens in the per-update total.

## Done when
Check every item yourself and tell me how you verified each one:
- [ ] Ask the director produces a complete prompt with no `{{` left. `{{SYSTEMS}}` lists every base system and the campfire (once loaded) in the same form, with hooks verbatim and no code.
- [ ] The downloaded map is in daylight even at night, has a grid line on every tile, and its edge labels line up with the tiles (check a known object, like the stream, against its coordinates).
- [ ] Sprites shown on the map are marked "in use"; a sprite that nothing shows or lists is marked "not yet used".
- [ ] The journal slot says "No entries yet" on a fresh game, and lists entries oldest first after updates.
- [ ] A director reply missing `experience` shows a clear message naming the field and keeps the box open; one with an unknown sprite id shows a warning but can still continue.
- [ ] Send to designer builds a designer prompt whose task section holds the director's reply as JSON, and the rest of the flow (repair, visual check, `loadChecked`) still works with the campfire fixture.
- [ ] After loading, `data/journal.json` has the `director` field. When the designer copied the entry unchanged, the next director prompt shows it once; when the designer rewrote it, the entry has `journalRevised: true` and the next director prompt shows both, as "Planned:" and "Built:".
- [ ] A hand-typed task still works and adds the "no director journal entry" line.
- [ ] `npm test` passes.
