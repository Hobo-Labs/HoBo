/** @module Interface hobo:experiment/provider@0.1.0 **/
export function assign(definition: ExperimentDefinition, request: AssignmentRequest): Assignment;
export function recordExposure(assignment: Assignment, exposure: Exposure): void;
export function conclude(definition: ExperimentDefinition): AnalysisResult;
export type AnalysisResult = import('./hobo-experiment-types.js').AnalysisResult;
export type Assignment = import('./hobo-experiment-types.js').Assignment;
export type AssignmentRequest = import('./hobo-experiment-types.js').AssignmentRequest;
export type ExperimentDefinition = import('./hobo-experiment-types.js').ExperimentDefinition;
export type ExperimentError = import('./hobo-experiment-types.js').ExperimentError;
export type Exposure = import('./hobo-experiment-types.js').Exposure;
