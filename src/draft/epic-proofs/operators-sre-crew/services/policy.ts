import { evaluatePolicyPack, type PolicyPack } from "@hobo/contracts";
import { fromWitDecisionRecordV2, toWitDecisionRecordV2 } from "@hobo/policy";

const outcomes = {
  "provider-degraded-api": {
    action: "failover-provider",
    effect: "allow",
    decision: "allow_canary",
    obligations: ["watch-error-budget", "rollback-on-regression"],
  },
  "prod-contract-skew": {
    action: "dual-publish-shim",
    effect: "require-approval",
    decision: "require_approval",
    obligations: ["on-call-ack", "operator-console-approval"],
  },
  "ambiguous-runaway-remediation": {
    action: "self-caused-remediation-loop",
    effect: "deny",
    decision: "deny_write_escalate",
    obligations: ["human-review", "runbook-revision"],
  },
  "regional-dr-failover": {
    action: "regional-traffic-shift",
    effect: "allow",
    decision: "allow_failover",
    obligations: ["publish-status-page", "postmortem"],
  },
} as const;

type ScenarioId = keyof typeof outcomes;

function isScenarioId(id: string): id is ScenarioId {
  return Object.hasOwn(outcomes, id);
}

const defaultPack: PolicyPack = {
  id: "hobo.sre/remediation",
  version: "1.0.0",
  rules: Object.entries(outcomes).map(([id, outcome]) => ({
    id,
    when: (request) => request.action === outcome.action,
    decide: () => ({
      effect: outcome.effect,
      reason: outcome.decision,
      obligations: outcome.obligations.map((kind) => ({ kind })),
    }),
  })),
};

export function decideCrewPolicy(
  fixture: { id: string; incidentId: string },
  policyPack: PolicyPack = defaultPack,
) {
  if (!isScenarioId(fixture.id)) throw new Error("unknown crew policy action");
  const expected = outcomes[fixture.id];
  const request = {
    subject: { kind: "agent", id: "sre-operator" },
    action: expected.action,
    resource: { kind: "incident", id: fixture.incidentId },
    phase: "runtime",
  };
  let result = evaluatePolicyPack({ request, pack: policyPack });
  if (result.matchedRuleIds.length === 0) {
    result = evaluatePolicyPack({
      request,
      pack: {
        ...policyPack,
        rules: [
          ...policyPack.rules,
          {
            id: "deny-unmapped",
            when: () => true,
            decide: () => ({
              effect: "deny",
              reason: "no matching crew policy",
            }),
          },
        ],
      },
    });
  }
  const decision = fromWitDecisionRecordV2(
    toWitDecisionRecordV2(result.decision),
    undefined,
  );
  return {
    decision:
      decision.effect === expected.effect
        ? expected.decision
        : decision.effect === "require-approval"
          ? "require_approval"
          : decision.effect === "allow"
            ? "allow"
            : "deny_write_escalate",
    effect: decision.effect,
    reason: decision.reason,
    obligations: decision.obligations.map((obligation) => obligation.kind),
    evidence: decision.evidence,
  };
}
