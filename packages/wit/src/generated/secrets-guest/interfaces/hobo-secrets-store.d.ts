/** @module Interface hobo:secrets/store@0.1.0 **/
/**
 * Write a new secret version; returns the provider-assigned version id.
 */
export function put(name: string, value: Uint8Array): VersionId;
/**
 * Read the latest version and its value.
 */
export function access(name: string): [VersionId, Uint8Array];
/**
 * Read a pinned version (`.allow(access)` + version argument at the SDK layer).
 */
export function accessVersion(name: string, version: VersionId): Uint8Array;
/**
 * Enumerate version ids (newest-first) for audit and rollback.
 */
export function listVersions(name: string): Array<VersionId>;
export type VersionId = string;
