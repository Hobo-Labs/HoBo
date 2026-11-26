import { isDeepStrictEqual } from "node:util";
import { isJsonString, isJsonObject } from "./json.js";


export const COMPONENT_HOST_CONFORMANCE_SCHEMA = "@hobo/conformance/component-host/v1";

const NON_COVERED_DIVERGENCES = Object.freeze([
  "wall-clock scheduling jitter",
  "host-specific partial-failure timing",
]);
const CANONICAL_NAN_BITS = "0x7ff8000000000000";
const REFERENCE_CLOCK_REPLAY = deepFreeze({
  componentId: "clocked-worker",
  counter: 3,
  ticks: [0, 25, 50],
  terminalState: "counter:3@50",
});
const REFERENCE_WASI_ROUND_TRIP = deepFreeze({
  interface: "wasi:keyvalue/store",
  version: "0.2.0",
  request: { key: "todo-1", value: "ship" },
  response: {
    ok: true,
    value: "wasi:todo-1",
  },
});
const REFERENCE_LINK_LATE_BINDING = deepFreeze({
  componentId: "api",
  importInterface: "wasi:http/outgoing-handler@0.2.0",
  providerExport: "wasi:http/outgoing-handler@0.2.0",
  response: {
    status: 200,
    body: "linked:/healthz",
  },
});
const REFERENCE_FUEL_SCHEDULE = Object.freeze([
  Object.freeze({ epoch: 0, fuelRemaining: 8, step: "load" }),
  Object.freeze({ epoch: 1, fuelRemaining: 4, step: "call-provider" }),
  Object.freeze({ epoch: 2, fuelRemaining: 0, step: "yield" }),
]);
const REFERENCE_RESOURCE_LIMIT = Object.freeze({
  memoryPages: 16,
  maxMemoryPages: 16,
  status: "trapped",
  trap: "component_host.resource-limit-exceeded",
});

export class ComponentHostPlanningError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${details.hostKind ?? "unknown"}@${details.hostVersion ?? "unknown"}`);
    this.name = "ComponentHostPlanningError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class CapabilityIsolationError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${details.componentId ?? "unknown"}:${details.importInterface ?? "unknown"}`);
    this.name = "CapabilityIsolationError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function createReferenceComponentHostManifest() {
  return deepFreeze({
    schema: "hobo.manifest/v1",
    componentHost: {
      suite: "@hobo/conformance/component-host",
      suiteVersion: "0.1.0",
      certifiedHosts: [
        { kind: "runtime-local", version: "wasmtime/46.0.1" },
        { kind: "wasm-in-container", version: "wasmtime-container/46.0.1" },
      ],
    },
  });
}

export function createReferenceRuntimeLocalHost(options = {}) {
  return new FixtureComponentHost({
    kind: "runtime-local",
    version: "wasmtime/46.0.1",
    boundaryMode: "in-process",
    ...options,
  });
}

export function createReferenceInContainerHost(options = {}) {
  return new FixtureComponentHost({
    kind: "wasm-in-container",
    version: "wasmtime-container/46.0.1",
    boundaryMode: "container",
    ...options,
  });
}

export function planComponentHost(manifest, host) {
  const pins = normalizeHostPins(manifest);
  const candidate = hostDescriptor(host);
  const exact = pins.find(
    (pin) => pin.kind === candidate.kind && pin.version === candidate.version,
  );
  if (!exact) {
    const expectedVersions = pins
      .filter((pin) => pin.kind === candidate.kind)
      .map((pin) => pin.version);
    throw new ComponentHostPlanningError("component_host.host-version-incompatible", {
      hostKind: candidate.kind,
      hostVersion: candidate.version,
      expectedVersions,
      suite: manifest?.componentHost?.suite,
    });
  }

  return deepFreeze({
    status: "pass",
    host: candidate,
    suite: manifest.componentHost.suite,
    suiteVersion: manifest.componentHost.suiteVersion,
  });
}

export async function runComponentHostConformance({ manifest, hosts }) {
  if (!Array.isArray(hosts) || hosts.length < 2) {
    throw new TypeError("hosts must include at least two component-host candidates");
  }

  const failures = [];
  const hostReports = [];
  for (const host of hosts) {
    const report = {
      ...hostDescriptor(host),
      boundaryMode: host.boundaryMode,
      status: "pass",
      checks: [],
    };
    try {
      planComponentHost(manifest, host);
      report.checks.push({ id: "manifest-host-pin", status: "pass" });
    } catch (error) {
      report.status = "fail";
      report.checks.push({ id: "manifest-host-pin", status: "fail", message: error.message });
      failures.push(failure("manifest-host-pin", error.message, [host]));
    }
    hostReports.push(report);
  }

  const crossHostAssertions = {
    manifestHostCoverage: assertManifestHostCoverage({ manifest, hosts, failures }),
    deterministicClockReplay: await assertSameAcrossHosts({
      id: "deterministic-clock-replay",
      hosts,
      failures,
      expected: REFERENCE_CLOCK_REPLAY,
      read: (host) => host.replayDeterministicClockTrace(referenceClockTrace()),
    }),
    wasiRoundTrip: await assertSameAcrossHosts({
      id: "wasi-round-trip",
      hosts,
      failures,
      expected: REFERENCE_WASI_ROUND_TRIP,
      read: (host) => host.roundTripWasiInterface(referenceWasiRequest()),
    }),
    linkLateBinding: await assertSameAcrossHosts({
      id: "link-late-binding",
      hosts,
      failures,
      expected: REFERENCE_LINK_LATE_BINDING,
      read: (host) => host.invokeLinkedImport(referenceLinkCall()),
    }),
    capabilityHandleIsolation: await assertCapabilityIsolation({ hosts, failures }),
    fpNanCanonicalization: await assertSameAcrossHosts({
      id: "fp-nan-canonicalization",
      hosts,
      failures,
      expected: CANONICAL_NAN_BITS,
      read: (host) => host.canonicalizeNan64("0x7ff0000000000001"),
    }),
    fuelEpochScheduling: await assertSameAcrossHosts({
      id: "fuel-epoch-scheduling",
      hosts,
      failures,
      expected: REFERENCE_FUEL_SCHEDULE,
      read: (host) => host.runFuelEpochSchedule(referenceFuelWorkload()),
    }),
    resourceLimitSemantics: await assertSameAcrossHosts({
      id: "resource-limit-semantics",
      hosts,
      failures,
      expected: REFERENCE_RESOURCE_LIMIT,
      read: (host) => host.enforceResourceLimit(referenceResourceWorkload()),
    }),
  };

  return deepFreeze({
    schema: COMPONENT_HOST_CONFORMANCE_SCHEMA,
    status: failures.length === 0 ? "pass" : "fail",
    hosts: hostReports,
    crossHostAssertions,
    failures,
    nonCoveredDivergences: NON_COVERED_DIVERGENCES,
  });
}

class FixtureComponentHost {
  constructor({
    kind,
    version,
    boundaryMode,
    nanBits = CANONICAL_NAN_BITS,
    fuelSchedule = REFERENCE_FUEL_SCHEDULE,
    resourceLimit = REFERENCE_RESOURCE_LIMIT,
    deterministicClockOffsetMs = 0,
    allowAmbientCapability = false,
  }) {
    this.kind = requireNonEmptyString(kind, "host.kind");
    this.version = requireNonEmptyString(version, "host.version");
    this.boundaryMode = requireNonEmptyString(boundaryMode, "host.boundaryMode");
    this.nanBits = nanBits;
    this.fuelSchedule = clone(fuelSchedule);
    this.resourceLimit = clone(resourceLimit);
    this.deterministicClockOffsetMs = deterministicClockOffsetMs;
    this.allowAmbientCapability = allowAmbientCapability;
  }

  replayDeterministicClockTrace(trace) {
    let counter = 0;
    const ticks = [];
    for (const step of trace) {
      if (step.type === "clock.tick") {
        ticks.push(step.atMs + this.deterministicClockOffsetMs);
      }
      if (step.type === "state.increment") {
        counter += step.by;
      }
    }
    return {
      componentId: "clocked-worker",
      counter,
      ticks,
      terminalState: `counter:${counter}@${ticks.at(-1)}`,
    };
  }

  roundTripWasiInterface(request) {
    return {
      interface: request.interface,
      version: request.version,
      request: clone(request.payload),
      response: {
        ok: true,
        value: `wasi:${request.payload.key}`,
      },
    };
  }

  invokeLinkedImport(call) {
    return {
      componentId: call.componentId,
      importInterface: call.importInterface,
      providerExport: call.providerExport,
      response: {
        status: 200,
        body: `linked:${call.payload.path}`,
      },
    };
  }

  callUnlinkedCapability(call) {
    if (this.allowAmbientCapability) {
      return {
        leaked: true,
        componentId: call.componentId,
        importInterface: call.importInterface,
      };
    }
    throw new CapabilityIsolationError("component_host.capability-not-linked", {
      componentId: call.componentId,
      importInterface: call.importInterface,
    });
  }

  canonicalizeNan64() {
    return this.nanBits;
  }

  runFuelEpochSchedule() {
    return clone(this.fuelSchedule);
  }

  enforceResourceLimit() {
    return clone(this.resourceLimit);
  }
}

async function assertSameAcrossHosts({ id, hosts, failures, read, expected }) {
  const observations = [];
  for (const host of hosts) {
    observations.push({
      host: hostDescriptor(host),
      value: await read(host),
    });
  }

  const expectedValue = expected ?? observations[0].value;
  if (observations.every((observation) => sameValue(observation.value, expectedValue))) {
    return "pass";
  }

  const hostsAgree = observations.every((observation) =>
    sameValue(observation.value, observations[0].value),
  );
  failures.push({
    checkId: id,
    message: hostsAgree
      ? `${id} did not match expected reference semantics`
      : `${id} diverged across component hosts`,
    expected: expectedValue,
    observations,
  });
  return "fail";
}

async function assertCapabilityIsolation({ hosts, failures }) {
  const observations = [];
  for (const host of hosts) {
    try {
      const value = await host.callUnlinkedCapability(referenceUnlinkedCapabilityCall());
      observations.push({ host: hostDescriptor(host), status: "fail", value });
    } catch (error) {
      observations.push({
        host: hostDescriptor(host),
        status: error instanceof CapabilityIsolationError &&
          error.code === "component_host.capability-not-linked"
          ? "pass"
          : "fail",
        message: error.message,
      });
    }
  }

  if (observations.every((observation) => observation.status === "pass")) {
    return "pass";
  }
  failures.push({
    checkId: "capability-handle-isolation",
    message: "unlinked capability call must fail closed on every host",
    observations,
  });
  return "fail";
}

function assertManifestHostCoverage({ manifest, hosts, failures }) {
  const requiredHosts = normalizeHostPins(manifest);
  const presentHosts = hosts.map(hostDescriptor);
  const missingHosts = requiredHosts.filter(
    (required) =>
      !presentHosts.some(
        (present) => present.kind === required.kind && present.version === required.version,
      ),
  );

  if (missingHosts.length === 0) {
    return "pass";
  }

  failures.push({
    checkId: "manifest-host-coverage",
    message: "all manifest-certified component hosts must run in the conformance report",
    missingHosts,
    hosts: presentHosts,
  });
  return "fail";
}

function referenceClockTrace() {
  return [
    { type: "clock.tick", atMs: 0 },
    { type: "state.increment", by: 1 },
    { type: "clock.tick", atMs: 25 },
    { type: "state.increment", by: 2 },
    { type: "clock.tick", atMs: 50 },
  ];
}

function referenceWasiRequest() {
  return {
    interface: "wasi:keyvalue/store",
    version: "0.2.0",
    payload: { key: "todo-1", value: "ship" },
  };
}

function referenceLinkCall() {
  return {
    componentId: "api",
    importInterface: "wasi:http/outgoing-handler@0.2.0",
    providerExport: "wasi:http/outgoing-handler@0.2.0",
    payload: { path: "/healthz" },
  };
}

function referenceUnlinkedCapabilityCall() {
  return {
    componentId: "api",
    importInterface: "wasi:blobstore/blobstore@0.2.0",
  };
}

function referenceFuelWorkload() {
  return { componentId: "cpu-bound-worker", initialFuel: 12 };
}

function referenceResourceWorkload() {
  return { componentId: "memory-bound-worker", requestedMemoryPages: 17 };
}

function normalizeHostPins(manifest) {
  const pins = manifest?.componentHost?.certifiedHosts;
  if (!Array.isArray(pins) || pins.length === 0) {
    throw new ComponentHostPlanningError("component_host.manifest-host-pins-required", {
      suite: manifest?.componentHost?.suite,
    });
  }
  return pins.map((pin) => hostDescriptor(pin));
}

function hostDescriptor(host) {
  return {
    kind: requireNonEmptyString(host?.kind, "host.kind"),
    version: requireNonEmptyString(host?.version, "host.version"),
  };
}

function failure(checkId, message, hosts) {
  return {
    checkId,
    message,
    hosts: hosts.map(hostDescriptor),
  };
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right);
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
