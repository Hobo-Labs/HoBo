// One table case per transition of the member state machine (§6.5) and one
// per refusal code of §7.6 that the enrollment authority answers.
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { OptimisticSequenceConflictError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AttestationTier,
	ClaimSchema,
	DeclareRequestSchema,
	KeyRotationRequestSchema,
	MemberKind,
	MemberState,
	MembershipRequestSchema,
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
import { FLEET_ERROR_CODES, type FleetErrorCode } from "../../src/errors.js";
import {
	generateDpopKey,
	jwkThumbprint,
	signEnvelope,
} from "../../src/keys/index.js";
import type { FleetEventStore } from "../../src/ports.js";
import { createMemoryEventStore } from "../../src/testing/plumbing/index.js";
import {
	bundleFor,
	device,
	enrollment,
	type Harness,
	harness,
	refresh,
	why,
} from "./fixtures.js";
import {
	active,
	code,
	decoded,
	pending,
	stateOf,
	token,
	value,
} from "./scenario.js";

const DAY_MS = 24 * 3_600_000;

async function setup(policy: Parameters<Harness["fleet"]>[1] = {}) {
	const h = await harness();
	await h.fleet("build", policy);
	await h.fleet("other");
	const admin = await h.person({ kind: "user", id: "admin" });
	return { h, admin: admin.caller };
}

type Transition = Readonly<{
	name: string;
	run(): Promise<Readonly<{ from: MemberState | "none"; to: MemberState }>>;
}>;

const transitions: readonly Transition[] = [
	{
		name: "enroll: none → PENDING",
		async run() {
			const { h, admin } = await setup();
			const subject = await pending(h, admin);
			return { from: "none", to: (await stateOf(h, subject, admin)).state };
		},
	},
	{
		name: "declare: none → PENDING (SINGLE)",
		async run() {
			const { h, admin } = await setup();
			const record = decoded(
				value(
					await h.authority.declare(
						create(DeclareRequestSchema, {
							fleet: "build",
							kind: MemberKind.TARGET,
							name: "web",
						}),
						admin,
					),
				).memberRecord,
			);
			return { from: "none", to: record.state };
		},
	},
	{
		name: "approve-key: PENDING → PENDING (key approved)",
		async run() {
			const { h, admin } = await setup();
			const subject = await pending(h, admin);
			const record = decoded(
				value(
					await h.authority.approveKey(
						{ memberId: subject.keys.memberId, request: why() },
						admin,
					),
				),
			);
			expect(record.keyApprovedBy).toBe("user:admin");
			return { from: MemberState.PENDING, to: record.state };
		},
	},
	{
		name: "accept: PENDING → ACTIVE",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			return {
				from: MemberState.PENDING,
				to: (await stateOf(h, subject, admin)).state,
			};
		},
	},
	{
		name: "reject: PENDING → REJECTED",
		async run() {
			const { h, admin } = await setup();
			const subject = await pending(h, admin);
			const record = decoded(
				value(
					await h.authority.reject(
						{ memberId: subject.keys.memberId, request: why("no") },
						admin,
					),
				),
			);
			expect(record.stateReason).toBe("no");
			return { from: MemberState.PENDING, to: record.state };
		},
	},
	{
		name: "token expiry: PENDING → REJECTED (tick)",
		async run() {
			const { h, admin } = await setup();
			const subject = await pending(h, admin);
			h.clock.advance(16 * 60_000);
			await h.authority.tick();
			const record = await stateOf(h, subject, admin);
			expect(record.stateReason).toBe("token-expired");
			expect(h.calls.ticks).toEqual(["projection", "audit"]);
			return { from: MemberState.PENDING, to: record.state };
		},
	},
	{
		name: "suspend: ACTIVE → SUSPENDED",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const record = decoded(
				value(
					await h.authority.suspend(
						{ memberId: subject.keys.memberId, request: why() },
						admin,
					),
				),
			);
			return { from: MemberState.ACTIVE, to: record.state };
		},
	},
	{
		name: "resume: SUSPENDED → ACTIVE",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const memberId = subject.keys.memberId;
			value(await h.authority.suspend({ memberId, request: why() }, admin));
			const record = decoded(
				value(await h.authority.resume({ memberId, request: why() }, admin)),
			);
			return { from: MemberState.SUSPENDED, to: record.state };
		},
	},
	{
		name: "clone detected: ACTIVE → LOCKED",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const memberId = subject.keys.memberId;
			expect(
				code(
					await h.authority.credentials(
						{ memberId, request: refresh(3) },
						subject.caller,
					),
				),
			).toBe("generation-mismatch");
			return {
				from: MemberState.ACTIVE,
				to: (await stateOf(h, subject, admin)).state,
			};
		},
	},
	{
		name: "unlock: LOCKED → ACTIVE, generation reset",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const memberId = subject.keys.memberId;
			value(
				await h.authority.credentials(
					{ memberId, request: refresh(0) },
					subject.caller,
				),
			);
			await h.authority.credentials(
				{ memberId, request: refresh(0) },
				subject.caller,
			);
			const record = decoded(
				value(await h.authority.unlock({ memberId, request: why() }, admin)),
			);
			const again = value(
				await h.authority.credentials(
					{ memberId, request: refresh(0) },
					subject.caller,
				),
			);
			expect(again.generation).toBe(1);
			return { from: MemberState.LOCKED, to: record.state };
		},
	},
	...[
		MemberState.PENDING,
		MemberState.ACTIVE,
		MemberState.SUSPENDED,
		MemberState.LOCKED,
	].map(
		(from): Transition => ({
			name: `revoke: ${MemberState[from]} → REVOKED`,
			async run() {
				const { h, admin } = await setup();
				const subject =
					from === MemberState.PENDING
						? await pending(h, admin)
						: await active(h, admin);
				const memberId = subject.keys.memberId;
				if (from === MemberState.SUSPENDED)
					value(await h.authority.suspend({ memberId, request: why() }, admin));
				if (from === MemberState.LOCKED)
					await h.authority.credentials(
						{ memberId, request: refresh(9) },
						subject.caller,
					);
				expect((await stateOf(h, subject, admin)).state).toBe(from);
				const record = decoded(
					value(await h.authority.revoke({ memberId, request: why() }, admin)),
				);
				return { from, to: record.state };
			},
		}),
	),
	{
		name: "leave: ACTIVE → REVOKED (the device itself)",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const record = decoded(
				value(
					await h.authority.leave(
						{ memberId: subject.keys.memberId },
						subject.caller,
					),
				),
			);
			return { from: MemberState.ACTIVE, to: record.state };
		},
	},
	{
		name: "assign: ACTIVE → ACTIVE with a second membership",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const record = decoded(
				value(
					await h.authority.assign(
						{
							memberId: subject.keys.memberId,
							request: create(MembershipRequestSchema, {
								fleet: "other",
								name: "laptop",
								roles: [Role.OBSERVER],
							}),
						},
						admin,
					),
				),
			);
			expect(record.memberships.map((m) => m.fleet)).toEqual([
				"build",
				"other",
			]);
			return { from: MemberState.ACTIVE, to: record.state };
		},
	},
	{
		name: "rotate key bundle: ACTIVE → ACTIVE",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const bundle = await bundleFor(subject.keys, h.clock.now(), {
				sequence: 2,
			});
			const record = decoded(
				value(
					await h.authority.rotateKeys(
						{
							memberId: subject.keys.memberId,
							request: create(KeyRotationRequestSchema, { keyBundle: bundle }),
						},
						subject.caller,
					),
				),
			);
			expect(record.keyBundle?.signature).toEqual(bundle.signature);
			return { from: MemberState.ACTIVE, to: record.state };
		},
	},
	{
		name: "rotate identity key: ACTIVE → ACTIVE, same id, old thumbprint retired",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const next = generateDpopKey();
			const rotation = await signEnvelope(
				subject.keys.identity,
				ROTATION_CONTEXT,
				toBinary(
					RotationStatementSchema,
					create(RotationStatementSchema, {
						memberId: subject.keys.memberId,
						newIdentityJwk: JSON.stringify(next.publicJwk),
						at: new Date(h.clock.now()).toISOString(),
					}),
				),
			);
			const bundle = await bundleFor(subject.keys, h.clock.now(), {
				sequence: 2,
				identity: next.signer,
			});
			const record = decoded(
				value(
					await h.authority.rotateKeys(
						{
							memberId: subject.keys.memberId,
							request: create(KeyRotationRequestSchema, {
								keyBundle: bundle,
								rotation,
							}),
						},
						subject.caller,
					),
				),
			);
			expect(record.memberId).toBe(subject.keys.memberId);
			expect(record.identityThumbprint).toBe(jwkThumbprint(next.publicJwk));
			expect(record.retiredThumbprints).toEqual([subject.thumbprint]);
			return { from: MemberState.ACTIVE, to: record.state };
		},
	},
];

const expected = new Map<string, MemberState>([
	["enroll: none → PENDING", MemberState.PENDING],
	["declare: none → PENDING (SINGLE)", MemberState.PENDING],
	["approve-key: PENDING → PENDING (key approved)", MemberState.PENDING],
	["accept: PENDING → ACTIVE", MemberState.ACTIVE],
	["reject: PENDING → REJECTED", MemberState.REJECTED],
	["token expiry: PENDING → REJECTED (tick)", MemberState.REJECTED],
	["suspend: ACTIVE → SUSPENDED", MemberState.SUSPENDED],
	["resume: SUSPENDED → ACTIVE", MemberState.ACTIVE],
	["clone detected: ACTIVE → LOCKED", MemberState.LOCKED],
	["unlock: LOCKED → ACTIVE, generation reset", MemberState.ACTIVE],
	["revoke: PENDING → REVOKED", MemberState.REVOKED],
	["revoke: ACTIVE → REVOKED", MemberState.REVOKED],
	["revoke: SUSPENDED → REVOKED", MemberState.REVOKED],
	["revoke: LOCKED → REVOKED", MemberState.REVOKED],
	["leave: ACTIVE → REVOKED (the device itself)", MemberState.REVOKED],
	["assign: ACTIVE → ACTIVE with a second membership", MemberState.ACTIVE],
	["rotate key bundle: ACTIVE → ACTIVE", MemberState.ACTIVE],
	[
		"rotate identity key: ACTIVE → ACTIVE, same id, old thumbprint retired",
		MemberState.ACTIVE,
	],
]);

describe("member state machine transitions", () => {
	it.each(
		transitions.map((t) => [t.name, t] as const),
	)("%s", async (name, transition) => {
		const result = await transition.run();
		expect(result.to).toBe(expected.get(name));
	});
});

/** A store whose every append loses the compare-and-set. */
function alwaysConflicting(): FleetEventStore {
	const inner = createMemoryEventStore();
	return {
		...inner,
		readAll: (options) => inner.readAll(options),
		async append(streamId, events, options) {
			if (streamId.startsWith("fleet-policy-"))
				return inner.append(streamId, events, options);
			throw new OptimisticSequenceConflictError(
				streamId,
				options.expectedSeq,
				options.expectedSeq + 1,
			);
		},
	};
}

type Refusal = Readonly<{ code: FleetErrorCode; run(): Promise<string> }>;

const refusals: readonly Refusal[] = [
	{
		code: "invalid-request",
		async run() {
			const { h, admin } = await setup();
			return code(
				await h.authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: "x",
						ttlSeconds: 60,
					}),
					admin,
				),
			);
		},
	},
	{
		code: "unauthenticated",
		async run() {
			const { h } = await setup();
			return code(await h.authority.listTokens({}, undefined));
		},
	},
	{
		code: "proof-invalid",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			return code(
				await h.authority.credentials(
					{ memberId: subject.keys.memberId, request: refresh(0) },
					{ ...subject.caller, jkt: "another-key" },
				),
			);
		},
	},
	{
		code: "proof-replayed",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			const url = `https://authority.fleet.test/v1/fleet/members/${subject.keys.memberId}/credentials`;
			const { dpopFor } = await import("./fixtures.js");
			const proof = await dpopFor(subject, "POST", url, h.clock.now());
			const request = { method: "POST", url, authorization: "", dpop: proof };
			value(await h.authority.authenticate(request));
			return code(await h.authority.authenticate(request));
		},
	},
	{
		code: "forbidden",
		async run() {
			const { h } = await setup();
			const nobody = await h.person({ kind: "user", id: "nobody" }, []);
			return code(
				await h.authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: "x",
						ttlSeconds: 900,
					}),
					nobody.caller,
				),
			);
		},
	},
	{
		code: "token-invalid",
		async run() {
			const { h } = await setup();
			const subject = await device(h.clock.now());
			return code(
				await h.authority.enroll(
					enrollment(subject, {
						proof: { case: "bootstrapToken", value: "hft_unknown" },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "token-used",
		async run() {
			const { h, admin } = await setup();
			const issued = await token(h, admin);
			value(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "bootstrapToken", value: issued },
					}),
					undefined,
				),
			);
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "bootstrapToken", value: issued },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "token-expired",
		async run() {
			const { h, admin } = await setup();
			const issued = await token(h, admin);
			h.clock.advance(16 * 60_000);
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "bootstrapToken", value: issued },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "fleet-unknown",
		async run() {
			const { h, admin } = await setup();
			return code(
				await h.authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "nope",
						name: "x",
						ttlSeconds: 900,
					}),
					admin,
				),
			);
		},
	},
	{
		code: "member-unknown",
		async run() {
			const { h, admin } = await setup();
			return code(
				await h.authority.getMember(
					{ memberId: `dev_${"0".repeat(32)}` },
					admin,
				),
			);
		},
	},
	{
		code: "fleet-policy",
		async run() {
			const { h, admin } = await setup({ allowedRoles: [Role.OBSERVER] });
			return code(
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
		},
	},
	{
		code: "quota-exceeded",
		async run() {
			const { h, admin } = await setup({ memberQuotaPerPrincipal: 1 });
			await pending(h, admin, "build", "one");
			const second = await token(h, admin, "build", "two");
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						name: "two",
						proof: { case: "bootstrapToken", value: second },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "attestation-insufficient",
		async run() {
			const { h, admin } = await setup({
				minAttestationTier: AttestationTier.T1_HELD_KEY,
			});
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "bootstrapToken", value: await token(h, admin) },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "key-known",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			value(
				await h.authority.revoke(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			);
			return code(
				await h.authority.enroll(
					enrollment(subject, {
						name: "again",
						proof: {
							case: "bootstrapToken",
							value: await token(h, admin, "build", "again"),
						},
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "approval-pending",
		async run() {
			const { h, admin } = await setup();
			const subject = await pending(h, admin);
			return code(
				await h.authority.credentials(
					{ memberId: subject.keys.memberId, request: refresh(0) },
					subject.caller,
				),
			);
		},
	},
	{
		code: "member-suspended",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			value(
				await h.authority.suspend(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			);
			return code(
				await h.authority.credentials(
					{ memberId: subject.keys.memberId, request: refresh(0) },
					subject.caller,
				),
			);
		},
	},
	{
		code: "member-locked",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			await h.authority.credentials(
				{ memberId: subject.keys.memberId, request: refresh(4) },
				subject.caller,
			);
			return code(
				await h.authority.credentials(
					{ memberId: subject.keys.memberId, request: refresh(0) },
					subject.caller,
				),
			);
		},
	},
	{
		code: "member-revoked",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			value(
				await h.authority.revoke(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			);
			return code(
				await h.authority.suspend(
					{ memberId: subject.keys.memberId, request: why() },
					admin,
				),
			);
		},
	},
	{
		code: "generation-mismatch",
		async run() {
			const { h, admin } = await setup();
			const subject = await active(h, admin);
			return code(
				await h.authority.credentials(
					{ memberId: subject.keys.memberId, request: refresh(5) },
					subject.caller,
				),
			);
		},
	},
	{
		code: "agent-outdated",
		async run() {
			const { h, admin } = await setup({ minAgentVersion: "2.0.0" });
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "bootstrapToken", value: await token(h, admin) },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "conflict",
		async run() {
			const h = await harness({ store: alwaysConflicting() });
			await h.fleet("build");
			const admin = await h.person({ kind: "user", id: "admin" });
			return code(
				await h.authority
					.revokeToken({ tokenHash: "f".repeat(64) }, admin.caller)
					.then(async () =>
						h.authority.issueToken(
							create(TokenCreateRequestSchema, {
								fleet: "build",
								name: "x",
								ttlSeconds: 900,
							}),
							admin.caller,
						),
					),
			);
		},
	},
	{
		code: "residency-denied",
		async run() {
			const { h, admin } = await setup({
				residency: {
					$typeName: "hobo.fleet.v1.ResidencyRule",
					classifications: [],
					allowedJurisdictions: ["eu"],
					deniedJurisdictions: [],
				},
			});
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						region: "us-east-1",
						proof: { case: "bootstrapToken", value: await token(h, admin) },
					}),
					undefined,
				),
			);
		},
	},
	{
		code: "evidence-invalid",
		async run() {
			const { h, admin } = await setup();
			const dispatcher = await active(h, admin, "build", "box", [
				Role.DISPATCHER,
			]);
			return code(
				await h.authority.report(
					create(ViolationReportSchema, { kind: "claim-not-entitled" }),
					dispatcher.caller,
				),
			);
		},
	},
	{
		code: "name-taken",
		async run() {
			const { h, admin } = await setup();
			await pending(h, admin);
			return code(
				await h.authority.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: "build",
						name: "laptop",
						ttlSeconds: 900,
					}),
					admin,
				),
			);
		},
	},
	{
		code: "unavailable",
		async run() {
			const h = await harness({
				assertions: {
					verifyOidc: async () => {
						throw new Error("issuer down");
					},
					verifyCertificateChain: () => ({
						ok: false,
						error: { code: "unauthenticated", message: "no" },
					}),
				},
			});
			await h.fleet("build");
			return code(
				await h.authority.enroll(
					enrollment(await device(h.clock.now()), {
						proof: { case: "oidcAssertion", value: "jwt" },
					}),
					undefined,
				),
			);
		},
	},
];

/** Codes the enrollment authority never answers: other lanes', device-side, or not reachable from these routes. */
const NOT_THIS_LANE: readonly FleetErrorCode[] = [
	"work-unknown",
	"incarnation-stale",
	"sandbox-inadequate",
	"order-invalid",
	"assignment-mismatch",
	"session-denied",
	"no-majority",
	"undecided",
	"sign-in-pending",
];

describe("refusal codes", () => {
	it("covers every code of §7.6 the lane answers", () => {
		const covered = new Set(refusals.map((r) => r.code));
		for (const known of FLEET_ERROR_CODES)
			expect(covered.has(known) || NOT_THIS_LANE.includes(known), known).toBe(
				true,
			);
	});

	it.each(
		refusals.map((r) => [r.code, r] as const),
	)("%s", async (wanted, refusal) => {
		expect(await refusal.run()).toBe(wanted);
	});
});

describe("violation reports", () => {
	async function claimScenario(
		verdict: "valid" | "discard" | "not-entitled" | "early",
	) {
		const seen: string[] = [];
		const h = await harness({
			checkClaim: async (_claim, subject) => {
				seen.push(`${subject.fleet}/${subject.digest}`);
				return verdict;
			},
		});
		await h.fleet("build");
		const admin = (await h.person({ kind: "user", id: "admin" })).caller;
		const dispatcher = await active(h, admin, "build", "box", [
			Role.DISPATCHER,
		]);
		const executor = await active(h, admin, "build", "laptop", [Role.EXECUTOR]);
		const digest = "a".repeat(32);
		const offer = await signEnvelope(
			dispatcher.keys.sign,
			OFFER_CONTEXT,
			toBinary(
				WorkOfferSchema,
				create(WorkOfferSchema, {
					workKey: "k",
					workDigest: digest,
					kind: "oci-command",
					fleet: "build",
					dispatcher: dispatcher.keys.memberId,
				}),
			),
		);
		const claim = (at: string) =>
			signEnvelope(
				executor.keys.sign,
				CLAIM_CONTEXT,
				toBinary(
					ClaimSchema,
					create(ClaimSchema, {
						workDigest: digest,
						fleet: "build",
						memberId: executor.keys.memberId,
						dispatcher: dispatcher.keys.memberId,
						claimedAt: at,
					}),
				),
			);
		return { h, admin, dispatcher, executor, offer, claim, seen };
	}

	it("suspends the claimant when checkClaim confirms not-entitled", async () => {
		const { h, admin, dispatcher, executor, offer, claim, seen } =
			await claimScenario("not-entitled");
		const record = decoded(
			value(
				await h.authority.report(
					create(ViolationReportSchema, {
						kind: "claim-not-entitled",
						offer,
						claims: [await claim("2026-11-01T10:00:00.000Z")],
					}),
					dispatcher.caller,
				),
			),
		);
		expect(record.memberId).toBe(executor.keys.memberId);
		expect(record.state).toBe(MemberState.SUSPENDED);
		expect(seen).toEqual([`build/${"a".repeat(32)}`]);
		expect((await stateOf(h, executor, admin)).stateReason).toBe(
			"violation:claim-not-entitled",
		);
	});

	it("needs three distinct early claims within an hour", async () => {
		const { h, dispatcher, offer, claim } = await claimScenario("early");
		const two = await h.authority.report(
			create(ViolationReportSchema, {
				kind: "claim-early",
				offer,
				claims: [
					await claim("2026-11-01T10:00:00.000Z"),
					await claim("2026-11-01T10:01:00.000Z"),
				],
			}),
			dispatcher.caller,
		);
		expect(code(two)).toBe("evidence-invalid");
		const three = await h.authority.report(
			create(ViolationReportSchema, {
				kind: "claim-early",
				offer,
				claims: [
					await claim("2026-11-01T10:00:00.000Z"),
					await claim("2026-11-01T10:01:00.000Z"),
					await claim("2026-11-01T10:02:00.000Z"),
				],
			}),
			dispatcher.caller,
		);
		expect(decoded(value(three)).state).toBe(MemberState.SUSPENDED);
	});

	it("refuses evidence checkClaim does not confirm, and a reporter that is not a dispatcher", async () => {
		const { h, executor, dispatcher, offer, claim } =
			await claimScenario("valid");
		const report = create(ViolationReportSchema, {
			kind: "claim-not-entitled",
			offer,
			claims: [await claim("2026-11-01T10:00:00.000Z")],
		});
		expect(code(await h.authority.report(report, dispatcher.caller))).toBe(
			"evidence-invalid",
		);
		expect(code(await h.authority.report(report, executor.caller))).toBe(
			"evidence-invalid",
		);
	});

	it("refuses a claim signed by someone other than its claimant", async () => {
		const { h, dispatcher, offer } = await claimScenario("not-entitled");
		const forged = await signEnvelope(
			dispatcher.keys.sign,
			CLAIM_CONTEXT,
			toBinary(
				ClaimSchema,
				create(ClaimSchema, { fleet: "build", workDigest: "a".repeat(32) }),
			),
		);
		expect(
			code(
				await h.authority.report(
					create(ViolationReportSchema, {
						kind: "claim-not-entitled",
						offer,
						claims: [forged],
					}),
					dispatcher.caller,
				),
			),
		).toBe("evidence-invalid");
	});
});

describe("refusals that keep the record as it is", () => {
	it("refuses a key bundle that outlives fleet policy", async () => {
		const { h, admin } = await setup({ keyBundleHours: 1 });
		const subject = await device(h.clock.now());
		const refused = await h.authority.enroll(
			enrollment(subject, {
				proof: { case: "bootstrapToken", value: await token(h, admin) },
			}),
			undefined,
		);
		expect(refused.ok ? {} : refused.error.detail).toEqual({
			rule: "key-bundle-hours",
		});
	});

	it("refuses a rotation statement not signed by the current identity key", async () => {
		const { h, admin } = await setup();
		const subject = await active(h, admin);
		const intruder = generateDpopKey();
		const rotation = await signEnvelope(
			intruder.signer,
			ROTATION_CONTEXT,
			toBinary(
				RotationStatementSchema,
				create(RotationStatementSchema, {
					memberId: subject.keys.memberId,
					newIdentityJwk: JSON.stringify(intruder.publicJwk),
				}),
			),
		);
		const refused = await h.authority.rotateKeys(
			{
				memberId: subject.keys.memberId,
				request: create(KeyRotationRequestSchema, {
					keyBundle: await bundleFor(subject.keys, h.clock.now(), {
						sequence: 2,
						identity: intruder.signer,
					}),
					rotation,
				}),
			},
			subject.caller,
		);
		expect(code(refused)).toBe("proof-invalid");
		void DAY_MS;
		void randomBytes;
	});
});
