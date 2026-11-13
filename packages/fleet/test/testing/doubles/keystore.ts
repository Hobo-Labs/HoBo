/**
 * An in-memory key store that keeps the contract (the suite's reference), and
 * stores broken in exactly one way each, keyed by the key-store assertion that
 * must catch the break.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { KeyAlgorithm } from "../../../src/_generated/fleet_pb.js";
import { parseKeyId } from "../../../src/ids.js";
import type { AgentState, DeviceKeys, KeyStore } from "../../../src/ports.js";
import {
	createSuiteKey,
	ed25519RawOf,
	createSuiteSealKey,
	randomMemberId,
} from "../../../src/testing/conformance/crypto.js";
import type { KeyStoreMake } from "../../../src/testing/conformance/keystore.js";

const EMPTY: AgentState = {
	generation: 0,
	pendingRefreshNonce: undefined,
	trust: undefined,
	lastSequence: {},
	seenOrderIds: [],
	pendingReceipts: [],
};

type Faults = Readonly<{
	reopenMakesNewKeys?: boolean;
	privateJwk?: boolean;
	identitySignsWithSignKey?: boolean;
	wrongSignKeyId?: boolean;
	openSealedFails?: boolean;
	agreeRandom?: boolean;
	initialGeneration?: number;
	writeMerges?: boolean;
	rotateIsNoop?: boolean;
	destroyIsNoop?: boolean;
}>;

function storeWith(faults: Faults): KeyStoreMake {
	return () => {
		let keys: DeviceKeys | undefined;
		let state: AgentState = {
			...EMPTY,
			generation: faults.initialGeneration ?? 0,
		};
		const operational = (
			base: Pick<DeviceKeys, "memberId" | "identityJwk" | "identity">,
		): DeviceKeys => {
			const signing = createSuiteKey(
				faults.wrongSignKeyId === true
					? `${base.memberId}#seal`
					: `${base.memberId}#sign`,
			);
			const seal = createSuiteSealKey();
			return {
				...base,
				identity:
					faults.identitySignsWithSignKey === true
						? { ...base.identity, sign: signing.signer.sign }
						: base.identity,
				sign: signing.signer,
				signPublicKey: ed25519RawOf(signing.publicJwk),
				sealPublicKey: seal.publicKey,
				openSealed:
					faults.openSealedFails === true
						? async () => {
								throw new Error("cannot open");
							}
						: seal.openSealed,
				agree:
					faults.agreeRandom === true
						? async () => new Uint8Array(randomBytes(32))
						: seal.agree,
				heldKey: false,
			};
		};
		const created = (): DeviceKeys => {
			const memberId = randomMemberId();
			if (faults.privateJwk === true) {
				const { privateKey } = generateKeyPairSync("ed25519");
				return operational({
					memberId,
					identityJwk: JSON.stringify(privateKey.export({ format: "jwk" })),
					identity: {
						keyId: parseKeyId(`${memberId}#identity`),
						algorithm: KeyAlgorithm.EDDSA,
						async sign(bytes) {
							return new Uint8Array(sign(null, bytes, privateKey));
						},
					},
				});
			}
			const identity = createSuiteKey(`${memberId}#identity`);
			return operational({
				memberId,
				identityJwk: identity.publicJwk,
				identity: identity.signer,
			});
		};
		const store: KeyStore = {
			async open() {
				if (keys === undefined || faults.reopenMakesNewKeys === true)
					keys = created();
				return keys;
			},
			async readState() {
				return state;
			},
			async writeState(next) {
				state =
					faults.writeMerges === true
						? {
								...next,
								lastSequence: { ...state.lastSequence, ...next.lastSequence },
							}
						: next;
			},
			async rotateOperational() {
				const current = keys ?? (await store.open());
				if (faults.rotateIsNoop !== true) keys = operational(current);
				return keys ?? current;
			},
			async destroy() {
				if (faults.destroyIsNoop === true) return;
				keys = undefined;
				state = EMPTY;
			},
		};
		return store;
	};
}

/** The reference store: passes `runKeyStoreConformance`. */
export const memoryKeyStore: KeyStoreMake = storeWith({});

export const BROKEN_KEYSTORES: ReadonlyMap<string, KeyStoreMake> = new Map([
	[
		"open creates the keys once and returns the same keys after, also after a rotation",
		storeWith({ reopenMakesNewKeys: true }),
	],
	[
		"the identity JWK carries no private member",
		storeWith({ privateJwk: true }),
	],
	[
		"the identity key signs what its JWK verifies",
		storeWith({ identitySignsWithSignKey: true }),
	],
	[
		"key ids name the member and the key's purpose",
		storeWith({ wrongSignKeyId: true }),
	],
	[
		"the SEAL key opens a box sealed to it, only with its context and associated data",
		storeWith({ openSealedFails: true }),
	],
	["agree gives both sides the same secret", storeWith({ agreeRandom: true })],
	["a new store reads the empty state", storeWith({ initialGeneration: 1 })],
	[
		"writeState replaces the state and readState returns it",
		storeWith({ writeMerges: true }),
	],
	[
		"rotateOperational replaces the operational keys and keeps the identity",
		storeWith({ rotateIsNoop: true }),
	],
	["destroy removes the keys", storeWith({ destroyIsNoop: true })],
]);
