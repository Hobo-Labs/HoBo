import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

import {
  assertNoForwardReverseDrift,
  buildComponentManifest,
  buildIdiomLayerSkeleton,
  compareForwardReverse,
  extractWitContract,
  reverseExtract,
} from "../src/reverse-extraction.js";

const packageRoot = join(import.meta.dirname, "..");
const witPath = join(packageRoot, "wit", "world.wit");
const cliPath = join(packageRoot, "bin", "reverse-extract.ts");
const fixturePath = join(packageRoot, "fixtures", "golden-component.imports-exports.json");
const generatedRoot = join(packageRoot, "generated");
const aggregateBindingPath = join(generatedRoot, "wit.d.ts");

async function readAuthoredContract() {
  return extractWitContract(await readFile(witPath, "utf8"));
}

test("jco emits the full hobo:sdk aggregate surface", async () => {
  const aggregate = await readFile(aggregateBindingPath, "utf8");
  const workflow = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-workflow.d.ts"), "utf8");
  const actor = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-actor.d.ts"), "utf8");
  const saga = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-saga.d.ts"), "utf8");
  const agent = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-agent.d.ts"), "utf8");
  const command = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-command.d.ts"), "utf8");
  const subscription = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-subscription.d.ts"), "utf8");
  const capability = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-capability.d.ts"), "utf8");
  const data = await readFile(join(generatedRoot, "interfaces", "hobo-sdk-data.d.ts"), "utf8");

  assert.match(aggregate, /export type \* as HoboSdkWorkflow010/);
  assert.match(aggregate, /export type \* as HoboSdkData010/);
  assert.match(workflow, /step\(/);
  assert.match(workflow, /compensate\(/);
  assert.match(actor, /send\(/);
  assert.match(actor, /ask\(/);
  assert.match(saga, /recordStep\(/);
  assert.match(agent, /invoke\(/);
  assert.match(command, /dispatch\(/);
  assert.match(subscription, /subscribe\(/);
  assert.match(capability, /allow\(/);
  assert.match(data, /append\(/);
});

test("reverse extraction reproduces authored imports and exports for the golden component", async () => {
  const contract = await readAuthoredContract();
  const manifest = buildComponentManifest(contract);
  const report = compareForwardReverse(contract, manifest);

  assert.equal(report.ok, true);
  assert.deepEqual(report.imports, { missing: [], extra: [] });
  assert.deepEqual(report.exports, { missing: [], extra: [] });
  assert.deepEqual(report.extracted.imports, [
    "actor",
    "agent",
    "capability",
    "command",
    "data",
    "saga",
    "subscription",
    "workflow",
  ]);
});

test("reverse extraction produces an idiom-layer skeleton from the shared hobo:sdk contract", async () => {
  const declaredWit = await readFile(witPath, "utf8");
  const { report, skeleton } = reverseExtract({ declaredWit, language: "typescript" });

  assert.equal(report.ok, true);
  assert.match(skeleton, /Generated typescript idiom-layer skeleton/);
  assert.match(skeleton, /Source contract: hobo:sdk@0\.1\.0 world sdk/);
  assert.match(skeleton, /export function recordStep\(\)/);
  assert.match(skeleton, /export function append\(\)/);
  assert.doesNotMatch(skeleton, /cloud|domain-record/i);
});

test("reverse-extraction CLI reproduces the golden artifact imports and exports", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "hobo-sdk-reverse-"));
  const reportPath = join(outputDir, "report.json");
  const skeletonPath = join(outputDir, "skeleton.ts");
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    cliPath,
    "--wit",
    witPath,
    "--artifact",
    fixturePath,
    "--report",
    reportPath,
    "--skeleton",
    skeletonPath,
  ]);

  assert.equal(result.status, 0, result.stderr.toString());
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const skeleton = await readFile(skeletonPath, "utf8");

  assert.equal(report.ok, true);
  assert.equal(report.artifact, "fixtures/golden-sdk-component.wasm");
  assert.deepEqual(report.imports, { missing: [], extra: [] });
  assert.deepEqual(report.exports, { missing: [], extra: [] });
  assert.match(skeleton, /export function subscribe\(\)/);
});

test("forward/reverse drift is a hard gate for missing and extra imports", async () => {
  const contract = await readAuthoredContract();
  const driftedManifest = buildComponentManifest(contract, {
    imports: contract.imports.filter((name) => name !== "data").concat("crypto"),
  });
  const report = compareForwardReverse(contract, driftedManifest);

  assert.equal(report.ok, false);
  assert.deepEqual(report.imports.missing, ["data"]);
  assert.deepEqual(report.imports.extra, ["crypto"]);
  assert.throws(
    () => assertNoForwardReverseDrift(report),
    /forward\/reverse WIT drift: missing imports: data; extra imports: crypto/,
  );
});

test("reverse-extraction CLI exits non-zero when the artifact surface drifts", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "hobo-sdk-drift-"));
  const artifactPath = join(outputDir, "drifted.imports-exports.json");
  await writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        artifact: "fixtures/drifted-sdk-component.wasm",
        imports: ["actor", "agent", "capability", "command", "crypto", "saga", "subscription", "workflow"],
        exports: [],
      },
      null,
      2,
    )}\n`,
  );

  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    cliPath,
    "--wit",
    witPath,
    "--artifact",
    artifactPath,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /forward\/reverse WIT drift detected/);
  const report = JSON.parse(result.stdout.toString());
  assert.deepEqual(report.imports, { missing: ["data"], extra: ["crypto"] });
});

test("forward/reverse drift is a hard gate for unexpected exports", async () => {
  const contract = await readAuthoredContract();
  const driftedManifest = buildComponentManifest(contract, { exports: ["workflow"] });
  const report = compareForwardReverse(contract, driftedManifest);

  assert.equal(report.ok, false);
  assert.deepEqual(report.exports.extra, ["workflow"]);
  assert.throws(() => buildIdiomLayerSkeleton(report), /extra exports: workflow/);
});

test("forward/reverse drift detects changed imported function signatures", async () => {
  const contract = await readAuthoredContract();
  const manifest = buildComponentManifest(contract);
  manifest.interfaces.workflow.functions = manifest.interfaces.workflow.functions.filter(
    (fn) => fn.name !== "compensate",
  );
  const report = compareForwardReverse(contract, manifest);

  assert.equal(report.ok, false);
  assert.deepEqual(report.signatureDrift, [
    { interface: "workflow", reason: "function signatures differ" },
  ]);
  assert.throws(() => assertNoForwardReverseDrift(report), /signature drift: workflow/);
});
