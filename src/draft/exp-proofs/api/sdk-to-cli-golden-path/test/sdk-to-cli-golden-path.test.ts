import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  createSdkToCliGoldenPathProof,
  validateSdkToCliGoldenPathProof,
} from "../src/sdk-to-cli-golden-path.js";

test("golden path links SDK consumer, manifest IR, CLI transcript, API, MCP, and proof note through the same fixture id", () => {
  const proof = createSdkToCliGoldenPathProof();

  assert.equal(proof.issue, "HOBO-576");
  assert.equal(proof.fixtureId, "dx.lifecycle.shop-api.v1");
  assert.match(proof.sdkConsumer.source, /bindle\("shop-api"/);
  assert.equal(proof.manifestIr.fixtureId, proof.fixtureId);
  assert.equal(proof.cliTranscript.fixtureId, proof.fixtureId);
  assert.equal(proof.apiContract.fixtureId, proof.fixtureId);
  assert.equal(proof.mcpResult.fixtureId, proof.fixtureId);
  assert.equal(proof.proofNote, "docs/design/proofs/sdk-to-cli-golden-path/README.md");
  assert.deepEqual(validateSdkToCliGoldenPathProof(proof), { ok: true, errors: [] });
});

test("compile proof keeps cloud logic out of the SDK consumer and pins typed results", () => {
  const proof = createSdkToCliGoldenPathProof();

  assert.equal(proof.sdkConsumer.compileCheck.command, "tsc --noEmit src/consumer.ts");
  assert.deepEqual(proof.sdkConsumer.imports, ["@hobo/bindles", "@hobo/sdk/results"]);
  assert.equal(proof.sdkConsumer.containsCloudProviderLogic, false);
  assert.deepEqual(
    proof.typeProof.expectedResultKinds,
    ["success", "gatekeeper-denied", "contract-incompatible", "stale-or-unknown-evidence", "support-handoff"],
  );
});

test("transcript proves happy, blocked, stale or unknown evidence, and support handoff paths", () => {
  const proof = createSdkToCliGoldenPathProof();

  assert.deepEqual(
    proof.cliTranscript.steps.map((step) => `${step.command}:${step.resultKind}`),
    [
      "hobo collect:success",
      "hobo plan:success",
      "hobo up:success",
      "hobo up:gatekeeper-denied",
      "hobo plan:contract-incompatible",
      "hobo inspect deploy:stale-or-unknown-evidence",
      "hobo doctor:support-handoff",
    ],
  );
  assert.equal(proof.cliTranscript.steps.every((step) => step.fixtureId === proof.fixtureId), true);
  assert.equal(proof.cliTranscript.steps.every((step) => step.proofMode), true);
});

test("same fixture id links SDK, CLI, API shape, MCP result, and proof README", () => {
  const proof = createSdkToCliGoldenPathProof();

  assert.deepEqual(proof.apiContract.operations.map((operation) => operation.fixtureId), [
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
  ]);
  assert.deepEqual(proof.mcpResult.tools.map((tool) => tool.fixtureId), [
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
  ]);
  assert.deepEqual(proof.handoffs.map((handoff) => handoff.consumesFixtureId), [
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
    proof.fixtureId,
  ]);
});

test("contract artifacts name protobuf, CUE, and Pact fixture boundaries", () => {
  const proof = createSdkToCliGoldenPathProof();

  assert.deepEqual(proof.contractArtifacts, {
    protobuf: "architecture/sdk_to_cli_golden_path.proto",
    cue: "architecture/sdk_to_cli_golden_path.cue",
    pact: "architecture/pacts/sdk_to_cli_golden_path.pact.json",
  });
});

test("proof README and contract artifacts exist and preserve scope-out boundaries", () => {
  const packageReadme = readPackageFile("README.md");
  const packageAdr = readPackageFile("ADR.md");
  const proto = readPackageFile("architecture/sdk_to_cli_golden_path.proto");
  const cue = readPackageFile("architecture/sdk_to_cli_golden_path.cue");
  const pact = JSON.parse(readPackageFile("architecture/pacts/sdk_to_cli_golden_path.pact.json"));
  const proofReadme = readRepoFile("docs/design/proofs/sdk-to-cli-golden-path/README.md");

  assert.match(packageReadme, /dx\.lifecycle\.shop-api\.v1/);
  assert.match(packageAdr, /sdkToCliGoldenPath\.TranscriptAccepted/);
  assert.match(proto, /message SdkToCliGoldenPathRecord/);
  assert.match(cue, /#SdkToCliGoldenPathRecord/);
  assert.equal(pact.interactions[0].response.body.issue, "HOBO-576");
  assert.match(proofReadme, /No production app scaffold, real deploy URL, package publication/);
});

test("validation rejects scope creep into production deploys, package publishing, live MCP, or dashboard screenshots", () => {
  const result = validateSdkToCliGoldenPathProof({
    ...createSdkToCliGoldenPathProof(),
    scopeClaims: [
      "Publish @hobo/bindles and run a real deploy URL through a live MCP server with dashboard screenshots.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

function readPackageFile(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");
}
