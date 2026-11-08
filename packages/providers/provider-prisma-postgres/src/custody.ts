/**
 * Secret custody boundary.
 *
 * `create-db` prints a connection string to stdout. That string is deposited
 * before anything else is done with it, and the driver carries only the
 * locator afterwards.
 */
import {
	type ParsedSecretRef,
	parseSecretRef,
	type SecretRef,
	type SecretValue,
} from "@hobo/bindings";

import { PrismaProviderError } from "./errors.js";

export type SecretPurpose =
	| "connection-string"
	| "rotation-evidence"
	| "claim-url"
	| "capability-binding"
	| "native-resource-id";

export type SecretCustodyScope = {
	readonly providerId: string;
	readonly resourceRef: string;
	readonly purpose: SecretPurpose;
	readonly labels?: Readonly<Record<string, string>>;
};

export interface SecretCustodyPort {
	deposit(value: string, scope: SecretCustodyScope): Promise<string>;
}

export interface SecretResolverPort {
	resolve(ref: SecretRef): Promise<SecretValue>;
}

/**
 * Deposit and parse in one step: a custody implementation that echoes the
 * plaintext back instead of a locator fails here, not three layers later.
 */
export async function depositSecret(
	custody: SecretCustodyPort,
	value: string,
	scope: SecretCustodyScope,
): Promise<ParsedSecretRef> {
	let raw: string;
	try {
		raw = await custody.deposit(value, scope);
	} catch (cause) {
		throw new PrismaProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			`secret custody refused a ${scope.purpose} deposit for ${scope.resourceRef}`,
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				detail: { purpose: scope.purpose, resourceRef: scope.resourceRef },
			},
		);
	}
	try {
		return parseSecretRef(raw);
	} catch (cause) {
		throw new PrismaProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			`secret custody returned something that is not a secret locator for ${scope.resourceRef}`,
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				detail: { purpose: scope.purpose, resourceRef: scope.resourceRef },
			},
		);
	}
}

export async function resolveSecret(
	resolver: SecretResolverPort,
	ref: SecretRef,
): Promise<SecretValue> {
	try {
		return await resolver.resolve(ref);
	} catch (cause) {
		throw new PrismaProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"secret custody could not resolve a deposited credential",
			{ cause: cause instanceof Error ? cause : new Error(String(cause)) },
		);
	}
}
