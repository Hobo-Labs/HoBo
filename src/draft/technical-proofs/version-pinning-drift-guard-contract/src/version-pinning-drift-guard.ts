import {
  evaluateDeprecationWindow,
  satisfies as satisfiesPolicy,
} from "../../distributed-artifact-version-policy/src/version-policy.js";
import {
  resolveDistributedArtifacts,
} from "../../distributed-artifact-resolver-contract/src/distributed-artifact-resolver.js";

export const VERSION_PINNING_DRIFT_GUARD_CONTRACT =
  "hobo.registry.version-pinning-drift-guard/v1";

export function planPinnedRedeploy(input = {}) {
  const runningPins = pinProjections(input.currentPins ?? []);
  const unservablePin = findUnservableCurrentPin({
    currentPins: input.currentPins ?? [],
    catalog: input.catalog ?? [],
    now: input.now,
  });

  if (unservablePin) {
    return {
      ok: false,
      contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
      runningPins,
      forcedRewrite: false,
      error: {
        code: "redeploy-blocked-unservable-pin",
        name: unservablePin.name,
        current: pinIdentity(unservablePin),
        remediation: "publish a new Bindle version with an explicit upcaster and re-conformance",
      },
    };
  }

  const resolution = resolveDistributedArtifacts({
    ...input,
    mode: "plan",
  });

  if (!resolution.ok) {
    return {
      ok: false,
      contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
      runningPins,
      forcedRewrite: false,
      error: resolution.error,
    };
  }

  const redeployPins = pinProjections(resolution.pins);
  const upgradeTarget = findUpgradeTarget({
    requests: input.requests ?? [],
    currentPins: input.currentPins ?? [],
    catalog: input.catalog ?? [],
  });

  return {
    ok: true,
    contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
    runningPins,
    redeployPins,
    forcedRewrite: false,
    driftPrevented: samePinSet(runningPins, redeployPins) && Boolean(upgradeTarget),
    reason: "immutable Bindle pin preserved during ordinary redeploy",
    remediation: upgradeTarget
      ? {
          kind: "explicit-upgrade-required",
          name: upgradeTarget.name,
          targetVersion: upgradeTarget.version,
        }
      : null,
  };
}

export function adoptPreviewBumpAsNewBindleVersion(input = {}) {
  if (input.currentBindleVersion === input.nextBindleVersion) {
    return {
      ok: false,
      contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
      forcedRewrite: false,
      error: {
        code: "new-bindle-version-required",
        reason: "preview bump adoption must publish a new Bindle version",
      },
    };
  }

  const resolution = resolveDistributedArtifacts({
    ...input,
    mode: "upgrade",
  });

  if (!resolution.ok) {
    return {
      ok: false,
      contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
      forcedRewrite: false,
      error: resolution.error,
    };
  }

  if (input.conformanceReport?.status !== "passed") {
    return {
      ok: false,
      contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
      forcedRewrite: false,
      error: {
        code: "reconformance-required",
        reason: "new Bindle version adoption must carry a passing conformance report",
      },
    };
  }

  return {
    ok: true,
    contract: VERSION_PINNING_DRIFT_GUARD_CONTRACT,
    previousBindleVersion: input.currentBindleVersion,
    nextBindleVersion: input.nextBindleVersion,
    oldPins: pinProjections(input.currentPins ?? []),
    newPins: pinProjections(resolution.pins),
    forcedRewrite: false,
    replanRequired: true,
    reconformanceRequired: true,
  };
}

function findUnservableCurrentPin({ currentPins, catalog, now }) {
  if (!now) return null;

  for (const pin of currentPins) {
    const entry = catalog.find((candidate) =>
      candidate.name === pin.name &&
      candidate.version === pin.version &&
      candidate.digest === pin.digest
    );

    if (entry?.tier !== "deprecated") continue;
    const deprecation = evaluateDeprecationWindow({
      status: "deprecated",
      expiresAt: entry.deprecationExpiresAt,
      checkedAt: now,
    });

    if (deprecation.state === "unservable") return pin;
  }

  return null;
}

function findUpgradeTarget({ requests, currentPins, catalog }) {
  for (const request of requests) {
    const currentPin = currentPins.find((pin) => pin.name === request.name);
    if (!currentPin) continue;

    const candidates = catalog
      .filter((candidate) => candidate.name === request.name)
      .filter((candidate) => pinIdentity(candidate) !== pinIdentity(currentPin))
      .filter((candidate) => {
        const verdict = satisfiesPolicy({
          installed: candidate.version,
          requested: request.range,
          tier: candidate.tier ?? "stable",
        }).verdict;

        return verdict === "compatible" ||
          verdict === "compatible-with-warning" ||
          verdict === "upcaster-required";
      })
      .sort((left, right) => compareVersions(parseVersion(right.version), parseVersion(left.version)));

    if (candidates.length > 0) return candidates[0];
  }

  return null;
}

function pinProjections(pins) {
  return pins
    .map(({ name, version, digest }) => ({ name, version, digest }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function samePinSet(left, right) {
  return JSON.stringify(pinProjections(left)) === JSON.stringify(pinProjections(right));
}

function pinIdentity(pin) {
  return `${pin.version}@${pin.digest}`;
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(String(version));
  if (!match) throw new Error(`invalid semver: ${version}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  return 0;
}
