import { isJsonObject } from "./json.js";
export class HoboWitError extends Error {
  constructor({ tag, message }) {
    super(message);
    this.name = "HoboWitError";
    this.tag = tag;
  }
}

export const semanticsAnnexSpec = Object.freeze({
  version: "hobo.sdk.semantics-annex/v1",
  categories: ["error-mapping", "cancellation", "async-ordering", "ifc-side-effects"],
  goldenIrBoundary:
    "Lowering equivalence proves WIT calls plus manifest IR only; this annex owns language control-flow semantics.",
});

export function createTypescriptIdiomAdapter(options = {}) {
  const {
    swallowResultErrors = false,
    hideCancellationAsRetry = false,
    useInputOrder = false,
  } = options;

  return {
    lower(program) {
      return lowerProgram(program);
    },

    mapResult(result) {
      if (Object.hasOwn(result, "ok")) {
        return result.ok;
      }

      if (!Object.hasOwn(result, "err")) {
        throw new TypeError("WIT result must contain ok or err");
      }

      if (swallowResultErrors) {
        return undefined;
      }

      throw new HoboWitError(result.err);
    },

    mapCancellation(signal) {
      if (hideCancellationAsRetry) {
        return { ok: { retried: true, reason: signal.reason } };
      }

      return {
        err: {
          tag: "cancelled",
          message: signal.reason,
          deadlineMs: signal.deadlineMs,
          retry: "caller-owned",
        },
      };
    },

    async collect(facts) {
      const declared = new Set();
      const observed = [];
      const orderedFacts = useInputOrder
        ? [...facts]
        : [...facts].sort((left, right) => left.sequence - right.sequence);

      for (const fact of orderedFacts) {
        await Promise.resolve();

        if (fact.kind === "resource") {
          declared.add(fact.name);
          observed.push(`resource:${fact.name}`);
          continue;
        }

        if (fact.kind === "handler") {
          if (!declared.has(fact.resource)) {
            throw new Error(
              `IfC order violation: handler ${fact.resource} observed before resource declaration`,
            );
          }
          observed.push(`handler:${fact.resource}:${fact.event}`);
          continue;
        }

        throw new Error(`unknown collection fact kind: ${fact.kind}`);
      }

      return { ok: observed };
    },
  };
}

export function runGoldenIrEquivalence(fixture, adapter) {
  const actual = adapter.lower(fixture.program);
  const passed =
    canonicalJson(actual.witCalls) === canonicalJson(fixture.expectedWitCalls) &&
    canonicalJson(actual.manifest) === canonicalJson(fixture.expectedManifest);

  return {
    lane: "golden-ir",
    fixture: fixture.name,
    status: passed ? "passed" : "failed",
  };
}

export async function runSemanticsAnnex(vectors, adapter) {
  const cases = [];

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
    });
  }

  return {
    suite: "@hobo/conformance/sdk/semantics-annex",
    specVersion: semanticsAnnexSpec.version,
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases,
  };
}

function runErrorMappingVector(vector, adapter) {
  try {
    adapter.mapResult(vector.result);
    return {
      name: vector.name,
      category: vector.category,
      status: "failed",
      reason: "WIT err result returned instead of throwing a typed idiom-layer error",
    };
  } catch (error) {
    const passed =
      error.name === vector.expectedThrow.name && error.tag === vector.expectedThrow.tag;
    return {
      name: vector.name,
      category: vector.category,
      status: passed ? "passed" : "failed",
      reason: passed ? undefined : `unexpected error mapping: ${error.name}:${error.tag}`,
    };
  }
}

function runCancellationVector(vector, adapter) {
  const actual = adapter.mapCancellation(vector.signal);
  const passed = canonicalJson(actual) === canonicalJson(vector.expected);

  return {
    name: vector.name,
    category: vector.category,
    status: passed ? "passed" : "failed",
    reason: passed ? undefined : "cancellation did not lower to caller-owned cancelled result",
  };
}

async function runCollectVector(vector, adapter) {
  const actual = await adapter.collect(vector.facts);
  const passed = canonicalJson(actual) === canonicalJson(vector.expected);

  return {
    name: vector.name,
    category: vector.category,
    status: passed ? "passed" : "failed",
    reason: passed ? undefined : "async collection order changed the observed declaration facts",
  };
}

async function runExpectedErrorVector(vector, adapter) {
  try {
    await adapter.collect(vector.facts);
    return {
      name: vector.name,
      category: vector.category,
      status: "failed",
      reason: "missing resource handler order did not fail closed",
    };
  } catch (error) {
    const passed = error.message.includes(vector.expectedError);
    return {
      name: vector.name,
      category: vector.category,
      status: passed ? "passed" : "failed",
      reason: passed ? undefined : error.message,
    };
  }
}

function lowerProgram(program) {
  const resources = [...program.resources].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
  const handlers = [...(program.handlers ?? [])].sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      left.event.localeCompare(right.event) ||
      left.exportName.localeCompare(right.exportName),
  );

  return {
    witCalls: [
      ...resources.map((resource) => ({
        interface: "hobo:sdk/resource-catalog",
        function: "declare-resource",
        args: { kind: resource.kind, name: resource.name },
      })),
      ...handlers.map((handler) => ({
        interface: "hobo:sdk/handlers",
        function: "attach-handler",
        args: handler,
      })),
    ],
    manifest: {
      schema: "hobo.manifest/v1",
      bindle: program.bindle,
      resources: resources.map((resource) => ({ kind: resource.kind, name: resource.name })),
      handlers,
    },
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
