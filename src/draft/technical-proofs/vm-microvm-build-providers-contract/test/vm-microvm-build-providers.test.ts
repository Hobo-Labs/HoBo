import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureResourcePlan,
  createReferenceIacBackend,
  realizeFixtureProvider,
  wireBuildOutputs,
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  FIRECRACKER_PROVIDER_ID,
  PACKER_PROVIDER_ID,
  VAGRANT_PROVIDER_ID,
  createFirecrackerBuildProvider,
  createFixtureMicroVmBuildSpec,
  createFixtureVagrantBuildSpec,
  createFixtureVmBuildSpec,
  createPackerBuildProvider,
  createVagrantBuildProvider,
  runVmMicroVmBuildConformance,
} from "../src/vm-microvm-build-providers.js";

test("@hobo/build-packer produces reproducible VM ImageRefs and wires them into fixture IacPrograms", async () => {
  const provider = createPackerBuildProvider();
  const spec = createFixtureVmBuildSpec();

  const first = await provider.build(spec);
  const second = await provider.build(spec);

  assert.equal(provider.id, PACKER_PROVIDER_ID);
  assert.equal(first.kind, "ImageRef");
  assert.equal(first.apiVersion, "hobo.imageRef/v1");
  assert.equal(first.provider, PACKER_PROVIDER_ID);
  assert.equal(first.artifactId, spec.id);
  assert.equal(first.ref, second.ref);
  assert.equal(first.digest, second.digest);
  assert.equal(first.image.kind, "vm-image");
  assert.equal(first.image.os, "ubuntu-24.04");
  assert.equal(first.image.arch, "x86_64");
  assert.deepEqual(first.image.providerArtifacts, [
    {
      provider: "aws",
      artifact: "ami",
      region: "us-east-1",
      arch: "x86_64",
      imageId: "ami-api-vm-image-us-east-1-x86-64",
    },
    {
      provider: "azure",
      artifact: "managed-image",
      region: "eastus",
      arch: "x86_64",
      imageId: "azure-api-vm-image-eastus-x86-64",
    },
  ]);
  assert.equal(first.provenance.toolchain.packer, "1.11.2");
  assert.equal(
    first.provenance.toolchain.digests.packer,
    "sha256:d3b9836a8f53d1fdc28936908f5cd04dbf61d7ac4f8d87e3f2bb3753a546187a",
  );
  assert.deepEqual(first.provenance.reproducibility, [
    "SOURCE_DATE_EPOCH",
    "canonical BuildSpec",
    "pinned VM toolchain",
    "content-addressed image manifest",
  ]);

  assert.deepEqual(await wireImageRefIntoFixtureProvider(first, spec), {
    accepted: true,
    imageRef: first.ref,
    target: "vm",
  });
});

test("@hobo/build-firecracker produces executor-consumable microVM rootfs ImageRefs", async () => {
  const provider = createFirecrackerBuildProvider();
  const spec = createFixtureMicroVmBuildSpec();

  const imageRef = await provider.build(spec);

  assert.equal(provider.id, FIRECRACKER_PROVIDER_ID);
  assert.equal(imageRef.kind, "ImageRef");
  assert.equal(imageRef.provider, FIRECRACKER_PROVIDER_ID);
  assert.equal(imageRef.artifactId, spec.id);
  assert.equal(imageRef.image.kind, "microvm-rootfs");
  assert.equal(imageRef.image.executorBase, true);
  assert.equal(imageRef.image.kernel.version, "6.8.12-hobo-fc");
  assert.deepEqual(imageRef.image.kernel.modules, ["virtio-blk", "virtio-net", "overlayfs"]);
  assert.equal(imageRef.image.rootfs.format, "ext4");
  assert.equal(imageRef.provenance.toolchain.firecracker, "1.10.1");
  assert.equal(imageRef.provenance.toolchain.digests.firecracker, spec.toolchain.digests.firecracker);
  assert.deepEqual(await wireImageRefIntoFixtureProvider(imageRef, spec), {
    accepted: true,
    imageRef: imageRef.ref,
    target: "microVm",
  });

  await assert.rejects(
    () =>
      createFirecrackerBuildProvider({
        rootfsBuilder: async () => ({
          kernel: {
            version: "6.8.12-hobo-fc",
            modules: ["virtio-blk", "overlayfs"],
          },
          rootfs: {
            format: "ext4",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sizeBytes: 268435456,
          },
          executorBase: true,
        }),
      }).build(spec),
    {
      name: "VmMicroVmBuildProviderError",
      code: "missing-firecracker-kernel-module",
      message: /virtio-net/,
    },
  );
});

test("@hobo/build-vagrant produces local VM boxes with honest production parity", async () => {
  const prodImageRef = await createPackerBuildProvider().build(createFixtureVmBuildSpec());
  const provider = createVagrantBuildProvider();
  const spec = createFixtureVagrantBuildSpec({ prodImageRef });

  const first = await provider.build(spec);
  const second = await provider.build(spec);

  assert.equal(provider.id, VAGRANT_PROVIDER_ID);
  assert.equal(first.kind, "ImageRef");
  assert.equal(first.provider, VAGRANT_PROVIDER_ID);
  assert.equal(first.ref, second.ref);
  assert.equal(first.image.kind, "local-vm-box");
  assert.equal(first.image.box.provider, "virtualbox");
  assert.equal(first.localParity.productionImageRef, prodImageRef.ref);
  assert.deepEqual(first.localParity.claim, {
    os: "ubuntu-24.04",
    arch: "x86_64",
    toolchainProfile: "prod-vm-dev-parity",
    productionImageDigest: prodImageRef.digest,
    fidelity: "simulated",
    campRequiredForProdReady: true,
  });
  assert.deepEqual(await wireImageRefIntoFixtureProvider(first, spec), {
    accepted: true,
    imageRef: first.ref,
    target: "localVm",
  });

  await assert.rejects(
    () =>
      createVagrantBuildProvider({
        boxBuilder: async () => ({
          box: {
            provider: "virtualbox",
            format: "box",
            digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sizeBytes: 805306368,
          },
          localParity: {
            os: "debian-12",
            arch: "x86_64",
            toolchainProfile: "prod-vm-dev-parity",
            productionImageDigest: prodImageRef.digest,
            fidelity: "simulated",
            campRequiredForProdReady: true,
          },
        }),
      }).build(spec),
    {
      name: "VmMicroVmBuildProviderError",
      code: "local-fidelity-drift",
      message: /os expected ubuntu-24\.04 got debian-12/,
    },
  );
  await assert.rejects(
    () =>
      createVagrantBuildProvider({
        boxBuilder: async () => ({
          box: {
            provider: "virtualbox",
            format: "box",
            digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sizeBytes: 805306368,
          },
          localParity: {
            os: "ubuntu-24.04",
            arch: "x86_64",
            toolchainProfile: "prod-vm-dev-parity",
            productionImageDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            fidelity: "simulated",
            campRequiredForProdReady: true,
          },
        }),
      }).build(spec),
    {
      name: "VmMicroVmBuildProviderError",
      code: "local-fidelity-drift",
      message: /productionImageDigest expected sha256:/,
    },
  );
});

test("VM/microVM build-provider conformance gates all adapters and fails on digest drift", async () => {
  const report = await runVmMicroVmBuildConformance(
    {
      packer: createPackerBuildProvider(),
      firecracker: createFirecrackerBuildProvider(),
      vagrant: createVagrantBuildProvider(),
    },
    { wireImageRef: wireImageRefIntoFixtureProvider },
  );

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.deepEqual(report.coverage, [
    "build.packer.vm-image",
    "build.firecracker.microvm-rootfs",
    "build.vagrant.local-vm-box",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "target.fail-closed",
    "adversarial.fail-closed",
  ]);

  await assert.rejects(
    () =>
      runVmMicroVmBuildConformance(
        {
          packer: createPackerBuildProvider({ baker: createDriftingVmBaker() }),
          firecracker: createFirecrackerBuildProvider(),
          vagrant: createVagrantBuildProvider(),
        },
        { wireImageRef: wireImageRefIntoFixtureProvider },
      ),
    {
      name: "VmMicroVmBuildProviderError",
      code: "non-reproducible-build",
    },
  );
});

test("providers fail closed for unsupported targets, unusable provider targets, and toolchain drift", async () => {
  const packer = createPackerBuildProvider();
  const firecracker = createFirecrackerBuildProvider();
  const vagrant = createVagrantBuildProvider();

  await assert.rejects(() => packer.build(createFixtureVmBuildSpec({ target: "wasm-component" })), {
    name: "VmMicroVmBuildProviderError",
    code: "unsupported-target",
    message: /target wasm-component is not vm/,
  });
  await assert.rejects(() => firecracker.build(createFixtureMicroVmBuildSpec({ target: "vm" })), {
    name: "VmMicroVmBuildProviderError",
    code: "unsupported-target",
    message: /target vm is not microVm/,
  });
  await assert.rejects(() => vagrant.build(createFixtureVagrantBuildSpec({ target: "vm" })), {
    name: "VmMicroVmBuildProviderError",
    code: "unsupported-target",
    message: /target vm is not localVm/,
  });

  await assert.rejects(
    () =>
      packer.build(
        createFixtureVmBuildSpec({
          providerTargets: [
            {
              provider: "aws",
              artifact: "ami",
              region: "antarctica-1",
              arch: "x86_64",
            },
          ],
        }),
      ),
    {
      name: "VmMicroVmBuildProviderError",
      code: "unsupported-provider-target",
      message: /aws antarctica-1/,
    },
  );
  await assert.rejects(
    () =>
      packer.build(
        createFixtureVmBuildSpec({
          providerTargets: [
            {
              provider: "aws",
              artifact: "ami",
              region: "us-east-1",
              arch: "sparc64",
            },
          ],
        }),
      ),
    {
      name: "VmMicroVmBuildProviderError",
      code: "unsupported-arch",
      message: /sparc64/,
    },
  );
  await assert.rejects(
    () =>
      packer.build(
        createFixtureVmBuildSpec({
          toolchain: {
            packer: "1.12.0",
          },
        }),
      ),
    {
      name: "VmMicroVmBuildProviderError",
      code: "toolchain-drift",
      message: /packer expected 1\.11\.2 got 1\.12\.0/,
    },
  );
});

async function wireImageRefIntoFixtureProvider(imageRef, spec) {
  const plan = createFixtureResourcePlan();
  const api = plan.resources.find((resource) => resource.id === "api");
  api.build = {
    artifactId: spec.id,
    source: spec.source.path,
    target: spec.target,
  };

  const emission = realizeFixtureProvider(plan);
  const wired = wireBuildOutputs(emission, {
    [spec.id]: imageRef.ref,
  });
  const apiNode = wired.iac.nodes.find((node) => node.id === spec.iacProgramRef.nodeId);
  const accepted = createReferenceIacBackend().accept(wired).accepted;

  return {
    accepted,
    imageRef: apiNode?.inputs?.image?.imageRef,
    target: emission.build.artifacts[0].target,
  };
}

function createDriftingVmBaker() {
  let counter = 0;
  return async (spec) => ({
    providerArtifacts: spec.providerTargets.map((target) => ({
      ...target,
      imageId: `${target.provider}-${spec.id}-${counter++}`,
    })),
    image: {
      os: spec.os,
      arch: spec.arch,
    },
  });
}
