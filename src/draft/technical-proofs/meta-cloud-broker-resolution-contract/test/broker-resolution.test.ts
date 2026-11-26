import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildAcceptedManifestFixture,
  buildAmbiguousEnvironmentFixture,
  buildBrokerEnvironmentFixture,
  buildIncompatibleEnvironmentFixture,
  buildUnavailableEnvironmentFixture,
  resolveBrokerManifest,
} from "../src/broker-resolution.ts";

test("same manifest plus same broker environment yields identical receipt output", () => {
  const manifest = buildAcceptedManifestFixture();
  const environment = buildBrokerEnvironmentFixture();
  const reorderedEnvironment = buildBrokerEnvironmentFixture({
    mappings: [...environment.mappings].reverse(),
    catalog: [...environment.catalog].reverse(),
  });

  const first = resolveBrokerManifest({ manifest, environment });
  const second = resolveBrokerManifest({ manifest, environment: reorderedEnvironment });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second, first);
  assert.equal(first.receipt.schema, "hobo.resolution-receipt/v1");
  assert.equal(first.receipt.resolutionAuthority, "meta-cloud-broker");
  assert.equal(first.receipt.manifestDigest, "sha256:manifest-orders-prod");
  assert.equal(first.receipt.environmentDigest, "sha256:broker-env-prod");
  assert.equal(first.receipt.catalogSnapshotDigest, "sha256:catalog-prod");
  assert.deepEqual(
    first.receipt.resourcePlans.map((plan) => [plan.resourceId, plan.provider, plan.capabilityId]),
    [
      ["orders-db", "provider.aws", "aws.postgres.ha"],
      ["orders-cache", "provider.cloudflare", "cloudflare.kv.edge"],
    ],
  );
  assert.match(first.receipt.signature, /^signed:meta-cloud-broker:sha256:/);
});

test("different broker snapshots are explicit inputs and cannot drift silently", () => {
  const manifest = buildAcceptedManifestFixture();
  const stable = resolveBrokerManifest({
    manifest,
    environment: buildBrokerEnvironmentFixture(),
  });
  const changedSnapshot = resolveBrokerManifest({
    manifest,
    environment: buildBrokerEnvironmentFixture({
      snapshotId: "broker-env-prod-next",
      environmentDigest: "sha256:broker-env-prod-next",
      catalogDigest: "sha256:catalog-prod-next",
    }),
  });

  assert.equal(stable.ok, true);
  assert.equal(changedSnapshot.ok, true);
  assert.notEqual(changedSnapshot.receipt.receiptId, stable.receipt.receiptId);
  assert.equal(changedSnapshot.receipt.environmentSnapshotId, "broker-env-prod-next");
  assert.equal(changedSnapshot.receipt.environmentDigest, "sha256:broker-env-prod-next");
  assert.equal(changedSnapshot.receipt.catalogSnapshotDigest, "sha256:catalog-prod-next");
  assert.notEqual(changedSnapshot.receipt.digest, stable.receipt.digest);
});

test("rejection reasons are structured for ambiguous, incompatible, and unavailable mappings", () => {
  const manifest = buildAcceptedManifestFixture();
  const ambiguous = resolveBrokerManifest({
    manifest,
    environment: buildAmbiguousEnvironmentFixture(),
  });
  const incompatible = resolveBrokerManifest({
    manifest,
    environment: buildIncompatibleEnvironmentFixture(),
  });
  const unavailable = resolveBrokerManifest({
    manifest,
    environment: buildUnavailableEnvironmentFixture(),
  });

  assert.equal(ambiguous.ok, false);
  assert.equal(incompatible.ok, false);
  assert.equal(unavailable.ok, false);
  assert.equal(ambiguous.rejection.reason.code, "mapping.ambiguous");
  assert.equal(incompatible.rejection.reason.code, "mapping.incompatible");
  assert.equal(unavailable.rejection.reason.code, "mapping.unavailable");
  assert.deepEqual(
    [ambiguous, incompatible, unavailable].map((result) => result.rejection.replay.inputs),
    [
      {
        manifestDigest: "sha256:manifest-orders-prod",
        environmentDigest: "sha256:broker-env-prod",
        catalogSnapshotDigest: "sha256:catalog-prod",
      },
      {
        manifestDigest: "sha256:manifest-orders-prod",
        environmentDigest: "sha256:broker-env-prod",
        catalogSnapshotDigest: "sha256:catalog-prod",
      },
      {
        manifestDigest: "sha256:manifest-orders-prod",
        environmentDigest: "sha256:broker-env-prod",
        catalogSnapshotDigest: "sha256:catalog-prod",
      },
    ],
  );
});

test("adversarial cases reject catalog-order nondeterminism and implicit provider defaults", () => {
  const manifest = buildAcceptedManifestFixture();
  const ambiguousForward = resolveBrokerManifest({
    manifest,
    environment: buildAmbiguousEnvironmentFixture(),
  });
  const ambiguousReverse = resolveBrokerManifest({
    manifest,
    environment: buildAmbiguousEnvironmentFixture({ reverseMappings: true }),
  });

  assert.equal(ambiguousForward.ok, false);
  assert.equal(ambiguousReverse.ok, false);
  assert.deepEqual(ambiguousReverse, ambiguousForward);

  const implicitDefault = resolveBrokerManifest({
    manifest,
    environment: buildUnavailableEnvironmentFixture({
      catalogIncludesImplicitDefault: true,
    }),
  });

  assert.equal(implicitDefault.ok, false);
  assert.equal(implicitDefault.rejection.reason.code, "mapping.unavailable");
  assert.equal(implicitDefault.rejection.reason.details[0], "provider defaults are catalog inputs, not broker decisions");
});

test("missing mapping never falls back to Yard-local matching", () => {
  let fallbackCalls = 0;

  const result = resolveBrokerManifest({
    manifest: buildAcceptedManifestFixture(),
    environment: buildUnavailableEnvironmentFixture(),
    yardFallbackResolver: () => {
      fallbackCalls += 1;
      throw new Error("Yard-local matching must not run inside broker resolution");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.rejection.reason.code, "mapping.unavailable");
  assert.equal(result.rejection.fallbackAttempted, false);
});
