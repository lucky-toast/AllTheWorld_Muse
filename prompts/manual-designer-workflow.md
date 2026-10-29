Build the AI designer loop, but with **me as the messenger** instead of an API. The game builds the exact prompt an AI would get, I copy it into an AI chat myself, and I paste the AI's reply back into the game. Everything else works as if an API were connected, so it can later be swapped for a real API call without changing anything else.

Put the "send a message, get a reply" step behind one small interface, `AiProvider { send(messages): Promise<string> }`. The only provider for now is `ManualProvider`, which hands the message to the UI and waits for me to paste a reply.

## Building the prompt (`src/ai/designer.ts`)
`runUpdate(task: string)` builds the prompt from `src/ai/prompts/designer.md` (imported `?raw`). Use only the **System message** part of the template, and fill its slots:
- `{{PILLARS}}`: `src/ai/pillars.md`, created with the text below.
- `{{API}}`: the full text of `src/engine/api.d.ts`.
- `{{EXAMPLES}}`: the full source of `movement`, `carry` and the campfire fixture, each in its own fenced block with its file name.
- `{{WORLD}}`: generated as described below.
- `{{CATALOG}}`: one compact line per sprite from `catalog.json`: `id — desc · layer · WxH tiles · materials · anims: a, b`.
- `{{ART_BOARD}}`: replace it with the line "(See the attached art board image.)". Render the art board image itself: a labeled grid of every catalog sprite, showing the first frame at 2× zoom with its id underneath.
- `{{TASK}}`: the task I typed.

Check that no `{{` is left in the final text.

## What the designer sees of existing systems (`{{WORLD}}`)
Describe base systems and accepted AI systems the same way. For each system, list:
- its `id`, `why` and `buildsOn`
- its full `contract` (claims, emits, hooks), verbatim
- the components it adds, with their shapes
- the events it emits, each with one real example payload, recorded the first time the event fires
- the entity types it adds

Then add entity counts by type.

## The AI tab (backtick panel)
1. **Task box and Start button.** Starting builds the prompt and shows it in a read-only text area, with:
   - a **Copy prompt** button
   - a **Download art board** button (PNG)
   - the prompt's length in characters and estimated tokens (characters ÷ 4), so I can see what it would cost on Spark
2. **Reply box and Submit reply button.** From the pasted reply, take the ```ts block and the ```json block (`{ title, summary, changes[], journal }`). If either is missing or the JSON lacks a field, say so clearly and keep the reply box open. Then run `checkSystem(source)` (never `submitSystem`, which would load it) and show the pipeline's stage boxes. Use one row per attempt, so repairs read top to bottom.
3. **If a stage fails,** build the **Repair message** from the template, with `{{STAGE}}` and `{{REPORT}}` filled in. Show it with a Copy button and the reply box again. Allow up to 3 repairs, then stop and leave the game untouched.
4. **If every stage passes,** nothing is loaded yet: use `checkSystem`, never `submitSystem`, so the live game stays untouched until the visual check is done. Build the **Visual check message**. Show the shots from the Report as images, with a **Download shots** button, and the message with a Copy button. My pasted reply is either:
   - `{ "ok": true }`: call `loadChecked` with that report.
   - A corrected module: it is new, unchecked code, so run it through `checkSystem` again from the first stage, as a new row of stage boxes. If it fails, the normal repair loop continues. If it passes, show its new shots and load it with `loadChecked`. There's only 1 visual round, so it isn't asked to look again. **Never load a module that hasn't passed every stage itself.**
5. **On load,** the pipeline plays the transition and banner as usual. Append the whole JSON block (title, summary, changes, journal), with the system id and a timestamp, to `data/journal.json` (or `localStorage` without the dev server).

Keep a log of every message sent and reply received for each update, viewable in the tab and saved to `data/ai-log.jsonl`, so I can compare runs later. Show the estimated tokens (characters ÷ 4) for every attempt and the total for the update, because each repair resends the whole conversation and costs more than the last.

## "What changed" panel
Opened from the banner or with **C**. It shows the latest update's `title`, `summary` and `changes` as a short list, with its `journal` underneath, and lists every past update by title. Put it behind a setting so it can be turned off later.

## Pillars (`src/ai/pillars.md`)
Create it with exactly this text:
- **A place you want to stay.** The clearing is cozy, and being there feels good even when nothing is happening. *So no:* urgency, clutter, or things that nag for attention.
- **The forest answers you.** It's quiet until you touch it. Moving, carrying and using things makes the world respond. *So no:* systems that only run in the background, with nothing for the player to do or poke at.
- **Small wonders.** Now and then, something should happen that the player didn't expect but that feels right. Magic, strange visitors, even things from far-off places are welcome, as long as the world gives them a reason to be here. *So no:* more of the same, like a new item that's just a reskin with no behaviour, or something that appears for no reason.
- **Nothing hurts you.** You can't be damaged, die or lose progress. *So no:* enemies that attack, fail states or penalties.

## Done when
Check every item yourself and tell me how you verified each one:
- [ ] Start produces a complete prompt with no `{{` left, and Copy puts it on the clipboard.
- [ ] Pasting `fixtures/bad-test.ts` wrapped in a ```ts block, plus a ```json block with title, summary, changes and journal, fails at Tests and shows a ready-to-copy repair message.
- [ ] Pasting `campfire.ts` the same way passes, shows the shots and the visual check message, and `{ "ok": true }` loads it with the transition and banner.
- [ ] A reply without a ```ts block shows a clear message instead of crashing.
- [ ] Replying to the visual check with a corrected module runs the full pipeline again as a new row, and nothing loads until that row is all green. A corrected module that fails a stage is never loaded.
- [ ] After a refresh, the accepted system and its journal entry are still there.
- [ ] `{{WORLD}}` describes base and AI systems the same way, including every contract verbatim and the campfire once it's loaded.
- [ ] Nothing loads before `{ "ok": true }` or a fully re-checked correction: the stage boxes never show Load until then.
- [ ] `npm test` passes.
