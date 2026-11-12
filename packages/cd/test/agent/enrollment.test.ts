/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- SAFETY: test fixtures brand ids they mint, build partial generated records, and read controlled JSON at the test boundary. */
// Agent enrollment (D19, I24): single-use Camp-set-scoped bootstrap tokens,
// double opt-in, Rail separate approvers and auto-accept, key-bound JWT-SVIDs
// with DPoP, refresh reported to CampInventory, revocation on the next request.
import { createInMemoryKms, JwtSvidIssuer } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	CampConditionType,
	ConditionStatus,
	EnrollmentState,
	ReconcilerMode,
	SignalSource,
} from "../../src/_generated/cd_pb.js";
import {
	AGENT_EVENTS,
	type AgentKeyPair,
	createAgentEnrollment,
	createDpopProof,
	generateAgentKey,
} from "../../src/agent/index.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	ENROLLMENT_INCOMPLETE,
} from "../../src/events.js";
import type { FeedRequest, Outcome, ReconcilerId } from "../../src/ports.js";
import {
	asCamp,
	type Clock,
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

const SETS = { "eu-fleet": ["eu-1", "eu-2", "eu-3"], "us-fleet": ["us-1"] };
const REFRESH_URL = "https://station.test/v1/cd/svid/refresh";
const alice = { kind: "user" as const, id: "alice" };
const bob = { kind: "user" as const, id: "bob" };

function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : (outcome.reasons[0]?.code ?? "");
}

function setup(
	rail = railWith(),
	deny: Parameters<typeof createFakeAuthorizer>[0] = [],
) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const inventory = createFakeInventory(SETS);
	const authorizer = createFakeAuthorizer(deny);
	const telemetry = createRecordingTelemetry();
	// Station replicas share one SVID issuer (its KMS key), as composed by WP18.
	const kms = createInMemoryKms();
	kms.generateRsaKey("svid-1");
	const issuer = new JwtSvidIssuer({
		issuerUrl: "https://station.test/identity",
		kms,
		activeKeyId: "svid-1",
		jwksKeyIds: ["svid-1"],
	});
	const make = () =>
		createAgentEnrollment({
			store,
			tenant: TENANT,
			now: clock.now,
			authorizer,
			rails: createFakeRails(rail),
			inventory,
			telemetry,
			issuer,
			publicOrigin: "https://station.test",
		});
	return {
		clock,
		store,
		inventory,
		authorizer,
		telemetry,
		enrollment: make(),
		make,
	};
}

type Setup = ReturnType<typeof setup>;

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
	if (!issued.ok) throw new Error(code(issued));
	return issued.value.token;
}

async function enrolled(s: Setup, key: AgentKeyPair = generateAgentKey()) {
	const token = await tokenFor(s);
	const result = await s.enrollment.enroll(
		{ token, publicJwk: key.publicJwk, claims: [] },
		ctxAt(s.clock, { kind: "agent", id: "bootstrap" }),
	);
	if (!result.ok) throw new Error(code(result));
	return {
		key,
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
	return e;
}

let jtis = 0;
function proof(
	key: AgentKeyPair,
	clock: Clock,
	method = "POST",
	url = REFRESH_URL,
	accessToken?: string,
) {
	jtis += 1;
	return createDpopProof({
		privateJwk: key.privateJwk,
		method,
		url,
		iatSeconds: Math.floor(clock.now() / 1000),
		jti: `jti-${jtis}`,
		...(accessToken !== undefined ? { accessToken } : {}),
	});
}

async function activated(s: Setup) {
	const e = await accepted(s);
	const result = await s.enrollment.activate(
		{ reconcilerId: e.id, dpopProof: proof(e.key, s.clock) },
		ctxAt(s.clock, { kind: "agent", id: e.id }),
	);
	if (!result.ok) throw new Error(code(result));
	return {
		...e,
		svid: result.value.svid,
		expiresAtMs: result.value.expiresAtMs,
	};
}

function feedRequest(
	key: AgentKeyPair,
	clock: Clock,
	svid: string,
	dpop = proof(key, clock, "GET", "https://station.test/v1/cd/feed", svid),
): FeedRequest {
	return {
		method: "GET",
		path: "/v1/cd/feed?camp=eu-1",
		headers: { authorization: `DPoP ${svid}`, dpop, host: "station.test" },
		body: new Uint8Array(),
	};
}

describe("bootstrap tokens (D19)", () => {
	it("issues a single-use token scoped to a Camp set and records only its hash", async () => {
		const s = setup();
		const token = await tokenFor(s);
		expect(token).toMatch(/^hcd_bt_[A-Za-z0-9_-]{43}$/);
		const journal = JSON.stringify(s.store.log.map((e) => e.event.data));
		expect(journal).not.toContain(token);
		expect(s.authorizer.decisions.map((d) => d.action)).toEqual([
			"reconciler.enroll",
		]);
	});

	it("refuses Camps outside the named Camp set, conductors, and TTLs above 24 h", async () => {
		const s = setup();
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
		const denied = setup(railWith(), ["reconciler.enroll"]);
		const ctx = ctxAt(denied.clock, alice);
		expect(
			code(
				await denied.enrollment.issueToken(
					{
						campSet: "eu-fleet",
						campIds: [asCamp("eu-1")],
						mode: ReconcilerMode.AGENT,
						ttlMs: 1,
					},
					ctx,
				),
			),
		).toBe("policy-denied");
		const s = setup();
		expect(
			code(
				await s.enrollment.issueToken(
					{
						campSet: "eu-fleet",
						campIds: [asCamp("eu-1")],
						mode: ReconcilerMode.AGENT,
						ttlMs: 1,
					},
					ctxAt(s.clock, { kind: "agent", id: "a" }),
				),
			),
		).toBe("proposal-only");
	});

	it("is single use: a second key is refused, the same key's retry is idempotent", async () => {
		const s = setup();
		const token = await tokenFor(s);
		const key = generateAgentKey();
		const ctx = ctxAt(s.clock, { kind: "agent", id: "bootstrap" });
		const first = await s.enrollment.enroll(
			{ token, publicJwk: key.publicJwk, claims: [] },
			ctx,
		);
		const again = await s.enrollment.enroll(
			{ token, publicJwk: key.publicJwk, claims: [] },
			ctx,
		);
		expect(
			first.ok &&
				again.ok &&
				first.value.reconciler.reconcilerId ===
					again.value.reconciler.reconcilerId,
		).toBe(true);
		expect(
			code(
				await s.enrollment.enroll(
					{ token, publicJwk: generateAgentKey().publicJwk, claims: [] },
					ctx,
				),
			),
		).toBe("token-used");
		expect(
			code(
				await s.enrollment.enroll(
					{ token: "hcd_bt_nope", publicJwk: key.publicJwk, claims: [] },
					ctx,
				),
			),
		).toBe("token-invalid");
	});

	it("refuses an expired token", async () => {
		const s = setup();
		const token = await tokenFor(s);
		s.clock.advance(CD_DEFAULTS.bootstrapTokenTtlMs + 1);
		expect(
			code(
				await s.enrollment.enroll(
					{ token, publicJwk: generateAgentKey().publicJwk, claims: [] },
					ctxAt(s.clock),
				),
			),
		).toBe("token-expired");
	});
});

describe("double opt-in (I24)", () => {
	it("enroll returns ENROLLMENT_STATE_PENDING with the token scope recorded", async () => {
		const s = setup();
		const e = await enrolled(s);
		expect(e.state).toBe(EnrollmentState.PENDING);
		const events = s.store.log
			.filter((p) => p.event.streamId === CD_STREAMS.reconciler(e.id))
			.map((p) => p.event.type);
		expect(events).toEqual([CD_EVENTS.ReconcilerEnrollmentRequested]);
	});

	it("one grant alone is refused with enrollment-incomplete (either grant)", async () => {
		const keyOnly = setup();
		const a = await enrolled(keyOnly);
		await keyOnly.enrollment.approveKey(a.id, ctxAt(keyOnly.clock, alice));
		expect(
			code(
				await keyOnly.enrollment.activate(
					{ reconcilerId: a.id, dpopProof: proof(a.key, keyOnly.clock) },
					ctxAt(keyOnly.clock),
				),
			),
		).toBe(ENROLLMENT_INCOMPLETE);
		const acceptOnly = setup();
		const b = await enrolled(acceptOnly);
		await acceptOnly.enrollment.accept(
			{ reconcilerId: b.id, campIds: [asCamp("eu-1")] },
			ctxAt(acceptOnly.clock, bob),
		);
		expect(
			code(
				await acceptOnly.enrollment.activate(
					{ reconcilerId: b.id, dpopProof: proof(b.key, acceptOnly.clock) },
					ctxAt(acceptOnly.clock),
				),
			),
		).toBe(ENROLLMENT_INCOMPLETE);
	});

	it("both grants from different principals accept the reconciler and record both", async () => {
		const s = setup();
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
		expect(s.authorizer.decisions.map((d) => d.action)).toContain(
			"reconciler.approve-key",
		);
		expect(s.authorizer.decisions.map((d) => d.action)).toContain(
			"reconciler.accept",
		);
	});

	it("the same principal for both grants under separate_approvers is refused (default and Rail)", async () => {
		for (const rail of [railWith(), railWith({ separateApprovers: true })]) {
			const s = setup(rail);
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
		}
	});

	it("a Rail without separate_approvers lets one principal grant both", async () => {
		const s = setup(railWith({ separateApprovers: false }));
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
		).toBe("ok");
	});

	it("an auto-accept scope works and is recorded", async () => {
		const s = setup(
			railWith({ separateApprovers: true, autoAcceptScopes: ["eu-fleet"] }),
		);
		const e = await enrolled(s);
		expect(e.state).toBe(EnrollmentState.ACCEPTED);
		const accept = s.store.log.find(
			(p) => p.event.type === CD_EVENTS.ReconcilerAccepted,
		);
		expect(accept?.event.data).toMatchObject({ autoAcceptScope: "eu-fleet" });
		const record = s.store.log.find(
			(p) => p.event.type === CD_EVENTS.ReconcilerEnrolled,
		)?.event.data as { reconciler: { autoAcceptedByScope: string } };
		expect(record.reconciler.autoAcceptedByScope).toBe("eu-fleet");
		expect(
			code(
				await s.enrollment.activate(
					{ reconcilerId: e.id, dpopProof: proof(e.key, s.clock) },
					ctxAt(s.clock),
				),
			),
		).toBe("ok");
	});

	it("an auto-accept scope that does not match the token scope leaves the agent pending", async () => {
		const s = setup(
			railWith({ separateApprovers: true, autoAcceptScopes: ["us-fleet"] }),
		);
		expect((await enrolled(s)).state).toBe(EnrollmentState.PENDING);
	});

	it("a token used for a Camp outside its scope is refused", async () => {
		const s = setup();
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
		expect(
			code(
				await s.enrollment.accept(
					{ reconcilerId: e.id, campIds: [asCamp("us-1")] },
					ctxAt(s.clock, bob),
				),
			),
		).toBe("camp-out-of-scope");
	});

	it("agent principals cannot grant (proposal only)", async () => {
		const s = setup();
		const e = await enrolled(s);
		expect(
			code(
				await s.enrollment.approveKey(
					e.id,
					ctxAt(s.clock, { kind: "agent", id: "ops-bot" }),
				),
			),
		).toBe("proposal-only");
	});
});

describe("key-bound SVIDs and DPoP", () => {
	it("activation issues a JWT-SVID carrying cnf.jkt and reports CREDENTIAL_VALID to the inventory", async () => {
		const s = setup();
		const a = await activated(s);
		const claims = JSON.parse(
			Buffer.from(a.svid.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		expect(claims.cnf).toEqual({ jkt: a.key.thumbprint });
		expect(claims.sub).toContain(a.id);
		expect(a.expiresAtMs).toBe(s.clock.now() + CD_DEFAULTS.svidTtlMs);
		const reported = s.inventory.observed.filter(
			(o) => o.conditions[0]?.type === CampConditionType.CREDENTIAL_VALID,
		);
		expect(reported.map((o) => o.campId).sort()).toEqual(["eu-1", "eu-2"]);
		expect(reported[0]?.source).toBe(SignalSource.STATION);
		expect(reported[0]?.conditions[0]?.status).toBe(ConditionStatus.TRUE);
		expect(reported[0]?.conditions[0]?.reason).toBe(
			`expires-at:${new Date(a.expiresAtMs).toISOString()}`,
		);
		const journal = JSON.stringify(s.store.log.map((e) => e.event.data));
		expect(journal).not.toContain(a.svid);
		expect(
			s.store.log.some((e) => e.event.type === AGENT_EVENTS.SvidIssued),
		).toBe(true);
	});

	it("activation with a proof from another key is refused", async () => {
		const s = setup();
		const e = await accepted(s);
		const other = generateAgentKey();
		expect(
			code(
				await s.enrollment.activate(
					{ reconcilerId: e.id, dpopProof: proof(other, s.clock) },
					ctxAt(s.clock),
				),
			),
		).toBe("dpop-key-mismatch");
	});

	it("verifies a request, refuses its replay, and refuses a stolen SVID with another key", async () => {
		const s = setup();
		const a = await activated(s);
		const request = feedRequest(a.key, s.clock, a.svid);
		const ok = await s.enrollment.verify(request);
		expect(ok.ok && ok.value.reconcilerId).toBe(a.id);
		expect(code(await s.enrollment.verify(request))).toBe("dpop-replayed");
		// A second Station replica over the same journal refuses the replay too.
		expect(code(await s.make().verify(request))).toBe("dpop-replayed");
		const thief = generateAgentKey();
		expect(
			code(await s.enrollment.verify(feedRequest(thief, s.clock, a.svid))),
		).toBe("dpop-key-mismatch");
	});

	it("refuses missing credentials, a Bearer scheme and a proof for another route", async () => {
		const s = setup();
		const a = await activated(s);
		const base = feedRequest(a.key, s.clock, a.svid);
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
					headers: { ...base.headers, authorization: `Bearer ${a.svid}` },
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
		const wrongRoute = proof(
			a.key,
			s.clock,
			"POST",
			"https://station.test/v1/cd/checkpoints",
			a.svid,
		);
		expect(
			code(
				await s.enrollment.verify(
					feedRequest(a.key, s.clock, a.svid, wrongRoute),
				),
			),
		).toBe("dpop-method-mismatch");
	});

	it("refreshes before expiry and reports the new expiry", async () => {
		const s = setup();
		const a = await activated(s);
		s.clock.advance(
			CD_DEFAULTS.svidTtlMs - CD_DEFAULTS.svidRefreshBeforeExpiryMs,
		);
		const refreshed = await s.enrollment.refresh(
			{
				svid: a.svid,
				dpopProof: proof(a.key, s.clock, "POST", REFRESH_URL, a.svid),
			},
			ctxAt(s.clock),
		);
		expect(refreshed.ok && refreshed.value.expiresAtMs).toBe(
			s.clock.now() + CD_DEFAULTS.svidTtlMs,
		);
		expect(refreshed.ok && refreshed.value.svid !== a.svid).toBe(true);
	});

	it("an expired SVID cannot refresh and the failure is reported as CREDENTIAL_VALID=FALSE", async () => {
		const s = setup();
		const a = await activated(s);
		s.clock.advance(CD_DEFAULTS.svidTtlMs + 1);
		const result = await s.enrollment.refresh(
			{
				svid: a.svid,
				dpopProof: proof(a.key, s.clock, "POST", REFRESH_URL, a.svid),
			},
			ctxAt(s.clock),
		);
		expect(code(result)).toBe("svid-expired");
		const failed = s.inventory.observed.filter(
			(o) => o.conditions[0]?.status === ConditionStatus.FALSE,
		);
		expect(failed.map((o) => o.conditions[0]?.reason)).toEqual([
			"svid-refresh-failed",
			"svid-refresh-failed",
		]);
		// Re-activation with the enrolled key recovers.
		expect(
			code(
				await s.enrollment.activate(
					{ reconcilerId: a.id, dpopProof: proof(a.key, s.clock) },
					ctxAt(s.clock),
				),
			),
		).toBe("ok");
	});

	it("a revoked agent is refused at once, on every replica", async () => {
		const s = setup();
		const a = await activated(s);
		expect(
			(await s.enrollment.verify(feedRequest(a.key, s.clock, a.svid))).ok,
		).toBe(true);
		const other = s.make();
		expect(
			code(await other.revoke(a.id, "key compromise", ctxAt(s.clock, alice))),
		).toBe("ok");
		expect(
			code(await s.enrollment.verify(feedRequest(a.key, s.clock, a.svid))),
		).toBe("reconciler-revoked");
		expect(
			code(
				await s.enrollment.refresh(
					{
						svid: a.svid,
						dpopProof: proof(a.key, s.clock, "POST", REFRESH_URL, a.svid),
					},
					ctxAt(s.clock),
				),
			),
		).toBe("reconciler-revoked");
		expect(
			code(
				await s.enrollment.activate(
					{ reconcilerId: a.id, dpopProof: proof(a.key, s.clock) },
					ctxAt(s.clock),
				),
			),
		).toBe("reconciler-revoked");
		// The revoked key can never re-enroll.
		const token = await tokenFor(s);
		expect(
			code(
				await s.enrollment.enroll(
					{ token, publicJwk: a.key.publicJwk, claims: [] },
					ctxAt(s.clock),
				),
			),
		).toBe("key-revoked");
		expect(s.authorizer.decisions.map((d) => d.action)).toContain(
			"reconciler.revoke",
		);
	});

	it("emits enrollment and verification metrics", async () => {
		const s = setup();
		const a = await activated(s);
		const request = feedRequest(a.key, s.clock, a.svid);
		await s.enrollment.verify(request);
		await s.enrollment.verify(request);
		const names = new Set(s.telemetry.points.map((p) => p.name));
		expect(names).toContain("hobo.cd.agent.enrollments");
		expect(names).toContain("hobo.cd.agent.grants");
		expect(names).toContain("hobo.cd.agent.svids_issued");
		expect(
			s.telemetry.points.find((p) => p.name === "hobo.cd.agent.verify_refusals")
				?.attributes.code,
		).toBe("dpop-replayed");
	});
});
