import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const COST_DEGRADATION_SAGA_ENGINE_ID =
  "hobo.cost-degradation-saga/contract@0.1.0";
export const COST_DEGRADATION_SAGA_SCHEMA_VERSION =
  "hobo.cost-degradation-saga/v1";

const PRIORITY_RANK = new Map([
  ["low", 0],
  ["standard", 1],
  ["critical", 2],
]);

const VALID_TIER_STRATEGIES = new Set([
  "observe",
  "shed-low-priority-first",
  "degrade-all",
  "fail-closed",
]);

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export function evaluateCostDegradationSaga(input) {
  const source = expectObject(input, "input");
  const requirement = normalizeRequirement(source.requirement);
  const profile = normalizeProfile(source.profile);
  assertRequirementMatchesProfile(requirement, profile);
  const resources = normalizeResources(source.resources ?? []);
  const runtime = normalizeRuntime(source.runtime ?? {});
  const priorEvents = normalizePriorEvents(source.priorEvents ?? []);
  const now = normalizeInstant(source.now ?? new Date().toISOString(), "input.now");
  const tier = findTier(profile, requirement.tier);
  const activeTier = findActiveTier(priorEvents, profile, requirement);

  if (activeTier && requirement.projectedPeriodSpendUsd <= tierThresholdUsd(tier, profile)) {
    return evaluateRecovery({ activeTier, profile, requirement, runtime, now });
  }

  if (runtime.projectedAvailabilityAfterActions < tier.availabilitySlo) {
    return failClosed({
      requirement,
      profile,
      tier,
      now,
      reason: `degradation would violate availabilitySlo ${tier.availabilitySlo}`,
      breakerExhausted: true,
    });
  }

  const plan = planDegradationSteps({
    requirement,
    profile,
    tier,
    resources,
    runtime,
  });

  if (plan.blockingReason) {
    return failClosed({
      requirement,
      profile,
      tier,
      now,
      reason: plan.blockingReason,
      eventReason: plan.eventReason,
      breakerExhausted: true,
    });
  }

  if (plan.steps.length === 0 && tier.strategy === "fail-closed") {
    return escalateToBreaker({
      requirement,
      profile,
      tier,
      now,
      reason: "no non-critical load can be shed",
    });
  }

  if (plan.steps.length === 0) {
    return failClosed({
      requirement,
      profile,
      tier,
      now,
      reason: "no safe degradation step matched the requested tier",
      breakerExhausted: true,
    });
  }

  const events = plan.steps.map((step) =>
    makeAppliedEvent({ requirement, profile, tier, step, now }),
  );

  return resultEnvelope({
    requirement,
    profile,
    tier,
    decision: {
      effect: "apply-degradation",
      reason: "safe degradation steps selected",
      tier: tier.name,
      availabilityFloorHeld: true,
      scope: profile.scope,
    },
    steps: plan.steps,
    events,
    breakerHandoff: {
      degradationExhausted: false,
      scope: profile.scope,
      activeTier: tier.name,
      evidenceEventIds: events.map((event) => event.id),
    },
  });
}

function evaluateRecovery({ activeTier, profile, requirement, runtime, now }) {
  if (!runtime.belowTierThresholdSince) {
    return resultEnvelope({
      requirement,
      profile,
      tier: activeTier,
      decision: {
        effect: "hold-degradation",
        reason: "recovery hysteresis has not started",
        tier: activeTier.name,
        scope: profile.scope,
      },
      steps: [],
      events: [],
      breakerHandoff: {
        degradationExhausted: false,
        scope: profile.scope,
        activeTier: activeTier.name,
      },
    });
  }

  const elapsedSeconds = Math.floor(
    (Date.parse(now) - Date.parse(runtime.belowTierThresholdSince)) / 1000,
  );
  if (elapsedSeconds < profile.recoveryHysteresisSeconds) {
    return resultEnvelope({
      requirement,
      profile,
      tier: activeTier,
      decision: {
        effect: "hold-degradation",
        reason: "recovery hysteresis has not elapsed",
        tier: activeTier.name,
        elapsedSeconds,
        requiredSeconds: profile.recoveryHysteresisSeconds,
        scope: profile.scope,
      },
      steps: [],
      events: [],
      breakerHandoff: {
        degradationExhausted: false,
        scope: profile.scope,
        activeTier: activeTier.name,
      },
    });
  }

  const rollback = makeRolledBackEvent({
    requirement,
    profile,
    fromTier: activeTier.name,
    toTier: "nominal",
    now,
    reason: "spend velocity recovered after hysteresis",
  });

  return resultEnvelope({
    requirement,
    profile,
    tier: activeTier,
    decision: {
      effect: "rollback-degradation",
      reason: "spend velocity recovered after hysteresis",
      tier: activeTier.name,
      scope: profile.scope,
    },
    steps: [],
    events: [rollback],
    breakerHandoff: {
      degradationExhausted: false,
      scope: profile.scope,
      activeTier: "nominal",
      evidenceEventIds: [rollback.id],
    },
  });
}

function planDegradationSteps({ requirement, profile: _profile, tier, resources, runtime }) {
  const steps = [];
  const unsafeReasons = [];

  for (const shed of requirement.shed.length > 0 ? requirement.shed : tier.shed) {
    const parsed = parseShedDirective(shed);

    if (parsed.lever === "request-priority") {
      if (runtime.retryAfterConsumerBudgetPerMinute <= 0) {
        return {
          steps,
          blockingReason: "Retry-After storm risk exceeds caller budget",
          eventReason: "retry-after storm would amplify load",
        };
      }
      const target = chooseResourceForLever(resources, "request-priority", {
        allowCritical: false,
      });
      if (!target) {
        unsafeReasons.push("no non-critical request-priority target");
        continue;
      }
      steps.push({
        lever: "request-priority",
        targetId: target.id,
        priority: target.priority,
        action: "shed-low-priority-calls",
        response: {
          status: 503,
          headers: {
            "Retry-After": String(tier.retryAfterSeconds),
          },
          silentHang: false,
          maxRejectedPerMinute: runtime.retryAfterConsumerBudgetPerMinute,
        },
      });
      continue;
    }

    if (parsed.lever === "feature-flag") {
      const target = chooseResourceForLever(resources, "feature-flag", {
        allowCritical: false,
      });
      if (!target) {
        unsafeReasons.push("no non-critical feature-flag target");
        continue;
      }
      steps.push({
        lever: "feature-flag",
        targetId: parsed.targetId,
        priority: target.priority,
        action: "disable-costly-path",
      });
      continue;
    }

    if (parsed.lever === "cache-ttl") {
      const target = selectCacheTtlTarget({
        resources,
        targetId: parsed.targetId === "cache-ttl" ? null : parsed.targetId,
        allowCritical: tier.strategy === "degrade-all",
      });
      if (!target.resource) {
        unsafeReasons.push(target.reason);
        continue;
      }
      steps.push({
        lever: "cache-ttl",
        targetId: target.resource.id,
        priority: target.resource.priority,
        action: "increase-cache-ttl",
        ttlSeconds: tier.cacheTtlSeconds,
      });
      continue;
    }

    if (parsed.lever === "canary-hold") {
      const target = chooseResourceForLever(resources, "canary-hold", {
        allowCritical: true,
      });
      if (!target) {
        unsafeReasons.push("no canary-hold target");
        continue;
      }
      steps.push({
        lever: "canary-hold",
        targetId: target.id,
        priority: target.priority,
        action: "hold-current-rollout-step",
      });
      continue;
    }

    if (parsed.lever === "scale-to-zero") {
      const target = findResource(resources, parsed.targetId);
      if (!target) {
        unsafeReasons.push(`scale-to-zero target ${parsed.targetId} not found`);
        continue;
      }
      const criticalReason = criticalShedReason(resources, target);
      if (criticalReason) {
        unsafeReasons.push(criticalReason);
        if (tier.strategy !== "fail-closed") {
          return {
            steps,
            blockingReason: criticalReason,
            eventReason: "critical resource would be shed",
          };
        }
        continue;
      }
      if (!target.levers.includes("scale-to-zero")) {
        unsafeReasons.push(`target ${target.id} has no scale-to-zero lever`);
        continue;
      }
      steps.push({
        lever: "scale-to-zero",
        targetId: target.id,
        priority: target.priority,
        action: "scale-non-critical-workload-to-zero",
      });
      continue;
    }

    unsafeReasons.push(`unsupported shed directive ${shed}`);
  }

  if (steps.length === 0 && tier.strategy !== "fail-closed" && unsafeReasons.length > 0) {
    return {
      steps,
      blockingReason: unsafeReasons[0],
      eventReason: unsafeReasons[0].includes("critical")
        ? "critical resource would be shed"
        : unsafeReasons[0],
    };
  }

  return { steps };
}

function failClosed({
  requirement,
  profile,
  tier,
  now,
  reason,
  eventReason = reason,
  breakerExhausted,
}) {
  const event = makeAppliedEvent({
    requirement,
    profile,
    tier,
    step: {
      lever: "fail-closed",
      targetId: profile.scope.id,
      priority: "critical",
      action: "refuse-unsafe-degradation",
      reason: eventReason,
    },
    now,
  });

  return resultEnvelope({
    requirement,
    profile,
    tier,
    decision: {
      effect: "fail-closed",
      reason,
      tier: tier.name,
      scope: profile.scope,
    },
    steps: [],
    events: [event],
    breakerHandoff: {
      degradationExhausted: breakerExhausted,
      scope: profile.scope,
      activeTier: tier.name,
      evidenceEventIds: [event.id],
    },
  });
}

function escalateToBreaker({ requirement, profile, tier, now, reason }) {
  const event = makeAppliedEvent({
    requirement,
    profile,
    tier,
    step: {
      lever: "fail-closed",
      targetId: profile.scope.id,
      priority: "critical",
      action: "degradation-exhausted",
      reason,
    },
    now,
  });

  return resultEnvelope({
    requirement,
    profile,
    tier,
    decision: {
      effect: "escalate-to-breaker",
      reason,
      tier: tier.name,
      scope: profile.scope,
    },
    steps: [],
    events: [event],
    breakerHandoff: {
      degradationExhausted: true,
      scope: profile.scope,
      activeTier: tier.name,
      evidenceEventIds: [event.id],
    },
  });
}

function makeAppliedEvent({ requirement, profile, tier, step, now }) {
  const payload = {
    type: "spend.DegradationApplied",
    schemaVersion: COST_DEGRADATION_SAGA_SCHEMA_VERSION,
    policyId: requirement.policyId,
    profileId: profile.id,
    scopeKind: profile.scope.kind,
    scopeId: profile.scope.id,
    tier: tier.name,
    step: step.lever,
    targetId: step.targetId,
    priority: step.priority,
    action: step.action,
    occurredAt: now,
    requirementId: requirement.id,
    reason: step.reason ?? "degradation step applied",
    response: step.response,
    ttlSeconds: step.ttlSeconds,
  };

  return {
    id: `${payload.type}:${shortHash(payload)}`,
    ...payload,
  };
}

function makeRolledBackEvent({ requirement, profile, fromTier, toTier, now, reason }) {
  const payload = {
    type: "spend.DegradationRolledBack",
    schemaVersion: COST_DEGRADATION_SAGA_SCHEMA_VERSION,
    policyId: requirement.policyId,
    profileId: profile.id,
    scopeKind: profile.scope.kind,
    scopeId: profile.scope.id,
    fromTier,
    toTier,
    occurredAt: now,
    reason,
  };

  return {
    id: `${payload.type}:${shortHash(payload)}`,
    ...payload,
  };
}

function resultEnvelope({ requirement, profile, tier, decision, steps, events, breakerHandoff }) {
  return {
    schemaVersion: COST_DEGRADATION_SAGA_SCHEMA_VERSION,
    engine: COST_DEGRADATION_SAGA_ENGINE_ID,
    profile: {
      id: profile.id,
      scope: profile.scope,
      availabilitySlo: profile.availabilitySlo,
    },
    requirement: {
      id: requirement.id,
      policyId: requirement.policyId,
      tier: requirement.tier,
      projectedPeriodSpendUsd: requirement.projectedPeriodSpendUsd,
      thresholdUsd: requirement.thresholdUsd,
    },
    tier: {
      name: tier.name,
      strategy: tier.strategy,
      availabilitySlo: tier.availabilitySlo,
    },
    decision,
    steps,
    events,
    breakerHandoff,
  };
}

function findActiveTier(events, profile, requirement) {
  const applied = events
    .filter(
      (event) =>
        event.type === "spend.DegradationApplied" &&
        event.profileId === profile.id &&
        event.scopeKind === profile.scope.kind &&
        event.scopeId === profile.scope.id,
    )
    .at(-1);
  if (!applied) {
    return null;
  }
  return findTier(profile, applied.tier ?? requirement.tier);
}

function chooseResourceForLever(resources, lever, { allowCritical }) {
  return resources
    .filter((resource) => resource.levers.includes(lever))
    .filter((resource) => allowCritical || resource.priority !== "critical")
    .sort((left, right) => priorityScore(left.priority) - priorityScore(right.priority))[0];
}

function selectCacheTtlTarget({ resources, targetId, allowCritical }) {
  if (!targetId) {
    const resource = chooseResourceForLever(resources, "cache-ttl", { allowCritical });
    return resource
      ? { resource }
      : { resource: null, reason: "no safe cache-ttl target" };
  }
  const resource = findResource(resources, targetId);
  if (!resource) {
    return { resource: null, reason: `cache-ttl target ${targetId} not found` };
  }
  if (!resource.levers.includes("cache-ttl")) {
    return { resource: null, reason: `target ${targetId} has no cache-ttl lever` };
  }
  if (!allowCritical && resource.priority === "critical") {
    return {
      resource: null,
      reason: `critical resource ${targetId} would require degrade-all strategy`,
    };
  }
  return { resource };
}

function criticalShedReason(resources, target) {
  if (target.priority === "critical") {
    return `critical resource ${target.id} would be shed`;
  }
  const dependentCritical = resources.find(
    (resource) => resource.priority === "critical" && resource.dependencies.includes(target.id),
  );
  if (dependentCritical) {
    return `critical resource ${dependentCritical.id} depends on ${target.id}`;
  }
  return null;
}

function parseShedDirective(value) {
  const text = requireString(value, "shed directive");
  if (text.includes(":")) {
    const [lever, ...rest] = text.split(":");
    return {
      lever,
      targetId: rest.join(":"),
    };
  }
  return { lever: text, targetId: text };
}

function findResource(resources, id) {
  return resources.find((resource) => resource.id === id) ?? null;
}

function findTier(profile, name) {
  const tier = profile.tiers.find((candidate) => candidate.name === name);
  if (!tier) {
    throw new TypeError(`profile.tiers must include requested tier ${name}`);
  }
  return tier;
}

function tierThresholdUsd(tier, profile) {
  return tier.thresholdUsd ?? roundUsd(profile.budgetUsd * tier.budgetFraction);
}

function normalizeRequirement(input) {
  const requirement = expectObject(input, "input.requirement");
  if (requirement.type !== "spend.DegradationRequired") {
    throw new TypeError("input.requirement.type must be spend.DegradationRequired");
  }
  return {
    id: optionalString(requirement.id) ?? "spend.DegradationRequired:unknown",
    type: requirement.type,
    policyId: requireString(requirement.policyId, "input.requirement.policyId"),
    profileId: requireString(requirement.profileId, "input.requirement.profileId"),
    scopeKind: requireString(requirement.scopeKind, "input.requirement.scopeKind"),
    scopeId: requireString(requirement.scopeId, "input.requirement.scopeId"),
    tier: requireString(requirement.tier, "input.requirement.tier"),
    durable: requirement.durable === true,
    strategy: optionalString(requirement.strategy),
    shed: parseStringArray(requirement.shed ?? [], "input.requirement.shed"),
    projectedPeriodSpendUsd:
      optionalNonNegativeNumber(
        requirement.projectedPeriodSpendUsd,
        "input.requirement.projectedPeriodSpendUsd",
      ) ?? 0,
    thresholdUsd:
      optionalNonNegativeNumber(requirement.thresholdUsd, "input.requirement.thresholdUsd") ??
      null,
  };
}

function normalizeProfile(input) {
  const profile = expectObject(input, "input.profile");
  const budgetUsd = requirePositiveNumber(profile.budgetUsd, "input.profile.budgetUsd");
  return {
    id: requireString(profile.id, "input.profile.id"),
    scope: normalizeScope(profile.scope, "input.profile.scope"),
    budgetUsd,
    availabilitySlo: requireRatio(profile.availabilitySlo, "input.profile.availabilitySlo"),
    tiers: normalizeTiers(profile.tiers, budgetUsd),
    recoveryHysteresisSeconds:
      optionalNonNegativeInteger(
        profile.recoveryHysteresisSeconds,
        "input.profile.recoveryHysteresisSeconds",
      ) ?? 300,
  };
}

function normalizeTiers(input, budgetUsd) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("input.profile.tiers must be a non-empty array");
  }
  return input.map((tier, index) => {
    const path = `input.profile.tiers[${index}]`;
    const source = expectObject(tier, path);
    const strategy = requireString(source.strategy, `${path}.strategy`);
    if (!VALID_TIER_STRATEGIES.has(strategy)) {
      throw new TypeError(
        `${path}.strategy must be observe, shed-low-priority-first, degrade-all, or fail-closed`,
      );
    }
    return {
      name: requireString(source.name, `${path}.name`),
      budgetFraction: requireRatio(source.budgetFraction, `${path}.budgetFraction`),
      thresholdUsd:
        optionalNonNegativeNumber(source.thresholdUsd, `${path}.thresholdUsd`) ??
        roundUsd(budgetUsd * requireRatio(source.budgetFraction, `${path}.budgetFraction`)),
      availabilitySlo: requireRatio(source.availabilitySlo, `${path}.availabilitySlo`),
      strategy,
      shed: parseStringArray(source.shed ?? [], `${path}.shed`),
      retryAfterSeconds:
        optionalPositiveInteger(source.retryAfterSeconds, `${path}.retryAfterSeconds`) ??
        DEFAULT_RETRY_AFTER_SECONDS,
      cacheTtlSeconds:
        optionalPositiveInteger(source.cacheTtlSeconds, `${path}.cacheTtlSeconds`) ??
        DEFAULT_CACHE_TTL_SECONDS,
    };
  });
}

function assertRequirementMatchesProfile(requirement, profile) {
  if (requirement.profileId !== profile.id) {
    throw new TypeError("input.requirement.profileId must match input.profile.id");
  }
  if (requirement.scopeKind !== profile.scope.kind || requirement.scopeId !== profile.scope.id) {
    throw new TypeError("input.requirement scope must match input.profile.scope");
  }
}

function normalizeResources(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.resources must be an array");
  }
  return input.map((resource, index) => {
    const path = `input.resources[${index}]`;
    const source = expectObject(resource, path);
    const priority = requireString(source.priority, `${path}.priority`);
    if (!PRIORITY_RANK.has(priority)) {
      throw new TypeError(`${path}.priority must be low, standard, or critical`);
    }
    return {
      id: requireString(source.id, `${path}.id`),
      priority,
      dependencies: parseStringArray(source.dependencies ?? [], `${path}.dependencies`),
      levers: parseStringArray(source.levers ?? [], `${path}.levers`),
    };
  });
}

function normalizeRuntime(input) {
  const runtime = expectObject(input, "input.runtime");
  return {
    observedAvailability:
      optionalRatio(runtime.observedAvailability, "input.runtime.observedAvailability") ?? 1,
    projectedAvailabilityAfterActions:
      optionalRatio(
        runtime.projectedAvailabilityAfterActions,
        "input.runtime.projectedAvailabilityAfterActions",
      ) ?? 1,
    lowPriorityQueueDepth:
      optionalNonNegativeInteger(
        runtime.lowPriorityQueueDepth,
        "input.runtime.lowPriorityQueueDepth",
      ) ?? 0,
    retryAfterConsumerBudgetPerMinute:
      optionalNonNegativeInteger(
        runtime.retryAfterConsumerBudgetPerMinute,
        "input.runtime.retryAfterConsumerBudgetPerMinute",
      ) ?? 0,
    belowTierThresholdSince:
      runtime.belowTierThresholdSince === null || runtime.belowTierThresholdSince === undefined
        ? null
        : normalizeInstant(runtime.belowTierThresholdSince, "input.runtime.belowTierThresholdSince"),
    spendVelocityUsdPerHour:
      optionalNonNegativeNumber(
        runtime.spendVelocityUsdPerHour,
        "input.runtime.spendVelocityUsdPerHour",
      ) ?? 0,
  };
}

function normalizePriorEvents(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.priorEvents must be an array");
  }
  return input.map((event) => expectObject(event, "input.priorEvents[]"));
}

function normalizeScope(input, path) {
  const scope = expectObject(input, path);
  return {
    kind: requireString(scope.kind, `${path}.kind`),
    id: requireString(scope.id, `${path}.id`),
  };
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function optionalString(input) {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  return requireString(input, "value");
}

function parseStringArray(input, fieldName) {
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function requireRatio(input, fieldName) {
  if (!Number.isFinite(input) || input < 0 || input > 1) {
    throw new TypeError(`${fieldName} must be a number from 0 through 1`);
  }
  return input;
}

function optionalRatio(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  return requireRatio(input, fieldName);
}

function requirePositiveNumber(input, fieldName) {
  if (!Number.isFinite(input) || input <= 0) {
    throw new TypeError(`${fieldName} must be a positive number`);
  }
  return roundUsd(input);
}

function optionalNonNegativeNumber(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Number.isFinite(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }
  return roundUsd(input);
}

function optionalNonNegativeInteger(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Number.isInteger(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return input;
}

function optionalPositiveInteger(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Number.isInteger(input) || input <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return input;
}

function normalizeInstant(input, fieldName) {
  if (!isJsonString(input)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(timestamp).toISOString();
}

function priorityScore(priority) {
  return PRIORITY_RANK.get(priority) ?? Number.POSITIVE_INFINITY;
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}

function shortHash(input) {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
