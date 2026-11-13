// A device that refreshes every second against a deployment while a key
// rotates (O19): it follows the trust record with `acceptTrust` from its pin,
// verifies a fresh session ticket and the previous one, a fresh token and the
// previous one, and has the NATS double accept a credential signed with the
// active signing key. Every refusal is counted.
import { createPublicKey, createVerify, verify } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	SESSION_TICKET_CONTEXT,
	SessionTicketSchema,
	type SignedEnvelope,
	type TrustRecord,
	TrustRecordSchema,
} from "@hobo/fleet";
import { acceptTrust, signEnvelope } from "@hobo/fleet/keys";
import { loadSecretStoreKms, type SecretsPort } from "@hobo/identity";
import { checkIncarnation } from "../../src/ops/incarnation.js";
import type { RotatableKey } from "../../src/ops/index.js";
import { decodeNkeySeed, signWithSeed, unbase32 } from "../../src/ops/nkeys.js";
import {
	activeRingKid,
	type NatsKey,
	type NatsSigningKeys,
} from "../../src/ops/rotation.js";
import {
	activeKey,
	readSecret,
	readSlot,
	slotName,
} from "../../src/ops/slots.js";
import type { Deployment } from "./harness.js";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const NATS_KEYS: readonly NatsKey[] = [
	"operator-signing",
	"account-signing",
	"scoped-observer",
	"scoped-executor",
	"scoped-dispatcher",
];

/** The NATS server's view of each signing-key set: what the operator and account JWTs list. */
export async function natsDouble(secrets: SecretsPort, prefix: string) {
	const published = new Map<NatsKey, readonly string[]>();
	for (const which of NATS_KEYS) {
		const slot = await readSlot(secrets, prefix, which);
		if (slot.ok && slot.value !== undefined)
			published.set(
				which,
				slot.value.keys.map((key) => key.publicKey),
			);
	}
	let down = false;
	const port: NatsSigningKeys = {
		async publish(which, publicKeys) {
			if (down)
				return {
					ok: false,
					error: { code: "unavailable", message: "NATS is down" },
				};
			published.set(which, [...publicKeys]);
			return { ok: true, value: undefined };
		},
	};
	return {
		published,
		port,
		setDown(value: boolean) {
			down = value;
		},
		/** True when the server accepts `signature` over `bytes` by `publicKey` for `which`. */
		accepts(
			which: NatsKey,
			publicKey: string,
			bytes: Uint8Array,
			signature: Uint8Array,
		): boolean {
			if (!(published.get(which) ?? []).includes(publicKey)) return false;
			const raw = unbase32(publicKey)?.subarray(1, 33);
			if (raw === undefined) return false;
			return verify(
				null,
				bytes,
				createPublicKey({
					key: Buffer.concat([SPKI_ED25519, raw]),
					format: "der",
					type: "spki",
				}),
				signature,
			);
		},
	};
}

export type Nats = Awaited<ReturnType<typeof natsDouble>>;

async function ringKid(
	secrets: SecretsPort,
	prefix: string,
): Promise<string | undefined> {
	const text = await readSecret(secrets, slotName(prefix, "token-signing"));
	if (!text.ok || text.value === undefined) return undefined;
	const ring = JSON.parse(text.value);
	return activeRingKid(ring.keys);
}

export function device(
	dep: Deployment,
	secrets: SecretsPort,
	prefix: string,
	nats: Nats,
	now: () => number,
) {
	let pinned: TrustRecord = dep.bus.registry.trust();
	let lastTicket: SignedEnvelope | undefined;
	let lastToken:
		| Readonly<{ kid: string; input: string; signature: Buffer }>
		| undefined;
	const refusals: string[] = [];
	let refreshes = 0;

	const followTrust = () => {
		const envelope = dep.bus.registry.trustEnvelope();
		const payload = envelope?.authority?.payload;
		if (envelope === undefined || payload === undefined) return;
		if (fromBinary(TrustRecordSchema, payload).sequence <= pinned.sequence)
			return;
		const accepted = acceptTrust(pinned, envelope);
		if (accepted.ok) pinned = accepted.value;
		else refusals.push(`trust: ${accepted.error.message}`);
	};

	const ticket = async () => {
		await dep.record.refresh();
		const issued = await signEnvelope(
			dep.record.signer,
			SESSION_TICKET_CONTEXT,
			toBinary(
				SessionTicketSchema,
				create(SessionTicketSchema, {
					ticketId: `t-${refreshes}`,
					memberId: "m-device",
					tenant: dep.tenant,
					issuedAt: new Date(now()).toISOString(),
					expiresAt: new Date(now() + 15 * 60_000).toISOString(),
					authorityIncarnation: pinned.authorityIncarnation,
				}),
			),
		);
		for (const candidate of [lastTicket, issued]) {
			if (candidate === undefined) continue;
			const checked = checkIncarnation(candidate, pinned);
			if (!checked.ok) refusals.push(`ticket: ${checked.error.message}`);
		}
		lastTicket = issued;
	};

	const token = async () => {
		const kid = await ringKid(secrets, prefix);
		if (kid === undefined) {
			refusals.push("token: no signing key");
			return;
		}
		// The authority reloads its ring and signs; a verifier fetches the JWKS (reloads too).
		const signerRing = await loadSecretStoreKms(secrets, {
			prefix: slotName(prefix, "token-signing"),
		});
		const input = `header.${refreshes}`;
		const signature = signerRing.sign(kid, input);
		const jwks = await loadSecretStoreKms(secrets, {
			prefix: slotName(prefix, "token-signing"),
		});
		for (const candidate of [lastToken, { kid, input, signature }]) {
			if (candidate === undefined) continue;
			if (!jwks.hasKey(candidate.kid)) {
				refusals.push(`token: ${candidate.kid} is not in the JWKS`);
				continue;
			}
			const key = createPublicKey({
				key: { ...jwks.publicJwk(candidate.kid) },
				format: "jwk",
			});
			const ok = createVerify("RSA-SHA256")
				.update(candidate.input)
				.end()
				.verify(key, candidate.signature);
			if (!ok) refusals.push(`token: ${candidate.kid} signature`);
		}
		lastToken = { kid, input, signature };
	};

	const natsCredential = async (which: NatsKey) => {
		const slot = await readSlot(secrets, prefix, which);
		if (!slot.ok || slot.value === undefined) {
			refusals.push(`${which}: no slot`);
			return;
		}
		const key = activeKey(slot.value);
		const seed = decodeNkeySeed(key.seed)?.seed;
		if (seed === undefined) {
			refusals.push(`${which}: bad seed`);
			return;
		}
		const bytes = new TextEncoder().encode(`credential-${refreshes}`);
		if (!nats.accepts(which, key.publicKey, bytes, signWithSeed(seed, bytes)))
			refusals.push(`${which}: the server refused ${key.kid}`);
	};

	return {
		refusals,
		pinned: () => pinned,
		refreshes: () => refreshes,
		/** One refresh, exercising the path of `which`. */
		async refresh(which: RotatableKey) {
			refreshes += 1;
			followTrust();
			if (which === "record-signing" || which === "witness") await ticket();
			else if (which === "token-signing") await token();
			else await natsCredential(which);
		},
	};
}
