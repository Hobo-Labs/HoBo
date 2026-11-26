import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  compareGeneratedTree,
  createCodegenCli,
  generateCodegenArtifacts,
  writeFixtureProject,
  writeGeneratedTree,
} from "../src/index.js";

async function withHelloBindleCopy(callback: (projectRoot: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hello-bindle-drift-"));
  try {
    await writeFixtureProject(dir);
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("codegen-check-drift: clean tree passes --check", async () => {
  await withHelloBindleCopy(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).drift, false);
  });
});

test("codegen-check-drift: seeded one-line drift fails with HOBO_CODEGEN_DRIFT and zero mutation", async () => {
  await withHelloBindleCopy(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    const bindingsPath = join(projectRoot, "src/_generated/bindings.d.ts");
    const before = await readFile(bindingsPath, "utf8");
    await writeFile(bindingsPath, `${before}// drift seed\n`);

    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    const after = await readFile(bindingsPath, "utf8");

    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, "HOBO_CODEGEN_DRIFT");
    assert.ok(
      envelope.detail.drift.some(
        (entry: { path: string; status: string }) =>
          entry.path === "src/_generated/bindings.d.ts" && entry.status === "changed",
      ),
    );
    assert.equal(after, `${before}// drift seed\n`);
  });
});

test("codegen-check-drift: deleted generated file reports missing drift", async () => {
  await withHelloBindleCopy(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);

    const workflowsPath = join(projectRoot, "src/_generated/workflows.d.ts");
    const before = await readFile(workflowsPath, "utf8");
    await rm(workflowsPath);

    const result = await cli.run(["codegen", "--check", "--json"], { cwd: projectRoot });
    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, "HOBO_CODEGEN_DRIFT");
    assert.ok(
      envelope.detail.drift.some(
        (entry: { path: string; status: string }) =>
          entry.path === "src/_generated/workflows.d.ts" && entry.status === "missing",
      ),
    );

    await writeFile(workflowsPath, before);
  });
});

test("codegen-check-drift: --check never mutates tree when drift present", async () => {
  await withHelloBindleCopy(async (projectRoot) => {
    const artifacts = await generateCodegenArtifacts({ projectRoot });
    await writeGeneratedTree(projectRoot, artifacts);
    await writeFile(join(projectRoot, "src/_generated/workflows.d.ts"), "// drift\n");

    const before = await readFile(join(projectRoot, "src/_generated/workflows.d.ts"), "utf8");
    const result = await createCodegenCli().run(["codegen", "--check"], { cwd: projectRoot });
    const after = await readFile(join(projectRoot, "src/_generated/workflows.d.ts"), "utf8");

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Generated tree drift/);
    assert.equal(after, before);
  });
});

test("second consecutive codegen run leaves tree byte-identical", async () => {
  await withHelloBindleCopy(async (projectRoot) => {
    const cli = createCodegenCli();
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    const firstBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    assert.equal((await cli.run(["codegen"], { cwd: projectRoot })).exitCode, 0);
    const secondBindings = await readFile(join(projectRoot, "src/_generated/bindings.d.ts"), "utf8");
    assert.equal(secondBindings, firstBindings);
    assert.deepEqual(await compareGeneratedTree(projectRoot, await generateCodegenArtifacts({ projectRoot })), []);
  });
});
