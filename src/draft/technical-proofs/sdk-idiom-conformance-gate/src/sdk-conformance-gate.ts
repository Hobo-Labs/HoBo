import {
  assertThinIdiomLayer,
  lowerCanonicalSdkProgram,
  lowerFluentBindle,
  runLoweringConformance,
} from "../../idiom-layer-lowering-contract/src/lowering-contract.js";
import { runSemanticsAnnex } from "../../idiom-semantics-annex/src/semantics-annex.js";

export const sdkConformanceGateSpec = Object.freeze({
  suite: "@hobo/conformance/sdk",
  contract: "hobo:sdk@0.1.0",
  lanes: [
    "golden-ir-lowering-equivalence",
    "semantics-annex",
    "resilience-semantics-annex",
    "thin-idiom-layer",
    "authorship-neutral-gate",
  ],
  corpusClaim:
    "Golden-IR equivalence is bounded by the checked corpus; semantics outside that corpus must be covered by annex vectors or called out as unsupported.",
});

export function buildTypescriptSdkLowerers(overrides = {}) {
  return {
    idiom: overrides.idiom ?? ((fixture) => lowerFluentBindle(fixture.fluent)),
    canonical:
      overrides.canonical ??
      ((fixture) => lowerCanonicalSdkProgram(fixture.expectedManifest)),
  };
}

export async function runSdkIdiomConformance({
  layerName = "@hobo/bindles",
  authorship = "hand-authored",
  corpus,
  corpusPath,
  annexVectors,
  annexPath,
  annexAdapter,
  resilienceReport,
  helperClaims = [],
  lowerers = buildTypescriptSdkLowerers(),
  sourceFiles = [],
} = {}) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new TypeError("SDK conformance requires a non-empty golden-IR corpus");
  }
  if (!Array.isArray(annexVectors) || annexVectors.length === 0) {
    throw new TypeError("SDK conformance requires non-empty semantics-annex vectors");
  }
  if (!annexAdapter) {
    throw new TypeError("SDK conformance requires a semantics-annex adapter");
  }

  const lowering = runLoweringConformance(
    corpus,
    {
      typescript: lowerers.idiom,
      canonical: lowerers.canonical,
    },
    { corpusPath },
  );
  const semantics = await runSemanticsAnnex(annexVectors, annexAdapter);
  const resilience = runResilienceLane({ resilienceReport });
  const thinLayer = runThinLayerLane(sourceFiles);
  const authorshipLane = runAuthorshipLane(authorship);
  const coverage = runCoverageLane({
    corpusPath,
    annexPath,
    annexVectors,
    resilienceReport,
    helperClaims,
  });

  const laneList = [lowering, semantics, resilience, thinLayer, authorshipLane, coverage];

  return {
    suite: sdkConformanceGateSpec.suite,
    contract: sdkConformanceGateSpec.contract,
    layerName,
    authorship,
    status: laneList.every((lane) => lane.status === "passed") ? "passed" : "failed",
    lanes: {
      lowering: {
        ...lowering,
        lane: "golden-ir-lowering-equivalence",
        boundedByCorpus: true,
      },
      semantics: {
        ...semantics,
        lane: "semantics-annex",
        annexPath,
      },
      existingSemantics: {
        ...semantics,
        lane: "semantics-annex",
        annexPath,
      },
      resilience,
      thinLayer,
      authorship: authorshipLane,
      coverage,
    },
  };
}

const requiredResilienceCases = Object.freeze([
  "transient-retry-schedule",
  "denial-never-retries",
  "terminal-never-retries",
  "cancellation-stops-retry",
  "deadline-escalates-from-state",
  "cleanup-after-interruption",
  "replay-no-effect-rerun",
]);

function runResilienceLane({ resilienceReport }) {
  if (!resilienceReport) {
    return {
      suite: "@hobo/conformance/sdk/resilience-semantics-annex",
      lane: "resilience-semantics-annex",
      status: "failed",
      cases: requiredResilienceCases.map((name) => ({
        name,
        status: "failed",
        reason: "missing resilience-semantics-annex report",
      })),
    };
  }

  const publishedCases = resilienceReport.resilienceSemanticsLane?.cases ?? [];
  const publishedByName = new Map(publishedCases.map((entry) => [entry.name, entry]));
  const requiredCaseNames = new Set(requiredResilienceCases);
  const cases = requiredResilienceCases.map((name) => {
    const entry = publishedByName.get(name);
    if (!entry) {
      return {
        name,
        status: "failed",
        reason: "missing resilience-semantics-annex vector",
      };
    }

    return formatResilienceCase(entry);
  });
  const extraFailures = publishedCases
    .filter((entry) => !requiredCaseNames.has(entry.name) && entry.status !== "passed")
    .map(formatResilienceCase);
  const allCases = [...cases, ...extraFailures];

  return {
    suite: "@hobo/conformance/sdk/resilience-semantics-annex",
    lane: "resilience-semantics-annex",
    specVersion: resilienceReport.specVersion,
    status:
      resilienceReport.status === "passed" &&
      allCases.every((entry) => entry.status === "passed")
        ? "passed"
        : "failed",
    cases: allCases,
  };
}

function formatResilienceCase(entry) {
  const caseResult = {
    name: entry.name,
    status: entry.status,
    code: entry.code,
    reason: entry.reason,
  };
  if (entry.seed) {
    caseResult.seed = entry.seed;
  }
  return caseResult;
}

function runThinLayerLane(sourceFiles) {
  const violations = assertThinIdiomLayer(sourceFiles);
  const violationsByPath = new Map();

  for (const violation of violations) {
    const entries = violationsByPath.get(violation.path) ?? [];
    entries.push(violation);
    violationsByPath.set(violation.path, entries);
  }

  return {
    suite: "@hobo/conformance/sdk/thin-idiom-layer",
    lane: "thin-idiom-layer",
    status: violations.length === 0 ? "passed" : "failed",
    cases: sourceFiles.map((file) => {
      const fileViolations = violationsByPath.get(file.path) ?? [];
      return {
        name: file.path,
        status: fileViolations.length === 0 ? "passed" : "failed",
        reason:
          fileViolations.length === 0
            ? undefined
            : fileViolations.map((entry) => `${entry.reason}: ${entry.match}`).join("; "),
      };
    }),
  };
}

function runAuthorshipLane(authorship) {
  const accepted = new Set(["hand-authored", "generated"]);
  const status = accepted.has(authorship) ? "passed" : "failed";

  return {
    suite: "@hobo/conformance/sdk/authorship-neutral-gate",
    lane: "authorship-neutral-gate",
    status,
    trustedByConvention: false,
    sameGateFor: ["hand-authored", "generated"],
    cases: [
      {
        name: `${authorship}-uses-same-gate`,
        status,
        reason: status === "passed" ? undefined : `unknown idiom-layer authorship: ${authorship}`,
      },
    ],
  };
}

function runCoverageLane({
  corpusPath,
  annexPath,
  annexVectors = [],
  resilienceReport,
  helperClaims = [],
}) {
  const coveredClaims = new Set([
    ...annexVectors.map((vector) => vector.name),
    ...(resilienceReport?.resilienceSemanticsLane?.cases ?? []).map((entry) => entry.name),
  ]);
  const helperClaimCases = helperClaims.map((name) => {
    if (coveredClaims.has(name)) {
      return { name, status: "passed" };
    }

    return {
      name,
      status: "failed",
      reason: "helper claim has no golden-IR, semantics-annex, or resilience vector",
    };
  });

  return {
    suite: "@hobo/conformance/sdk/coverage-claim",
    lane: "coverage-claim",
    status: helperClaimCases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    claim: "bounded-by-corpus",
    corpusPath,
    annexPath,
    helperClaims: helperClaimCases,
    notCoveredHere: [
      "authoring non-TS idiom layers",
      "AI-generation implementation loop",
      "full @hobo/bindles fluent surface",
    ],
    requiredFollowupForOffCorpusSemantics:
      "Add semantics-annex vectors or mark the behavior unsupported before claiming parity.",
  };
}
