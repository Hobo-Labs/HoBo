/** @module Interface hobo:runtime/subscribe@0.1.0 **/
export function subscribe(filter: SubscriptionFilter): Subscription;
export function snapshot(materialization: string, atSeq: bigint | undefined): Bytes;
export type Bytes = import('./hobo-runtime-types.js').Bytes;
export type RuntimeError = import('./hobo-runtime-types.js').RuntimeError;
export type Subscription = import('./hobo-runtime-types.js').Subscription;
export type SubscriptionFilter = import('./hobo-runtime-types.js').SubscriptionFilter;
