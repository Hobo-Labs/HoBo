/**
 * Signed evidence for the behaviour suite: a dispatcher's offer and a
 * device's claim on it (design §6.9 steps 3 and 4), built with the device's
 * own SIGN key or, for a forgery, another key; key-bundle rotation; a copied
 * key store (F7); and an in-memory stream pair for a granted session.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type AgentState,
	CLAIM_CONTEXT,
	ClaimSchema,
	type DeviceKeys,
	type FleetStream,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	type KeyStore,
	OFFER_CONTEXT,
	PublicKeyRefSchema,
	SandboxTier,
	type SignedEnvelope,
	type Signer,
	TrustClass,
	type WorkOffer,
	WorkOfferSchema,
	WorkOrigin,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import { workDigest } from "@hobo/fleet/work";

const iso = (ms: number) => new Date(ms).toISOString();

/** An `oci-command` offer by `dispatcher` in `fleet`, authored by `author`. */
export function offerOf(
	dispatcher: DeviceKeys,
	fleet: string,
	nowMs: number,
	fields: Readonly<{ workKey?: string; author?: string; origin?: WorkOrigin; trustClass?: TrustClass }> = {},
): WorkOffer {
	const workKey = fields.workKey ?? "job-1";
	return create(WorkOfferSchema, {
		workKey,
		workDigest: workDigest("oci-command", workKey),
		kind: "oci-command",
		fleet,
		label: "",
		needs: { labels: [] },
		trustClass: fields.trustClass ?? TrustClass.ORG,
		author: fields.author ?? "user:dev",
		origin: fields.origin ?? WorkOrigin.INTERNAL,
		repository: "",
		ref: "",
		workflowDigest: "",
		queuedAt: iso(nowMs),
		expiresAt: iso(nowMs + 10 * 60_000),
		dispatcher: dispatcher.memberId,
	});
}

export function signOffer(dispatcher: DeviceKeys, offer: WorkOffer): Promise<SignedEnvelope> {
	return signEnvelope(dispatcher.sign, OFFER_CONTEXT, toBinary(WorkOfferSchema, offer));
}

/** A claim naming `claimant` on `offer`, signed by `signer` (the claimant's own SIGN key unless forged). */
export function claimOf(
	claimant: DeviceKeys,
	offer: WorkOffer,
	signer: Signer = claimant.sign,
	tier: SandboxTier = SandboxTier.S3_MICROVM,
): Promise<SignedEnvelope> {
	return signEnvelope(
		signer,
		CLAIM_CONTEXT,
		toBinary(
			ClaimSchema,
			create(ClaimSchema, {
				workDigest: offer.workDigest,
				fleet: offer.fleet,
				memberId: claimant.memberId,
				dispatcher: offer.dispatcher,
				offerExpiresAt: offer.expiresAt,
				rank: 0,
				sandboxTier: tier,
				claimedAt: offer.queuedAt,
			}),
		),
	);
}

/** Key bundle `sequence` for the device's current SIGN and SEAL keys, signed by its identity key. */
export function keyBundle(keys: DeviceKeys, sequence: number, nowMs: number): Promise<SignedEnvelope> {
	return signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(
			KeyBundleSchema,
			create(KeyBundleSchema, {
				memberId: keys.memberId,
				sequence,
				keys: [
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SIGN,
						keyId: keys.sign.keyId,
						algorithm: KeyAlgorithm.EDDSA,
						value: keys.signPublicKey,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${keys.memberId}#seal`,
						algorithm: KeyAlgorithm.UNSPECIFIED,
						value: keys.sealPublicKey,
					}),
				],
				issuedAt: iso(nowMs),
				notAfter: iso(nowMs + 24 * 3_600_000),
			}),
		),
	);
}

/** A second key store holding the same keys with its own copy of the state: a cloned device (F7). */
export function copiedKeyStore(original: KeyStore, state: AgentState): KeyStore {
	let held = state;
	return {
		open: () => original.open(),
		readState: async () => held,
		writeState: async (next) => {
			held = next;
		},
		rotateOperational: () => original.rotateOperational(),
		destroy: async () => {},
	};
}

/** Two ends of an in-memory byte stream, as a transport would hand them over; closing either end ends both. */
export function streamPair(initiator: string, acceptor: string): readonly [FleetStream, FleetStream] {
	const shared = { closed: false };
	const end = (peer: string, inbox: Uint8Array[], outbox: Uint8Array[], mine: (() => void)[], theirs: (() => void)[]) => {
		let sent = 0;
		let received = 0;
		const wake = (waiters: (() => void)[]) => {
			for (const resolve of waiters.splice(0)) resolve();
		};
		const stream: FleetStream = {
			peer,
			async *read() {
				while (true) {
					const next = inbox.shift();
					if (next !== undefined) {
						received += next.length;
						yield next;
					} else if (shared.closed) return;
					else await new Promise<void>((resolve) => mine.push(resolve));
				}
			},
			async write(chunk) {
				if (shared.closed) throw new Error("the stream is closed");
				sent += chunk.length;
				outbox.push(chunk);
				wake(theirs);
			},
			async close() {
				shared.closed = true;
				wake(mine);
				wake(theirs);
				return { bytesSent: sent, bytesReceived: received };
			},
		};
		return stream;
	};
	const toAcceptor: Uint8Array[] = [];
	const toInitiator: Uint8Array[] = [];
	const initiatorWaiters: (() => void)[] = [];
	const acceptorWaiters: (() => void)[] = [];
	return [
		end(acceptor, toInitiator, toAcceptor, initiatorWaiters, acceptorWaiters),
		end(initiator, toAcceptor, toInitiator, acceptorWaiters, initiatorWaiters),
	];
}
