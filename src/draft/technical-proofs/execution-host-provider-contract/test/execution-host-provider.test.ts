import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createExecutionHostRegistry,
  createFixtureBuildProvider,
  createSelfHostedBuildMachineProvider,
  createSelfHostedRunnerProvider,
  selectExecutionHost,
  validateExecutionHostManifest,
} from "../src/execution-host-provider.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ledgerView(overrides = {}) {
  return {
    seq: overrides.seq ?? 42,
    balanceHash:
      overrides.balanceHash ??
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    balances: {
      "self-hosted": {
        "runner.minutes": { freeHeadroom: 0, marginalUnitCost: 0.02 },
        "build.minutes": { freeHeadroom: 0, marginalUnitCost: 0.03 },
      },
      github: {
        "runner.minutes": { freeHeadroom: 40, marginalUnitCost: 0.01 },
        "build.minutes": { freeHeadroom: 20, marginalUnitCost: 0.02 },
      },
      depot: {
        "runner.minutes": { freeHeadroom: 0, marginalUnitCost: 0.03 },
        "build.minutes": { freeHeadroom: 100, marginalUnitCost: 0.04 },
      },
      ...overrides.balances,
    },
  };
}

test("self-hosted RunnerProvider runs a fixture CI job and publishes cost facts", async () => {
  const runner = createSelfHostedRunnerProvider();
  const result = await runner.run({
    jobId: "ci-lint",
    command: "npm.cmd test",
    estimatedUnits: 2,
  });
  const manifest = runner.capabilityManifest();
  const validation = validateExecutionHostManifest(manifest, { category: "runner" });

  assert.equal(result.status, "succeeded");
  assert.equal(result.providerId, "self-hosted");
  assert.equal(result.category, "runner");
  assert.deepEqual(result.events.map((event) => event.type), [
    "runner.JobStarted",
    "runner.JobSucceeded",
  ]);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(manifest.capabilities[0].port, "hobo:runner");
  assert.equal(manifest.cost.facts[0].sku, "runner.minutes");
  assert.equal(manifest.cost.facts[0].source.type, "declared-provider");
});

test("self-hosted BuildMachineProvider delegates a fixture build to build-wasm and returns an ImageRef", async () => {
  const buildProvider = createFixtureBuildProvider();
  const buildMachine = createSelfHostedBuildMachineProvider({ buildProvider });

  const imageRef = await buildMachine.execute({
    buildId: "api-wasm",
    engine: "build-wasm",
    sourceRef: "git:main#apps/api",
    estimatedUnits: 3,
  });

  assert.deepEqual(buildProvider.calls.map((call) => call.hostProviderId), ["self-hosted"]);
  assert.deepEqual(imageRef, {
    mediaType: "application/vnd.wasm.content.layer.v1+wasm",
    uri: "oci://registry.example/hobo/api-wasm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
});

test("Dispatcher fixture ranks only registered execution hosts by declared cost evidence", () => {
  const registry = createExecutionHostRegistry([
    createSelfHostedRunnerProvider(),
    createSelfHostedRunnerProvider({ id: "github" }),
    createSelfHostedBuildMachineProvider({ id: "depot", buildProvider: createFixtureBuildProvider() }),
  ]);

  const decision = selectExecutionHost({
    category: "runner",
    dispatchId: "job-ci-lint",
    objective: "maximize-credits",
    units: 20,
    ledgerView: ledgerView(),
  }, registry);

  assert.equal(decision.selectedProvider, "github");
  assert.equal(decision.routingMode, "ranked");
  assert.deepEqual(decision.candidates.map((candidate) => candidate.providerId), [
    "github",
    "self-hosted",
  ]);
  assert.equal(decision.candidates.every((candidate) => candidate.costTrust === "declared-unverified"), true);
  assert.deepEqual(decision.dispatchDecided.data.ledgerInput, {
    view: "CreditLedgerView",
    seq: 42,
    reservationId: "reserve-job-ci-lint",
    balanceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
});

test("a pinned .with(...) provider opts out of routing but still must be registered", () => {
  const registry = createExecutionHostRegistry([
    createSelfHostedBuildMachineProvider({ id: "self-hosted", buildProvider: createFixtureBuildProvider() }),
    createSelfHostedBuildMachineProvider({ id: "depot", buildProvider: createFixtureBuildProvider() }),
  ]);

  const decision = selectExecutionHost({
    category: "build-machine",
    dispatchId: "build-api",
    objective: "maximize-credits",
    units: 20,
    withProvider: "self-hosted",
    ledgerView: ledgerView(),
  }, registry);

  assert.equal(decision.selectedProvider, "self-hosted");
  assert.equal(decision.routingMode, "pinned");
  assert.equal(decision.optedOutOfRouting, true);
  assert.deepEqual(decision.candidates.map((candidate) => candidate.providerId), ["self-hosted"]);
  assert.throws(
    () => selectExecutionHost({
      category: "build-machine",
      dispatchId: "build-api",
      objective: "maximize-credits",
      units: 20,
      withProvider: "blacksmith",
      ledgerView: ledgerView(),
    }, registry),
    /pinned provider blacksmith is not registered/,
  );
});

test("build-machine credit exhaustion fails before delegating the build", async () => {
  const buildProvider = createFixtureBuildProvider();
  const buildMachine = createSelfHostedBuildMachineProvider({
    buildProvider,
    creditBudget: { remainingUnits: 0 },
  });

  await assert.rejects(
    () => buildMachine.execute({
      buildId: "api-wasm",
      engine: "build-wasm",
      sourceRef: "git:main#apps/api",
      estimatedUnits: 1,
    }),
    (error) => {
      assert.equal(error.code, "credit.exhausted");
      assert.equal(error.providerId, "self-hosted");
      assert.equal(error.buildId, "api-wasm");
      return true;
    },
  );

  assert.equal(buildProvider.calls.length, 0);
});

test("type declarations publish the execution-host provider contract surface", async () => {
  const declarations = await readFile(
    path.join(packageRoot, "src", "execution-host-provider.d.ts"),
    "utf8",
  );

  assert.match(declarations, /export interface RunnerProvider/);
  assert.match(declarations, /run\(job: RunnerJob\): Promise<RunnerResult>/);
  assert.match(declarations, /export interface BuildMachineProvider/);
  assert.match(declarations, /execute\(build: BuildSpec\): Promise<ImageRef>/);
  assert.match(declarations, /capabilityManifest\(\): ExecutionHostCapabilityManifest/);
  assert.match(declarations, /createSelfHostedBuildMachineProvider\(options\?:/);
});
