/** @module Interface hobo:sdk/workflow@0.1.0 **/
export function step(spec: WorkflowStep): StepResult;
export function compensate(spec: WorkflowStep): StepResult;
export type SdkError = import('./hobo-sdk-types.js').SdkError;
export type StepResult = import('./hobo-sdk-types.js').StepResult;
export type WorkflowStep = import('./hobo-sdk-types.js').WorkflowStep;
