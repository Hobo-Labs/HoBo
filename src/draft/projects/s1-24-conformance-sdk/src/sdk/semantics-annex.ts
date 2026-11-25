import { canonicalJson, diffJsonPaths } from "./canonical-json.js";
import {
  SEMANTICS_ANNEX_SPEC_VERSION,
  type LaneReport,
  type SdkIdiomAdapter,
  type SemanticsAnnexVector,
  type VectorCaseResult,
} from "./types.js";


export class HoboWitError extends Error {
  readonly tag: string;

  constructor(payload: { tag: string; message?: string }) {
    super(payload.message ?? payload.tag);
    this.name = "HoboWitError";
    this.tag = payload.tag;
  }
}

export async function runSemanticsAnnex(
  vectors: readonly SemanticsAnnexVector[],
  adapter: SdkIdiomAdapter,
): Promise<LaneReport> {
  const cases: VectorCaseResult[] = [];

  for (const vector of vectors) {
    if (vector.category === "error-mapping") {
      cases.push(runErrorMappingVector(vector, adapter));
      continue;
    }
    if (vector.category === "cancellation") {
      cases.push(runCancellationVector(vector, adapter));
      continue;
    }
    if (vector.category === "async-ordering") {
      cases.push(await runCollectVector(vector, adapter));
      continue;
    }
    if (vector.category === "ifc-side-effects") {
      cases.push(await runExpectedErrorVector(vector, adapter));
      continue;
    }

    cases.push({
      name: vector.name,
      category: vector.category,
      status: "failed",
      reason: "unknown annex category",
      expectedJson: canonicalJson({ category: vector.category }),
      actualJson: canonicalJson({ category: "unknown" }),
      diffPaths: ["category"],
    });
  }

  return Object.freeze({
    lane: "semantics-annex",
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases,
  });
}

function runErrorMappingVector(
  vector: SemanticsAnnexVector,
  adapter: SdkIdiomAdapter,
): VectorCaseResult {
  const expected = vector.expectedThrow;
  if (!vector.result || !expected) {
    return failedCase(vector, "error-mapping vector missing result or expectedThrow", {}, {});
  }

  try {
    adapter.mapResult(vector.result);
    return failedCase(
      vector,
      "WIT err result returned instead of throwing a typed idiom-layer error",
      { thrown: expected },
      { thrown: null },
    );
  } catch (error) {
    const actual = {
      name: error instanceof Error ? error.name : "unknown",
      tag: error instanceof HoboWitError ? error.tag : "unknown",
    };
    const passed = actual.name === expected.name && actual.tag === expected.tag;
    if (passed) {
      return { name: vector.name, category: vector.category, status: "passed" };
    }

    return failedCase(
      vector,
      `unexpected error mapping: ${actual.name}:${actual.tag}`,
      expected,
      actual,
    );
  }
}

function runCancellationVector(
  vector: SemanticsAnnexVector,
  adapter: SdkIdiomAdapter,
): VectorCaseResult {
  if (!vector.signal || !vector.expected) {
    return failedCase(vector, "cancellation vector missing signal or expected", {}, {});
  }

  const actual = adapter.mapCancellation(vector.signal);
  const passed = canonicalJson(actual) === canonicalJson(vector.expected);
  if (passed) {
    return { name: vector.name, category: vector.category, status: "passed" };
  }

  return failedCase(
    vector,
    "cancellation did not lower to caller-owned cancelled result",
    vector.expected,
    actual,
  );
}

async function runCollectVector(
  vector: SemanticsAnnexVector,
  adapter: SdkIdiomAdapter,
): Promise<VectorCaseResult> {
  if (!vector.facts || !vector.expected) {
    return failedCase(vector, "async-ordering vector missing facts or expected", {}, {});
  }

  const actual = await adapter.collect(vector.facts);
  const passed = canonicalJson(actual) === canonicalJson(vector.expected);
  if (passed) {
    return { name: vector.name, category: vector.category, status: "passed" };
  }

  return failedCase(
    vector,
    "async collection order changed the observed declaration facts",
    vector.expected,
    actual,
  );
}

async function runExpectedErrorVector(
  vector: SemanticsAnnexVector,
  adapter: SdkIdiomAdapter,
): Promise<VectorCaseResult> {
  if (!vector.facts || !vector.expectedError) {
    return failedCase(vector, "ifc-side-effects vector missing facts or expectedError", {}, {});
  }

  try {
    await adapter.collect(vector.facts);
    return failedCase(
      vector,
      "missing resource handler order did not fail closed",
      { error: vector.expectedError },
      { error: null },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const passed = message.includes(vector.expectedError);
    if (passed) {
      return { name: vector.name, category: vector.category, status: "passed" };
    }

    return failedCase(vector, message, { error: vector.expectedError }, { error: message });
  }
}

function failedCase<T, U>(
  vector: SemanticsAnnexVector,
  reason: string,
  expected: T,
  actual: U,
): VectorCaseResult {
  return {
    name: vector.name,
    category: vector.category,
    status: "failed",
    reason,
    expectedJson: canonicalJson(expected),
    actualJson: canonicalJson(actual),
    diffPaths: diffJsonPaths(expected, actual),
  };
}

export const semanticsAnnexSpec = Object.freeze({
  version: SEMANTICS_ANNEX_SPEC_VERSION,
  categories: [
    "error-mapping",
    "cancellation",
    "async-ordering",
    "ifc-side-effects",
  ] as const,
  goldenIrBoundary:
    "Lowering equivalence proves WIT calls plus manifest IR only; this annex owns language control-flow semantics.",
});
