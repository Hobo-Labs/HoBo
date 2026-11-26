import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PromotionGateContractError,
  buildPromotionPolicyRequest,
  createGenerationPromotionGate,
  rebuildPromotionGateRun,
} from "../src/promotion-gate.js";
import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
} from "../../policy-engine-port-contract/src/policy-engine-port.js";

const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

test("low-risk generation candidate auto-certifies through the policy gate", () => {
  const gate = createGenerationPromotionGate({
    policyEngine: createBuiltInPolicyEngine(),
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "allow-low-risk-generation-certify",
          when: ({ request }) =>
            request.action === "gen.certify" &&
            request.phase === "promote" &&
            request.context.riskClass === "low" &&
            request.context.environment === "preview",
          decide: () => ({
            effect: "allow",
            reason: "low-risk preview generation may auto-certify",
          }),
        }),
      ],
    }),
  });

  const result = gate.decide(validCandidate());

  assert.equal(result.effect, "certify");
  assert.equal(result.certified, true);
  assert.equal(result.policyRequest.action, "gen.certify");
  assert.equal(result.policyRequest.phase, "promote");
  assert.deepEqual(result.policyRequest.context.evalResults, { passed: true });
  assert.equal(result.policyDecision.effect, "allow");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["policy.Decided", "gen.PromotionGateDecided", "gen.Certified"],
  );

  const rebuilt = rebuildPromotionGateRun(result.events);
  assert.equal(rebuilt.finalDecision.effect, "certify");
  assert.equal(rebuilt.certified, true);
  assert.equal(rebuilt.policyDecision.evidence.inputHash, result.policyDecision.evidence.inputHash);
});

test("prod generation candidate blocks on createHook and certifies only after approval resolves", () => {
  const gate = createGenerationPromotionGate({
    policyEngine: createBuiltInPolicyEngine(),
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "prod-generation-requires-approval",
          when: ({ request }) =>
            request.action === "gen.certify" && request.context.environment === "prod",
          decide: () => ({
            effect: "require-approval",
            reason: "prod generation requires human approval",
            approvals: ["hook:gen-prod-certify"],
            obligations: [
              {
                kind: "createHook",
                id: "hook:gen-prod-certify",
                deadline: "PT30M",
              },
            ],
          }),
        }),
      ],
    }),
  });

  const pending = gate.decide(
    validCandidate({
      environment: "prod",
      riskClass: "high",
      target: {
        kind: "provider-plugin",
        id: "@hobo/provider-acme-db",
        witPort: "hobo:database/postgres@0.1.0",
      },
    }),
  );

  assert.equal(pending.effect, "require-approval");
  assert.equal(pending.certified, false);
  assert.equal(pending.approvalHook.kind, "createHook");
  assert.equal(pending.events.some((event) => event.type === "gen.Certified"), false);
  assert.throws(() => gate.certifyFromEvents(pending.events), /approval hook has not resolved/);

  const approvedAt = "2026-06-25T16:00:00.000Z";
  const approved = gate.resolveApproval(pending.events, {
    approvedBy: "user:security-admin",
    resolution: "approved",
    ts: approvedAt,
  });

  assert.deepEqual(
    approved.events.map((event) => event.type),
    ["gen.ApprovalHookResolved", "gen.Certified"],
  );
  assert.deepEqual(
    approved.events.map((event) => event.ts),
    [approvedAt, approvedAt],
  );

  const rebuilt = rebuildPromotionGateRun([...pending.events, ...approved.events]);
  assert.equal(rebuilt.approval.resolution, "approved");
  assert.equal(rebuilt.certified, true);
});

test("unknown risk class defaults to require-approval even when policy would allow", () => {
  const gate = createGenerationPromotionGate({
    policyEngine: createBuiltInPolicyEngine(),
    ruleset: createRuleset({
      rules: [
        defineTypescriptRule({
          id: "overbroad-allow",
          when: ({ request }) => request.action === "gen.certify",
          decide: () => ({ effect: "allow", reason: "overbroad policy fixture" }),
        }),
      ],
    }),
  });

  const result = gate.decide(validCandidate({ riskClass: "novel-risk-class" }));

  assert.equal(result.policyDecision.effect, "allow");
  assert.equal(result.effect, "require-approval");
  assert.equal(result.certified, false);
  assert.match(result.finalDecision.reason, /unknown-risk-fail-closed/);
});

test("gate refuses certification when conformance or eval evidence is not green", () => {
  const gate = createGenerationPromotionGate({
    policyEngine: createBuiltInPolicyEngine(),
    ruleset: createRuleset(),
  });

  assertContractError(
    () => gate.decide(validCandidate({ conformance: { passed: false } })),
    "promotion.conformance_not_green",
  );
  assertContractError(
    () => gate.decide(validCandidate({ evalResults: { passed: false } })),
    "promotion.eval_not_green",
  );
});

test("policy request shape carries subject, generation action, resource, phase, and risk context", () => {
  const request = buildPromotionPolicyRequest(
    validCandidate({
      subject: {
        kind: "agent",
        id: "spiffe://tenant-a/yard/gen-agent",
        roles: ["generation-operator"],
      },
    }),
  );

  assert.equal(request.schema, "hobo.policy-ir/v1");
  assert.equal(request.subject.kind, "agent");
  assert.equal(request.action, "gen.certify");
  assert.equal(request.resource.kind, "generated-artifact");
  assert.equal(request.phase, "promote");
  assert.equal(request.context.riskClass, "low");
  assert.equal(request.context.environment, "preview");
});

function validCandidate(overrides = {}) {
  return {
    runId: "gen-run-333",
    subject: {
      kind: "agent",
      id: "spiffe://tenant-a/yard/generation-agent",
      roles: ["generation-operator"],
    },
    artifactKind: "provider",
    target: {
      kind: "generated-artifact",
      id: "@hobo/provider-acme-db",
      witPort: "hobo:database/postgres@0.1.0",
    },
    environment: "preview",
    riskClass: "low",
    conformance: {
      passed: true,
      reportRef: {
        uri: "oci://registry.example/hobo/reports/gen-run-333",
        digest,
      },
    },
    evalResults: {
      passed: true,
    },
    candidateRef: {
      uri: "oci://registry.example/hobo/candidates/provider-acme-db",
      digest,
    },
    provenanceRef: {
      uri: "oci://registry.example/hobo/provenance/gen-run-333",
      digest,
    },
    ts: "2026-06-25T15:55:00.000Z",
    ...overrides,
  };
}

function assertContractError(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof PromotionGateContractError && error.code === code,
  );
}
