import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import {
  REQUIRED_DEBT_MARKERS,
  REQUIRED_DESIGN_ANCHORS,
  REQUIRED_EXAMPLE_KINDS,
  SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF,
  SDK_TYPECHECK_CONSUMERS,
  type ExampleConsumer,
  isParsedSdkObjectGraphProof,
  parseSdkObjectGraphProof,
  validateSdkObjectGraphProof,
} from "../src/sdk-object-graph-manifest-ir-shapes.js";
import { type JsonValue } from "../src/json.js";


test("HOBO-568 proof parses and covers the accepted SDK object graph shape", () => {
  const parsed = parseSdkObjectGraphProof(SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF);

  assert.equal(isParsedSdkObjectGraphProof(parsed), true);
  assert.equal(parsed.issue, "HOBO-568");
  assert.equal(parsed.parentIssue, "HOBO-566");
  assert.equal(parsed.phase, "M1");
  assert.deepEqual(validateSdkObjectGraphProof(parsed), []);
  assert.equal(parsed.compileConsumers[0]?.importFrom, "@hobo/bindles");

  for (const anchor of REQUIRED_DESIGN_ANCHORS) {
    assert.ok(parsed.designAnchors.includes(anchor));
  }
});

test("example consumers compile against the public interface shape and generated WIT binding names", () => {
  const desiredResourceExample = {
    kind: "desired-resource-graph",
    proofMode: "type-test",
    fixtureId: "sdk-object-graph.compile-consumer.minimal.v1",
    fixtureInput: "fixtures/input/minimal.sdk.ts",
    fixtureOutput: "fixtures/output/minimal.manifest.json",
    sdkSnippet: "bindle('minimal', b => ({ api: b.api(() => app.run()), cache: b.cache() }))",
    manifestIrContract: "resources[].generatedId + workload import boundary",
    expectedArtifact: "manifest-ir/minimal.resources.json",
    typeSurface: {
      importFrom: "@hobo/bindles",
      generatedBindings: ["hobo:sdk/bindle", "hobo:sdk/manifest"],
      manifestVersion: "hobo.manifest/v1",
      lowersTo: "hobo:sdk WIT bindings",
      compileProof: "type-test",
    },
  } satisfies ExampleConsumer;

  assert.equal(desiredResourceExample.typeSurface.importFrom, "@hobo/bindles");
  assert.ok(desiredResourceExample.typeSurface.generatedBindings.every((binding) => binding.startsWith("hobo:sdk/")));
});

test("typecheck consumers cover bindles, WIT bindings, manifest IR, resource refs, and typed client calls", () => {
  const consumer = SDK_TYPECHECK_CONSUMERS.todoApi;

  assert.equal(consumer.objectGraph.importFrom, "@hobo/bindles");
  assert.ok(consumer.manifestIr.generatedBindings.every((binding) => binding.module.startsWith("hobo:sdk/")));
  assert.equal(consumer.manifestIr.version, "hobo.manifest/v1");
  assert.ok(consumer.objectGraph.resources.some((resource) => resource.kind === "provider-capability"));
  assert.equal(consumer.typedClientCalls.deploymentPlanRequest.objective, "balanced");
  assert.deepEqual(consumer.typedClientCalls.migrationPlanRequest.phases, ["expand", "backfill", "contract"]);
  assert.equal(consumer.typedClientCalls.inspectReader.stream, "inspect");
  assert.equal(consumer.typedClientCalls.logReader.stream, "logs");
});

test("all required consumer examples have stable fixture ids and expected artifacts", () => {
  const parsed = parseSdkObjectGraphProof(SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF);
  const examplesByKind = new Map(parsed.exampleConsumers.map((example) => [example.kind, example]));

  for (const kind of REQUIRED_EXAMPLE_KINDS) {
    const example = examplesByKind.get(kind);
    assert.ok(example, `missing ${kind}`);
    assert.match(example.fixtureId, /^sdk-object-graph\./);
    assert.match(example.fixtureInput, /^fixtures\/input\/.+/);
    assert.match(example.fixtureOutput, /^fixtures\/output\/.+/);
    assert.match(example.expectedArtifact, /[a-z-]+\/[a-z0-9-]+\.json$/);
  }
});

test("raw provider and authoritative-external paths are surfaced as debt instead of hidden", () => {
  const parsed = parseSdkObjectGraphProof(SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF);
  const markers = new Map(parsed.debtMarkers.map((marker) => [marker.kind, marker]));
  const consumer = SDK_TYPECHECK_CONSUMERS.todoApi;

  for (const debtKind of REQUIRED_DEBT_MARKERS) {
    const marker = markers.get(debtKind);
    assert.ok(marker, `missing ${debtKind}`);
    assert.ok(marker.surfacedBy.length >= 2);
    assert.match(marker.authorMessage, /raw|external|adopted|provider/i);
  }

  assert.ok(consumer.manifestIr.rawProviderEdges.includes("azure.flexible-server"));
  assert.ok(consumer.manifestIr.authoritativeExternalResources.includes("billing-db"));
});

test("scope creep is rejected for live cloud, published SDK, production binding, and new semantic claims", () => {
  const invalid = structuredClone(SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF);
  invalid.scopeBoundary.in.push("Publish real @hobo/bindles with production bindings and live cloud provider execution.");

  assert.throws(() => parseSdkObjectGraphProof(invalid), /scope creep/i);
});

test("unsupported SDK semantics beyond WIT-first thin idiom layer are rejected", () => {
  const invalid = structuredClone(SDK_OBJECT_GRAPH_MANIFEST_IR_PROOF);
  invalid.exampleConsumers[0] = {
    ...invalid.exampleConsumers[0],
    manifestIrContract: "Adds new SDK semantics for runtime implementation retries",
  };

  assert.throws(() => parseSdkObjectGraphProof(invalid), /scope creep/i);
});

test("architecture artifacts reconcile protobuf, CUE, and Pact evidence for the package boundary", () => {
  const architectureDir = join(import.meta.dirname, "..", "architecture");
  const proto = readFileSync(join(architectureDir, "sdk_object_graph_manifest_ir_shapes.proto"), "utf8");
  const cue = readFileSync(join(architectureDir, "sdk_object_graph_manifest_ir_shapes.cue"), "utf8");
  // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
  const pact = JSON.parse(
    readFileSync(join(architectureDir, "pacts", "sdk_object_graph_manifest_ir_shapes.pact.json"), "utf8"),
  ) as { consumer: { name: string }; provider: { name: string }; interactions: JsonValue[] };

  assert.match(proto, /message SdkObjectGraphProof/);
  assert.match(cue, /#SdkObjectGraphProof/);
  assert.equal(pact.consumer.name, "HOBO-568 SDK object graph proof");
  assert.equal(pact.provider.name, "HoBo design proof registry");
  assert.ok(pact.interactions.length >= 1);
});
