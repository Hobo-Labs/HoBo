import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  publishSignedArtifact,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import {
  RESOURCE_PACK_MEDIA_TYPE,
  createOfflineBundleSigningKey,
  createFixtureProviderResourcePack,
  createResourcePackTrustBoundary,
  createSignedOfflineResourcePackBundle,
  createYard,
  hoboAddResourcePack,
  importOfflineResourcePackBundle,
  matchManifest,
} from "../src/resource-pack-distribution.js";

const signingKey = createFixtureSigningKey({
  keyId: "resource-pack-builder-key",
  builderId: "spiffe://yard/builders/resource-pack-publisher",
});
const offlineBundleKey = createOfflineBundleSigningKey({
  keyId: "airgap-bundle-root",
  secret: "airgap-bundle-signing-secret",
});

const trustBoundary = createResourcePackTrustBoundary({
  trustedSigningKeys: [signingKey],
  trustedBuilderIds: [signingKey.builderId],
  trustedOfflineBundleKeys: [offlineBundleKey],
});

const manifest = Object.freeze({
  resources: [
    { id: "orders-db", type: "database", require: ["postgres", "managed"] },
    { id: "assets", type: "objectStore", require: ["durable"] },
    { id: "api", type: "compute", require: ["container"] },
  ],
});

test("provider pack publishes signed definitions with conformance and provenance", () => {
  const pack = createFixtureProviderResourcePack({ signingKey });
  const yard = createYard({ yardId: "yard.fresh" });

  const installed = hoboAddResourcePack({ yard, pack, trustBoundary, command: "hobo add" });

  assert.equal(installed.ok, true, installed.reasons.join("\n"));
  assert.equal(installed.availableToMatching, true);
  assert.equal(installed.selectedByMatching, false);
  assert.equal(installed.entries.length, 3);
  assert.equal(installed.events[0].type, "resourcePack.Installed");
  assert.equal(installed.events.some((event) => event.type.startsWith("listing.")), false);
  assert.equal(pack.signedArtifact.signature.keyId, signingKey.keyId);
  assert.equal(pack.signedArtifact.provenance.slsa.builder.id, signingKey.builderId);
  assert.equal(pack.conformanceReport.subject.packContentDigest, pack.contentDigest);
});

test("hobo add installs on a fresh Yard and Camp provider plus IaC matches the whole manifest", () => {
  const pack = createFixtureProviderResourcePack({ signingKey });
  const installed = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.zero-config" }),
    pack,
    trustBoundary,
  });

  const matched = matchManifest({
    yard: installed.yard,
    manifest,
    camp: { provider: "aws", driver: "terraform" },
  });

  assert.equal(matched.ok, true);
  assert.deepEqual(
    matched.decisions.map((decision) => decision.winner.id),
    ["aws.default.database", "aws.default.object-store", "aws.default.compute"],
  );
  assert.ok(matched.decisions.every((decision) => decision.winner.availableToMatching));
  assert.ok(matched.decisions.every((decision) => !decision.winner.selectedByMatching));
  assert.ok(matched.catalogContentHash.startsWith("sha256:"));
});

test("unsigned and uncertified provider packs are refused with the Yard unchanged", () => {
  const yard = createYard({ yardId: "yard.reject" });
  const signedPack = createFixtureProviderResourcePack({ signingKey });
  const unsignedPack = {
    ...signedPack,
    signedArtifact: { ...signedPack.signedArtifact, signature: null },
  };
  const uncertifiedPack = createFixtureProviderResourcePack({
    signingKey,
    conformancePassed: false,
  });

  const unsigned = hoboAddResourcePack({ yard, pack: unsignedPack, trustBoundary });
  const uncertified = hoboAddResourcePack({ yard, pack: uncertifiedPack, trustBoundary });

  assert.equal(unsigned.ok, false);
  assert.match(unsigned.reasons.join("\n"), /signedArtifact\.signature\.required/);
  assert.deepEqual(unsigned.yard.catalog, []);

  assert.equal(uncertified.ok, false);
  assert.match(uncertified.reasons.join("\n"), /conformance\.failed/);
  assert.deepEqual(uncertified.yard.catalog, []);
});

test("stale conformance is rechecked against bundled provider code and definitions", () => {
  const pack = createFixtureProviderResourcePack({ signingKey });
  const stalePack = {
    ...pack,
    content: {
      ...pack.content,
      provider: {
        ...pack.content.provider,
        codeDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  };

  const installed = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.stale" }),
    pack: stalePack,
    trustBoundary,
  });

  assert.equal(installed.ok, false);
  assert.match(installed.reasons.join("\n"), /conformance\.stale_pack_content/);
  assert.match(installed.reasons.join("\n"), /conformance\.stale_provider_code/);
});

test("stale signed conformance cannot be hidden by a corrected unsigned report", () => {
  const staleReportPack = createFixtureProviderResourcePack({ signingKey });
  const freshContentPack = createFixtureProviderResourcePack({
    signingKey,
    provider: {
      id: "aws",
      version: "6.0.1",
      codeDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  });
  const staleSignedArtifact = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: freshContentPack.signedArtifact.artifact.coordinate,
      version: freshContentPack.version,
      mediaType: RESOURCE_PACK_MEDIA_TYPE,
      bytes: freshContentPack.signedArtifact.artifact.bytes,
    }),
    signingKey,
    conformanceReport: staleReportPack.conformanceReport,
    issuedAt: "2026-06-26T12:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const tamperedPack = {
    ...freshContentPack,
    conformanceReport: freshContentPack.conformanceReport,
    signedArtifact: staleSignedArtifact,
  };

  const installed = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.signed-stale" }),
    pack: tamperedPack,
    trustBoundary,
  });

  assert.equal(installed.ok, false);
  assert.match(installed.reasons.join("\n"), /conformance\.stale_pack_content/);
  assert.match(installed.reasons.join("\n"), /conformance\.stale_provider_code/);
  assert.match(installed.reasons.join("\n"), /conformance\.report_unsigned_mismatch/);
});

test("equal-scoring winner changes are attributed to catalog and pack content hashes", () => {
  const firstPack = createFixtureProviderResourcePack({ signingKey });
  const firstInstall = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.tie" }),
    pack: firstPack,
    trustBoundary,
  });
  const firstMatch = matchManifest({
    yard: firstInstall.yard,
    manifest: { resources: [{ id: "orders-db", type: "database", require: ["postgres"] }] },
    camp: { provider: "aws", driver: "terraform" },
  });
  const secondPack = createFixtureProviderResourcePack({
    signingKey,
    name: "@hobo/aws-defaults-alt",
    version: "1.1.0",
    definitions: [
      {
        id: "aaa.aws.default.database",
        type: "database",
        provider: "aws",
        driver: "terraform",
        resourceClass: "rds-aurora-postgres",
        satisfies: ["postgres", "managed", "ha"],
        match: {},
      },
    ],
  });
  const secondInstall = hoboAddResourcePack({
    yard: firstInstall.yard,
    pack: secondPack,
    trustBoundary,
  });

  const secondMatch = matchManifest({
    yard: secondInstall.yard,
    manifest: { resources: [{ id: "orders-db", type: "database", require: ["postgres"] }] },
    camp: { provider: "aws", driver: "terraform" },
  });
  const [decision] = secondMatch.decisions;

  assert.equal(firstMatch.decisions[0].winner.id, "aws.default.database");
  assert.equal(decision.winner.id, "aaa.aws.default.database");
  assert.equal(decision.equalScoreTie, true);
  assert.notEqual(secondMatch.catalogContentHash, firstMatch.catalogContentHash);
  assert.deepEqual(
    decision.candidateContentHashes.map((candidate) => candidate.packContentDigest).sort(),
    [firstPack.contentDigest, secondPack.contentDigest].sort(),
  );
});

test("signed offline bundle imports in-boundary without egress and updates anti-rollback state", () => {
  const pack = createFixtureProviderResourcePack({ signingKey });
  const bundle = createSignedOfflineResourcePackBundle({
    bundleId: "bundle.airgap.resource-packs.2026-06-26",
    packs: [pack],
    bundleSigningKey: offlineBundleKey,
  });

  const imported = importOfflineResourcePackBundle({
    yard: createYard({ yardId: "yard.airgap" }),
    bundle,
    trustBoundary,
  });
  const matched = matchManifest({
    yard: imported.yard,
    manifest,
    camp: { provider: "aws", driver: "terraform" },
  });

  assert.equal(imported.ok, true, imported.reasons.join("\n"));
  assert.equal(imported.egressAttempted, false);
  assert.equal(imported.event.verification.signature, "passed");
  assert.equal(imported.event.verification.provenance, "passed");
  assert.equal(imported.event.verification.conformance, "passed");
  assert.equal(imported.event.verification.antiRollback, "passed");
  assert.equal(imported.event.verification.inBoundary, "passed");
  assert.equal(imported.yard.airGap.lastAcceptedBuildTimestamp, pack.signedArtifact.provenance.slsa.issuedAt);
  assert.equal(matched.ok, true);
});

test("air-gap import refuses an older vulnerable pack by anti-rollback state", () => {
  const currentPack = createFixtureProviderResourcePack({
    signingKey,
    issuedAt: "2026-06-26T12:00:00.000Z",
  });
  const currentBundle = createSignedOfflineResourcePackBundle({
    issuedAt: "2026-06-26T13:00:00.000Z",
    packs: [currentPack],
    bundleSigningKey: offlineBundleKey,
  });
  const imported = importOfflineResourcePackBundle({
    yard: createYard({ yardId: "yard.rollback" }),
    bundle: currentBundle,
    trustBoundary,
  });
  const olderPack = createFixtureProviderResourcePack({
    signingKey,
    version: "0.9.0",
    issuedAt: "2026-06-01T12:00:00.000Z",
  });
  const olderBundle = createSignedOfflineResourcePackBundle({
    issuedAt: "2026-06-27T13:00:00.000Z",
    packs: [olderPack],
    bundleSigningKey: offlineBundleKey,
  });

  const rejected = importOfflineResourcePackBundle({
    yard: imported.yard,
    bundle: olderBundle,
    trustBoundary,
  });

  assert.equal(imported.ok, true, imported.reasons.join("\n"));
  assert.equal(rejected.ok, false);
  assert.match(rejected.reasons.join("\n"), /airgap\.rollback\.vulnerable_pack/);
  assert.equal(rejected.yard.catalog.length, imported.yard.catalog.length);
});

test("offline bundle wrappers must be signed by a trusted bundle key", () => {
  const pack = createFixtureProviderResourcePack({ signingKey });
  const attackerKey = createOfflineBundleSigningKey({
    keyId: "attacker-bundle-key",
    secret: "attacker-controlled-secret",
  });
  const attackerBundle = createSignedOfflineResourcePackBundle({
    bundleId: "bundle.airgap.attacker",
    packs: [pack],
    bundleSigningKey: attackerKey,
  });
  const forgedBundle = {
    ...attackerBundle,
    signature: {
      ...attackerBundle.signature,
      keyId: offlineBundleKey.keyId,
    },
  };

  const untrusted = importOfflineResourcePackBundle({
    yard: createYard({ yardId: "yard.untrusted-bundle" }),
    bundle: attackerBundle,
    trustBoundary,
  });
  const forged = importOfflineResourcePackBundle({
    yard: createYard({ yardId: "yard.forged-bundle" }),
    bundle: forgedBundle,
    trustBoundary,
  });

  assert.equal(untrusted.ok, false);
  assert.match(untrusted.reasons.join("\n"), /offlineBundle\.signature\.key_untrusted/);
  assert.equal(forged.ok, false);
  assert.match(forged.reasons.join("\n"), /offlineBundle\.signature\.invalid/);
});

test("pack force-selection directives are ignored; install only makes definitions available", () => {
  const awsPack = createFixtureProviderResourcePack({ signingKey });
  const forcedPack = createFixtureProviderResourcePack({
    signingKey,
    name: "@hobo/gcp-forced",
    provider: {
      id: "gcp",
      version: "1.0.0",
      codeDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    definitions: [
      {
        id: "gcp.default.database",
        type: "database",
        provider: "gcp",
        driver: "terraform",
        resourceClass: "cloud-sql-postgres",
        priority: 99,
        satisfies: ["postgres", "managed"],
        match: {},
      },
    ],
    selectionHint: { forceWinner: true },
  });
  const awsInstall = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.force" }),
    pack: awsPack,
    trustBoundary,
  });
  const forcedInstall = hoboAddResourcePack({
    yard: awsInstall.yard,
    pack: forcedPack,
    trustBoundary,
  });
  const matched = matchManifest({
    yard: forcedInstall.yard,
    manifest: { resources: [{ id: "orders-db", type: "database", require: ["postgres"] }] },
    camp: { provider: "aws", driver: "terraform" },
  });

  assert.equal(forcedInstall.ok, true, forcedInstall.reasons.join("\n"));
  assert.deepEqual(forcedInstall.warnings, ["selection.force_ignored"]);
  assert.equal(forcedInstall.entries[0].availableToMatching, true);
  assert.equal(forcedInstall.entries[0].selectedByMatching, false);
  assert.equal(matched.decisions[0].winner.id, "aws.default.database");
});

test("pack-provided priority is ignored as another force-selection path", () => {
  const firstPack = createFixtureProviderResourcePack({ signingKey });
  const firstInstall = hoboAddResourcePack({
    yard: createYard({ yardId: "yard.priority" }),
    pack: firstPack,
    trustBoundary,
  });
  const priorityPack = createFixtureProviderResourcePack({
    signingKey,
    name: "@hobo/aws-priority-forced",
    definitions: [
      {
        id: "zzz.aws.priority.database",
        type: "database",
        provider: "aws",
        driver: "terraform",
        resourceClass: "rds-aurora-postgres",
        priority: 99,
        satisfies: ["postgres", "managed", "ha"],
        match: {},
      },
    ],
  });
  const priorityInstall = hoboAddResourcePack({
    yard: firstInstall.yard,
    pack: priorityPack,
    trustBoundary,
  });
  const matched = matchManifest({
    yard: priorityInstall.yard,
    manifest: { resources: [{ id: "orders-db", type: "database", require: ["postgres"] }] },
    camp: { provider: "aws", driver: "terraform" },
  });

  assert.equal(priorityInstall.ok, true, priorityInstall.reasons.join("\n"));
  assert.equal(priorityInstall.entries[0].priority, 0);
  assert.equal(matched.decisions[0].equalScoreTie, true);
  assert.equal(matched.decisions[0].winner.id, "aws.default.database");
});
