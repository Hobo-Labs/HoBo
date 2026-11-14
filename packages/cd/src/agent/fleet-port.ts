// The fleet authority as the delivery Station uses it (L19): the
// `DeliveryFleet` port of `createAgentEnrollment`, over `@hobo/fleet/client`
// (`remoteDeliveryFleet`) or over an authority composed in the same process
// (`inProcessDeliveryFleet`), plus the agent-side signer of feed proofs.
//
// Forwarded calls (enroll, credentials) carry the agent's own DPoP proof,
// made by the agent for the authority URL; the Station never re-signs them.
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { JsonObject, TenantId } from "@hobo/core";
import {
	type EnrollmentAuthority,
	type FleetId,
	KeyAlgorithm,
	type PublicJwk,
	parseKeyId,
	type Signer,
	type VerifiedToken,
} from "@hobo/fleet";
import { createFleetClient } from "@hobo/fleet/client";
import { memberIdFromJwk } from "@hobo/fleet/keys";
import type { DeliveryFleet } from "../ports.js";

const MEMBERS = "/v1/fleet/members";

/** The fleet authority over HTTP (`createFleetClient`); `authenticate` verifies member SVIDs for the feed. */
export function remoteDeliveryFleet(
	options: Readonly<{
		tenant: TenantId;
		fleet: FleetId;
		origin: string;
		fetch: typeof fetch;
		/** The Station's own credential at the authority (its token, DPoP signer and key). */
		auth: Readonly<{
			token(): Promise<string>;
			signer: Signer;
			publicJwk: PublicJwk;
		}>;
		authenticate: EnrollmentAuthority["authenticate"];
	}>,
): DeliveryFleet {
	const station = createFleetClient({
		origin: options.origin,
		fetch: options.fetch,
		auth: options.auth,
	});
	return Object.freeze({
		tenant: options.tenant,
		fleet: options.fleet,
		origin: options.origin,
		station,
		forward(dpopProof: string) {
			const forwarding: typeof fetch = (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set("dpop", dpopProof);
				return options.fetch(input, { ...init, headers });
			};
			return createFleetClient({
				origin: options.origin,
				fetch: forwarding,
				auth: undefined,
			});
		},
		authenticate: options.authenticate,
	});
}

/** An authority composed in this process; `station` is the Station's verified principal there. */
export function inProcessDeliveryFleet(
	options: Readonly<{
		authority: EnrollmentAuthority;
		tenant: TenantId;
		fleet: FleetId;
		origin: string;
		station: VerifiedToken;
	}>,
): DeliveryFleet {
	const { authority, station } = options;
	return Object.freeze({
		tenant: options.tenant,
		fleet: options.fleet,
		origin: options.origin,
		station: {
			issueToken: (request) => authority.issueToken(request, station),
			approveKey: (request) => authority.approveKey(request, station),
			accept: (request) => authority.accept(request, station),
			revoke: (request) => authority.revoke(request, station),
		},
		forward(dpopProof: string) {
			return {
				// Enrollment proves possession by the key bundle's signature; the route carries no caller.
				enroll: (request) => authority.enroll(request, undefined),
				async credentials(request) {
					const caller = await authority.authenticate({
						method: "POST",
						url: `${options.origin}${MEMBERS}/${encodeURIComponent(request.memberId)}/credentials`,
						authorization: "",
						dpop: dpopProof,
					});
					if (!caller.ok) return caller;
					return authority.credentials(request, caller.value);
				},
			};
		},
		authenticate: (request) => authority.authenticate(request),
	});
}

/** The agent's signing key from its private JWK file: a DPoP `Signer` and its public JWK. */
export type AgentKey = Readonly<{ signer: Signer; publicJwk: PublicJwk }>;

export function agentKeyFromJwk(privateJwk: JsonObject): AgentKey {
	// Node validates the JWK members; a malformed key throws here.
	const privateKey: KeyObject = createPrivateKey({
		key: privateJwk,
		format: "jwk",
	});
	const algorithm =
		privateKey.asymmetricKeyType === "ec"
			? KeyAlgorithm.ES256
			: privateKey.asymmetricKeyType === "ed25519"
				? KeyAlgorithm.EDDSA
				: undefined;
	if (algorithm === undefined)
		throw new Error("an agent key is an EC P-256 or an Ed25519 JWK");
	const exported = privateKey.export({ format: "jwk" });
	const publicJwk: PublicJwk =
		algorithm === KeyAlgorithm.ES256
			? {
					kty: "EC",
					crv: "P-256",
					x: String(exported.x),
					y: String(exported.y),
				}
			: { kty: "OKP", crv: "Ed25519", x: String(exported.x) };
	const signer: Signer = Object.freeze({
		keyId: parseKeyId(`${memberIdFromJwk(publicJwk)}#identity`),
		algorithm,
		async sign(bytes: Uint8Array): Promise<Uint8Array> {
			return new Uint8Array(
				algorithm === KeyAlgorithm.ES256
					? sign("sha256", bytes, {
							key: privateKey,
							dsaEncoding: "ieee-p1363",
						})
					: sign(null, bytes, privateKey),
			);
		},
	});
	return Object.freeze({ signer, publicJwk });
}
