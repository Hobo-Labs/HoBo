import { createHash } from "node:crypto";

export interface DeterministicContext {
  seed: string;
  now(): string;
  random(label?: string): number;
}

export function createDeterministicContext(seed: string, startInstant = "2026-06-26T00:00:00.000Z"): DeterministicContext {
  let nowMs = Date.parse(startInstant);

  // SAFETY: assertion to `return Object.freeze({` is required at this boundary.
  return Object.freeze({
    seed,
    now() {
      return new Date(nowMs).toISOString();
    },
    random(label = "default") {
      return seededUnit(`${seed}:random:${label}`);
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setNowMs(nextMs: number) {
      nowMs = nextMs;
    },
    nowMs() {
      return nowMs;
    },
  }) as DeterministicContext & { advance(ms: number): void; setNowMs(nextMs: number): void; nowMs(): number };
}

export function withDeterminism<T>(ctx: DeterministicContext, callback: () => T): T {
  const originalDateNow = Date.now;
  const originalMathRandom = Math.random;

  Date.now = () => Date.parse(ctx.now());
  Math.random = () => ctx.random("ambient");

  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
  }
}

function seededUnit(input: string): number {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}
