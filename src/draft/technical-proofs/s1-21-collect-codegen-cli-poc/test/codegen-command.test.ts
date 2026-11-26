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
} from "../src/index.js";

test("hobo codegen writes the documented generated layout deterministically", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    const first = await cli.run(["codegen", "--json"], { cwd: projectRoot });
    const firstBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    const second = await cli.run(["codegen", "--json"], { cwd: projectRoot });
    const secondBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
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

test("--check fails with HOBO_CODEGEN_DRIFT after generated drift", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    await writeFile(join(projectRoot, "src/_generated/hooks.d.ts"), "// stale\n");
    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });

    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, "HOBO_CODEGEN_DRIFT");
    assert.equal(envelope.drift, true);
    assert.deepEqual(envelope.detail.drift.map((entry: { status: string; path: string }) => [entry.status, entry.path]), [
      ["changed", "src/_generated/hooks.d.ts"],
    ]);
  });
});

test("source parse errors name the offending file before tree mutation", async () => {
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

test("map and set ordering is normalized so --check cannot flap", async () => {
  const forward = await generateCodegenArtifacts({ sources: fixtureSources() });
  const reverse = await generateCodegenArtifacts({ sources: fixtureSources({ reverse: true }) });
  assert.deepEqual(reverse, forward);
});

test("non-TypeScript guests fail with HOBO_CODEGEN_STATIC_ANALYSIS_REQUIRED", async () => {
  await withTempProject(async (projectRoot) => {
    const result = await createCodegenCli().run(
      ["codegen", "--guest-language", "python", "--json"],
      { cwd: projectRoot },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).code, "HOBO_CODEGEN_STATIC_ANALYSIS_REQUIRED");
  });
});

test("unknown codegen flags exit 2 with usage error", async () => {
  await withTempProject(async (projectRoot) => {
    const result = await createCodegenCli().run(["codegen", "--bogus", "--json"], { cwd: projectRoot });
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stdout).code, "HOBO_CODEGEN_USAGE");
  });
});

test("generated TypeScript tree type-checks for a guest consumer", async () => {
  await withTempProject(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    await typecheckGeneratedTree(projectRoot);
  });
});
