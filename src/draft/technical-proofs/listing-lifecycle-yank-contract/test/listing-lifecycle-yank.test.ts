import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  LISTING_LIFECYCLE_YANK_CONTRACT,
  createListingLifecycle
} from "../src/listing-lifecycle-yank.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("authorized yank emits listing.Yanked and removes the listing from new selections", () => {
  const lifecycle = createListingLifecycle();
  lifecycle.certify(certifiedListing({ listingId: "listing-acme-blobstore-v1" }));

  const result = lifecycle.yank({
    listingId: "listing-acme-blobstore-v1",
    actor: publisherActor("spiffe://acme.example"),
    reason: "capability spec regression",
    severity: "high",
    occurredAt: "2026-06-26T12:00:00.000Z"
  });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.contract, LISTING_LIFECYCLE_YANK_CONTRACT);
  assert.equal(result.listing.status, "Yanked");
  assert.equal(result.event.type, "listing.Yanked");
  assert.equal(result.event.reason, "capability spec regression");
  assert.equal(result.event.severity, "high");
  assert.deepEqual(lifecycle.events().map((event) => event.type), [
    "listing.Certified",
    "listing.Yanked"
  ]);
  assert.deepEqual(lifecycle.discovery().map((listing) => listing.listingId), []);
});

test("can-deploy hard-fails when a new deployment selects a yanked listing", () => {
  const lifecycle = createListingLifecycle();
  lifecycle.certify(certifiedListing({ listingId: "listing-acme-blobstore-v1" }));
  lifecycle.yank({
    listingId: "listing-acme-blobstore-v1",
    actor: publisherActor("spiffe://acme.example"),
    reason: "CVE-2026-377",
    severity: "critical"
  });

  const decision = lifecycle.canDeploy({
    selection: { listingId: "listing-acme-blobstore-v1" },
    operation: "new-deploy"
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.decision, "hard-fail");
  assert.equal(decision.reason, "listing.yanked");
  assert.match(decision.remediation, /pick a non-yanked version/i);
  assert.equal(decision.evidence.listingId, "listing-acme-blobstore-v1");
  assert.equal(decision.evidence.severity, "critical");
});

test("hobo doctor flags running Sets pinned to a yanked listing without rewriting them", () => {
  const lifecycle = createListingLifecycle();
  const runningSet = {
    setId: "set-prod-payments",
    status: "Running",
    pinnedListings: [{ listingId: "listing-acme-blobstore-v1", role: "object-store" }],
    deploymentRevision: "deploy-17"
  };
  const originalSet = JSON.parse(JSON.stringify(runningSet));
  lifecycle.certify(certifiedListing({ listingId: "listing-acme-blobstore-v1" }));
  lifecycle.registerRunningSet(runningSet);

  lifecycle.yank({
    listingId: "listing-acme-blobstore-v1",
    actor: publisherActor("spiffe://acme.example"),
    reason: "broken storage adapter",
    severity: "high"
  });

  const doctor = lifecycle.doctor();
  const pinned = lifecycle.resolvePinnedListing({
    setId: "set-prod-payments",
    listingId: "listing-acme-blobstore-v1"
  });

  assert.deepEqual(runningSet, originalSet);
  assert.equal(doctor.ok, false);
  assert.deepEqual(doctor.findings.map((finding) => finding.type), ["listing.yanked.pinned-set"]);
  assert.equal(doctor.findings[0].setId, "set-prod-payments");
  assert.equal(doctor.findings[0].incidentClass, "security-response");
  assert.match(doctor.findings[0].remediation, /migrate/i);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.flagged, true);
  assert.equal(pinned.listing.status, "Yanked");
});

test("critical yanks raise remediation obligations while low yanks can suppress auto-page", () => {
  const lifecycle = createListingLifecycle();
  lifecycle.certify(certifiedListing({ listingId: "listing-critical" }));
  lifecycle.certify(certifiedListing({ listingId: "listing-low", digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }));

  const critical = lifecycle.yank({
    listingId: "listing-critical",
    actor: yardSecurityAdmin(),
    reason: "actively exploited CVE",
    severity: "critical"
  });
  const low = lifecycle.yank({
    listingId: "listing-low",
    actor: yardSecurityAdmin(),
    reason: "documentation bug",
    severity: "low",
    policyOverride: { autoPage: false }
  });

  assert.equal(critical.remediationObligation.type, "policy.ObligationCreated");
  assert.equal(critical.remediationObligation.severity, "critical");
  assert.equal(critical.policy.autoPage, true);
  assert.equal(low.remediationObligation, null);
  assert.equal(low.policy.autoPage, false);
  assert.deepEqual(
    lifecycle.obligations().map((obligation) => obligation.listingId),
    ["listing-critical"]
  );
  assert.deepEqual(
    lifecycle.events().filter((event) => event.type === "policy.ObligationCreated").map((event) => event.listingId),
    ["listing-critical"]
  );
});

test("yank by an unauthorized identity is rejected without changing discovery", () => {
  const lifecycle = createListingLifecycle();
  lifecycle.certify(certifiedListing({ listingId: "listing-acme-blobstore-v1" }));

  const result = lifecycle.yank({
    listingId: "listing-acme-blobstore-v1",
    actor: { subject: "user:random", trustDomain: "spiffe://other.example", roles: ["deployer"] },
    reason: "malicious takedown",
    severity: "critical"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["actor.unauthorized"]);
  assert.deepEqual(lifecycle.events().map((event) => event.type), ["listing.Certified"]);
  assert.deepEqual(lifecycle.discovery().map((listing) => listing.listingId), [
    "listing-acme-blobstore-v1"
  ]);
  assert.deepEqual(lifecycle.obligations(), []);
});

test("re-certifying a fixed version does not un-yank the compromised listing", () => {
  const lifecycle = createListingLifecycle();
  lifecycle.certify(certifiedListing({ listingId: "listing-bad-v1", version: "1.0.0" }));
  lifecycle.registerRunningSet({
    setId: "set-prod-payments",
    status: "Running",
    pinnedListings: [{ listingId: "listing-bad-v1" }]
  });
  lifecycle.yank({
    listingId: "listing-bad-v1",
    actor: publisherActor("spiffe://acme.example"),
    reason: "regressed Capability Spec",
    severity: "critical"
  });

  lifecycle.certify(certifiedListing({
    listingId: "listing-fixed-v2",
    version: "1.0.1",
    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  }));

  assert.deepEqual(lifecycle.discovery().map((listing) => listing.listingId), ["listing-fixed-v2"]);
  assert.equal(lifecycle.canDeploy({ selection: { listingId: "listing-bad-v1" } }).ok, false);
  assert.equal(lifecycle.resolvePinnedListing({
    setId: "set-prod-payments",
    listingId: "listing-bad-v1"
  }).flagged, true);
  assert.deepEqual(
    lifecycle.events().filter((event) => event.type === "listing.Yanked").map((event) => event.listingId),
    ["listing-bad-v1"]
  );
});

test("schema-free type declarations publish the lifecycle yank surface", async () => {
  const declarations = await readFile(
    path.join(packageRoot, "src", "listing-lifecycle-yank.d.ts"),
    "utf8"
  );

  assert.match(declarations, /export interface ListingLifecycle/);
  assert.match(declarations, /listing\.Yanked/);
  assert.match(declarations, /canDeploy/);
  assert.match(declarations, /doctor/);
  assert.match(declarations, /policy\.ObligationCreated/);
});

function certifiedListing(overrides = {}) {
  return {
    listingId: overrides.listingId ?? "listing-acme-blobstore-v1",
    status: "Certified",
    kind: "provider",
    name: "@acme/blobstore-provider",
    version: overrides.version ?? "1.0.0",
    artifact: {
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      uri: `oci://registry.example/hobo/blobstore:${overrides.version ?? "1.0.0"}`,
      digest: overrides.digest ?? "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    },
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://acme.example"
    },
    certification: {
      status: "passed",
      reportRefs: ["oci://registry.example/reports/blobstore@sha256:2222"]
    }
  };
}

function publisherActor(trustDomain) {
  return {
    subject: "publisher:acme",
    trustDomain,
    roles: ["publisher"]
  };
}

function yardSecurityAdmin() {
  return {
    subject: "user:security-admin",
    roles: ["yard-security-policy-admin"]
  };
}
