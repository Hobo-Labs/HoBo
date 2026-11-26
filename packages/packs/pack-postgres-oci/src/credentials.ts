/**
 * Provisioning the superuser credential.
 *
 * The password is created *inside* secret custody and this module receives only a
 * locator. That is the difference between a pack and a managed-provider driver: a
 * provider hands back a connection string that has to be captured and deposited
 * quickly, while a pack never has to hold the material at all.
 *
 * The policy below is a floor, not a generator. Custody owns the entropy source,
 * because entropy belongs next to the key material rather than in application
 * code.
 */
import type { ParsedSecretRef } from "@hobo/bindings";
import {
	generateSecret,
	type PackSecretCustodyPort,
	type PackSecretPolicy,
} from "@hobo/pack-framework";

import { POSTGRES_PACK_ID } from "./manifest.js";

/**
 * 32 characters from base64url is ~190 bits. A PostgreSQL password is a
 * long-lived credential on a port that may be reachable across a Camp, so the
 * floor is set well above the 16-character framework minimum.
 */
export const POSTGRES_PASSWORD_POLICY: PackSecretPolicy = {
	minimumLength: 32,
	alphabet: "base64url",
	rotationIntervalMs: 90 * 24 * 60 * 60 * 1000,
};

export async function provisionPostgresSuperuserCredential(
	custody: PackSecretCustodyPort,
	resourceRef: string,
): Promise<ParsedSecretRef> {
	return generateSecret(
		custody,
		{
			packId: POSTGRES_PACK_ID,
			resourceRef,
			purpose: "database-owner-password",
			labels: { engine: "postgresql" },
		},
		POSTGRES_PASSWORD_POLICY,
	);
}

export async function provisionPostgresApplicationCredential(
	custody: PackSecretCustodyPort,
	resourceRef: string,
): Promise<ParsedSecretRef> {
	return generateSecret(
		custody,
		{
			packId: POSTGRES_PACK_ID,
			resourceRef,
			purpose: "database-app-password",
			labels: { engine: "postgresql" },
		},
		POSTGRES_PASSWORD_POLICY,
	);
}
