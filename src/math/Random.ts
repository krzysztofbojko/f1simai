/**
 * Simulation randomness. Defaults to Math.random (so existing seeding of
 * Math.random keeps working); `seedRandom(n)` switches to a reproducible
 * mulberry32 stream, `seedRandom(null)` restores the default.
 */
let source: (() => number) | null = null;

export function seedRandom(seed: number | null): void {
  if (seed === null) { source = null; return; }
  let s = seed >>> 0;
  source = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function random(): number {
  return source ? source() : Math.random();
}
