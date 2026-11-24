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
	operatorName: string;
	now: Clock;
	log: FleetLog;
}>;

export type CeremonyResult = Readonly<{
	operatorPublicKey: string;
	shares: readonly [string, string];
}>;

export function operatorJwtName(prefix: string): string {
	return `${prefix}/operator-jwt`;
}

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
