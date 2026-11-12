/**
 * Keys the relay derives instead of storing (ADR-0179 amendment "Secretless
 * first"). Three symmetric keys used to be separate secrets in the config
 * service: the session key that seals onboarding cookies, the Sandbox proxy
 * token key, and `CRON_SECRET`, which authenticates the queue handoff from an
 * older deployment to the production relay (`/internal/queue-wakeup`). Each
 * is now HKDF-SHA256 of the GitHub App private key the store already holds
 * (its PKCS#8 DER as input keying material, a fixed salt, the setting's name
 * as info), so no person and no process ever creates, enters or rotates them
 * separately.
 *
 * Rotation: rotating the App private key rotates all three at once. Sealed
 * onboarding sessions then fail to open (the owner signs in again), Sandbox
 * proxy tokens of running leases stop verifying (they are per lease and
 * short-lived), and a handoff from a deployment still on the old key is
 * refused and redelivered by the queue until both read the same store copy
 * (the loader re-reads at most once a minute). A value stored explicitly
 * under the setting's name still wins, so an existing deployment keeps its
 * sessions until its operator deletes the entry.
 */

import { createPrivateKey, hkdfSync } from "node:crypto";

// public-contract: the HKDF salt of every relay-derived key; changing it rotates them all.
export const RELAY_DERIVED_KEY_SALT = "hobo-ci/relay-root/v1";

// public-contract: the settings the relay derives when the store does not hold them.
export const RELAY_DERIVED_KEYS = Object.freeze([
	"HOBO_CI_SESSION_KEY",
	"HOBO_CI_SANDBOX_PROXY_TOKEN_KEY",
	"CRON_SECRET",
] as const);

export type RelayDerivedKey = (typeof RELAY_DERIVED_KEYS)[number];

/** 32 bytes for `name`, base64url (43 characters, the canonical key form). */
export function deriveRelayKey(
	privateKeyPem: string,
	name: RelayDerivedKey,
): string {
	const der = createPrivateKey(privateKeyPem).export({
		type: "pkcs8",
		format: "der",
	});
	try {
		return Buffer.from(
			hkdfSync(
				"sha256",
				der,
				Buffer.from(RELAY_DERIVED_KEY_SALT, "utf8"),
				Buffer.from(name, "utf8"),
				32,
			),
		).toString("base64url");
	} finally {
		der.fill(0);
	}
}

/**
 * The entries with every derived key the store does not hold filled in from
 * `HOBO_CI_GITHUB_APP_PRIVATE_KEY`. Without a private key nothing is derived
 * (the schema then reports the missing keys by name).
 */
export function withDerivedRelayKeys(
	entries: Readonly<Record<string, string>>,
) {
	const pem = entries.HOBO_CI_GITHUB_APP_PRIVATE_KEY;
	if (pem === undefined || pem === "") return entries;
	const out = { ...entries };
	for (const name of RELAY_DERIVED_KEYS) {
		if (out[name] !== undefined && out[name] !== "") continue;
		try {
			out[name] = deriveRelayKey(pem, name);
		} catch {
			// Not a key: the schema refuses HOBO_CI_GITHUB_APP_PRIVATE_KEY by name.
			return entries;
		}
	}
	return out;
}
