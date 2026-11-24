import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import type { JsonObject, TenantId } from "@hobo/core";
import {
	DeviceClass,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type FleetId,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	type MemberId,
	PublicKeyRefSchema,
	Role,
} from "@hobo/fleet";
import { memberIdFromJwk, mintDpopProof, signEnvelope } from "@hobo/fleet/keys";
import { agentKeyFromJwk } from "./fleet-port.js";

export type ReconcilerKeys = Readonly<{
	identity: JsonObject;
	sign: JsonObject;
	seal: JsonObject;
}>;

const BUNDLE_LIFETIME_MS = 24 * 3_600_000;
const MEMBERS_PATH = "/v1/fleet/members";

function privateJwkOf(key: KeyObject): JsonObject {
	const jwk = key.export({ format: "jwk" });
	return Object.fromEntries(
		(["kty", "crv", "x", "y", "d"] as const).flatMap((name) => {
			const value = jwk[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

export function generateReconcilerKeys(): ReconcilerKeys {
	return Object.freeze({
		identity: privateJwkOf(
			generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
		),
		sign: privateJwkOf(generateKeyPairSync("ed25519").privateKey),
		seal: privateJwkOf(generateKeyPairSync("x25519").privateKey),
	});
}

export async function reconcilerEnrollment(
	input: Readonly<{
		keys: ReconcilerKeys;
		token: string;
		tenant: TenantId;
		fleet: FleetId;
		origin: string;
		nowMs: number;
		agentVersion: string;
		displayName?: string;
		region?: string;
	}>,
): Promise<
	Readonly<{
		memberId: MemberId;
		request: EnrollmentRequest;
		dpopProof: string;
	}>
> {
	const identity = agentKeyFromJwk(input.keys.identity);
	const sign = agentKeyFromJwk(input.keys.sign);
	const memberId = memberIdFromJwk(identity.publicJwk);
	const bundle = await signEnvelope(
		identity.signer,
		KEY_BUNDLE_CONTEXT,
		toBinary(
			KeyBundleSchema,
			create(KeyBundleSchema, {
				memberId,
				sequence: 1,
				keys: [
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SIGN,
						keyId: `${memberId}#sign`,
						algorithm: KeyAlgorithm.EDDSA,
						value: sign.publicJwk.x,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${memberId}#seal`,
						algorithm: KeyAlgorithm.UNSPECIFIED,
						value: String(input.keys.seal.x),
					}),
				],
				issuedAt: new Date(input.nowMs).toISOString(),
				notAfter: new Date(input.nowMs + BUNDLE_LIFETIME_MS).toISOString(),
			}),
		),
	);
	const request = create(EnrollmentRequestSchema, {
		tenant: input.tenant,
		fleet: input.fleet,
		name: "",
		displayName: input.displayName ?? "reconciler",
		identityJwk: JSON.stringify(identity.publicJwk),
		keyBundle: bundle,
		platform: { os: process.platform, arch: process.arch },
		region: input.region ?? "",
		agentVersion: input.agentVersion,
		deviceClass: DeviceClass.DEDICATED,
		requestedRoles: [Role.RECONCILER],
		proof: { case: "bootstrapToken", value: input.token },
	});
	const dpopProof = await mintDpopProof(identity.signer, identity.publicJwk, {
		htm: "POST",
		htu: `${input.origin.replace(/\/+$/u, "")}${MEMBERS_PATH}`,
		nowMs: input.nowMs,
	});
	return Object.freeze({ memberId, request, dpopProof });
}
