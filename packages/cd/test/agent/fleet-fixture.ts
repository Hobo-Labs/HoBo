// The fleet side of the agent and feed tests (L19): `createTestAuthority`
// with the Yard's fleet defined by the Station, the in-process
// `DeliveryFleet`, and devices that enroll and fetch member SVIDs the way the
// fleet agent does (identity key, SIGN key, key bundle, DPoP proofs). The
// device keys are generated here, so a test can hand the SIGN key to the
// feed transport as the private JWK it reads from its key file.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { type JsonObject, parseTenantId } from "@hobo/core";
import {
	ApprovalMode,
	CoordinationMode,
	CredentialRequestSchema,
	DeviceClass,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type FleetId,
	FleetRecordSchema,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	type MemberId,
	PublicKeyRefSchema,
	parseFleetId,
	Role,
	type VerifiedToken,
} from "@hobo/fleet";
import { memberIdFromJwk, mintDpopProof, signEnvelope } from "@hobo/fleet/keys";
import { createTestAuthority } from "@hobo/fleet/testing";
import {
	type AgentKey,
	agentKeyFromJwk,
	inProcessDeliveryFleet,
} from "../../src/agent/index.js";
import type { DeliveryFleet } from "../../src/ports.js";

export const FLEET_ORIGIN = "https://authority.fleet.test";
export const FLEET_TENANT = parseTenantId("test");
export const YARD_FLEET: FleetId = parseFleetId("yard-a");

const STATION_PRINCIPAL = { kind: "service", id: "cd-station" } as const;

export type FleetDevice = Readonly<{
	memberId: MemberId;
	/** The SIGN key (Ed25519) as the private JWK the feed transport reads from its key file. */
	signPrivateJwk: JsonObject;
	sign: AgentKey;
	/** The agent's EnrollmentRequest for a bootstrap token (name from the token). */
	request(token: string, fleet?: FleetId): EnrollmentRequest;
	/** A DPoP proof by the SIGN key for a URL (`ath` when a token is given). */
	proof(method: string, url: string, accessToken?: string): Promise<string>;
}>;

function privateJwkOf(
	key: ReturnType<typeof generateKeyPairSync>["privateKey"],
): JsonObject {
	const jwk = key.export({ format: "jwk" });
	const out: JsonObject = {};
	for (const name of ["kty", "crv", "x", "y", "d"] as const) {
		const value = jwk[name];
		if (value !== undefined) out[name] = value;
	}
	return out;
}

/** A fresh Ed25519 private JWK, for a transport that never reaches the fleet. */
export function freshSignJwk(): JsonObject {
	return privateJwkOf(generateKeyPairSync("ed25519").privateKey);
}

export async function fleetFixture(
	now: () => number,
	approval: ApprovalMode = ApprovalMode.SINGLE,
) {
	const composed = await createTestAuthority(now);
	const station: VerifiedToken = {
		kind: "person",
		principal: STATION_PRINCIPAL,
		tenant: FLEET_TENANT,
		tags: ["fleet-admin"],
		jkt: "cd-station",
		expiresAtMs: Number.MAX_SAFE_INTEGER,
	};
	const defined = await composed.authority.defineFleet(
		create(FleetRecordSchema, {
			fleetId: YARD_FLEET,
			tenant: FLEET_TENANT,
			owner: "service:cd-station",
			coordination: CoordinationMode.MANY_ACTIVE,
			policy: { approval },
		}),
		station,
	);
	if (!defined.ok) throw new Error(`defineFleet: ${defined.error.message}`);
	const fleet: DeliveryFleet = inProcessDeliveryFleet({
		authority: composed.authority,
		tenant: FLEET_TENANT,
		fleet: YARD_FLEET,
		origin: FLEET_ORIGIN,
		station,
	});

	async function device(): Promise<FleetDevice> {
		const identity = agentKeyFromJwk(
			privateJwkOf(
				generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
			),
		);
		const signPrivateJwk = privateJwkOf(
			generateKeyPairSync("ed25519").privateKey,
		);
		const sign = agentKeyFromJwk(signPrivateJwk);
		const seal = privateJwkOf(generateKeyPairSync("x25519").privateKey);
		const memberId = memberIdFromJwk(identity.publicJwk);
		const signPublicKey = sign.publicJwk.x;
		const nowMs = now();
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
							value: signPublicKey,
						}),
						create(PublicKeyRefSchema, {
							purpose: KeyPurpose.SEAL,
							keyId: `${memberId}#seal`,
							algorithm: KeyAlgorithm.UNSPECIFIED,
							value: String(seal.x),
						}),
					],
					issuedAt: new Date(nowMs).toISOString(),
					notAfter: new Date(nowMs + 24 * 3_600_000).toISOString(),
				}),
			),
		);
		return {
			memberId,
			signPrivateJwk,
			sign,
			request(token, target = YARD_FLEET) {
				return create(EnrollmentRequestSchema, {
					tenant: FLEET_TENANT,
					fleet: target,
					name: "",
					displayName: "reconciler",
					identityJwk: JSON.stringify(identity.publicJwk),
					keyBundle: bundle,
					platform: { os: "linux", arch: "x64" },
					region: "eu-west-1",
					agentVersion: "1.0.0",
					deviceClass: DeviceClass.DEDICATED,
					requestedRoles: [Role.RECONCILER],
					proof: { case: "bootstrapToken", value: token },
				});
			},
			proof(method, url, accessToken) {
				return mintDpopProof(
					sign.signer,
					sign.publicJwk,
					accessToken === undefined
						? { htm: method, htu: url, nowMs: now() }
						: { htm: method, htu: url, accessToken, nowMs: now() },
				);
			},
		};
	}

	/** The member SVID a device fetches from the fleet with its SIGN key (generation from 0). */
	async function credentials(
		subject: FleetDevice,
		memberId: MemberId = subject.memberId,
		generation = 0,
	): Promise<string> {
		const url = `${FLEET_ORIGIN}/v1/fleet/members/${memberId}/credentials`;
		const issued = await fleet
			.forward(await subject.proof("POST", url))
			.credentials({
				memberId,
				request: create(CredentialRequestSchema, {
					generation,
					refreshNonce: randomBytes(16),
					agentVersion: "1.0.0",
				}),
			});
		if (!issued.ok) throw new Error(`credentials: ${issued.error.message}`);
		return issued.value.svid;
	}

	return { ...composed, fleet, station, device, credentials };
}

export type FleetFixture = Awaited<ReturnType<typeof fleetFixture>>;
