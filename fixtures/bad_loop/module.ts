let ticks: i32 = 0;

export function onTick(): void {
  ticks++;
  if (ticks >= 50) {
    while (true) {}
  }
}
