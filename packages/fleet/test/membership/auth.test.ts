// authenticate for the four VerifiedToken kinds; a self-minted token is
// refused on every route; reads, discovery and the routing to AuthorityParts.

import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AuditEntrySchema,
	MemberState,
	Role,
	SessionRequestSchema,
	SignInStartSchema,
	TokenCreateRequestSchema,
} from "../../src/_generated/fleet_pb.js";
import { parseFleetId } from "../../src/ids.js";
import { generateDpopKey, mintDpopProof } from "../../src/keys/index.js";
import type {
	EnrollmentAuthority,
	FleetApi,
	VerifiedToken,
} from "../../src/ports.js";
import {
	device,
	dpopFor,
	enrollment,
	harness,
	ISSUER,
	OWNER,
	refresh,
	TENANT,
	why,
} from "./fixtures.js";
import { active, code, decoded, ids, pending, value } from "./scenario.js";

const ID = `dev_${"1".repeat(32)}`;

/** Every route of §6.15, one per FleetApi method. */
const ROUTES = {
	authorityDiscovery: ["GET", "/.well-known/hobo-fleet"],
	discovery: ["GET", "/v1/fleet/tenants/acme/discovery"],
	jwks: ["GET", "/v1/fleet/jwks"],
	signInStart: ["POST", "/v1/fleet/signin/start"],
	signInCallback: ["GET", "/v1/fleet/signin/callback"],
	signInDevice: ["POST", "/v1/fleet/signin/device"],
	approval: ["GET", "/v1/fleet/approve/s"],
	approve: ["POST", "/v1/fleet/approve/s"],
	signInComplete: ["POST", "/v1/fleet/signin/complete"],
	signInPoll: ["POST", "/v1/fleet/signin/device/poll"],
	signInRefresh: ["POST", "/v1/fleet/signin/refresh"],
	issueToken: ["POST", "/v1/fleet/tokens"],
	listTokens: ["GET", "/v1/fleet/tokens"],
	revokeToken: ["DELETE", "/v1/fleet/tokens/abc"],
	enroll: ["POST", "/v1/fleet/members"],
	declare: ["POST", "/v1/fleet/members:declare"],
	approveKey: ["POST", `/v1/fleet/members/${ID}/approve-key`],
	accept: ["POST", `/v1/fleet/members/${ID}/accept`],
	reject: ["POST", `/v1/fleet/members/${ID}/reject`],
	suspend: ["POST", `/v1/fleet/members/${ID}/suspend`],
	resume: ["POST", `/v1/fleet/members/${ID}/resume`],
	unlock: ["POST", `/v1/fleet/members/${ID}/unlock`],
	revoke: ["POST", `/v1/fleet/members/${ID}/revoke`],
	assign: ["POST", `/v1/fleet/members/${ID}/memberships`],
	credentials: ["POST", `/v1/fleet/members/${ID}/credentials`],
	rotateKeys: ["POST", `/v1/fleet/members/${ID}/keys`],
	leave: ["POST", `/v1/fleet/members/${ID}/leave`],
	listMembers: ["GET", "/v1/fleet/members"],
	getMember: ["GET", `/v1/fleet/members/${ID}`],
	listFleets: ["GET", "/v1/fleet/fleets"],
	getFleet: ["GET", "/v1/fleet/fleets/build"],
	defineFleet: ["PUT", "/v1/fleet/fleets/build"],
	fleetView: ["GET", "/v1/fleet/fleets/build/view"],
	fleetVerdict: ["GET", "/v1/fleet/fleets/build/verdict"],
	grantSession: ["POST", "/v1/fleet/sessions"],
	submitWork: ["POST", "/v1/fleet/work"],
	workStatus: ["GET", "/v1/fleet/work/w"],
	workLogs: ["GET", "/v1/fleet/work/w/logs"],
	report: ["POST", "/v1/fleet/reports"],
	auditCheckpoints: ["GET", "/v1/fleet/audit/checkpoints"],
	auditEntries: ["GET", "/v1/fleet/audit/entries"],
} satisfies Readonly<Record<keyof FleetApi, readonly [string, string]>>;

describe("authenticate", () => {
	it("refuses a self-minted person or member token on every route", async () => {
		const h = await harness();
		const other = await harness();
		const forged = await other.person(OWNER, ["fleet-admin", "auditor"]);
		for (const [method, path] of Object.values(ROUTES)) {
			const url = `${ISSUER}${path}`;
			const dpop = await mintDpopProof(
				forged.key.signer,
				forged.key.publicJwk,
				{
					htm: method,
					htu: url,
					accessToken: forged.token,
					nowMs: h.clock.now(),
				},
			);
			const result = await h.authority.authenticate({
				method,
				url,
				authorization: `DPoP ${forged.token}`,
				dpop,
			});
			expect(code(result), path).toBe("unauthenticated");
		}
	});

	it("refuses every authenticated route without a caller", async () => {
		const h = await harness();
		await h.fleet("build");
		const open: readonly (keyof FleetApi)[] = [
			"authorityDiscovery",
			"discovery",
			"jwks",
		];
		const authority: EnrollmentAuthority = h.authority;
		const empty = {
			memberId: ID,
			tokenHash: "abc",
			fleetId: "build",
			submissionId: "w",
			state: "s",
			tenant: TENANT,
			label: "x",
			from: 0,
			to: 1,
			request: why(),
		};
		// SAFETY: ROUTES is typed as a record over exactly the FleetApi method names.
		for (const name of Object.keys(ROUTES) as (keyof FleetApi)[]) {
			if (open.includes(name)) continue;
			// SAFETY: each method reads only the fields of its own request; `empty` carries every id field any route reads.
			const method = authority[name] as (
				r: typeof empty,
				c: undefined,
			) => ReturnType<EnrollmentAuthority["jwks"]>;
			const result = await method(empty, undefined);
			expect(result.ok, name).toBe(false);
		}
	});

	it("accepts a person token with its DPoP proof, once", async () => {
		const h = await harness();
		const person = await h.person(OWNER);
		const url = `${ISSUER}/v1/fleet/tokens`;
		const dpop = await mintDpopProof(person.key.signer, person.key.publicJwk, {
			htm: "GET",
			htu: url,
			accessToken: person.token,
			nowMs: h.clock.now(),
		});
		const request = {
			method: "GET",
			url,
			authorization: `DPoP ${person.token}`,
			dpop,
		};
		const verified = value(await h.authority.authenticate(request));
		expect(verified.kind).toBe("person");
		expect(code(await h.authority.authenticate(request))).toBe(
			"proof-replayed",
		);
		expect(code(await h.authority.authenticate({ ...request, dpop: "" }))).toBe(
			"proof-invalid",
		);
	});

	it("refuses a person token whose proof is made with another key", async () => {
		const h = await harness();
		const person = await h.person(OWNER);
		const thief = await h.person(OWNER);
		const url = `${ISSUER}/v1/fleet/tokens`;
		const dpop = await mintDpopProof(thief.key.signer, thief.key.publicJwk, {
			htm: "GET",
			htu: url,
			accessToken: person.token,
			nowMs: h.clock.now(),
		});
		expect(
			code(
				await h.authority.authenticate({
					method: "GET",
					url,
					authorization: `DPoP ${person.token}`,
					dpop,
				}),
			),
		).toBe("proof-invalid");
	});

	it("authenticates a device by its SIGN key proof, then by its SVID, and stops at revocation", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const laptop = await active(h, admin);
		const memberId = laptop.keys.memberId;
		const url = `${ISSUER}/v1/fleet/members/${memberId}/credentials`;
		const proofOnly = value(
			await h.authority.authenticate({
				method: "POST",
				url,
				authorization: "",
				dpop: await dpopFor(laptop, "POST", url, h.clock.now()),
			}),
		);
		expect(proofOnly).toMatchObject({
			kind: "member",
			memberId,
			jkt: laptop.caller.kind === "member" ? laptop.caller.jkt : "",
		});
		const issued = value(
			await h.authority.credentials(
				{ memberId, request: refresh(0, new Uint8Array(randomBytes(16))) },
				proofOnly,
			),
		);
		const readUrl = `${ISSUER}/v1/fleet/members`;
		const svidRequest = async () => ({
			method: "GET",
			url: readUrl,
			authorization: `DPoP ${issued.svid}`,
			dpop: await dpopFor(laptop, "GET", readUrl, h.clock.now(), issued.svid),
		});
		const svid = value(await h.authority.authenticate(await svidRequest()));
		expect(svid.kind).toBe("member");
		value(await h.authority.listMembers({}, svid));
		value(await h.authority.revoke({ memberId, request: why() }, admin));
		expect(code(await h.authority.authenticate(await svidRequest()))).toBe(
			"member-revoked",
		);
		// A proof by a key that is no enrolled SIGN key authenticates nobody.
		const stranger = generateDpopKey();
		expect(
			code(
				await h.authority.authenticate({
					method: "POST",
					url,
					authorization: "",
					dpop: await mintDpopProof(stranger.signer, stranger.publicJwk, {
						htm: "POST",
						htu: url,
						nowMs: h.clock.now(),
					}),
				}),
			),
		).toBe("unauthenticated");
	});

	it("maps an account credential and a workload token", async () => {
		const h = await harness({
			assertions: {
				async verifyOidc(assertion) {
					return assertion === "gha"
						? {
								ok: true,
								value: {
									issuer: "https://token.actions.githubusercontent.com",
									subject: "repo:acme/app:ref:refs/heads/main",
									tokenId: "t",
									claims: { repository: "acme/app", exp: "4102444800" },
								},
							}
						: { ok: false, error: { code: "unauthenticated", message: "no" } };
				},
				verifyCertificateChain: () => ({
					ok: false,
					error: { code: "unauthenticated", message: "no" },
				}),
			},
		});
		const base = {
			method: "GET",
			url: `${ISSUER}/v1/fleet/fleets/build/verdict`,
			dpop: "",
		};
		expect(
			value(
				await h.authority.authenticate({
					...base,
					authorization: "Bearer account-ok",
				}),
			),
		).toMatchObject({
			kind: "account",
			scopes: ["read"],
		});
		expect(
			value(
				await h.authority.authenticate({
					...base,
					authorization: "Bearer gha",
				}),
			),
		).toMatchObject({
			kind: "workload",
			repository: "acme/app",
			expiresAtMs: 4_102_444_800_000,
		});
		expect(
			code(
				await h.authority.authenticate({
					...base,
					authorization: "Bearer nope",
				}),
			),
		).toBe("unauthenticated");
		expect(
			code(await h.authority.authenticate({ ...base, authorization: "" })),
		).toBe("unauthenticated");
	});
});

describe("reads, discovery and routing", () => {
	it("serves discovery and JWKS without a caller", async () => {
		const h = await harness();
		const discovery = value(
			await h.authority.discovery({ tenant: TENANT }, undefined),
		);
		expect(discovery.natsUrls).toEqual(["nats://bus.test:4222"]);
		expect(discovery.trust?.authority).toBeDefined();
		expect(
			code(
				await h.authority.discovery(
					{ tenant: parseTenantId("else") },
					undefined,
				),
			),
		).toBe("invalid-request");
		expect(
			value(await h.authority.authorityDiscovery({}, undefined))
				.signInProviders,
		).toEqual(["test"]);
		expect(
			JSON.parse(value(await h.authority.jwks({}, undefined)).jwks).keys,
		).toHaveLength(1);
	});

	it("lists members by fleet for readers, and audit entries only for auditors", async () => {
		const h = await harness();
		await h.fleet("build");
		await h.fleet("other");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		await active(h, admin, "build", "a");
		await pending(h, admin, "other", "b");
		const all = value(await h.authority.listMembers({}, admin)).members.map(
			decoded,
		);
		expect(all).toHaveLength(2);
		const build = value(
			await h.authority.listMembers({ fleet: parseFleetId("build") }, admin),
		).members.map(decoded);
		expect(build.map((m) => m.state)).toEqual([MemberState.ACTIVE]);
		const account: VerifiedToken = {
			kind: "account",
			principal: { kind: "service", id: "relay" },
			tenant: TENANT,
			scopes: [],
		};
		expect(
			value(await h.authority.listMembers({}, account)).members,
		).toHaveLength(2);

		expect(
			code(await h.authority.auditEntries({ from: 0, to: 10 }, admin)),
		).toBe("forbidden");
		const auditor = (
			await h.person({ kind: "user", id: "auditor" }, ["auditor"])
		).caller;
		await h.bus.audit.append(
			create(AuditEntrySchema, { sequence: 1, eventType: "fleet.TokenIssued" }),
		);
		expect(
			value(await h.authority.auditEntries({ from: 1, to: 1 }, auditor))
				.entries,
		).toHaveLength(1);
		expect(
			value(await h.authority.auditCheckpoints({}, auditor)).checkpoints,
		).toEqual([]);
		expect(
			code(await h.authority.auditEntries({ from: 3, to: 1 }, auditor)),
		).toBe("invalid-request");
	});

	it("routes fleets, work and sign-in to the parts, and tick to projection and audit", async () => {
		const h = await harness();
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		await h.authority.listFleets({}, admin);
		await h.authority.fleetVerdict({ fleetId: "build", label: "x" }, admin);
		await h.authority.grantSession(create(SessionRequestSchema, {}), admin);
		expect(h.calls.fleets).toEqual([
			"listFleets",
			"fleetVerdict",
			"grantSession",
		]);
		expect(
			code(
				await h.authority.workStatus(
					ids<"workStatus">({ submissionId: "w" }),
					admin,
				),
			),
		).toBe("unavailable");
		expect(
			code(
				await h.authority.signInStart(create(SignInStartSchema, {}), undefined),
			),
		).toBe("unavailable");
		await h.authority.tick();
		expect(h.calls.ticks).toEqual(["projection", "audit"]);
	});

	it("lists and revokes tokens; a revoked token cannot enroll", async () => {
		const h = await harness();
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const issued = value(
			await h.authority.issueToken(
				create(TokenCreateRequestSchema, {
					fleet: "build",
					name: "x",
					roles: [Role.EXECUTOR],
					ttlSeconds: 900,
				}),
				admin,
			),
		);
		const listed = value(await h.authority.listTokens({}, admin)).tokens;
		expect(listed.map((t) => t.tokenHash)).toEqual([issued.tokenHash]);
		expect(
			value(
				await h.authority.revokeToken(
					ids<"revokeToken">({ tokenHash: issued.tokenHash }),
					admin,
				),
			).tokens,
		).toEqual([]);
		expect(
			code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						name: "x",
						proof: { case: "bootstrapToken", value: issued.token },
					}),
					undefined,
				),
			),
		).toBe("token-invalid");
	});
});
