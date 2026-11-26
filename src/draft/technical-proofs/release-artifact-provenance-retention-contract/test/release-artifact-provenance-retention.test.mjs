import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RELEASE_ARTIFACT_PROVENANCE_RETENTION,
  REQUIRED_ARTIFACT_CLASSES,
  REQUIRED_HANDOFF_FIELDS,
  REQUIRED_OWNER_LANES,
  classifyGapDisposition,
  evaluateArtifactHandoffReadiness,
  validateReleaseArtifactProvenanceRetention,
} from "../src/release-artifact-provenance-retention.mjs";

test("HOBO-504 record defines required artifact classes and handoff fields", () => {
  const result = validateReleaseArtifactProvenanceRetention(RELEASE_ARTIFACT_PROVENANCE_RETENTION);

  assert.deepEqual(result.errors, []);
  assert.equal(RELEASE_ARTIFACT_PROVENANCE_RETENTION.issue, "HOBO-504");
  assert.equal(RELEASE_ARTIFACT_PROVENANCE_RETENTION.phase, "M0");
  assert.deepEqual(REQUIRED_ARTIFACT_CLASSES, [
    "saas-release",
    "self-host-offline-bundle",
    "cli-release",
    "package-release",
    "registry-listing",
    "generated-provider-artifact",
    "customer-assurance-packet",
  ]);
  assert.deepEqual(REQUIRED_HANDOFF_FIELDS, [
    "provenanceSource",
    "retentionPeriod",
    "invalidationAndYank",
    "offlineBundleExpectation",
    "supportDebugAccess",
  ]);
});

test("handoff links release engineering, artifact store, package cache, registry, compliance, and support", () => {
  assert.deepEqual(REQUIRED_OWNER_LANES, [
    "release-engineering",
    "artifact-store",
    "package-cache",
    "registry",
    "compliance",
    "support",
  ]);
  assert.deepEqual(
    RELEASE_ARTIFACT_PROVENANCE_RETENTION.handoffOwnerLinks.map((item) => item.lane),
    REQUIRED_OWNER_LANES,
  );

  for (const link of RELEASE_ARTIFACT_PROVENANCE_RETENTION.handoffOwnerLinks) {
    assert.ok(link.ownerProject, `${link.lane} missing ownerProject`);
    assert.ok(link.handoffResponsibility, `${link.lane} missing handoffResponsibility`);
    assert.ok(link.sourceOfTruth, `${link.lane} missing sourceOfTruth`);
  }
});

test("known gaps are classified as beta limitation, GA blocker, or post-GA follow-up", () => {
  assert.deepEqual(classifyGapDisposition(RELEASE_ARTIFACT_PROVENANCE_RETENTION), {
    "beta-limitation": ["manual-provenance-review"],
    "ga-blocker": ["unretained-yank-evidence"],
    "post-ga-follow-up": ["automated-customer-assurance-export"],
  });
});

test("artifact readiness requires retained provenance, invalidation, offline, and support evidence", () => {
  const artifact = RELEASE_ARTIFACT_PROVENANCE_RETENTION.artifactClasses.find(
    (item) => item.id === "self-host-offline-bundle",
  );

  assert.deepEqual(evaluateArtifactHandoffReadiness(artifact), {
    ok: true,
    errors: [],
  });
  assert.equal(
    evaluateArtifactHandoffReadiness({
      ...artifact,
      retentionPeriod: "",
      supportDebugAccess: "",
    }).ok,
    false,
  );
});

test("validation rejects artifact-store implementation scope creep and unclassified gaps", () => {
  const invalid = structuredClone(RELEASE_ARTIFACT_PROVENANCE_RETENTION);
  invalid.scopeIn.push("Implement the artifact store and wire production blob retention.");
  invalid.knownGaps.push({
    id: "unknown-retention-gap",
    disposition: "accepted-risk",
    ownerLane: "support",
    customerImpact: "Gap is accepted without release cutline review.",
  });
  invalid.artifactClasses[0] = {
    ...invalid.artifactClasses[0],
    offlineBundleExpectation: "",
  };

  const result = validateReleaseArtifactProvenanceRetention(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /artifact store implementation is scope-out/);
  assert.match(result.errors.join("\n"), /unknown-retention-gap disposition/);
  assert.match(result.errors.join("\n"), /saas-release missing offlineBundleExpectation/);
});
