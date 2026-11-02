// How the AI tab sends messages: "manual" (the dev panel, copy and paste) or "api" (the Muse API
// through the dev server). Stored like the "What changed" setting (src/ai/changed.ts).
export type AiMode = "manual" | "api";

const KEY = "atw.aiMode";
export function aiMode(): AiMode { try { return localStorage.getItem(KEY) === "api" ? "api" : "manual"; } catch { return "manual"; } }
export function setAiMode(mode: AiMode) { try { localStorage.setItem(KEY, mode); } catch { /* ignore */ } }
