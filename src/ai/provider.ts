// The seam between the planner and designer loops and the AI backend (spec 13.3, 13.5).
// MuseProvider sends messages to the Meta Muse API's Responses endpoint through the dev server's
// /__ai proxy (devserver/ai.ts), which holds the key. Tests use scripted providers in its place.
import type { ToolCall, ToolSpec } from "./tools";

/** One image sent with a message, as base64 (no data: prefix). */
export interface ChatImage { mediaType: "image/png"; data: string }

/**
 * One chat message in an AI conversation. `cache: true` marks the end of the part a provider
 * may cache (the planner and designer send their prompt as two system messages, the first cached).
 * `images` go with the message (the designer's maps).
 * `output` is, on an assistant message, the raw Responses output items of that reply (reasoning,
 * with its encrypted content, and the message): replayed unchanged on the next send so the model's
 * reasoning carries over. Opaque; nothing reads inside it. A "tool" message is the result of one
 * function call: `content` is the result text and `callId` the call it answers.
 */
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; cache?: boolean; images?: ChatImage[]; output?: unknown[]; callId?: string }

/** Per-send options: the tools the model may call. */
export interface SendOptions { tools?: readonly ToolSpec[] }

/** Real token counts from an API reply. `output` includes `reasoning`, when the API reports it. */
export interface AiUsage { input: number; cachedInput: number; output: number; reasoning?: number }

/** One API call, as the provider saw it: for the usage log (src/ai/stats.ts). */
export interface AiCall {
  model: string;
  /** Null when the call failed before the API answered. */
  usage: AiUsage | null;
  /** Wall time of the call, in milliseconds. */
  ms: number;
  ok: boolean;
  finishReason: string | null;
  error?: string;
}

export interface AiProvider {
  /** Resolves with the reply text. With tools, a reply that only calls tools may have empty text: see lastToolCalls. */
  send(messages: ChatMessage[], opts?: SendOptions): Promise<string>;
  /** The function calls in the last successful reply, in order; empty when it called none. */
  readonly lastToolCalls?: readonly ToolCall[];
  /** The last API call, when the provider makes them (scripted test providers may not). Set even when the send rejects. */
  readonly lastCall?: AiCall | null;
  /** The raw output items of the last successful reply, for providers that replay them (see ChatMessage.output). */
  readonly lastOutput?: unknown[] | null;
}

/** The assistant message for a reply `provider` just gave: its text, plus its output items to replay when it has them. */
export function replyMessage(provider: AiProvider, reply: string): ChatMessage {
  const output = provider.lastOutput;
  return output?.length ? { role: "assistant", content: reply, output } : { role: "assistant", content: reply };
}

/** The new text of this send, for the AI tab and log: every message after the last reply, joined. */
export function outgoingText(messages: ChatMessage[]): string {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role !== "assistant") i--;
  return messages.slice(i).map((m) => m.content).join("");
}

/** Usage as one line: "in 12,345 (cached 11,000) · out 2,100 (reasoning 1,500) tokens". */
export function usageText(u: AiUsage): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `in ${n(u.input)} (cached ${n(u.cachedInput)}) · out ${n(u.output)}${u.reasoning ? ` (reasoning ${n(u.reasoning)})` : ""} tokens`;
}

// ---------------------------------------------------------------------------
// Responses API input (the Muse API's stateless Responses shape)
// ---------------------------------------------------------------------------
export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
export type InputMessage =
  | { role: "developer" | "user"; content: string | InputPart[] }
  | { role: "assistant"; content: { type: "output_text"; text: string }[] };
/** One Responses input item: a message we build, a tool result, or an output item replayed as it came back. */
export type ResponsesItem = InputMessage | Record<string, unknown>;

/** The fixed user turn after the system messages, when the conversation starts without one. */
export const LEAD_USER_TEXT = "Follow the instructions above and reply.";
const imagePart = (img: ChatImage): InputPart => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` });

/**
 * Map our messages to Responses input items. The leading system messages become developer items,
 * in order and unchanged, so the cached prefix is byte-stable. Images only go in user items, so
 * the system messages' images move into a fixed leading user turn (added when the conversation has
 * none before its first reply). An assistant message with `output` items replays them unchanged
 * (that is how its reasoning carries over); one without (a scripted test reply) becomes an output_text
 * message. The rest map one to one, a user message's own images first.
 */
export function toResponsesInput(messages: ChatMessage[]): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  const images: ChatImage[] = [];
  let i = 0;
  for (; i < messages.length && messages[i].role === "system"; i++) {
    out.push({ role: "developer", content: messages[i].content });
    images.push(...(messages[i].images ?? []));
  }
  // A conversation that already starts with a user turn (none of ours do) takes the images there.
  let pending = images;
  if (messages[i]?.role !== "user") { out.push({ role: "user", content: [...images.map(imagePart), { type: "input_text", text: LEAD_USER_TEXT }] }); pending = []; }
  for (; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      if (m.output?.length) out.push(...(m.output as Record<string, unknown>[]));
      else out.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      continue;
    }
    if (m.role === "tool") { out.push({ type: "function_call_output", call_id: m.callId ?? "", output: m.content }); continue; }
    const role = m.role === "system" ? "developer" : "user";
    const imgs = role === "user" ? [...pending, ...(m.images ?? [])] : [];
    if (role === "user") pending = [];
    if (imgs.length) out.push({ role, content: [...imgs.map(imagePart), { type: "input_text", text: m.content }] });
    else out.push({ role, content: m.content });
  }
  return out;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AiRoleName = "planner" | "designer";

/** A send that failed at the API or the proxy (not a pipeline problem). */
export class AiApiError extends Error { override name = "AiApiError"; }

/**
 * Muse provider: POSTs the messages, as Responses input items, to /__ai/chat and resolves with
 * the reply text; the reply's output items are kept in lastOutput for replay. A non-2xx
 * answer or a reply cut off at max_tokens rejects with a readable message, so a truncated reply
 * never burns a repair round. onShow fires before sending and onReply after, for the AI tab.
 */
export class MuseProvider implements AiProvider {
  onShow: (text: string, messages: ChatMessage[]) => void = () => {};
  onReply: (text: string, usage: AiUsage | null) => void = () => {};
  lastCall: AiCall | null = null;
  lastOutput: unknown[] | null = null;
  lastToolCalls: ToolCall[] = [];
  /** The usage of the last reply, if any. */
  get lastUsage(): AiUsage | null { return this.lastCall?.usage ?? null; }

  constructor(private opts: { role: AiRoleName; model: string; maxTokens: number; reasoningEffort?: ReasoningEffort; fetch?: typeof fetch; url?: string }) {}

  async send(messages: ChatMessage[], sendOpts: SendOptions = {}): Promise<string> {
    const { role, model, maxTokens, reasoningEffort } = this.opts;
    this.lastCall = null;
    this.lastOutput = null;
    this.lastToolCalls = [];
    this.onShow(outgoingText(messages), messages);
    const t0 = Date.now();
    const fail = (msg: string, usage: AiUsage | null = null, finishReason: string | null = null): never => {
      this.lastCall = { model, usage, ms: Date.now() - t0, ok: false, finishReason, error: msg };
      throw new AiApiError(msg);
    };
    const body = JSON.stringify({ role, model, max_tokens: maxTokens, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), input: toResponsesInput(messages), ...(sendOpts.tools?.length ? { tools: sendOpts.tools } : {}) });
    const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    let res: Response;
    try { res = await f(this.opts.url ?? "/__ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body }); }
    catch (e) { return fail(`the ${role} request couldn't reach the dev server (${e instanceof Error ? e.message : String(e)})`); }
    let data: { text?: unknown; finishReason?: unknown; output?: unknown; usage?: AiUsage; error?: unknown } = {};
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok) return fail(`the ${role} request failed (${res.status}): ${typeof data.error === "string" ? data.error : res.statusText || "no message"}`);
    const usage = data.usage ?? null;
    const finish = typeof data.finishReason === "string" ? data.finishReason : null;
    if (finish === "length") return fail(`the ${role}'s reply was cut off at max_tokens (${maxTokens})`, usage, finish);
    if (finish === "content_filter") return fail(`the ${role}'s reply was stopped by the API's content filter`, usage, finish);
    const output = Array.isArray(data.output) ? data.output : null;
    const calls = toolCallsIn(output);
    const text = typeof data.text === "string" ? data.text : "";
    if (!text.trim() && !calls.length) return fail(`the ${role}'s reply was empty`, usage, finish);
    this.lastCall = { model, usage, ms: Date.now() - t0, ok: true, finishReason: finish };
    this.lastOutput = output;
    this.lastToolCalls = calls;
    this.onReply(text, usage);
    return text;
  }
}

/** The function_call items of a Responses output, in order. */
export function toolCallsIn(output: unknown): ToolCall[] {
  if (!Array.isArray(output)) return [];
  return (output as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown }[])
    .filter((o) => o?.type === "function_call" && typeof o.call_id === "string" && typeof o.name === "string")
    .map((o) => ({ callId: o.call_id as string, name: o.name as string, arguments: typeof o.arguments === "string" ? o.arguments : "" }));
}
