import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { componentizeHelloBindle } from "../../../../../packages/componentize/src/index.js";
import { createBuildCli, runBuild, writeBuildFixtureProject } from "../src/index.js";
import {
  executeCodegenRequest,
  generateCodegenArtifacts,
} from "../../../technical-proofs/hobo-codegen-cli-contract/src/codegen-cli-contract.js";

const GOLDEN_DIGEST = JSON.parse(
  readFileSync(new URL("./fixtures/hello-bindle.digest.json", import.meta.url), "utf8"),
);

const HELLO_BINDLE_EXAMPLE = new URL(
  "../../../../../packages/componentize/test/fixtures/hello-bindle",
  import.meta.url,
);

test("runBuild digest matches componentize direct path and golden S0-07 fixture", async () => {
  const direct = await componentizeHelloBindle({
    sourceRoot: HELLO_BINDLE_EXAMPLE,
    sourceDateEpoch: GOLDEN_DIGEST.sourceDateEpoch,
  });

  assert.equal(direct.component.digest, GOLDEN_DIGEST.digest);

  await withHelloBindleProject(async (projectRoot) => {
    const buildResult = await runBuild({
      json: true,
      projectRoot,
      targetRuntime: "auto",
      sourceDateEpoch: GOLDEN_DIGEST.sourceDateEpoch,
    });

    const helloArtifact = buildResult.artifacts.find((artifact) => artifact.service === "hello-bindle");
    assert.equal(helloArtifact?.digest, direct.component.digest);
    assert.equal(helloArtifact?.digest, GOLDEN_DIGEST.digest);
  });
});

test("CLI envelope digest matches golden fixture for hello-bindle-only project", async () => {
  await withHelloBindleProject(async (projectRoot) => {
    const cli = await createBuildCli().run(["build", "--json"], {
      cwd: projectRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: GOLDEN_DIGEST.sourceDateEpoch },
    });
    const envelope = JSON.parse(cli.stdout);
    const helloArtifact = envelope.artifacts.find((artifact) => artifact.service === "hello-bindle");
    assert.equal(helloArtifact?.digest, GOLDEN_DIGEST.digest);
  });
});

async function withHelloBindleProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-parity-"));
  try {
    await writeBuildFixtureProject(projectRoot, {
      services: [
        {
          name: "hello-bindle",
          language: "ts",
          runtime: "wasm",
          sourceRoot: "services/hello-bindle",
          entrypoint: "services/hello-bindle/src/service.ts",
        },
      ],
    });
    await seedGeneratedTree(projectRoot);
    await copyHelloBindleSources(projectRoot);
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function copyHelloBindleSources(projectRoot) {
  const target = join(projectRoot, "services/hello-bindle/src/service.ts");
  const source = fileURLToPath(
    new URL("../../../../../packages/componentize/test/fixtures/hello-bindle/src/service.ts", import.meta.url),
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source, "utf8"));
}

async function seedGeneratedTree(projectRoot) {
  await executeCodegenRequest({
    projectRoot,
    check: false,
    guestLanguage: "ts",
    engine: generateCodegenArtifacts,
  });
}
