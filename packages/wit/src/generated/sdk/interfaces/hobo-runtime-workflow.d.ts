/** @module Interface hobo:runtime/workflow@0.1.0 **/
export function runStep(name: string, input: Bytes, opts: StepOpts): Bytes;
export function sleep(durationMs: bigint): void;
export function emit(event: Event): bigint;
export function createHook(name: string): HookToken;
export function start(workflowName: string, input: Bytes, idempotencyKey: string | undefined): RunHandle;
export type Bytes = import('./hobo-runtime-types.js').Bytes;
export type Event = import('./hobo-runtime-types.js').Event;
export type HookToken = import('./hobo-runtime-types.js').HookToken;
export type RunHandle = import('./hobo-runtime-types.js').RunHandle;
export type RuntimeError = import('./hobo-runtime-types.js').RuntimeError;
export type StepOpts = import('./hobo-runtime-types.js').StepOpts;
