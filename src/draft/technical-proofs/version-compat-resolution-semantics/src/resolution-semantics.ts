const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const STABILITY_ORDER = new Map([
  ["stable", 0],
  ["preview", 1],
  ["experimental", 2],
  ["deprecated", 3]
]);

export function resolveVector(vector) {
  const byName = catalogByName(vector.catalog ?? []);
  const constraints = new Map();
  const selected = new Map();

  for (const pin of vector.currentPins ?? []) {
    const lockPin = (vector.lockPins ?? []).find((candidate) => candidate.name === pin.name);
    if (lockPin && pinIdentity(lockPin) !== pinIdentity(pin)) {
      return {
        ok: false,
        error: {
          code: "lock-mismatch",
          name: pin.name,
          manifest: pinIdentity(pin),
          lock: pinIdentity(lockPin)
        }
      };
    }
  }

  for (const request of vector.requests ?? []) {
    addConstraint(constraints, request.name, {
      via: "root",
      range: request.range,
      path: `${request.name} ${request.range}`
    });
  }

  while (true) {
    const nextName = [...constraints.keys()]
      .filter((name) => !selected.has(name))
      .sort()[0];

    if (!nextName) break;

    const resolution = resolveOne({
      name: nextName,
      constraints: constraints.get(nextName),
      byName,
      currentPins: vector.currentPins ?? [],
      mode: vector.mode,
      now: vector.now
    });

    if (!resolution.ok) return resolution;
    selected.set(nextName, resolution.pin);

    for (const dependency of resolution.entry.dependencies ?? []) {
      addConstraint(constraints, dependency.name, {
        via: resolution.entry.name,
        range: dependency.range,
        path: `${resolution.entry.name}@${resolution.entry.version} -> ${dependency.name} ${dependency.range}`
      });
    }
  }

  return {
    ok: true,
    pins: [...selected.values()].sort(comparePins)
  };
}

export function canonicalResult(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    pins: result.pins.map(({ name, version, digest }) => ({ name, version, digest }))
  };
}

function resolveOne({ name, constraints, byName, currentPins, mode, now }) {
  const currentPin = currentPins.find((pin) => pin.name === name);
  if (mode === "plan" && currentPin && pinSatisfiesAll(currentPin, constraints) && isServable(currentPin, now)) {
    return {
      ok: true,
      pin: pinProjection(currentPin),
      entry: findCatalogEntry(byName.get(name) ?? [], currentPin) ?? { ...currentPin, dependencies: [] }
    };
  }

  const candidates = (byName.get(name) ?? [])
    .filter((candidate) => isServable(candidate, now))
    .filter((candidate) => constraints.every((constraint) => satisfies(candidate.version, constraint.range)))
    .sort(compareCandidates);

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "dependency-conflict",
        name,
        constraints: constraints.map((constraint) => constraint.path).sort()
      }
    };
  }

  const selected = candidates[0];
  if (currentPin && selected.digest !== currentPin.digest && requiresUpcaster(currentPin, selected)) {
    return {
      ok: false,
      error: {
        code: "upcaster-required",
        name,
        from: currentPin.version,
        to: selected.version
      }
    };
  }

  return {
    ok: true,
    pin: pinProjection(selected),
    entry: selected
  };
}

function catalogByName(catalog) {
  const byName = new Map();
  for (const entry of catalog) {
    const list = byName.get(entry.name) ?? [];
    list.push(entry);
    byName.set(entry.name, list);
  }
  return byName;
}

function addConstraint(constraints, name, constraint) {
  const list = constraints.get(name) ?? [];
  list.push(constraint);
  constraints.set(name, list);
}

function pinSatisfiesAll(pin, constraints) {
  return constraints.every((constraint) => satisfies(pin.version, constraint.range));
}

function findCatalogEntry(entries, pin) {
  return entries.find((entry) => entry.version === pin.version && entry.digest === pin.digest);
}

function requiresUpcaster(from, to) {
  if (to.tier !== "preview" && to.tier !== "experimental") return false;
  return compareVersions(parseVersion(from.version), parseVersion(to.version)) !== 0;
}

function isServable(candidate, now) {
  if (candidate.tier !== "deprecated" || !candidate.deprecationExpiresAt || !now) return true;
  return Date.parse(now) < Date.parse(candidate.deprecationExpiresAt);
}

function satisfies(version, range) {
  const parsed = parseRange(range);
  const candidate = parseVersion(version);
  if (parsed.kind === "exact") {
    return compareVersions(candidate, parsed.lowerInclusive) === 0;
  }

  return (
    compareVersions(candidate, parsed.lowerInclusive) >= 0 &&
    compareVersions(candidate, parsed.upperExclusive) < 0
  );
}

function parseRange(range) {
  const trimmed = String(range).trim();
  if (SEMVER_RE.test(trimmed)) {
    const exact = parseVersion(trimmed);
    return {
      kind: "exact",
      lowerInclusive: exact,
      upperExclusive: bumpPatch(exact)
    };
  }

  if (trimmed.startsWith("^")) {
    const lower = parseVersion(trimmed.slice(1));
    return {
      kind: "caret",
      lowerInclusive: lower,
      upperExclusive: caretUpperBound(lower)
    };
  }

  if (trimmed.startsWith("~")) {
    const lower = parseVersion(trimmed.slice(1));
    return {
      kind: "tilde",
      lowerInclusive: lower,
      upperExclusive: {
        major: lower.major,
        minor: lower.minor + 1,
        patch: 0
      }
    };
  }

  const bounded = /^>=([^\s]+)\s+<([^\s]+)$/.exec(trimmed);
  if (bounded) {
    const lower = parseVersion(bounded[1]);
    const upper = parseVersion(bounded[2]);
    return {
      kind: "bounded",
      lowerInclusive: lower,
      upperExclusive: upper
    };
  }

  throw new Error(`unsupported range: ${range}`);
}

function parseVersion(version) {
  const match = SEMVER_RE.exec(String(version));
  if (!match) throw new Error(`invalid semver: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? ""
  };
}

function compareCandidates(left, right) {
  const tier = (STABILITY_ORDER.get(left.tier) ?? 99) - (STABILITY_ORDER.get(right.tier) ?? 99);
  if (tier !== 0) return tier;

  const version = compareVersions(parseVersion(right.version), parseVersion(left.version));
  if (version !== 0) return version;

  return left.digest.localeCompare(right.digest);
}

function comparePins(left, right) {
  return left.name.localeCompare(right.name);
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

function bumpPatch(version) {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1
  };
}

function caretUpperBound(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

function pinProjection(entry) {
  return {
    name: entry.name,
    version: entry.version,
    digest: entry.digest
  };
}

function pinIdentity(pin) {
  return `${pin.version}@${pin.digest}`;
}
