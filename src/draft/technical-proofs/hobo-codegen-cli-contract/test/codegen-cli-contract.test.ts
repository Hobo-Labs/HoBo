import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  compareGeneratedTree,
  createCodegenCli,
  fixtureSources,
  generateCodegenArtifacts,
  typecheckGeneratedTree,
  withTempProject,
  writeGeneratedTree,
} from "../src/codegen-cli-contract.js";

test("hobo codegen writes the documented generated layout deterministically", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    const first = await cli.run(["codegen", "--json"], { cwd: projectRoot });
    const firstBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const firstManifest = await readFile(join(projectRoot, ".hobo/generated/codegen-manifest.json"), "utf8");
    const second = await cli.run(["codegen", "--json"], { cwd: projectRoot });
    const secondBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const secondManifest = await readFile(join(projectRoot, ".hobo/generated/codegen-manifest.json"), "utf8");
    const generated = await generateCodegenArtifacts({ projectRoot });

    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(JSON.parse(first.stdout).written, [
      ".hobo/generated/codegen-manifest.json",
      "src/_generated/api-tree.d.ts",
      "src/_generated/bindings.d.ts",
      "src/_generated/hooks.d.ts",
      "src/_generated/steps.d.ts",
      "src/_generated/with-options.d.ts",
      "src/_generated/workflows.d.ts",
    ]);
    assert.deepEqual(await compareGeneratedTree(projectRoot, generated), []);
    assert.equal(secondBindings, firstBindings);
    assert.equal(secondManifest, firstManifest);
  });
});

test("--check passes on a fresh tree and never mutates the working tree", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    const before = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    const after = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");

    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).drift, false);
    assert.equal(after, before);
  });
});

test("--check fails with a clear diff after source or generated drift", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    await writeFile(join(projectRoot, "src/_generated/hooks.d.ts"), "// stale\n");
    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });

    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, "HOBO_CODEGEN_DRIFT");
    assert.equal(envelope.drift, true);
    assert.deepEqual(envelope.detail.drift.map((entry) => [entry.status, entry.path]), [
      ["changed", "src/_generated/hooks.d.ts"],
    ]);
  });
});

test("--check fails after a valid source edit without rewriting generated files", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    const before = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const sourcePath = join(projectRoot, ".hobo/sources/zod/resources.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    source.resources.ticket.fields.description = { type: "string" };
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    const after = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const driftPaths = JSON.parse(result.stdout).detail.drift.map((entry) => entry.path);

    assert.equal(result.exitCode, 1);
    assert.ok(driftPaths.includes(".hobo/generated/codegen-manifest.json"));
    assert.ok(driftPaths.includes("src/_generated/bindings.d.ts"));
    assert.equal(after, before);
  });
});

test("generated TypeScript tree type-checks for a guest consumer", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    await typecheckGeneratedTree(projectRoot);
  });
});

test("map and set ordering is normalized so --check cannot flap", async () => {
  const forward = await generateCodegenArtifacts({ sources: fixtureSources() });
  const reverse = await generateCodegenArtifacts({ sources: fixtureSources({ reverse: true }) });

  assert.deepEqual(reverse, forward);
});

test("source parse errors name the offending file and do not half-write the generated tree", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    const before = await readFile(join(projectRoot, "src/_generated/api-tree.d.ts"), "utf8");
    await writeFile(join(projectRoot, ".hobo/sources/zod/resources.json"), "{ broken json\n");
    const result = await cli.run(["codegen", "--json"], { cwd: projectRoot });
    const after = await readFile(join(projectRoot, "src/_generated/api-tree.d.ts"), "utf8");

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).detail.file, ".hobo/sources/zod/resources.json");
    assert.equal(after, before);
  });
});

test("--check does not mutate when drift is present", async () => {
  await withTempProject(async (projectRoot) => {
    const artifacts = await generateCodegenArtifacts({ projectRoot });
    await writeGeneratedTree(projectRoot, artifacts);
    await writeFile(join(projectRoot, "src/_generated/workflows.d.ts"), "// drift\n");

    const before = await readFile(join(projectRoot, "src/_generated/workflows.d.ts"), "utf8");
    const result = await createCodegenCli().run(["codegen", "--check"], { cwd: projectRoot });
    const after = await readFile(join(projectRoot, "src/_generated/workflows.d.ts"), "utf8");

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Generated tree drift/);
    assert.match(result.stderr, /CHANGED src\/_generated\/workflows\.d\.ts/);
    assert.equal(after, before);
  });
});

test("non-TypeScript guests fail with a static-analysis-required diagnostic", async () => {
  await withTempProject(async (projectRoot) => {
    const result = await createCodegenCli().run(
      ["codegen", "--guest-language", "python", "--json"],
      { cwd: projectRoot },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).code, "HOBO_CODEGEN_STATIC_ANALYSIS_REQUIRED");
    assert.match(JSON.parse(result.stdout).message, /static-analysis required/);
  });
});
