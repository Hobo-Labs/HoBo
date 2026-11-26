import { isJsonObject } from "./json.js";
const reportSchema = "hobo.conformance.port-suite-report/v1";
const suiteSchema = "hobo.conformance.port-suite/v1";

const defaultAnnexCategories = [
  "error-mapping",
  "cancellation",
  "async-ordering",
  "ifc-side-effect-order",
];

const languageSpecificGoldenIrKeys = new Set([
  "exceptionClass",
  "jsSyntax",
  "language",
  "runtime",
  "runtimeLanguage",
  "tsNodeKind",
  "typescriptNodeKind",
]);

export function createConformanceSuite(definition) {
  if (!definition || !isJsonObject(definition)) {
    throw new TypeError("conformance suite definition is required");
  }
  if (!definition.id) {
    throw new TypeError("conformance suite id is required");
  }
  if (!definition.port?.wit) {
    throw new TypeError("conformance suite port.wit is required");
  }
  if (!Array.isArray(definition.port.functions) || definition.port.functions.length === 0) {
    throw new TypeError("conformance suite port.functions must name at least one function");
  }
  if (!Array.isArray(definition.cases) || definition.cases.length === 0) {
    throw new TypeError("conformance suite cases must contain at least one case");
  }

  const portFunctions = unique(definition.port.functions);
  const requiredFunctions = unique(definition.coverage?.requiredFunctions ?? portFunctions);

  return {
    schema: suiteSchema,
    id: definition.id,
    port: {
      ...cloneData(definition.port),
      functions: portFunctions,
    },
    coverage: {
      ...cloneData(definition.coverage ?? {}),
      requiredFunctions,
    },
    cases: cloneData(definition.cases),
  };
}

export async function runConformanceSuite(definition, adapter, options = {}) {
  const suite = createConformanceSuite(definition);
  const seed = options.seed ?? "hobo-conformance-default-seed";
  const failures = [];
  const assertions = [];
  const exercisedFunctions = new Set();

  for (const suiteCase of suite.cases) {
    const functionName = suiteCase.call?.function;
    for (const exercisedFunction of suiteCase.exercises ?? [functionName]) {
      if (exercisedFunction) {
        exercisedFunctions.add(exercisedFunction);
      }
    }

    if (!(adapter?.[functionName] instanceof Function)) {
      failures.push({
        code: "adapter.missing-function",
        caseId: suiteCase.id,
        function: functionName,
      });
      continue;
    }

    const firstRun = await runAdapterCase(suiteCase, adapter, seed);
    if (firstRun.error) {
      failures.push(firstRun.error);
      continue;
    }

    if (options.determinism !== false) {
      const secondRun = await runAdapterCase(suiteCase, adapter, seed);
      if (secondRun.error) {
        failures.push({
          ...secondRun.error,
          code: "determinism.second-run-failed",
        });
        continue;
      }

      const determinismDiff = firstDiff(firstRun.result, secondRun.result);
      if (determinismDiff) {
        failures.push({
          code: "determinism.seed-drift",
          caseId: suiteCase.id,
          function: functionName,
          seed,
          diff: determinismDiff,
        });
      }
    }

    compareExpected({
      assertions,
      failures,
      suiteCase,
      actual: firstRun.result,
    });
  }

  const requiredFunctions = suite.coverage.requiredFunctions;
  const exercised = requiredFunctions.filter((functionName) => exercisedFunctions.has(functionName));
  const unexercised = requiredFunctions.filter((functionName) => !exercisedFunctions.has(functionName));
  const coverage = {
    exercisedFunctions: exercised,
    requiredFunctions,
    unexercisedFunctions: unexercised,
  };

  if (unexercised.length > 0) {
    failures.push({
      code: "coverage.claimed-unexercised",
      functions: unexercised,
    });
  }

  const adapterId = adapter?.id ?? options.adapterId ?? "anonymous-adapter";
  const failureCodes = failures.map((failure) => failure.code);

  return {
    schema: reportSchema,
    ok: failures.length === 0,
    suiteId: suite.id,
    port: suite.port.wit,
    adapterId,
    seed,
    provenance: {
      suiteId: suite.id,
      port: suite.port.wit,
      adapterId,
      seed,
      cases: suite.cases.map((suiteCase) => suiteCase.id),
    },
    claim: {
      status: failures.length === 0 ? "listed" : "blocked",
      port: suite.port.wit,
      adapterId,
      failureCodes,
    },
    assertions,
    coverage,
    failures,
  };
}

export function evaluateSdkParity(input) {
  const failures = [];
  const language = input?.language ?? "unknown";

  if (input?.goldenIr?.equivalent === false) {
    failures.push({
      code: "golden-ir.mismatch",
    });
  }

  const languageLeak = firstLanguageSpecificGoldenIrField(input?.goldenIr?.ir ?? []);
  if (languageLeak) {
    failures.push({
      code: "golden-ir.language-leak",
      path: languageLeak.path,
      language,
    });
  }

  const passedCategories = new Set(
    (input?.semanticsAnnex?.vectors ?? [])
      .filter((vector) => vector?.passed === true)
      .map((vector) => vector.category),
  );
  const missingCategories = defaultAnnexCategories.filter(
    (category) => !passedCategories.has(category),
  );

  if (missingCategories.length > 0) {
    failures.push({
      code: "semantics-annex.missing-vector",
      categories: missingCategories,
    });
  }

  return {
    schema: "hobo.conformance.sdk-parity-report/v1",
    ok: failures.length === 0,
    language,
    failures,
  };
}

async function runAdapterCase(suiteCase, adapter, seed) {
  const functionName = suiteCase.call.function;

  try {
    const result = await adapter[functionName](
      cloneData(suiteCase.call.input),
      createCaseContext(seed, suiteCase.id),
    );

    return {
      result: normalizeAdapterResult(result),
    };
  } catch (error) {
    return {
      error: {
        code: "adapter.threw",
        caseId: suiteCase.id,
        function: functionName,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function compareExpected({ assertions, failures, suiteCase, actual }) {
  const expected = suiteCase.expect ?? {};
  const functionName = suiteCase.call.function;

  if (Object.hasOwn(expected, "output")) {
    const outputDiff = firstDiff(expected.output, actual.output);
    if (outputDiff) {
      failures.push({
        code: "adapter.output-mismatch",
        caseId: suiteCase.id,
        function: functionName,
        diff: outputDiff,
      });
    } else {
      assertions.push({
        code: "adapter.output",
        caseId: suiteCase.id,
        function: functionName,
      });
    }
  }

  if (Object.hasOwn(expected, "goldenIr")) {
    const leak = firstLanguageSpecificGoldenIrField(actual.goldenIr);
    if (leak) {
      failures.push({
        code: "golden-ir.language-leak",
        caseId: suiteCase.id,
        function: functionName,
        path: leak.path,
      });
    }

    const goldenIrDiff = firstDiff(expected.goldenIr, actual.goldenIr);
    if (goldenIrDiff) {
      failures.push({
        code: "golden-ir.mismatch",
        caseId: suiteCase.id,
        function: functionName,
        diff: goldenIrDiff,
      });
    } else {
      assertions.push({
        code: "golden-ir.equivalence",
        caseId: suiteCase.id,
        function: functionName,
      });
    }
  }

  if (Object.hasOwn(expected, "replayTrace")) {
    const traceDiff = firstDiff(expected.replayTrace, actual.replayTrace);
    if (traceDiff) {
      failures.push({
        code: "trace-replay.regression",
        caseId: suiteCase.id,
        function: functionName,
        diff: traceDiff,
      });
    } else {
      assertions.push({
        code: "trace-replay.equivalence",
        caseId: suiteCase.id,
        function: functionName,
      });
    }
  }
}

function normalizeAdapterResult(result) {
  if (isPlainObject(result) && hasHarnessResultContract(result)) {
    return {
      output: cloneData(result.output),
      goldenIr: cloneData(result.goldenIr ?? []),
      replayTrace: cloneData(result.replayTrace ?? result.trace ?? []),
    };
  }

  return {
    output: cloneData(result),
    goldenIr: [],
    replayTrace: [],
  };
}

function hasHarnessResultContract(result) {
  return (
    Object.hasOwn(result, "output") ||
    Object.hasOwn(result, "goldenIr") ||
    Object.hasOwn(result, "replayTrace") ||
    Object.hasOwn(result, "trace")
  );
}

function createCaseContext(seed, caseId) {
  return {
    seed,
    caseId,
    random: createSeededRandom(`${seed}:${caseId}`),
  };
}

function createSeededRandom(seed) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }

  return () => {
    state += 0x6d2b79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function firstDiff(expected, actual, path = "$") {
  if (Object.is(expected, actual)) {
    return null;
  }

  if (
    Object.prototype.toString.call(expected) !== Object.prototype.toString.call(actual) ||
    expected === null ||
    actual === null
  ) {
    return {
      path,
      expected,
      actual,
    };
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return {
        path,
        expected,
        actual,
      };
    }

    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= expected.length || index >= actual.length) {
        return {
          path: `${path}[${index}]`,
          expected: expected[index],
          actual: actual[index],
        };
      }

      const diff = firstDiff(expected[index], actual[index], `${path}[${index}]`);
      if (diff) {
        return diff;
      }
    }

    return null;
  }

  if (isJsonObject(expected)) {
    const keys = unique([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const diff = firstDiff(expected[key], actual[key], joinPath(path, key));
      if (diff) {
        return diff;
      }
    }

    return null;
  }

  return {
    path,
    expected,
    actual,
  };
}

function firstLanguageSpecificGoldenIrField(value, path = "$") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = firstLanguageSpecificGoldenIrField(value[index], `${path}[${index}]`);
      if (leak) {
        return leak;
      }
    }

    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  for (const key of Object.keys(value)) {
    const keyPath = joinPath(path, key);
    if (languageSpecificGoldenIrKeys.has(key)) {
      return {
        path: keyPath,
      };
    }

    const leak = firstLanguageSpecificGoldenIrField(value[key], keyPath);
    if (leak) {
      return leak;
    }
  }

  return null;
}

function joinPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function unique(values) {
  return [...new Set(values)];
}

function cloneData(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && isJsonObject(value) && !Array.isArray(value);
}
