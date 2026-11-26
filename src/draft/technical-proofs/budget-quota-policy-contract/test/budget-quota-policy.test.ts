import assert from "node:assert/strict";
import { test } from "vitest";

import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { snapshotMeteringView } from "../../metering-view-projection-contract/src/metering-view.js";

import {
  BUDGET_QUOTA_POLICY_ENGINE_ID,
  evaluateBudgetQuotaPolicy,
} from "../src/budget-quota-policy.js";

const COST_CATALOG = {
  currency: "USD",
  unitPrices: {
    "generation-runs": 1,
    "runtime-compute-seconds": 0.01,
  },
};

function usage(seq, overrides = {}) {
  return {
    id: overrides.id ?? `usage-${seq}`,
    type: "meter.UsageRecorded",
    seq,
    dimension: overrides.dimension ?? "generation-runs",
    quantity: overrides.quantity ?? 1,
    occurredAt: overrides.occurredAt ?? "2026-06-25T12:00:00.000Z",
    idempotencyKey: overrides.idempotencyKey ?? `usage-${seq}`,
    owner: {
      tenantId: "tenant-a",
      campId: "camp-prod",
      bindleId: "checkout",
      runId: "run-1",
      agentId: "agent-deploy",
      teamId: "team-platform",
      ...overrides.owner,
    },
  };
}

function meteringView({ seq = 10, totalCost = 0, scopeCosts = {} } = {}) {
  const view = snapshotMeteringView(totalCost > 0 ? [usage(1, { quantity: totalCost })] : [], {
    seq,
    costCatalog: COST_CATALOG,
  });
  return {
    ...view,
    scopeCosts: Object.fromEntries(
      Object.entries(scopeCosts).map(([key, cost]) => [
        key,
        {
          cost,
          currency: "USD",
        },
      ]),
    ),
  };
}

function decisionRequest(overrides = {}) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:tenant-a/agent-deploy",
      delegatedBy: "user:platform-admin",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
    },
    action: "hobo:deployment:apply",
    resource: {
      kind: "deployment",
      id: "deployment:checkout-prod",
    },
    phase: "plan",
    context: {
      owner: {
        tenantId: "tenant-a",
        campId: "camp-prod",
        agentId: "agent-deploy",
      },
      actorId: "user:platform-admin",
      costEstimateUsd: 0,
      ...overrides.context,
    },
    ...overrides,
  };
}

function quotaReservation(overrides = {}) {
  return {
    counterId: "counter:tenant-a/camp-prod/monthly",
    scope: { kind: "camp", id: "tenant-a/camp-prod" },
    granted: true,
    reservedCostUsd: 3.5,
    inFlightActionId: "action:deploy-checkout-prod",
    ...overrides,
  };
}

test("soft threshold emits a warn obligation without blocking the gate", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 8 } }),
    meteringView: meteringView({
      scopeCosts: {
        "tenant:tenant-a": 86,
      },
    }),
    policies: [
      {
        id: "budget:tenant-a/monthly",
        scope: { kind: "tenant", id: "tenant-a" },
        softLimitUsd: 90,
        hardLimitUsd: 100,
        lastEvaluatedSeq: 9,
      },
    ],
  });

  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.evidence.engine, BUDGET_QUOTA_POLICY_ENGINE_ID);
  assert.deepEqual(
    result.decision.obligations.map((obligation) => obligation.kind),
    ["spend.warn-threshold"],
  );
  assert.equal(result.events.find((event) => event.type === "policy.Decided")?.data.effect, "allow");
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "spend.BudgetThresholdCrossed")
      .map((event) => ({
        severity: event.severity,
        blocked: event.blocked,
        projectedSpendUsd: event.projectedSpendUsd,
      })),
    [{ severity: "soft", blocked: false, projectedSpendUsd: 94 }],
  );
});

test("hard threshold denies spend-incurring deployment and agent-provision gates", () => {
  const deploy = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 7 } }),
    meteringView: meteringView({
      scopeCosts: {
        "camp:tenant-a/camp-prod": 96,
      },
    }),
    policies: [
      {
        id: "budget:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        softLimitUsd: 90,
        hardLimitUsd: 100,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  const provision = evaluateBudgetQuotaPolicy({
    request: decisionRequest({
      action: "hobo:agent:provision",
      resource: { kind: "agent", id: "agent:tenant-a/agent-reviewer" },
      context: { costEstimateUsd: 11 },
    }),
    meteringView: meteringView({
      scopeCosts: {
        "tenant:tenant-a": 92,
      },
    }),
    policies: [
      {
        id: "budget:tenant-a/monthly",
        scope: { kind: "tenant", id: "tenant-a" },
        hardLimitUsd: 100,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(deploy.decision.effect, "deny");
  assert.match(deploy.decision.reason, /hard budget/);
  assert.equal(provision.decision.effect, "deny");
  assert.match(provision.decision.violations.join("\n"), /budget:tenant-a\/monthly/);
});

test("agent spendCapUsd routes through approve or deny gate instead of silent spend", () => {
  const base = {
    request: decisionRequest({ context: { costEstimateUsd: 5 } }),
    meteringView: meteringView({
      scopeCosts: {
        "agent:tenant-a/agent-deploy": 28,
      },
    }),
    policies: [
      {
        id: "cap:agent-deploy/daily",
        scope: { kind: "agent", id: "tenant-a/agent-deploy" },
        spendCapUsd: 30,
        allowedApprovers: ["user:finance-admin"],
        lastEvaluatedSeq: 10,
      },
    ],
  };

  const unapproved = evaluateBudgetQuotaPolicy(base);
  const approved = evaluateBudgetQuotaPolicy({
    ...base,
    approval: {
      decision: "approved",
      approverId: "user:finance-admin",
      approvedAt: "2026-06-25T13:00:00.000Z",
    },
  });
  const denied = evaluateBudgetQuotaPolicy({
    ...base,
    approval: {
      decision: "denied",
      approverId: "user:finance-admin",
      approvedAt: "2026-06-25T13:05:00.000Z",
    },
  });

  assert.equal(unapproved.decision.effect, "require-approval");
  assert.equal(unapproved.decision.obligations[0].kind, "spend.agent-cap-approval");

  assert.equal(approved.decision.effect, "allow");
  assert.equal(approved.decision.approvals[0].approverId, "user:finance-admin");
  assert.equal(approved.events.find((event) => event.type === "policy.Decided").audit.approverId, "user:finance-admin");
  assert.notEqual(
    approved.events.find((event) => event.type === "policy.Decided").id,
    denied.events.find((event) => event.type === "policy.Decided").id,
  );

  assert.equal(denied.decision.effect, "deny");
  assert.match(denied.decision.reason, /approval denied/);
});

test("malformed approver configuration fails closed before evaluating spend", () => {
  assert.throws(
    () =>
      evaluateBudgetQuotaPolicy({
        request: decisionRequest({ context: { costEstimateUsd: 5 } }),
        meteringView: meteringView({
          scopeCosts: {
            "agent:tenant-a/agent-deploy": 28,
          },
        }),
        policies: [
          {
            id: "cap:agent-deploy/daily",
            scope: { kind: "agent", id: "tenant-a/agent-deploy" },
            spendCapUsd: 30,
            allowedApprovers: "user:finance-admin",
            lastEvaluatedSeq: 10,
          },
        ],
      }),
    /allowedApprovers must be an array/,
  );
});

test("every decision is an auditable policy.Decided event tying spend to actor and approver", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 5 } }),
    meteringView: meteringView({
      scopeCosts: {
        "agent:tenant-a/agent-deploy": 28,
      },
    }),
    approval: {
      decision: "approved",
      approverId: "user:finance-admin",
      approvedAt: "2026-06-25T13:00:00.000Z",
    },
    policies: [
      {
        id: "cap:agent-deploy/daily",
        scope: { kind: "agent", id: "tenant-a/agent-deploy" },
        spendCapUsd: 30,
        allowedApprovers: ["user:finance-admin"],
        lastEvaluatedSeq: 10,
      },
    ],
  });

  const event = result.events.find((candidate) => candidate.type === "policy.Decided");
  assert.equal(event.audit.actorId, "user:platform-admin");
  assert.equal(event.audit.approverId, "user:finance-admin");
  assert.equal(event.audit.meteringViewSeq, 10);
  assert.equal(event.audit.estimatedCostUsd, 5);
  assert.deepEqual(event.audit.policyIds, ["cap:agent-deploy/daily"]);
});

test("estimate under budget but actual over budget emits reconciliation obligation", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({
      context: {
        costEstimateUsd: 4,
        actualCostUsd: 18,
      },
    }),
    meteringView: meteringView({
      scopeCosts: {
        "tenant:tenant-a": 88,
      },
    }),
    policies: [
      {
        id: "budget:tenant-a/monthly",
        scope: { kind: "tenant", id: "tenant-a" },
        hardLimitUsd: 100,
        driftToleranceUsd: 2,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "require-approval");
  assert.deepEqual(
    result.decision.obligations.map((obligation) => obligation.kind),
    ["spend.reconcile-estimate-drift"],
  );
  assert.equal(result.events.find((event) => event.type === "spend.EstimateDriftObserved").actualProjectedSpendUsd, 106);
});

test("hard deny after partial provisioning carries a compensation obligation", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({
      phase: "apply",
      context: {
        costEstimateUsd: 5,
        partialProvisioning: {
          sagaId: "saga:deploy-checkout-prod",
          provisionedResourceIds: ["resource:db", "resource:queue"],
        },
      },
    }),
    meteringView: meteringView({
      scopeCosts: {
        "camp:tenant-a/camp-prod": 99,
      },
    }),
    policies: [
      {
        id: "budget:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        hardLimitUsd: 100,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.deepEqual(
    result.decision.obligations.filter((obligation) => obligation.kind === "deployment.compensate"),
    [
      {
        kind: "deployment.compensate",
        reason: "hard budget deny after partial provisioning",
        sagaId: "saga:deploy-checkout-prod",
        provisionedResourceIds: ["resource:db", "resource:queue"],
      },
    ],
  );
});

test("agent cannot evade cap by splitting spend across sub-budgets", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({
      context: {
        costEstimateUsd: 10,
        owner: {
          tenantId: "tenant-a",
          campId: "camp-prod",
          agentId: "agent-a",
        },
      },
    }),
    meteringView: meteringView({
      scopeCosts: {
        "agent:tenant-a/agent-a": 20,
        "agent:tenant-a/agent-b": 25,
        "tenant:tenant-a": 45,
      },
    }),
    policies: [
      {
        id: "cap:agent-a/daily",
        scope: { kind: "agent", id: "tenant-a/agent-a" },
        spendCapUsd: 35,
        lastEvaluatedSeq: 10,
      },
      {
        id: "budget:tenant-a/monthly",
        scope: { kind: "tenant", id: "tenant-a" },
        hardLimitUsd: 50,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /budget:tenant-a\/monthly/);
});

test("out-of-order counter update fails closed instead of regressing a crossed threshold", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 1 } }),
    meteringView: meteringView({
      seq: 8,
      scopeCosts: {
        "tenant:tenant-a": 80,
      },
    }),
    policies: [
      {
        id: "budget:tenant-a/monthly",
        scope: { kind: "tenant", id: "tenant-a" },
        softLimitUsd: 90,
        hardLimitUsd: 100,
        lastEvaluatedSeq: 9,
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /out-of-order/);
  assert.equal(result.events.find((event) => event.type === "spend.CounterOutOfOrder").scopeId, "tenant-a");
});

test("pre-commit reservation bounds hot-loop overshoot to one in-flight action", () => {
  const policy = {
    id: "budget:camp-prod/monthly",
    scope: { kind: "camp", id: "tenant-a/camp-prod" },
    softLimitUsd: 90,
    hardLimitUsd: 100,
    reservationRequired: true,
    lastEvaluatedSeq: 10,
  };
  const request = decisionRequest({ context: { costEstimateUsd: 3.5 } });
  const view = meteringView({
    scopeCosts: {
      "camp:tenant-a/camp-prod": 96,
    },
  });

  const firstInFlight = evaluateBudgetQuotaPolicy({
    request,
    meteringView: view,
    reservation: quotaReservation(),
    policies: [policy],
  });
  const racedHotLoop = evaluateBudgetQuotaPolicy({
    request,
    meteringView: view,
    reservation: quotaReservation({
      granted: false,
      reason: "quota counter already reserved for in-flight action",
    }),
    policies: [policy],
  });

  assert.equal(firstInFlight.decision.effect, "allow");
  assert.equal(
    firstInFlight.events.find((event) => event.type === "spend.QuotaReservationCommitted")
      .maxOvershootUsd,
    3.5,
  );
  assert.equal(firstInFlight.events.find((event) => event.type === "policy.Decided").data.effect, "allow");

  assert.equal(racedHotLoop.decision.effect, "deny");
  assert.match(racedHotLoop.decision.reason, /pre-commit quota reservation/);
  assert.equal(
    racedHotLoop.events.find((event) => event.type === "spend.QuotaReservationDenied").reason,
    "quota counter already reserved for in-flight action",
  );
  assert.equal(racedHotLoop.events.find((event) => event.type === "policy.Decided").data.effect, "deny");
});

test("spend-incurring action with no quota context fails closed", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 2 } }),
    meteringView: meteringView(),
    policies: [],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /missing quota policy context/);
  assert.equal(result.events.find((event) => event.type === "spend.QuotaContextMissing").estimatedCostUsd, 2);
  assert.equal(result.events.find((event) => event.type === "policy.Decided").data.effect, "deny");
});

test("quota policy with no matching MeteringView counter fails closed", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 2 } }),
    meteringView: meteringView({
      scopeCosts: {
        "camp:tenant-a/other-camp": 12,
      },
    }),
    policies: [
      {
        id: "budget:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        hardLimitUsd: 100,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /missing MeteringView quota counter/);
  assert.equal(
    result.events.find((event) => event.type === "spend.QuotaContextMissing").scopeId,
    "tenant-a/camp-prod",
  );
  assert.equal(result.events.find((event) => event.type === "policy.Decided").data.effect, "deny");
});

test("missing required reservation denies instead of treating hard quota as unlimited", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 1 } }),
    meteringView: meteringView({
      scopeCosts: {
        "camp:tenant-a/camp-prod": 25,
      },
    }),
    policies: [
      {
        id: "budget:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        hardLimitUsd: 100,
        reservationRequired: true,
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /missing pre-commit quota reservation/);
  assert.equal(result.events.find((event) => event.type === "spend.QuotaReservationDenied").blocked, undefined);
  assert.equal(result.events.find((event) => event.type === "policy.Decided").data.effect, "deny");
});

test("spend velocity crossing cost availability tier yields durable allow-degraded obligation", () => {
  const result = evaluateBudgetQuotaPolicy({
    request: decisionRequest({ context: { costEstimateUsd: 1 } }),
    meteringView: meteringView({
      scopeCosts: {
        "camp:tenant-a/camp-prod": 70,
      },
    }),
    policies: [
      {
        id: "cost-availability:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        hardLimitUsd: 100,
        costAvailabilityProfile: {
          id: "cost-availability-profile:camp-prod",
          evaluationAt: "2026-06-26T12:00:00.000Z",
          periodEnd: "2026-06-27T00:00:00.000Z",
          spendVelocityUsdPerHour: 1,
          tiers: [
            {
              name: "observe",
              thresholdFraction: 0.5,
              strategy: "watch-cost-velocity",
              shed: ["cosmetic-telemetry"],
            },
            {
              name: "reduced",
              thresholdFraction: 0.8,
              strategy: "shed-low-priority-work",
              shed: ["background-analysis", "noncritical-retries"],
            },
          ],
        },
        lastEvaluatedSeq: 10,
      },
    ],
  });

  assert.equal(result.decision.effect, "allow-degraded");
  assert.equal(result.decision.reason, "spend velocity requires degraded execution");
  assert.deepEqual(result.decision.obligations, [
    {
      kind: "spend.degradation-required",
      policyId: "cost-availability:camp-prod/monthly",
      scope: { kind: "camp", id: "tenant-a/camp-prod" },
      profileId: "cost-availability-profile:camp-prod",
      tier: "reduced",
      durable: true,
      strategy: "shed-low-priority-work",
      shed: ["background-analysis", "noncritical-retries"],
      currentSpendUsd: 70,
      projectedSpendUsd: 71,
      projectedPeriodSpendUsd: 83,
      thresholdUsd: 80,
    },
  ]);
  assert.equal(result.events.find((event) => event.type === "spend.DegradationRequired").durable, true);
  assert.equal(
    result.events.find((event) => event.type === "policy.Decided").data.effect,
    "allow-degraded",
  );
});

test("cost availability profile without hard limit or budget fails closed", () => {
  assert.throws(
    () =>
      evaluateBudgetQuotaPolicy({
        request: decisionRequest({ context: { costEstimateUsd: 1 } }),
        meteringView: meteringView(),
        policies: [
          {
            id: "cost-availability:camp-prod/monthly",
            scope: { kind: "camp", id: "tenant-a/camp-prod" },
            costAvailabilityProfile: {
              id: "cost-availability-profile:camp-prod",
              evaluationAt: "2026-06-26T12:00:00.000Z",
              periodEnd: "2026-06-27T00:00:00.000Z",
              spendVelocityUsdPerHour: 1,
              tiers: [
                {
                  name: "reduced",
                  thresholdFraction: 0.8,
                  strategy: "shed-low-priority-work",
                  shed: [],
                },
              ],
            },
          },
        ],
      }),
    /budgetUsd is required/,
  );
});
