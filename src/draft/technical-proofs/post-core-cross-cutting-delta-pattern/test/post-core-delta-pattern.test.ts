import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  POST_CORE_DELTA_PATTERN,
  assertDocsCarryPostCoreDeltaPattern,
  classifyPostCoreDeltaClaim,
  validatePostCoreDeltaPattern,
} from "../src/post-core-delta-pattern.ts";

const repoRoot = new URL("../../../../../", import.meta.url);

test("pattern defines the durable post-core cross-cutting capability lane", () => {
  const result = validatePostCoreDeltaPattern(POST_CORE_DELTA_PATTERN);

  assert.deepEqual(result.errors, []);
  assert.equal(POST_CORE_DELTA_PATTERN.issue, "HOBO-524");
  assert.equal(POST_CORE_DELTA_PATTERN.sourceM0Issue, "HOBO-521");
  assert.deepEqual(POST_CORE_DELTA_PATTERN.requiredRecords, [
    "linear-project",
    "m0-acceptance-record",
    "design-index-row",
    "proof-readme",
    "traceability-row",
    "blocked-follow-up-skeleton",
  ]);
});

test("design index and traceability carry the broker delta pattern", () => {
  const result = assertDocsCarryPostCoreDeltaPattern(repoRoot);

  assert.deepEqual(result.errors, []);
  assert.match(result.designIndex, /meta-cloud-broker\.md/);
  assert.match(result.traceability, /HOBO-521/);
  assert.match(result.traceability, /meta-cloud-broker-scope-contract/);
});

test("completed epics cannot become mutable catch-alls for post-core deltas", () => {
  assert.deepEqual(
    classifyPostCoreDeltaClaim({
      target: "completed-epic",
      claim: "Append the broker delta to the old Control Plane epic and skip a new project.",
      linearOwner: "HOBO-521",
      proofPath: "src/draft/exp-proofs/api/meta-cloud-broker-scope-contract",
    }),
    {
      allowed: false,
      reason: "Post-core deltas must not make completed epics mutable catch-alls.",
    },
  );
});

test("docs-only delta claims need a Linear owner and executable proof path", () => {
  assert.deepEqual(
    classifyPostCoreDeltaClaim({
      target: "new-cross-cutting-capability",
      claim: "Document the broker direction in a design note only.",
    }),
    {
      allowed: false,
      reason: "Post-core delta claims require a Linear owner and executable proof path.",
    },
  );

  assert.equal(
    classifyPostCoreDeltaClaim({
      target: "new-cross-cutting-capability",
      claim: "Record the broker M0 acceptance as its own project with proof.",
      linearOwner: "HOBO-521",
      proofPath: "src/draft/exp-proofs/api/meta-cloud-broker-scope-contract",
    }).allowed,
    true,
  );
});

test("architecture evidence names schema, parsed types, and event boundary", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/post-core-delta-pattern.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(new URL("../proto/post_core_delta_pattern.proto", import.meta.url), "utf8");
  const cue = readFileSync(new URL("../cue/post_core_delta_pattern.cue", import.meta.url), "utf8");

  assert.equal(pact.consumer.name, "PostCoreDeltaAuthor");
  assert.equal(pact.provider.name, "HoBoDesignSystemOfRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "PostCoreDeltaRecord",
    "DeltaArtifactEvidence",
    "DeltaTraceabilityRecord",
    "DeltaGateDecision",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain\s+types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Events/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event-store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
