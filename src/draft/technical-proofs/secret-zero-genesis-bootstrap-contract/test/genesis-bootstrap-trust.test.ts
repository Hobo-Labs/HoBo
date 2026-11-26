import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  baseGenesisBootstrapTrace,
  validateGenesisBootstrapTrace
} from "../src/genesis-bootstrap-trust.js";

describe("secret-zero genesis bootstrap trust contract", () => {
  it("accepts a genesis trace where the durable root only exists inside target KMS", () => {
    const result = validateGenesisBootstrapTrace(baseGenesisBootstrapTrace());

    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.evidence, {
      rootKeyId: "yard-root-2026-06",
      rootKeyCustody: "target-kms",
      issuerUrl: "https://identity.acme-yard.example",
      issuerPinnedBeforeFederation: true,
      seedCredentialDestroyed: true,
      providerFederationEstablished: true,
      selfDeployPreservedRoot: true,
      rootMaterialSurfaces: []
    });
  });

  it("rejects a captured seed credential after self-deploy handoff", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace(),
      {
        seq: 80,
        type: "seed.signingAttempt",
        credentialId: "seed-bootstrap-1",
        audience: "sts"
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "captured-seed-credential-post-handoff");
  });

  it("rejects incomplete bootstrap traces that cannot prove handoff", () => {
    const result = validateGenesisBootstrapTrace([
      {
        seq: 10,
        type: "issuer.urlPinned",
        issuerUrl: "https://identity.acme-yard.example",
        discoveryFingerprint: "sha256:genesis-discovery"
      },
      {
        seq: 20,
        type: "kms.rootGenerated",
        keyId: "yard-root-2026-06",
        keyRole: "svid-oidc-root",
        custody: "target-kms",
        generatedBy: "target-kms",
        exportable: false
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "missing-seed-delegation");
    assertViolation(result, "missing-provider-federation");
    assertViolation(result, "missing-self-deploy");
    assertViolation(result, "missing-handoff-completion");
  });

  it("rejects root generation outside target KMS custody", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace().filter((event) => event.type !== "kms.rootGenerated"),
      {
        seq: 20,
        type: "kms.rootGenerated",
        keyId: "yard-root-2026-06",
        keyRole: "svid-oidc-root",
        custody: "seed-local-memory",
        generatedBy: "seed-yard",
        exportable: true
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "root-key-outside-target-kms");
  });

  it("rejects a seed credential that can act as the durable root", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace().filter((event) => event.type !== "seed.credentialIssued"),
      {
        seq: 30,
        type: "seed.credentialIssued",
        credentialId: "seed-bootstrap-1",
        delegated: false,
        durableRoot: true,
        canSignRoot: true
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "seed-holds-durable-root");
  });

  it("rejects a second issuer instance at the pinned URL", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace(),
      {
        seq: 80,
        type: "issuer.instanceCreated",
        issuerUrl: "https://identity.acme-yard.example",
        discoveryFingerprint: "rogue-discovery",
        rootKeyId: "attacker-root"
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "second-issuer-at-pinned-url");
  });

  it("rejects self-deploy attempts that regenerate or rotate the root", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace().filter((event) => event.type !== "yard.selfDeploy"),
      {
        seq: 50,
        type: "yard.selfDeploy",
        issuerUrl: "https://identity.acme-yard.example",
        rootKeyId: "fresh-root",
        regenerateRoot: true
      }
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "self-deploy-root-regeneration");
  });

  it("rejects a rogue OIDC discovery race before provider federation", () => {
    const result = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace().slice(0, 3),
      {
        seq: 35,
        type: "issuer.discoveryPublished",
        issuerUrl: "https://identity.acme-yard.example",
        discoveryFingerprint: "attacker-controlled-discovery",
        publisher: "attacker"
      },
      ...baseGenesisBootstrapTrace().slice(3)
    ]);

    assert.equal(result.ok, false);
    assertViolation(result, "rogue-issuer-discovery-before-federation");
  });

  it("rejects genesis steps that write root material to disk or logs", () => {
    const diskWrite = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace(),
      {
        seq: 80,
        type: "root.materialObserved",
        keyId: "yard-root-2026-06",
        surface: "disk",
        material: "PRIVATE KEY"
      }
    ]);
    const logWrite = validateGenesisBootstrapTrace([
      ...baseGenesisBootstrapTrace(),
      {
        seq: 81,
        type: "audit.logWritten",
        message: "generated root key",
        keyId: "yard-root-2026-06",
        rootPrivateKeyMaterial: "PRIVATE KEY"
      }
    ]);

    assert.equal(diskWrite.ok, false);
    assertViolation(diskWrite, "root-key-material-leaked");
    assert.equal(logWrite.ok, false);
    assertViolation(logWrite, "root-key-material-leaked");
  });
});

function assertViolation(result, code) {
  assert.ok(
    result.violations.some((violation) => violation.code === code),
    `expected violation ${code}; got ${JSON.stringify(result.violations)}`
  );
}
