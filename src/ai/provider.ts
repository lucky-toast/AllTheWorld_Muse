// The seam between the planner and designer loops and any AI backend (spec 13.3, 13.5).
// A real API provider can replace ManualProvider later without changing anything else:
// it only has to send messages and return the reply text.

/**
 * One chat message in an AI conversation. `cache: true` marks the end of the part a provider
 * may cache (the planner and designer send their prompt as two system messages, the first cached).
 */
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; cache?: boolean }

export interface AiProvider {
  send(messages: ChatMessage[]): Promise<string>;
}

/** The text a person pastes into an AI chat for this send: every message after the last reply, joined. */
export function outgoingText(messages: ChatMessage[]): string {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role !== "assistant") i--;
  return messages.slice(i).map((m) => m.content).join("");
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
