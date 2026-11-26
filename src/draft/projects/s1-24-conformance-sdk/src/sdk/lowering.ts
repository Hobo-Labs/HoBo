import { canonicalJson } from "./canonical-json.js";
import type { LaneReport, LoweringFixture, SdkIdiomAdapter, VectorCaseResult } from "./types.js";

export function runGoldenIrLoweringLane(
  corpus: readonly LoweringFixture[],
  adapter: SdkIdiomAdapter,
): LaneReport {
  const cases: VectorCaseResult[] = corpus.map((fixture) => {
    const actual = adapter.lower(fixture.program);
    const witPassed =
      canonicalJson(actual.witCalls) === canonicalJson(fixture.expectedWitCalls);
    const manifestPassed =
      canonicalJson(actual.manifest) === canonicalJson(fixture.expectedManifest);

    if (witPassed && manifestPassed) {
      return { name: fixture.name, status: "passed" };
    }

    const expected = {
      witCalls: fixture.expectedWitCalls,
      manifest: fixture.expectedManifest,
    };
    const actualPayload = {
      witCalls: actual.witCalls,
      manifest: actual.manifest,
    };

    return {
      name: fixture.name,
      status: "failed",
      reason: !witPassed
        ? "lowered WIT calls diverged from golden-IR corpus"
        : "lowered manifest IR diverged from golden-IR corpus",
      expectedJson: canonicalJson(expected),
      actualJson: canonicalJson(actualPayload),
      diffPaths: !witPassed ? ["witCalls"] : ["manifest"],
    };
  });

  return Object.freeze({
    lane: "golden-ir-lowering-equivalence",
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    boundedByCorpus: true,
    cases,
  });
}
