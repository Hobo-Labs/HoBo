import { createHash } from "node:crypto";
import { isJsonObject } from "./json.js";


export const BUILD_DAGGER_PROVIDER_ID = "@hobo/build-dagger";
export const BUILD_SPEC_VERSION = "hobo.buildSpec/v1";
export const IMAGE_REF_VERSION = "hobo.imageRef/v1";
export const OCI_IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const OCI_IMAGE_CONFIG = "application/vnd.oci.image.config.v1+json";

const PINNED_BASE_IMAGE =
  "cgr.dev/chainguard/node@sha256:1111111111111111111111111111111111111111111111111111111111111111";

export class BuildDaggerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BuildDaggerError";
    this.code = code;
    this.details = details;
    this.events = details.events ?? [];
  }
}

export function createFixtureContainerBuildSpec(overrides = {}) {
  const base = {
    apiVersion: BUILD_SPEC_VERSION,
    id: "api-container-image",
    target: "container",
    outputKind: "ImageRef",
    registry: "oci://registry.example/hobo",
    baseImage: PINNED_BASE_IMAGE,
    source: {
      path: "services/api",
      files: {
        "package.json": "{\"type\":\"module\",\"scripts\":{\"start\":\"node src/server.ts\"}}\n",
        "src/server.ts": "export function handler() { return 'ok'; }\n",
      },
    },
    pipeline: [
      { name: "install", command: "npm ci --ignore-scripts", deterministic: true },
      { name: "build", command: "npm run build --if-present", deterministic: true },
    ],
    platform: {
      os: "linux",
      architecture: "amd64",
    },
    platforms: [
      {
        os: "linux",
        architecture: "amd64",
      },
    ],
    budget: {
      maxSeconds: 300,
      maxMemoryMb: 2048,
    },
    estimate: {
      seconds: 45,
      memoryMb: 512,
    },
    buildMachine: {
      providerId: "self-hosted",
      machineId: "build-machine-1",
    },
    iacProgramRef: {
      nodeId: "api",
      inputPath: "inputs.image",
    },
  };

  return deepFreeze(mergeSpec(base, overrides));
}

export function createBuildDaggerProvider() {
  return deepFreeze({
    id: BUILD_DAGGER_PROVIDER_ID,
    async build(spec) {
      const normalized = validateBasicBuildSpec(spec);
      const baseImage = parsePinnedImage(normalized.baseImage);
      const pipelineEvents = runPipeline(normalized);
      const sourceDigest = sha256Text(canonicalJson(normalized.source));
      const pipelineDigest = sha256Text(canonicalJson(normalized.pipeline));
      const config = {
        mediaType: OCI_IMAGE_CONFIG,
        digest: sha256Text(
          canonicalJson({
            baseImage: normalized.baseImage,
            pipelineDigest,
            platform: normalized.platform,
            sourceDigest,
          }),
        ),
        platform: normalized.platform,
      };
      const layers = [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          digest: sha256Text(
            canonicalJson({
              files: normalized.source.files,
              pipeline: normalized.pipeline,
            }),
          ),
        },
      ];
      const manifest = {
        schemaVersion: 2,
        mediaType: OCI_IMAGE_MANIFEST,
        config,
        layers,
        annotations: {
          "dev.hobo.build.provider": BUILD_DAGGER_PROVIDER_ID,
          "dev.hobo.base-image": normalized.baseImage,
          "dev.hobo.source.path": normalized.source.path,
        },
      };
      const digest = sha256Text(canonicalJson(manifest));

      return deepFreeze({
        kind: "ImageRef",
        apiVersion: IMAGE_REF_VERSION,
        provider: BUILD_DAGGER_PROVIDER_ID,
        artifactId: normalized.id,
        ref: `${normalized.registry}/${normalized.id}@${digest}`,
        digest,
        mediaType: OCI_IMAGE_MANIFEST,
        config,
        manifest,
        provenance: {
          builder: BUILD_DAGGER_PROVIDER_ID,
          sourceDigest,
          pipelineDigest,
          baseImage,
          buildMachine: normalized.buildMachine,
          reproducibility: [
            "pinned base image digest",
            "canonical source descriptor",
            "canonical Dagger pipeline descriptor",
            "content-addressed OCI manifest",
          ],
        },
        events: [
          ...pipelineEvents,
          {
            type: "exec.Succeeded",
            artifactId: normalized.id,
            imageRef: `${normalized.registry}/${normalized.id}@${digest}`,
          },
        ],
      });
    },
  });
}

export async function runBuildDaggerConformance(provider, { wireImageRef } = {}) {
  const coverage = [
    "build.container-image",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "exec-output.failure-logs",
    "target-arch.fail-closed",
  ];
  const failures = [];
  const spec = createFixtureContainerBuildSpec({ id: "api-image" });

  if (provider?.id !== BUILD_DAGGER_PROVIDER_ID || !(provider?.build instanceof Function)) {
    throw new BuildDaggerError(
      "conformance-failed",
      "provider does not expose the @hobo/build-dagger shape",
    );
  }

  const first = await provider.build(spec);
  const second = await provider.build(spec);
  if (first.ref !== second.ref || first.digest !== second.digest) {
    throw new BuildDaggerError("non-reproducible-build", "same BuildSpec produced different ImageRefs", {
      first: first.ref,
      second: second.ref,
    });
  }
  if (first.kind !== "ImageRef" || first.provider !== BUILD_DAGGER_PROVIDER_ID || first.mediaType !== OCI_IMAGE_MANIFEST) {
    failures.push("build did not return a container OCI ImageRef");
  }
  if (!(wireImageRef instanceof Function)) {
    failures.push("conformance did not receive an IacProgram wire-back hook");
  } else {
    const wireBack = await wireImageRef(first, spec);
    if (!wireBack?.accepted || wireBack.imageRef !== first.ref) {
      failures.push("ImageRef did not wire back into the fixture provider IacProgram");
    }
  }
  try {
    await provider.build(
      createFixtureContainerBuildSpec({
        pipeline: [
          { name: "install", command: "npm ci --ignore-scripts", deterministic: true },
          { name: "test", command: "npm test", deterministic: true, exitCode: 1, output: ["boom"] },
        ],
      }),
    );
    failures.push("provider did not surface a failing build");
  } catch (error) {
    if (!(error instanceof BuildDaggerError) || error.code !== "build-failed") {
      throw error;
    }
    if (!error.events.some((event) => event.type === "exec.Output")) {
      failures.push("failing build did not include exec.Output events");
    }
  }

  try {
    await provider.build(
      createFixtureContainerBuildSpec({
        platform: { os: "linux", architecture: "arm64" },
        platforms: [{ os: "linux", architecture: "amd64" }],
      }),
    );
    failures.push("provider accepted a missing target architecture");
  } catch (error) {
    if (!(error instanceof BuildDaggerError) || error.code !== "missing-target-arch") {
      throw error;
    }
  }

  if (failures.length > 0) {
    throw new BuildDaggerError("conformance-failed", failures.join("; "), { failures });
  }

  return deepFreeze({
    passed: true,
    coverage,
    failures,
  });
}

export function deployFixtureIacProgram(iacProgram) {
  if (!iacProgram || !Array.isArray(iacProgram.nodes)) {
    throw new BuildDaggerError("invalid-iac-program", "IacProgram nodes are required");
  }

  const events = iacProgram.nodes.map((node) => {
    const image = node.inputs?.image;
    if (image?.$build) {
      throw new BuildDaggerError(
        "unresolved-build-ref",
        `node ${node.id} still references unresolved BuildSpec artifact ${image.$build}`,
      );
    }

    return {
      type: "resource.Provisioned",
      nodeId: node.id,
      resourceType: node.type,
      imageRef: image?.imageRef,
    };
  });

  return deepFreeze({
    status: "deployed",
    events,
  });
}

function validateBasicBuildSpec(spec) {
  if (!spec || !isJsonObject(spec)) {
    throw new BuildDaggerError("invalid-build-spec", "BuildSpec must be an object");
  }
  if (spec.apiVersion !== BUILD_SPEC_VERSION) {
    throw new BuildDaggerError("invalid-build-spec", `BuildSpec apiVersion must be ${BUILD_SPEC_VERSION}`);
  }
  if (!spec.id) {
    throw new BuildDaggerError("invalid-build-spec", "BuildSpec id is required");
  }
  if (spec.target !== "container") {
    throw new BuildDaggerError("unsupported-target", `target ${spec.target} is not container`);
  }
  if (spec.outputKind !== "ImageRef") {
    throw new BuildDaggerError("invalid-build-spec", "build-dagger emits ImageRef output only");
  }
  if (!spec.registry) {
    throw new BuildDaggerError("invalid-build-spec", "registry is required");
  }
  if (!spec.source?.path || !spec.source?.files || !isJsonObject(spec.source.files)) {
    throw new BuildDaggerError("invalid-build-spec", "source.path and source.files are required");
  }
  if (!Array.isArray(spec.pipeline) || spec.pipeline.length === 0) {
    throw new BuildDaggerError("invalid-build-spec", "pipeline must contain at least one step");
  }
  if (!spec.platform?.os || !spec.platform?.architecture) {
    throw new BuildDaggerError("invalid-build-spec", "platform os and architecture are required");
  }
  parsePinnedImage(spec.baseImage);
  validatePipeline(spec.pipeline);
  validateBudget(spec);
  validatePlatform(spec);

  return deepFreeze(structuredClone(spec));
}

function validatePipeline(pipeline) {
  for (const [index, step] of pipeline.entries()) {
    if (!step?.name || !step?.command) {
      throw new BuildDaggerError("invalid-build-spec", `pipeline step ${index} must have name and command`);
    }
    if (step.deterministic !== true) {
      throw new BuildDaggerError(
        "non-reproducible-pipeline",
        `pipeline step ${step.name} is not marked deterministic`,
        { step: step.name },
      );
    }
  }
}

function validateBudget(spec) {
  const seconds = spec.estimate?.seconds ?? 0;
  const maxSeconds = spec.budget?.maxSeconds ?? Number.POSITIVE_INFINITY;
  if (seconds > maxSeconds) {
    throw new BuildDaggerError(
      "build-budget-exceeded",
      `time budget exceeded: estimated ${seconds}s > ${maxSeconds}s`,
      { seconds, maxSeconds },
    );
  }

  const memoryMb = spec.estimate?.memoryMb ?? 0;
  const maxMemoryMb = spec.budget?.maxMemoryMb ?? Number.POSITIVE_INFINITY;
  if (memoryMb > maxMemoryMb) {
    throw new BuildDaggerError(
      "build-budget-exceeded",
      `memory budget exceeded: estimated ${memoryMb}MiB > ${maxMemoryMb}MiB`,
      { memoryMb, maxMemoryMb },
    );
  }
}

function validatePlatform(spec) {
  const target = `${spec.platform.os}/${spec.platform.architecture}`;
  const available = (spec.platforms ?? []).some(
    (platform) => platform.os === spec.platform.os && platform.architecture === spec.platform.architecture,
  );
  if (!available) {
    throw new BuildDaggerError(
      "missing-target-arch",
      `multi-arch image is missing target platform ${target}`,
      { target, platforms: spec.platforms ?? [] },
    );
  }
}

function parsePinnedImage(image) {
  const match = /^(?<repository>[^@]+)@(?<digest>sha256:[a-f0-9]{64})$/u.exec(image ?? "");
  if (!match) {
    throw new BuildDaggerError(
      "unpinned-base-image",
      `base image must be pinned by sha256 digest: ${image ?? "missing"}`,
    );
  }
  return match.groups;
}

function runPipeline(spec) {
  const events = [];
  for (const step of spec.pipeline) {
    events.push({
      type: "exec.Output",
      stream: "stdout",
      step: step.name,
      message: `dagger ${step.name}: ${step.command}`,
    });
    for (const line of step.output ?? []) {
      events.push({
        type: "exec.Output",
        stream: step.stream ?? "stdout",
        step: step.name,
        message: line,
      });
    }

    if ((step.exitCode ?? 0) !== 0) {
      const failed = [
        ...events,
        {
          type: "exec.Failed",
          step: step.name,
          exitCode: step.exitCode,
        },
      ];
      throw new BuildDaggerError(
        "build-failed",
        `Dagger pipeline step ${step.name} failed with exit ${step.exitCode}`,
        { events: failed },
      );
    }
  }

  return events;
}

function mergeSpec(base, overrides) {
  return {
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...overrides.source,
      files: {
        ...base.source.files,
        ...overrides.source?.files,
      },
    },
    platform: {
      ...base.platform,
      ...overrides.platform,
    },
    platforms: overrides.platforms ?? base.platforms,
    budget: {
      ...base.budget,
      ...overrides.budget,
    },
    estimate: {
      ...base.estimate,
      ...overrides.estimate,
    },
    buildMachine: {
      ...base.buildMachine,
      ...overrides.buildMachine,
    },
    iacProgramRef: {
      ...base.iacProgramRef,
      ...overrides.iacProgramRef,
    },
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
