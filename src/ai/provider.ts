// The seam between the planner and designer loops and any AI backend (spec 13.3, 13.5).
// ManualProvider hands messages to a human; MuseProvider sends them to the Meta Muse API
// through the dev server's /__ai proxy (devserver/ai.ts), which holds the key. SwitchProvider
// picks one of them on each send, so the wish chain never changes.

/** One image sent with a message, as base64 (no data: prefix). */
export interface ChatImage { mediaType: "image/png"; data: string }

/**
 * One chat message in an AI conversation. `cache: true` marks the end of the part a provider
 * may cache (the planner and designer send their prompt as two system messages, the first cached).
 * `images` go with the message to providers that can send them; ManualProvider ignores them.
 */
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; cache?: boolean; images?: ChatImage[] }

/** Real token counts from an API reply. `output` includes reasoning tokens. */
export interface AiUsage { input: number; cachedInput: number; output: number }

export interface AiProvider {
  send(messages: ChatMessage[]): Promise<string>;
  /** The usage of the last reply, when the provider knows it. */
  readonly lastUsage?: AiUsage | null;
}

/** The text a person pastes into an AI chat for this send: every message after the last reply, joined. */
export function outgoingText(messages: ChatMessage[]): string {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role !== "assistant") i--;
  return messages.slice(i).map((m) => m.content).join("");
}

/** Usage as one line: "in 12,345 (cached 11,000) · out 2,100 tokens". */
export function usageText(u: AiUsage): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `in ${n(u.input)} (cached ${n(u.cachedInput)}) · out ${n(u.output)} tokens`;
}

/**
 * Manual provider: hands each outgoing message to the UI (which shows it for the human to copy
 * into an AI chat) and waits until the human pastes the AI's reply back. The two system messages
 * of a prompt are joined, so the manual flow shows one text.
 */
export class ManualProvider implements AiProvider {
  onShow: (text: string, messages: ChatMessage[]) => void = () => {};
  private resolver: ((reply: string) => void) | null = null;

  send(messages: ChatMessage[]): Promise<string> {
    this.onShow(outgoingText(messages), messages);
    return new Promise<string>((resolve) => { this.resolver = resolve; });
  }
  /** Called by the UI when the human submits the pasted reply. */
  deliver(reply: string) {
    const r = this.resolver; this.resolver = null;
    if (r) r(reply);
  }
  get waiting(): boolean { return this.resolver !== null; }
}

// ---------------------------------------------------------------------------
// Chat Completions (the Muse API's OpenAI-compatible shape)
// ---------------------------------------------------------------------------
export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatCompletionsMessage { role: "system" | "user" | "assistant"; content: string | ChatPart[] }

/** The fixed user turn after the system messages, when the conversation starts without one. */
export const LEAD_USER_TEXT = "Follow the instructions above and reply.";
const imagePart = (img: ChatImage): ChatPart => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });

/**
 * Map our messages to Chat Completions messages. The leading system messages stay as they are,
 * in order, so the cached prefix is byte-stable. Images only go in user messages, so the system
 * messages' images move into a fixed leading user turn (added when the conversation has none
 * before its first reply); the rest map one to one, a user message's own images first.
 */
export function toChatCompletions(messages: ChatMessage[]): ChatCompletionsMessage[] {
  const out: ChatCompletionsMessage[] = [];
  const images: ChatImage[] = [];
  let i = 0;
  for (; i < messages.length && messages[i].role === "system"; i++) {
    out.push({ role: "system", content: messages[i].content });
    images.push(...(messages[i].images ?? []));
  }
  // A conversation that already starts with a user turn (none of ours do) takes the images there.
  let pending = images;
  if (messages[i]?.role !== "user") { out.push({ role: "user", content: [...images.map(imagePart), { type: "text", text: LEAD_USER_TEXT }] }); pending = []; }
  for (; i < messages.length; i++) {
    const m = messages[i];
    const imgs = m.role === "user" ? [...pending, ...(m.images ?? [])] : [];
    if (m.role === "user") pending = [];
    if (imgs.length) out.push({ role: "user", content: [...imgs.map(imagePart), { type: "text", text: m.content }] });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AiRoleName = "planner" | "designer";

/** A send that failed at the API or the proxy (not a pipeline problem). */
export class AiApiError extends Error { override name = "AiApiError"; }

/**
 * Muse provider: POSTs the messages to /__ai/chat and resolves with the reply text. A non-2xx
 * answer or a reply cut off at max_tokens rejects with a readable message, so a truncated reply
 * never burns a repair round. onShow fires before sending and onReply after, like the manual UI.
 */
export class MuseProvider implements AiProvider {
  onShow: (text: string, messages: ChatMessage[]) => void = () => {};
  onReply: (text: string, usage: AiUsage | null) => void = () => {};
  lastUsage: AiUsage | null = null;

  constructor(private opts: { role: AiRoleName; model: string; maxTokens: number; reasoningEffort?: ReasoningEffort; fetch?: typeof fetch; url?: string }) {}

  async send(messages: ChatMessage[]): Promise<string> {
    const { role, model, maxTokens, reasoningEffort } = this.opts;
    this.lastUsage = null;
    this.onShow(outgoingText(messages), messages);
    const body = JSON.stringify({ role, model, max_tokens: maxTokens, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), messages: toChatCompletions(messages) });
    const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    let res: Response;
    try { res = await f(this.opts.url ?? "/__ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body }); }
    catch (e) { throw new AiApiError(`the ${role} request couldn't reach the dev server (${e instanceof Error ? e.message : String(e)})`); }
    let data: { text?: unknown; finishReason?: unknown; usage?: AiUsage; error?: unknown } = {};
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok) throw new AiApiError(`the ${role} request failed (${res.status}): ${typeof data.error === "string" ? data.error : res.statusText || "no message"}`);
    if (data.usage) this.lastUsage = data.usage;
    if (data.finishReason === "length") throw new AiApiError(`the ${role}'s reply was cut off at max_tokens (${maxTokens})`);
    if (data.finishReason === "content_filter") throw new AiApiError(`the ${role}'s reply was stopped by the API's content filter`);
    if (typeof data.text !== "string" || !data.text.trim()) throw new AiApiError(`the ${role}'s reply was empty`);
    this.onReply(data.text, this.lastUsage);
    return data.text;
  }
}

/** Delegates each send to whichever provider pick() returns at that moment. */
export class SwitchProvider implements AiProvider {
  private last: AiProvider | null = null;
  constructor(private pick: () => AiProvider) {}
  send(messages: ChatMessage[]): Promise<string> { this.last = this.pick(); return this.last.send(messages); }
  get lastUsage(): AiUsage | null { return this.last?.lastUsage ?? null; }
}
