// The key ceremony (design §6.16): generates the NATS operator identity key
// offline, uses it once to sign the operator JWT naming the operator signing
// key, and hands it back only as two shares. The keys the deployment runs on
// are stored, one secret per key, behind `SecretsPort`. Private to L27.
import type { Clock, FleetLog, Outcome } from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";
import { loadSecretStoreKms } from "@hobo/identity";
import type { RotatableKey } from "./index.js";
import { freshSeed, operatorJwt } from "./nkeys.js";
import { splitOperatorSeed } from "./shares.js";
import { freshKey, readSlot, slotName, writeSlot } from "./slots.js";

export type CeremonyDeps = Readonly<{
	secrets: SecretsPort;
	prefix: string;
	/** The operator's name in its JWT. */
	operatorName: string;
	now: Clock;
	log: FleetLog;
}>;

export type CeremonyResult = Readonly<{
	operatorPublicKey: string;
	shares: readonly [string, string];
}>;

/** The secret holding the operator JWT the ceremony signed (public; the NATS server configuration reads it). */
export function operatorJwtName(prefix: string): string {
	return `${prefix}/operator-jwt`;
}

/** Ed25519 keys the ceremony creates when absent, besides the operator signing key. */
const AUTHORITY_KEYS: readonly RotatableKey[] = ["record-signing", "witness"];

export async function ceremony(
	deps: CeremonyDeps,
): Promise<Outcome<CeremonyResult>> {
	const existing = await readSlot(
		deps.secrets,
		deps.prefix,
		"operator-signing",
	);
	if (!existing.ok) return existing;
	if (existing.value !== undefined)
		return {
			ok: false,
			error: {
				code: "conflict",
				message:
					"the ceremony has already run for this deployment; rotate the operator signing key instead",
				detail: { secret: slotName(deps.prefix, "operator-signing") },
			},
		};

	const operatorSeed = freshSeed();
	try {
		const signing = freshKey("operator-signing", "operator-signing#1");
		const jwt = operatorJwt(
			operatorSeed,
			deps.operatorName,
			[signing.publicKey],
			deps.now(),
		);
		const shares = splitOperatorSeed(operatorSeed);
		const operatorPublicKey = shares[0].split(":")[2] ?? "";

		for (const which of AUTHORITY_KEYS) {
			const slot = await readSlot(deps.secrets, deps.prefix, which);
			if (!slot.ok) return slot;
			if (slot.value === undefined) {
				const key = freshKey(
					which,
					which === "witness" ? "witness#1" : "authority#1",
				);
				await writeSlot(deps.secrets, deps.prefix, which, {
					active: key.kid,
					keys: [key],
				});
			}
		}
		// The token-signing ring is @hobo/identity's; loading it creates it once.
		await loadSecretStoreKms(deps.secrets, {
			prefix: slotName(deps.prefix, "token-signing"),
		});
		await deps.secrets.put(operatorJwtName(deps.prefix), jwt);
		await writeSlot(deps.secrets, deps.prefix, "operator-signing", {
			active: signing.kid,
			keys: [signing],
		});
		return { ok: true, value: { operatorPublicKey, shares } };
	} finally {
		operatorSeed.fill(0);
	}
}
