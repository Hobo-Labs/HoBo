import assert from "node:assert/strict";
import { test } from "vitest";

import { createExperimentEvent } from "../../hobo-experiment-port/src/experiment-contract.js";
import {
  analyzeExperiment,
  ExperimentAnalysisError
} from "../src/experiment-statistical-analysis.js";

function experimentDefinition(overrides = {}) {
  return {
    key: "checkout-copy",
    controlVariant: "control",
    minimumSamplesPerVariant: 4,
    primaryConfidence: 0.95,
    metrics: [
      {
        name: "checkout.completed",
        role: "primary",
        direction: "increase",
        minDetectableEffect: 0.2,
        bounds: [0, 1]
      },
      {
        name: "checkout.error_rate",
        role: "guardrail",
        direction: "decrease",
        maxRegression: 0.05,
        bounds: [0, 1]
      }
    ],
    ...overrides
  };
}

function plannedExperimentDefinition(seq, overrides = {}) {
  const requestedPlan = overrides.analysisPlan ?? {};
  return experimentDefinition({
    ...overrides,
    analysisPlan: {
      multipleComparisons: "bonferroni",
      peekingProtection: "locked-schedule",
      ...requestedPlan,
      lookSchedule: requestedPlan.lookSchedule ?? [{ seq }]
    }
  });
}

function exposure(subjectKey, variantKey, overrides = {}) {
  return {
    type: "experiment.Exposed",
    id: `${variantKey}:${subjectKey}`,
    data: {
      experimentKey: "checkout-copy",
      subjectKey,
      variantKey,
      sampling: {
        population: "sampled",
        sampled: true,
        rateBasisPoints: 10000
      },
      ...overrides
    }
  };
}

function metric(subjectKey, variantKey, metricName, value) {
  return {
    experimentKey: "checkout-copy",
    subjectKey,
    variantKey,
    metricName,
    value
  };
}

function metricEvent(observation) {
  return {
    type: "metric.Observed",
    data: observation
  };
}

function cohort(variantKey, values, metricName = "checkout.completed") {
  return values.map((value, index) => {
    const subjectKey = `${variantKey}-${index}`;
    return {
      exposure: exposure(subjectKey, variantKey),
      metric: metric(subjectKey, variantKey, metricName, value)
    };
  });
}

function flatten(groups) {
  return groups.flatMap((group) => group);
}

test("analysis is pure and replayable for fixed exposures and metrics", () => {
  const rows = flatten([
    cohort("control", [0, 0, 0, 0]),
    cohort("treatment", [1, 1, 1, 1])
  ]);
  const input = {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => metricEvent(row.metric)),
    seq: 42
  };

  const left = analyzeExperiment(plannedExperimentDefinition(42), input);
  const right = analyzeExperiment(plannedExperimentDefinition(42), input);

  assert.deepEqual(left, right);
  assert.equal(left.event.type, "experiment.Concluded");
  assert.equal(left.event.seq, 42);
  assert.doesNotThrow(() => createExperimentEvent("experiment.Concluded", left.event.data));
});

test("clearly winning variant concludes winner with confidence interval", () => {
  const rows = flatten([
    cohort("control", [0, 0, 0, 0, 0, 0]),
    cohort("treatment", [1, 1, 1, 1, 1, 1])
  ]);

  const analysis = analyzeExperiment(plannedExperimentDefinition(7), {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => row.metric),
    seq: 7
  });

  assert.equal(analysis.outcome, "winner");
  assert.equal(analysis.event.data.verdict, "promote");
  assert.equal(analysis.event.data.winningVariant, "treatment");
  assert.equal(analysis.primary.interval.lower > 0, true);
  assert.equal(analysis.primary.confidence, 0.95);
});

test("missing locked analysis schedule fails closed instead of defaulting to winner", () => {
  const rows = flatten([
    cohort("control", [0, 0, 0, 0, 0, 0]),
    cohort("treatment", [1, 1, 1, 1, 1, 1])
  ]);

  const analysis = analyzeExperiment(experimentDefinition(), {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => row.metric),
    seq: 20
  });

  assert.equal(analysis.outcome, "inconclusive");
  assert.equal(analysis.event.data.verdict, "inconclusive");
  assert.match(analysis.event.data.reason, /missing locked analysis schedule/);
});

test("underpowered experiment is inconclusive and never a false winner", () => {
  const rows = flatten([
    cohort("control", [0, 0]),
    cohort("treatment", [1, 1])
  ]);

  const analysis = analyzeExperiment(plannedExperimentDefinition(8), {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => row.metric),
    seq: 8
  });

  assert.equal(analysis.outcome, "inconclusive");
  assert.equal(analysis.event.data.verdict, "inconclusive");
  assert.match(analysis.event.data.reason, /insufficient sample/);
});

test("underpowered A/A look is inconclusive instead of no-difference", () => {
  const rows = flatten([cohort("control", [0]), cohort("treatment", [0])]);

  const analysis = analyzeExperiment(plannedExperimentDefinition(21), {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => row.metric),
    seq: 21
  });

  assert.equal(analysis.outcome, "inconclusive");
  assert.equal(analysis.event.data.verdict, "inconclusive");
  assert.match(analysis.event.data.reason, /insufficient sample/);
});

test("guardrail regression flips a would-be winner to do not ship", () => {
  const primaryRows = flatten([
    cohort("control", [0, 0, 0, 0, 0, 0]),
    cohort("treatment", [1, 1, 1, 1, 1, 1])
  ]);
  const guardrailRows = flatten([
    cohort("control", [0, 0, 0, 0, 0, 0], "checkout.error_rate"),
    cohort("treatment", [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], "checkout.error_rate")
  ]);

  const analysis = analyzeExperiment(plannedExperimentDefinition(9), {
    exposures: primaryRows.map((row) => row.exposure),
    metrics: [...primaryRows, ...guardrailRows].map((row) => row.metric),
    seq: 9
  });

  assert.equal(analysis.outcome, "do-not-ship");
  assert.equal(analysis.event.data.verdict, "rollback");
  assert.equal(analysis.guardrails[0].regressed, true);
  assert.equal(
    analysis.guardrails[0].interval.lower > analysis.guardrails[0].maxRegression,
    true
  );
});

test("extreme metric outlier cannot let one subject flip the verdict", () => {
  const controlValues = Array(100).fill(0.5);
  const treatmentValues = Array(99).fill(0.5).concat(100);
  const rows = flatten([
    cohort("control", controlValues),
    cohort("treatment", treatmentValues)
  ]);

  const analysis = analyzeExperiment(plannedExperimentDefinition(10), {
    exposures: rows.map((row) => row.exposure),
    metrics: rows.map((row) => row.metric),
    seq: 10
  });

  assert.equal(analysis.outcome, "no-difference");
  assert.equal(analysis.event.data.verdict, "inconclusive");
  assert.equal(analysis.primary.outliersClamped, 1);
});

test("sampled exposure counts are scaled instead of treated as full traffic", () => {
  const sampledExposure = (subjectKey, variantKey) =>
    exposure(subjectKey, variantKey, {
      sampling: {
        population: "sampled",
        sampled: true,
        rateBasisPoints: 5000
      }
    });
  const exposures = [
    sampledExposure("control-0", "control"),
    sampledExposure("treatment-0", "treatment")
  ];
  const metrics = [
    metric("control-0", "control", "checkout.completed", 0),
    metric("treatment-0", "treatment", "checkout.completed", 1)
  ];

  const analysis = analyzeExperiment(
    plannedExperimentDefinition(11, { minimumSamplesPerVariant: 1 }),
    {
      exposures,
      metrics,
      seq: 11
    }
  );

  assert.equal(analysis.variants.control.observedExposures, 1);
  assert.equal(analysis.variants.control.populationEstimate, 2);
  assert.equal(analysis.variants.treatment.populationEstimate, 2);

  const underpowered = analyzeExperiment(
    plannedExperimentDefinition(12, { minimumSamplesPerVariant: 2 }),
    {
      exposures,
      metrics,
      seq: 12
    }
  );

  assert.equal(underpowered.outcome, "inconclusive");
  assert.match(underpowered.event.data.reason, /insufficient sample/);
});

test("zero exposures conclude inconclusive instead of divide by zero", () => {
  const analysis = analyzeExperiment(experimentDefinition(), {
    exposures: [],
    metrics: [],
    seq: 13
  });

  assert.equal(analysis.outcome, "inconclusive");
  assert.equal(analysis.event.data.verdict, "inconclusive");
  assert.match(analysis.event.data.reason, /zero exposures/);
});

test("sampled exposure without a sampling rate fails closed", () => {
  assert.throws(
    () =>
      analyzeExperiment(experimentDefinition(), {
        exposures: [
          exposure("control-0", "control", {
            sampling: { population: "sampled", sampled: true }
          })
        ],
        metrics: [],
        seq: 14
      }),
    (error) =>
      error instanceof ExperimentAnalysisError &&
      error.code === "invalid-sampling-marker"
  );
});

test("locked look schedule blocks favorable peeking before the scheduled analysis", () => {
  const rows = flatten([
    cohort("control", [0, 0, 0, 0, 0, 0]),
    cohort("treatment", [1, 1, 1, 1, 1, 1])
  ]);

  const analysis = analyzeExperiment(
    experimentDefinition({
      analysisPlan: {
        peekingProtection: "locked-schedule",
        lookSchedule: [{ seq: 30 }]
      }
    }),
    {
      exposures: rows.map((row) => row.exposure),
      metrics: rows.map((row) => row.metric),
      seq: 12
    }
  );

  assert.equal(analysis.outcome, "inconclusive");
  assert.match(analysis.event.data.reason, /not a scheduled analysis look/);
});

test("A/A calibration corpus never produces spurious winners under repeated looks", () => {
  const values = Array.from({ length: 100 }, (_, index) => index % 2);
  const looks = [1, 2, 3, 4, 5];
  const analyses = Array.from({ length: 20 }, () => {
    const rows = flatten([cohort("control", values), cohort("treatment", values)]);
    return looks.map((seq) =>
      analyzeExperiment(
        plannedExperimentDefinition(5, {
          analysisPlan: {
            lookSchedule: [{ seq: 5 }]
          }
        }),
        {
          exposures: rows.map((row) => row.exposure),
          metrics: rows.map((row) => row.metric),
          seq
        }
      )
    );
  }).flat();

  const winners = analyses.filter((analysis) => analysis.outcome === "winner");
  const finalLooks = analyses.filter((analysis) => analysis.event.seq === 5);

  assert.equal(winners.length, 0);
  assert.equal(winners.length / analyses.length <= 0.05, true);
  assert.equal(finalLooks.every((analysis) => analysis.outcome === "no-difference"), true);
  assert.equal(finalLooks.length, 20);
});

test("metric-family correction prevents a post-hoc many-metric win", () => {
  const rows = flatten([
    cohort("control", Array(10).fill(0)),
    cohort("treatment", [1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
  ]);

  const analysis = analyzeExperiment(
    plannedExperimentDefinition(15, {
      metrics: [
        {
          name: "checkout.completed",
          role: "primary",
          direction: "increase",
          minDetectableEffect: 0.2,
          bounds: [0, 1]
        },
        { name: "cart.added", role: "secondary", direction: "increase", bounds: [0, 1] },
        { name: "email.clicked", role: "secondary", direction: "increase", bounds: [0, 1] },
        { name: "session.length", role: "secondary", direction: "increase", bounds: [0, 1] }
      ],
      analysisPlan: {
        multipleComparisons: "bonferroni"
      }
    }),
    {
      exposures: rows.map((row) => row.exposure),
      metrics: rows.map((row) => row.metric),
      seq: 15
    }
  );

  assert.equal(analysis.outcome, "no-difference");
  assert.equal(analysis.primary.multiplicity.familySize, 4);
  assert.equal(analysis.primary.multiplicity.method, "bonferroni");
  assert.equal(analysis.primary.confidence > 0.95, true);
});

test("required sample-size power floor blocks tiny-sample certainty", () => {
  const rows = flatten([
    cohort("control", Array(20).fill(0)),
    cohort("treatment", Array(20).fill(1))
  ]);

  const analysis = analyzeExperiment(
    plannedExperimentDefinition(16, {
      minimumSamplesPerVariant: 1,
      metrics: [
        {
          name: "checkout.completed",
          role: "primary",
          direction: "increase",
          minDetectableEffect: 0.05,
          bounds: [0, 1]
        }
      ]
    }),
    {
      exposures: rows.map((row) => row.exposure),
      metrics: rows.map((row) => row.metric),
      seq: 16
    }
  );

  assert.equal(analysis.outcome, "inconclusive");
  assert.match(analysis.event.data.reason, /insufficient sample/);
  assert.equal(analysis.primary.comparisons[0].requiredSampleSize > 20, true);
});

test("post-hoc primary metric swap is rejected", () => {
  const rows = flatten([
    cohort("control", Array(6).fill(0)),
    cohort("treatment", Array(6).fill(1))
  ]);

  assert.throws(
    () =>
      analyzeExperiment(experimentDefinition(), {
        exposures: rows.map((row) => row.exposure),
        metrics: rows.map((row) => row.metric),
        primaryMetricName: "posthoc.revenue",
        seq: 17
      }),
    (error) =>
      error instanceof ExperimentAnalysisError &&
      error.code === "post-hoc-primary-metric"
  );
});

test("analysis plan rejects opt-outs for peeking and multiplicity guardrails", () => {
  assert.throws(
    () =>
      analyzeExperiment(
        experimentDefinition({
          analysisPlan: {
            multipleComparisons: "none",
            peekingProtection: "locked-schedule",
            lookSchedule: [{ seq: 22 }]
          }
        }),
        { exposures: [], metrics: [], seq: 22 }
      ),
    /analysisPlan.multipleComparisons must use bonferroni/
  );

  assert.throws(
    () =>
      analyzeExperiment(
        experimentDefinition({
          analysisPlan: {
            peekingProtection: "none",
            lookSchedule: [{ seq: 23 }]
          }
        }),
        { exposures: [], metrics: [], seq: 23 }
      ),
    /analysisPlan.peekingProtection must use locked-schedule/
  );
});

test("post-hoc segment cherry-pick is rejected instead of treated as a free win", () => {
  const rows = flatten([
    cohort("control", Array(6).fill(0)),
    cohort("treatment", Array(6).fill(1))
  ]);

  assert.throws(
    () =>
      analyzeExperiment(
        experimentDefinition({
          analysisPlan: {
            preregisteredSegments: ["all-traffic"]
          }
        }),
        {
          exposures: rows.map((row) => row.exposure),
          metrics: rows.map((row) => row.metric),
          selectedSegmentKey: "mobile-big-spenders",
          seq: 18
        }
      ),
    (error) =>
      error instanceof ExperimentAnalysisError &&
      error.code === "post-hoc-segment"
  );
});

test("pre-registered segment families are corrected as multiplicity", () => {
  const rows = flatten([
    cohort("control", Array(10).fill(0)),
    cohort("treatment", [1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
  ]);

  const analysis = analyzeExperiment(
    plannedExperimentDefinition(19, {
      metrics: [
        {
          name: "checkout.completed",
          role: "primary",
          direction: "increase",
          minDetectableEffect: 0.2,
          bounds: [0, 1]
        }
      ],
      analysisPlan: {
        multipleComparisons: "bonferroni",
        preregisteredSegments: [
          "all-traffic",
          "mobile",
          "desktop",
          "new-user",
          "returning-user",
          "high-intent"
        ]
      }
    }),
    {
      exposures: rows.map((row) => row.exposure),
      metrics: rows.map((row) => row.metric),
      selectedSegmentKey: "mobile",
      seq: 19
    }
  );

  assert.equal(analysis.outcome, "no-difference");
  assert.equal(analysis.primary.multiplicity.familySize, 6);
  assert.equal(analysis.primary.multiplicity.segments, 6);
});
