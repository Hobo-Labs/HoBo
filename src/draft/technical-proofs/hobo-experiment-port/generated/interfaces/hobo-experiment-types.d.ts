/** @module Interface hobo:experiment/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"counter"`
 *
 * ## `"gauge"`
 *
 * ## `"histogram"`
 *
 * ## `"duration"`
 *
 * ## `"ratio"`
 */
export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'duration' | 'ratio';
/**
 * # Variants
 *
 * ## `"inconclusive"`
 *
 * ## `"promote"`
 *
 * ## `"rollback"`
 *
 * ## `"needs-human"`
 */
export type AnalysisVerdict = 'inconclusive' | 'promote' | 'rollback' | 'needs-human';
/**
 * # Variants
 *
 * ## `"split"`
 *
 * ## `"holdout"`
 *
 * ## `"override"`
 *
 * ## `"default"`
 */
export type AssignmentReason = 'split' | 'holdout' | 'override' | 'default';
/**
 * # Variants
 *
 * ## `"invalid-definition"`
 *
 * ## `"unassigned-subject"`
 *
 * ## `"invalid-event"`
 */
export type ExperimentErrorCode = 'invalid-definition' | 'unassigned-subject' | 'invalid-event';
export interface PrincipalRef {
  kind: string,
  id: string,
  tenant?: string,
}
export interface ExperimentVariant {
  key: string,
  allocationBasisPoints: number,
  flagVariant: string,
}
export interface MetricRef {
  name: string,
  kind: MetricKind,
  source: string,
  primary: boolean,
  guardrail: boolean,
}
export interface ExperimentDefinition {
  key: string,
  flagKey: string,
  sampleRatioBasisPoints: number,
  variants: Array<ExperimentVariant>,
  metrics: Array<MetricRef>,
}
export interface AssignmentRequest {
  experimentKey: string,
  subject: PrincipalRef,
  contextHash: string,
}
export interface Assignment {
  experimentKey: string,
  subject: PrincipalRef,
  variantKey: string,
  flagKey: string,
  flagVariant: string,
  sampled: boolean,
  reason: AssignmentReason,
}
export interface Exposure {
  experimentKey: string,
  subject: PrincipalRef,
  variantKey: string,
  sampled: boolean,
  occurredAt: string,
}
export interface AnalysisResult {
  experimentKey: string,
  verdict: AnalysisVerdict,
  winningVariant?: string,
  confidence: number,
  reason: string,
}
export interface ExperimentError {
  code: ExperimentErrorCode,
  message: string,
}
