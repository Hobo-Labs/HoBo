import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalSkeleton,
  validateBoundaryImports,
  validateMonorepoSkeleton,
} from "../../../technical-proofs/hobo-monorepo-skeleton-contract/src/monorepo-skeleton-contract.js";
import {
  CORE_API_SNAPSHOT,
  createEventEnvelope,
  parseCapabilityManifestBundle,
  toCloudEvent,
  toOcsfAuditEvent,
  toOtlpSpan,
  validatePublicTypeSurface,
} from "../../../technical-proofs/hobo-core-contract/src/core-contract.js";
import {
  parseHoboSdkSkeleton,
  readToolchainLock,
  readWitSource,
  validateToolchainLock,
} from "../../../technical-proofs/hobo-wit-toolchain-contract/src/wit-toolchain-contract.js";
import {
  componentizeHelloBindle,
  runWasmtimeSmoke,
  validateWasmComponentArtifact,
} from "../../../technical-proofs/hobo-componentize-contract/src/componentize-contract.js";
import {
  createHoboCiFabricContract,
  simulateHelloBindleE2e,
  validateCiFabricContract,
} from "../../../technical-proofs/ci-fabric-oidc-e2e-contract/src/ci-fabric-contract.js";
import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../../../technical-proofs/signed-artifact-publish-install-contract/src/publish-install-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const draftRoot = join(here, "..", "..", "..");

const CONTRACTS_COVERED = Object.freeze([
  "WorkspaceSkeletonBoundary",
  "CoreContractBoundary",
  "WitToolchainBoundary",
  "ComponentizeBuildBoundary",
  "CiFabricBoundary",
  "ArtifactTrustBoundary",
  "HardeningTraceabilityBoundary",
]);

export async function runFoundationsBuildConformanceSimulation() {
  const workspace = runWorkspaceSlice();
  const core = await runCoreSlice();
  const wit = await runWitSlice();
  const componentize = await runComponentizeSlice();
  const ci = runCiSlice();
  const artifactTrust = runArtifactTrustSlice(componentize.componentDigest);
  const hardening = await runHardeningSlice();
  const negative = runNegativeCases({ ci, artifactTrust });

  return {
    epic: {
      id: "648882d1-6039-4ed5-b771-6df8fd1a96d4",
      title: "Foundations, Build & Conformance Harness",
      slug: "foundations-build-conformance-harness",
    },
    verticalSlices: [
      bdd("workspace-contract", "Platform engineer", "bootstrap a package skeleton with boundary lint"),
      bdd("contract-surface", "Provider author", "compile against shared core and WIT contracts"),
      bdd("artifact-build", "Application developer", "build a deterministic hello-bindle component"),
      bdd("trust-gate", "SecOps reviewer", "verify signed artifacts before Matching can see them"),
      bdd("ci-conformance", "Maintainer", "run PR gates and opt-in hello-bindle E2E without stored secrets"),
      bdd("hardening-traceability", "Design maintainer", "keep package/API/traceability docs aligned"),
    ],
    workspace,
    core,
    wit,
    componentize,
    ci,
    artifactTrust,
    hardening,
    negative,
    contracts: {
      covered: [...CONTRACTS_COVERED],
      missing: [],
    },
  };
}

function runWorkspaceSlice() {
  const validation = validateMonorepoSkeleton(canonicalSkeleton);
  const violation = validateBoundaryImports([
    {
      from: "packages/providers/provider-aws",
      specifier: "@hobo/provider-gcp",
    },
  ]);

  return {
    status: validation.errors.length === 0 ? "valid" : "invalid",
    packageManager: validation.summary.packageManager,
    packageCount: validation.summary.packageCount,
    requiredScripts: validation.summary.requiredScripts,
    requiredPackages: validation.summary.requiredPackages.slice(0, 8),
    boundaryViolation: {
      effect: violation.errors.length > 0 ? "deny" : "allow",
      reason: violation.errors[0] ?? "none",
    },
  };
}

async function runCoreSlice() {
  const manifest = parseCapabilityManifestBundle(providerManifest(), {
    trustedIssuer: "https://acme-cloud.example.com",
    trustedOidcDiscoveryHost: "yard.example.com",
  });
  const envelope = createEventEnvelope({
    id: "evt-foundations-1",
    type: "foundation.ContractSurfaceVerified",
    streamId: "foundation/ref-impl",
    seq: 1,
    ts: "2026-06-29T02:47:00.000Z",
    actor: { kind: "agent", id: "agent:foundation-rollup" },
    tenant: "tenant-foundations",
    project: "hobo",
    correlationId: "corr-foundations-rollup",
    data: {
      manifestIssuer: manifest.index.issuer,
      packageName: CORE_API_SNAPSHOT.packageName,
    },
    meta: {
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    },
  });
  const cloudEvent = toCloudEvent(envelope);
  const ocsf = toOcsfAuditEvent(envelope);
  const otlp = toOtlpSpan(envelope);
  const publicSurface = validatePublicTypeSurface(
    await readFile(join(draftRoot, "technical-proofs", "hobo-core-contract", "src", "core-contract.d.ts"), "utf8"),
  );

  return {
    schemaVersion: CORE_API_SNAPSHOT.schemaVersion,
    packageName: CORE_API_SNAPSHOT.packageName,
    manifestIssuer: manifest.index.issuer,
    ports: manifest.capabilities.ports.map((port) => port.port),
    eventMappings: {
      cloudEventSpecversion: cloudEvent.specversion,
      ocsfClass: ocsf.class_name,
      otlpTraceId: otlp.traceId,
    },
    publicSurface,
  };
}

async function runWitSlice() {
  const source = await readWitSource();
  const parsed = parseHoboSdkSkeleton(source);
  const lock = await validateToolchainLock(await readToolchainLock());

  return {
    package: parsed.package,
    version: parsed.version,
    world: parsed.world.name,
    imports: parsed.world.imports,
    lock,
  };
}

async function runComponentizeSlice() {
  const built = await componentizeHelloBindle({
    sourceRoot: join(draftRoot, "technical-proofs", "hobo-componentize-contract", "examples", "hello-bindle"),
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });
  const validation = validateWasmComponentArtifact(built.component);
  const smoke = await runWasmtimeSmoke(built.component, { exportName: "health" });

  return {
    componentDigest: built.component.digest,
    validation,
    smoke,
    oci: {
      ...built.oci,
      mediaType: built.oci.manifest.mediaType,
    },
    reproducibility: built.reproducibility.controls,
    ciMatrix: built.ciMatrix,
  };
}

function runCiSlice() {
  const contract = createHoboCiFabricContract();
  const validation = validateCiFabricContract(contract);
  const e2e = simulateHelloBindleE2e(contract, {
    githubRunId: "foundations-rollup-1",
    liveUrl: "https://hello-bindle.preview.example",
  });

  return {
    contract: validation,
    e2e,
    mockedBoundaries: ["GitHubActions", "OIDCTokenIssuer", "SandboxCloud", "OrphanSweeper"],
  };
}

function runArtifactTrustSlice(componentDigest) {
  const signingKey = createFixtureSigningKey({
    keyId: "foundation-fixture-key",
    builderId: "github-actions://Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml",
  });
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: ["@hobo/conformance/foundations"],
    allowedCoordinateScopes: ["@hobo/"],
    minimumProvenanceTier: "slsa-build-l3",
  });
  const artifact = createArtifactPayload({
    coordinate: "@hobo/hello-bindle",
    version: "0.1.0-foundations",
    mediaType: "application/vnd.wasm.component.v1+wasm",
    bytes: componentDigest,
  });
  const candidate = publishSignedArtifact({
    artifact,
    signingKey,
    issuedAt: "2026-06-29T02:47:00.000Z",
    provenanceTier: "slsa-build-l3",
    conformanceReport: {
      suiteId: "@hobo/conformance/foundations",
      passed: true,
      reportRef: "conformance://foundations/reference/green",
    },
  });

  return {
    artifactDigest: artifact.digest,
    candidate,
    trustBoundary,
    install: verifyInstallCandidate({ candidate, trustBoundary }),
  };
}

async function runHardeningSlice() {
  const traceability = await readFile(join(draftRoot, "..", "..", "docs", "design", "traceability.md"), "utf8");
  const packageNamespaces = await readFile(join(draftRoot, "..", "..", "docs", "design", "package-namespaces.md"), "utf8");
  return {
    namespace: {
      secretRefPackage: packageNamespaces.includes("`secretRef`") ? "@hobo/bindles" : "unknown",
      bindlesLeakCheck: {
        ok: packageNamespaces.includes("`@hobo/bindles`") && packageNamespaces.includes("does not re-export topology"),
        errors: [],
      },
    },
    traceability: {
      plan10: lineContaining(traceability, "| PLAN-10 |"),
      adr0005: lineContaining(traceability, "| ADR-0005 |"),
    },
  };
}

function runNegativeCases({ ci, artifactTrust }) {
  const adapterViolation = validateBoundaryImports([
    {
      from: "packages/providers/provider-azure",
      specifier: "@hobo/provider-aws",
    },
  ]);
  const publicSurface = validatePublicTypeSurface(
    [
      "export interface CapabilityManifestBundle {}",
      "export interface Container {}",
      "export interface EventEnvelope {}",
      "export interface PortDescriptor {}",
      "export interface ProviderPort { accessKeyId: string }",
      "export interface RuntimePort {}",
    ].join("\n"),
  );
  const ciMissingOidc = validateCiFabricContract({
    ...createHoboCiFabricContract(),
    e2e: {
      ...createHoboCiFabricContract().e2e,
      permissions: {},
      auth: {
        ...createHoboCiFabricContract().e2e.auth,
        mode: "stored-secret",
      },
    },
  });
  const unsignedArtifact = verifyInstallCandidate({
    candidate: {
      ...artifactTrust.candidate,
      signature: undefined,
    },
    trustBoundary: artifactTrust.trustBoundary,
  });

  return {
    adapterImport: {
      effect: adapterViolation.errors.length > 0 ? "deny" : "allow",
      reason: adapterViolation.errors[0] ?? "none",
    },
    providerSpecificCoreSurface: publicSurface,
    ciMissingOidc: {
      passed: ciMissingOidc.passed,
      violations: ciMissingOidc.violations,
      originalGatePassed: ci.contract.passed,
    },
    unsignedArtifact,
  };
}

function bdd(id, persona, scenario) {
  return {
    id,
    persona,
    scenario,
    gherkin: [
      "Feature: Foundations, Build and Conformance Harness",
      "",
      `  Persona: ${persona}`,
      "",
      `  Scenario: ${scenario}`,
      "    Given a HoBo design-phase reference implementation",
      "    When the mocked boundary is exercised",
      "    Then the contract, simulation, and fail-closed behavior are observable",
    ].join("\n"),
  };
}

function lineContaining(text, needle) {
  return text.split(/\r?\n/).find((line) => line.includes(needle)) ?? "";
}

function providerManifest() {
  return {
    index: {
      schemaVersion: "hobo.core/v1",
      issuer: "https://acme-cloud.example.com",
      manifestDigest: digest("a"),
      signature: {
        alg: "HOBO-FIXTURE-SHA256",
        keyId: "acme-provider-key",
        digest: digest("b"),
      },
      files: ["capabilities.json", "auth.json", "cost.json"],
    },
    capabilities: {
      ports: [
        { port: "compute", kinds: ["container", "function"], stability: "stable" },
        { port: "database", kinds: ["postgres"], stability: "stable" },
      ],
      regions: ["us-east-1", "us-west-2"],
      equivalenceClasses: ["container", "postgres"],
    },
    auth: {
      issuer: "https://acme-cloud.example.com",
      flows: [
        {
          type: "oidc-federation",
          audience: "hobo",
          exchange: "sts:AssumeRoleWithWebIdentity",
          trust: {
            oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration",
          },
        },
      ],
      scopeModel: "least-privilege-per-resource",
      resourceIndicators: ["urn:acme:compute", "urn:acme:database"],
      tokenLifetimeSec: 3600,
      audit: {
        events: ["token.Granted", "token.Used"],
      },
    },
    cost: {
      currency: "USD",
      unitPrices: {
        "compute.container.vcpu-hour": { unit: "hour", amount: 0.04, regions: ["us-east-1"] },
      },
      freeTier: [{ meter: "compute.container.vcpu-hour", amount: 10, resetWindow: "P1M" }],
    },
  };
}

function digest(seed) {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
