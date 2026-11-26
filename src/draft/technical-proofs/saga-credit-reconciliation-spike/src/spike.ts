export function buildCompensationPlan({ resources, provisioned, failure }) {
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const provisionedSet = new Set(provisioned);

  if (!failure.crossesNoGoThreshold) {
    return {
      terminal: "partial-success",
      actions: [],
      constraints: [],
    };
  }

  for (const id of provisionedSet) {
    if (!resourceIds.has(id)) {
      throw new Error(`Unknown provisioned resource: ${id}`);
    }
  }

  const actions = topologicalSort(resources)
    .filter((resourceId) => provisionedSet.has(resourceId))
    .reverse()
    .map((resourceId) => ({
      type: "provider.destroy",
      resourceId,
      idempotencyKey: `destroy:${resourceId}`,
    }));

  return {
    terminal: "rollback-required",
    actions,
    constraints: [
      "destroy-only-provisioned-resources",
      "reverse-topological-order",
      "idempotent-destroy-required",
    ],
  };
}

export function analyzeCompensationInterleaving({ events }) {
  const providerCreates = events.filter((event) => event.type === "provider.created");
  const stateRecords = new Set(
    events
      .filter((event) => event.type === "state.recorded")
      .map((event) => event.resourceId),
  );

  const unrecordedCreate = providerCreates.find((event) => !stateRecords.has(event.resourceId));
  if (unrecordedCreate && !unrecordedCreate.tagged) {
    return {
      terminal: "blocked",
      failingExample: "provider-created-before-state-recorded",
      requiredConstraints: [
        "provider-object-tags-required",
        "orphan-sweep-before-terminal-rollback-success",
        "rollback-must-escalate-needs-human-when-orphan-identity-is-unknown",
      ],
    };
  }

  const failedCompensation = events.find((event) => event.type === "compensation.failed");
  if (failedCompensation) {
    return {
      terminal: "needs-human",
      failingExample: "compensation-destroy-failed",
      requiredConstraints: ["failed-compensation-must-not-report-rollback-success"],
    };
  }

  return {
    terminal: "consistent",
    failingExample: null,
    requiredConstraints: [],
  };
}

export function measureAccuracyBound(samples) {
  const measured = samples.filter((sample) => Number.isFinite(sample.actual));
  const errors = measured.map((sample) =>
    roundTo2((Math.abs(sample.actual - sample.estimated) / sample.estimated) * 100),
  );
  const total = errors.reduce((sum, value) => sum + value, 0);

  return {
    sampleCount: measured.length,
    estimateOnlyCount: samples.length - measured.length,
    maxAbsolutePercentError: errors.length === 0 ? null : Math.max(...errors),
    meanAbsolutePercentError: errors.length === 0 ? null : roundTo2(total / errors.length),
  };
}

export function reconcileBillingPeriod({
  provider,
  period,
  ledgerSeq,
  tolerancePercent,
  lines,
  priorDeltas = new Set(),
}) {
  if (lines.some((line) => !Number.isFinite(line.actual))) {
    return {
      provider,
      period,
      ledgerSeq,
      mode: "estimate-only",
      category: "actual-unavailable",
      totalEstimated: sum(lines.map((line) => line.estimated)),
      totalActual: null,
      percentError: null,
      deltaEvents: [],
      skippedDeltas: [],
      risks: ["provider-billing-api-unavailable", "dispatcher-must-treat-cost-as-uncertain"],
    };
  }

  const totalEstimated = sum(lines.map((line) => line.estimated));
  const totalActual = sum(lines.map((line) => line.actual));
  const percentError = roundTo2((Math.abs(totalActual - totalEstimated) / totalEstimated) * 100);
  const skippedDeltas = [];
  const deltaEvents = [];

  for (const line of lines) {
    const idempotencyKey = `spend-delta:${provider}:${period}:${line.meter}`;
    if (priorDeltas.has(idempotencyKey)) {
      skippedDeltas.push(idempotencyKey);
      continue;
    }

    deltaEvents.push({
      type: "spend.ReconciliationDeltaRecorded",
      idempotencyKey,
      provider,
      period,
      meter: line.meter,
      ledgerSeq,
      estimatedAmount: line.estimated,
      actualAmount: line.actual,
      deltaAmount: roundTo2(line.actual - line.estimated),
    });
  }

  const outsideBound = percentError > tolerancePercent;

  return {
    provider,
    period,
    ledgerSeq,
    mode: "actual-reconciled",
    category: outsideBound ? "pricing-or-usage-drift" : "within-bound",
    totalEstimated,
    totalActual,
    percentError,
    deltaEvents,
    skippedDeltas,
    risks: outsideBound
      ? [
          "actual-cost-outside-estimate-bound",
          "dispatcher-should-lower-confidence-for-this-provider-meter",
        ]
      : [],
  };
}

function topologicalSort(resources) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const permanent = new Set();
  const temporary = new Set();
  const sorted = [];

  for (const resource of resources) {
    visit(resource.id);
  }

  return sorted;

  function visit(id) {
    if (permanent.has(id)) {
      return;
    }

    if (temporary.has(id)) {
      throw new Error(`Resource dependency cycle includes: ${id}`);
    }

    const resource = byId.get(id);
    if (!resource) {
      throw new Error(`Unknown resource dependency: ${id}`);
    }

    temporary.add(id);
    for (const dependency of resource.dependsOn ?? []) {
      visit(dependency);
    }
    temporary.delete(id);
    permanent.add(id);
    sorted.push(id);
  }
}

function sum(values) {
  return roundTo2(values.reduce((total, value) => total + value, 0));
}

function roundTo2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
