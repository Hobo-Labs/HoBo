/** @module Interface hobo:sdk/saga@0.1.0 **/
export function begin(name: string, idempotencyKey: string): string;
export function recordStep(sagaId: string, spec: WorkflowStep, stepOutput: StepResult): void;
export function rollback(sagaId: string, reason: string): void;
export type SdkError = import('./hobo-sdk-types.js').SdkError;
export type StepResult = import('./hobo-sdk-types.js').StepResult;
export type WorkflowStep = import('./hobo-sdk-types.js').WorkflowStep;
