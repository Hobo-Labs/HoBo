export const verdicts = Object.freeze({
  FULL: "full",
  PARTIAL: "partial",
  NONE: "none",
  WARN: "warn",
  REJECTED: "rejected",
});

export function makeProviderEntry({
  provider,
  resourceClass,
  port,
  paradigm,
  engines = [],
  native = [],
  emulated = [],
  conformance = "passed",
  remediation,
}) {
  return {
    provider,
    resourceClass,
    port,
    paradigm,
    engines: new Set(engines),
    native: new Set(native),
    emulated: new Set(emulated),
    conformance,
    remediation,
  };
}

export function satisfies(request, entry) {
  if (entry.conformance !== "passed") {
    return {
      verdict: verdicts.NONE,
      reason: "conformance-not-passed",
    };
  }

  if (entry.port !== request.port) {
    return {
      verdict: verdicts.NONE,
      reason: "port-mismatch",
    };
  }

  if (entry.paradigm !== request.paradigm) {
    return {
      verdict: verdicts.NONE,
      reason: "paradigm-mismatch",
    };
  }

  if (request.engine && !entry.engines.has(request.engine)) {
    return {
      verdict: verdicts.NONE,
      reason: "engine-mismatch",
    };
  }

  const requiredMissing = missingFeatures(entry, request.require ?? []);
  const preferredMissing = missingFeatures(entry, request.prefer ?? []);
  const emulatedPreferred = emulatedFeatures(entry, request.prefer ?? []);

  if (requiredMissing.length > 0 || preferredMissing.length > 0 || emulatedPreferred.length > 0) {
    return {
      verdict: verdicts.PARTIAL,
      missing: [
        ...requiredMissing,
        ...preferredMissing,
        ...emulatedPreferred.map((feature) => `${feature}:emulated`),
      ],
      requiredMissing,
      remediation: entry.remediation,
    };
  }

  return {
    verdict: verdicts.FULL,
    missing: [],
  };
}

export function resolveCapability({ request, catalog }) {
  const evaluated = catalog.map((entry) => ({
    entry,
    match: satisfies(request, entry),
  }));

  const full = evaluated.find((candidate) => candidate.match.verdict === verdicts.FULL);
  if (full) {
    return {
      verdict: verdicts.FULL,
      provider: full.entry.provider,
      resourceClass: full.entry.resourceClass,
      evaluated,
    };
  }

  const partial = evaluated.find(
    (candidate) =>
      candidate.match.verdict === verdicts.PARTIAL &&
      (candidate.match.requiredMissing?.length ?? 0) === 0,
  );
  if (partial) {
    return {
      verdict: verdicts.WARN,
      provider: partial.entry.provider,
      resourceClass: partial.entry.resourceClass,
      warning: {
        kind: "prefer-degraded",
        missing: partial.match.missing,
        remediation: partial.match.remediation,
      },
      evaluated,
    };
  }

  return {
    verdict: verdicts.REJECTED,
    reason: "no-equivalent-provider",
    rejected: evaluated.map(({ entry, match }) => ({
      provider: entry.provider,
      resourceClass: entry.resourceClass,
      reason:
        match.reason ??
        ((match.requiredMissing?.length ?? 0) > 0 ? "required-features-missing" : "partial-only"),
      missing: match.missing ?? [],
      remediation: match.remediation,
    })),
  };
}

function missingFeatures(entry, features) {
  return features.filter((feature) => !entry.native.has(feature) && !entry.emulated.has(feature));
}

function emulatedFeatures(entry, features) {
  return features.filter((feature) => entry.emulated.has(feature));
}
