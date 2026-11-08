/**
 * Secret custody boundary.
 *
 * The REST token in a `start-redis` response is a bearer credential for a
 * database that anyone holding it can read and write. It is deposited the
 * instant it is parsed, and from that point the driver carries a SecretRef.
 * Nothing downstream — record, receipt, fact, binding, error — is given the
 * option of holding the material.
 */
import {
	type ParsedSecretRef,
	parseSecretRef,
	type SecretRef,
	type SecretValue,
} from "@hobo/bindings";

import { UpstashProviderError } from "./errors.js";

export type SecretPurpose =
	| "redis-rest-token"
	| "redis-rest-url"
	| "redis-protocol-url"
	| "claim-url"
	| "capability-binding"
	| "native-resource-id"
	| "rotation-evidence";

export type SecretCustodyScope = {
	readonly providerId: string;
	readonly resourceRef: string;
	readonly purpose: SecretPurpose;
	readonly labels?: Readonly<Record<string, string>>;
};

/** Deposits material and returns only the locator. */
export interface SecretCustodyPort {
	deposit(value: string, scope: SecretCustodyScope): Promise<string>;
}

/** The read side. Only a runtime projection path should ever hold this. */
export interface SecretResolverPort {
	resolve(ref: SecretRef): Promise<SecretValue>;
}

/**
 * Deposit and parse in one step, so a custody implementation that hands back
 * the plaintext it was given instead of a locator fails here rather than
 * leaking into a binding. `parseSecretRef` already rejects credential-shaped
 * input, which is what makes that check more than a formality.
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
		throw new UpstashProviderError(
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
		throw new UpstashProviderError(
			"SECRET_REFERENCE_INVALID",
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
		throw new UpstashProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"secret custody could not resolve a deposited credential",
			{ cause: cause instanceof Error ? cause : new Error(String(cause)) },
		);
	}
}
