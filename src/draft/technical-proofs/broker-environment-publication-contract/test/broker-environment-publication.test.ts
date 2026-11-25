import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  buildFixturePublication,
  createResolutionProofInput,
  publishBrokerEnvironmentSnapshot,
  validateArchitectureEvidence,
} from "../src/broker-environment-publication.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("approved provider, catalog, and mapping publications become a Broker Environment snapshot", () => {
  const publication = buildFixturePublication();
  const result = publishBrokerEnvironmentSnapshot(publication);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.snapshot.schema, "hobo.broker-environment-snapshot/v1");
  assert.equal(result.snapshot.sourceIssue, "HOBO-526");
  assert.equal(result.snapshot.provider.providerId, "aws");
  assert.equal(result.snapshot.provider.manifestDigest, publication.providerCapability.manifestDigest);
  assert.equal(result.snapshot.mapping.mappingDigest, publication.mapping.mappingDigest);
  assert.equal(result.snapshot.approval.approvalId, publication.approval.approvalId);
  assert.equal(result.snapshot.version.publicationVersion, "2026-06-30.m2");
  assert.match(result.snapshot.provenance.digest, /^sha256:/);
  assert.equal(result.snapshot.providerDefaults[0].role, "broker-validation-input");
  assert.equal(Object.hasOwn(result.snapshot, "yardDecision"), false);
});

test("unapproved, stale, and incompatible publications fail closed", () => {
  const unapproved = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({ approval: { decision: "pending" } }),
  );
  const stale = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({
      catalog: { staleAfter: "2026-06-01T00:00:00Z" },
      asOf: "2026-06-30T00:00:00Z",
    }),
  );
  const incompatible = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({ mapping: { compatibility: "incompatible" } }),
  );

  assert.equal(unapproved.ok, false);
  assert.match(unapproved.errors.join("\n"), /approval decision must be approved/);
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join("\n"), /catalog snapshot is stale/);
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.errors.join("\n"), /mapping compatibility must be compatible/);
});

test("non-object and non-cloneable publications fail closed", () => {
  const missing = publishBrokerEnvironmentSnapshot(undefined);
  const nonCloneable = publishBrokerEnvironmentSnapshot({
    providerCapability: () => undefined,
  });

  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /publication must be an object/);
  assert.equal(nonCloneable.ok, false);
  assert.match(nonCloneable.errors.join("\n"), /publication must be cloneable/);
});

test("malicious provider claims that skip conformance or approval are rejected", () => {
  const missingConformance = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({
      providerCapability: { conformanceDigest: "" },
    }),
  );
  const uncoveredCapability = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({
      providerCapability: {
        capabilities: [
          { type: "database", features: ["postgres", "managed", "ha"] },
          { type: "queue", features: ["durable"] },
        ],
      },
    }),
  );
  const missingApprovalEvidence = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({ approval: { evidenceDigest: "" } }),
  );

  assert.equal(missingConformance.ok, false);
  assert.match(missingConformance.errors.join("\n"), /conformanceDigest must be a sha256 digest/);
  assert.equal(uncoveredCapability.ok, false);
  assert.match(uncoveredCapability.errors.join("\n"), /capability queue lacks conformance coverage/);
  assert.equal(missingApprovalEvidence.ok, false);
  assert.match(missingApprovalEvidence.errors.join("\n"), /approval evidenceDigest must be a sha256 digest/);
});

test("snapshot identity is immutable and shadow updates must create a new snapshot", () => {
  const first = publishBrokerEnvironmentSnapshot(buildFixturePublication());
  assert.equal(first.ok, true, first.errors.join("\n"));

  const shadow = publishBrokerEnvironmentSnapshot(
    buildFixturePublication({
      mapping: { providerResourceClass: "rds-single-az-postgres" },
      expectedSnapshotId: first.snapshot.snapshotId,
    }),
  );

  assert.equal(shadow.ok, false);
  assert.match(shadow.errors.join("\n"), /shadow update changed snapshot content without a new snapshot identity/);
});

test("Broker Environment snapshots are immutable inputs to resolution proof", () => {
  const result = publishBrokerEnvironmentSnapshot(buildFixturePublication());
  assert.equal(result.ok, true, result.errors.join("\n"));

  const proofInput = createResolutionProofInput(result.snapshot);

  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.mapping), true);
  assert.equal(proofInput.authority, "meta-cloud-broker");
  assert.equal(proofInput.environmentSnapshotId, result.snapshot.snapshotId);
  assert.deepEqual(proofInput.allowedProviderDefaults, ["aws.default.database"]);
  assert.equal(Object.hasOwn(proofInput, "finalYardDecision"), false);
});

test("architecture evidence names protobuf, CUE, PACT, parsed types, and event boundary", async () => {
  const architecture = await readFile(path.join(packageRoot, "ARCHITECTURE.md"), "utf8");
  const proto = await readFile(
    path.join(packageRoot, "architecture", "broker_environment_publication.proto"),
    "utf8",
  );
  const cue = await readFile(
    path.join(packageRoot, "architecture", "broker_environment_publication.cue"),
    "utf8",
  );
  const pact = JSON.parse(
    await readFile(
      path.join(packageRoot, "architecture", "pacts", "broker_environment_publication.pact.json"),
      "utf8",
    ),
  );

  assert.deepEqual(validateArchitectureEvidence({ architecture, proto, cue, pact }), []);
});
