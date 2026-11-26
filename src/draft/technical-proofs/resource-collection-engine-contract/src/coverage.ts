import type { CoverageEvaluatorContext, CoverageSummary } from "./types.js";

export function defaultCoverageEvaluator(
  context: CoverageEvaluatorContext,
): CoverageSummary {
  return emptyCoverage({
    observedResourceIds: context.observedResourceIds,
    observedBindKeys: context.observedBindKeys,
  });
}

export function emptyCoverage({
  observedResourceIds,
  observedBindKeys,
}: {
  observedResourceIds: readonly string[];
  observedBindKeys: readonly string[];
}): CoverageSummary {
  return {
    ok: true,
    canDeployDimension: "collectionCoverage",
    status: "pass",
    observedResourceIds: [...observedResourceIds],
    observedBindKeys: [...observedBindKeys],
    declaredResources: [],
    declaredBinds: [],
    unobservedDeclarations: [],
    unobservedBinds: [],
    unreachableDeclarations: [],
    unreachableBinds: [],
    unresolvedDeclarations: [],
    unresolvedBinds: [],
    diagnostics: [],
  };
}
