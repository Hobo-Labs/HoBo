import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureMirror,
  selectDigestPinnedMirror,
  sha256Digest,
} from "../src/mirror-digest-selection.js";

const coordinate = Object.freeze({
  name: "@acme/provider-shell",
  version: "1.0.0",
});

test("byte-identical verified mirrors choose the cheapest mirror only after every mirror verifies", async () => {
  const timeline = [];
  const artifactBytes = Buffer.from("provider shell component bytes v1\n");
  const resolvedDigest = sha256Digest(artifactBytes);
  const mirrors = [
    createFixtureMirror({ mirrorId: "primary", artifactBytes, costMicros: 80, latencyMs: 20, timeline }),
    createFixtureMirror({ mirrorId: "cheap-edge", artifactBytes, costMicros: 15, latencyMs: 60, timeline }),
    createFixtureMirror({ mirrorId: "fast-edge", artifactBytes, costMicros: 40, latencyMs: 5, timeline }),
  ];
  const candidatesSeenByDispatcher = [];

  const result = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors,
    dispatchCostTiebreak({ candidates }) {
      timeline.push("dispatch-cost");
      candidatesSeenByDispatcher.push(...candidates);
      return candidates.toSorted((left, right) => left.costMicros - right.costMicros)[0].mirrorId;
    },
  });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.selection.mirrorId, "cheap-edge");
  assert.equal(result.selection.digest, resolvedDigest);
  assert.equal(Buffer.compare(result.artifact.bytes, artifactBytes), 0);
  assert.deepEqual(timeline, ["verify:primary", "verify:cheap-edge", "verify:fast-edge", "dispatch-cost", "fetch:cheap-edge"]);
  assert.deepEqual(candidatesSeenByDispatcher.map((candidate) => candidate.mirrorId), ["primary", "cheap-edge", "fast-edge"]);
  assert.deepEqual(candidatesSeenByDispatcher.map((candidate) => candidate.digest), [
    resolvedDigest,
    resolvedDigest,
    resolvedDigest,
  ]);
});

test("changing the mirror winner never changes the resolved digest or fetched bytes", async () => {
  const artifactBytes = Buffer.from("same bytes behind every equivalent mirror\n");
  const resolvedDigest = sha256Digest(artifactBytes);
  const west = createFixtureMirror({ mirrorId: "west", artifactBytes, costMicros: 10, latencyMs: 80 });
  const east = createFixtureMirror({ mirrorId: "east", artifactBytes, costMicros: 12, latencyMs: 15 });

  const byCost = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors: [west, east],
  });
  const byLatency = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors: [west, east],
    dispatchCostTiebreak({ candidates }) {
      return candidates.toSorted((left, right) => left.latencyMs - right.latencyMs)[0].mirrorId;
    },
  });

  assert.equal(byCost.ok, true, byCost.reasons.join("\n"));
  assert.equal(byLatency.ok, true, byLatency.reasons.join("\n"));
  assert.equal(byCost.selection.mirrorId, "west");
  assert.equal(byLatency.selection.mirrorId, "east");
  assert.equal(byCost.selection.digest, resolvedDigest);
  assert.equal(byLatency.selection.digest, resolvedDigest);
  assert.equal(Buffer.compare(byCost.artifact.bytes, byLatency.artifact.bytes), 0);
});

test("a cheaper mirror with a different digest fails before Dispatcher cost is consulted", async () => {
  const artifactBytes = Buffer.from("trusted provider bytes\n");
  const cheaperDifferentBytes = Buffer.from("different cheaper bytes\n");
  const resolvedDigest = sha256Digest(artifactBytes);
  let dispatcherCalls = 0;

  const result = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors: [
      createFixtureMirror({ mirrorId: "cheap-shadow", artifactBytes: cheaperDifferentBytes, costMicros: 1, latencyMs: 1 }),
      createFixtureMirror({ mirrorId: "trusted-origin", artifactBytes, costMicros: 50, latencyMs: 20 }),
    ],
    dispatchCostTiebreak() {
      dispatcherCalls += 1;
      throw new Error("cost must not run for digest disagreement");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "mirror.digest_mismatch");
  assert.equal(result.escalatedTo, "HOBO-391");
  assert.equal(dispatcherCalls, 0);
  assert.deepEqual(result.costEligibleMirrorIds, []);
});

test("unverified mirrors are never cost-eligible and cannot be promoted by cheap cost", async () => {
  const artifactBytes = Buffer.from("verified provider bytes\n");
  const resolvedDigest = sha256Digest(artifactBytes);
  let dispatcherCalls = 0;

  const result = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors: [
      createFixtureMirror({
        mirrorId: "unverified-cheap",
        artifactBytes,
        costMicros: 1,
        latencyMs: 1,
        verificationOk: false,
        verificationReasons: ["signature.invalid"],
      }),
      createFixtureMirror({ mirrorId: "verified-origin", artifactBytes, costMicros: 90, latencyMs: 10 }),
    ],
    dispatchCostTiebreak() {
      dispatcherCalls += 1;
      throw new Error("cost must not run for unverified mirrors");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "mirror.unverified");
  assert.equal(dispatcherCalls, 0);
  assert.deepEqual(result.costEligibleMirrorIds, []);
  assert.match(result.reasons.join("\n"), /signature.invalid/);
});

test("a selected mirror whose fetched bytes no longer match the agreed digest is refused", async () => {
  const verifiedBytes = Buffer.from("bytes verified at install boundary\n");
  const tamperedFetchBytes = Buffer.from("bytes changed after selection\n");
  const resolvedDigest = sha256Digest(verifiedBytes);

  const result = await selectDigestPinnedMirror({
    coordinate,
    resolvedDigest,
    mirrors: [
      createFixtureMirror({
        mirrorId: "mutable-mirror",
        artifactBytes: verifiedBytes,
        fetchBytes: tamperedFetchBytes,
        costMicros: 5,
        latencyMs: 5,
      }),
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "mirror.fetch_digest_mismatch");
  assert.equal(result.selection.mirrorId, "mutable-mirror");
  assert.equal(result.selection.digest, resolvedDigest);
  assert.notEqual(sha256Digest(result.artifact.bytes), resolvedDigest);
});
