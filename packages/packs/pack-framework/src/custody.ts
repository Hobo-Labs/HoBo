/**
 * Secret custody for packs: material is *minted inside custody*, not handed to it.
 *
 * A managed provider returns a connection string and the driver's job is to
 * deposit it fast. A pack is different: the credential does not exist until
 * somebody creates it, so the honest design is for custody to generate it and
 * return only a locator. This process then never holds the password at all —
 * there is no variable to leak, no error message to redact it out of, and no
 * heap for a crash dump to catch it in.
 *
 * `deposit` exists for the residual case where an external system produced the
 * material first (an imported backup credential, for example).
 */
import {
	type ParsedSecretRef,
	parseSecretRef,
	type SecretRef,
	type SecretValue,
} from "@hobo/bindings";

import { PackError } from "./errors.js";

export type PackSecretPurpose =
	| "database-owner-password"
	| "database-app-password"
	| "cache-auth-password"
	| "replication-password"
	| "backup-credential";

export type PackSecretScope = {
	readonly packId: string;
	readonly resourceRef: string;
	readonly purpose: PackSecretPurpose;
	readonly labels?: Readonly<Record<string, string>>;
};

/**
 * Generation policy. Deliberately a shape, not a generator: the pack states the
 * strength it needs and custody decides how to satisfy it, so the entropy source
 * lives with the key material rather than in application code.
 */
export type PackSecretPolicy = {
	readonly minimumLength: number;
	readonly alphabet:
		| "base58"
		| "base64url"
		| "hex"
		| "printable-ascii-no-space";
	/** Rotation interval the operator should honour, in ms. Advisory metadata. */
	readonly rotationIntervalMs?: number;
};

export interface PackSecretCustodyPort {
	/** Mint new material inside custody and return only its locator. */
	generate(scope: PackSecretScope, policy: PackSecretPolicy): Promise<string>;
	/** Store externally produced material and return only its locator. */
	deposit(value: string, scope: PackSecretScope): Promise<string>;
}

/** The read side. Used only by operation drivers, inside one function scope. */
export interface PackSecretResolverPort {
	resolve(ref: SecretRef): Promise<SecretValue>;
}

async function toParsedRef(
	raw: string,
	scope: PackSecretScope,
	operation: string,
): Promise<ParsedSecretRef> {
	try {
		return parseSecretRef(raw);
	} catch (cause) {
		// `parseSecretRef` rejects credential-shaped input, so this is also the
		// check that catches a custody implementation returning the value itself.
		throw new PackError(
			"SECRET_CUSTODY_UNAVAILABLE",
			`secret custody returned something that is not a locator from ${operation} for ${scope.resourceRef}`,
			{
				cause,
				detail: { purpose: scope.purpose, resourceRef: scope.resourceRef },
			},
		);
	}
}

export async function generateSecret(
	custody: PackSecretCustodyPort,
	scope: PackSecretScope,
	policy: PackSecretPolicy,
): Promise<ParsedSecretRef> {
	if (!Number.isInteger(policy.minimumLength) || policy.minimumLength < 16) {
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			"a generated pack credential must be at least 16 characters",
		);
	}
	let raw: string;
	try {
		raw = await custody.generate(scope, policy);
	} catch (cause) {
		throw new PackError(
			"SECRET_CUSTODY_UNAVAILABLE",
			`secret custody refused to mint a ${scope.purpose} for ${scope.resourceRef}`,
			{
				cause,
				detail: { purpose: scope.purpose, resourceRef: scope.resourceRef },
			},
		);
	}
	return toParsedRef(raw, scope, "generate");
}

export async function depositSecret(
	custody: PackSecretCustodyPort,
	value: string,
	scope: PackSecretScope,
): Promise<ParsedSecretRef> {
	let raw: string;
	try {
		raw = await custody.deposit(value, scope);
	} catch (cause) {
		throw new PackError(
			"SECRET_CUSTODY_UNAVAILABLE",
			`secret custody refused a ${scope.purpose} deposit for ${scope.resourceRef}`,
			{
				cause,
				detail: { purpose: scope.purpose, resourceRef: scope.resourceRef },
			},
		);
	}
	return toParsedRef(raw, scope, "deposit");
}

export async function resolveSecret(
	resolver: PackSecretResolverPort,
	ref: SecretRef,
): Promise<SecretValue> {
	try {
		return await resolver.resolve(ref);
	} catch (cause) {
		throw new PackError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"secret custody could not resolve a pack credential",
			{ cause },
		);
	}
}
