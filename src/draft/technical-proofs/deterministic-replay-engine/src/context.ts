import crypto from "node:crypto";

import type { DeterministicContext, ReplayMode } from "./types.js";

export interface CreateDeterministicContextInput {
  seed: string;
  mode: ReplayMode;
  eventKey: string;
}

export function createDeterministicContext({
  seed,
  mode,
  eventKey,
}: CreateDeterministicContextInput): DeterministicContext {
  return Object.freeze({
    seed,
    mode,
    eventKey,
    now: () =>
      new Date(
        seededInt(`${seed}:${eventKey}:clock`, 1_700_000_000_000, 1_899_999_999_999),
      ).toISOString(),
    random: (label = "default") => seededUnit(`${seed}:${eventKey}:random:${label}`),
  });
}

function seededUnit(input: string): number {
  const hex = crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function seededInt(input: string, min: number, max: number): number {
  return Math.floor(seededUnit(input) * (max - min + 1)) + min;
}
