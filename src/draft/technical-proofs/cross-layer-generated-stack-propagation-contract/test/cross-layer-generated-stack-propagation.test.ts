import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  GENERATED_STACK_LAYERS,
  checkGeneratedRegions,
  renderSourceWithGeneratedRegions,
  runCrossLayerPropagation,
} from "../src/cross-layer-generated-stack-propagation.js";

describe("cross-layer generated-stack propagation contract", () => {
  it("propagates one WIT domain-record change through all five generated-stack layers", () => {
    const result = runCrossLayerPropagation({
      domainRecordChange: supportTicketPriorityChange(),
    });

    assert.deepEqual(
      result.layers.map((layer) => layer.name),
      GENERATED_STACK_LAYERS,
    );
    assert.deepEqual(
      result.layers.map((layer) => layer.loop),
      Array.from({ length: 5 }, () => ["generate", "validate", "repair", "certify", "persist"]),
    );

    for (const layer of result.layers) {
      assert.equal(layer.domainRecord.digest, result.domainRecord.digest);
      assert.equal(layer.gates.every((gate) => gate.status === "passed"), true);
      assert.match(layer.generatedRegion.path, new RegExp(`${layer.name}.*generated`, "i"));
      assert.equal(layer.reviewableDiff.kind, "region-scoped");
      assert.equal(layer.provenance.domainRecordRef, result.domainRecord.ref);
    }

    assert.deepEqual(result.summary.gatedLayers, GENERATED_STACK_LAYERS);
    assert.equal(result.summary.persistedLayers.length, 3);
    assert.equal(result.summary.proposedLayers.length, 2);
  });

  it("degrades non-deterministic intelligence and UI layers to propose/human-gate without mutating source", () => {
    const result = runCrossLayerPropagation({
      domainRecordChange: supportTicketPriorityChange(),
      existingSources: sourceFixture(),
      layerOverrides: {
        intelligence: { autoHealSafe: false },
        ui: { autoHealSafe: false },
      },
    });

    for (const layerName of ["intelligence", "ui"]) {
      const layer = result.layersByName[layerName];
      assert.equal(layer.deterministic, false);
      assert.equal(layer.persistence.status, "proposed-human-gate");
      assert.equal(layer.persistence.mutatedSource, false);
      assert.equal(layer.sourceAfter, sourceFixture()[layerName]);
      assert.match(layer.persistence.reason, /nondeterministic.*human-gate/);
    }
  });

  it("makes hobo codegen --check fail on hand-edited drift in any layer generated region", () => {
    const result = runCrossLayerPropagation({
      domainRecordChange: supportTicketPriorityChange(),
    });
    const cleanSources = renderSourceWithGeneratedRegions(result.layers);

    for (const layerName of GENERATED_STACK_LAYERS) {
      const driftedSources = {
        ...cleanSources,
        [layerName]: cleanSources[layerName].replace("priority: urgent | normal | low", "priority: urgent | low"),
      };

      const check = checkGeneratedRegions({
        expectedLayers: result.layers,
        sources: driftedSources,
      });

      assert.equal(check.ok, false);
      assert.equal(check.exitCode, 1);
      assert.equal(check.code, "HOBO_CODEGEN_DRIFT");
      assert.deepEqual(check.drift.map((entry) => entry.layer), [layerName]);
      assert.equal(check.sourcesAfter[layerName], driftedSources[layerName]);
    }
  });

  it("routes a layer that cannot auto-heal to a proposal instead of silently mutating source", () => {
    const before = sourceFixture();
    const result = runCrossLayerPropagation({
      domainRecordChange: supportTicketPriorityChange(),
      existingSources: before,
      layerOverrides: {
        message: { autoHealSafe: false },
      },
    });

    const message = result.layersByName.message;
    assert.equal(message.deterministic, true);
    assert.equal(message.persistence.status, "proposed-human-gate");
    assert.equal(message.persistence.mutatedSource, false);
    assert.equal(message.sourceAfter, before.message);
    assert.equal(message.proposal.patch.length > 0, true);
    assert.ok(!result.events.some((event) => event.type === "source.SilentlyMutated"));
  });

  it("catches hand edits inside generated regions and leaves the source unclobbered", () => {
    const result = runCrossLayerPropagation({
      domainRecordChange: supportTicketPriorityChange(),
    });
    const cleanSources = renderSourceWithGeneratedRegions(result.layers);
    const handwrittenDrift = {
      ...cleanSources,
      data: cleanSources.data.replace(
        "export type SupportTicketPriority = \"urgent\" | \"normal\" | \"low\";",
        "export type SupportTicketPriority = \"urgent\" | \"low\"; // hand edit",
      ),
    };

    const check = checkGeneratedRegions({
      expectedLayers: result.layers,
      sources: handwrittenDrift,
    });

    assert.equal(check.ok, false);
    assert.equal(check.drift[0].status, "changed");
    assert.equal(check.drift[0].layer, "data");
    assert.match(check.drift[0].message, /generated region drift/);
    assert.equal(check.sourcesAfter.data, handwrittenDrift.data);
  });
});

function supportTicketPriorityChange() {
  return {
    ref: "wit://hobo/support@0.1.0#SupportTicket.priority",
    record: "SupportTicket",
    field: "priority",
    previousType: "\"normal\" | \"low\"",
    nextType: "\"urgent\" | \"normal\" | \"low\"",
    invariants: ["urgent tickets page SRE", "priority is required"],
  };
}

function sourceFixture() {
  return {
    data: "// hand-authored data imports\n",
    business: "// hand-authored business rules\n",
    message: "// hand-authored message routes\n",
    intelligence: "// hand-authored training directive\n",
    ui: "// hand-authored design.md boundary\n",
  };
}
