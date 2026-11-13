// The in-memory `KeyStore` (design §6.4, §7.3): an ES256 identity key, an
// Ed25519 SIGN key and an X25519 SEAL key, held in this closure and never
// returned. For tests, local development and `createTestAuthority`; the file
// and external-signer stores are in `@hobo/fleet-agent` (L10).

import {
	diffieHellman,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	KeyAlgorithm,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	type SealedBox,
} from "../_generated/fleet_pb.js";
import { FLEET_CONTEXTS } from "../contexts.js";
import { type MemberId, parseKeyId } from "../ids.js";
import type { AgentState, DeviceKeys, KeyStore } from "../ports.js";
import { rawValueOfJwk } from "./envelope.js";
import { publicJwkJson, thumbprintOf } from "./jose.js";
import { deviceMemberId } from "./member-id.js";
import { openSealedBox, rawX25519, x25519PublicKey } from "./seal.js";
import { generateSigningKey, memorySigner } from "./signers.js";

const signRefs = new WeakMap<DeviceKeys, PublicKeyRef>();

/** The SIGN public key of keys opened from a memory store (DeviceKeys does not carry it; see the lane report). */
export function memorySignKeyRef(keys: DeviceKeys): PublicKeyRef | undefined {
	return signRefs.get(keys);
}

function emptyState(): AgentState {
	return Object.freeze({
		generation: 0,
		pendingRefreshNonce: undefined,
		trust: undefined,
		lastSequence: Object.freeze({}),
		seenOrderIds: Object.freeze([]),
		pendingReceipts: Object.freeze([]),
	});
}

function copyState(state: AgentState): AgentState {
	return Object.freeze({
		generation: state.generation,
		pendingRefreshNonce:
			state.pendingRefreshNonce === undefined
				? undefined
				: new Uint8Array(state.pendingRefreshNonce),
		trust: state.trust,
		lastSequence: Object.freeze({ ...state.lastSequence }),
		seenOrderIds: Object.freeze([...state.seenOrderIds]),
		pendingReceipts: Object.freeze([...state.pendingReceipts]),
	});
}

type Held = Readonly<{
	identity: KeyObject;
	identityJwk: string;
	sign: KeyObject;
	seal: KeyObject;
	keys: DeviceKeys;
}>;

function deviceKeysOf(
	identity: KeyObject,
	identityJwkText: string,
	memberId: MemberId,
): Held {
	const sign = generateSigningKey(KeyAlgorithm.EDDSA);
	const seal = generateKeyPairSync("x25519").privateKey;
	const sealPublicKey = rawX25519(seal);
	const keys: DeviceKeys = Object.freeze({
		memberId,
		identityJwk: identityJwkText,
		identity: memorySigner(parseKeyId(`${memberId}#identity`), identity),
		sign: memorySigner(parseKeyId(`${memberId}#sign`), sign.privateKey),
		sealPublicKey,
		async openSealed(
			box: SealedBox,
			context: string,
			associatedData: Uint8Array,
		): Promise<Uint8Array> {
			const known = FLEET_CONTEXTS.find((candidate) => candidate === context);
			if (known === undefined) throw new Error(`unknown context ${context}`);
			if (box.recipientKeyId !== `${memberId}#seal`)
				throw new Error(`the box is sealed to ${box.recipientKeyId}`);
			const opened = openSealedBox(seal, box, known, associatedData);
			if (!opened.ok) throw new Error(opened.error.message);
			return opened.value;
		},
		async agree(peerSealPublicKey: string): Promise<Uint8Array> {
			const peer = x25519PublicKey(peerSealPublicKey);
			if (peer === undefined)
				throw new Error("the peer key is not a raw X25519 key");
			return new Uint8Array(
				diffieHellman({ privateKey: seal, publicKey: peer }),
			);
		},
		heldKey: false,
	} satisfies DeviceKeys);
	signRefs.set(
		keys,
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SIGN,
			keyId: `${memberId}#sign`,
			algorithm: KeyAlgorithm.EDDSA,
			value: rawValueOfJwk(sign.publicJwk),
		}),
	);
	return {
		identity,
		identityJwk: identityJwkText,
		sign: sign.privateKey,
		seal,
		keys,
	};
}

export function memoryKeyStore(): KeyStore {
	let held: Held | undefined;
	let state = emptyState();

	const openKeys = (): Held => {
		if (held !== undefined) return held;
		const identity = generateSigningKey(KeyAlgorithm.ES256);
		const memberId = deviceMemberId(thumbprintOf(identity.publicJwk));
		held = deviceKeysOf(
			identity.privateKey,
			JSON.stringify(publicJwkJson(identity.publicJwk)),
			memberId,
		);
		return held;
	};

	return Object.freeze({
		async open() {
			return openKeys().keys;
		},
		async readState() {
			return copyState(state);
		},
		async writeState(next: AgentState) {
			state = copyState(next);
		},
		async rotateOperational() {
			const current = openKeys();
			held = deviceKeysOf(
				current.identity,
				current.identityJwk,
				current.keys.memberId,
			);
			return held.keys;
		},
		async destroy() {
			held = undefined;
			state = emptyState();
		},
	} satisfies KeyStore);
}
