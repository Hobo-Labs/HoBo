/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/keys` (L01): JWKs and thumbprints, member ids, the signed and
 * witnessed envelope, the trust rule, DPoP, sealing, session keys,
 * fingerprint words, the in-memory key store and credential issuer.
 *
 * Contract commit: every body throws `FleetNotImplemented`; L01 replaces them.
 */
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
import { FleetNotImplemented } from "../errors.js";
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

/** EC P-256 or OKP Ed25519; rejects private members. */
export function parsePublicJwk(json: string): Outcome<PublicJwk> {
	throw new FleetNotImplemented("parsePublicJwk");
}

/** RFC 7638, base64url. */
export function jwkThumbprint(jwk: PublicJwk): string {
	throw new FleetNotImplemented("jwkThumbprint");
}

export function memberIdFromJwk(jwk: PublicJwk): MemberId {
	throw new FleetNotImplemented("memberIdFromJwk");
}

/** §6.2 */
export function sponsoredMemberId(
	tenant: TenantId,
	kind: MemberKind,
	fleet: FleetId,
	name: MemberName,
): MemberId {
	throw new FleetNotImplemented("sponsoredMemberId");
}

export function signEnvelope(
	signer: Signer,
	context: FleetContext,
	payload: Uint8Array,
): Promise<SignedEnvelope> {
	throw new FleetNotImplemented("signEnvelope");
}

export function verifyEnvelope(
	envelope: SignedEnvelope,
	expected: FleetContext,
	key: PublicKeyRef | PublicJwk,
): boolean {
	throw new FleetNotImplemented("verifyEnvelope");
}

export function verifyWitnessed(
	envelope: WitnessedEnvelope,
	expected: FleetContext,
	trust: TrustRecord,
): boolean {
	throw new FleetNotImplemented("verifyWitnessed");
}

/** §7.4 rule */
export function acceptTrust(
	pinned: TrustRecord | undefined,
	next: WitnessedEnvelope,
): Outcome<TrustRecord> {
	throw new FleetNotImplemented("acceptTrust");
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
	throw new FleetNotImplemented("mintDpopProof");
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
	throw new FleetNotImplemented("verifyDpopProof");
}

export function seal(
	recipient: PublicKeyRef,
	plaintext: Uint8Array,
	context: FleetContext,
	associatedData: Uint8Array,
): SealedBox {
	throw new FleetNotImplemented("seal");
}

export function openSealedWith(
	privateKey: KeyObject,
	box: SealedBox,
	context: FleetContext,
	associatedData: Uint8Array,
): Outcome<Uint8Array> {
	throw new FleetNotImplemented("openSealedWith");
}

export function sessionKeys(
	sharedSecret: Uint8Array,
	sessionId: string,
): Readonly<{
	initiatorToAcceptor: Uint8Array;
	acceptorToInitiator: Uint8Array;
}> {
	throw new FleetNotImplemented("sessionKeys");
}

export function fingerprintWords(
	thumbprint: string,
): readonly [string, string, string, string] {
	throw new FleetNotImplemented("fingerprintWords");
}

export function generateDpopKey(): Readonly<{
	signer: Signer;
	publicJwk: PublicJwk;
}> {
	throw new FleetNotImplemented("generateDpopKey");
}

export function createMemoryKeyStore(): KeyStore {
	throw new FleetNotImplemented("createMemoryKeyStore");
}

/** ES256 over an in-memory key, through the same JOSE code; for tests, createTestAuthority and offline development. */
export function createMemoryCredentialIssuer(now: Clock): CredentialIssuer {
	throw new FleetNotImplemented("createMemoryCredentialIssuer");
}
