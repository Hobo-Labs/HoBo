/** @module Interface hobo:feature-flag/hooks@0.1.0 **/
export function before(invocation: HookInvocation): EvaluationContext | undefined;
export function after(invocation: HookInvocation, details: EvaluationDetails): void;
export function onError(invocation: HookInvocation, error: EvaluationError): void;
export { _finally as finally };
function _finally(invocation: HookInvocation): void;
export type EvaluationContext = import('./hobo-feature-flag-types.js').EvaluationContext;
export type EvaluationDetails = import('./hobo-feature-flag-types.js').EvaluationDetails;
export type EvaluationError = import('./hobo-feature-flag-types.js').EvaluationError;
export type HookInvocation = import('./hobo-feature-flag-types.js').HookInvocation;
