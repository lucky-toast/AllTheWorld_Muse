// Dev panel shell (spec 13.6). Backtick toggles it; it sits to the right of the map
// and swallows game input while open. Phase 1 has the Sprites tab; the Pipeline and
// AI tabs are added by later phases through addTab.
import { renderSpritesTab } from "../engine/render";

interface Tab { name: string; body: HTMLElement; draw?: (tick: number) => void }

export class DevPanel {
  private tabs: Tab[] = [];
  private active = 0;
  private bar: HTMLElement; private bodyRoot: HTMLElement;
  constructor(private root: HTMLElement) {
    this.bar = root.querySelector(".devtabs") as HTMLElement;
    this.bodyRoot = root.querySelector(".devbody") as HTMLElement;
    const canvas = document.createElement("canvas"); canvas.className = "spritecanvas";
    const ctx = canvas.getContext("2d")!;
    const body = document.createElement("div");
    const label = document.createElement("div"); label.className = "devsec"; label.textContent = "Every catalog sprite at 4x on grass";
    body.append(label, canvas);
    this.addTab("Sprites", body, (tick) => renderSpritesTab(ctx, tick));
  }
  addTab(name: string, body: HTMLElement, draw?: (tick: number) => void) {
    const tab: Tab = { name, body, draw }; this.tabs.push(tab);
    const btn = document.createElement("button"); btn.type = "button"; btn.textContent = name;
    const i = this.tabs.length - 1; btn.addEventListener("click", () => this.show(i));
    this.bar.append(btn); this.bodyRoot.append(body);
    this.show(this.active);
  }
  show(i: number) {
    this.active = i;
    this.tabs.forEach((t, j) => { t.body.hidden = j !== i; });
    [...this.bar.children].forEach((b, j) => b.classList.toggle("on", j === i));
  }
  get open() { return !this.root.hidden; }
  /** Draw the active tab (called each frame while open). */
  draw(tick: number) { if (this.open) this.tabs[this.active]?.draw?.(tick); }
}
