/** @module Interface hobo:feature-flag/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"boolean"`
 *
 * ## `"string"`
 *
 * ## `"number"`
 *
 * ## `"object"`
 */
export type ValueType = 'boolean' | 'string' | 'number' | 'object';
/**
 * # Variants
 *
 * ## `"static"`
 *
 * ## `"targeting-match"`
 *
 * ## `"split"`
 *
 * ## `"cached"`
 *
 * ## `"default"`
 *
 * ## `"error"`
 *
 * ## `"disabled"`
 *
 * ## `"unknown"`
 */
export type EvaluationReason = 'static' | 'targeting-match' | 'split' | 'cached' | 'default' | 'error' | 'disabled' | 'unknown';
export interface EvaluationError {
  code: string,
  message?: string,
}
export interface JsonValue {
  encodedJson: string,
}
export type AttributeValue = AttributeValueBoolean | AttributeValueNumber | AttributeValueString | AttributeValueJson;
export interface AttributeValueBoolean {
  tag: 'boolean',
  val: boolean,
}
export interface AttributeValueNumber {
  tag: 'number',
  val: number,
}
export interface AttributeValueString {
  tag: 'string',
  val: string,
}
export interface AttributeValueJson {
  tag: 'json',
  val: JsonValue,
}
export interface ContextAttribute {
  key: string,
  value: AttributeValue,
}
export interface PrincipalRef {
  kind: string,
  id: string,
  tenant?: string,
  claims: Array<ContextAttribute>,
}
export interface EvaluationContext {
  user?: PrincipalRef,
  identity?: PrincipalRef,
  attributes: Array<ContextAttribute>,
}
export interface BooleanEvaluationDetails {
  flagKey: string,
  value: boolean,
  reason: EvaluationReason,
  variant?: string,
  error?: EvaluationError,
}
export interface StringEvaluationDetails {
  flagKey: string,
  value: string,
  reason: EvaluationReason,
  variant?: string,
  error?: EvaluationError,
}
export interface NumberEvaluationDetails {
  flagKey: string,
  value: number,
  reason: EvaluationReason,
  variant?: string,
  error?: EvaluationError,
}
export interface ObjectEvaluationDetails {
  flagKey: string,
  value: JsonValue,
  reason: EvaluationReason,
  variant?: string,
  error?: EvaluationError,
}
export type EvaluationDetails = EvaluationDetailsBoolean | EvaluationDetailsString | EvaluationDetailsNumber | EvaluationDetailsObject;
export interface EvaluationDetailsBoolean {
  tag: 'boolean',
  val: BooleanEvaluationDetails,
}
export interface EvaluationDetailsString {
  tag: 'string',
  val: StringEvaluationDetails,
}
export interface EvaluationDetailsNumber {
  tag: 'number',
  val: NumberEvaluationDetails,
}
export interface EvaluationDetailsObject {
  tag: 'object',
  val: ObjectEvaluationDetails,
}
export interface HookInvocation {
  flagKey: string,
  valueType: ValueType,
  defaultValue: JsonValue,
  context: EvaluationContext,
}
