/** @module Interface hobo:projection/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"native"`
 *
 * ## `"relational"`
 *
 * ## `"document"`
 *
 * ## `"kv"`
 *
 * ## `"wide-column"`
 *
 * ## `"graph"`
 *
 * ## `"vector"`
 *
 * ## `"object-lake"`
 *
 * ## `"olap"`
 */
export type SinkParadigm = 'native' | 'relational' | 'document' | 'kv' | 'wide-column' | 'graph' | 'vector' | 'object-lake' | 'olap';
/**
 * # Variants
 *
 * ## `"reactive"`
 *
 * ## `"non-reactive"`
 */
export type ReactivityClass = 'reactive' | 'non-reactive';
/**
 * # Variants
 *
 * ## `"strong"`
 *
 * ## `"bounded-staleness"`
 *
 * ## `"session"`
 *
 * ## `"consistent-prefix"`
 *
 * ## `"eventual"`
 */
export type ConsistencyLevel = 'strong' | 'bounded-staleness' | 'session' | 'consistent-prefix' | 'eventual';
export interface ProjectionSink {
  type: string,
  paradigm: SinkParadigm,
  reactive: boolean,
}
export interface ProjectionSpec {
  name: string,
  readModel: string,
  readSet: Array<string>,
  fold: string,
  reactivity: ReactivityClass,
  consistency: ConsistencyLevel,
  sink: ProjectionSink,
}
export interface ProjectionQuery {
  projection: string,
  predicate?: string,
  limit?: number,
}
export interface RawDriverCall {
  projection: string,
  driver: string,
  call: string,
}
export interface ProjectionReadResult {
  projection: string,
  seq: bigint,
  encodedJson: string,
}
export interface ProjectionDeclared {
  name: string,
  readModel: string,
  readSet: Array<string>,
  reactivity: ReactivityClass,
  consistency: ConsistencyLevel,
  sink: ProjectionSink,
}
export interface ProjectionLagged {
  name: string,
  observedLagMs: bigint,
  boundMs: bigint,
  policyInput: boolean,
}
export interface ProjectionSinkRebound {
  name: string,
  matchDecisionId: string,
  from: ProjectionSink,
  to: ProjectionSink,
}
