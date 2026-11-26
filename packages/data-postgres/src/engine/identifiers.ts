import { sha256Hex } from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

export const TENANT_COLUMN = "tenant_id";
export const OPEN_FIELDS_COLUMN = "hobo_extra";

export const METADATA_TABLES = Object.freeze({
	datasets: "hobo_data_datasets",
	fences: "hobo_data_fences",
	fenceOperations: "hobo_data_fence_operations",
	fencePolicy: "hobo_data_fence_policy",
	fenceReceivers: "hobo_data_fence_receivers",
	watermarks: "hobo_data_watermarks",
	subscriptions: "hobo_data_subscriptions",
	schemaSnapshots: "hobo_data_schema_snapshots",
} as const);

export const RESERVED_TABLE_NAMES: readonly string[] = Object.freeze(
	Object.values(METADATA_TABLES),
);

export function parseNamespace(value: string): string {
	if (!NAMESPACE_PATTERN.test(value) || value.startsWith("pg_")) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"namespace must be a lowercase snake_case identifier of at most 63 bytes that does not start with pg_",
			{ detail: { field: "namespace" } },
		);
	}
	return value;
}

export function parseTableName(value: string): string {
	if (!NAMESPACE_PATTERN.test(value) || RESERVED_TABLE_NAMES.includes(value)) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"a schema-port table must be a lowercase snake_case identifier that is not one of the binding's own tables",
			{ detail: { field: "schemaTables" } },
		);
	}
	return value;
}

export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(namespace: string, name: string): string {
	return `${quoteIdentifier(namespace)}.${quoteIdentifier(name)}`;
}

// domain-view:
export interface PostgresCaptureObjects {
	readonly slot: string;
	readonly publication: string;
}

export function captureObjectNames(
	database: string,
	namespace: string,
	subscription: string,
): PostgresCaptureObjects {
	const owner = sha256Hex(`${database}\u0000${namespace}`).slice(0, 12);
	const reader = sha256Hex(subscription).slice(0, 24);
	return Object.freeze({
		slot: `hobo_s_${owner}_${reader}`,
		publication: `hobo_p_${owner}_${reader}`,
	});
}

export function snapshotNamespace(namespace: string, nonce: string): string {
	return `hobo_snap_${sha256Hex(namespace).slice(0, 12)}_${nonce}`;
}

export function captureObjectPrefixes(
	database: string,
	namespace: string,
): PostgresCaptureObjects {
	const owner = sha256Hex(`${database}\u0000${namespace}`).slice(0, 12);
	return Object.freeze({
		slot: `hobo_s_${owner}_`,
		publication: `hobo_p_${owner}_`,
	});
}

export function nativeSubscriptionPrefix(namespace: string): string {
	return `hobo_n_${sha256Hex(namespace).slice(0, 12)}_`;
}

export function nativeSubscriptionName(
	namespace: string,
	transfer: string,
): string {
	return `${nativeSubscriptionPrefix(namespace)}${sha256Hex(transfer).slice(0, 24)}`;
}

export const NATIVE_TRANSFER_KEY_PREFIX = "native:";

export function nativeTransferKey(transfer: string): string {
	return `${NATIVE_TRANSFER_KEY_PREFIX}${transfer}`;
}
