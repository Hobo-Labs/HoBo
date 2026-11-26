import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { test } from "vitest";

import {
  bindFirstRealRole,
  createOfflineBreakGlassCredential,
  createYardGovernanceLedger,
  diagnoseGenesisAdmin,
  recoverWithBreakGlass,
  rotateGenesisAdmin,
  seedGenesisAdmin,
  selfGrantOrgAdmin,
} from "../src/genesis-breakglass.js";

test("yard genesis emits exactly one auditable Org-Admin fact and role binding", () => {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });

  const result = seedGenesisAdmin(ledger, {
    principalId: "user:founder",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
    evidence: {
      source: "hobo yard up",
      targetKmsKey: "kms:prod/svid-root",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(ledger.currentOrgAdmins().length, 1);
  assert.deepEqual(ledger.currentOrgAdmins(), ["user:founder"]);
  assert.equal(result.events.at(0).type, "identity.GenesisAdmin");
  assert.equal(result.events.at(1).type, "role.BindingCreated");
  assert.equal(result.events.at(0).data.oneTime, true);
  assert.equal(result.events.at(1).data.role, "Org-Admin");
  assert.equal(result.events.at(0).actor, "system:yard-bootstrap");
  assert.match(result.events.at(0).auditHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.events.at(1).auditHash, /^sha256:[a-f0-9]{64}$/);
});

test("genesis seeding is one-time and replay cannot mint a second Org-Admin", () => {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });
  seedGenesisAdmin(ledger, {
    principalId: "user:founder",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  const replay = seedGenesisAdmin(ledger, {
    principalId: "user:attacker",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  assert.equal(replay.ok, false);
  assert.equal(replay.code, "GENESIS_ALREADY_CONSUMED");
  assert.deepEqual(ledger.currentOrgAdmins(), ["user:founder"]);
  assert.equal(ledger.events.filter((event) => event.type === "identity.GenesisAdmin").length, 1);
});

test("genesis admin can rotate immediately while retaining an audit trail", () => {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });
  seedGenesisAdmin(ledger, {
    principalId: "user:bootstrap-admin",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  const rotation = rotateGenesisAdmin(ledger, {
    fromPrincipalId: "user:bootstrap-admin",
    toPrincipalId: "user:platform-admin",
    actorId: "user:bootstrap-admin",
    requestId: "rotate-001",
  });

  assert.equal(rotation.ok, true);
  assert.deepEqual(ledger.currentOrgAdmins(), ["user:platform-admin"]);
  assert.equal(rotation.events.at(0).type, "identity.GenesisAdminRotated");
  assert.equal(rotation.events.at(1).type, "role.BindingRevoked");
  assert.equal(rotation.events.at(2).type, "role.BindingCreated");
  assert.equal(rotation.events.at(0).data.from, "user:bootstrap-admin");
  assert.equal(rotation.events.at(0).data.to, "user:platform-admin");
  assert.deepEqual(ledger.roleBindings(), [
    {
      principalId: "user:platform-admin",
      role: "Org-Admin",
      source: "genesis-rotation",
    },
  ]);
});

test("genesis admin can bind the first real role before normal RBAC is bootstrapped", () => {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });
  seedGenesisAdmin(ledger, {
    principalId: "user:bootstrap-admin",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  const firstBinding = bindFirstRealRole(ledger, {
    actorId: "user:bootstrap-admin",
    targetPrincipalId: "group:platform-admins",
    role: "Org-Admin",
    requestId: "first-role-001",
  });
  const attackerBinding = bindFirstRealRole(ledger, {
    actorId: "user:attacker",
    targetPrincipalId: "group:attacker-admins",
    role: "Org-Admin",
    requestId: "first-role-002",
  });

  assert.equal(firstBinding.ok, true);
  assert.equal(firstBinding.events.at(0).type, "role.BindingCreated");
  assert.equal(firstBinding.events.at(0).data.source, "genesis-first-role");
  assert.equal(firstBinding.events.at(0).data.bootstrapAuthority, "identity.GenesisAdmin");
  assert.match(firstBinding.events.at(0).auditHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(ledger.roleBindings(), [
    {
      principalId: "group:platform-admins",
      role: "Org-Admin",
      source: "genesis-first-role",
    },
  ]);
  assert.equal(attackerBinding.ok, false);
  assert.equal(attackerBinding.code, "GENESIS_ADMIN_REQUIRED");
});

test("hobo doctor flags an unrotated genesis admin and clears after rotation", () => {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });

  assert.deepEqual(diagnoseGenesisAdmin(ledger), []);

  seedGenesisAdmin(ledger, {
    principalId: "user:bootstrap-admin",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  assert.deepEqual(diagnoseGenesisAdmin(ledger), [
    {
      code: "GENESIS_ADMIN_NOT_ROTATED",
      severity: "warning",
      principalId: "user:bootstrap-admin",
      message: "Genesis Org-Admin remains active; rotate it to a durable admin binding.",
    },
  ]);

  rotateGenesisAdmin(ledger, {
    fromPrincipalId: "user:bootstrap-admin",
    toPrincipalId: "user:platform-admin",
    actorId: "user:bootstrap-admin",
    requestId: "rotate-001",
  });

  assert.deepEqual(diagnoseGenesisAdmin(ledger), []);

  const staleBootstrapBinding = bindFirstRealRole(ledger, {
    actorId: "user:bootstrap-admin",
    targetPrincipalId: "group:late-admins",
    role: "Org-Admin",
    requestId: "first-role-after-rotation",
  });

  assert.equal(staleBootstrapBinding.ok, false);
  assert.equal(staleBootstrapBinding.code, "GENESIS_ADMIN_REQUIRED");
});

test("offline-signed break-glass recovers when IdP and mandatory policy block normal changes", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ledger = createYardGovernanceLedger({
    yardId: "yard:prod",
    offlinePublicKeys: {
      "breakglass-key-1": publicKey,
    },
  });
  seedGenesisAdmin(ledger, {
    principalId: "user:founder",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });

  const credential = createOfflineBreakGlassCredential({
    keyId: "breakglass-key-1",
    privateKey,
    subjectId: "user:security-admin",
    action: "hobo:policy-pack:update",
    resourceId: "policy-pack:prod-mandatory",
    reason: "recover from bricking mandatory rule while IdP is unavailable",
    nonce: "nonce-001",
  });

  const recovery = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-001",
  });

  assert.equal(recovery.ok, true);
  assert.equal(recovery.decision.effect, "allow");
  assert.equal(recovery.decision.reason, "offline break-glass authorized recovery");
  assert.equal(recovery.events.at(0).type, "policy.Decided");
  assert.equal(recovery.events.at(1).type, "identity.BreakGlassUsed");
  assert.equal(recovery.events.at(1).data.offlineSigned, true);
  assert.equal(recovery.events.at(1).data.idpPath, false);
  assert.equal(recovery.events.at(1).data.signatureFingerprint, fingerprint(credential.signature));
});

test("normal IdP path and self-grant cannot recover a bricked mandatory rule", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const ledger = createYardGovernanceLedger({
    yardId: "yard:prod",
    offlinePublicKeys: {
      "breakglass-key-1": publicKey,
    },
  });

  const normalRecovery = recoverWithBreakGlass(ledger, {
    credential: {
      keyId: "breakglass-key-1",
      subjectId: "user:security-admin",
      action: "hobo:policy-pack:update",
      resourceId: "policy-pack:prod-mandatory",
      reason: "normal idp token",
      nonce: "nonce-002",
      idpPath: true,
      signature: "not-offline-signed",
    },
    idpAvailable: true,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-002",
  });

  const selfGrant = selfGrantOrgAdmin(ledger, {
    actorId: "user:locked-out-admin",
    targetPrincipalId: "user:locked-out-admin",
    requestId: "self-grant-001",
  });

  assert.equal(normalRecovery.ok, false);
  assert.equal(normalRecovery.code, "OFFLINE_SIGNATURE_REQUIRED");
  assert.equal(selfGrant.ok, false);
  assert.equal(selfGrant.code, "SELF_GRANT_BLOCKED");
  assert.equal(ledger.events.some((event) => event.type === "identity.BreakGlassUsed"), false);
});

test("offline-signed break-glass is denied unless both emergency predicates hold", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ledger = createYardGovernanceLedger({
    yardId: "yard:prod",
    offlinePublicKeys: {
      "breakglass-key-1": publicKey,
    },
  });
  const credential = createOfflineBreakGlassCredential({
    keyId: "breakglass-key-1",
    privateKey,
    subjectId: "user:security-admin",
    action: "hobo:policy-pack:update",
    resourceId: "policy-pack:prod-mandatory",
    reason: "recover bricked policy",
    nonce: "nonce-005",
  });

  const idpStillAvailable = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: true,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-005-idp-available",
  });
  const policyStillMutable = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: false,
    requestId: "breakglass-005-policy-mutable",
  });
  const actualEmergency = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-005",
  });

  assert.equal(idpStillAvailable.ok, false);
  assert.equal(idpStillAvailable.code, "BREAK_GLASS_CONTEXT_NOT_BRICKED");
  assert.equal(policyStillMutable.ok, false);
  assert.equal(policyStillMutable.code, "BREAK_GLASS_CONTEXT_NOT_BRICKED");
  assert.equal(actualEmergency.ok, true);
  assert.equal(ledger.events.filter((event) => event.type === "identity.BreakGlassUsed").length, 1);
});

test("tampered offline break-glass credentials fail closed before recovery", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ledger = createYardGovernanceLedger({
    yardId: "yard:prod",
    offlinePublicKeys: {
      "breakglass-key-1": publicKey,
    },
  });
  const credential = createOfflineBreakGlassCredential({
    keyId: "breakglass-key-1",
    privateKey,
    subjectId: "user:security-admin",
    action: "hobo:policy-pack:update",
    resourceId: "policy-pack:prod-mandatory",
    reason: "recover bricked policy",
    nonce: "nonce-004",
  });

  const recovery = recoverWithBreakGlass(ledger, {
    credential: {
      ...credential,
      resourceId: "policy-pack:attacker-target",
    },
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-004",
  });

  assert.equal(recovery.ok, false);
  assert.equal(recovery.code, "INVALID_BREAK_GLASS_SIGNATURE");
  assert.equal(ledger.events.some((event) => event.type === "identity.BreakGlassUsed"), false);
});

test("break-glass signature replay is rejected and successful use is never silent", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ledger = createYardGovernanceLedger({
    yardId: "yard:prod",
    offlinePublicKeys: {
      "breakglass-key-1": publicKey,
    },
  });
  const credential = createOfflineBreakGlassCredential({
    keyId: "breakglass-key-1",
    privateKey,
    subjectId: "user:security-admin",
    action: "hobo:policy-pack:update",
    resourceId: "policy-pack:prod-mandatory",
    reason: "recover bricked policy",
    nonce: "nonce-003",
  });

  const first = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-003",
  });
  const replay = recoverWithBreakGlass(ledger, {
    credential,
    idpAvailable: false,
    mandatoryPolicyBlocksAllChanges: true,
    requestId: "breakglass-003-replay",
  });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "BREAK_GLASS_REPLAY");
  assert.equal(first.events.every((event) => event.auditHash), true);
  assert.equal(first.events.some((event) => event.type === "identity.BreakGlassUsed"), true);
});

function fingerprint(signature) {
  return `sha256:${createHash("sha256").update(signature, "base64").digest("hex")}`;
}
