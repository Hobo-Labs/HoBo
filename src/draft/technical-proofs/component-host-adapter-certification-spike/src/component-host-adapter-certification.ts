import {
  createReferenceRuntimeLocalHost,
  runComponentHostConformance,
} from "../../component-host-conformance-suite/src/component-host-conformance.js";
import { isJsonString, isJsonObject } from "./json.js";


export const ADAPTER_CERTIFICATION_SCHEMA = "hobo.component-host-adapter-certification-spike/v1";
export const COMPONENT_HOST_SUITE = "@hobo/conformance/component-host";

export const REQUIRED_WASI_INTERFACES = Object.freeze([
  "wasi:blobstore/blobstore@0.2.0",
  "wasi:clocks/wall-clock@0.2.0",
  "wasi:http/outgoing-handler@0.2.0",
  "wasi:io/streams@0.2.0",
  "wasi:keyvalue/store@0.2.0",
]);

export const ASSERTED_BEHAVIORS = Object.freeze([
  { key: "deterministicClockReplay", checkId: "deterministic-clock-replay" },
  { key: "wasiRoundTrip", checkId: "wasi-round-trip" },
  { key: "linkLateBinding", checkId: "link-late-binding" },
  { key: "capabilityHandleIsolation", checkId: "capability-handle-isolation" },
  { key: "fpNanCanonicalization", checkId: "fp-nan-canonicalization" },
  { key: "fuelEpochScheduling", checkId: "fuel-epoch-scheduling" },
  { key: "resourceLimitSemantics", checkId: "resource-limit-semantics" },
]);

const NON_COVERED_DIVERGENCES = Object.freeze([
  "wall-clock scheduling jitter",
  "host-specific partial-failure timing",
]);

const CANONICAL_NAN_BITS = "0x7ff8000000000000";
const DRIFTING_NAN_BITS = "0x7ff0000000000001";

export function createWasmtimeLocalProfile(overrides = {}) {
  return createProfile(
    {
      id: "wasmtime-local",
      label: "Wasmtime local",
      role: "baseline",
      host: {
        kind: "runtime-local",
        version: "wasmtime/46.0.1",
        boundaryMode: "in-process",
      },
      wasiInterfaces: REQUIRED_WASI_INTERFACES,
      determinism: allAssertedBehaviors(true),
      supportedHostOptions: [],
      hostBehaviorOverrides: {},
      nonCoveredDivergences: NON_COVERED_DIVERGENCES,
    },
    overrides,
  );
}

export function createSpinKubeAdapterProfile(overrides = {}) {
  return createProfile(
    {
      id: "spinkube-containerd-wasm",
      label: "SpinKube / containerd-wasm",
      role: "candidate-adapter",
      host: {
        kind: "spinkube",
        version: "containerd-wasm/spinkube@spike",
        boundaryMode: "kubernetes-runtimeclass",
      },
      wasiInterfaces: REQUIRED_WASI_INTERFACES,
      determinism: allAssertedBehaviors(true),
      supportedHostOptions: ["linkMigration"],
      hostBehaviorOverrides: {},
      nonCoveredDivergences: NON_COVERED_DIVERGENCES,
    },
    overrides,
  );
}

export function createCloudflareWorkersProviderNativeProfile(overrides = {}) {
  return createProfile(
    {
      id: "cloudflare-workers-provider-native",
      label: "Cloudflare Workers provider-native wasm",
      role: "candidate-adapter",
      host: {
        kind: "provider-native",
        version: "cloudflare-workers@spike",
        boundaryMode: "provider-native-edge",
      },
      wasiInterfaces: [
        "wasi:clocks/wall-clock@0.2.0",
        "wasi:http/outgoing-handler@0.2.0",
        "wasi:io/streams@0.2.0",
      ],
      determinism: {
        ...allAssertedBehaviors(true),
        fuelEpochScheduling: false,
        resourceLimitSemantics: false,
      },
      supportedHostOptions: [],
      hostBehaviorOverrides: {},
      nonCoveredDivergences: NON_COVERED_DIVERGENCES,
    },
    overrides,
  );
}

export function createDeterminismDriftProfile(overrides = {}) {
  return createSpinKubeAdapterProfile({
    id: "spinkube-determinism-drift",
    label: "SpinKube fixture with determinism drift",
    hostBehaviorOverrides: {
      nanBits: DRIFTING_NAN_BITS,
      fuelSchedule: [
        { epoch: 0, fuelRemaining: 8, step: "load" },
        { epoch: 1, fuelRemaining: 0, step: "yield" },
      ],
      resourceLimit: {
        memoryPages: 17,
        maxMemoryPages: 16,
        status: "continued",
        trap: null,
      },
    },
    ...overrides,
  });
}

export function hostWith(hostKind, option, value = true) {
  requireNonEmptyString(hostKind, "hostKind");
  requireNonEmptyString(option, "option");
  return deepFreeze({ hostKind, option, value });
}

export async function certifyComponentHostAdapter({
  adapterProfile,
  baselineProfile = createWasmtimeLocalProfile(),
  hostOptions = [],
} = {}) {
  const baseline = normalizeProfile(baselineProfile, "baselineProfile");
  const adapter = normalizeProfile(adapterProfile, "adapterProfile");
  const normalizedHostOptions = normalizeHostOptions(hostOptions);
  const hostOptionResult = applyHostWithOptions({ adapterProfile: adapter, hostOptions: normalizedHostOptions });
  const doctor = doctorHostWithOptions({ hostOptions: normalizedHostOptions });
  const preflightGaps = evaluateAdapterProfile(adapter);

  if (preflightGaps.length > 0) {
    return certificationReport({
      adapter,
      baseline,
      doctor,
      hostOptionResult,
      status: "planning-failed",
      decision: "gap-list",
      reason: gapReason(preflightGaps),
      gaps: preflightGaps,
      conformanceReport: null,
    });
  }

  const conformanceReport = await runComponentHostConformance({
    manifest: createCertificationManifest({ baseline, adapter }),
    hosts: [toFixtureHost(baseline), toFixtureHost(adapter)],
  });
  const conformanceGaps = conformanceReport.failures.map((failure) => ({
    code: "component_host.conformance-gap",
    checkId: failure.checkId,
    reason: failure.message,
  }));

  return certificationReport({
    adapter,
    baseline,
    doctor,
    hostOptionResult,
    status: conformanceReport.status === "pass" ? "certified" : "conformance-failed",
    decision: conformanceReport.status === "pass" ? "certify-adapter" : "gap-list",
    reason: conformanceReport.status === "pass"
      ? "adapter satisfies the asserted component-host conformance boundary"
      : gapReason(conformanceGaps),
    gaps: conformanceGaps,
    conformanceReport,
  });
}

export function evaluateAdapterProfile(profile) {
  const adapter = normalizeProfile(profile, "profile");
  const gaps = [];

  for (const interfaceId of REQUIRED_WASI_INTERFACES) {
    if (!adapter.wasiInterfaces.includes(interfaceId)) {
      gaps.push({
        code: "component_host.wasi-interface-missing",
        interface: interfaceId,
        requiredBy: "ADR-0031 component-host conformance",
        remediation: "register an adapter implementation for the pinned wasi interface before selecting this host",
      });
    }
  }

  for (const behavior of ASSERTED_BEHAVIORS) {
    if (adapter.determinism[behavior.key] !== true) {
      gaps.push({
        code: "component_host.determinism-control-missing",
        checkId: behavior.checkId,
        requiredBy: "ADR-0024/ADR-0031 portability guarantee",
        remediation: "prove this behavior in @hobo/conformance/component-host or fail planning",
      });
    }
  }

  return deepFreeze(gaps);
}

export function applyHostWithOptions({ adapterProfile, hostOptions }) {
  const adapter = normalizeProfile(adapterProfile, "adapterProfile");
  const options = normalizeHostOptions(hostOptions);
  const applied = [];
  const inert = [];

  for (const option of options) {
    const supported =
      option.hostKind === adapter.host.kind &&
      adapter.supportedHostOptions.includes(option.option);
    const target = {
      host: adapter.host.kind,
      option: `host.${option.hostKind}.with("${option.option}")`,
      value: option.value,
    };

    if (supported) {
      applied.push({
        ...target,
        status: "applied",
      });
    } else {
      inert.push({
        ...target,
        status: "inert",
        reason: option.hostKind === adapter.host.kind
          ? "adapter does not support this host option"
          : "option belongs to a different component-host kind",
      });
    }
  }

  return deepFreeze({ applied, inert });
}

export function doctorHostWithOptions({ hostOptions = [] } = {}) {
  const findings = normalizeHostOptions(hostOptions).map((option) => ({
    code: "component_host.host-lock-in",
    severity: "warning",
    source: `host.${option.hostKind}.with("${option.option}")`,
    reason: "host-specific option narrows the portability target set",
    remediation: "keep the option typed and include it in the PortabilityReport/doctor output",
  }));

  return deepFreeze({
    schema: "hobo.doctor.component-host-adapter-certification/v1",
    findings,
  });
}

function certificationReport({
  adapter,
  baseline,
  doctor,
  hostOptionResult,
  status,
  decision,
  reason,
  gaps,
  conformanceReport,
}) {
  const coveredAssertions = conformanceReport
    ? Object.entries(conformanceReport.crossHostAssertions).map(([id, assertionStatus]) => ({
        id: camelToKebab(id),
        status: assertionStatus,
      }))
    : ASSERTED_BEHAVIORS.map((behavior) => ({ id: behavior.checkId, status: "not-run" }));

  return deepFreeze({
    schema: ADAPTER_CERTIFICATION_SCHEMA,
    issue: "HOBO-35",
    ok: status === "certified",
    status,
    decision,
    reason,
    adapter: publicProfile(adapter),
    baseline: publicProfile(baseline),
    gaps,
    coveredDivergences: coveredAssertions,
    nonCoveredDivergences: conformanceReport?.nonCoveredDivergences ?? adapter.nonCoveredDivergences,
    hostOptions: hostOptionResult,
    doctor,
    crossHostE2E: {
      component: "hobo:examples/hello-bindle@0.1.0/service",
      from: hostDescriptor(baseline),
      to: hostDescriptor(adapter),
      status: conformanceReport?.status ?? "not-run",
      equivalentBehavior: conformanceReport?.status === "pass",
      assertedBy: coveredAssertions.filter((assertion) => assertion.status === "pass").map((assertion) => assertion.id),
    },
    conformanceReport,
  });
}

function createCertificationManifest({ baseline, adapter }) {
  return deepFreeze({
    schema: "hobo.manifest/v1",
    componentHost: {
      suite: COMPONENT_HOST_SUITE,
      suiteVersion: "0.1.0",
      certifiedHosts: [hostDescriptor(baseline), hostDescriptor(adapter)],
    },
  });
}

function toFixtureHost(profile) {
  return createReferenceRuntimeLocalHost({
    kind: profile.host.kind,
    version: profile.host.version,
    boundaryMode: profile.host.boundaryMode,
    nanBits: CANONICAL_NAN_BITS,
    ...profile.hostBehaviorOverrides,
  });
}

function createProfile(base, overrides) {
  return deepFreeze({
    ...base,
    ...overrides,
    host: {
      ...base.host,
      ...overrides.host,
    },
    wasiInterfaces: [...(overrides.wasiInterfaces ?? base.wasiInterfaces)],
    determinism: {
      ...base.determinism,
      ...overrides.determinism,
    },
    supportedHostOptions: [...(overrides.supportedHostOptions ?? base.supportedHostOptions)],
    hostBehaviorOverrides: {
      ...base.hostBehaviorOverrides,
      ...overrides.hostBehaviorOverrides,
    },
    nonCoveredDivergences: [...(overrides.nonCoveredDivergences ?? base.nonCoveredDivergences)],
  });
}

function normalizeProfile(profile, fieldName) {
  if (!profile || !isJsonObject(profile)) {
    throw new TypeError(`${fieldName} is required`);
  }
  requireNonEmptyString(profile.id, `${fieldName}.id`);
  requireNonEmptyString(profile.host?.kind, `${fieldName}.host.kind`);
  requireNonEmptyString(profile.host?.version, `${fieldName}.host.version`);
  requireNonEmptyString(profile.host?.boundaryMode, `${fieldName}.host.boundaryMode`);
  if (!Array.isArray(profile.wasiInterfaces)) {
    throw new TypeError(`${fieldName}.wasiInterfaces must be an array`);
  }
  return profile;
}

function normalizeHostOptions(hostOptions) {
  if (!Array.isArray(hostOptions)) {
    throw new TypeError("hostOptions must be an array");
  }
  return hostOptions.map((option, index) => {
    requireNonEmptyString(option?.hostKind, `hostOptions[${index}].hostKind`);
    requireNonEmptyString(option?.option, `hostOptions[${index}].option`);
    return {
      hostKind: option.hostKind,
      option: option.option,
      value: option.value,
    };
  });
}

function allAssertedBehaviors(value) {
  return Object.fromEntries(ASSERTED_BEHAVIORS.map((behavior) => [behavior.key, value]));
}

function hostDescriptor(profile) {
  return {
    kind: profile.host.kind,
    version: profile.host.version,
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    role: profile.role,
    host: hostDescriptor(profile),
    wasiInterfaces: [...profile.wasiInterfaces].sort(),
    supportedHostOptions: [...profile.supportedHostOptions].sort(),
  };
}

function gapReason(gaps) {
  if (gaps.length === 0) return "no gaps";
  const missingWasi = gaps.filter((gap) => gap.code === "component_host.wasi-interface-missing");
  if (missingWasi.length > 0) {
    return `component_host.wasi-interface-missing: ${missingWasi.map((gap) => gap.interface).join(", ")}`;
  }
  return gaps.map((gap) => gap.checkId ?? gap.code).join(", ");
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
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
