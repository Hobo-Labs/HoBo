import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureMirror,
  resolvePinnedRegistryArtifact,
  sha256Digest,
} from "../src/registry-dependency-confusion-guard.js";

const pinnedBytes = Buffer.from("signed provider shell v1\n");
const pinnedDigest = sha256Digest(pinnedBytes);
const pin = Object.freeze({
  name: "@acme/provider-shell",
  version: "1.0.0",
  digest: pinnedDigest,
});

test("mirror digest disagreement for one pinned coordinate fails closed and surfaces every digest", async () => {
  const timeline = [];
  const poisonedBytes = Buffer.from("shadow provider shell v1\n");
  const poisonedDigest = sha256Digest(poisonedBytes);

  const result = await resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "cheap-public",
        costMicros: 1,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: poisonedBytes },
        ],
        timeline,
      }),
      createFixtureMirror({
        mirrorId: "trusted-yard",
        costMicros: 50,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: pinnedBytes },
        ],
        timeline,
      }),
    ],
    selectedMirrorId: "cheap-public",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.digest_mismatch_across_mirrors");
  assert.deepEqual(result.costEligibleMirrorIds, []);
  assert.deepEqual(result.conflictingDigests, [
    { digest: poisonedDigest, mirrorIds: ["cheap-public"] },
    { digest: pinnedDigest, mirrorIds: ["trusted-yard"] },
  ].toSorted((left, right) => left.digest.localeCompare(right.digest)));
  assert.match(result.reasons.join("\n"), /cheap-public/);
  assert.match(result.reasons.join("\n"), /trusted-yard/);
  assert.deepEqual(timeline, ["list:cheap-public", "list:trusted-yard"]);
});

test("a cheaper mirror with a different digest is never cost-eligible", async () => {
  const result = await resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "trusted-yard",
        costMicros: 90,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: pinnedBytes },
        ],
      }),
      createFixtureMirror({
        mirrorId: "cheap-shadow",
        costMicros: 1,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: Buffer.from("cheap substitute\n") },
        ],
      }),
    ],
    selectedMirrorId: "cheap-shadow",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.digest_mismatch_across_mirrors");
  assert.deepEqual(result.costEligibleMirrorIds, []);
  assert.equal(result.selection, null);
});

test("typosquatted, namespace-shadowed, and higher-version listings cannot replace an immutable pin", async () => {
  const result = await resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "public-registry",
        costMicros: 1,
        listings: [
          { name: "acme-provider-shell", version: pin.version, artifactBytes: Buffer.from("typosquat\n") },
          { name: "@evil/provider-shell", version: pin.version, artifactBytes: Buffer.from("namespace shadow\n") },
          { name: pin.name, version: "9.0.0", artifactBytes: Buffer.from("higher version\n") },
        ],
      }),
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.pinned_coordinate_absent");
  assert.deepEqual(result.costEligibleMirrorIds, []);
  assert.deepEqual(result.rejectedListings.map((listing) => ({
    mirrorId: listing.mirrorId,
    name: listing.name,
    version: listing.version,
    reason: listing.reason,
  })), [
    {
      mirrorId: "public-registry",
      name: "acme-provider-shell",
      version: "1.0.0",
      reason: "name-shadow",
    },
    {
      mirrorId: "public-registry",
      name: "@evil/provider-shell",
      version: "1.0.0",
      reason: "name-shadow",
    },
    {
      mirrorId: "public-registry",
      name: "@acme/provider-shell",
      version: "9.0.0",
      reason: "version-shadow",
    },
  ]);
});

test("byte-identical candidates are the only mirror ids exported for the HOBO-374 tiebreak", async () => {
  const timeline = [];

  const result = await resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "yard-east",
        costMicros: 20,
        latencyMs: 5,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: pinnedBytes },
        ],
        timeline,
      }),
      createFixtureMirror({
        mirrorId: "yard-west",
        costMicros: 10,
        latencyMs: 25,
        listings: [
          { name: pin.name, version: pin.version, artifactBytes: pinnedBytes },
        ],
        timeline,
      }),
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.selected_mirror_not_digest_eligible");
  assert.deepEqual(result.costEligibleMirrorIds, ["yard-east", "yard-west"]);
  assert.match(result.reasons.join("\n"), /HOBO-374/);
  assert.deepEqual(timeline, ["list:yard-east", "list:yard-west"]);
});

test("mirror byte flips are caught by digest verification on re-fetch", async () => {
  const result = await resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "mutable-public",
        costMicros: 1,
        listings: [
          {
            name: pin.name,
            version: pin.version,
            artifactBytes: pinnedBytes,
            fetchBytes: Buffer.from("bytes changed after listing\n"),
          },
        ],
      }),
    ],
    selectedMirrorId: "mutable-public",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.fetch_digest_mismatch");
  assert.equal(result.selection.mirrorId, "mutable-public");
  assert.notEqual(result.artifact.digest, pin.digest);
});
