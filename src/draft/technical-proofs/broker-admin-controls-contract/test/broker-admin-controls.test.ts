import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  BROKER_ADMIN_CONTROLS_CONTRACT,
  applyBrokerAdminAction,
  classifyBrokerAdminControlWork,
  createInitialBrokerAdminState,
  mutableBrokerAdminControlsContract,
  validateBrokerAdminControlsContract,
} from "../src/broker-admin-controls.ts";

test("admin proposal and approval fixtures produce auditable environment transitions", () => {
  const state = createInitialBrokerAdminState();

  const proposed = applyBrokerAdminAction(state, {
    kind: "propose-environment",
    actorId: "broker-admin-alice",
    targetEnvironmentId: "broker-env-prod",
    proposalId: "proposal-prod-2026-06-30",
    auditEvidenceId: "audit-proposal-1",
    requestedChanges: ["allow-provider:azure-eastus", "catalog-snapshot:2026-06-30"],
  });

  assert.equal(proposed.accepted, true);
  assert.equal(proposed.event.type, "BrokerEnvironmentProposalRecorded");
  assert.equal(proposed.nextState.environmentSnapshots.length, 0);
  assert.equal(proposed.nextState.pendingProposals.length, 1);
  assert.deepEqual(proposed.event.auditEvidenceIds, ["audit-proposal-1"]);

  const approved = applyBrokerAdminAction(proposed.nextState, {
    kind: "approve-environment",
    actorId: "broker-admin-bob",
    targetEnvironmentId: "broker-env-prod",
    proposalId: "proposal-prod-2026-06-30",
    auditEvidenceId: "audit-approval-1",
    reviewerEvidenceIds: ["security-review-1", "support-boundary-1"],
  });

  assert.equal(approved.accepted, true);
  assert.equal(approved.event.type, "BrokerEnvironmentSnapshotApproved");
  assert.equal(approved.nextState.pendingProposals.length, 0);
  assert.deepEqual(approved.nextState.environmentSnapshots, [
    {
      id: "broker-env-prod",
      version: 1,
      sourceProposalId: "proposal-prod-2026-06-30",
      approvedBy: "broker-admin-bob",
      auditEvidenceIds: ["audit-proposal-1", "audit-approval-1", "security-review-1", "support-boundary-1"],
      state: "approved",
    },
  ]);
});

test("admin controls cannot mutate issued Resolution Receipts", () => {
  const state = createInitialBrokerAdminState({
    issuedReceiptRefs: [
      {
        receiptId: "receipt-123",
        environmentId: "broker-env-prod",
        environmentVersion: 1,
        digest: "sha256:receipt123",
        immutable: true,
      },
    ],
  });

  const result = applyBrokerAdminAction(state, {
    kind: "mutate-receipt",
    actorId: "broker-admin-alice",
    targetEnvironmentId: "broker-env-prod",
    receiptId: "receipt-123",
    auditEvidenceId: "audit-mutate-1",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "admin-controls-cannot-mutate-issued-receipts");
  assert.deepEqual(result.nextState.issuedReceiptRefs, state.issuedReceiptRefs);
});

test("admin revocation creates a new audited environment snapshot without touching receipts", () => {
  const state = createInitialBrokerAdminState({
    environmentSnapshots: [
      {
        id: "broker-env-prod",
        version: 1,
        sourceProposalId: "proposal-prod-2026-06-30",
        approvedBy: "broker-admin-bob",
        auditEvidenceIds: ["audit-proposal-1", "audit-approval-1"],
        state: "approved",
      },
    ],
    issuedReceiptRefs: [
      {
        receiptId: "receipt-123",
        environmentId: "broker-env-prod",
        environmentVersion: 1,
        digest: "sha256:receipt123",
        immutable: true,
      },
    ],
  });

  const result = applyBrokerAdminAction(state, {
    kind: "revoke-environment",
    actorId: "broker-admin-cara",
    targetEnvironmentId: "broker-env-prod",
    auditEvidenceId: "audit-revoke-1",
    reviewerEvidenceIds: ["security-review-2", "support-boundary-2"],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event.type, "BrokerEnvironmentSnapshotRevoked");
  assert.deepEqual(result.nextState.issuedReceiptRefs, state.issuedReceiptRefs);
  assert.deepEqual(result.nextState.environmentSnapshots.at(-1), {
    id: "broker-env-prod",
    version: 2,
    sourceProposalId: "proposal-prod-2026-06-30",
    approvedBy: "broker-admin-cara",
    auditEvidenceIds: ["audit-revoke-1", "security-review-2", "support-boundary-2"],
    state: "revoked",
  });
});

test("unsupported and unauthorized admin actions fail closed", () => {
  const state = createInitialBrokerAdminState();

  assert.deepEqual(
    applyBrokerAdminAction(state, {
      kind: "approve-environment",
      actorId: "support-operator-cara",
      targetEnvironmentId: "broker-env-prod",
      proposalId: "missing-proposal",
      auditEvidenceId: "audit-approval-1",
      reviewerEvidenceIds: ["security-review-1"],
    }),
    {
      accepted: false,
      reason: "actor-not-authorized-for-admin-approval",
      nextState: state,
    },
  );

  assert.equal(
    applyBrokerAdminAction(state, {
      kind: "run-hosted-broker-runtime",
      actorId: "broker-admin-alice",
      targetEnvironmentId: "broker-env-prod",
      auditEvidenceId: "audit-runtime-1",
    }).reason,
    "unsupported-admin-action",
  );
});

test("malformed and cross-environment approval requests fail closed", () => {
  const state = createInitialBrokerAdminState();

  const malformed = applyBrokerAdminAction(state, {
    kind: "propose-environment",
    actorId: "broker-admin-alice",
    targetEnvironmentId: "broker-env-prod",
    auditEvidenceId: "audit-proposal-1",
  });

  assert.equal(malformed.accepted, false);
  assert.equal(malformed.reason, "malformed-admin-action");
  assert.deepEqual(malformed.nextState, state);

  const proposed = applyBrokerAdminAction(state, {
    kind: "propose-environment",
    actorId: "broker-admin-alice",
    targetEnvironmentId: "broker-env-staging",
    proposalId: "proposal-staging-2026-07-01",
    auditEvidenceId: "audit-proposal-1",
    requestedChanges: ["allow-provider:azure-eastus"],
  });

  assert.equal(proposed.accepted, true);
  const mismatch = applyBrokerAdminAction(proposed.nextState, {
    kind: "approve-environment",
    actorId: "broker-admin-bob",
    targetEnvironmentId: "broker-env-prod",
    proposalId: "proposal-staging-2026-07-01",
    auditEvidenceId: "audit-approval-1",
  });

  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.reason, "proposal-environment-mismatch");
  assert.deepEqual(mismatch.nextState, proposed.nextState);
});

test("adversarial cases reject self-approval and approval without audit evidence", () => {
  const proposed = applyBrokerAdminAction(createInitialBrokerAdminState(), {
    kind: "propose-environment",
    actorId: "broker-admin-alice",
    targetEnvironmentId: "broker-env-prod",
    proposalId: "proposal-prod-2026-06-30",
    auditEvidenceId: "audit-proposal-1",
    requestedChanges: ["allow-provider:azure-eastus"],
  }).nextState;

  assert.equal(
    applyBrokerAdminAction(proposed, {
      kind: "approve-environment",
      actorId: "broker-admin-alice",
      targetEnvironmentId: "broker-env-prod",
      proposalId: "proposal-prod-2026-06-30",
      auditEvidenceId: "audit-approval-1",
      reviewerEvidenceIds: ["security-review-1"],
    }).reason,
    "self-approval-rejected",
  );

  assert.equal(
    applyBrokerAdminAction(proposed, {
      kind: "approve-environment",
      actorId: "broker-admin-bob",
      targetEnvironmentId: "broker-env-prod",
      proposalId: "proposal-prod-2026-06-30",
      auditEvidenceId: "",
      reviewerEvidenceIds: [],
    }).reason,
    "approval-requires-audit-evidence",
  );
});

test("contract record maps support/security boundaries and rejects scope creep", () => {
  assert.deepEqual(validateBrokerAdminControlsContract(BROKER_ADMIN_CONTROLS_CONTRACT).errors, []);
  assert.deepEqual(
    BROKER_ADMIN_CONTROLS_CONTRACT.operatingBoundaries.map((boundary) => boundary.owner),
    ["Admin Console", "Meta-cloud Broker", "Contracts, Policy & Governance", "Support Workflow"],
  );

  const invalid = mutableBrokerAdminControlsContract();
  invalid.scopeIn.push("Build full admin console navigation and hosted broker runtime controls.");

  const result = validateBrokerAdminControlsContract(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /admin console navigation/i);
  assert.match(result.errors.join("\n"), /hosted broker runtime/i);
});

test("work classifier keeps full UI and hosted runtime work outside this POC", () => {
  assert.deepEqual(classifyBrokerAdminControlWork("record broker environment approval fixture"), {
    owner: "Broker Admin Controls Contract",
    inScope: true,
  });
  assert.deepEqual(classifyBrokerAdminControlWork("build full admin console navigation"), {
    owner: "Admin Console",
    inScope: false,
  });
  assert.deepEqual(classifyBrokerAdminControlWork("run hosted broker runtime resolver"), {
    owner: "Meta-cloud Broker Runtime",
    inScope: false,
  });
});

test("architecture artifacts pin protobuf, CUE, Pact, and event-store boundaries", () => {
  const architecture = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8");
  const proto = readFileSync(new URL("../architecture/broker_admin_controls.proto", import.meta.url), "utf8");
  const cue = readFileSync(new URL("../architecture/broker_admin_controls.cue", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/broker_admin_controls.pact.json", import.meta.url),
      "utf8",
    ),
  );

  for (const typeName of [
    "BrokerEnvironmentProposal",
    "BrokerEnvironmentSnapshot",
    "ResolutionReceiptRef",
    "BrokerAdminAction",
    "BrokerAdminEvent",
  ]) {
    assert.match(proto, new RegExp(`message ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.equal(pact.consumer.name, "AdminConsoleBrokerControls");
  assert.equal(pact.provider.name, "MetaCloudBrokerAdminBoundary");
  assert.ok(pact.interactions.length >= 3);
  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Event/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /read store/i);
});
