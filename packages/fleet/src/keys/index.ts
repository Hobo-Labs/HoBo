import type { KeyObject } from "node:crypto";
import type { TenantId } from "@hobo/core";
import type {
	MemberKind,
	PublicKeyRef,
	SealedBox,
	SignedEnvelope,
	TrustRecord,
	WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import type { FleetId, MemberId, MemberName } from "../ids.js";
import type {
	Clock,
	CredentialIssuer,
	FleetContext,
	KeyStore,
	Outcome,
	PublicJwk,
	ReplayStore,
	Signer,
} from "../ports.js";
import { createDpopProof } from "./dpop.js";
import { verifyDpopWithReplay } from "./dpop-verifier.js";
import {
	acceptTrustRecord,
	signEnvelopeWith,
	verifyEnvelopeWith,
	verifyWitnessedWith,
} from "./envelope.js";
import { wordsOf } from "./fingerprint.js";
import { parsePublicJwkText, thumbprintOf } from "./jose.js";
import { deviceMemberId, sponsoredId } from "./member-id.js";
import { memoryCredentialIssuer } from "./memory-issuer.js";
import { memoryKeyStore } from "./memory-key-store.js";
import { deriveSessionKeys, openSealedBox, sealTo } from "./seal.js";
import { freshDpopKey } from "./signers.js";

export function parsePublicJwk(json: string): Outcome<PublicJwk> {
	return parsePublicJwkText(json);
}

export function jwkThumbprint(jwk: PublicJwk): string {
	return thumbprintOf(jwk);
}

export function memberIdFromJwk(jwk: PublicJwk): MemberId {
	return deviceMemberId(thumbprintOf(jwk));
}

export function sponsoredMemberId(
	tenant: TenantId,
	kind: MemberKind,
	fleet: FleetId,
	name: MemberName,
): MemberId {
	return sponsoredId(tenant, kind, fleet, name);
}

export function signEnvelope(
	signer: Signer,
	context: FleetContext,
	payload: Uint8Array,
): Promise<SignedEnvelope> {
	return signEnvelopeWith(signer, context, payload);
}

export function verifyEnvelope(
	envelope: SignedEnvelope,
	expected: FleetContext,
	key: PublicKeyRef | PublicJwk,
): boolean {
	return verifyEnvelopeWith(envelope, expected, key);
}

export function verifyWitnessed(
	envelope: WitnessedEnvelope,
	expected: FleetContext,
	trust: TrustRecord,
): boolean {
	return verifyWitnessedWith(envelope, expected, trust);
}

export function acceptTrust(
	pinned: TrustRecord | undefined,
	next: WitnessedEnvelope,
): Outcome<TrustRecord> {
	return acceptTrustRecord(pinned, next);
}

export function mintDpopProof(
	signer: Signer,
	publicJwk: PublicJwk,
	input: Readonly<{
		htm: string;
		htu: string;
		accessToken?: string;
		nowMs: number;
	}>,
): Promise<string> {
	return createDpopProof(signer, publicJwk, input);
}

export function verifyDpopProof(
	input: Readonly<{
		proof: string;
		htm: string;
		htu: string;
		accessToken?: string;
		nowMs: number;
		replay: ReplayStore;
	}>,
): Promise<Outcome<Readonly<{ jkt: string; jwk: PublicJwk }>>> {
	return verifyDpopWithReplay(
		input.proof,
		input.accessToken === undefined
			? { htm: input.htm, htu: input.htu, nowMs: input.nowMs }
			: {
					htm: input.htm,
					htu: input.htu,
					nowMs: input.nowMs,
					accessToken: input.accessToken,
				},
		input.replay,
	).then((verified) =>
		verified.ok
			? {
					ok: true,
					value: Object.freeze({
						jkt: verified.value.jkt,
						jwk: verified.value.jwk,
					}),
				}
			: verified,
	);
}

export function seal(
	recipient: PublicKeyRef,
	plaintext: Uint8Array,
	context: FleetContext,
	associatedData: Uint8Array,
): SealedBox {
	return sealTo(recipient, plaintext, context, associatedData);
}

export function openSealedWith(
	privateKey: KeyObject,
	box: SealedBox,
	context: FleetContext,
	associatedData: Uint8Array,
): Outcome<Uint8Array> {
	return openSealedBox(privateKey, box, context, associatedData);
}

export function sessionKeys(
	sharedSecret: Uint8Array,
	sessionId: string,
): Readonly<{
	initiatorToAcceptor: Uint8Array;
	acceptorToInitiator: Uint8Array;
}> {
	return deriveSessionKeys(sharedSecret, sessionId);
}

export function fingerprintWords(
	thumbprint: string,
): readonly [string, string, string, string] {
	return wordsOf(thumbprint);
}

export function generateDpopKey(): Readonly<{
	signer: Signer;
	publicJwk: PublicJwk;
}> {
	return freshDpopKey();
}

export function createMemoryKeyStore(): KeyStore {
	return memoryKeyStore();
}

export function createMemoryCredentialIssuer(now: Clock): CredentialIssuer {
	return memoryCredentialIssuer(now);
}
