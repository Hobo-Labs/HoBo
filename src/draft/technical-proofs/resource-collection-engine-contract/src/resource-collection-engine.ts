// Backward-compatible entry for existing imports.
export {
  collectBindleResources,
  CollectionEngineError,
  parseCollectionInput,
} from "./collection-engine.js";
export type {
  CollectionContext,
  CollectionEvent,
  CollectionInput,
  CollectionResult,
  CoverageEvaluator,
  CoverageSummary,
  SideEffectRecord,
} from "./types.js";
