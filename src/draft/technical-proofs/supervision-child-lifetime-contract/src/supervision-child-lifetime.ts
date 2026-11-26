export const supervisionChildLifetimeSpec = Object.freeze({
  version: "hobo.sdk.supervision-child-lifetime/v1",
  suite: "@hobo/conformance/sdk/supervision-child-lifetime",
  cases: Object.freeze([
    "invoked-child-stops-on-parent-exit",
    "spawned-child-requires-stop-or-teardown",
    "retry-budget-exhaustion-escalates",
    "cleanup-failure-is-audited",
    "replay-reconstructs-supervision-outcome",
  ]),
});

export const canonicalSupervisionFixtures = Object.freeze([
  freezeFixture({
    name: "invoked-child-stops-on-parent-exit",
    assertions: ["parent-exit-stops-invoked-child", "cleanup-after-parent-exit"],
    facts: [
      { type: "parent.StateEntered", parentId: "workflow:checkout", state: "running", atMs: 0 },
      { type: "child.Invoked", parentId: "workflow:checkout", childId: "step:reserve-inventory", atMs: 1 },
      { type: "parent.StateExited", parentId: "workflow:checkout", from: "running", to: "cancelled", atMs: 20 },
      { type: "child.Stopped", parentId: "workflow:checkout", childId: "step:reserve-inventory", reason: "parent-exit", atMs: 21 },
      { type: "cleanup.Emitted", childId: "step:reserve-inventory", reason: "parent-exit", atMs: 22 },
      { type: "cleanup.Audited", childId: "step:reserve-inventory", status: "released", atMs: 23 },
    ],
  }),
  freezeFixture({
    name: "spawned-child-requires-stop-or-teardown",
    assertions: ["spawned-child-has-teardown-owner"],
    facts: [
      { type: "parent.StateEntered", parentId: "saga:progressive-rollout", state: "monitoring", atMs: 0 },
      {
        type: "child.Spawned",
        parentId: "saga:progressive-rollout",
        childId: "monitor:slo-window",
        spawnContract: "explicit-stop",
        atMs: 1,
      },
      { type: "parent.StateExited", parentId: "saga:progressive-rollout", from: "monitoring", to: "tearing-down", atMs: 50 },
      {
        type: "child.StopRequested",
        parentId: "saga:progressive-rollout",
        childId: "monitor:slo-window",
        owner: "parent-teardown",
        atMs: 51,
      },
      { type: "child.Stopped", parentId: "saga:progressive-rollout", childId: "monitor:slo-window", reason: "parent-teardown", atMs: 52 },
      { type: "cleanup.Emitted", childId: "monitor:slo-window", reason: "parent-teardown", atMs: 53 },
      { type: "cleanup.Audited", childId: "monitor:slo-window", status: "released", atMs: 54 },
    ],
  }),
  freezeFixture({
    name: "retry-budget-exhaustion-escalates",
    assertions: ["retry-budget-exhaustion-escalates"],
    facts: [
      { type: "child.Invoked", parentId: "workflow:checkout", childId: "step:charge-card", atMs: 0 },
      { type: "retry.BudgetDeclared", childId: "step:charge-card", maxAttempts: 2, atMs: 1 },
      { type: "retry.Attempted", childId: "step:charge-card", attempt: 1, failure: "provider-timeout", atMs: 2 },
      { type: "retry.Attempted", childId: "step:charge-card", attempt: 2, failure: "provider-timeout", atMs: 3 },
      { type: "retry.BudgetExhausted", parentId: "workflow:checkout", childId: "step:charge-card", attempts: 2, atMs: 4 },
      {
        type: "workflow.Escalated",
        parentId: "workflow:checkout",
        childId: "step:charge-card",
        reason: "retry-budget-exhausted",
        attempts: 2,
        operatorContext: {
          action: "inspect-child",
          lastFailure: "provider-timeout",
        },
        atMs: 5,
      },
      { type: "inspection.Replayed", effectCounterBefore: 2, effectCounterAfter: 2, atMs: 100 },
    ],
  }),
  freezeFixture({
    name: "cleanup-failure-is-audited",
    assertions: ["cleanup-failure-audited", "cleanup-failure-not-successful"],
    facts: [
      { type: "parent.StateExited", parentId: "runbook:rollback", from: "compensating", to: "tearing-down", atMs: 0 },
      { type: "child.Stopped", parentId: "runbook:rollback", childId: "step:rollback-traffic", reason: "parent-exit", atMs: 1 },
      { type: "cleanup.Trapped", childId: "step:rollback-traffic", reason: "guest finalizer trap", atMs: 2 },
      { type: "cleanup.Audited", childId: "step:rollback-traffic", status: "owned-for-teardown", owner: "parent-teardown", atMs: 3 },
      { type: "workflow.Escalated", parentId: "runbook:rollback", childId: "step:rollback-traffic", reason: "cleanup-failed", atMs: 4 },
    ],
  }),
  freezeFixture({
    name: "replay-reconstructs-supervision-outcome",
    assertions: ["replay-reconstructs-outcome"],
    facts: [
      { type: "child.Invoked", parentId: "workflow:checkout", childId: "step:notify", atMs: 0 },
      { type: "child.Stopped", parentId: "workflow:checkout", childId: "step:notify", reason: "completed", atMs: 10 },
      { type: "inspection.Replayed", effectCounterBefore: 1, effectCounterAfter: 1, atMs: 100 },
      {
        type: "inspection.SupervisionOutcome",
        source: "persisted-facts",
        parentId: "workflow:checkout",
        childStates: [{ childId: "step:notify", state: "stopped" }],
        atMs: 101,
      },
    ],
  }),
]);

export const badSupervisionFixtures = Object.freeze([
  freezeFixture({
    name: "bad-parent-cancel-leaves-child-retry",
    assertions: ["parent-cancellation-stops-child-retry"],
    facts: [
      { type: "child.Invoked", parentId: "workflow:checkout", childId: "step:charge-card", atMs: 0 },
      { type: "parent.Cancelled", parentId: "workflow:checkout", atMs: 10 },
      { type: "retry.Scheduled", childId: "step:charge-card", attempt: 3, delayMs: 500, atMs: 11 },
    ],
  }),
  freezeFixture({
    name: "bad-cleanup-trap-without-audit",
    assertions: ["cleanup-failure-audited"],
    facts: [
      { type: "parent.StateExited", parentId: "runbook:rollback", from: "compensating", to: "tearing-down", atMs: 0 },
      { type: "child.Stopped", parentId: "runbook:rollback", childId: "step:rollback-traffic", reason: "parent-exit", atMs: 1 },
      { type: "cleanup.Trapped", childId: "step:rollback-traffic", reason: "guest finalizer trap", atMs: 2 },
    ],
  }),
  freezeFixture({
    name: "bad-retry-budget-reset-after-restart",
    assertions: ["retry-budget-exhaustion-escalates"],
    facts: [
      { type: "child.Invoked", parentId: "workflow:checkout", childId: "step:charge-card", atMs: 0 },
      { type: "retry.BudgetDeclared", childId: "step:charge-card", maxAttempts: 2, atMs: 1 },
      { type: "retry.Attempted", childId: "step:charge-card", attempt: 1, failure: "provider-timeout", atMs: 2 },
      { type: "retry.Attempted", childId: "step:charge-card", attempt: 2, failure: "provider-timeout", atMs: 3 },
      { type: "retry.BudgetExhausted", parentId: "workflow:checkout", childId: "step:charge-card", attempts: 2, atMs: 4 },
      { type: "workflow.Escalated", parentId: "workflow:checkout", childId: "step:charge-card", reason: "retry-budget-exhausted", attempts: 2, operatorContext: { action: "inspect-child" }, atMs: 5 },
      { type: "process.Restarted", parentId: "workflow:checkout", atMs: 6 },
      { type: "retry.Attempted", childId: "step:charge-card", attempt: 1, failure: "provider-timeout", atMs: 7 },
    ],
  }),
]);

const scopeOut = Object.freeze([
  "No distributed scheduler implementation.",
  "No production process supervision tree.",
  "No new queue backend.",
]);

export function runSupervisionChildLifetimeContract(fixtures = canonicalSupervisionFixtures) {
  const cases = fixtures.map(runSupervisionCase);
  const status = cases.every((entry) => entry.status === "passed") ? "passed" : "failed";

  return {
    suite: supervisionChildLifetimeSpec.suite,
    specVersion: supervisionChildLifetimeSpec.version,
    status,
    resilienceSemanticsLane: {
      status: "referenced",
      source: "HOBO-516 resilience-semantics-annex",
    },
    supervisionSemanticsLane: {
      status,
      cases,
    },
    scopeOut: [...scopeOut],
  };
}

export function runSupervisionCase(fixture: SupervisionFixture): SupervisionCaseResult {
  const failure = validateFixture(fixture);
  const provenAcceptance = failure ? [] : fixture.assertions.flatMap((assertion) => PROVEN_ACCEPTANCE[assertion] ?? []);

  return {
    name: fixture.name,
    category: "supervisionSemanticsLane",
    status: failure ? "failed" : "passed",
    code: failure?.code,
    reason: failure?.reason,
    provenAcceptance,
  };
}

interface ProvenAcceptance {
  readonly [scenario: string]: readonly string[];
}

const PROVEN_ACCEPTANCE: ProvenAcceptance = {
  "parent-exit-stops-invoked-child": ["parent-exit-stops-invoked-child"],
  "cleanup-after-parent-exit": ["cleanup-facts-after-parent-exit"],
  "spawned-child-has-teardown-owner": ["spawned-child-has-teardown-owner"],
  "retry-budget-exhaustion-escalates": ["retry-budget-exhaustion-escalates"],
  "cleanup-failure-audited": ["cleanup-failure-audited"],
  "cleanup-failure-not-successful": ["cleanup-failure-not-successful"],
  "replay-reconstructs-outcome": ["replay-reconstructs-outcome"],
};

function validateFixture(fixture: SupervisionFixture): SupervisionFailure | null {
  const facts = sortFacts(fixture.facts);

  for (const assertion of fixture.assertions) {
    const failure = validateAssertion(assertion, facts);
    if (failure) return failure;
  }

  return null;
}

function validateAssertion(assertion: string, facts: SupervisionFact[]): SupervisionFailure | null {
  if (assertion === "parent-exit-stops-invoked-child") return validateParentExitStopsInvokedChild(facts);
  if (assertion === "cleanup-after-parent-exit") return validateCleanupAfterParentExit(facts);
  if (assertion === "spawned-child-has-teardown-owner") return validateSpawnedChildHasTeardownOwner(facts);
  if (assertion === "retry-budget-exhaustion-escalates") return validateRetryBudgetExhaustionEscalates(facts);
  if (assertion === "cleanup-failure-audited") return validateCleanupFailureAudited(facts);
  if (assertion === "cleanup-failure-not-successful") return validateCleanupFailureNotSuccessful(facts);
  if (assertion === "replay-reconstructs-outcome") return validateReplayReconstructsOutcome(facts);
  if (assertion === "parent-cancellation-stops-child-retry") return validateParentCancellationStopsChildRetry(facts);
  return fail("supervision.unknown_assertion", `unknown assertion: ${assertion}`);
}

function validateParentExitStopsInvokedChild(facts: SupervisionFact[]) {
  const exit = facts.find((fact) => fact.type === "parent.StateExited" || fact.type === "parent.Cancelled");
  if (!exit) return fail("supervision.parent_exit_missing", "fixture has no persisted parent exit or cancellation fact");

  const invokedChildren = facts.filter((fact) => fact.type === "child.Invoked" && fact.atMs < exit.atMs);
  if (invokedChildren.length === 0) return fail("supervision.child_missing", "fixture has no invoked child before parent exit");

  for (const child of invokedChildren) {
    if (!hasStopAfter(facts, child.childId, exit.atMs)) {
      return fail("supervision.child_outlived_parent", `${child.childId} was not stopped after parent exit`);
    }
  }

  return null;
}

function validateCleanupAfterParentExit(facts: SupervisionFact[]) {
  const exit = facts.find((fact) => fact.type === "parent.StateExited" || fact.type === "parent.Cancelled");
  if (!exit) return fail("supervision.parent_exit_missing", "fixture has no persisted parent exit or cancellation fact");

  const stoppedChildren = facts.filter((fact) => fact.type === "child.Stopped" && fact.atMs >= exit.atMs);
  if (stoppedChildren.length === 0) return fail("supervision.child_stop_missing", "no child stop fact after parent exit");

  for (const child of stoppedChildren) {
    if (!hasCleanupAuditAfter(facts, child.childId, child.atMs)) {
      return fail("supervision.cleanup_not_audited", `${child.childId} cleanup was not emitted and audited`);
    }
  }

  return null;
}

function validateSpawnedChildHasTeardownOwner(facts: SupervisionFact[]) {
  const exit = facts.find((fact) => fact.type === "parent.StateExited" || fact.type === "parent.Cancelled");
  if (!exit) return fail("supervision.parent_exit_missing", "fixture has no persisted parent exit or cancellation fact");

  const spawnedChildren = facts.filter((fact) => fact.type === "child.Spawned" && fact.atMs < exit.atMs);
  if (spawnedChildren.length === 0) return fail("supervision.spawned_child_missing", "fixture has no spawned child");

  for (const child of spawnedChildren) {
    const stopRequest = facts.find(
      (fact) =>
        fact.type === "child.StopRequested" &&
        fact.childId === child.childId &&
        fact.owner === "parent-teardown" &&
        fact.atMs >= exit.atMs,
    );
    if (!stopRequest || !hasStopAfter(facts, child.childId, stopRequest.atMs)) {
      return fail("supervision.child_outlived_parent", `${child.childId} lacks explicit parent-teardown ownership`);
    }
  }

  return null;
}

function validateRetryBudgetExhaustionEscalates(facts: SupervisionFact[]) {
  const exhaustion = facts.find((fact) => fact.type === "retry.BudgetExhausted");
  if (!exhaustion) return fail("supervision.retry_budget_missing", "fixture has no retry budget exhaustion fact");

  const restart = facts.find((fact) => fact.type === "process.Restarted" && fact.atMs > exhaustion.atMs);
  if (restart && facts.some((fact) => fact.type === "retry.Attempted" && fact.childId === exhaustion.childId && fact.atMs > restart.atMs)) {
    return fail("supervision.retry_budget_reset", "retry budget exhaustion was reset by process restart");
  }

  const escalation = facts.find(
    (fact) =>
      fact.type === "workflow.Escalated" &&
      fact.reason === "retry-budget-exhausted" &&
      fact.childId === exhaustion.childId &&
      fact.attempts === exhaustion.attempts &&
      fact.operatorContext &&
      fact.atMs >= exhaustion.atMs,
  );
  if (!escalation) {
    return fail("supervision.retry_budget_not_escalated", "retry budget exhaustion did not emit operator-ready escalation");
  }

  return null;
}

function validateCleanupFailureAudited(facts: SupervisionFact[]) {
  const trap = facts.find((fact) => fact.type === "cleanup.Trapped");
  if (!trap) return fail("supervision.cleanup_trap_missing", "fixture has no cleanup trap fact");

  const audit = facts.find(
    (fact) =>
      fact.type === "cleanup.Audited" &&
      fact.childId === trap.childId &&
      (fact.status === "owned-for-teardown" || fact.status === "released") &&
      fact.atMs >= trap.atMs,
  );
  if (!audit) return fail("supervision.cleanup_not_audited", "cleanup trap did not produce a safe audit fact");

  return null;
}

function validateCleanupFailureNotSuccessful(facts: SupervisionFact[]) {
  const trap = facts.find((fact) => fact.type === "cleanup.Trapped");
  if (!trap) return fail("supervision.cleanup_trap_missing", "fixture has no cleanup trap fact");
  if (facts.some((fact) => fact.type === "parent.Succeeded" && fact.atMs >= trap.atMs)) {
    return fail("supervision.cleanup_marked_success", "cleanup failure silently marked parent successful");
  }
  if (!facts.some((fact) => fact.type === "workflow.Escalated" && fact.reason === "cleanup-failed" && fact.atMs >= trap.atMs)) {
    return fail("supervision.cleanup_not_escalated", "cleanup failure did not transfer teardown ownership");
  }

  return null;
}

function validateReplayReconstructsOutcome(facts: SupervisionFact[]) {
  const replay = facts.find((fact) => fact.type === "inspection.Replayed");
  if (!replay) return fail("supervision.replay_missing", "fixture has no replay inspection fact");
  if (replay.effectCounterBefore !== replay.effectCounterAfter) {
    return fail("supervision.replay_reran_effect", "replay changed effect counters");
  }
  if (facts.some((fact) => fact.mode === "replay" && (fact.type === "child.Invoked" || fact.type === "retry.Attempted"))) {
    return fail("supervision.replay_reran_effect", "replay emitted fresh child work");
  }
  if (!facts.some((fact) => fact.type === "inspection.SupervisionOutcome" && fact.source === "persisted-facts" && fact.atMs >= replay.atMs)) {
    return fail("supervision.replay_not_persisted", "supervision inspection was not rebuilt from persisted facts");
  }

  return null;
}

function validateParentCancellationStopsChildRetry(facts: SupervisionFact[]) {
  const cancellation = facts.find((fact) => fact.type === "parent.Cancelled");
  if (!cancellation) return fail("supervision.parent_cancel_missing", "fixture has no parent cancellation fact");

  const retry = facts.find((fact) => fact.type === "retry.Scheduled" && fact.atMs > cancellation.atMs);
  if (retry) return fail("supervision.untracked_child_retry", "parent cancellation left an untracked child retry pending");

  return validateParentExitStopsInvokedChild(facts) ?? validateCleanupAfterParentExit(facts);
}

function hasStopAfter(facts: SupervisionFact[], childId: string, atMs: number): boolean {
  return facts.some((fact) => fact.type === "child.Stopped" && fact.childId === childId && fact.atMs >= atMs);
}

function hasCleanupAuditAfter(facts: SupervisionFact[], childId: string, atMs: number): boolean {
  const cleanup = facts.find((fact) => fact.type === "cleanup.Emitted" && fact.childId === childId && fact.atMs >= atMs);
  const audit = facts.find((fact) => fact.type === "cleanup.Audited" && fact.childId === childId && fact.atMs >= (cleanup?.atMs ?? atMs));
  return Boolean(cleanup && audit);
}

function sortFacts(facts: readonly SupervisionFact[]): SupervisionFact[] {
  return [...facts].sort((left, right) => left.atMs - right.atMs || left.type.localeCompare(right.type));
}

function fail(code: string, reason: string): SupervisionFailure {
  return { code, reason };
}

function freezeFixture(fixture: SupervisionFixture): SupervisionFixture {
  return Object.freeze({
    ...fixture,
    assertions: Object.freeze([...fixture.assertions]),
    facts: Object.freeze(fixture.facts.map((fact) => Object.freeze({ ...fact }))),
  });
}

export type SupervisionFixture = Readonly<{
  name: string;
  assertions: readonly string[];
  facts: readonly SupervisionFact[];
}>;

export type SupervisionFact = Readonly<{
  type: string;
  atMs: number;
  parentId?: string;
  childId?: string;
  state?: string;
  from?: string;
  to?: string;
  reason?: string;
  owner?: string;
  status?: string;
  spawnContract?: string;
  attempt?: number;
  attempts?: number;
  maxAttempts?: number;
  delayMs?: number;
  failure?: string;
  mode?: string;
  source?: string;
  effectCounterBefore?: number;
  effectCounterAfter?: number;
  operatorContext?: Record<string, string>;
  childStates?: readonly Record<string, string>[];
}>;

export type SupervisionCaseResult = Readonly<{
  name: string;
  category: "supervisionSemanticsLane";
  status: "passed" | "failed";
  code?: string;
  reason?: string;
  provenAcceptance: string[];
}>;

type SupervisionFailure = Readonly<{
  code: string;
  reason: string;
}>;
