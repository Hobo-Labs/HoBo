import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ChampionChallengerPromotionError,
  checkGeneratedRegionDrift,
  createChampionChallengerPromotion,
  findGeneratedRegion,
} from "../src/champion-challenger-promotion.js";

test("preview challenger shadows traffic then promotes by touching only the generated region", () => {
  const source = trainingSource("return \"identity-support\";");
  const region = findGeneratedRegion(source, "classifyTicket-body");
  const promotion = createChampionChallengerPromotion();

  const shadow = promotion.shadowTraffic({
    champion: (ticket) => (ticket.includes("password") ? "identity-support" : "general-support"),
    challenger: (ticket) => (ticket.includes("billing") ? "billing-support" : "identity-support"),
    requests: ["password reset", "billing invoice"],
  });

  assert.deepEqual(
    shadow.samples.map((sample) => sample.servedResponse),
    ["identity-support", "general-support"],
  );
  assert.deepEqual(
    shadow.samples.map((sample) => sample.challengerResponse),
    ["identity-support", "billing-support"],
  );

  const result = promotion.promote({
    source,
    region,
    candidate: candidateFor(region, "return \"billing-support\";"),
    gate: { effect: "certify", certified: true, reason: "green gates" },
    provenance: completeProvenance(),
    environment: "preview",
    riskClass: "low",
  });

  assert.equal(result.effect, "auto-applied");
  assert.equal(result.source.includes("return \"billing-support\";"), true);
  assert.equal(result.source.includes("const handWrittenGuard = true;"), true);
  assert.equal(result.source.split("const handWrittenGuard = true;").length, 2);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["training.Promoted", "impl.Promoted"],
  );
});

test("prod promotion emits a PR delta and leaves source unchanged", () => {
  const source = trainingSource("return \"identity-support\";");
  const region = findGeneratedRegion(source, "classifyTicket-body");
  const promotion = createChampionChallengerPromotion();

  const result = promotion.promote({
    source,
    region,
    candidate: candidateFor(region, "return \"billing-support\";"),
    gate: { effect: "certify", certified: true, reason: "approved gate" },
    provenance: completeProvenance(),
    environment: "prod",
    riskClass: "high",
  });

  assert.equal(result.effect, "pr-delta");
  assert.equal(result.source, source);
  assert.equal(result.delta.kind, "source-pr-delta");
  assert.equal(result.delta.regionId, "classifyTicket-body");
  assert.match(result.delta.provenanceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.events[0].effect, "pending-pr-delta");
});

test("promotion is idempotent and reversible from the event log", () => {
  const source = `${["function unrelatedClassifier() {", "  return \"billing-support\";", "}", ""].join("\n")}${trainingSource(
    "return \"identity-support\";",
  )}`;
  const region = findGeneratedRegion(source, "classifyTicket-body");
  const promotion = createChampionChallengerPromotion();
  const candidate = candidateFor(region, "return \"billing-support\";");

  const first = promotion.promote({
    source,
    region,
    candidate,
    gate: { effect: "certify", certified: true, reason: "green gates" },
    provenance: completeProvenance(),
    environment: "preview",
    riskClass: "low",
  });
  const second = promotion.promote({
    source: first.source,
    region,
    candidate,
    gate: { effect: "certify", certified: true, reason: "green gates" },
    provenance: completeProvenance(),
    environment: "preview",
    riskClass: "low",
  });

  assert.equal(second.effect, "already-applied");
  assert.equal(second.source, first.source);

  const reverted = promotion.revert({
    source: first.source,
    events: first.events,
    candidateId: candidate.id,
  });

  assert.equal(reverted.effect, "reverted");
  assert.equal(reverted.source, source);
  assert.equal(reverted.source.includes("function unrelatedClassifier()"), true);
});

test("generated-region drift check distinguishes human edits from a deliberate promotion", () => {
  const expectedSource = trainingSource("return \"identity-support\";");
  const region = findGeneratedRegion(expectedSource, "classifyTicket-body");
  const driftedSource = expectedSource.replace("return \"identity-support\";", "return \"manual-hotfix\";");

  const clean = checkGeneratedRegionDrift({
    source: expectedSource,
    expectedSource,
    regionId: region.regionId,
  });
  const drifted = checkGeneratedRegionDrift({
    source: driftedSource,
    expectedSource,
    regionId: region.regionId,
  });

  assert.equal(clean.ok, true);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, "promotion.generated_region_drift");
  assert.equal(drifted.handWrittenChanged, false);
});

test("out-of-region codemod and incomplete provenance are rejected", () => {
  const source = trainingSource("return \"identity-support\";");
  const region = findGeneratedRegion(source, "classifyTicket-body");
  const promotion = createChampionChallengerPromotion();
  const fakeHandWrittenRegion = { ...region, startOffset: 0, endOffset: 32 };

  assertPromotionError(
    () =>
      promotion.promote({
        source,
        region,
        candidate: {
          ...candidateFor(region, "return \"billing-support\";"),
          edits: [
            {
              startOffset: region.endOffset + 1,
              endOffset: region.endOffset + 12,
              replacement: "manual overwrite",
            },
          ],
        },
        gate: { effect: "certify", certified: true, reason: "green gates" },
        provenance: completeProvenance(),
        environment: "preview",
        riskClass: "low",
      }),
    "promotion.candidate_patch_invalid",
  );

  assertPromotionError(
    () =>
      promotion.promote({
        source,
        region: fakeHandWrittenRegion,
        candidate: candidateFor(fakeHandWrittenRegion, "const hacked = true;"),
        gate: { effect: "certify", certified: true, reason: "green gates" },
        provenance: completeProvenance(),
        environment: "preview",
        riskClass: "low",
      }),
    "promotion.region_boundary_mismatch",
  );

  assertPromotionError(
    () =>
      promotion.promote({
        source,
        region,
        candidate: candidateFor(region, "return \"billing-support\";"),
        gate: { effect: "certify", certified: true, reason: "green gates" },
        provenance: { ...completeProvenance(), signature: undefined },
        environment: "preview",
        riskClass: "low",
      }),
    "promotion.provenance_signature_required",
  );
});

function trainingSource(regionBody) {
  return [
    "export function classifyTicket(ticket) {",
    "  const handWrittenGuard = true;",
    "  // hobo:generated-region begin region=classifyTicket-body owner=training-engine",
    `  ${regionBody}`,
    "  // hobo:generated-region end region=classifyTicket-body",
    "}",
    "",
  ].join("\n");
}

function candidateFor(region, replacement) {
  return {
    schema: "hobo.training.candidate-patch/v1",
    id: "candidate-billing-route",
    engineId: "hobo.training-engine/built-in-opto@0.1.0",
    region,
    edits: [
      {
        startOffset: region.startOffset,
        endOffset: region.endOffset,
        replacement: `  ${replacement}`,
      },
    ],
    provenance: {
      optimizer: "hobo.built-in-opto-training-engine/v1",
      trajectoryHashes: ["sha256:1111111111111111111111111111111111111111111111111111111111111111"],
      rubricRef: "rubric://support/classifier@1.0.0",
      contractRef: "contract://support/classification@1.0.0",
    },
  };
}

function completeProvenance() {
  return {
    kind: "generation-provenance",
    signature: {
      alg: "Ed25519",
      payloadDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      value: "signed-fixture",
    },
    payload: {
      schema: "hobo.generation.provenance/v1",
      model: {
        provider: "local",
        id: "opto-fixture",
        digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      },
      prompt: {
        id: "prompt:support-classifier",
        frozenPromptDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      },
      seed: "seed-344",
      evalReportRefs: [
        {
          kind: "eval-report",
          name: "shadow-eval",
          digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        },
      ],
      conformanceReportRef: {
        kind: "conformance-report",
        name: "support-classifier-contract",
        digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        signature: {
          alg: "Ed25519",
          payloadDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
          value: "signed-report",
        },
      },
      artifact: {
        kind: "use-training-method",
        name: "classifyTicket",
        digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      },
      issuedAt: "2026-06-28T19:10:00.000Z",
    },
  };
}

function assertPromotionError(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof ChampionChallengerPromotionError && error.code === code,
  );
}
