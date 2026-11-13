// The narrower refusals and branches of enrollment, declaration, lifecycle,
// credentials and rotation, each in one line of setup.
import { create, toBinary } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ApprovalMode,
	AttestationTier,
	ClaimSchema,
	CredentialRequestSchema,
	DeclareRequestSchema,
	DeviceClass,
	KeyRotationRequestSchema,
	MemberKind,
	MemberState,
	MembershipRequestSchema,
	OidcTrustRuleSchema,
	Role,
	RotationStatementSchema,
	TokenCreateRequestSchema,
	ViolationReportSchema,
	WorkOfferSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	OFFER_CONTEXT,
	ROTATION_CONTEXT,
} from "../../src/contexts.js";
import { parseMemberId } from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type {
	IdentityAssertionVerifier,
	VerifiedToken,
} from "../../src/ports.js";
import {
	bundleFor,
	device,
	enrollment,
	type Harness,
	harness,
	OWNER,
	refresh,
	TENANT,
	why,
} from "./fixtures.js";
import {
	active,
	code,
	decoded,
	ids,
	pending,
	stateOf,
	token,
	value,
} from "./scenario.js";

async function setup(policy: Parameters<Harness["fleet"]>[1] = {}) {
	const h = await harness();
	await h.fleet("build", policy);
	await h.fleet("other", { allowedKinds: [MemberKind.DEVICE] });
	const admin = (await h.person({ kind: "user", id: "admin" })).caller;
	return { h, admin };
}

function oidc(
	subject: string,
	chain: "ok" | "fail" = "fail",
): IdentityAssertionVerifier {
	return {
		async verifyOidc(assertion) {
			return assertion === "bad"
				? { ok: false, error: { code: "unauthenticated", message: "bad" } }
				: {
						ok: true,
						value: {
							issuer: "https://issuer.test",
							subject,
							tokenId: assertion,
							claims: {},
						},
					};
		},
		verifyCertificateChain: () =>
			chain === "ok"
				? { ok: true, value: { digest: "sha256:chain" } }
				: {
						ok: false,
						error: { code: "unauthenticated", message: "untrusted chain" },
					},
	};
}

const sponsorRule = create(OidcTrustRuleSchema, {
	issuer: "https://issuer.test",
	subjectPattern: "relay-.*",
	sponsor: true,
});

describe("enrollment edges", () => {
	it("refuses malformed requests and tokens for another fleet, name or role", async () => {
		const { h, admin } = await setup();
		const subject = await device(h.clock.now());
		const issued = await token(h, admin);
		const enroll = (fields: Parameters<typeof enrollment>[1]) =>
			h.authority.enroll(enrollment(subject, fields), undefined).then(code);
		const proof = { case: "bootstrapToken" as const, value: issued };
		expect(await enroll({ tenant: "else", proof })).toBe("invalid-request");
		expect(await enroll({ identityJwk: "{}", proof })).toBe("invalid-request");
		expect(await enroll({ fleet: "other", proof })).toBe("invalid-request");
		expect(await enroll({ name: "else", proof })).toBe("invalid-request");
		expect(await enroll({ requestedRoles: [Role.DISPATCHER], proof })).toBe(
			"forbidden",
		);
		expect(
			await enroll({ proof: { case: "bootstrapToken", value: "nope" } }),
		).toBe("token-invalid");
		expect(await enroll({ proof: { case: undefined } })).toBe(
			"unauthenticated",
		);
		expect(await enroll({ keyBundle: undefined, proof })).toBe(
			"invalid-request",
		);
		const foreign = await device(h.clock.now());
		expect(await enroll({ keyBundle: foreign.bundle, proof })).toBe(
			"proof-invalid",
		);
		expect(
			await enroll({
				keyBundle: await bundleFor(subject.keys, h.clock.now(), {
					sequence: 0,
				}),
				proof,
			}),
		).toBe("invalid-request");
		expect(
			await enroll({
				keyBundle: await bundleFor(subject.keys, h.clock.now() + 3_600_000),
				proof,
			}),
		).toBe("invalid-request");
	});

	it("records T1 for a held key and T2 for a certified one, and refuses an untrusted chain", async () => {
		const h = await harness({ assertions: oidc("x", "ok") });
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const held = decoded(
			value(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						name: "held",
						heldKey: true,
						proof: {
							case: "bootstrapToken",
							value: await token(h, admin, "build", "held"),
						},
					}),
					undefined,
				),
			).memberRecord,
		);
		expect(held.attestationTier).toBe(AttestationTier.T1_HELD_KEY);
		const certified = decoded(
			value(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						name: "cert",
						certificateChainPem: ["-----BEGIN CERTIFICATE-----"],
						proof: {
							case: "bootstrapToken",
							value: await token(h, admin, "build", "cert"),
						},
					}),
					undefined,
				),
			).memberRecord,
		);
		expect(certified.attestationTier).toBe(AttestationTier.T2_ORG_CERTIFIED);
		expect(certified.attestationDigest).toBe("sha256:chain");

		const strict = await harness({ assertions: oidc("x", "fail") });
		await strict.fleet("build");
		const strictAdmin = (await strict.person({ kind: "user", id: "admin" }))
			.caller;
		expect(
			code(
				await strict.authority.enroll(
					enrollment(await device(strict.clock.now()), {
						certificateChainPem: ["-----BEGIN CERTIFICATE-----"],
						proof: {
							case: "bootstrapToken",
							value: await token(strict, strictAdmin),
						},
					}),
					undefined,
				),
			),
		).toBe("attestation-insufficient");
	});

	it("refuses an OIDC assertion that does not verify or matches no rule, and a fleet without policy rules", async () => {
		const h = await harness({ assertions: oidc("nobody") });
		await h.fleet("build");
		const subject = await device(h.clock.now());
		const via = (value: string, fleet = "build") =>
			h.authority
				.enroll(
					enrollment(subject, {
						fleet,
						proof: { case: "oidcAssertion", value },
					}),
					undefined,
				)
				.then(code);
		expect(await via("bad")).toBe("unauthenticated");
		expect(await via("good")).toBe("fleet-policy");
		expect(await via("good2", "missing")).toBe("fleet-unknown");
	});

	it("answers the same key's enrollment again, and refuses it for another fleet", async () => {
		const { h, admin } = await setup();
		const subject = await pending(h, admin);
		const again = await h.authority.enroll(
			enrollment(subject, {
				fleet: "",
				proof: { case: "bootstrapToken", value: "hft_x" },
			}),
			undefined,
		);
		expect(code(again)).toBe("ok");
		expect(
			code(
				await h.authority.enroll(
					enrollment(subject, {
						fleet: "other",
						proof: { case: "bootstrapToken", value: "hft_x" },
					}),
					undefined,
				),
			),
		).toBe("key-known");
	});

	it("refuses a person token for another tenant, and a governed enrollment the policy denies", async () => {
		const { h } = await setup();
		const subject = await device(h.clock.now());
		const key = { signer: subject.keys.identity, publicJwk: subject.identity };
		const plain = await h.person(OWNER, [], key);
		expect(
			code(
				await h.authority.enroll(
					enrollment(subject, {
						fleet: "build",
						proof: { case: "personToken", value: plain.token },
					}),
					plain.caller,
				),
			),
		).toBe("forbidden");
		const outsider = await h.issuer.issuePerson({
			principal: OWNER,
			tenant: parseTenantId("elsewhere"),
			tags: ["fleet-admin"],
			jkt: subject.thumbprint,
			ttlMs: 60_000,
		});
		expect(
			code(
				await h.authority.enroll(
					enrollment(subject, {
						fleet: "build",
						proof: { case: "personToken", value: outsider.token },
					}),
					undefined,
				),
			),
		).toBe("forbidden");
	});

	it("refuses tokens with a bad name, class or kind, and revoking an unknown token", async () => {
		const { h, admin } = await setup({
			allowedClasses: [DeviceClass.DEDICATED],
			allowedKinds: [MemberKind.BACKEND],
		});
		const issue = (
			fields: Partial<{ name: string; deviceClass: DeviceClass }>,
		) =>
			h.authority
				.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: "ok",
						ttlSeconds: 900,
						...fields,
					}),
					admin,
				)
				.then((result) =>
					result.ok ? "ok" : (result.error.detail?.rule ?? result.error.code),
				);
		expect(await issue({ name: "Not Valid" })).toBe("invalid-request");
		expect(await issue({})).toBe("allowed-kinds");
		expect(
			code(
				await h.authority.revokeToken(
					ids<"revokeToken">({ tokenHash: "0" }),
					admin,
				),
			),
		).toBe("token-invalid");
		const classes = await setup({ allowedClasses: [DeviceClass.DEDICATED] });
		expect(
			code(
				await classes.h.authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: "x",
						deviceClass: DeviceClass.PERSONAL,
						ttlSeconds: 900,
					}),
					classes.admin,
				),
			),
		).toBe("fleet-policy");
	});
});

describe("declaration edges", () => {
	it("refuses malformed declarations and unauthenticated or account callers", async () => {
		const { h, admin } = await setup();
		const declare = (
			fields: Record<string, string | number>,
			caller: VerifiedToken | undefined = admin,
		) =>
			h.authority
				.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind: MemberKind.BACKEND,
						name: "db",
						...fields,
					}),
					caller,
				)
				.then(code);
		expect(await declare({ tenant: "else" })).toBe("invalid-request");
		expect(await declare({ kind: MemberKind.DEVICE })).toBe("invalid-request");
		expect(await declare({ name: "Bad Name" })).toBe("invalid-request");
		expect(await declare({ endpointDigest: "md5:x" })).toBe("invalid-request");
		expect(await declare({ fleet: "missing" })).toBe("fleet-unknown");
		expect(await declare({ fleet: "other" })).toBe("fleet-policy");
		expect(
			code(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind: MemberKind.BACKEND,
						name: "db",
					}),
					undefined,
				),
			),
		).toBe("unauthenticated");
		const account: VerifiedToken = {
			kind: "account",
			principal: { kind: "service", id: "r" },
			tenant: TENANT,
			scopes: [],
		};
		expect(await declare({}, account)).toBe("forbidden");
		const elsewhere: VerifiedToken = {
			...account,
			tenant: parseTenantId("else"),
		};
		expect(await declare({}, elsewhere)).toBe("forbidden");
		value(
			await h.authority.declare(
				create(DeclareRequestSchema, {
					fleet: "build",
					kind: MemberKind.BACKEND,
					name: "db",
				}),
				admin,
			),
		);
		const rival = (await h.person({ kind: "user", id: "rival" })).caller;
		expect(await declare({}, rival)).toBe("name-taken");
	});

	it("lets an ACTIVE device and a matching workload sponsor, and refuses others", async () => {
		const h = await harness();
		await h.fleet("cache", {
			approval: ApprovalMode.AUTO_OWNER,
			oidcTrust: [sponsorRule],
		});
		const owner = (await h.person(OWNER)).caller;
		const relay = await active(h, owner, "cache", "relay", [Role.OBSERVER]);
		// The test engine allows by tag: the device's tags are its roles, so it is denied here.
		expect(
			code(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "redis",
					}),
					relay.caller,
				),
			),
		).toBe("forbidden");
		const workload = (subject: string): VerifiedToken => ({
			kind: "workload",
			issuer: "https://issuer.test",
			subject,
			repository: "",
			tenant: TENANT,
			expiresAtMs: h.clock.now() + 60_000,
		});
		const declared = decoded(
			value(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "kv",
					}),
					workload("relay-1"),
				),
			).memberRecord,
		);
		expect(declared.state).toBe(MemberState.ACTIVE);
		expect(declared.sponsor).toBe("service:https://issuer.test#relay-1");
		expect(
			code(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "kv2",
					}),
					workload("intruder"),
				),
			),
		).toBe("fleet-policy");
		const ghost: VerifiedToken = {
			...relay.caller,
			memberId: parseMemberId(`dev_${"0".repeat(32)}`),
		};
		expect(
			code(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "x",
					}),
					ghost,
				),
			),
		).toBe("member-unknown");
	});

	it("lets a device sponsor when policy allows it, approved at once for the fleet owner's device", async () => {
		const h = await harness({
			policy: {
				engineId: "e",
				evaluate: async (request) => ({
					effect: "allow",
					engineId: "e",
					reasons: [],
					audit: {
						decidedAt: "",
						tenantId: request.subject.tenantId,
						action: request.action,
						resourceKind: "",
						resourceId: "",
						subjectIdentity: "",
					},
				}),
			},
		});
		await h.fleet("cache", { approval: ApprovalMode.AUTO_OWNER });
		const owner = (await h.person(OWNER)).caller;
		const relay = await active(h, owner, "cache", "relay", [Role.OBSERVER]);
		const declared = decoded(
			value(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "redis",
					}),
					relay.caller,
				),
			).memberRecord,
		);
		expect(declared.state).toBe(MemberState.ACTIVE);
		expect(declared.sponsor).toBe(relay.keys.memberId);
		expect(declared.owner).toBe("user:owner");
		value(
			await h.authority.suspend(
				{ memberId: relay.keys.memberId, request: why() },
				owner,
			),
		);
		expect(
			code(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "cache",
						kind: MemberKind.BACKEND,
						name: "x",
					}),
					relay.caller,
				),
			),
		).toBe("forbidden");
	});

	it("counts declared members against the sponsor's quota", async () => {
		const { h, admin } = await setup({ memberQuotaPerPrincipal: 1 });
		const declare = (name: string) =>
			h.authority
				.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind: MemberKind.TARGET,
						name,
					}),
					admin,
				)
				.then(code);
		expect(await declare("a")).toBe("ok");
		expect(await declare("b")).toBe("quota-exceeded");
	});
});

describe("lifecycle edges", () => {
	it("refuses steps out of order and answers repeated ones with the current record", async () => {
		const { h, admin } = await setup();
		const subject = await pending(h, admin);
		const memberId = subject.keys.memberId;
		const step = (
			name:
				| "approveKey"
				| "accept"
				| "reject"
				| "suspend"
				| "resume"
				| "unlock",
		) => h.authority[name]({ memberId, request: why() }, admin).then(code);
		expect(await step("accept")).toBe("approval-pending");
		expect(await step("suspend")).toBe("invalid-request");
		expect(await step("resume")).toBe("invalid-request");
		expect(await step("unlock")).toBe("invalid-request");
		expect(await step("approveKey")).toBe("ok");
		expect(await step("approveKey")).toBe("ok");
		expect(await step("accept")).toBe("ok");
		expect(await step("accept")).toBe("ok");
		expect(await step("approveKey")).toBe("ok");
		expect(await step("reject")).toBe("invalid-request");
		expect(await step("suspend")).toBe("ok");
		expect(await step("suspend")).toBe("ok");
		const unknown = `dev_${"9".repeat(32)}`;
		expect(
			code(
				await h.authority.suspend({ memberId: unknown, request: why() }, admin),
			),
		).toBe("member-unknown");
		expect(
			code(
				await h.authority.suspend({ memberId: "nope", request: why() }, admin),
			),
		).toBe("member-unknown");
		expect(
			code(await h.authority.suspend({ memberId, request: why() }, undefined)),
		).toBe("unauthenticated");
		const rejected = await pending(h, admin, "build", "second");
		const second = rejected.keys.memberId;
		expect(
			code(
				await h.authority.reject({ memberId: second, request: why() }, admin),
			),
		).toBe("ok");
		expect(
			code(
				await h.authority.reject({ memberId: second, request: why() }, admin),
			),
		).toBe("ok");
		expect(
			code(
				await h.authority.revoke({ memberId: second, request: why() }, admin),
			),
		).toBe("ok");
		expect(
			code(
				await h.authority.revoke({ memberId: second, request: why() }, admin),
			),
		).toBe("ok");
	});

	it("accepts only the memberships named, and refuses an accept that grants none", async () => {
		const { h, admin } = await setup();
		const subject = await pending(h, admin);
		const memberId = subject.keys.memberId;
		value(await h.authority.approveKey({ memberId, request: why() }, admin));
		expect(
			code(
				await h.authority.accept(
					{ memberId, request: { ...why(), fleets: ["other"] } },
					admin,
				),
			),
		).toBe("invalid-request");
		const record = decoded(
			value(
				await h.authority.accept(
					{ memberId, request: { ...why(), fleets: ["build"] } },
					admin,
				),
			),
		);
		expect(record.memberships.map((m) => m.fleet)).toEqual(["build"]);
	});

	it("refuses approving an enrollment whose token has expired, and rejects it", async () => {
		const { h, admin } = await setup();
		const subject = await pending(h, admin);
		h.clock.advance(20 * 60_000);
		expect(
			code(
				await h.authority.approveKey(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			),
		).toBe("token-expired");
		expect((await stateOf(h, subject, admin)).state).toBe(MemberState.REJECTED);
		expect(
			code(
				await h.authority.accept(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			),
		).toBe("invalid-request");
	});

	it("refuses assignments outside policy or name rules, and repeats an identical one", async () => {
		const { h, admin } = await setup();
		await h.fleet("observers", { allowedRoles: [Role.OBSERVER] });
		const subject = await active(h, admin);
		const memberId = subject.keys.memberId;
		const assign = (
			fleet: string,
			name: string,
			roles: Role[] = [Role.OBSERVER],
		) =>
			h.authority
				.assign(
					{
						memberId,
						request: create(MembershipRequestSchema, { fleet, name, roles }),
					},
					admin,
				)
				.then((result) =>
					result.ok ? "ok" : (result.error.detail?.rule ?? result.error.code),
				);
		expect(await assign("Bad", "x")).toBe("invalid-request");
		expect(await assign("missing", "x")).toBe("fleet-unknown");
		expect(await assign("observers", "x", [Role.EXECUTOR])).toBe(
			"allowed-roles",
		);
		expect(await assign("observers", "x")).toBe("ok");
		expect(await assign("observers", "x")).toBe("ok");
		expect(await assign("observers", "y")).toBe("invalid-request");
		await pending(h, admin, "build", "taken");
		expect(await assign("other", "taken")).toBe("ok");
		const another = await active(h, admin, "build", "third");
		expect(
			code(
				await h.authority.assign(
					{
						memberId: another.keys.memberId,
						request: create(MembershipRequestSchema, {
							fleet: "other",
							name: "taken",
						}),
					},
					admin,
				),
			),
		).toBe("name-taken");
		const backend = decoded(
			value(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind: MemberKind.BACKEND,
						name: "db",
					}),
					admin,
				),
			).memberRecord,
		);
		value(
			await h.authority.approveKey(
				{ memberId: backend.memberId, request: why() },
				admin,
			),
		);
		value(
			await h.authority.accept(
				{ memberId: backend.memberId, request: why() },
				admin,
			),
		);
		expect(
			code(
				await h.authority.assign(
					{
						memberId: backend.memberId,
						request: create(MembershipRequestSchema, {
							fleet: "build",
							name: "db2",
							roles: [Role.EXECUTOR],
						}),
					},
					admin,
				),
			),
		).toBe("invalid-request");
		expect(
			code(
				await h.authority.assign(
					{
						memberId: "nope",
						request: create(MembershipRequestSchema, {
							fleet: "build",
							name: "z",
						}),
					},
					admin,
				),
			),
		).toBe("member-unknown");
		expect(
			code(
				await h.authority.assign(
					{
						memberId: `dev_${"8".repeat(32)}`,
						request: create(MembershipRequestSchema, {
							fleet: "build",
							name: "z",
						}),
					},
					admin,
				),
			),
		).toBe("member-unknown");
	});

	it("lets a device leave only for itself", async () => {
		const { h, admin } = await setup();
		const a = await active(h, admin, "build", "a");
		const b = await active(h, admin, "build", "b");
		expect(
			code(
				await h.authority.leave(
					ids<"leave">({ memberId: b.keys.memberId }),
					a.caller,
				),
			),
		).toBe("forbidden");
		expect(
			code(
				await h.authority.leave(
					ids<"leave">({ memberId: a.keys.memberId }),
					admin,
				),
			),
		).toBe("unauthenticated");
	});
});

describe("report edges", () => {
	async function scene(
		verdict: () => Promise<"valid" | "discard" | "not-entitled" | "early">,
	) {
		const h = await harness({ checkClaim: verdict });
		await h.fleet("build");
		await h.fleet("other");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const dispatcher = await active(h, admin, "build", "box", [
			Role.DISPATCHER,
		]);
		const executor = await active(h, admin, "build", "laptop");
		const offer = (
			fleet = "build",
			digest = "b".repeat(32),
			by: string = dispatcher.keys.memberId,
		) =>
			signEnvelope(
				dispatcher.keys.sign,
				OFFER_CONTEXT,
				toBinary(
					WorkOfferSchema,
					create(WorkOfferSchema, {
						fleet,
						workDigest: digest,
						dispatcher: by,
					}),
				),
			);
		const claim = (at = "2026-11-01T10:00:00.000Z", fleet = "build") =>
			signEnvelope(
				executor.keys.sign,
				CLAIM_CONTEXT,
				toBinary(
					ClaimSchema,
					create(ClaimSchema, {
						fleet,
						workDigest: "b".repeat(32),
						memberId: executor.keys.memberId,
						dispatcher: dispatcher.keys.memberId,
						claimedAt: at,
					}),
				),
			);
		return { h, admin, dispatcher, executor, offer, claim };
	}

	it("refuses unknown kinds, wrong counts, foreign offers and checkClaim failures", async () => {
		const { h, dispatcher, offer, claim } = await scene(async () => {
			throw new Error("rules down");
		});
		const send = async (
			fields: Parameters<typeof create<typeof ViolationReportSchema>>[1],
		) =>
			code(
				await h.authority.report(
					create(ViolationReportSchema, fields),
					dispatcher.caller,
				),
			);
		expect(
			await send({
				kind: "other",
				offer: await offer(),
				claims: [await claim()],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer(),
				claims: [],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer("build", "b".repeat(32), "someone-else"),
				claims: [await claim()],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer("other"),
				claims: [await claim()],
			}),
		).toBe("forbidden");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer("build", "not-a-digest"),
				claims: [await claim()],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer(),
				claims: [await claim("x", "other")],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-early",
				offer: await offer(),
				claims: [await claim(), await claim(), await claim()],
			}),
		).toBe("evidence-invalid");
		expect(
			await send({
				kind: "claim-not-entitled",
				offer: await offer(),
				claims: [await claim()],
			}),
		).toBe("unavailable");
		expect(
			code(
				await h.authority.report(create(ViolationReportSchema, {}), undefined),
			),
		).toBe("unauthenticated");
	});

	it("records a second violation without suspending twice", async () => {
		const { h, admin, dispatcher, executor, offer, claim } = await scene(
			async () => "not-entitled",
		);
		const report = async () =>
			decoded(
				value(
					await h.authority.report(
						create(ViolationReportSchema, {
							kind: "claim-not-entitled",
							offer: await offer(),
							claims: [await claim()],
						}),
						dispatcher.caller,
					),
				),
			).state;
		expect(await report()).toBe(MemberState.SUSPENDED);
		expect(await report()).toBe(MemberState.SUSPENDED);
		expect((await stateOf(h, executor, admin)).recordSequence).toBe(5);
		value(
			await h.authority.suspend(
				{ memberId: dispatcher.keys.memberId, request: why() },
				admin,
			),
		);
		expect(
			code(
				await h.authority.report(
					create(ViolationReportSchema, { kind: "claim-not-entitled" }),
					dispatcher.caller,
				),
			),
		).toBe("member-suspended");
	});
});

describe("credentials and rotation edges", () => {
	it("renews the key bundle with a refresh, and refuses a bad renewal", async () => {
		const { h, admin } = await setup();
		const subject = await active(h, admin);
		const memberId = subject.keys.memberId;
		const renewed = await bundleFor(subject.keys, h.clock.now(), {
			sequence: 2,
		});
		const answer = value(
			await h.authority.credentials(
				{
					memberId,
					request: create(CredentialRequestSchema, {
						...refresh(0),
						keyBundle: renewed,
						audiences: ["https://feed.test"],
					}),
				},
				subject.caller,
			),
		);
		expect(decoded(answer.memberRecord).keyBundle?.signature).toEqual(
			renewed.signature,
		);
		expect(answer.trust).toBeDefined();
		expect(answer.sessionTicket?.context).toBe("hobo-fleet/session-ticket/v1");
		const stale = await bundleFor(subject.keys, h.clock.now(), { sequence: 1 });
		expect(
			code(
				await h.authority.credentials(
					{
						memberId,
						request: create(CredentialRequestSchema, {
							...refresh(1),
							keyBundle: stale,
						}),
					},
					subject.caller,
				),
			),
		).toBe("invalid-request");
		expect(
			code(
				await h.authority.credentials(
					{
						memberId,
						request: create(CredentialRequestSchema, {
							...refresh(1),
							agentVersion: "0.1.0",
						}),
					},
					subject.caller,
				),
			),
		).toBe("agent-outdated");
	});

	it("refuses credentials for another member, a sponsored member and an unknown one", async () => {
		const { h, admin } = await setup();
		const a = await active(h, admin, "build", "a");
		const b = await active(h, admin, "build", "b");
		expect(
			code(
				await h.authority.credentials(
					{ memberId: b.keys.memberId, request: refresh(0) },
					a.caller,
				),
			),
		).toBe("forbidden");
		expect(
			code(
				await h.authority.credentials(
					{ memberId: a.keys.memberId, request: refresh(0) },
					undefined,
				),
			),
		).toBe("unauthenticated");
		const backend = decoded(
			value(
				await h.authority.declare(
					create(DeclareRequestSchema, {
						fleet: "build",
						kind: MemberKind.BACKEND,
						name: "db",
					}),
					admin,
				),
			).memberRecord,
		);
		const posing: VerifiedToken = {
			...a.caller,
			memberId: parseMemberId(backend.memberId),
		};
		expect(
			code(
				await h.authority.credentials(
					{ memberId: backend.memberId, request: refresh(0) },
					posing,
				),
			),
		).toBe("forbidden");
		const ghost = `dev_${"7".repeat(32)}`;
		const unknown: VerifiedToken = {
			...a.caller,
			memberId: parseMemberId(ghost),
		};
		expect(
			code(
				await h.authority.credentials(
					{ memberId: ghost, request: refresh(0) },
					unknown,
				),
			),
		).toBe("member-unknown");
	});

	it("answers a repeated rotation with the current record and refuses bad statements", async () => {
		const { h, admin } = await setup();
		const subject = await active(h, admin);
		const memberId = subject.keys.memberId;
		const bundle = await bundleFor(subject.keys, h.clock.now(), {
			sequence: 2,
		});
		const rotate = async (
			request: Parameters<typeof create<typeof KeyRotationRequestSchema>>[1],
			caller: VerifiedToken = subject.caller,
		) =>
			code(
				await h.authority.rotateKeys(
					{ memberId, request: create(KeyRotationRequestSchema, request) },
					caller,
				),
			);
		expect(await rotate({ keyBundle: bundle })).toBe("ok");
		expect(await rotate({ keyBundle: bundle })).toBe("ok");
		expect(
			await rotate({ keyBundle: bundle }, { ...subject.caller, jkt: "x" }),
		).toBe("proof-invalid");
		const statement = (
			fields: Partial<{ memberId: string; newIdentityJwk: string }>,
		) =>
			signEnvelope(
				subject.keys.identity,
				ROTATION_CONTEXT,
				toBinary(
					RotationStatementSchema,
					create(RotationStatementSchema, { memberId, ...fields }),
				),
			);
		expect(
			await rotate({
				keyBundle: await bundleFor(subject.keys, h.clock.now(), {
					sequence: 3,
				}),
				rotation: await statement({ memberId: "dev_other" }),
			}),
		).toBe("invalid-request");
		expect(
			await rotate({
				keyBundle: await bundleFor(subject.keys, h.clock.now(), {
					sequence: 3,
				}),
				rotation: await statement({ newIdentityJwk: "{}" }),
			}),
		).toBe("invalid-request");
		// A new identity key that another member already holds.
		const other = await active(h, admin, "build", "other");
		const stolen = await rotate({
			keyBundle: await bundleFor(subject.keys, h.clock.now(), {
				sequence: 3,
				identity: other.keys.identity,
			}),
			rotation: await statement({ newIdentityJwk: other.keys.identityJwk }),
		});
		expect(stolen).toBe("key-known");
		value(await h.authority.suspend({ memberId, request: why() }, admin));
		expect(
			await rotate({
				keyBundle: await bundleFor(subject.keys, h.clock.now(), {
					sequence: 4,
				}),
			}),
		).toBe("member-suspended");
	});
});
