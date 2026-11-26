import { isJsonString } from "./json.js";
export const STABILITY_TIERS = Object.freeze([
  "stable",
  "preview",
  "experimental",
  "deprecated"
]);

const SEMVER_PATTERN_SOURCE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const SEMVER_RE = new RegExp(`^${SEMVER_PATTERN_SOURCE}$`);

export function normalizeVersion(version) {
  const parsed = parseVersion(version);

  return {
    canonical: formatVersion(parsed, { includeBuild: false }),
    original: version,
    ...(parsed.build ? { build: parsed.build } : undefined)
  };
}

export function validateAcceptedRange(range) {
  const parsed = parseRange(range);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  if (parsed.range.kind === "bounded" && crossesMajorBoundary(parsed.range)) {
    return {
      ok: false,
      reason: "range crosses major boundary for a pinned consumer"
    };
  }

  return { ok: true, normalized: parsed.range.normalized };
}

export function satisfies({ installed, requested, tier }) {
  assertTier(tier);

  const rangeCheck = validateAcceptedRange(requested);
  if (!rangeCheck.ok) {
    return { verdict: "invalid-range", reason: rangeCheck.reason };
  }

  const installedVersion = parseVersion(installed);
  const range = parseRange(requested).range;
  if (!versionInRange(installedVersion, range)) {
    return {
      verdict: "incompatible",
      reason: `${normalizeVersion(installed).canonical} does not satisfy ${range.normalized}`
    };
  }

  const bump = classifyTierAwareBump({
    from: range.base,
    to: installed,
    tier
  });

  if (bump.verdict !== "compatible") {
    return bump;
  }

  if (tier === "deprecated") {
    return {
      verdict: "compatible-with-warning",
      reason: "deprecated artifact pin remains selectable until its deprecation window expires"
    };
  }

  return { verdict: "compatible" };
}

export function classifyTierAwareBump({ from, to, tier }) {
  assertTier(tier);

  const fromVersion = parseVersion(from);
  const toVersion = parseVersion(to);
  if (compareVersions(fromVersion, toVersion) === 0) {
    return { verdict: "compatible" };
  }

  if (tier === "stable") {
    if (fromVersion.major !== toVersion.major) {
      return {
        verdict: "incompatible",
        reason: "stable major bump is incompatible without an explicit migration"
      };
    }

    return { verdict: "compatible" };
  }

  if (tier === "preview" || tier === "experimental") {
    if (fromVersion.major === 0) {
      return {
        verdict: "upcaster-required",
        reason: "0.x preview interface bumps are potentially breaking"
      };
    }

    return {
      verdict: "upcaster-required",
      reason: `${tier} interface bump requires an upcaster and a new Bindle version`
    };
  }

  return {
    verdict: "compatible-with-warning",
    reason: "deprecated artifact pin remains selectable until its deprecation window expires"
  };
}

export function checkImmutablePinMutation({ bindleVersion, before, after }) {
  const beforePin = formatPin(before);
  const afterPin = formatPin(after);

  if (before?.name === after?.name && beforePin === afterPin) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `${bindleVersion} pins ${before.name} to ${beforePin}; publish a new Bindle version to adopt ${afterPin}`
  };
}

export function evaluateDeprecationWindow({ status, expiresAt, checkedAt }) {
  if (status !== "deprecated") {
    return { state: status };
  }

  const expires = Date.parse(expiresAt);
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(expires) || !Number.isFinite(checked)) {
    return { state: "invalid", reason: "deprecation window timestamps must be ISO-8601 dates" };
  }

  if (checked >= expires) {
    return {
      state: "unservable",
      reason: "deprecation window expired; old pins are blocked from redeploy"
    };
  }

  return { state: "deprecated" };
}

function parseRange(range) {
  try {
    return parseRangeUnsafe(range);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function parseRangeUnsafe(range) {
  if (!isJsonString(range)) {
    return { ok: false, reason: "range must be a string" };
  }

  const trimmed = range.trim();
  if (SEMVER_RE.test(trimmed)) {
    const exact = parseVersion(trimmed);
    return {
      ok: true,
      range: {
        kind: "exact",
        base: formatVersion(exact, { includeBuild: false }),
        normalized: formatVersion(exact, { includeBuild: false }),
        lowerInclusive: exact,
        upperExclusive: bumpPatch(exact)
      }
    };
  }

  if (trimmed.startsWith("^")) {
    const lower = parseVersion(trimmed.slice(1));
    return {
      ok: true,
      range: {
        kind: "caret",
        base: formatVersion(lower, { includeBuild: false }),
        normalized: `^${formatVersion(lower, { includeBuild: false })}`,
        lowerInclusive: lower,
        upperExclusive: caretUpperBound(lower)
      }
    };
  }

  if (trimmed.startsWith("~")) {
    const lower = parseVersion(trimmed.slice(1));
    return {
      ok: true,
      range: {
        kind: "tilde",
        base: formatVersion(lower, { includeBuild: false }),
        normalized: `~${formatVersion(lower, { includeBuild: false })}`,
        lowerInclusive: lower,
        upperExclusive: {
          major: lower.major,
          minor: lower.minor + 1,
          patch: 0
        }
      }
    };
  }

  const bounded = /^>=([^\s]+)\s+<([^\s]+)$/.exec(trimmed);
  if (bounded) {
    const lower = parseVersion(bounded[1]);
    const upper = parseVersion(bounded[2]);
    if (compareVersions(lower, upper) >= 0) {
      return {
        ok: false,
        reason: "range lower bound must be less than upper bound"
      };
    }

    return {
      ok: true,
      range: {
        kind: "bounded",
        base: formatVersion(lower, { includeBuild: false }),
        normalized: `>=${formatVersion(lower, { includeBuild: false })} <${formatVersion(upper, { includeBuild: false })}`,
        lowerInclusive: lower,
        upperExclusive: upper
      }
    };
  }

  return {
    ok: false,
    reason: "accepted range syntax is exact semver, ^semver, ~semver, or >=semver <semver"
  };
}

function versionInRange(version, range) {
  if (range.kind === "exact") {
    return compareVersions(version, range.lowerInclusive) === 0;
  }

  return (
    compareVersions(version, range.lowerInclusive) >= 0 &&
    compareVersions(version, range.upperExclusive) < 0
  );
}

function crossesMajorBoundary(range) {
  const lower = range.lowerInclusive;
  const upper = range.upperExclusive;

  if (upper.major > lower.major + 1) {
    return true;
  }
  if (upper.major === lower.major + 1) {
    return upper.minor !== 0 || upper.patch !== 0 || Boolean(upper.prerelease);
  }

  return false;
}

function parseVersion(version) {
  if (!isJsonString(version)) {
    throw new Error(`version must be a string: ${String(version)}`);
  }

  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`version must be semver: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : undefined),
    ...(match[5] ? { build: match[5] } : undefined)
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
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
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;

    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function formatVersion(version, { includeBuild }) {
  const prerelease = version.prerelease ? `-${version.prerelease}` : "";
  const build = includeBuild && version.build ? `+${version.build}` : "";

  return `${version.major}.${version.minor}.${version.patch}${prerelease}${build}`;
}

function bumpPatch(version) {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1
  };
}

function caretUpperBound(version) {
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (version.minor > 0) {
    return { major: 0, minor: version.minor + 1, patch: 0 };
  }

  return { major: 0, minor: 0, patch: version.patch + 1 };
}

function formatPin(pin) {
  return `${pin.version}@${pin.digest}`;
}

function assertTier(tier) {
  if (!STABILITY_TIERS.includes(tier)) {
    throw new Error(`unknown stability tier ${String(tier)}`);
  }
}
