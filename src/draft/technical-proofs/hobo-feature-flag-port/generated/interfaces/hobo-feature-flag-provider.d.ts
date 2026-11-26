/** @module Interface hobo:feature-flag/provider@0.1.0 **/
export function getBooleanDetails(key: string, defaultValue: boolean, context: EvaluationContext | undefined): BooleanEvaluationDetails;
export function getStringDetails(key: string, defaultValue: string, context: EvaluationContext | undefined): StringEvaluationDetails;
export function getNumberDetails(key: string, defaultValue: number, context: EvaluationContext | undefined): NumberEvaluationDetails;
export function getObjectDetails(key: string, defaultValue: JsonValue, context: EvaluationContext | undefined): ObjectEvaluationDetails;
export type BooleanEvaluationDetails = import('./hobo-feature-flag-types.js').BooleanEvaluationDetails;
export type EvaluationContext = import('./hobo-feature-flag-types.js').EvaluationContext;
export type JsonValue = import('./hobo-feature-flag-types.js').JsonValue;
export type NumberEvaluationDetails = import('./hobo-feature-flag-types.js').NumberEvaluationDetails;
export type ObjectEvaluationDetails = import('./hobo-feature-flag-types.js').ObjectEvaluationDetails;
export type StringEvaluationDetails = import('./hobo-feature-flag-types.js').StringEvaluationDetails;
