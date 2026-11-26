import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  BUILD_MANIFEST_PATH,
  createBuildCli,
  writeBuildFixtureProject,
} from "../src/build-cli-contract.js";
import {
  executeCodegenRequest,
  generateCodegenArtifacts,
} from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";

test("hobo build emits wasm and OCI fallback artifacts with JSON digests", async () => {
  await withSeededBuildProject(async (projectRoot) => {
    const result = await createBuildCli().run(["build", "--json"], { cwd: projectRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "build");
    assert.equal(envelope.manifest, BUILD_MANIFEST_PATH);
    assert.equal(envelope.artifacts.length, 2);

    const artifacts = byService(envelope.artifacts);
    assert.equal(artifacts.get("hello-bindle").kind, "wasm-component");
    assert.match(artifacts.get("hello-bindle").digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(artifacts.get("legacy-worker").kind, "oci-container");
    assert.equal(artifacts.get("legacy-worker").fallbackReason, "unsupported-language: python");
    assert.match(artifacts.get("legacy-worker").digest, /^sha256:[a-f0-9]{64}$/);

    const manifest = JSON.parse(await readFile(join(projectRoot, BUILD_MANIFEST_PATH), "utf8"));
    assert.deepEqual(manifest.artifacts, envelope.artifacts);
  });
});

test("hobo build accepts SOURCE_DATE_EPOCH as Unix seconds", async () => {
  await withSeededBuildProject(async (projectRoot) => {
    const result = await createBuildCli().run(["build", "--json"], {
      cwd: projectRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: "1704067200" },
    });

    assert.equal(result.exitCode, 0);
    const manifest = JSON.parse(await readFile(join(projectRoot, BUILD_MANIFEST_PATH), "utf8"));
    assert.equal(manifest.sourceDateEpoch, "2024-01-01T00:00:00.000Z");
  });
});

test("hobo build digests are stable on repeat and across clean checkouts", async () => {
  let cleanCheckoutArtifacts;

  await withSeededBuildProject(async (projectRoot) => {
    const first = JSON.parse(
      (await createBuildCli().run(["build", "--json"], { cwd: projectRoot })).stdout,
    );
    const second = JSON.parse(
      (await createBuildCli().run(["build", "--json"], { cwd: projectRoot })).stdout,
    );

    assert.deepEqual(second.artifacts, first.artifacts);
    cleanCheckoutArtifacts = first.artifacts;
  });

  await withSeededBuildProject(async (projectRoot) => {
    const fresh = JSON.parse(
      (await createBuildCli().run(["build", "--json"], { cwd: projectRoot })).stdout,
    );

    assert.deepEqual(fresh.artifacts, cleanCheckoutArtifacts);
  });
});

test("stale _generated tree fails with a regeneration hint before build output", async () => {
  await withSeededBuildProject(async (projectRoot) => {
    await writeFile(join(projectRoot, "src/_generated/hooks.d.ts"), "stale generated file\n");

    const result = await createBuildCli().run(["build", "--json"], { cwd: projectRoot });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, "HOBO_BUILD_CODEGEN_DRIFT");
    assert.match(envelope.message, /hobo codegen/);
    await assertMissing(join(projectRoot, BUILD_MANIFEST_PATH));
  });
});

test("componentize failure names service and cause without writing a manifest", async () => {
  await withTempBuildProject(async (projectRoot) => {
    await writeBuildFixtureProject(projectRoot, {
      services: [
        {
          name: "aaa-legacy-worker",
          language: "python",
          runtime: "container",
          sourceRoot: "services/legacy-worker",
          entrypoint: "services/legacy-worker/src/app.py",
        },
        {
          name: "hello-bindle",
          language: "ts",
          runtime: "wasm",
          sourceRoot: "services/hello-bindle",
          entrypoint: "services/hello-bindle/src/service.ts",
        },
      ],
      helloSource: 'export const health = () => ({ body: "bad", nonce: Date.now() });\n',
    });
    await seedGeneratedTree(projectRoot);

    const result = await createBuildCli().run(["build", "--json"], { cwd: projectRoot });
    const envelope = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(envelope.code, "HOBO_BUILD_COMPONENTIZE_FAILED");
    assert.equal(envelope.detail.service, "hello-bindle");
    assert.match(envelope.detail.cause, /componentize\.nondeterministic_source/);
    await assertMissing(join(projectRoot, ".hobo/build/artifacts/aaa-legacy-worker.oci.json"));
    await assertMissing(join(projectRoot, BUILD_MANIFEST_PATH));
  });
});

test("HOBO_RUNTIME container forces declared wasm services through OCI fallback with reason", async () => {
  await withSeededBuildProject(async (projectRoot) => {
    const result = await createBuildCli().run(["build", "--json"], {
      cwd: projectRoot,
      env: { ...process.env, HOBO_RUNTIME: "container" },
    });

    assert.equal(result.exitCode, 0);
    const artifacts = byService(JSON.parse(result.stdout).artifacts);
    assert.equal(artifacts.get("hello-bindle").kind, "oci-container");
    assert.equal(artifacts.get("hello-bindle").fallbackReason, "target-runtime: container");
    assert.equal(artifacts.get("legacy-worker").kind, "oci-container");
    assert.equal(artifacts.get("legacy-worker").fallbackReason, "unsupported-language: python");
  });
});

test("declared container runtime records declared-runtime fallback for wasm-capable services", async () => {
  await withTempBuildProject(async (projectRoot) => {
    await writeBuildFixtureProject(projectRoot, {
      services: [
        {
          name: "queue-worker",
          language: "ts",
          runtime: "container",
          sourceRoot: "services/queue-worker",
          entrypoint: "services/queue-worker/src/service.ts",
        },
      ],
    });
    await seedGeneratedTree(projectRoot);

    const result = await createBuildCli().run(["build", "--json"], { cwd: projectRoot });
    const artifacts = byService(JSON.parse(result.stdout).artifacts);

    assert.equal(result.exitCode, 0);
    assert.equal(artifacts.get("queue-worker").kind, "oci-container");
    assert.equal(artifacts.get("queue-worker").fallbackReason, "declared-runtime: container");
  });
});

async function withSeededBuildProject(callback) {
  return withTempBuildProject(async (projectRoot) => {
    await writeBuildFixtureProject(projectRoot);
    await seedGeneratedTree(projectRoot);
    return callback(projectRoot);
  });
}

async function withTempBuildProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-"));
  try {
    return await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function seedGeneratedTree(projectRoot) {
  await executeCodegenRequest({
    projectRoot,
    check: false,
    guestLanguage: "ts",
    engine: generateCodegenArtifacts,
  });
}

function byService(artifacts) {
  return new Map(artifacts.map((artifact) => [artifact.service, artifact]));
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}
