const COMPONENT_HOST_SUITE = "component-host-portability/v1";

export class HostPlanningError extends Error {
  constructor({ code, reason, phase, expected, actual, details }) {
    super(`${code}: ${reason}`);
    this.name = "HostPlanningError";
    this.code = code;
    this.reason = reason;
    this.phase = phase;
    this.expected = expected;
    this.actual = actual;
    this.details = details ;
  }
}

export function createHostManifest({
  bindle,
  component,
  componentHost,
  hostOptions = {}
}) {
  assertPresent("bindle", bindle);
  assertPresent("component", component);
  const hostPin = pinHost(componentHost);

  return clone({
    schema: "hobo.manifest-ir.component-host/v1",
    bindle,
    component,
    componentHost: hostPin,
    hostOptions,
    upgradePolicy: {
      gate: "explicit-operator-request",
      semanticsChange: "verified-upcaster-required"
    }
  });
}

export function planComponentHostDeployment({ manifest, campHost }) {
  const current = pinHost(manifest.componentHost);
  const actual = pinHost(campHost);

  if (!sameHostVersion(current, actual)) {
    throw new HostPlanningError({
      code: "component_host.host-version-incompatible",
      reason: "manifest-host-pin-does-not-match-camp-host",
      phase: "planning",
      expected: current,
      actual,
      details: {
        bindle: manifest.bindle,
        component: manifest.component,
        recovery: "run an explicit host upgrade plan before deploying to this Camp host"
      }
    });
  }

  return {
    ok: true,
    decision: "plan-current-host",
    manifest: clone(manifest),
    events: [
      {
        type: "componentHost.PlanAccepted",
        bindle: manifest.bindle,
        component: manifest.component,
        host: publicHostRef(current)
      }
    ]
  };
}

export function planHostUpgrade({
  manifest,
  targetHost,
  requestedBy,
  conformanceReports = [],
  upcasters = []
}) {
  const current = pinHost(manifest.componentHost);
  const target = pinHost(targetHost);

  if (!requestedBy) {
    throw new HostPlanningError({
      code: "component_host.upgrade-gate-required",
      reason: "host-upgrade-request-missing-operator-gate",
      phase: "host-upgrade",
      expected: current,
      actual: target,
      details: {
        recovery: "supply a human/operator upgrade request before changing host pins"
      }
    });
  }

  if (current.kind !== target.kind || current.name !== target.name) {
    throw new HostPlanningError({
      code: "component_host.host-kind-incompatible",
      reason: "host-upgrade-cannot-cross-host-kind-or-name",
      phase: "host-upgrade",
      expected: current,
      actual: target,
      details: {
        recovery: "cross-host adapter moves are outside the HOBO-36 upgrade contract"
      }
    });
  }

  const conformance = findPassingConformance(conformanceReports, target);
  if (!conformance) {
    throw new HostPlanningError({
      code: "component_host.conformance-required",
      reason: "target-host-has-no-passing-conformance-report",
      phase: "host-upgrade",
      expected: current,
      actual: target,
      details: {
        requiredSuite: COMPONENT_HOST_SUITE
      }
    });
  }

  const semanticsChange = hostSemanticsChanged(current, target);
  const events = [
    {
      type: "componentHost.UpgradeRequested",
      by: requestedBy,
      from: publicHostRef(current),
      to: publicHostRef(target)
    }
  ];

  let upgradedManifest = clone(manifest);
  const appliedUpcasters = [];

  if (semanticsChange) {
    const upcaster = findVerifiedUpcaster(upcasters, current, target);
    if (!upcaster) {
      throw new HostPlanningError({
        code: "component_host.upcaster-required",
        reason: "semantics-changing-host-upgrade-has-no-verified-upcaster",
        phase: "host-upgrade",
        expected: current,
        actual: target,
        details: {
          requiredEdge: `${hostKey(current)} -> ${hostKey(target)}`
        }
      });
    }

    upgradedManifest = clone(upcaster.apply(clone(manifest)));
    appliedUpcasters.push(upcaster.id);
    events.push({
      type: "componentHost.UpcasterApplied",
      upcaster: upcaster.id,
      from: publicHostRef(current),
      to: publicHostRef(target)
    });
  }

  upgradedManifest = {
    ...upgradedManifest,
    componentHost: target,
    upgradePolicy: clone(manifest.upgradePolicy)
  };

  events.push({
    type: "componentHost.UpgradeAccepted",
    bindle: upgradedManifest.bindle,
    conformanceSuite: conformance.suite,
    from: publicHostRef(current),
    to: publicHostRef(target)
  });

  return {
    ok: true,
    decision: semanticsChange ? "upgrade-host-with-upcaster" : "upgrade-host",
    manifest: clone(upgradedManifest),
    appliedUpcasters,
    events
  };
}

export function doctorHostCompatibility({
  manifest,
  registeredHosts = []
}) {
  const current = pinHost(manifest.componentHost);
  const lockIn = Object.keys(manifest.hostOptions ).map((option) => ({
    code: "component_host.host-lock-in",
    option,
    reason: "manifest uses host-specific option"
  }));

  const upgradeReadiness = registeredHosts
    .map((entry) => normalizeRegisteredHost(entry))
    .filter((entry) =>
      entry.host.kind === current.kind &&
      entry.host.name === current.name &&
      entry.host.version !== current.version
    )
    .map((entry) => {
      if (
        entry.conformance?.status !== "pass" ||
        entry.conformance?.suite !== COMPONENT_HOST_SUITE
      ) {
        return readiness(entry.host, "blocked", "target host needs passing conformance report");
      }
      if (!hostSemanticsChanged(current, entry.host)) {
        return readiness(entry.host, "ready", "no semantics change detected");
      }
      if (entry.upcaster?.verified === true) {
        return readiness(entry.host, "ready-with-upcaster", "verified upcaster available");
      }
      return readiness(
        entry.host,
        "blocked",
        "semantics-changing host upgrade requires verified upcaster"
      );
    });

  return {
    schema: "hobo.doctor.component-host-version/v1",
    issue: "HOBO-36",
    currentPin: publicHostRef(current),
    lockIn,
    upgradeReadiness
  };
}

function assertPresent(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(`${name} is required`);
  }
}

function pinHost(host) {
  assertPresent("componentHost", host);
  assertPresent("componentHost.kind", host.kind);
  assertPresent("componentHost.name", host.name);
  assertPresent("componentHost.version", host.version);

  return {
    kind: host.kind,
    name: host.name,
    version: host.version,
    behaviorProfileHash: host.behaviorProfileHash ?? null
  };
}

function publicHostRef(host) {
  return {
    kind: host.kind,
    name: host.name,
    version: host.version
  };
}

function sameHostVersion(left, right) {
  return left.kind === right.kind &&
    left.name === right.name &&
    left.version === right.version;
}

function hostKey(host) {
  return `${host.kind}:${host.name}@${host.version}`;
}

function hostSemanticsChanged(current, target) {
  return current.behaviorProfileHash !== null &&
    target.behaviorProfileHash !== null &&
    current.behaviorProfileHash !== target.behaviorProfileHash;
}

function findPassingConformance(reports, target) {
  return reports.find((report) => {
    const reportHost = pinHost(report.host);
    return sameHostVersion(reportHost, target) &&
      report.status === "pass" &&
      report.suite === COMPONENT_HOST_SUITE;
  });
}

function findVerifiedUpcaster(upcasters, current, target) {
  return upcasters.find((upcaster) => {
    const from = pinHost(upcaster.from);
    const to = pinHost(upcaster.to);
    return sameHostVersion(from, current) &&
      sameHostVersion(to, target) &&
      upcaster.verified === true &&
      upcaster.apply instanceof Function;
  });
}

function normalizeRegisteredHost(entry) {
  return {
    host: pinHost(entry.host),
    conformance: clone(entry.conformance ?? null),
    upcaster: clone(entry.upcaster ?? null)
  };
}

function readiness(host, status, reason) {
  return {
    to: publicHostRef(host),
    status,
    reason
  };
}

function clone(value) {
  return structuredClone(value);
}
