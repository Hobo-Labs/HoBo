import { validateManifest, canonicalManifestHash } from "../../hobo-manifest-contract/src/manifest.js";
import { assembleManifest } from "./assemble-manifest.js";
import { createCollectionContext } from "./collection-context.js";
import { defaultCoverageEvaluator } from "./coverage.js";
import { createCollectionEvents } from "./events.js";
import { parseCollectionInput } from "./parse-input.js";
import type { CollectionInput, CollectionResult, CollectionState } from "./types.js";

export { CollectionEngineError } from "./errors.js";
export { parseCollectionInput } from "./parse-input.js";
export type {
  CollectionContext,
  CollectionEvent,
  CollectionInput,
  CollectionResult,
  CoverageEvaluator,
  CoverageSummary,
  SideEffectRecord,
} from "./types.js";

export function collectBindleResources(input: CollectionInput): CollectionResult {
  const source = parseCollectionInput(input);
  const state: CollectionState = {
    resources: new Map(),
    bindEdges: [],
    sideEffects: [],
  };
  const collect = createCollectionContext(state);

  source.define(collect);

  const manifest = assembleManifest({
    componentHost: source.componentHost,
    resources: state.resources,
  });
  validateManifest(manifest);

  const observedResourceIds = [...state.resources.keys()];
  const observedBindKeys = state.bindEdges.map((edge) => edge.key);
  const coverage = (source.coverageEvaluator ?? defaultCoverageEvaluator)({
    bindleId: source.bindleId,
    fileName: source.fileName,
    sourceText: source.sourceText,
    observedResourceIds,
    observedBindKeys,
  });
  const manifestHash = canonicalManifestHash(manifest);
  const events = createCollectionEvents({
    bindleId: source.bindleId,
    manifest,
    manifestHash,
    observedResourceIds,
    observedBindKeys,
    coverage,
  });

  return {
    bindleId: source.bindleId,
    manifest,
    manifestHash,
    coverage,
    events,
    sideEffects: state.sideEffects,
  };
}
