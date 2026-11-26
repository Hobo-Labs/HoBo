import { runGoldenIrLoweringLane } from "./lowering.js";
import { runAuthorshipLane, runCoverageLane, runThinIdiomLayerLane } from "./lanes.js";
import { runSemanticsAnnex } from "./semantics-annex.js";
import type { RunSdkIdiomConformanceOptions, SdkConformanceReport } from "./types.js";

export const sdkConformanceGateSpec = Object.freeze({
  suite: "@hobo/conformance/sdk" as const,
  contract: "hobo:sdk@0.1.0" as const,
  lanes: [
    "golden-ir-lowering-equivalence",
    "semantics-annex",
    "thin-idiom-layer",
    "authorship-neutral-gate",
    "coverage-claim",
  ],
  corpusClaim:
    "Golden-IR equivalence is bounded by the checked corpus; semantics outside that corpus must be covered by annex vectors or called out as unsupported.",
});

export async function runSdkIdiomConformance(
  options: RunSdkIdiomConformanceOptions,
): Promise<SdkConformanceReport> {
  const {
    layerName = "@hobo/bindles",
    authorship = "hand-authored",
    corpus,
    annexVectors,
    adapter,
    helperClaims = [],
    sourceFiles = [],
    corpusPath,
    annexPath,
  } = options;

  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new TypeError("SDK conformance requires a non-empty golden-IR corpus");
  }
  if (!Array.isArray(annexVectors) || annexVectors.length === 0) {
    throw new TypeError("SDK conformance requires non-empty semantics-annex vectors");
  }
  if (!adapter) {
    throw new TypeError("SDK conformance requires a semantics-annex adapter");
  }

  const lowering = runGoldenIrLoweringLane(corpus, adapter);
  const semantics = await runSemanticsAnnex(annexVectors, adapter);
  const thinLayer = runThinIdiomLayerLane(sourceFiles);
  const authorshipLane = runAuthorshipLane(authorship);
  const coverage = runCoverageLane({
    ...(corpusPath ? { corpusPath } : undefined),
    ...(annexPath ? { annexPath } : undefined),
    annexVectors,
    helperClaims,
  });

  const lanes = [lowering, semantics, thinLayer, authorshipLane, coverage];
  const status = lanes.every((lane) => lane.status === "passed") ? "passed" : "failed";

  return Object.freeze({
    suite: sdkConformanceGateSpec.suite,
    contract: sdkConformanceGateSpec.contract,
    layerName,
    authorship,
    status,
    corpusClaim: sdkConformanceGateSpec.corpusClaim,
    lanes,
  });
}
