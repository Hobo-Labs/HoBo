/** @module Interface hobo:sdk/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"stable"`
 *
 * ## `"preview"`
 *
 * ## `"experimental"`
 *
 * ## `"deprecated"`
 */
export type StabilityTier = 'stable' | 'preview' | 'experimental' | 'deprecated';
/**
 * # Variants
 *
 * ## `"api"`
 *
 * ## `"schedule"`
 *
 * ## `"website"`
 *
 * ## `"storage"`
 *
 * ## `"secret"`
 *
 * ## `"config"`
 *
 * ## `"database"`
 *
 * ## `"cache"`
 *
 * ## `"queue"`
 *
 * ## `"event-stream"`
 *
 * ## `"feature-flag"`
 *
 * ## `"function"`
 *
 * ## `"workflow"`
 *
 * ## `"actor"`
 *
 * ## `"agent"`
 */
export type ResourceKind = 'api' | 'schedule' | 'website' | 'storage' | 'secret' | 'config' | 'database' | 'cache' | 'queue' | 'event-stream' | 'feature-flag' | 'function' | 'workflow' | 'actor' | 'agent';
/**
 * # Variants
 *
 * ## `"read"`
 *
 * ## `"write"`
 *
 * ## `"invoke"`
 *
 * ## `"publish"`
 *
 * ## `"subscribe"`
 *
 * ## `"deploy"`
 *
 * ## `"administer"`
 */
export type GrantVerb = 'read' | 'write' | 'invoke' | 'publish' | 'subscribe' | 'deploy' | 'administer';
/**
 * # Variants
 *
 * ## `"completed"`
 *
 * ## `"retry"`
 *
 * ## `"compensating"`
 *
 * ## `"failed"`
 */
export type StepStatus = 'completed' | 'retry' | 'compensating' | 'failed';
export interface InterfaceRef {
  namespace: string,
  packageName: string,
  interfaceName: string,
  version: string,
  stability: StabilityTier,
}
export interface ResourceRef {
  kind: ResourceKind,
  name: string,
  interfaceRef: InterfaceRef,
}
export interface CapabilityGrant {
  target: ResourceRef,
  verbs: Array<GrantVerb>,
}
export interface ManifestIr {
  component: string,
  resources: Array<ResourceRef>,
  grants: Array<CapabilityGrant>,
}
export interface WorkflowStep {
  name: string,
  idempotencyKey: string,
  timeoutMs: bigint,
  grants: Array<CapabilityGrant>,
}
export interface StepResult {
  status: StepStatus,
  encodedJson: string,
}
export interface CommandMessage {
  name: string,
  encodedJson: string,
  idempotencyKey: string,
}
export interface SubscriptionFilter {
  streamName: string,
  eventTypes: Array<string>,
}
export interface DataQuery {
  target: ResourceRef,
  predicateJson: string,
  limit?: number,
}
export interface DataChange {
  target: ResourceRef,
  eventType: string,
  encodedJson: string,
}
export type SdkError = SdkErrorUnauthorized | SdkErrorNotFound | SdkErrorConflict | SdkErrorDeadlineExceeded | SdkErrorInvalidContract;
export interface SdkErrorUnauthorized {
  tag: 'unauthorized',
  val: string,
}
export interface SdkErrorNotFound {
  tag: 'not-found',
  val: string,
}
export interface SdkErrorConflict {
  tag: 'conflict',
  val: string,
}
export interface SdkErrorDeadlineExceeded {
  tag: 'deadline-exceeded',
  val: string,
}
export interface SdkErrorInvalidContract {
  tag: 'invalid-contract',
  val: string,
}
