/** @module Interface hobo:sdk/subscription@0.1.0 **/
export function subscribe(filter: SubscriptionFilter): string;
export function next(subscriptionId: string): DataChange | undefined;
export type DataChange = import('./hobo-sdk-types.js').DataChange;
export type SdkError = import('./hobo-sdk-types.js').SdkError;
export type SubscriptionFilter = import('./hobo-sdk-types.js').SubscriptionFilter;
