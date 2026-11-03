# Example systems

Each folder here holds a `manifest.json` and a `module.ts`. The ones named in `PROMPT_EXAMPLES`
(src/ai/examples.ts; campfire only for now) go into the designer's prompt as `{{SYSTEM_EXAMPLES}}`.
The designer copies what it sees, so every example should be a good reference for these habits:

- **Read positions back, never assume them.** `spawn`, `place` and `tileStamp` use the nearest
  free spot when the asked one is taken. Use `posOf(id)` after a spawn (or `place`'s return) in
  code, and check against that in tests instead of the coordinates migrate asked for.
