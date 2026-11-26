import { isJsonString, isJsonObject } from "./json.js";
export const INLINE_BUDGET_SCHEMA = "hobo.inline-budget/v1";

const BUDGET_PERIODS = new Set(["monthly", "weekly", "daily"]);

function roundUsd(value) {
  return Number(Number(value).toFixed(2));
}

function requireObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function optionalNumber(value, path) {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new RangeError(`${path} must be a non-negative number`);
  }
  return roundUsd(numeric);
}

function requireString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function parseBudget(input, path) {
  if (input === undefined || input === null) {
    return null;
  }
  const budget = requireObject(input, path);
  const softLimitUsd = optionalNumber(budget.softLimitUsd, `${path}.softLimitUsd`);
  const hardLimitUsd = optionalNumber(budget.hardLimitUsd, `${path}.hardLimitUsd`);
  const period = budget.period === undefined ? "monthly" : requireString(budget.period, `${path}.period`);
  if (!BUDGET_PERIODS.has(period)) {
    throw new TypeError(`${path}.period must be one of ${[...BUDGET_PERIODS].join(", ")}`);
  }
  if (softLimitUsd === null && hardLimitUsd === null) {
    throw new TypeError(`${path} must define softLimitUsd and/or hardLimitUsd`);
  }
  if (softLimitUsd !== null && hardLimitUsd !== null && softLimitUsd >= hardLimitUsd) {
    throw new RangeError(`${path}.softLimitUsd must be less than hardLimitUsd`);
  }
  return { softLimitUsd, hardLimitUsd, period };
}

function parseTier(input, path, budgetUsd) {
  const tier = requireObject(input, path);
  const upToBudgetFrac = optionalNumber(tier.upToBudgetFrac, `${path}.upToBudgetFrac`);
  const thresholdUsd =
    optionalNumber(tier.thresholdUsd, `${path}.thresholdUsd`) ??
    (upToBudgetFrac === null ? null : roundUsd(budgetUsd * upToBudgetFrac));
  if (thresholdUsd === null) {
    throw new TypeError(`${path} must define thresholdUsd or upToBudgetFrac`);
  }
  return {
    name: requireString(tier.name, `${path}.name`),
    thresholdUsd,
    upToBudgetFrac,
    slo: optionalNumber(tier.slo, `${path}.slo`),
    shed: Array.isArray(tier.shed) ? tier.shed.map((entry, index) => requireString(entry, `${path}.shed[${index}]`)) : [],
  };
}

function parseCostAvailabilityProfile(input, path, fallbackBudgetUsd) {
  if (input === undefined || input === null) {
    return null;
  }
  const profile = requireObject(input, path);
  const budgetUsd = optionalNumber(profile.budgetUsd, `${path}.budgetUsd`) ?? fallbackBudgetUsd;
  if (budgetUsd === null) {
    throw new TypeError(`${path}.budgetUsd is required when budget.hardLimitUsd is absent`);
  }
  if (!Array.isArray(profile.tiers) || profile.tiers.length === 0) {
    throw new TypeError(`${path}.tiers must be a non-empty array`);
  }
  return {
    budgetUsd,
    availabilitySlo: optionalNumber(profile.availabilitySlo, `${path}.availabilitySlo`),
    strategy: profile.strategy === undefined ? "shed-low-priority-first" : requireString(profile.strategy, `${path}.strategy`),
    tiers: profile.tiers.map((tier, index) => parseTier(tier, `${path}.tiers[${index}]`, budgetUsd)),
  };
}

export function normalizeCampPolicy(input) {
  const policy = requireObject(input, "policy");
  const budget = parseBudget(policy.budget, "policy.budget");
  const costAvailabilityProfile = parseCostAvailabilityProfile(
    policy.costAvailabilityProfile,
    "policy.costAvailabilityProfile",
    budget?.hardLimitUsd ?? null,
  );
  return {
    schema: INLINE_BUDGET_SCHEMA,
    budget,
    costAvailabilityProfile,
  };
}

function hoursBetween(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new RangeError("metering.evaluationAt must precede metering.periodEnd");
  }
  return (end - start) / 3_600_000;
}

function resolveActiveTier(profile, projectedPeriodSpendUsd) {
  return profile.tiers.reduce((selected, tier) => {
    if (projectedPeriodSpendUsd <= tier.thresholdUsd) {
      return selected;
    }
    if (!selected || tier.thresholdUsd >= selected.thresholdUsd) {
      return tier;
    }
    return selected;
  }, null);
}

export function surfacePlanBudget({ campName, period = "monthly", projectedMonthlyUsd, policy, metering = null }) {
  const normalized = normalizeCampPolicy(policy);
  const projected = roundUsd(projectedMonthlyUsd);
  const hardLimitUsd = normalized.budget?.hardLimitUsd ?? normalized.costAvailabilityProfile?.budgetUsd ?? null;
  const softLimitUsd = normalized.budget?.softLimitUsd ?? null;
  const headroomUsd = hardLimitUsd === null ? null : roundUsd(Math.max(0, hardLimitUsd - projected));
  const warnings = [];
  const gateAnnotations = [];

  if (softLimitUsd !== null && projected > softLimitUsd) {
    warnings.push({
      code: "budget-soft-threshold",
      message: `projected ${projected}/mo exceeds soft budget ${softLimitUsd}`,
    });
  }
  if (hardLimitUsd !== null && projected > hardLimitUsd) {
    gateAnnotations.push({
      code: "budget-hard-would-deny",
      message: `projected ${projected}/mo would exceed hard budget ${hardLimitUsd}`,
      effect: "deny",
    });
  }

  let tierPreview = null;
  if (normalized.costAvailabilityProfile && metering) {
    const hoursRemaining = hoursBetween(metering.evaluationAt, metering.periodEnd);
    const projectedPeriodSpendUsd = roundUsd(
      metering.currentSpendUsd + projected + metering.spendVelocityUsdPerHour * hoursRemaining,
    );
    const activeTier = resolveActiveTier(normalized.costAvailabilityProfile, projectedPeriodSpendUsd);
    if (activeTier) {
      tierPreview = {
        tier: activeTier.name,
        thresholdUsd: activeTier.thresholdUsd,
        projectedPeriodSpendUsd,
        shed: activeTier.shed,
        velocityOk: false,
      };
      warnings.push({
        code: "cost-availability-tier-preview",
        message: `spend velocity would enter ${activeTier.name} tier before period end`,
      });
    } else {
      const nominalTier = normalized.costAvailabilityProfile.tiers[0];
      tierPreview = {
        tier: nominalTier.name,
        thresholdUsd: nominalTier.thresholdUsd,
        projectedPeriodSpendUsd,
        shed: [],
        velocityOk: true,
      };
    }
  }

  const humanLines = [
    `Cost & budget (camp ${campName}, ${period})`,
    `  projected:  $${projected.toFixed(2)}/mo`,
  ];
  if (hardLimitUsd !== null || softLimitUsd !== null) {
    const budgetParts = [];
    if (hardLimitUsd !== null) {
      budgetParts.push(`$${hardLimitUsd.toLocaleString("en-US")} hard`);
    }
    if (softLimitUsd !== null) {
      budgetParts.push(`$${softLimitUsd.toLocaleString("en-US")} soft`);
    }
    const headroomText = headroomUsd === null ? "n/a" : `$${headroomUsd.toFixed(2)}`;
    humanLines.push(`  budget:     ${budgetParts.join(" / ")}  →  headroom ${headroomText}`);
  }
  if (tierPreview) {
    const velocityText = tierPreview.velocityOk ? "velocity OK for period" : `would enter ${tierPreview.tier} tier`;
    humanLines.push(
      `  profile:    ${tierPreview.tier} tier (${tierPreview.thresholdUsd} cap)      →  ${velocityText}`,
    );
  }

  return {
    schema: INLINE_BUDGET_SCHEMA,
    camp: campName,
    period,
    projectedMonthlyUsd: projected,
    budget: {
      softLimitUsd,
      hardLimitUsd,
      headroomUsd,
      tierPreview,
      gateAnnotations,
    },
    warnings,
    humanBlock: `${humanLines.join("\n")}\n`,
  };
}
