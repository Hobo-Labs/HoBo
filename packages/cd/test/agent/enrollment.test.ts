/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- SAFETY: test fixtures brand ids they mint and read controlled JSON at the test boundary. */
// Agent enrollment over the fleet (L19; D19, I24): a reconciler is a fleet
// DEVICE with role RECONCILER. The fleet's createTestAuthority holds identity
// (hft_ tokens, keys, member SVIDs, DPoP, revocation); the adapter keeps the
// Camp scope, double opt-in with Rail rules, governance and the accepted Camps.
import { ApprovalMode, MemberState, parseMemberId } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	CampConditionType,
	ConditionStatus,
	EnrollmentState,
	ReconcilerMode,
	SignalSource,
} from "../../src/_generated/cd_pb.js";
import { createAgentEnrollment } from "../../src/agent/index.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	ENROLLMENT_INCOMPLETE,
} from "../../src/events.js";
import type { FeedRequest, Outcome, ReconcilerId } from "../../src/ports.js";
import {
	asCamp,
	createClock,
	createFakeAuthorizer,
	createFakeInventory,
	createFakeRails,
	createFakeStore,
	createRecordingTelemetry,
	ctxAt,
	railWith,
	TENANT,
} from "../feed/fakes.js";
import {
	FLEET_ORIGIN,
	type FleetDevice,
	fleetFixture,
	YARD_FLEET,
} from "./fleet-fixture.js";

const SETS = { "eu-fleet": ["eu-1", "eu-2", "eu-3"], "us-fleet": ["us-1"] };
const FEED_URL = "https://station.test/v1/cd/feed";
const alice = { kind: "user" as const, id: "alice" };
const bob = { kind: "user" as const, id: "bob" };

function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : (outcome.reasons[0]?.code ?? "");
}

async function setup(
	rail = railWith(),
	deny: Parameters<typeof createFakeAuthorizer>[0] = [],
	withFleet = true,
) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const inventory = createFakeInventory(SETS);
	const authorizer = createFakeAuthorizer(deny);
	const telemetry = createRecordingTelemetry();
	const fixture = await fleetFixture(clock.now, ApprovalMode.SINGLE);
	const make = () =>
		createAgentEnrollment({
			store,
			tenant: TENANT,
			now: clock.now,
			authorizer,
			rails: createFakeRails(rail),
			inventory,
			telemetry,
			fleet: withFleet ? fixture.fleet : undefined,
			publicOrigin: "https://station.test",
		});
	return {
		clock,
		store,
		inventory,
		authorizer,
		telemetry,
		fixture,
		enrollment: make(),
		make,
	};
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function tokenFor(
	s: Setup,
	campIds = ["eu-1", "eu-2"],
	campSet = "eu-fleet",
) {
	const issued = await s.enrollment.issueToken(
		{
			campSet,
			campIds: campIds.map(asCamp),
			mode: ReconcilerMode.AGENT,
			ttlMs: CD_DEFAULTS.bootstrapTokenTtlMs,
		},
		ctxAt(s.clock, alice),
	);
	if (!issued.ok)
		throw new Error(`${code(issued)}: ${issued.reasons[0]?.message}`);
	return issued.value.token;
}

async function enrollWith(
	s: Setup,
	token: string,
	device: FleetDevice,
	campIds: readonly string[] = [],
) {
	return s.enrollment.enroll(
		{
			request: device.request(token),
			dpopProof: await device.proof("POST", `${FLEET_ORIGIN}/v1/fleet/members`),
			campIds: campIds.map(asCamp),
		},
		ctxAt(s.clock, { kind: "agent", id: "bootstrap" }),
	);
}

async function enrolled(s: Setup) {
	const device = await s.fixture.device();
	const token = await tokenFor(s);
	const result = await enrollWith(s, token, device);
	if (!result.ok) throw new Error(code(result));
	return {
		device,
		token,
		id: result.value.reconciler.reconcilerId as ReconcilerId,
		state: result.value.state,
	};
}

async function accepted(s: Setup) {
	const e = await enrolled(s);
	expect(code(await s.enrollment.approveKey(e.id, ctxAt(s.clock, alice)))).toBe(
		"ok",
	);
	expect(
		code(
			await s.enrollment.accept(
				{ reconcilerId: e.id, campIds: ["eu-1", "eu-2"].map(asCamp) },
				ctxAt(s.clock, bob),
			),
		),
	).toBe("ok");
	const svid = await s.fixture.credentials(e.device, parseMemberId(e.id));
	return { ...e, svid };
}

async function feedRequest(
	device: FleetDevice,
	svid: string,
	dpop?: string,
): Promise<FeedRequest> {
	return {
		method: "GET",
		path: "/v1/cd/feed?camp=eu-1",
		headers: {
			authorization: `DPoP ${svid}`,
			dpop: dpop ?? (await device.proof("GET", FEED_URL, svid)),
			host: "station.test",
		},
		body: new Uint8Array(),
	};
}

async function memberState(s: Setup, id: string): Promise<MemberState> {
	const member = await s.fixture.bus.registry.member(parseMemberId(id));
	return member?.state ?? MemberState.UNSPECIFIED;
}

describe("bootstrap tokens (D19)", () => {
	it("issues a single-use fleet token scoped to a Camp set and records only its hash", async () => {
		const s = await setup();
		const token = await tokenFor(s);
		expect(token).toMatch(/^hft_[A-Za-z0-9_-]{43}$/);
		const journal = JSON.stringify(s.store.log.map((e) => e.event.data));
		expect(journal).not.toContain(token);
		expect(s.authorizer.decisions.map((d) => d.action)).toEqual([
			"reconciler.enroll",
		]);
	});

	it("refuses Camps outside the named Camp set, conductors, and TTLs above 24 h", async () => {
		const s = await setup();
		const ctx = ctxAt(s.clock, alice);
		const base = {
			campSet: "eu-fleet",
			mode: ReconcilerMode.AGENT,
			ttlMs: 1000,
		};
		expect(
			code(
				await s.enrollment.issueToken(
					{ ...base, campIds: ["us-1"].map(asCamp) },
					ctx,
				),
			),
		).toBe("token-scope-invalid");
		expect(
			code(await s.enrollment.issueToken({ ...base, campIds: [] }, ctx)),
		).toBe("token-scope-invalid");
		expect(
			code(
				await s.enrollment.issueToken(
					{
						...base,
						campIds: ["eu-1"].map(asCamp),
						mode: ReconcilerMode.CONDUCTOR,
					},
					ctx,
				),
			),
		).toBe("mode-invalid");
		expect(
			code(
				await s.enrollment.issueToken(
					{
						...base,
						campIds: ["eu-1"].map(asCamp),
						ttlMs: CD_DEFAULTS.bootstrapTokenMaxTtlMs + 1,
					},
					ctx,
				),
			),
		).toBe("token-ttl-invalid");
	});

	it("is governed: a denied or proposal-only principal cannot issue", async () => {
		const denied = await setup(railWith(), ["reconciler.enroll"]);
		const input = {
			campSet: "eu-fleet",
			campIds: [asCamp("eu-1")],
			mode: ReconcilerMode.AGENT,
			ttlMs: 1,
		};
		expect(
			code(
				await denied.enrollment.issueToken(input, ctxAt(denied.clock, alice)),
			),
		).toBe("policy-denied");
		const s = await setup();
		expect(
			code(
				await s.enrollment.issueToken(
					input,
					ctxAt(s.clock, { kind: "agent", id: "a" }),
				),
			),
		).toBe("proposal-only");
	});

	it("is single use: a second key is refused by the fleet", async () => {
		const s = await setup();
		const token = await tokenFor(s);
		expect(code(await enrollWith(s, token, await s.fixture.device()))).toBe(
			"ok",
		);
		expect(code(await enrollWith(s, token, await s.fixture.device()))).toBe(
			"token-used",
		);
		expect(
			code(
				await enrollWith(s, `hft_${"x".repeat(43)}`, await s.fixture.device()),
			),
		).toBe("token-invalid");
		expect(
			code(await enrollWith(s, "hcd_bt_old", await s.fixture.device())),
		).toBe("token-invalid");
	});

	it("refuses an expired token and Camps outside its scope", async () => {
		const s = await setup();
		const token = await tokenFor(s);
		expect(
			code(await enrollWith(s, token, await s.fixture.device(), ["eu-3"])),
		).toBe("camp-out-of-scope");
		s.clock.advance(CD_DEFAULTS.bootstrapTokenTtlMs + 1);
		expect(code(await enrollWith(s, token, await s.fixture.device()))).toBe(
			"token-expired",
		);
	});

	it("names a one-Camp reconciler after its Camp, so the Camp mapper finds its DEVICE", async () => {
		const s = await setup();
		const device = await s.fixture.device();
		const result = await enrollWith(s, await tokenFor(s, ["eu-1"]), device);
		if (!result.ok) throw new Error(code(result));
		const member = await s.fixture.bus.registry.member(
			parseMemberId(result.value.reconciler.reconcilerId),
		);
		expect(member?.memberships.map((m) => [m.fleet, m.name])).toEqual([
			[YARD_FLEET, "eu-1"],
		]);
	});

	it("refuses every identity step without a fleet (fail closed)", async () => {
		const s = await setup(railWith(), [], false);
		expect(
			code(
				await s.enrollment.issueToken(
					{
						campSet: "eu-fleet",
						campIds: [asCamp("eu-1")],
						mode: ReconcilerMode.AGENT,
						ttlMs: 1000,
					},
					ctxAt(s.clock, alice),
				),
			),
		).toBe("fleet-unavailable");
	});
});

describe("double opt-in (I24)", () => {
	it("enroll returns PENDING with the token scope recorded; the fleet member is PENDING too", async () => {
		const s = await setup();
		const e = await enrolled(s);
		expect(e.state).toBe(EnrollmentState.PENDING);
		expect(e.id).toMatch(/^dev_[0-9a-f]{32}$/u);
		const events = s.store.log
			.filter((p) => p.event.streamId === CD_STREAMS.reconciler(e.id))
			.map((p) => p.event.type);
		expect(events).toEqual([CD_EVENTS.ReconcilerEnrollmentRequested]);
		expect(await memberState(s, e.id)).toBe(MemberState.PENDING);
	});

	it("one grant alone leaves the fleet member PENDING: no credential, no feed", async () => {
		const s = await setup();
		const e = await enrolled(s);
		await s.enrollment.approveKey(e.id, ctxAt(s.clock, alice));
		expect(await memberState(s, e.id)).toBe(MemberState.PENDING);
		await expect(
			s.fixture.credentials(e.device, parseMemberId(e.id)),
		).rejects.toThrow();
	});

	it("both grants from different principals accept the reconciler and activate the member", async () => {
		const s = await setup();
		const e = await accepted(s);
		const types = s.store.log
			.filter((p) => p.event.streamId === CD_STREAMS.reconciler(e.id))
			.map((p) => p.event.type);
		expect(types).toEqual([
			CD_EVENTS.ReconcilerEnrollmentRequested,
			CD_EVENTS.ReconcilerKeyApproved,
			CD_EVENTS.ReconcilerAccepted,
			CD_EVENTS.ReconcilerEnrolled,
		]);
		expect(await memberState(s, e.id)).toBe(MemberState.ACTIVE);
		expect(s.authorizer.decisions.map((d) => d.action)).toEqual(
			expect.arrayContaining(["reconciler.approve-key", "reconciler.accept"]),
		);
	});

	it("the same principal for both grants under separate_approvers is refused (default and Rail)", async () => {
		for (const rail of [railWith(), railWith({ separateApprovers: true })]) {
			const s = await setup(rail);
			const e = await enrolled(s);
			expect(
				code(await s.enrollment.approveKey(e.id, ctxAt(s.clock, alice))),
			).toBe("ok");
			expect(
				code(
					await s.enrollment.accept(
						{ reconcilerId: e.id, campIds: [asCamp("eu-1")] },
						ctxAt(s.clock, alice),
					),
				),
			).toBe("separate-approvers-required");
			expect(await memberState(s, e.id)).toBe(MemberState.PENDING);
		}
	});

	it("an auto-accept scope accepts at enrollment and activates the member", async () => {
		const s = await setup(
			railWith({ separateApprovers: true, autoAcceptScopes: ["eu-fleet"] }),
		);
		const e = await enrolled(s);
		expect(e.state).toBe(EnrollmentState.ACCEPTED);
		const accept = s.store.log.find(
			(p) => p.event.type === CD_EVENTS.ReconcilerAccepted,
		);
		expect(accept?.event.data).toMatchObject({ autoAcceptScope: "eu-fleet" });
		expect(await memberState(s, e.id)).toBe(MemberState.ACTIVE);
	});

	it("an auto-accept scope that does not match the token scope leaves the agent pending", async () => {
		const s = await setup(
			railWith({ separateApprovers: true, autoAcceptScopes: ["us-fleet"] }),
		);
		expect((await enrolled(s)).state).toBe(EnrollmentState.PENDING);
	});

	it("a Camp outside the token scope is refused; agents only propose", async () => {
		const s = await setup();
		const e = await enrolled(s);
		await s.enrollment.approveKey(e.id, ctxAt(s.clock, alice));
		expect(
			code(
				await s.enrollment.accept(
					{ reconcilerId: e.id, campIds: ["eu-1", "eu-3"].map(asCamp) },
					ctxAt(s.clock, bob),
				),
			),
		).toBe("camp-out-of-scope");
		const other = await enrolled(s);
		expect(
			code(
				await s.enrollment.approveKey(
					other.id,
					ctxAt(s.clock, { kind: "agent", id: "ops-bot" }),
				),
			),
		).toBe("proposal-only");
	});
});

describe("member SVIDs and DPoP through the fleet", () => {
	it("verify accepts the fleet's member SVID with a fresh proof and refuses a replay", async () => {
		const s = await setup();
		const a = await accepted(s);
		const request = await feedRequest(a.device, a.svid);
		const ok = await s.enrollment.verify(request);
		expect(ok.ok && ok.value.reconcilerId).toBe(a.id);
		expect(code(await s.enrollment.verify(request))).toBe("dpop-replayed");
	});

	it("a stolen SVID presented with another key is refused", async () => {
		const s = await setup();
		const a = await accepted(s);
		const thief = await s.fixture.device();
		expect(
			code(await s.enrollment.verify(await feedRequest(thief, a.svid))),
		).not.toBe("ok");
	});

	it("requests without the SVID or the proof are refused", async () => {
		const s = await setup();
		const a = await accepted(s);
		const base = await feedRequest(a.device, a.svid);
		expect(
			code(
				await s.enrollment.verify({
					...base,
					headers: { dpop: base.headers.dpop ?? "" },
				}),
			),
		).toBe("svid-required");
		expect(
			code(
				await s.enrollment.verify({
					...base,
					headers: { authorization: `DPoP ${a.svid}` },
				}),
			),
		).toBe("dpop-required");
	});

	it("refresh forwards the agent's proof to the fleet and reports CREDENTIAL_VALID", async () => {
		const s = await setup();
		const a = await accepted(s);
		const memberId = parseMemberId(a.id);
		const { create } = await import("@bufbuild/protobuf");
		const { CredentialRequestSchema } = await import("@hobo/fleet");
		const refreshed = await s.enrollment.refresh(
			{
				memberId,
				request: create(CredentialRequestSchema, {
					generation: 1,
					refreshNonce: new Uint8Array(16).fill(7),
					agentVersion: "1.0.0",
				}),
				dpopProof: await a.device.proof(
					"POST",
					`${FLEET_ORIGIN}/v1/fleet/members/${memberId}/credentials`,
				),
			},
			ctxAt(s.clock, { kind: "agent", id: a.id }),
		);
		if (!refreshed.ok) throw new Error(code(refreshed));
		expect(refreshed.value.svid.split(".")).toHaveLength(3);
		const reported = s.inventory.observed.filter(
			(o) => o.conditions[0]?.type === CampConditionType.CREDENTIAL_VALID,
		);
		expect(reported.map((o) => o.campId).sort()).toEqual(["eu-1", "eu-2"]);
		expect(reported[0]?.source).toBe(SignalSource.STATION);
		expect(reported[0]?.conditions[0]?.status).toBe(ConditionStatus.TRUE);
		const journal = JSON.stringify(s.store.log.map((e) => e.event.data));
		expect(journal).not.toContain(refreshed.value.svid);
	});

	it("an incomplete enrollment cannot refresh", async () => {
		const s = await setup();
		const e = await enrolled(s);
		const { create } = await import("@bufbuild/protobuf");
		const { CredentialRequestSchema } = await import("@hobo/fleet");
		expect(
			code(
				await s.enrollment.refresh(
					{
						memberId: parseMemberId(e.id),
						request: create(CredentialRequestSchema, { generation: 0 }),
						dpopProof: "x",
					},
					ctxAt(s.clock),
				),
			),
		).toBe(ENROLLMENT_INCOMPLETE);
	});
});

describe("revocation", () => {
	it("revoke is governed, revokes the fleet member, and the next request is refused", async () => {
		const s = await setup();
		const a = await accepted(s);
		expect(
			(await s.enrollment.verify(await feedRequest(a.device, a.svid))).ok,
		).toBe(true);
		const revoked = await s.enrollment.revoke(
			a.id,
			"compromised",
			ctxAt(s.clock, alice),
		);
		expect(revoked.ok && revoked.value.enrollment).toBe(
			EnrollmentState.REVOKED,
		);
		expect(await memberState(s, a.id)).toBe(MemberState.REVOKED);
		expect(
			code(await s.enrollment.verify(await feedRequest(a.device, a.svid))),
		).not.toBe("ok");
		expect(
			code(await s.enrollment.approveKey(a.id, ctxAt(s.clock, alice))),
		).toBe("reconciler-revoked");
		const reported = s.inventory.observed.filter(
			(o) =>
				o.conditions[0]?.type === CampConditionType.CREDENTIAL_VALID &&
				o.conditions[0]?.status === ConditionStatus.FALSE,
		);
		expect(reported.map((o) => o.campId).sort()).toEqual(["eu-1", "eu-2"]);
	});

	it("a second Station replica on the same journal and fleet agrees", async () => {
		const s = await setup();
		const a = await accepted(s);
		const replica = s.make();
		const ok = await replica.verify(await feedRequest(a.device, a.svid));
		expect(ok.ok).toBe(true);
	});
});
