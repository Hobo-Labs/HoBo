import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  createTenantOtlpBackend,
  runEvalsTrainingPromotionPipeline,
  runRefusedPromotionPipeline,
} from "../src/promotion-pipeline.js";
import { lintUseTrainingSource } from "../src/lint/use-training-lint.js";
import { evaluateThreePassGate, createPromotionGateFromRubric } from "../src/evals/promotion-gates.js";
import { CLASSIFY_TICKET_RUBRIC } from "../src/evals/rubrics.js";

describe("Feature: Promote trained semantic functions (HOBO-653 acceptance)", () => {
  it("Scenario: challenger promotes through conformance, eval, and policy with provenance events", () => {
    const backend = createTenantOtlpBackend({
      tenantId: "tenant-a",
      endpoint: "https://otlp.example/tenant-a/v1/traces",
    });

    const result = runEvalsTrainingPromotionPipeline({ backend, tenantId: "tenant-a" });

    assert.equal(result.optimizer.outcome, "ready-for-gate");
    assert.equal(result.eval.threePass.outcome, "promote");
    assert.equal(result.eval.threePass.passFlags.conformance, true);
    assert.equal(result.eval.threePass.passFlags.eval, true);
    assert.equal(result.eval.threePass.passFlags.policy, true);
    assert.equal(result.promotion.outcome, "auto-applied");
    assert.deepEqual(result.promotion.eventTypes, ["training.Promoted", "impl.Promoted"]);
    assert.equal(result.otlp.accepted, true);
    assert.ok(result.telemetry.spanCount > 0);
    assert.ok(result.telemetry.rewardCount > 0);

    const exported = backend.batches();
    assert.equal(exported.length, 1);
    assert.equal(exported[0].tenantId, "tenant-a");
    assert.ok(exported[0].spans.length > 0);
    assert.ok(exported[0].rewards.length > 0);
  });

  it("Scenario: rubric-failing challenger is refused and stays shadow", () => {
    const result = runRefusedPromotionPipeline();

    assert.equal(result.eval.threePass.outcome, "refuse");
    assert.equal(result.eval.threePass.passFlags.eval, false);
    assert.equal(result.promotion.outcome, "refused");
    assert.deepEqual(result.promotion.eventTypes, []);
  });
});

describe("Feature: Lint use-training semantic grounding", () => {
  it("flags missing intent, contract, and rubric", () => {
    const source = [
      "export async function classifyTicket(ticket) {",
      '  "use training";',
      "  return llm.classify(ticket);",
      "}",
    ].join("\n");

    const report = lintUseTrainingSource(source);
    assert.equal(report.ok, false);
    assert.equal(report.findings.length, 3);
    assert.ok(report.findings.some((finding) => finding.kind === "intent"));
    assert.ok(report.findings.some((finding) => finding.kind === "contract"));
    assert.ok(report.findings.some((finding) => finding.kind === "rubric"));
  });

  it("passes fully grounded use-training source", () => {
    const source = [
      "/** @intent Route tickets to the right queue. */",
      "export const classifyTicket = training(async (t) => llm.classify(t), {",
      '  intent: "Route tickets",',
      "  contract: ClassificationContract,",
      "  rubric: { categoryCorrect: 0.92, urgencyCalibrated: 0.9, piiSafe: 1.0 },",
      "});",
    ].join("\n");

    const report = lintUseTrainingSource(source);
    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
  });
});

describe("architecture evidence", () => {
  it("pins protobuf, CUE, Pact, and ADR boundaries", () => {
    const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
    const proto = readFileSync(
      new URL("../architecture/evals_training_promotion_gates.proto", import.meta.url),
      "utf8",
    );
    const cue = readFileSync(
      new URL("../architecture/evals_training_promotion_gates.cue", import.meta.url),
      "utf8",
    );
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/evals_training_promotion_gates.pact.json", import.meta.url),
        "utf8",
      ),
    );

    for (const typeName of ["EvalsTrainingPromotionGatesRecord"]) {
      assert.match(proto, new RegExp(`message ${typeName}`));
      assert.match(cue, new RegExp(`#${typeName}:`));
    }

    assert.equal(pact.consumer.name, "EvalsTrainingPromotionGatesConsumer");
    assert.equal(pact.provider.name, "EvalsTrainingPromotionGatesBoundary");
    assert.equal(pact.interactions[0].response.body.ok, true);
    assert.match(adr, /parse, don't validate/i);
    assert.match(adr, /Command/i);
    assert.match(adr, /Event/i);
    assert.match(adr, /Actor/i);
    assert.match(adr, /event store/i);
    assert.match(adr, /projection/i);
    assert.match(adr, /read store/i);
  });
});

describe("evals three-pass gate unit", () => {
  it("requires conformance, eval, and policy", () => {
    const gate = createPromotionGateFromRubric(CLASSIFY_TICKET_RUBRIC, { minSamples: 3 });
    const passing = evaluateThreePassGate(gate, {
      candidateId: "candidate-1",
      championId: "champion-1",
      conformance: { passed: true },
      policy: { effect: "allow" },
      samples: 3,
      scores: { categoryCorrect: 0.96, urgencyCalibrated: 0.95, piiSafe: 1 },
    });
    assert.equal(passing.outcome, "promote");

    const failing = evaluateThreePassGate(gate, {
      candidateId: "candidate-2",
      championId: "champion-1",
      conformance: { passed: true },
      policy: { effect: "allow" },
      samples: 3,
      scores: { categoryCorrect: 0.7, urgencyCalibrated: 0.65, piiSafe: 1 },
    });
    assert.equal(failing.outcome, "refuse");
  });
});
