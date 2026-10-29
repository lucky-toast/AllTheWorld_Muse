import type { JournalLike } from "../pipeline/persistence";

const KEY = "atw.changedEnabled";
export function changedEnabled(): boolean { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } }
export function setChangedEnabled(on: boolean) { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* ignore */ } }

/** "What changed" panel: latest update's title/summary/changes/journal, plus every past update by title. Opened from the banner (canvas click) or with C. */
export class ChangedPanel {
  private entries: JournalLike[] = [];
  constructor(private root: HTMLElement) {
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close (C)"; close.className = "changed-close";
    close.addEventListener("click", () => this.hide());
    root.appendChild(close);
  }
  setEntries(entries: JournalLike[]) { this.entries = entries; if (!this.root.hidden) this.render(); }
  toggle() { if (!changedEnabled()) return; this.root.hidden = !this.root.hidden; if (!this.root.hidden) this.render(); }
  show() { if (!changedEnabled()) return; this.root.hidden = false; this.render(); }
  hide() { this.root.hidden = true; }
  get visible() { return !this.root.hidden; }
  private render() {
    const latest = this.entries[this.entries.length - 1];
    const list = this.entries.map((e) => `<div class="changed-past">${escapeHtml(e.title)} <span>(${escapeHtml(e.systemId)})</span></div>`).join("");
    this.root.innerHTML = `<button type="button" class="changed-close">Close (C)</button>` + (latest ? `
      <div class="changed-title">${escapeHtml(latest.title)}</div>
      <div>${escapeHtml(latest.summary)}</div>
      <ul>${latest.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
      <div class="changed-journal">${escapeHtml(latest.journal)}</div>
      <div class="devsec">Past updates</div>${list}` : `<div class="changed-title">What changed</div><div>No AI updates yet.</div>`);
    this.root.querySelector(".changed-close")?.addEventListener("click", () => this.hide());
  }
}
function escapeHtml(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
