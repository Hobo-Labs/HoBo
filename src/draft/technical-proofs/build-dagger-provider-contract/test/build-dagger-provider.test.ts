import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureResourcePlan,
  createReferenceIacBackend,
  realizeFixtureProvider,
  wireBuildOutputs,
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  BUILD_DAGGER_PROVIDER_ID,
  BuildDaggerError,
  createBuildDaggerProvider,
  createFixtureContainerBuildSpec,
  deployFixtureIacProgram,
  runBuildDaggerConformance,
} from "../src/build-dagger-provider.js";

test("@hobo/build-dagger builds a reproducible container OCI ImageRef", async () => {
  const provider = createBuildDaggerProvider();
  const spec = createFixtureContainerBuildSpec();

  const first = await provider.build(spec);
  const second = await provider.build(spec);

  assert.equal(provider.id, BUILD_DAGGER_PROVIDER_ID);
  assert.equal(first.kind, "ImageRef");
  assert.equal(first.provider, BUILD_DAGGER_PROVIDER_ID);
  assert.equal(first.ref, second.ref);
  assert.equal(first.digest, second.digest);
  assert.equal(first.manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.equal(first.config.platform.architecture, "amd64");
  assert.equal(
    first.provenance.baseImage.digest,
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  );
});

test("BuildProvider ImageRef wires back into the fixture provider IacProgram and deploys", async () => {
  const provider = createBuildDaggerProvider();
  const emission = realizeContainerFixtureProvider();
  const artifact = emission.build.artifacts[0];
  const imageRef = await provider.build(
    createFixtureContainerBuildSpec({
      id: artifact.id,
      source: { path: artifact.source },
      target: artifact.target,
    }),
  );

  const wired = wireBuildOutputs(emission, {
    [artifact.id]: imageRef.ref,
  });
  const apiNode = wired.iac.nodes.find((node) => node.id === "api");
  const deployment = deployFixtureIacProgram(wired.iac);

  assert.deepEqual(apiNode.inputs.image, {
    artifactId: "api-image",
    imageRef: imageRef.ref,
  });
  assert.equal(createReferenceIacBackend().accept(wired).accepted, true);
  assert.equal(deployment.status, "deployed");
  assert.equal(
    deployment.events.some(
      (event) => event.type === "resource.Provisioned" && event.nodeId === "api" && event.imageRef === imageRef.ref,
    ),
    true,
  );
});

test("build-dagger conformance gates container BuildProvider behavior", async () => {
  const provider = createBuildDaggerProvider();
  const report = await runBuildDaggerConformance(provider, {
    wireImageRef: wireImageRefIntoFixtureProvider,
  });

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.deepEqual(report.coverage, [
    "build.container-image",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "exec-output.failure-logs",
    "target-arch.fail-closed",
  ]);
});

test("failing builds surface Dagger logs as exec.Output-style events", async () => {
  const provider = createBuildDaggerProvider();

  await assert.rejects(
    () =>
      provider.build(
        createFixtureContainerBuildSpec({
          pipeline: [
            { name: "install", command: "npm ci --ignore-scripts", deterministic: true },
            {
              name: "test",
              command: "npm test",
              deterministic: true,
              exitCode: 1,
              output: ["tests failed", "see /tmp/build.log"],
            },
          ],
        }),
    ),
    (error) => {
      assert.equal(error instanceof BuildDaggerError, true);
      assert.equal(error.name, "BuildDaggerError");
      assert.equal(error.code, "build-failed");
      assert.equal(
        error.events.some((event) => event.type === "exec.Output" && /tests failed/.test(event.message)),
        true,
      );
      assert.equal(error.events.at(-1).type, "exec.Failed");
      return true;
    },
  );
});

test("unpinned base images and non-reproducible pipelines fail closed", async () => {
  const provider = createBuildDaggerProvider();

  await assert.rejects(() => provider.build(createFixtureContainerBuildSpec({ baseImage: "node:24" })), {
    name: "BuildDaggerError",
    code: "unpinned-base-image",
    message: /base image must be pinned/,
  });

  await assert.rejects(
    () =>
      provider.build(
        createFixtureContainerBuildSpec({
          pipeline: [
            { name: "install", command: "npm ci --ignore-scripts", deterministic: true },
            { name: "stamp", command: "date > build.txt", deterministic: false },
          ],
        }),
      ),
    {
      name: "BuildDaggerError",
      code: "non-reproducible-pipeline",
      message: /stamp/,
    },
  );
});

test("budget and multi-arch mismatches fail before producing an ImageRef", async () => {
  const provider = createBuildDaggerProvider();

  await assert.rejects(
    () =>
      provider.build(
        createFixtureContainerBuildSpec({
          estimate: { seconds: 301, memoryMb: 512 },
        }),
      ),
    {
      name: "BuildDaggerError",
      code: "build-budget-exceeded",
      message: /time budget/,
    },
  );

  await assert.rejects(
    () =>
      provider.build(
        createFixtureContainerBuildSpec({
          platform: { os: "linux", architecture: "arm64" },
          platforms: [{ os: "linux", architecture: "amd64" }],
        }),
      ),
    {
      name: "BuildDaggerError",
      code: "missing-target-arch",
      message: /linux\/arm64/,
    },
  );
});

function realizeContainerFixtureProvider() {
  const plan = createFixtureResourcePlan();
  return realizeFixtureProvider({
    ...plan,
    resources: plan.resources.map((resource) => {
      if (resource.id !== "api") return resource;
      return {
        ...resource,
        build: {
          ...resource.build,
          target: "container",
        },
      };
    }),
  });
}

async function wireImageRefIntoFixtureProvider(imageRef, spec) {
  const emission = realizeContainerFixtureProvider();
  const wired = wireBuildOutputs(emission, {
    [spec.id]: imageRef.ref,
  });
  const apiNode = wired.iac.nodes.find((node) => node.id === spec.iacProgramRef.nodeId);
  const accepted = createReferenceIacBackend().accept(wired).accepted;
  const deployment = deployFixtureIacProgram(wired.iac);

  return {
    accepted: accepted && deployment.status === "deployed",
    imageRef: apiNode?.inputs?.image?.imageRef,
  };
}
