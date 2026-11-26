import { createHash } from "node:crypto";
import { isJsonObject } from "./json.js";


export const PACKER_PROVIDER_ID = "@hobo/build-packer";
export const FIRECRACKER_PROVIDER_ID = "@hobo/build-firecracker";
export const VAGRANT_PROVIDER_ID = "@hobo/build-vagrant";
export const BUILD_SPEC_VERSION = "hobo.buildSpec/v1";
export const IMAGE_REF_VERSION = "hobo.imageRef/v1";

export const PINNED_VM_TOOLCHAIN = deepFreeze({
  packer: "1.11.2",
  firecracker: "1.10.1",
  vagrant: "2.4.3",
  qemu: "9.1.0",
  linuxKernel: "6.8.12-hobo-fc",
  digests: {
    packer: "sha256:d3b9836a8f53d1fdc28936908f5cd04dbf61d7ac4f8d87e3f2bb3753a546187a",
    firecracker: "sha256:f4e355879f8304b4b40f5aa2016ba92dd62fa8dd96eb08096ce907a9f1db8e1c",
    vagrant: "sha256:746b62d960f0b5692d4cc0c9e1740f00cc29b13e4156a35ff8abfe7c8f2e9ad6",
    qemu: "sha256:89427b9f9821dce660f504a070a2a95789af405181a54a4c6e743a308aa25ae3",
    linuxKernel: "sha256:3d126d27c37c8b77dfbd901a50f0e9fb0baee3c3fdd14af6fa34abed0a3ef17d",
  },
});

const VM_IMAGE_MEDIA_TYPE = "application/vnd.hobo.vm.image.v1+json";
const MICROVM_ROOTFS_MEDIA_TYPE = "application/vnd.hobo.microvm.rootfs.v1+json";
const VAGRANT_BOX_MEDIA_TYPE = "application/vnd.hobo.vagrant.box.v1+json";
const DEFAULT_SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";
const DEFAULT_REGISTRY = "oci://registry.example/hobo";
const DEFAULT_OS = "ubuntu-24.04";
const DEFAULT_ARCH = "x86_64";
const DEFAULT_REQUIRED_KERNEL_MODULES = deepFreeze(["virtio-blk", "virtio-net", "overlayfs"]);

const SUPPORTED_PROVIDER_TARGETS = deepFreeze({
  aws: {
    artifact: "ami",
    regions: ["us-east-1", "us-west-2", "eu-west-1"],
    arches: ["x86_64", "arm64"],
  },
  azure: {
    artifact: "managed-image",
    regions: ["eastus", "westus2", "westeurope"],
    arches: ["x86_64"],
  },
});

export class VmMicroVmBuildProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VmMicroVmBuildProviderError";
    this.code = code;
    this.details = details;
  }
}

export function createFixtureVmBuildSpec(overrides = {}) {
  const base = {
    apiVersion: BUILD_SPEC_VERSION,
    id: "api-vm-image",
    target: "vm",
    outputKind: "ImageRef",
    source: {
      path: "services/api",
      packerTemplate: "images/api.pkr.hcl",
    },
    os: DEFAULT_OS,
    arch: DEFAULT_ARCH,
    providerTargets: [
      {
        provider: "aws",
        artifact: "ami",
        region: "us-east-1",
        arch: DEFAULT_ARCH,
      },
      {
        provider: "azure",
        artifact: "managed-image",
        region: "eastus",
        arch: DEFAULT_ARCH,
      },
    ],
    toolchain: PINNED_VM_TOOLCHAIN,
    sourceDateEpoch: DEFAULT_SOURCE_DATE_EPOCH,
    registry: DEFAULT_REGISTRY,
    iacProgramRef: {
      nodeId: "api",
      inputPath: "inputs.image",
    },
  };

  return deepFreeze(mergeBuildSpec(base, overrides));
}

export function createFixtureMicroVmBuildSpec(overrides = {}) {
  const base = {
    apiVersion: BUILD_SPEC_VERSION,
    id: "api-microvm-rootfs",
    target: "microVm",
    outputKind: "ImageRef",
    source: {
      path: "services/api",
      rootfsRecipe: "images/microvm/rootfs.hobo.json",
    },
    os: DEFAULT_OS,
    arch: DEFAULT_ARCH,
    kernelVersion: PINNED_VM_TOOLCHAIN.linuxKernel,
    requiredKernelModules: DEFAULT_REQUIRED_KERNEL_MODULES,
    executorBase: true,
    toolchain: PINNED_VM_TOOLCHAIN,
    sourceDateEpoch: DEFAULT_SOURCE_DATE_EPOCH,
    registry: DEFAULT_REGISTRY,
    iacProgramRef: {
      nodeId: "api",
      inputPath: "inputs.image",
    },
  };

  return deepFreeze(mergeBuildSpec(base, overrides));
}

export function createFixtureVagrantBuildSpec(overrides = {}) {
  const prodImageRef = overrides.prodImageRef ?? createFixtureProdVmImageRef();
  const base = {
    apiVersion: BUILD_SPEC_VERSION,
    id: "api-local-vm-box",
    target: "localVm",
    outputKind: "ImageRef",
    source: {
      path: "services/api",
      vagrantTemplate: "images/Vagrantfile.hobo",
    },
    os: prodImageRef.image?.os ?? DEFAULT_OS,
    arch: prodImageRef.image?.arch ?? DEFAULT_ARCH,
    prodImageRef,
    boxProvider: "virtualbox",
    parityProfile: {
      os: prodImageRef.image?.os ?? DEFAULT_OS,
      arch: prodImageRef.image?.arch ?? DEFAULT_ARCH,
      toolchainProfile: "prod-vm-dev-parity",
    },
    toolchain: PINNED_VM_TOOLCHAIN,
    sourceDateEpoch: DEFAULT_SOURCE_DATE_EPOCH,
    registry: DEFAULT_REGISTRY,
    iacProgramRef: {
      nodeId: "api",
      inputPath: "inputs.image",
    },
  };

  return deepFreeze(mergeBuildSpec(base, overrides));
}

export function createPackerBuildProvider({ baker = defaultVmBaker } = {}) {
  return deepFreeze({
    id: PACKER_PROVIDER_ID,
    async build(spec) {
      const normalized = validatePackerSpec(spec);
      const result = await baker(normalized);
      const providerArtifacts = validatePackerResult(result, normalized);
      const image = {
        kind: "vm-image",
        os: normalized.os,
        arch: normalized.arch,
        digest: sha256Text(canonicalJson({ providerArtifacts, os: normalized.os, arch: normalized.arch })),
        providerArtifacts,
      };

      return createImageRef({
        providerId: PACKER_PROVIDER_ID,
        artifactId: normalized.id,
        registry: normalized.registry,
        spec: normalized,
        image,
        mediaType: VM_IMAGE_MEDIA_TYPE,
        reproducibility: [
          "SOURCE_DATE_EPOCH",
          "canonical BuildSpec",
          "pinned VM toolchain",
          "content-addressed image manifest",
        ],
      });
    },
  });
}

export function createFirecrackerBuildProvider({ rootfsBuilder = defaultRootfsBuilder } = {}) {
  return deepFreeze({
    id: FIRECRACKER_PROVIDER_ID,
    async build(spec) {
      const normalized = validateMicroVmSpec(spec);
      const result = await rootfsBuilder(normalized);
      const kernel = validateKernel(result?.kernel, normalized);
      const rootfs = validateRootfs(result?.rootfs);
      const executorBase = result?.executorBase === true;
      if (!executorBase) {
        throw new VmMicroVmBuildProviderError(
          "missing-executor-base-capability",
          "Firecracker rootfs must be consumable as an Executor sandbox base",
        );
      }

      const image = {
        kind: "microvm-rootfs",
        os: normalized.os,
        arch: normalized.arch,
        digest: sha256Text(canonicalJson({ kernel, rootfs, executorBase })),
        executorBase,
        kernel,
        rootfs,
      };

      return createImageRef({
        providerId: FIRECRACKER_PROVIDER_ID,
        artifactId: normalized.id,
        registry: normalized.registry,
        spec: normalized,
        image,
        mediaType: MICROVM_ROOTFS_MEDIA_TYPE,
        reproducibility: [
          "SOURCE_DATE_EPOCH",
          "canonical BuildSpec",
          "pinned Firecracker toolchain",
          "content-addressed rootfs manifest",
        ],
      });
    },
  });
}

export function createVagrantBuildProvider({ boxBuilder = defaultVagrantBoxBuilder } = {}) {
  return deepFreeze({
    id: VAGRANT_PROVIDER_ID,
    async build(spec) {
      const normalized = validateVagrantSpec(spec);
      const result = await boxBuilder(normalized);
      const box = validateVagrantBox(result?.box);
      const claim = validateLocalParity(result?.localParity, normalized);
      const image = {
        kind: "local-vm-box",
        os: claim.os,
        arch: claim.arch,
        digest: sha256Text(canonicalJson({ box, claim })),
        box,
      };

      return deepFreeze({
        ...createImageRef({
          providerId: VAGRANT_PROVIDER_ID,
          artifactId: normalized.id,
          registry: normalized.registry,
          spec: normalized,
          image,
          mediaType: VAGRANT_BOX_MEDIA_TYPE,
          reproducibility: [
            "SOURCE_DATE_EPOCH",
            "canonical BuildSpec",
            "pinned Vagrant toolchain",
            "production VM parity claim",
          ],
        }),
        localParity: {
          productionImageRef: normalized.prodImageRef.ref,
          claim,
        },
      });
    },
  });
}

export async function runVmMicroVmBuildConformance(providers, { wireImageRef } = {}) {
  const coverage = [
    "build.packer.vm-image",
    "build.firecracker.microvm-rootfs",
    "build.vagrant.local-vm-box",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "target.fail-closed",
    "adversarial.fail-closed",
  ];
  const failures = [];
  assertProviderContract(providers?.packer, PACKER_PROVIDER_ID);
  assertProviderContract(providers?.firecracker, FIRECRACKER_PROVIDER_ID);
  assertProviderContract(providers?.vagrant, VAGRANT_PROVIDER_ID);

  const vmSpec = createFixtureVmBuildSpec();
  const vmImage = await assertReproducible(providers.packer, vmSpec, "vm-image");
  const microVmSpec = createFixtureMicroVmBuildSpec();
  const microVmImage = await assertReproducible(providers.firecracker, microVmSpec, "microvm-rootfs");
  const vagrantSpec = createFixtureVagrantBuildSpec({ prodImageRef: vmImage });
  const vagrantImage = await assertReproducible(providers.vagrant, vagrantSpec, "local-vm-box");

  if (microVmImage.image.executorBase !== true) {
    failures.push("Firecracker ImageRef did not declare Executor sandbox-base compatibility");
  }
  if (vagrantImage.localParity?.productionImageRef !== vmImage.ref) {
    failures.push("Vagrant ImageRef did not keep an honest production VM parity link");
  }

  if (!(wireImageRef instanceof Function)) {
    failures.push("conformance did not receive an IacProgram wire-back hook");
  } else {
    for (const [imageRef, spec] of [
      [vmImage, vmSpec],
      [microVmImage, microVmSpec],
      [vagrantImage, vagrantSpec],
    ]) {
      const wireBack = await wireImageRef(imageRef, spec);
      if (!wireBack?.accepted || wireBack.imageRef !== imageRef.ref || wireBack.target !== spec.target) {
        failures.push(`${imageRef.provider} ImageRef did not wire back into the fixture provider IacProgram`);
      }
    }
  }

  await expectProviderError(
    () => providers.packer.build(createFixtureVmBuildSpec({ target: "wasm-component" })),
    "unsupported-target",
    "packer accepted a non-VM target",
  );
  await expectProviderError(
    () => providers.firecracker.build(createFixtureMicroVmBuildSpec({ target: "vm" })),
    "unsupported-target",
    "firecracker accepted a non-microVM target",
  );
  await expectProviderError(
    () => providers.vagrant.build(createFixtureVagrantBuildSpec({ target: "vm", prodImageRef: vmImage })),
    "unsupported-target",
    "vagrant accepted a non-local VM target",
  );
  await expectProviderError(
    () =>
      providers.packer.build(
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
    "unsupported-provider-target",
    "packer accepted a provider region it cannot use",
  );

  if (failures.length > 0) {
    throw new VmMicroVmBuildProviderError("conformance-failed", failures.join("; "), { failures });
  }

  return deepFreeze({
    passed: true,
    coverage,
    failures,
  });
}

function validatePackerSpec(spec) {
  const normalized = validateCommonBuildSpec(spec, "vm", ["packer"]);
  if (!normalized.source?.packerTemplate) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "source.packerTemplate is required");
  }
  if (!Array.isArray(normalized.providerTargets) || normalized.providerTargets.length === 0) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "providerTargets must contain at least one target");
  }
  for (const target of normalized.providerTargets) {
    validateProviderTarget(target);
  }
  return normalized;
}

function validateMicroVmSpec(spec) {
  const normalized = validateCommonBuildSpec(spec, "microVm", ["firecracker", "qemu", "linuxKernel"]);
  if (!normalized.source?.rootfsRecipe) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "source.rootfsRecipe is required");
  }
  if (!Array.isArray(normalized.requiredKernelModules) || normalized.requiredKernelModules.length === 0) {
    throw new VmMicroVmBuildProviderError(
      "invalid-build-spec",
      "requiredKernelModules must contain at least one module",
    );
  }
  if (normalized.kernelVersion !== PINNED_VM_TOOLCHAIN.linuxKernel) {
    throw new VmMicroVmBuildProviderError(
      "toolchain-drift",
      `linuxKernel expected ${PINNED_VM_TOOLCHAIN.linuxKernel} got ${normalized.kernelVersion ?? "missing"}`,
    );
  }
  return normalized;
}

function validateVagrantSpec(spec) {
  const normalized = validateCommonBuildSpec(spec, "localVm", ["vagrant", "qemu"]);
  if (!normalized.source?.vagrantTemplate) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "source.vagrantTemplate is required");
  }
  if (!normalized.prodImageRef?.ref || normalized.prodImageRef.image?.kind !== "vm-image") {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "prodImageRef must reference a VM ImageRef");
  }
  return normalized;
}

function validateCommonBuildSpec(spec, expectedTarget, requiredToolchainPins) {
  if (!spec || !isJsonObject(spec)) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "BuildSpec must be an object");
  }
  if (spec.apiVersion !== BUILD_SPEC_VERSION) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", `BuildSpec apiVersion must be ${BUILD_SPEC_VERSION}`);
  }
  if (!spec.id) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "BuildSpec id is required");
  }
  if (spec.target !== expectedTarget) {
    throw new VmMicroVmBuildProviderError(
      "unsupported-target",
      `target ${spec.target} is not ${expectedTarget}`,
      { expectedTarget, actualTarget: spec.target },
    );
  }
  if (spec.outputKind !== "ImageRef") {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "VM build providers emit ImageRef output only");
  }
  if (!spec.source?.path) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "source.path is required");
  }
  if (!spec.os) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "os is required");
  }
  if (!spec.arch) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "arch is required");
  }
  if (!spec.sourceDateEpoch || Number.isNaN(Date.parse(spec.sourceDateEpoch))) {
    throw new VmMicroVmBuildProviderError("invalid-build-spec", "sourceDateEpoch must be an ISO timestamp");
  }

  for (const name of requiredToolchainPins) {
    const expected = PINNED_VM_TOOLCHAIN[name];
    const actual = spec.toolchain?.[name];
    if (actual !== expected) {
      throw new VmMicroVmBuildProviderError(
        "toolchain-drift",
        `${name} expected ${expected} got ${actual ?? "missing"}`,
      );
    }
    const expectedDigest = PINNED_VM_TOOLCHAIN.digests[name];
    const actualDigest = spec.toolchain?.digests?.[name];
    if (actualDigest !== expectedDigest) {
      throw new VmMicroVmBuildProviderError(
        "toolchain-drift",
        `${name} digest expected ${expectedDigest} got ${actualDigest ?? "missing"}`,
      );
    }
  }

  return deepFreeze(structuredClone(spec));
}

function validateProviderTarget(target) {
  const supported = SUPPORTED_PROVIDER_TARGETS[target?.provider];
  if (!supported || target.artifact !== supported.artifact) {
    throw new VmMicroVmBuildProviderError(
      "unsupported-provider-target",
      `${target?.provider ?? "unknown"} ${target?.artifact ?? "unknown"} is not a supported VM image target`,
      { target },
    );
  }
  if (!supported.arches.includes(target.arch)) {
    throw new VmMicroVmBuildProviderError("unsupported-arch", `arch ${target.arch} is not supported for ${target.provider}`, {
      target,
    });
  }
  if (!supported.regions.includes(target.region)) {
    throw new VmMicroVmBuildProviderError(
      "unsupported-provider-target",
      `${target.provider} ${target.region} is not a supported VM image region`,
      { target },
    );
  }
}

function validatePackerResult(result, spec) {
  const artifacts = result?.providerArtifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== spec.providerTargets.length) {
    throw new VmMicroVmBuildProviderError("invalid-image-output", "packer baker must return one artifact per target");
  }

  return deepFreeze(
    spec.providerTargets.map((target) => {
      const artifact = artifacts.find(
        (candidate) =>
          candidate.provider === target.provider &&
          candidate.artifact === target.artifact &&
          candidate.region === target.region &&
          candidate.arch === target.arch,
      );
      if (!artifact?.imageId) {
        throw new VmMicroVmBuildProviderError(
          "invalid-image-output",
          `packer baker did not return ${target.provider} ${target.region} ${target.arch}`,
          { target },
        );
      }
      return {
        ...target,
        imageId: artifact.imageId,
      };
    }),
  );
}

function validateKernel(kernel, spec) {
  if (!kernel || kernel.version !== spec.kernelVersion) {
    throw new VmMicroVmBuildProviderError(
      "missing-firecracker-kernel-module",
      `kernel version expected ${spec.kernelVersion} got ${kernel?.version ?? "missing"}`,
    );
  }
  const modules = kernel.modules ?? [];
  for (const name of spec.requiredKernelModules) {
    if (!modules.includes(name)) {
      throw new VmMicroVmBuildProviderError(
        "missing-firecracker-kernel-module",
        `Firecracker rootfs missing required kernel module ${name}`,
        { missing: name },
      );
    }
  }
  return deepFreeze({
    version: kernel.version,
    modules: spec.requiredKernelModules.slice(),
  });
}

function validateRootfs(rootfs) {
  if (!rootfs || rootfs.format !== "ext4" || !isSha256(rootfs.digest) || !Number.isInteger(rootfs.sizeBytes)) {
    throw new VmMicroVmBuildProviderError("invalid-rootfs-output", "rootfs must be an ext4 digest-addressed image");
  }
  return deepFreeze({
    format: rootfs.format,
    digest: rootfs.digest,
    sizeBytes: rootfs.sizeBytes,
  });
}

function validateVagrantBox(box) {
  if (!box || box.provider !== "virtualbox" || box.format !== "box" || !isSha256(box.digest)) {
    throw new VmMicroVmBuildProviderError(
      "invalid-vagrant-box-output",
      "vagrant builder must return a virtualbox .box digest",
    );
  }
  return deepFreeze({
    provider: box.provider,
    format: box.format,
    digest: box.digest,
    sizeBytes: box.sizeBytes,
  });
}

function validateLocalParity(localParity, spec) {
  const expected = {
    os: spec.prodImageRef.image.os,
    arch: spec.prodImageRef.image.arch,
    toolchainProfile: spec.parityProfile.toolchainProfile,
    productionImageDigest: spec.prodImageRef.digest,
    fidelity: "simulated",
    campRequiredForProdReady: true,
  };
  for (const key of Object.keys(expected)) {
    if (localParity?.[key] !== expected[key]) {
      throw new VmMicroVmBuildProviderError(
        "local-fidelity-drift",
        `${key} expected ${expected[key]} got ${localParity?.[key] ?? "missing"}`,
        { expected, actual: localParity },
      );
    }
  }
  return deepFreeze(expected);
}

async function assertReproducible(provider, spec, expectedImageKind) {
  const first = await provider.build(spec);
  const second = await provider.build(spec);
  if (first.ref !== second.ref || first.digest !== second.digest) {
    throw new VmMicroVmBuildProviderError("non-reproducible-build", "same BuildSpec produced different ImageRefs", {
      first: first.ref,
      second: second.ref,
    });
  }
  if (first.kind !== "ImageRef" || first.image?.kind !== expectedImageKind || first.artifactId !== spec.id) {
    throw new VmMicroVmBuildProviderError(
      "conformance-failed",
      `${provider.id} did not produce an ${expectedImageKind} ImageRef for ${spec.id}`,
    );
  }
  return first;
}

function assertProviderContract(provider, expectedId) {
  if (provider?.id !== expectedId || !(provider?.build instanceof Function)) {
    throw new VmMicroVmBuildProviderError("conformance-failed", `provider does not expose ${expectedId}`);
  }
}

async function expectProviderError(fn, code, failureMessage) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof VmMicroVmBuildProviderError && error.code === code) return;
    throw error;
  }
  throw new VmMicroVmBuildProviderError("conformance-failed", failureMessage);
}

async function defaultVmBaker(spec) {
  return {
    providerArtifacts: spec.providerTargets.map((target) => ({
      ...target,
      imageId: createProviderImageId(spec, target),
    })),
    image: {
      os: spec.os,
      arch: spec.arch,
    },
  };
}

async function defaultRootfsBuilder(spec) {
  const rootfsDescriptor = {
    source: spec.source,
    os: spec.os,
    arch: spec.arch,
    sourceDateEpoch: spec.sourceDateEpoch,
    toolchain: {
      firecracker: spec.toolchain.firecracker,
      qemu: spec.toolchain.qemu,
      linuxKernel: spec.toolchain.linuxKernel,
      digests: {
        firecracker: spec.toolchain.digests.firecracker,
        qemu: spec.toolchain.digests.qemu,
        linuxKernel: spec.toolchain.digests.linuxKernel,
      },
    },
  };

  return {
    kernel: {
      version: spec.kernelVersion,
      modules: spec.requiredKernelModules.slice(),
    },
    rootfs: {
      format: "ext4",
      digest: sha256Text(canonicalJson(rootfsDescriptor)),
      sizeBytes: 268435456,
    },
    executorBase: true,
  };
}

async function defaultVagrantBoxBuilder(spec) {
  const boxDescriptor = {
    source: spec.source,
    productionImageRef: spec.prodImageRef.ref,
    os: spec.prodImageRef.image.os,
    arch: spec.prodImageRef.image.arch,
    sourceDateEpoch: spec.sourceDateEpoch,
    toolchain: {
      vagrant: spec.toolchain.vagrant,
      qemu: spec.toolchain.qemu,
      digests: {
        vagrant: spec.toolchain.digests.vagrant,
        qemu: spec.toolchain.digests.qemu,
      },
    },
  };

  return {
    box: {
      provider: spec.boxProvider,
      format: "box",
      digest: sha256Text(canonicalJson(boxDescriptor)),
      sizeBytes: 805306368,
    },
    localParity: {
      os: spec.prodImageRef.image.os,
      arch: spec.prodImageRef.image.arch,
      toolchainProfile: spec.parityProfile.toolchainProfile,
      productionImageDigest: spec.prodImageRef.digest,
      fidelity: "simulated",
      campRequiredForProdReady: true,
    },
  };
}

function createImageRef({ providerId, artifactId, registry, spec, image, mediaType, reproducibility }) {
  const sourceDigest = sha256Text(canonicalJson(spec.source));
  const config = {
    artifactId,
    sourceDigest,
    sourceDateEpoch: spec.sourceDateEpoch,
    target: spec.target,
    toolchain: spec.toolchain,
    image,
  };
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: mediaType,
    config: {
      mediaType: "application/vnd.hobo.build-provider.config.v1+json",
      digest: sha256Text(canonicalJson(config)),
    },
    layers: [
      {
        mediaType,
        digest: image.digest,
        size: image.rootfs?.sizeBytes ?? image.box?.sizeBytes ?? image.providerArtifacts?.length ?? 1,
      },
    ],
    annotations: {
      "dev.hobo.build.provider": providerId,
      "dev.hobo.build.target": spec.target,
      "dev.hobo.source.path": spec.source.path,
    },
  };
  const digest = sha256Text(canonicalJson(manifest));

  return deepFreeze({
    kind: "ImageRef",
    apiVersion: IMAGE_REF_VERSION,
    provider: providerId,
    artifactId,
    ref: `${registry}/${artifactId}@${digest}`,
    digest,
    image,
    manifest,
    provenance: {
      builder: providerId,
      sourceDigest,
      sourceDateEpoch: spec.sourceDateEpoch,
      toolchain: spec.toolchain,
      reproducibility,
    },
  });
}

function createProviderImageId(spec, target) {
  const artifactId = sanitizeIdentifier(spec.id);
  const region = sanitizeIdentifier(target.region);
  const arch = sanitizeIdentifier(target.arch);
  if (target.provider === "aws") {
    return `ami-${artifactId}-${region}-${arch}`;
  }
  return `${target.provider}-${artifactId}-${region}-${arch}`;
}

function createFixtureProdVmImageRef() {
  const image = {
    kind: "vm-image",
    os: DEFAULT_OS,
    arch: DEFAULT_ARCH,
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    providerArtifacts: [
      {
        provider: "aws",
        artifact: "ami",
        region: "us-east-1",
        arch: DEFAULT_ARCH,
        imageId: "ami-api-vm-image-us-east-1-x86-64",
      },
    ],
  };
  return deepFreeze({
    kind: "ImageRef",
    apiVersion: IMAGE_REF_VERSION,
    provider: PACKER_PROVIDER_ID,
    artifactId: "api-vm-image",
    ref: "oci://registry.example/hobo/api-vm-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    image,
  });
}

function mergeBuildSpec(base, overrides) {
  return {
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...overrides.source,
    },
    toolchain: {
      ...base.toolchain,
      ...overrides.toolchain,
      digests: {
        ...base.toolchain.digests,
        ...overrides.toolchain?.digests,
      },
    },
    iacProgramRef: {
      ...base.iacProgramRef,
      ...overrides.iacProgramRef,
    },
    parityProfile: {
      ...base.parityProfile,
      ...overrides.parityProfile,
    },
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function sanitizeIdentifier(value) {
  return String(value).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
