/**
 * `AccountCredentialVerifier` (§6.15): the CI relay's account credential, a
 * bearer secret held in the secret store. Only SHA-256 digests are kept in
 * memory; a presented credential is hashed and compared in constant time.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrincipalRef, TenantId } from "@hobo/core";
import type { AccountCredentialVerifier } from "@hobo/fleet";

// domain-view: one configured account with its credential already read from the secret store.
export type Account = Readonly<{
	principal: PrincipalRef;
	scopes: readonly string[];
	credential: string;
}>;

function digest(text: string): Buffer {
	return createHash("sha256").update(text, "utf8").digest();
}

export function createAccountVerifier(
	tenant: TenantId,
	accounts: readonly Account[],
): AccountCredentialVerifier {
	const held = accounts
		.filter((account) => account.credential.length >= 32)
		.map((account) => ({ ...account, digest: digest(account.credential) }));
	return {
		async verify(bearer) {
			const presented = digest(bearer);
			const match = held.find((account) =>
				timingSafeEqual(account.digest, presented),
			);
			return match === undefined
				? {
						ok: false,
						error: {
							code: "unauthenticated",
							message: "not an account credential",
						},
					}
				: {
						ok: true,
						value: { principal: match.principal, tenant, scopes: match.scopes },
					};
		},
	};
}

/** `<kind>:<id>` into a principal; undefined for another kind. */
export function parsePrincipal(text: string): PrincipalRef | undefined {
	const colon = text.indexOf(":");
	const kind = text.slice(0, colon);
	const id = text.slice(colon + 1);
	if (colon <= 0 || id.length === 0) return undefined;
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}
