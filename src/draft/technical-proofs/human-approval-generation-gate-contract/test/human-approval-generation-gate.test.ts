import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HumanApprovalGateError,
  decideGenerationHumanApproval,
  replayHumanApprovalGate,
  resolveGenerationHumanApproval,
} from "../src/human-approval-generation-gate.js";

test("prod high-risk generation requires meaningful human approval before certification", () => {
  const pending = decideGenerationHumanApproval(generationRequest());

  assert.equal(pending.status, "approval-required");
  assert.equal(pending.certified, false);
  assert.equal(pending.decision.effect, "require-approval");
  assert.equal(pending.approvalHook.reportRefs.safetyReport.digest, digest("3"));
  assert.deepEqual(
    pending.events.map((event) => event.type),
    ["policy.Decided", "policy.ObligationCreated", "gen.ApprovalHookCreated"],
  );

  const approved = resolveGenerationHumanApproval(pending.events, approvalDecision());

  assert.equal(approved.status, "certified");
  assert.equal(approved.certified, true);
  assert.deepEqual(
    approved.events.map((event) => event.type),
    ["gen.ApprovalDecisionRecorded", "gen.Certified"],
  );
  assert.equal(approved.events[1].data.approvedBy, "user:security-admin");

  const replay = replayHumanApprovalGate([...pending.events, ...approved.events]);
  assert.equal(replay.certified, true);
  assert.equal(replay.approval.resolution, "approved");
  assert.equal(replay.policyDecision.data.evidence.inputHash, pending.decision.evidence.inputHash);
});

test("mandatory deny-ceiling keeps the prod gate on despite tenant auto-approval policy", () => {
  const prodResult = decideGenerationHumanApproval(
    generationRequest({
      requestedRiskClass: "low",
      policyPacks: [
        {
          id: "junction-mandatory-prod-gen-gate",
          scope: "junction",
          mode: "mandatory",
          requireHumanApprovalFor: ["gen.certify:prod"],
        },
        {
          id: "tenant-auto-generation",
          scope: "bindle",
          mode: "default",
          autoApproveFor: ["gen.certify:prod"],
        },
      ],
    }),
  );

  assert.equal(prodResult.status, "approval-required");
  assert.equal(prodResult.decision.effect, "require-approval");
  assert.match(prodResult.decision.reason, /mandatory deny-ceiling/);
  assert.deepEqual(prodResult.decision.evidence.policyIds, [
    "junction-mandatory-prod-gen-gate",
    "tenant-auto-generation",
  ]);
  assert.equal(prodResult.certified, false);

  const lowRiskPreviewResult = decideGenerationHumanApproval(
    generationRequest({
      environment: "preview",
      requestedRiskClass: "low",
      target: { ...generationRequest().target, trustClass: "normal", destructive: false },
      evidence: { actualRiskClass: "low", riskReasons: [] },
      policyPacks: [
        {
          id: "junction-mandatory-preview-gen-gate",
          scope: "junction",
          mode: "mandatory",
          requireHumanApprovalFor: ["gen.certify:preview"],
        },
        {
          id: "tenant-auto-generation",
          scope: "bindle",
          mode: "default",
          autoApproveFor: ["gen.certify:preview"],
        },
      ],
    }),
  );

  assert.equal(lowRiskPreviewResult.status, "approval-required");
  assert.equal(lowRiskPreviewResult.decision.effect, "require-approval");
  assert.match(lowRiskPreviewResult.decision.reason, /mandatory deny-ceiling/);
  assert.equal(lowRiskPreviewResult.certified, false);
});

test("approval denial is event-sourced and never emits gen.Certified", () => {
  const pending = decideGenerationHumanApproval(generationRequest());
  const denied = resolveGenerationHumanApproval(
    pending.events,
    approvalDecision({ resolution: "denied", reason: "unsafe generated migration" }),
  );

  assert.equal(denied.status, "denied");
  assert.equal(denied.certified, false);
  assert.deepEqual(
    denied.events.map((event) => event.type),
    ["gen.ApprovalDecisionRecorded"],
  );

  const replay = replayHumanApprovalGate([...pending.events, ...denied.events]);
  assert.equal(replay.certified, false);
  assert.equal(replay.approval.resolution, "denied");
});

test("agent self-approval and empty auto-resolved approval do not count", () => {
  const pending = decideGenerationHumanApproval(generationRequest());

  assertGateError(
    () =>
      resolveGenerationHumanApproval(
        pending.events,
        approvalDecision({
          actor: { kind: "agent", id: "spiffe://tenant-a/yard/gen-agent" },
          approvedBy: "spiffe://tenant-a/yard/gen-agent",
        }),
      ),
    "approval.actor_not_human",
  );

  assertGateError(
    () =>
      resolveGenerationHumanApproval(
        pending.events,
        approvalDecision({ humanSignal: "", autoResolved: true }),
      ),
    "approval.meaningful_signal_required",
  );
});

test("risk downgrade attempts and unknown risk default to approval required", () => {
  const downgraded = decideGenerationHumanApproval(
    generationRequest({
      requestedRiskClass: "low",
      evidence: {
        actualRiskClass: "high",
        riskReasons: ["destructive", "prod-target"],
      },
    }),
  );

  assert.equal(downgraded.status, "approval-required");
  assert.equal(downgraded.decision.context.riskClass, "high");
  assert.match(downgraded.decision.reason, /computed high-risk/);

  const unknown = decideGenerationHumanApproval(
    generationRequest({
      requestedRiskClass: "unmapped-model-risk",
      environment: "preview",
      target: { ...generationRequest().target, trustClass: "normal" },
      evidence: { actualRiskClass: "unknown", riskReasons: [] },
    }),
  );

  assert.equal(unknown.status, "approval-required");
  assert.match(unknown.decision.reason, /unknown risk/);
});

test("low-risk preview generation can pass without approval when no policy demands it", () => {
  const result = decideGenerationHumanApproval(
    generationRequest({
      environment: "preview",
      requestedRiskClass: "low",
      target: { ...generationRequest().target, trustClass: "normal", destructive: false },
      evidence: { actualRiskClass: "low", riskReasons: [] },
    }),
  );

  assert.equal(result.status, "certified");
  assert.equal(result.certified, true);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["policy.Decided", "gen.Certified"],
  );
});

function generationRequest(overrides = {}) {
  return {
    requestId: "gen-hobo-360",
    subject: {
      kind: "agent",
      id: "spiffe://tenant-a/yard/gen-agent",
    },
    action: "gen.certify",
    environment: "prod",
    requestedRiskClass: "high",
    target: {
      kind: "provider-plugin",
      id: "@acme/provider-payments",
      trustClass: "high-trust",
      destructive: true,
    },
    evidence: {
      actualRiskClass: "high",
      riskReasons: ["prod-target", "destructive", "high-trust"],
    },
    reports: {
      provenance: { uri: "oci://registry.example/provenance/gen-hobo-360", digest: digest("1") },
      conformance: { uri: "oci://registry.example/conformance/gen-hobo-360", digest: digest("2") },
      safetyReport: { uri: "oci://registry.example/safety/gen-hobo-360", digest: digest("3") },
    },
    ts: "2026-06-28T02:50:00.000Z",
    ...overrides,
  };
}

function approvalDecision(overrides = {}) {
  return {
    hookId: "hook:gen-hobo-360:human-approval",
    resolution: "approved",
    approvedBy: "user:security-admin",
    actor: { kind: "user", id: "user:security-admin" },
    humanSignal: "reviewed provenance, conformance, and safety report",
    reportRefsShown: ["provenance", "conformance", "safetyReport"],
    ts: "2026-06-28T03:00:00.000Z",
    ...overrides,
  };
}

function digest(seed) {
  return `sha256:${seed.repeat(64)}`;
}

function assertGateError(fn, code) {
  assert.throws(fn, (error) => error instanceof HumanApprovalGateError && error.code === code);
}
