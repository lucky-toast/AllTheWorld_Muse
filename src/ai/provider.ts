/** One chat message in an AI conversation. */
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/**
 * The single seam between the designer loop and any AI backend.
 * Later, a real API provider can replace ManualProvider without changing
 * anything else: it just has to send messages and return the reply text.
 */
export interface AiProvider {
  send(messages: ChatMessage[]): Promise<string>;
}

/**
 * Manual provider: hands each outgoing message to the UI (which shows it for
 * the human to copy into an AI chat) and waits until the human pastes the
 * AI's reply back. The reply text is left in the box until the designer
 * accepts it, so a malformed reply can be fixed in place.
 */
export class ManualProvider implements AiProvider {
  onShow: (text: string, messages: ChatMessage[]) => void = () => {};
  private resolver: ((reply: string) => void) | null = null;

  send(messages: ChatMessage[]): Promise<string> {
    const last = messages[messages.length - 1];
    this.onShow(last?.content ?? "", messages);
    return new Promise<string>((resolve) => { this.resolver = resolve; });
  }
  /** Called by the UI when the human submits the pasted reply. */
  deliver(reply: string) {
    const r = this.resolver; this.resolver = null;
    if (r) r(reply);
  }
  get waiting(): boolean { return this.resolver !== null; }
}
