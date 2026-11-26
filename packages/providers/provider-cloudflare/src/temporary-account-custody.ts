/**
 * Server-side custody for the two bearer values a temporary account produces.
 *
 * Cloudflare's own guidance is unambiguous: `account.apiToken` must never reach
 * a browser response, and `claim.url` is to be treated like a bearer credential
 * because anyone holding it can claim ownership of the account. Both therefore
 * leave this module only as references — a {@link SecretRef} for the token and a
 * {@link SensitiveActionRef} for the one-time human claim action.
 */

import { randomUUID } from "node:crypto";
import { parseSecretRef, type SecretRef } from "@hobo/bindings";

import { TemporaryAccountError } from "./temporary-account-errors.js";

export type SecretDeposit = {
	/** Stable slug used to build the locator path. Not secret. */
	readonly name: string;
	readonly value: string;
	readonly expiresAtMs?: number;
};

export type SecretCustodyPort = {
	deposit(input: SecretDeposit): Promise<SecretRef>;
	/** Irreversibly destroy the stored material. Idempotent. */
	destroy(ref: SecretRef): Promise<void>;
	has(ref: SecretRef): Promise<boolean>;
};

const CUSTODY_AUTHORITY = "cloudflare-temporary";
const SLUG = /^[A-Za-z0-9._~-]{1,64}$/u;

/**
 * Reference custody implementation.
 *
 * The stored value lives in a closure-scoped map, so a caller that holds only
 * the returned {@link SecretRef} cannot reach the material by walking the
 * object graph or serializing the port.
 */
export function createInMemorySecretCustody(options?: {
	readonly nextId?: () => string;
}): SecretCustodyPort & { readonly size: number } {
	const values = new Map<string, string>();
	const nextId = options?.nextId ?? (() => randomUUID());

	const port: SecretCustodyPort & { readonly size: number } = {
		async deposit(input) {
			if (!SLUG.test(input.name)) {
				throw new TemporaryAccountError(
					"SECRET_CUSTODY_UNAVAILABLE",
					"custody deposit name must be a short unreserved-character slug",
					{ reason: "INVALID_NAME" },
				);
			}
			if (input.value.length === 0) {
				throw new TemporaryAccountError(
					"SECRET_CUSTODY_UNAVAILABLE",
					"custody deposit requires a non-empty value",
					{ reason: "EMPTY_VALUE" },
				);
			}
			const ref = parseSecretRef(
				`hobo-token://${CUSTODY_AUTHORITY}/${input.name}/${nextId()}`,
			).ref;
			values.set(ref, input.value);
			return ref;
		},
		async destroy(ref) {
			values.delete(ref);
		},
		async has(ref) {
			return values.has(ref);
		},
		get size() {
			return values.size;
		},
	};
	return port;
}

/** Deposit that turns any custody failure into `SECRET_CUSTODY_UNAVAILABLE`. */
export async function depositOrFailClosed(
	custody: SecretCustodyPort | undefined,
	deposit: SecretDeposit,
): Promise<SecretRef> {
	if (custody === undefined) {
		throw new TemporaryAccountError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"a SecretCustodyPort is required: the temporary API token may not be returned to the caller",
			{ reason: "PORT_MISSING" },
		);
	}
	try {
		return await custody.deposit(deposit);
	} catch (cause) {
		if (
			cause instanceof TemporaryAccountError &&
			cause.code === "SECRET_CUSTODY_UNAVAILABLE"
		) {
			throw cause;
		}
		throw new TemporaryAccountError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"secret custody rejected the temporary credential deposit",
			{
				reason: "DEPOSIT_FAILED",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}
}

declare const sensitiveActionRefBrand: unique symbol;

/**
 * An opaque handle to a one-time sensitive human action.
 *
 * This is deliberately not the URL. It is safe to place in an event, a receipt,
 * or a log line; redeeming it requires the vault plus the audience it was
 * minted for, and it redeems exactly once.
 */
export type SensitiveActionRef = string & {
	readonly [sensitiveActionRefBrand]: "SensitiveActionRef";
};

export const SENSITIVE_ACTION_KINDS = ["cloudflare.claim-deployment"] as const;

export type SensitiveActionKind = (typeof SENSITIVE_ACTION_KINDS)[number];

export type SensitiveActionDescriptor = {
	readonly ref: SensitiveActionRef;
	readonly kind: SensitiveActionKind;
	readonly audienceRef: string;
	readonly expiresAtMs: number;
	readonly redeemed: boolean;
	readonly revoked: boolean;
};

export type OneTimeActionVaultPort = {
	store(input: {
		readonly kind: SensitiveActionKind;
		readonly url: string;
		readonly audienceRef: string;
		readonly expiresAtMs: number;
	}): Promise<SensitiveActionRef>;
	/** Single-use disclosure to the intended audience. */
	redeem(input: {
		readonly ref: SensitiveActionRef;
		readonly audienceRef: string;
		readonly nowMs: number;
	}): Promise<string>;
	/** Metadata only — never the URL. */
	describe(
		ref: SensitiveActionRef,
	): Promise<SensitiveActionDescriptor | undefined>;
	revoke(ref: SensitiveActionRef): Promise<void>;
};

const ACTION_URL_ALLOWED_HOSTS: readonly string[] = ["dash.cloudflare.com"];

export function createInMemoryOneTimeActionVault(options?: {
	readonly nextId?: () => string;
}): OneTimeActionVaultPort {
	type Entry = {
		url: string;
		kind: SensitiveActionKind;
		audienceRef: string;
		expiresAtMs: number;
		redeemed: boolean;
		revoked: boolean;
	};
	const entries = new Map<string, Entry>();
	const nextId = options?.nextId ?? (() => randomUUID());

	return {
		async store(input) {
			let parsed: URL;
			try {
				parsed = new URL(input.url);
			} catch (cause) {
				throw new TemporaryAccountError(
					"PROVIDER_CONTRACT_CHANGED",
					"claim action target is not a URL",
					{
						reason: "CLAIM_URL_MALFORMED",
						cause: cause instanceof Error ? cause : new Error(String(cause)),
					},
				);
			}
			if (parsed.protocol !== "https:") {
				throw new TemporaryAccountError(
					"PROVIDER_CONTRACT_CHANGED",
					"claim action target must be https",
					{ reason: "CLAIM_URL_NOT_HTTPS" },
				);
			}
			if (!ACTION_URL_ALLOWED_HOSTS.includes(parsed.hostname)) {
				throw new TemporaryAccountError(
					"PROVIDER_CONTRACT_CHANGED",
					`claim action host must be one of ${ACTION_URL_ALLOWED_HOSTS.join(", ")}`,
					{ reason: "CLAIM_URL_HOST_NOT_ALLOWED" },
				);
			}
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			const ref = `hobo-action:${input.kind}:${nextId()}` as SensitiveActionRef;
			entries.set(ref, {
				url: input.url,
				kind: input.kind,
				audienceRef: input.audienceRef,
				expiresAtMs: input.expiresAtMs,
				redeemed: false,
				revoked: false,
			});
			return ref;
		},
		async redeem({ ref, audienceRef, nowMs }) {
			const entry = entries.get(ref);
			if (entry === undefined || entry.revoked) {
				throw new TemporaryAccountError(
					"CLAIM_ACTION_CONSUMED",
					"claim action reference is not redeemable",
					{ reason: "UNKNOWN_OR_REVOKED" },
				);
			}
			if (entry.redeemed) {
				throw new TemporaryAccountError(
					"CLAIM_ACTION_CONSUMED",
					"claim action reference has already been redeemed once",
					{ reason: "ALREADY_REDEEMED" },
				);
			}
			if (entry.audienceRef !== audienceRef) {
				throw new TemporaryAccountError(
					"CLAIM_NOT_VERIFIED",
					"claim action may only be redeemed by the audience it was minted for",
					{ reason: "AUDIENCE_MISMATCH" },
				);
			}
			if (nowMs >= entry.expiresAtMs) {
				throw new TemporaryAccountError(
					"CLAIM_EXPIRED",
					"the provider-stated claim deadline has passed",
					{ reason: "CLAIM_WINDOW_CLOSED" },
				);
			}
			entry.redeemed = true;
			return entry.url;
		},
		async describe(ref) {
			const entry = entries.get(ref);
			if (entry === undefined) return undefined;
			return {
				ref,
				kind: entry.kind,
				audienceRef: entry.audienceRef,
				expiresAtMs: entry.expiresAtMs,
				redeemed: entry.redeemed,
				revoked: entry.revoked,
			};
		},
		async revoke(ref) {
			const entry = entries.get(ref);
			if (entry === undefined) return;
			entry.revoked = true;
			entry.url = "";
			entries.set(ref, entry);
		},
	};
}
