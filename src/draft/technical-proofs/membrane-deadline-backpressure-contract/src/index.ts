export {
  classifyFailure,
  failureStrategies,
  parseFailureClassification,
  CLASSIFICATION_EVENT_TYPE,
  type FailureClass,
  type FailureClassification,
  type FailureStrategy,
} from "./failure-taxonomy.js";
export { deriveDeadline, parseDeadline, type Deadline } from "./deadline.js";
export {
  DeadlineExceededError,
  MembraneOverloadedError,
  MembraneSeveredError,
  AmbiguousReturnError,
} from "./errors.js";
export { createManualClock, type ManualClock } from "./manual-clock.js";
export {
  createMembraneDeadlineBackpressure,
  createJsonWitCodec,
  MEMBRANE_CONTRACT_VERSION,
  type CallContext,
  type CallOptions,
  type MembraneEvent,
  type ProviderRegistration,
  type WitCodec,
} from "./membrane.js";
export {
  reconcileAmbiguousFailure,
  type EventStorePort,
  type ReconcileCall,
} from "./reconcile-ambiguous-failure.js";
export {
  runMembraneFailureLane,
  MEMBRANE_FAILURE_LANE_VERSION,
  type MembraneFailureLaneReport,
} from "./conformance-lane.js";
