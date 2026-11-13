/**
 * PACT consumer tests of `createFleetClient` against the authority's HTTP API
 * (design §6.15, §7.3 `FleetClient`, O35). Each interaction is one route: the
 * mock provider below answers only a request that matches it exactly (method,
 * path and query, protobuf JSON body, and the authentication the route
 * takes, with the DPoP proof verified over that method and URL), and the
 * client must read the canned answer back. When every interaction has run,
 * the pact is written to `contracts/fleet-authority.pact.json`, which L09
 * replays on the provider side.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@bufbuild/protobuf";
import { create, toJson, toJsonString } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { parseTenantId } from "@hobo/core";
import { afterAll, describe, expect, it } from "vitest";
import {
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	AuthorityDiscoverySchema,
	CredentialRequestSchema,
	CredentialResponseSchema,
	DeclareRequestSchema,
	DeviceClass,
	DiscoverySchema,
	EnrollmentRequestSchema,
	EnrollmentResponseSchema,
	FleetErrorSchema,
	FleetListSchema,
	FleetPolicySchema,
	FleetRecordSchema,
	FleetVerdictSchema,
	KeyAlgorithm,
	KeyRotationRequestSchema,
	LifecycleRequestSchema,
	MemberKind,
	MemberListSchema,
	MembershipRequestSchema,
	PersonCredentialSchema,
	Role,
	SessionPurpose,
	SessionRequestSchema,
	SignedEnvelopeSchema,
	SignInChallengeSchema,
	SignInCompleteSchema,
	SignInPollSchema,
	SignInRefreshSchema,
	SignInStartSchema,
	TokenCreateRequestSchema,
	TokenCreateResponseSchema,
	TokenListSchema,
	VerdictState,
	ViolationReportSchema,
	WorkLogsSchema,
	WorkStatusSchema,
	WorkSubmissionRequestSchema,
} from "../../src/_generated/fleet_pb.js";
import { createFleetClient } from "../../src/client/index.js";
import { parseFleetId } from "../../src/ids.js";
import { generateDpopKey, verifyDpopProof } from "../../src/keys/index.js";
import type { FleetClient, Outcome, ReplayStore } from "../../src/ports.js";

const ORIGIN = "https://authority.fleet.test";
const PERSON_TOKEN = "eyJhbGciOiJFUzI1NiJ9.person.token";
const MEMBER = "dev_0123456789abcdef0123456789abcdef";
const FLEET = parseFleetId("hobo");
const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"contracts",
	"fleet-authority.pact.json",
);

type Json = ReturnType<typeof toJson>;
type AuthKind = "none" | "proof" | "token";
type Interaction = Readonly<{
	description: string;
	providerState: string;
	method: string;
	path: string;
	auth: AuthKind;
	body?: Json;
	status: number;
	response: string;
}>;

const envelopeJson = (context: string) =>
	toJsonString(
		SignedEnvelopeSchema,
		create(SignedEnvelopeSchema, {
			context,
			keyId: "authority#1",
			algorithm: KeyAlgorithm.EDDSA,
			payload: new Uint8Array([10, 3, 100, 101, 118]),
			signature: new Uint8Array(64),
		}),
	);

function json<T extends Message>(schema: GenMessage<T>, message: T): Json {
	return toJson(schema, message);
}

const { signer, publicJwk } = generateDpopKey();
const seen = new Map<string, number>();
const replay: ReplayStore = {
	async firstUse(scope, id) {
		const key = `${scope}.${id}`;
		if (seen.has(key)) return false;
		seen.set(key, 1);
		return true;
	},
};

const recorded: Interaction[] = [];
let expected: Interaction | undefined;
const mismatches: string[] = [];

/** The mock provider: answers only the interaction under test, and only when the request matches it. */
const provider: typeof fetch = async (input, init) => {
	const interaction = expected;
	if (interaction === undefined) throw new TypeError("no interaction is set");
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = init?.method ?? "GET";
	const headers = new Headers(init?.headers);
	const text =
		init?.body === undefined || init.body === null ? "" : String(init.body);
	const problems: string[] = [];
	if (method !== interaction.method)
		problems.push(`method ${method} is not ${interaction.method}`);
	if (`${url.pathname}${url.search}` !== interaction.path)
		problems.push(
			`path ${url.pathname}${url.search} is not ${interaction.path}`,
		);
	const body = text.length === 0 ? undefined : JSON.parse(text);
	expect(body).toEqual(interaction.body);
	const authorization = headers.get("authorization");
	const dpop = headers.get("dpop");
	if (interaction.auth === "none" && (authorization !== null || dpop !== null))
		problems.push("an open route carries credentials");
	if (interaction.auth === "proof" && (authorization !== null || dpop === null))
		problems.push("a proof route carries a token or no proof");
	if (
		interaction.auth === "token" &&
		(authorization !== `DPoP ${PERSON_TOKEN}` || dpop === null)
	)
		problems.push("a token route lacks its DPoP token or proof");
	if (dpop !== null) {
		const expectation = {
			proof: dpop,
			htm: method,
			htu: `${url.origin}${url.pathname}`,
			nowMs: Date.now(),
			replay,
		};
		const proof = await verifyDpopProof(
			interaction.auth === "token"
				? { ...expectation, accessToken: PERSON_TOKEN }
				: expectation,
		);
		if (!proof.ok) problems.push(`proof: ${proof.error.message}`);
	}
	if (headers.get("accept") !== "application/json")
		problems.push("no JSON accept header");
	if (problems.length > 0) {
		mismatches.push(...problems);
		return new Response("mismatch", { status: 500 });
	}
	recorded.push(interaction);
	return new Response(interaction.response, {
		status: interaction.status,
		headers: { "content-type": "application/json" },
	});
};

const client: FleetClient = createFleetClient({
	origin: `${ORIGIN}/`,
	fetch: provider,
	auth: { token: async () => PERSON_TOKEN, signer, publicJwk },
});

async function exchange<T>(
	interaction: Interaction,
	run: (fleet: FleetClient) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	expected = interaction;
	mismatches.length = 0;
	const outcome = await run(client);
	expected = undefined;
	expect(mismatches).toEqual([]);
	return outcome;
}

function ok<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.value;
}

const DPOP_PATTERN = "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$";

/** One interaction in pact form: headers and matching rules follow what the route carries. */
function pactInteraction(interaction: Interaction) {
	const [path = "", search] = interaction.path.split("?");
	const headers = new Map<string, string>([["Accept", "application/json"]]);
	const rules = new Map<string, Readonly<Record<string, string>>>();
	if (interaction.body !== undefined) {
		headers.set("Content-Type", "application/json");
		rules.set("$.body", { match: "type" });
	}
	if (interaction.auth !== "none") {
		headers.set("DPoP", "<compact JWS, typ dpop+jwt>");
		rules.set("$.headers.DPoP", { match: "regex", regex: DPOP_PATTERN });
	}
	if (interaction.auth === "token") {
		headers.set("Authorization", "DPoP <token>");
		rules.set("$.headers.Authorization", {
			match: "regex",
			regex: "^DPoP .+$",
		});
	}
	const request = new Map<string, Json | string>([
		["method", interaction.method],
		["path", path],
	]);
	if (search !== undefined) request.set("query", search);
	const out = {
		description: interaction.description,
		providerState: interaction.providerState,
		request: {
			...Object.fromEntries(request),
			headers: Object.fromEntries(headers),
			body: interaction.body,
			matchingRules: Object.fromEntries(rules),
		},
		response: {
			status: interaction.status,
			headers: { "Content-Type": "application/json" },
			body: JSON.parse(interaction.response),
			matchingRules: { "$.body": { match: "type" } },
		},
	};
	return out;
}

const SIGNED_MEMBER = envelopeJson("hobo-fleet/member-record/v1");
const SIGNED_FLEET = envelopeJson("hobo-fleet/fleet-record/v1");
const lifecycleBody = json(
	LifecycleRequestSchema,
	create(LifecycleRequestSchema, {
		reason: "checked by a person",
		fleets: [FLEET],
	}),
);

describe("createFleetClient against the authority's HTTP API (PACT consumer)", () => {
	afterAll(() => {
		const pact = {
			consumer: { name: "@hobo/fleet/client" },
			provider: { name: "@hobo/fleet-authority HTTP API" },
			metadata: {
				pactSpecification: { version: "3.0.0" },
				note: "Written by packages/fleet/test/client/client.pact.test.ts (L07). Bodies are protobuf JSON of the records of design §7.1; errors are FleetError with the §7.6 status. `auth` names what the request carries: none; a bare DPoP proof (`DPoP` header); or `Authorization: DPoP <token>` plus a proof whose `ath` hashes it. Header values and record contents are examples: the provider matches them by type (matchingRules), not by value.",
			},
			interactions: recorded.map(pactInteraction),
		};
		writeFileSync(pactPath, `${JSON.stringify(pact, null, "\t")}\n`, "utf8");
	});

	it("reads discovery, the tenant's discovery and the JWKS without credentials", async () => {
		const discovery = ok(
			await exchange(
				{
					description: "the authority's discovery document",
					providerState: "an authority is running",
					method: "GET",
					path: "/.well-known/hobo-fleet",
					auth: "none",
					status: 200,
					response: toJsonString(
						AuthorityDiscoverySchema,
						create(AuthorityDiscoverySchema, {
							issuer: ORIGIN,
							jwksUri: `${ORIGIN}/v1/fleet/jwks`,
							signInProviders: ["github", "oidc"],
						}),
					),
				},
				(fleet) => fleet.authorityDiscovery({}),
			),
		);
		expect(discovery.signInProviders).toEqual(["github", "oidc"]);

		const tenant = ok(
			await exchange(
				{
					description: "a tenant's discovery: bus, relays and the trust record",
					providerState: "tenant test exists",
					method: "GET",
					path: "/v1/fleet/tenants/test/discovery",
					auth: "none",
					status: 200,
					response: toJsonString(
						DiscoverySchema,
						create(DiscoverySchema, {
							tenant: "test",
							issuer: ORIGIN,
							natsUrls: ["tls://nats.fleet.test:4222"],
							relayUrls: ["https://relay.fleet.test"],
							minAgentVersion: "1.0.0",
						}),
					),
				},
				(fleet) => fleet.discovery({ tenant: parseTenantId("test") }),
			),
		);
		expect(tenant.natsUrls).toEqual(["tls://nats.fleet.test:4222"]);

		const jwks = ok(
			await exchange(
				{
					description: "the authority's token signing keys",
					providerState: "an authority is running",
					method: "GET",
					path: "/v1/fleet/jwks",
					auth: "none",
					status: 200,
					response: JSON.stringify({
						keys: [{ kty: "EC", crv: "P-256", x: "AA", y: "AA", kid: "k1" }],
					}),
				},
				(fleet) => fleet.jwks({}),
			),
		);
		expect(JSON.parse(jwks.jwks).keys[0].kid).toBe("k1");
	});

	it("signs a person in: start without credentials, complete and poll with a bare proof, refresh with the token", async () => {
		const start = create(SignInStartSchema, {
			provider: "github",
			tenant: "test",
			redirectUri: "http://127.0.0.1:53682/callback",
			codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			dpopThumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
			hostName: "laptop",
		});
		const challenge = ok(
			await exchange(
				{
					description: "start a browser sign-in",
					providerState: "sign-in provider github is configured",
					method: "POST",
					path: "/v1/fleet/signin/start",
					auth: "none",
					body: json(SignInStartSchema, start),
					status: 200,
					response: toJsonString(
						SignInChallengeSchema,
						create(SignInChallengeSchema, {
							state: "st_1",
							authorizeUrl:
								"https://github.com/login/oauth/authorize?state=st_1",
							expiresAt: "2026-11-13T12:10:00.000Z",
						}),
					),
				},
				(fleet) => fleet.signInStart(start),
			),
		);
		expect(challenge.state).toBe("st_1");

		const credential = toJsonString(
			PersonCredentialSchema,
			create(PersonCredentialSchema, {
				token: PERSON_TOKEN,
				expiresAt: "2026-11-13T12:15:00.000Z",
				refreshUntil: "2026-11-14T00:00:00.000Z",
				principal: "user:alice",
				tenant: "test",
				tags: ["fleet-admin"],
			}),
		);
		const complete = create(SignInCompleteSchema, {
			state: "st_1",
			code: "ac_1",
			codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		});
		expect(
			ok(
				await exchange(
					{
						description:
							"exchange the one-time authority code for a person token",
						providerState: "sign-in st_1 was approved",
						method: "POST",
						path: "/v1/fleet/signin/complete",
						auth: "proof",
						body: json(SignInCompleteSchema, complete),
						status: 200,
						response: credential,
					},
					(fleet) => fleet.signInComplete(complete),
				),
			).principal,
		).toBe("user:alice");

		const poll = create(SignInPollSchema, { state: "st_2" });
		const pending = await exchange(
			{
				description: "poll a device-code sign-in the person has not confirmed",
				providerState: "device sign-in st_2 is pending",
				method: "POST",
				path: "/v1/fleet/signin/device/poll",
				auth: "proof",
				body: json(SignInPollSchema, poll),
				status: 428,
				response: toJsonString(
					FleetErrorSchema,
					create(FleetErrorSchema, {
						code: "sign-in-pending",
						message: "the person has not confirmed yet",
					}),
				),
			},
			(fleet) => fleet.signInPoll(poll),
		);
		expect(pending).toEqual({
			ok: false,
			error: {
				code: "sign-in-pending",
				message: "the person has not confirmed yet",
			},
		});

		const refresh = create(SignInRefreshSchema, {});
		expect(
			ok(
				await exchange(
					{
						description: "refresh a person token",
						providerState: "a person token for user:alice is valid",
						method: "POST",
						path: "/v1/fleet/signin/refresh",
						auth: "token",
						body: json(SignInRefreshSchema, refresh),
						status: 200,
						response: credential,
					},
					(fleet) => fleet.signInRefresh(refresh),
				),
			).token,
		).toBe(PERSON_TOKEN);
	});

	it("issues, lists and revokes bootstrap tokens with the person token", async () => {
		const request = create(TokenCreateRequestSchema, {
			fleet: FLEET,
			name: "laptop",
			displayName: "Alice's laptop",
			deviceClass: DeviceClass.PERSONAL,
			roles: [Role.EXECUTOR],
			ttlSeconds: 900,
		});
		expect(
			ok(
				await exchange(
					{
						description: "issue a bootstrap token",
						providerState: "fleet hobo exists and user:alice may invite",
						method: "POST",
						path: "/v1/fleet/tokens",
						auth: "token",
						body: json(TokenCreateRequestSchema, request),
						status: 200,
						response: toJsonString(
							TokenCreateResponseSchema,
							create(TokenCreateResponseSchema, {
								token: `hft_${"A".repeat(43)}`,
								tokenHash: "a".repeat(64),
								expiresAt: "2026-11-13T12:15:00.000Z",
							}),
						),
					},
					(fleet) => fleet.issueToken(request),
				),
			).tokenHash,
		).toBe("a".repeat(64));
		const list = toJsonString(
			TokenListSchema,
			create(TokenListSchema, {
				tokens: [{ tokenHash: "a".repeat(64), fleet: FLEET, name: "laptop" }],
			}),
		);
		ok(
			await exchange(
				{
					description: "list bootstrap tokens",
					providerState: "one bootstrap token is outstanding",
					method: "GET",
					path: "/v1/fleet/tokens",
					auth: "token",
					status: 200,
					response: list,
				},
				(fleet) => fleet.listTokens({}),
			),
		);
		ok(
			await exchange(
				{
					description: "revoke a bootstrap token",
					providerState: "one bootstrap token is outstanding",
					method: "DELETE",
					path: `/v1/fleet/tokens/${"a".repeat(64)}`,
					auth: "token",
					status: 200,
					response: toJsonString(TokenListSchema, create(TokenListSchema, {})),
				},
				(fleet) => fleet.revokeToken({ tokenHash: "a".repeat(64) }),
			),
		);
	});

	it("enrolls with a bare identity-key proof, declares with the person token", async () => {
		const enroll = create(EnrollmentRequestSchema, {
			tenant: "test",
			fleet: FLEET,
			name: "laptop",
			identityJwk: '{"kty":"EC","crv":"P-256","x":"AA","y":"AA"}',
			keyBundle: {
				context: "hobo-fleet/key-bundle/v1",
				keyId: `${MEMBER}#identity`,
				algorithm: KeyAlgorithm.ES256,
				payload: new Uint8Array([1]),
				signature: new Uint8Array([2]),
			},
			platform: { os: "linux", arch: "x64" },
			agentVersion: "1.0.0",
			deviceClass: DeviceClass.PERSONAL,
			requestedRoles: [Role.EXECUTOR],
			proof: { case: "bootstrapToken", value: `hft_${"A".repeat(43)}` },
		});
		const response = toJsonString(
			EnrollmentResponseSchema,
			create(EnrollmentResponseSchema, {
				memberRecord: {
					context: "hobo-fleet/member-record/v1",
					keyId: "authority#1",
					algorithm: KeyAlgorithm.EDDSA,
					payload: new Uint8Array([10, 3]),
					signature: new Uint8Array(64),
				},
				overlayJoins: [
					{
						provider: "tailscale",
						credential: "tskey-x",
						expiresAt: "2026-11-13T12:10:00.000Z",
					},
				],
				discovery: { tenant: "test", issuer: ORIGIN },
			}),
		);
		const enrolled = ok(
			await exchange(
				{
					description: "enroll a device with a bootstrap token",
					providerState:
						"a bootstrap token for fleet hobo, name laptop, is outstanding",
					method: "POST",
					path: "/v1/fleet/members",
					auth: "proof",
					body: json(EnrollmentRequestSchema, enroll),
					status: 200,
					response,
				},
				(fleet) => fleet.enroll(enroll),
			),
		);
		expect(enrolled.overlayJoins[0]?.provider).toBe("tailscale");

		const declare = create(DeclareRequestSchema, {
			tenant: "test",
			fleet: FLEET,
			kind: MemberKind.BACKEND,
			name: "cache-a",
			credentialRef: "secret://hobo/cache-a",
			endpointDigest: `sha256:${"b".repeat(64)}`,
		});
		// A declared backend runs no agent, so it is answered with no overlay join (D54).
		const declared = toJsonString(
			EnrollmentResponseSchema,
			create(EnrollmentResponseSchema, {
				memberRecord: {
					context: "hobo-fleet/member-record/v1",
					keyId: "authority#1",
					algorithm: KeyAlgorithm.EDDSA,
					payload: new Uint8Array([10, 3]),
					signature: new Uint8Array(64),
				},
				discovery: { tenant: "test", issuer: ORIGIN },
			}),
		);
		ok(
			await exchange(
				{
					description: "declare a sponsored backend",
					providerState: "fleet hobo exists and user:alice may declare",
					method: "POST",
					path: "/v1/fleet/members:declare",
					auth: "token",
					body: json(DeclareRequestSchema, declare),
					status: 200,
					response: declared,
				},
				(fleet) => fleet.declare(declare),
			),
		);
	});

	it("runs each lifecycle and membership command against the member's path", async () => {
		const routes = [
			["approveKey", "approve-key"],
			["accept", "accept"],
			["reject", "reject"],
			["suspend", "suspend"],
			["resume", "resume"],
			["unlock", "unlock"],
			["revoke", "revoke"],
		] as const;
		for (const [method, suffix] of routes) {
			const request = {
				memberId: MEMBER,
				request: create(LifecycleRequestSchema, {
					reason: "checked by a person",
					fleets: [FLEET],
				}),
			};
			ok(
				await exchange(
					{
						description: `${suffix} a member`,
						providerState: `member ${MEMBER} exists and user:alice may ${suffix}`,
						method: "POST",
						path: `/v1/fleet/members/${MEMBER}/${suffix}`,
						auth: "token",
						body: lifecycleBody,
						status: 200,
						response: SIGNED_MEMBER,
					},
					(fleet) => fleet[method](request),
				),
			);
		}
		const membership = create(MembershipRequestSchema, {
			fleet: "hobo-trunk",
			name: "laptop",
			roles: [Role.EXECUTOR],
		});
		ok(
			await exchange(
				{
					description: "add a membership in another fleet",
					providerState: `member ${MEMBER} is ACTIVE and fleet hobo-trunk exists`,
					method: "POST",
					path: `/v1/fleet/members/${MEMBER}/memberships`,
					auth: "token",
					body: json(MembershipRequestSchema, membership),
					status: 200,
					response: SIGNED_MEMBER,
				},
				(fleet) => fleet.assign({ memberId: MEMBER, request: membership }),
			),
		);
	});

	it("refreshes credentials with a bare SIGN-key proof, and reads the clone alarm", async () => {
		const request = create(CredentialRequestSchema, {
			generation: 3,
			refreshNonce: new Uint8Array(16).fill(7),
			agentVersion: "1.0.0",
		});
		const answered = ok(
			await exchange(
				{
					description: "refresh a device's credentials",
					providerState: `member ${MEMBER} is ACTIVE at generation 3`,
					method: "POST",
					path: `/v1/fleet/members/${MEMBER}/credentials`,
					auth: "proof",
					body: json(CredentialRequestSchema, request),
					status: 200,
					response: toJsonString(
						CredentialResponseSchema,
						create(CredentialResponseSchema, {
							svid: "eyJ.svid.token",
							svidExpiresAt: "2026-11-13T12:15:00.000Z",
							sessionTicket: {
								context: "hobo-fleet/session-ticket/v1",
								keyId: "authority#1",
								algorithm: KeyAlgorithm.EDDSA,
								payload: new Uint8Array([10, 1]),
								signature: new Uint8Array(64),
							},
							generation: 4,
						}),
					),
				},
				(fleet) => fleet.credentials({ memberId: MEMBER, request }),
			),
		);
		expect(answered.generation).toBe(4);

		const locked = await exchange(
			{
				description: "refresh at a generation the authority did not answer",
				providerState: `member ${MEMBER} is ACTIVE at generation 5`,
				method: "POST",
				path: `/v1/fleet/members/${MEMBER}/credentials`,
				auth: "proof",
				body: json(CredentialRequestSchema, request),
				status: 423,
				response: toJsonString(
					FleetErrorSchema,
					create(FleetErrorSchema, {
						code: "generation-mismatch",
						message: "the device is locked",
						detail: { generation: "5" },
					}),
				),
			},
			(fleet) => fleet.credentials({ memberId: MEMBER, request }),
		);
		expect(locked).toEqual({
			ok: false,
			error: {
				code: "generation-mismatch",
				message: "the device is locked",
				detail: { generation: "5" },
			},
		});

		const rotation = create(KeyRotationRequestSchema, {
			keyBundle: {
				context: "hobo-fleet/key-bundle/v1",
				keyId: `${MEMBER}#identity`,
				algorithm: KeyAlgorithm.ES256,
				payload: new Uint8Array([1]),
				signature: new Uint8Array([2]),
			},
		});
		ok(
			await exchange(
				{
					description: "replace a device's key bundle",
					providerState: `member ${MEMBER} is ACTIVE`,
					method: "POST",
					path: `/v1/fleet/members/${MEMBER}/keys`,
					auth: "token",
					body: json(KeyRotationRequestSchema, rotation),
					status: 200,
					response: SIGNED_MEMBER,
				},
				(fleet) => fleet.rotateKeys({ memberId: MEMBER, request: rotation }),
			),
		);
		ok(
			await exchange(
				{
					description: "a device leaves",
					providerState: `member ${MEMBER} is ACTIVE`,
					method: "POST",
					path: `/v1/fleet/members/${MEMBER}/leave`,
					auth: "token",
					status: 200,
					response: SIGNED_MEMBER,
				},
				(fleet) => fleet.leave({ memberId: MEMBER }),
			),
		);
	});

	it("reads members, fleets, views and verdicts, and defines a fleet", async () => {
		ok(
			await exchange(
				{
					description: "list the members of one fleet",
					providerState: "fleet hobo has members",
					method: "GET",
					path: "/v1/fleet/members?fleet=hobo",
					auth: "token",
					status: 200,
					response: toJsonString(
						MemberListSchema,
						create(MemberListSchema, {
							members: [
								{
									context: "hobo-fleet/member-record/v1",
									keyId: "authority#1",
								},
							],
						}),
					),
				},
				(fleet) => fleet.listMembers({ fleet: FLEET }),
			),
		);
		ok(
			await exchange(
				{
					description: "read one member",
					providerState: `member ${MEMBER} exists`,
					method: "GET",
					path: `/v1/fleet/members/${MEMBER}`,
					auth: "token",
					status: 200,
					response: SIGNED_MEMBER,
				},
				(fleet) => fleet.getMember({ memberId: MEMBER }),
			),
		);
		ok(
			await exchange(
				{
					description: "list fleets",
					providerState: "fleet hobo exists",
					method: "GET",
					path: "/v1/fleet/fleets",
					auth: "token",
					status: 200,
					response: toJsonString(
						FleetListSchema,
						create(FleetListSchema, {
							fleets: [{ context: "hobo-fleet/fleet-record/v1" }],
						}),
					),
				},
				(fleet) => fleet.listFleets({}),
			),
		);
		ok(
			await exchange(
				{
					description: "read one fleet",
					providerState: "fleet hobo exists",
					method: "GET",
					path: "/v1/fleet/fleets/hobo",
					auth: "token",
					status: 200,
					response: SIGNED_FLEET,
				},
				(fleet) => fleet.getFleet({ fleetId: FLEET }),
			),
		);
		const record = create(FleetRecordSchema, {
			fleetId: FLEET,
			tenant: "test",
			owner: "user:alice",
			policy: create(FleetPolicySchema, {
				keyBundleHours: 24,
				sessionPurposes: [SessionPurpose.SHELL],
			}),
		});
		ok(
			await exchange(
				{
					description: "define a fleet's policy",
					providerState: "user:alice may define fleets",
					method: "PUT",
					path: "/v1/fleet/fleets/hobo",
					auth: "token",
					body: json(FleetRecordSchema, record),
					status: 200,
					response: SIGNED_FLEET,
				},
				(fleet) => fleet.defineFleet(record),
			),
		);
		ok(
			await exchange(
				{
					description: "read a fleet's signed view",
					providerState: "fleet hobo has a view",
					method: "GET",
					path: "/v1/fleet/fleets/hobo/view",
					auth: "token",
					status: 200,
					response: envelopeJson("hobo-fleet/fleet-view/v1"),
				},
				(fleet) => fleet.fleetView({ fleetId: FLEET }),
			),
		);
		const verdict = ok(
			await exchange(
				{
					description: "read a fleet's verdict for a runner label",
					providerState: "fleet hobo has one live executor with a free slot",
					method: "GET",
					path: "/v1/fleet/fleets/hobo/verdict?label=hobo",
					auth: "token",
					status: 200,
					response: toJsonString(
						FleetVerdictSchema,
						create(FleetVerdictSchema, {
							fleet: FLEET,
							label: "hobo",
							state: VerdictState.OPEN,
							members: 1,
							freeSlots: 1,
						}),
					),
				},
				(fleet) => fleet.fleetVerdict({ fleetId: FLEET, label: "hobo" }),
			),
		);
		expect(verdict.state).toBe(VerdictState.OPEN);
	});

	it("grants sessions, submits and follows work, reports violations, reads the audit chain", async () => {
		const session = create(SessionRequestSchema, {
			peer: MEMBER,
			purpose: SessionPurpose.SHELL,
			orderId: "0".repeat(32),
			initiator: {
				principal: "user:alice",
				transportIdentity: "relay:AAAA",
				sealPublicKey: "AAAA",
			},
			ttlSeconds: 600,
		});
		ok(
			await exchange(
				{
					description: "grant a shell session into an order's sandbox",
					providerState: `member ${MEMBER} runs order ${"0".repeat(32)} in fleet hobo`,
					method: "POST",
					path: "/v1/fleet/sessions",
					auth: "token",
					body: json(SessionRequestSchema, session),
					status: 200,
					response: envelopeJson("hobo-fleet/session-grant/v1"),
				},
				(fleet) => fleet.grantSession(session),
			),
		);
		const work = create(WorkSubmissionRequestSchema, {
			fleet: FLEET,
			image: "docker.io/library/alpine",
			imageDigest: `sha256:${"c".repeat(64)}`,
			argv: ["echo", "hi"],
			ttlSeconds: 600,
		});
		const status = toJsonString(
			WorkStatusSchema,
			create(WorkStatusSchema, { submissionId: "sub_1" }),
		);
		expect(
			ok(
				await exchange(
					{
						description: "submit oci-command work",
						providerState:
							"fleet hobo allows oci-command and user:alice may submit",
						method: "POST",
						path: "/v1/fleet/work",
						auth: "token",
						body: json(WorkSubmissionRequestSchema, work),
						status: 200,
						response: status,
					},
					(fleet) => fleet.submitWork(work),
				),
			).submissionId,
		).toBe("sub_1");
		ok(
			await exchange(
				{
					description: "read submitted work's status",
					providerState: "submission sub_1 exists",
					method: "GET",
					path: "/v1/fleet/work/sub_1",
					auth: "token",
					status: 200,
					response: status,
				},
				(fleet) => fleet.workStatus({ submissionId: "sub_1" }),
			),
		);
		ok(
			await exchange(
				{
					description: "read submitted work's logs",
					providerState: "submission sub_1 has logged",
					method: "GET",
					path: "/v1/fleet/work/sub_1/logs",
					auth: "token",
					status: 200,
					response: toJsonString(WorkLogsSchema, create(WorkLogsSchema, {})),
				},
				(fleet) => fleet.workLogs({ submissionId: "sub_1" }),
			),
		);
		const report = create(ViolationReportSchema, {});
		ok(
			await exchange(
				{
					description: "a dispatcher reports a violation",
					providerState: `a dispatcher of fleet hobo holds an early claim of ${MEMBER}`,
					method: "POST",
					path: "/v1/fleet/reports",
					auth: "token",
					body: json(ViolationReportSchema, report),
					status: 200,
					response: SIGNED_MEMBER,
				},
				(fleet) => fleet.report(report),
			),
		);
		ok(
			await exchange(
				{
					description: "read audit checkpoints from a sequence",
					providerState: "the audit chain has checkpoints",
					method: "GET",
					path: "/v1/fleet/audit/checkpoints?from=1",
					auth: "token",
					status: 200,
					response: toJsonString(
						AuditCheckpointsSchema,
						create(AuditCheckpointsSchema, {}),
					),
				},
				(fleet) => fleet.auditCheckpoints({ fromSequence: 1 }),
			),
		);
		ok(
			await exchange(
				{
					description: "read audit entries in a range",
					providerState: "the audit chain has entries 1 to 10",
					method: "GET",
					path: "/v1/fleet/audit/entries?from=1&to=10",
					auth: "token",
					status: 200,
					response: toJsonString(
						AuditEntriesSchema,
						create(AuditEntriesSchema, {
							entries: [{ sequence: 1, eventType: "fleet.MemberActivated" }],
						}),
					),
				},
				(fleet) => fleet.auditEntries({ from: 1, to: 10 }),
			),
		);
	});

	it("reports a transport failure as unavailable and a non-FleetError body by its status", async () => {
		const down = createFleetClient({
			origin: ORIGIN,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			auth: undefined,
		});
		const failed = await down.authorityDiscovery({});
		expect(failed.ok ? undefined : failed.error.code).toBe("unavailable");
		const gateway = createFleetClient({
			origin: ORIGIN,
			fetch: async () =>
				new Response("<html>bad gateway</html>", { status: 502 }),
			auth: undefined,
		});
		const bad = await gateway.jwks({});
		expect(bad.ok ? undefined : bad.error.code).toBe("unavailable");
		const unparsable = createFleetClient({
			origin: ORIGIN,
			fetch: async () => new Response("not json", { status: 200 }),
			auth: undefined,
		});
		const parsed = await unparsable.authorityDiscovery({});
		expect(parsed.ok ? undefined : parsed.error.code).toBe("invalid-request");
	});
});
