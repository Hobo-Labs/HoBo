/** @module Interface hobo:training-engine/training-engine@0.1.0 **/
export function optimize(request: OptimizeRequest): Candidate;
export type Candidate = import('./hobo-training-engine-types.js').Candidate;
export type OptimizeRequest = import('./hobo-training-engine-types.js').OptimizeRequest;
export type TrainingError = import('./hobo-training-engine-types.js').TrainingError;
