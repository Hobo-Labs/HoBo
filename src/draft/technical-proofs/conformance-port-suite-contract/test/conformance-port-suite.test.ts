import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createConformanceSuite,
  evaluateSdkParity,
  runConformanceSuite,
} from "../src/conformance-port-suite.js";

const addInput = { left: 2, right: 3 };
const addOutput = { sum: 5 };

function addGoldenIr(input = addInput, output = addOutput) {
  return [
    {
      op: "wit.call",
      interface: "hobo:toy-math/add@0.1.0",
      input,
    },
    {
      op: "manifest.emit",
      resource: "toy.sum",
      value: output.sum,
    },
  ];
}

function addTrace(input = addInput, output = addOutput) {
  return [
    {
      function: "add",
      input,
      output,
    },
  ];
}

function toySuite(overrides = {}) {
  return createConformanceSuite({
    id: "toy-math-port",
    port: {
      wit: "hobo:toy-math@0.1.0",
      functions: ["add"],
    },
    coverage: {
      requiredFunctions: ["add"],
    },
    cases: [
      {
        id: "adds-two-numbers",
        exercises: ["add"],
        call: {
          function: "add",
          input: addInput,
        },
        expect: {
          output: addOutput,
          goldenIr: addGoldenIr(),
          replayTrace: addTrace(),
        },
      },
    ],
    ...overrides,
  });
}

const passingToyAdapter = {
  id: "toy-adapter-good",
  async add(input) {
    const output = { sum: input.left + input.right };

    return {
      output,
      goldenIr: addGoldenIr(input, output),
      replayTrace: addTrace(input, output),
    };
  },
};

test("toy port adapter passes, and a broken adapter fails with a precise output diff", async () => {
  const passReport = await runConformanceSuite(toySuite(), passingToyAdapter, {
    seed: "hobo-5-stable-seed",
  });

  assert.equal(passReport.ok, true);
  assert.deepEqual(passReport.provenance, {
    suiteId: "toy-math-port",
    port: "hobo:toy-math@0.1.0",
    adapterId: "toy-adapter-good",
    seed: "hobo-5-stable-seed",
    cases: ["adds-two-numbers"],
  });
  assert.deepEqual(passReport.claim, {
    status: "listed",
    port: "hobo:toy-math@0.1.0",
    adapterId: "toy-adapter-good",
    failureCodes: [],
  });
  assert.deepEqual(passReport.coverage, {
    exercisedFunctions: ["add"],
    requiredFunctions: ["add"],
    unexercisedFunctions: [],
  });
  assert.deepEqual(
    passReport.assertions.map((assertion) => assertion.code),
    ["adapter.output", "golden-ir.equivalence", "trace-replay.equivalence"],
  );

  const brokenAdapter = {
    id: "toy-adapter-broken",
    async add(input) {
      const output = { sum: input.left - input.right };

      return {
        output,
        goldenIr: addGoldenIr(input, output),
        replayTrace: addTrace(input, output),
      };
    },
  };

  const failReport = await runConformanceSuite(toySuite(), brokenAdapter, {
    seed: "hobo-5-stable-seed",
  });

  assert.equal(failReport.ok, false);
  assert.deepEqual(failReport.claim, {
    status: "blocked",
    port: "hobo:toy-math@0.1.0",
    adapterId: "toy-adapter-broken",
    failureCodes: [
      "adapter.output-mismatch",
      "golden-ir.mismatch",
      "trace-replay.regression",
    ],
  });
  assert.deepEqual(failReport.failures[0], {
    code: "adapter.output-mismatch",
    caseId: "adds-two-numbers",
    function: "add",
    diff: {
      path: "$.sum",
      expected: 5,
      actual: -1,
    },
  });
});

test("golden-IR mismatches and replay trace regressions are reported separately", async () => {
  const driftedAdapter = {
    id: "toy-adapter-golden-and-replay-drift",
    async add(input) {
      const output = { sum: input.left + input.right };

      return {
        output,
        goldenIr: [
          {
            op: "wit.call",
            interface: "hobo:toy-math/subtract@0.1.0",
            input,
          },
        ],
        replayTrace: addTrace(input, { sum: 6 }),
      };
    },
  };

  const report = await runConformanceSuite(toySuite(), driftedAdapter, {
    seed: "hobo-5-stable-seed",
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.failures.map((failure) => failure.code),
    ["golden-ir.mismatch", "trace-replay.regression"],
  );
  assert.equal(report.failures[0].diff.path, "$[0].interface");
  assert.equal(report.failures[1].diff.path, "$[0].output.sum");
});

test("claimed-but-unexercised port functions fail the coverage manifest", async () => {
  const suite = toySuite({
    port: {
      wit: "hobo:toy-math@0.1.0",
      functions: ["add", "negate"],
    },
    coverage: {
      requiredFunctions: ["add", "negate"],
    },
  });

  const report = await runConformanceSuite(
    suite,
    {
      ...passingToyAdapter,
      async negate(input) {
        return {
          output: { value: -input.value },
          goldenIr: [],
          replayTrace: [],
        };
      },
    },
    { seed: "hobo-5-stable-seed" },
  );

  assert.equal(report.ok, false);
  assert.deepEqual(report.coverage, {
    exercisedFunctions: ["add"],
    requiredFunctions: ["add", "negate"],
    unexercisedFunctions: ["negate"],
  });
  assert.deepEqual(report.failures.at(-1), {
    code: "coverage.claimed-unexercised",
    functions: ["negate"],
  });
});

test("seeded determinism checks reject nondeterministic suites", async () => {
  let counter = 0;
  const suite = createConformanceSuite({
    id: "toy-clock-port",
    port: {
      wit: "hobo:toy-clock@0.1.0",
      functions: ["read"],
    },
    coverage: {
      requiredFunctions: ["read"],
    },
    cases: [
      {
        id: "reads-clock",
        exercises: ["read"],
        call: {
          function: "read",
          input: {},
        },
        expect: {
          goldenIr: [{ op: "wit.call", interface: "hobo:toy-clock/read@0.1.0" }],
          replayTrace: [{ function: "read" }],
        },
      },
    ],
  });

  const report = await runConformanceSuite(
    suite,
    {
      id: "toy-clock-nondeterministic",
      async read() {
        counter += 1;

        return {
          output: { tick: counter },
          goldenIr: [{ op: "wit.call", interface: "hobo:toy-clock/read@0.1.0" }],
          replayTrace: [{ function: "read" }],
        };
      },
    },
    { seed: "hobo-5-stable-seed" },
  );

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "determinism.seed-drift");
  assert.equal(report.failures[0].diff.path, "$.output.tick");
  assert.deepEqual(report.failures[0].seed, "hobo-5-stable-seed");
});

test("SDK parity rejects language-specific golden IR and missing annex vectors", () => {
  const report = evaluateSdkParity({
    language: "typescript",
    goldenIr: {
      equivalent: true,
      ir: [
        {
          op: "wit.call",
          interface: "hobo:toy-math/add@0.1.0",
          language: "typescript",
        },
      ],
    },
    semanticsAnnex: {
      vectors: [
        { category: "error-mapping", passed: true },
        { category: "async-ordering", passed: true },
      ],
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures, [
    {
      code: "golden-ir.language-leak",
      path: "$[0].language",
      language: "typescript",
    },
    {
      code: "semantics-annex.missing-vector",
      categories: ["cancellation", "ifc-side-effect-order"],
    },
  ]);
});
