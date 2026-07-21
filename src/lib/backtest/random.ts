/**
 * Deterministic hashing + PRNG for the backtest engine. Every run's randomness
 * (the random-entry baseline) is seeded from a hash of the canonical run config,
 * so the same inputs always produce identical outputs (spec: Determinism).
 */

/** JSON.stringify with sorted object keys — canonical form for hashing. */
export function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const keys = Object.keys(x as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((x as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** FNV-1a 32-bit hash. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hex hash of a config object (canonicalized). */
export function hashConfig(cfg: unknown): string {
  return fnv1a(stableStringify(cfg)).toString(16).padStart(8, "0");
}

/** mulberry32 — small, fast, deterministic PRNG. Returns a () => [0,1) function. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
