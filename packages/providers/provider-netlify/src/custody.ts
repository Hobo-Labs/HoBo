/**
 * Secret custody boundary for the anonymous-site path.
 *
 * Exactly one thing here is bearer authority, and it is easy to miss because it
 * looks like a link: the claim URL. Anyone who opens it becomes the owner of the
 * site. It is deposited the moment it is parsed out of CLI output, and from then
 * on this package carries a {@link SecretRef} — no record, receipt, fact, event,
 * or error is ever offered the URL itself.
 */
import {
	type ParsedSecretRef,
	parseSecretRef,
	type SecretRef,
	type SecretValue,
} from "@hobo/bindings";

import { NetlifyProviderError } from "./provider-errors.js";

export type SecretPurpose =
	| "anonymous-claim-url"
	| "anonymous-session"
	| "authenticated-api-token";

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

/** The read side. Used only where the material must actually be presented. */
export interface SecretResolverPort {
	resolve(ref: SecretRef): Promise<SecretValue>;
}

/**
 * Deposit and parse in one step, so a custody implementation that echoes the
 * plaintext back instead of a locator fails here rather than in a receipt.
 * `parseSecretRef` already rejects credential-shaped input.
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
		throw new NetlifyProviderError(
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
		throw new NetlifyProviderError(
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
		throw new NetlifyProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"secret custody could not resolve a deposited credential",
			{ cause: cause instanceof Error ? cause : new Error(String(cause)) },
		);
	}
}
