/**
 * `runKeyStoreConformance` (design §7.3, O36): what every device `KeyStore`
 * must do (§6.4).
 *
 * - `open` creates the identity and operational keys once and returns the
 *   same keys after; it never returns private material.
 * - The identity key signs what its JWK verifies; key ids are
 *   `<MemberId>#identity` and `<MemberId>#sign`.
 * - The SEAL key opens a box sealed to it under §7.4, and only with the
 *   context and associated data it was sealed with; `agree` gives both sides
 *   the same secret.
 * - Agent state starts empty, and `writeState` replaces it whole.
 * - `rotateOperational` replaces the operational keys and keeps the identity;
 *   `destroy` removes every key.
 *
 * Each call of `make` returns a fresh store with no keys.
 */
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	SignedEnvelopeSchema,
	WitnessedEnvelopeSchema,
} from "../../_generated/fleet_pb.js";
import { ORDER_SECRET_CONTEXT, RECEIPT_CONTEXT } from "../../contexts.js";
import type { AgentState, DeviceKeys, KeyStore } from "../../ports.js";
import {
	type ConformanceAssertion,
	ensure,
	fails,
	sameBytes,
} from "./assertion.js";
import { sealTo, verifyWithJwk } from "./crypto.js";

export type KeyStoreMake = () => KeyStore;

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** What identifies a set of device keys, without anything private. */
const fingerprint = (keys: DeviceKeys) =>
	JSON.stringify({
		memberId: keys.memberId,
		identityJwk: keys.identityJwk,
		identity: keys.identity.keyId,
		sign: keys.sign.keyId,
		seal: keys.sealPublicKey,
	});

const describeState = (state: AgentState) =>
	JSON.stringify({
		generation: state.generation,
		pendingRefreshNonce:
			state.pendingRefreshNonce === undefined
				? null
				: base64(state.pendingRefreshNonce),
		trust:
			state.trust === undefined
				? null
				: base64(toBinary(WitnessedEnvelopeSchema, state.trust)),
		lastSequence: Object.entries(state.lastSequence).sort(([a], [b]) =>
			a.localeCompare(b),
		),
		seenOrderIds: state.seenOrderIds,
		pendingReceipts: state.pendingReceipts.map((receipt) =>
			base64(toBinary(SignedEnvelopeSchema, receipt)),
		),
	});

const envelope = (context: string) =>
	create(SignedEnvelopeSchema, {
		context,
		keyId: "authority#1",
		algorithm: KeyAlgorithm.EDDSA,
		payload: randomBytes(24),
		signature: randomBytes(64),
	});

/** The key-store assertions, in the order they are registered. */
export const KEYSTORE_ASSERTIONS: readonly ConformanceAssertion<KeyStoreMake>[] =
	[
		{
			name: "open creates the keys once and returns the same keys after, also after a rotation",
			async check(make) {
				const store = make();
				const first = await store.open();
				const second = await store.open();
				ensure(
					fingerprint(first) === fingerprint(second),
					"a second open returned different keys",
				);
				const rotated = await store.rotateOperational();
				const reopened = await store.open();
				ensure(
					fingerprint(reopened) === fingerprint(rotated),
					"open after a rotation did not return the rotated keys",
				);
			},
		},
		{
			name: "the identity JWK carries no private member",
			async check(make) {
				const keys = await make().open();
				const jwk: Readonly<Record<string, string>> = JSON.parse(
					keys.identityJwk,
				);
				ensure(
					jwk.kty === "EC" || jwk.kty === "OKP",
					`the identity JWK has kty ${jwk.kty}`,
				);
				for (const member of ["d", "p", "q", "dp", "dq", "qi", "k"])
					ensure(
						!(member in jwk),
						`the identity JWK carries the private member ${member}`,
					);
			},
		},
		{
			name: "the identity key signs what its JWK verifies",
			async check(make) {
				const keys = await make().open();
				const bytes = encoder.encode("hobo-fleet conformance");
				const signature = await keys.identity.sign(bytes);
				ensure(
					verifyWithJwk(
						keys.identityJwk,
						keys.identity.algorithm,
						bytes,
						signature,
					),
					"an identity signature does not verify against the identity JWK",
				);
				ensure(
					!verifyWithJwk(
						keys.identityJwk,
						keys.identity.algorithm,
						encoder.encode("other bytes"),
						signature,
					),
					"an identity signature verifies over other bytes",
				);
			},
		},
		{
			name: "key ids name the member and the key's purpose",
			async check(make) {
				const keys = await make().open();
				ensure(
					keys.identity.keyId === `${keys.memberId}#identity`,
					`the identity key id is ${keys.identity.keyId}`,
				);
				ensure(
					keys.sign.keyId === `${keys.memberId}#sign`,
					`the SIGN key id is ${keys.sign.keyId}`,
				);
			},
		},
		{
			name: "the SEAL key opens a box sealed to it, only with its context and associated data",
			async check(make) {
				const keys = await make().open();
				const secret = randomBytes(48);
				const associated = encoder.encode(`order-1\u0000${keys.memberId}`);
				const box = sealTo(
					keys.sealPublicKey,
					`${keys.memberId}#seal`,
					secret,
					ORDER_SECRET_CONTEXT,
					associated,
				);
				const opened = await keys.openSealed(
					box,
					ORDER_SECRET_CONTEXT,
					associated,
				);
				ensure(
					sameBytes(opened, secret),
					"openSealed did not return the sealed bytes",
				);
				ensure(
					await fails(async () => {
						await keys.openSealed(
							box,
							ORDER_SECRET_CONTEXT,
							encoder.encode("order-2"),
						);
					}),
					"openSealed opened a box under other associated data",
				);
				ensure(
					await fails(async () => {
						await keys.openSealed(box, RECEIPT_CONTEXT, associated);
					}),
					"openSealed opened a box under another context",
				);
			},
		},
		{
			name: "agree gives both sides the same secret",
			async check(make) {
				const a = await make().open();
				const b = await make().open();
				const ab = await a.agree(b.sealPublicKey);
				const ba = await b.agree(a.sealPublicKey);
				ensure(ab.length === 32, `agree answered ${ab.length} bytes, want 32`);
				ensure(sameBytes(ab, ba), "the two sides agreed different secrets");
			},
		},
		{
			name: "a new store reads the empty state",
			async check(make) {
				const store = make();
				await store.open();
				const state = await store.readState();
				ensure(state.generation === 0, `generation ${state.generation}`);
				ensure(
					state.pendingRefreshNonce === undefined,
					"a new store has a pending refresh nonce",
				);
				ensure(state.trust === undefined, "a new store has a pinned trust");
				ensure(
					Object.keys(state.lastSequence).length === 0 &&
						state.seenOrderIds.length === 0 &&
						state.pendingReceipts.length === 0,
					"a new store remembers sequences, orders or receipts",
				);
			},
		},
		{
			name: "writeState replaces the state and readState returns it",
			async check(make) {
				const store = make();
				await store.open();
				const first: AgentState = {
					generation: 3,
					pendingRefreshNonce: randomBytes(16),
					trust: create(WitnessedEnvelopeSchema, {
						authority: envelope("hobo-fleet/trust-record/v1"),
						witness: envelope("hobo-fleet/trust-record/v1"),
					}),
					lastSequence: { orders: 7, control: 2 },
					seenOrderIds: ["order-1", "order-2"],
					pendingReceipts: [envelope(RECEIPT_CONTEXT)],
				};
				await store.writeState(first);
				const read = await store.readState();
				ensure(
					describeState(read) === describeState(first),
					"readState did not return what writeState wrote",
				);
				const second: AgentState = {
					generation: 4,
					pendingRefreshNonce: undefined,
					trust: first.trust,
					lastSequence: { orders: 9 },
					seenOrderIds: [],
					pendingReceipts: [],
				};
				await store.writeState(second);
				ensure(
					describeState(await store.readState()) === describeState(second),
					"writeState merged into the old state instead of replacing it",
				);
			},
		},
		{
			name: "rotateOperational replaces the operational keys and keeps the identity",
			async check(make) {
				const store = make();
				const before = await store.open();
				const rotated = await store.rotateOperational();
				ensure(
					rotated.memberId === before.memberId &&
						rotated.identityJwk === before.identityJwk,
					"rotation changed the identity",
				);
				ensure(
					rotated.sealPublicKey !== before.sealPublicKey,
					"rotation kept the SEAL key",
				);
			},
		},
		{
			name: "destroy removes the keys",
			async check(make) {
				const store = make();
				const before = await store.open();
				await store.destroy();
				const after = await store.open();
				ensure(
					after.identityJwk !== before.identityJwk,
					"open after destroy returned the destroyed identity",
				);
			},
		},
	];
