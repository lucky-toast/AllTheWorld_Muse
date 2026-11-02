export function onTick(): void {
  const keep = new Array<Uint8Array>();
  while (true) {
    keep.push(new Uint8Array(65536));
  }
}
