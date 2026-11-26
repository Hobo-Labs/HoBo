import assert from "node:assert/strict";
import { test } from "vitest";

import { CONTRACT_BOUNDARIES, runIdentityReferenceSimulation } from "../services/identity-reference-architecture.js";

test("issues scoped workload SVID and exchanges provider token only after attestation", async () => {
  const result = await runIdentityReferenceSimulation();

  assert.equal(result.epic.slug, "identity-auth-secrets-cross-app-access-xaa");
  assert.equal(result.workloadCredential.status, "issued");
  assert.equal(result.workloadCredential.svid.subject, "spiffe://yard/tenant-a/bindle/orders-api/agent/deployer");
  assert.equal(result.workloadCredential.providerCredential.provider, "aws");
  assert.deepEqual(result.workloadCredential.providerCredential.scope, {
    port: "bucket",
    resource: "orders-archive",
    action: "write"
  });
  assert.equal(result.workloadCredential.denials.compromisedFork.ok, false);
  assert.equal(result.workloadCredential.denials.compromisedFork.reason, "attestation-derived-tenant-overrides-caller-claim");
  assert.equal(result.workloadCredential.rotation.partitionGraceRenewal.ok, true);
  assert.equal(result.workloadCredential.rotation.scopeWideningDuringPartition.ok, false);
  assert.equal(result.workloadCredential.staticKeyFallback.ok, false);
});

test("verifies ctx.user, enforces RBAC/session revocation, and resolves secretless config", async () => {
  const result = await runIdentityReferenceSimulation();

  assert.equal(result.auth.verified.ok, true);
  assert.equal(result.auth.verified.ctx.user.id, "user_alice");
  assert.deepEqual(result.auth.verified.ctx.user.roles, ["deployer"]);
  assert.equal(result.auth.verified.ctx.tenant.app, "tenant-a");
  assert.equal(result.auth.denials.wrongIssuer.ok, false);
  assert.equal(result.auth.denials.tamperedToken.ok, false);
  assert.equal(result.auth.sessionRevocation.nextRequest.ok, false);
  assert.equal(result.secretless.resolved.databaseUrl.ref, "secretref://tenant-a/orders/database-url");
  assert.equal(result.secretless.noPlaintextLeaks, true);
  assert.equal(result.secretless.staticKeyExpired.ok, false);
});

test("governs outbound and inbound XAA with inferred scope, delegation, and replay guards", async () => {
  const result = await runIdentityReferenceSimulation();

  assert.equal(result.xaa.outbound.status, "granted");
  assert.equal(result.xaa.outbound.idJag.audience, "asana");
  assert.deepEqual(result.xaa.outbound.idJag.scope, ["tasks:write"]);
  assert.equal(result.xaa.inbound.status, "accepted");
  assert.equal(result.xaa.inbound.ctx.user.id, "user_alice");
  assert.equal(result.xaa.denials.confusedDeputy.ok, false);
  assert.equal(result.xaa.denials.scopeWidening.ok, false);
  assert.equal(result.xaa.denials.replay.ok, false);
  assert.equal(result.xaa.auditChain, "user_alice->agent_scheduler->asana");
});

test("keeps governance controls bounded and exports redacted OCSF evidence", async () => {
  const result = await runIdentityReferenceSimulation();

  assert.equal(result.governance.genesis.rootCustody, "target-kms");
  assert.equal(result.governance.genesis.seedSigningAfterHandoff.ok, false);
  assert.equal(result.governance.breakGlass.status, "audited-emergency-override");
  assert.equal(result.governance.mtls.peerAuthenticated, true);
  assert.equal(result.governance.relayAttach.status, "accepted");
  assert.equal(result.governance.ocsf.records.length >= 4, true);
  assert.equal(result.governance.ocsf.containsPlaintextSecrets, false);
  assert.deepEqual(result.liveNetworkCalls, []);
});

test("covers every declared service boundary with a contract decision", async () => {
  const result = await runIdentityReferenceSimulation();

  assert.equal(CONTRACT_BOUNDARIES.length, 12);
  assert.deepEqual(
    [...result.contracts.covered].sort(),
    CONTRACT_BOUNDARIES.map((boundary) => boundary.provider).sort(),
  );
  assert.deepEqual(result.contracts.missing, []);
});
