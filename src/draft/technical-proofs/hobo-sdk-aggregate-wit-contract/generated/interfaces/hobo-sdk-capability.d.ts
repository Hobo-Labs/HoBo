/** @module Interface hobo:sdk/capability@0.1.0 **/
export function require(target: ResourceRef, verbs: Array<string>): CapabilityGrant;
export function allow(grant: CapabilityGrant): void;
export type CapabilityGrant = import('./hobo-sdk-types.js').CapabilityGrant;
export type ResourceRef = import('./hobo-sdk-types.js').ResourceRef;
export type SdkError = import('./hobo-sdk-types.js').SdkError;
