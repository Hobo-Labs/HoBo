import assert from "node:assert/strict";
import { test } from "vitest";

import {
  normalizeCampPolicy,
  surfacePlanBudget,
} from "../src/inline-budget-authoring.ts";

const SAMPLE_POLICY = {
  budget: { softLimitUsd: 4000, hardLimitUsd: 5000, period: "monthly" },
  costAvailabilityProfile: {
    budgetUsd: 5000,
    availabilitySlo: 0.999,
    strategy: "shed-low-priority-first",
    tiers: [
      { name: "nominal", upToBudgetFrac: 0.8, slo: 0.999 },
      { name: "reduced", upToBudgetFrac: 0.95, slo: 0.99, shed: ["batch", "analytics"] },
      { name: "minimal", upToBudgetFrac: 1.0, slo: 0.95, shed: ["non-critical"] },
    ],
  },
};

test("normalizeCampPolicy accepts inline budget and costAvailabilityProfile declarations", () => {
  const normalized = normalizeCampPolicy(SAMPLE_POLICY);

  assert.equal(normalized.budget.softLimitUsd, 4000);
  assert.equal(normalized.budget.hardLimitUsd, 5000);
  assert.equal(normalized.costAvailabilityProfile.budgetUsd, 5000);
  assert.equal(normalized.costAvailabilityProfile.tiers[1].thresholdUsd, 4750);
  assert.deepEqual(normalized.costAvailabilityProfile.tiers[1].shed, ["batch", "analytics"]);
});

test("surfacePlanBudget renders Cost & budget headroom for hobo plan human output", () => {
  const surfaced = surfacePlanBudget({
    campName: "prod",
    projectedMonthlyUsd: 63.5,
    policy: SAMPLE_POLICY,
    metering: {
      evaluationAt: "2026-06-26T12:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      currentSpendUsd: 3900,
      spendVelocityUsdPerHour: 8,
    },
  });

  assert.match(surfaced.humanBlock, /Cost & budget \(camp prod, monthly\)/);
  assert.match(surfaced.humanBlock, /projected:\s+\$63\.50\/mo/);
  assert.match(surfaced.humanBlock, /\$5,000 hard \/ \$4,000 soft/);
  assert.match(surfaced.humanBlock, /headroom \$4936\.50/);
  assert.equal(surfaced.budget.headroomUsd, 4936.5);
  assert.equal(surfaced.warnings.some((warning) => warning.code === "cost-availability-tier-preview"), true);
  assert.match(surfaced.humanBlock, /would enter reduced tier/);
});

test("surfacePlanBudget annotates hard budget breach as would-deny without blocking read-only plan", () => {
  const surfaced = surfacePlanBudget({
    campName: "prod",
    projectedMonthlyUsd: 5200,
    policy: SAMPLE_POLICY,
  });

  assert.equal(surfaced.budget.gateAnnotations.length, 1);
  assert.equal(surfaced.budget.gateAnnotations[0].effect, "deny");
  assert.equal(surfaced.warnings.some((warning) => warning.code === "budget-soft-threshold"), true);
});

test("costAvailabilityProfile without hard budget fails closed at normalize", () => {
  assert.throws(
    () =>
      normalizeCampPolicy({
        costAvailabilityProfile: {
          availabilitySlo: 0.999,
          tiers: [{ name: "nominal", upToBudgetFrac: 0.8 }],
        },
      }),
    /budgetUsd is required/,
  );
});
