/**
 * Provisioning the `requirepass` credential.
 *
 * Custody mints the material and this module receives only a locator, so the pack
 * process never holds the password: there is no variable to leak and no error
 * message to redact it out of.
 */
import type { ParsedSecretRef } from "@hobo/bindings";
import {
	generateSecret,
	type PackSecretCustodyPort,
	type PackSecretPolicy,
} from "@hobo/pack-framework";

import { VALKEY_PACK_ID } from "./manifest.js";

/**
 * 32 characters of base64url is ~190 bits.
 *
 * Sized for the specific threat: Valkey answers commands as fast as the network
 * allows, with no login delay and no lockout, so a weak `requirepass` is a
 * credential an attacker can attempt millions of times a minute.
 */
export const VALKEY_PASSWORD_POLICY: PackSecretPolicy = {
	minimumLength: 32,
	alphabet: "base64url",
	rotationIntervalMs: 90 * 24 * 60 * 60 * 1000,
};

export async function provisionValkeyAuthCredential(
	custody: PackSecretCustodyPort,
	resourceRef: string,
): Promise<ParsedSecretRef> {
	return generateSecret(
		custody,
		{
			packId: VALKEY_PACK_ID,
			resourceRef,
			purpose: "cache-auth-password",
			labels: { engine: "valkey" },
		},
		VALKEY_PASSWORD_POLICY,
	);
}
