import { isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import {

  STABILITY_TIERS,
  evaluateDeprecationWindow,
  satisfies as satisfiesPolicy,
} from "../../distributed-artifact-version-policy/src/version-policy.js";

export const DISTRIBUTED_ARTIFACT_RESOLVER_CONTRACT =
  "hobo.registry.distributed-artifact-resolver/v1";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const STABILITY_ORDER = new Map(STABILITY_TIERS.map((tier, index) => [tier, index]));
const MAX_RESOLUTION_ITERATIONS = 64;

export function resolveDistributedArtifacts(input = {}) {
  const catalog = canonicalizeCatalog(input.catalog ?? []);
  const byName = catalogByName(catalog);
  const currentPins = canonicalizePins(input.currentPins ?? []);
  const lockPins = canonicalizePins(input.lockPins ?? []);
  const catalogSnapshotHash = snapshotHash(catalog);
  const rootRequests = canonicalizeRequests(input.requests ?? []);
  const selected = new Map();
  const mode = input.mode ?? "install";
  const now = input.now;
  const upcasters = input.upcasters ?? [];

  const lockValidation = validateLockPins(currentPins, lockPins);
  if (lockValidation) return lockValidation;

  for (let iteration = 0; iteration < MAX_RESOLUTION_ITERATIONS; iteration += 1) {
    const constraints = collectConstraints(rootRequests, selected);
    let changed = false;

    for (const selectedName of Array.from(selected.keys())) {
      if (!constraints.has(selectedName)) {
        selected.delete(selectedName);
        changed = true;
      }
    }

    for (const name of [...constraints.keys()].sort()) {
      const existing = selected.get(name);
      const nameConstraints = constraints.get(name) ?? [];
      if (existing && pinSatisfiesAll(existing, nameConstraints) && isServable(existing, now)) {
        continue;
      }

      const resolution = resolveOne({
        name,
        constraints: nameConstraints,
        byName,
        currentPins,
        mode,
        now,
        upcasters,
      });
      if (!resolution.ok) return resolution;

      if (!existing || pinIdentity(existing) !== pinIdentity(resolution.entry)) {
        selected.set(name, resolution.entry);
        changed = true;
      }
    }

    if (!changed) {
      const pins = [...selected.values()]
        .map(pinProjection)
        .sort(comparePins);

      return {
        ok: true,
        contract: DISTRIBUTED_ARTIFACT_RESOLVER_CONTRACT,
        catalogSnapshotHash,
        pins,
        manifestIr: {
          schema: "hobo.manifest/v1",
          artifactPins: manifestPinRecords({ pins, constraints, catalogSnapshotHash }),
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "resolver-non-convergent",
      iterations: MAX_RESOLUTION_ITERATIONS,
    },
  };
}

export function canonicalResolutionResult(result) {
  if (!result.ok) return result;

  return {
    ok: true,
    pins: result.pins.map(pinProjection),
  };
}

function resolveOne({ name, constraints, byName, currentPins, mode, now, upcasters }) {
  const currentPin = currentPins.find((pin) => pin.name === name);
  const currentEntry = currentPin
    ? findCatalogEntry(byName.get(name) ?? [], currentPin)
    : null;

  if (mode === "plan" && currentPin) {
    if (!currentEntry) {
      return {
        ok: false,
        error: {
          code: "manifest-pin-not-in-catalog",
          name,
          current: pinIdentity(currentPin),
          reason: "catalog snapshot must contain the immutable manifest pin before plan can preserve it",
        },
      };
    }

    if (pinSatisfiesAll(currentEntry, constraints) && isServable(currentEntry, now)) {
      return {
        ok: true,
        entry: currentEntry,
      };
    }

    return immutablePinMutationError({ name, currentPin, constraints });
  }

  const candidates = (byName.get(name) ?? [])
    .filter((candidate) => isServable(candidate, now))
    .filter((candidate) => pinSatisfiesAll(candidate, constraints))
    .sort(compareCandidates);

  if (candidates.length === 0) {
    return dependencyConflict(name, constraints);
  }

  const selected = candidates[0];
  if (
    currentPin &&
    pinIdentity(selected) !== pinIdentity(currentPin) &&
    requiresUpcaster(currentPin, selected) &&
    !hasUpcaster({ upcasters, name, from: currentPin.version, to: selected.version })
  ) {
    return {
      ok: false,
      error: {
        code: "upcaster-required",
        name,
        from: currentPin.version,
        to: selected.version,
      },
    };
  }

  return {
    ok: true,
    entry: selected,
  };
}

function canonicalizeCatalog(catalog) {
  return catalog
    .map((entry) => ({
      ...entry,
      tier: entry.tier ?? "stable",
      dependencies: canonicalizeRequests(entry.dependencies ?? []),
    }))
    .sort(compareCatalogEntries);
}

function canonicalizePins(pins) {
  return pins
    .map((pin) => ({ ...pin }))
    .sort(comparePins);
}

function canonicalizeRequests(requests) {
  return requests
    .map((request) => ({ name: request.name, range: request.range }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.range.localeCompare(right.range));
}

function catalogByName(catalog) {
  const byName = new Map();
  for (const entry of catalog) {
    const entries = byName.get(entry.name) ?? [];
    entries.push(entry);
    byName.set(entry.name, entries);
  }
  return byName;
}

function validateLockPins(currentPins, lockPins) {
  if (lockPins.length === 0) return null;

  const currentByName = new Map(currentPins.map((pin) => [pin.name, pin]));
  const lockByName = new Map(lockPins.map((pin) => [pin.name, pin]));
  const names = [...new Set([...currentByName.keys(), ...lockByName.keys()])].sort();

  for (const name of names) {
    const currentPin = currentByName.get(name);
    const lockPin = lockByName.get(name);
    const manifest = currentPin ? pinIdentity(currentPin) : null;
    const lock = lockPin ? pinIdentity(lockPin) : null;
    if (manifest !== lock) {
      return {
        ok: false,
        error: {
          code: "lock-mismatch",
          name,
          manifest,
          lock,
        },
      };
    }
  }

  return null;
}

function addConstraint(constraints, name, constraint) {
  const list = constraints.get(name) ?? [];
  list.push(constraint);
  constraints.set(name, list);
}

function collectConstraints(rootRequests, selected) {
  const constraints = new Map();
  for (const request of rootRequests) {
    addConstraint(constraints, request.name, {
      via: "root",
      range: request.range,
      path: `${request.name} ${request.range}`,
    });
  }

  for (const entry of [...selected.values()].sort(comparePins)) {
    for (const dependency of canonicalizeRequests(entry.dependencies ?? [])) {
      addConstraint(constraints, dependency.name, {
        via: entry.name,
        range: dependency.range,
        path: `${entry.name}@${entry.version} -> ${dependency.name} ${dependency.range}`,
      });
    }
  }

  return constraints;
}

function pinSatisfiesAll(candidate, constraints) {
  return constraints.every((constraint) => {
    const verdict = satisfiesPolicy({
      installed: candidate.version,
      requested: constraint.range,
      tier: candidate.tier ?? "stable",
    }).verdict;

    return verdict === "compatible" ||
      verdict === "compatible-with-warning" ||
      verdict === "upcaster-required";
  });
}

function dependencyConflict(name, constraints) {
  return {
    ok: false,
    error: {
      code: "dependency-conflict",
      name,
      constraints: constraints.map((constraint) => constraint.path).sort(),
    },
  };
}

function immutablePinMutationError({ name, currentPin, constraints }) {
  return {
    ok: false,
    error: {
      code: "immutable-pin-mutation",
      name,
      current: pinIdentity(currentPin),
      constraints: constraints.map((constraint) => constraint.path).sort(),
      reason: "publish a new Bindle version to change an immutable manifest pin",
    },
  };
}

function manifestPinRecords({ pins, constraints, catalogSnapshotHash }) {
  return pins.map((pin) => ({
    ...pinProjection(pin),
    immutable: true,
    constraints: (constraints.get(pin.name) ?? []).map((constraint) => constraint.path).sort(),
    catalogSnapshotHash,
  }));
}

function findCatalogEntry(entries, pin) {
  return entries.find((entry) => entry.version === pin.version && entry.digest === pin.digest);
}

function requiresUpcaster(from, to) {
  if (to.tier !== "preview" && to.tier !== "experimental") return false;
  return compareVersions(parseVersion(from.version), parseVersion(to.version)) !== 0;
}

function hasUpcaster({ upcasters, name, from, to }) {
  return upcasters.some((upcaster) =>
    upcaster.name === name &&
    upcaster.from === from &&
    upcaster.to === to
  );
}

function isServable(candidate, now) {
  if (candidate.tier !== "deprecated" || !candidate.deprecationExpiresAt || !now) {
    return true;
  }

  const deprecation = evaluateDeprecationWindow({
    status: "deprecated",
    expiresAt: candidate.deprecationExpiresAt,
    checkedAt: now,
  });

  return deprecation.state === "deprecated";
}

function compareCandidates(left, right) {
  const tier = stabilityRank(left) - stabilityRank(right);
  if (tier !== 0) return tier;

  const version = compareVersions(parseVersion(right.version), parseVersion(left.version));
  if (version !== 0) return version;

  return left.digest.localeCompare(right.digest);
}

function compareCatalogEntries(left, right) {
  const name = left.name.localeCompare(right.name);
  if (name !== 0) return name;

  const version = compareVersions(parseVersion(left.version), parseVersion(right.version));
  if (version !== 0) return version;

  const tier = stabilityRank(left) - stabilityRank(right);
  if (tier !== 0) return tier;

  return left.digest.localeCompare(right.digest);
}

function comparePins(left, right) {
  return left.name.localeCompare(right.name);
}

function stabilityRank(entry) {
  return STABILITY_ORDER.get(entry.tier ?? "stable") ?? 99;
}

function snapshotHash(catalog) {
  return `sha256:${createHash("sha256").update(stableStringify(catalog)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function parseVersion(version) {
  const match = SEMVER_RE.exec(String(version));
  if (!match) throw new Error(`invalid semver: ${version}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function pinProjection(entry) {
  return {
    name: entry.name,
    version: entry.version,
    digest: entry.digest,
  };
}

function pinIdentity(pin) {
  return `${pin.version}@${pin.digest}`;
}
