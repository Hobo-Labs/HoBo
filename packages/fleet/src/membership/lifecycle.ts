/**
 * The member state machine after enrollment (§6.5; L02 private):
 *
 *   PENDING ─approve-key, accept─▶ ACTIVE ⇄ SUSPENDED (suspend, resume)
 *   PENDING ─reject or token expiry─▶ REJECTED
 *   ACTIVE ─clone detected─▶ LOCKED ─unlock (governed)─▶ ACTIVE
 *   any state ─revoke, leave─▶ REVOKED (terminal)
 *
 * Every person transition is governed (§6.13) and decided once, before the
 * compare-and-set loop; `DUAL` needs approve-key and accept from two
 * principals. A transition already done is answered with the current record.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { EventInput, JsonObject } from "@hobo/core";
import {
	ApprovalMode,
	type Claim,
	ClaimSchema,
	ControlKind,
	type LifecycleRequest,
	MemberControlSchema,
	MemberKind,
	type MemberRecord,
	MemberState,
	type MembershipRequest,
	MembershipSchema,
	Role,
	type SignedEnvelope,
	type ViolationReport,
	type WorkOffer,
	WorkOfferSchema,
} from "../_generated/fleet_pb.js";
import { CLAIM_CONTEXT, CONTROL_CONTEXT, OFFER_CONTEXT } from "../contexts.js";
import type { FleetEventType } from "../events.js";
import {
	type FleetId,
	type MemberId,
	type MemberName,
	parseFleetId,
	parseMemberId,
	parseMemberName,
	parseWorkDigest,
	type WorkDigest,
} from "../ids.js";
import { signEnvelope, verifyEnvelope } from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import { decodeBundle, signRefOf } from "./bundle.js";
import {
	actorOf,
	asDevice,
	asPerson,
	type Ctx,
	type Person,
	personSubject,
	principalKey,
	refuse,
	stateRefusal,
	withRetry,
} from "./context.js";
import { nameTaken } from "./enroll.js";
import {
	type MemberState as Folded,
	type MembershipIndex,
	memberEvent,
	memberFact,
	memberStream,
} from "./journal.js";
import {
	checkClass,
	checkKind,
	checkResidency,
	checkRoles,
	checkTier,
} from "./policy.js";
import { nextRecord } from "./records.js";

const STEP_MS = 20_000;
const EARLY_WINDOW_MS = 60 * 60 * 1_000;
const EARLY_CLAIMS = 3;

/** One planned change: the events to append (none when the change is already done), and the record after them. */
type Plan = Readonly<{
	events: readonly EventInput<JsonObject>[];
	record: MemberRecord;
}>;

function parseId(id: string): MemberId | undefined {
	try {
		return parseMemberId(id);
	} catch {
		return undefined;
	}
}

function step(
	ctx: Ctx,
	record: MemberRecord,
	type: FleetEventType,
	change: Parameters<typeof nextRecord>[1],
): Plan {
	const next = nextRecord(record, change, ctx.nowIso());
	return { events: [memberEvent(type, next)], record: next };
}

function unchanged(record: MemberRecord): Plan {
	return { events: [], record };
}

function wrongState<T>(record: MemberRecord, action: string): Outcome<T> {
	if (record.state === MemberState.REVOKED)
		return refuse("member-revoked", `${record.memberId} is revoked`);
	return refuse(
		"invalid-request",
		`${action} does not apply to a member in state ${MemberState[record.state]}`,
		{ state: MemberState[record.state] ?? "UNSPECIFIED" },
	);
}

/** Appends a plan at the member's stream head; publishes the record and logs the events. */
async function commit(
	ctx: Ctx,
	state: Folded,
	plan: Plan,
	caller: VerifiedToken | undefined,
): Promise<"conflict" | "appended"> {
	if (plan.events.length === 0) return "appended";
	const id = parseMemberId(plan.record.memberId);
	const appended = await ctx.append(
		memberStream(id),
		state.seq,
		plan.events,
		actorOf(caller),
	);
	if (appended === "conflict") return "conflict";
	ctx.logEvents(plan.events, id);
	await ctx.publish(plan.record);
	return "appended";
}

/** A governed person transition on one member. */
async function transition(
	ctx: Ctx,
	memberId: string,
	caller: VerifiedToken | undefined,
	action: string,
	decide: (
		state: Folded,
		person: Person,
	) => Promise<Outcome<Plan>> | Outcome<Plan>,
): Promise<Outcome<SignedEnvelope>> {
	const person = asPerson(ctx.deps, caller);
	if (!person.ok) return person;
	const id = parseId(memberId);
	if (id === undefined)
		return refuse("member-unknown", `no member ${memberId}`);
	const first = (await ctx.catchUp()).members.get(id);
	if (first === undefined)
		return refuse("member-unknown", `no member ${memberId}`);
	const decision = await ctx.governed(personSubject(person.value), action, {
		kind: "fleet-member",
		id,
		fleet: first.record.memberships[0]?.fleet ?? "",
	});
	if (!decision.ok) return decision;
	return withRetry(ctx, async (index) => {
		const state = index.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${memberId}`);
		const plan = await decide(state, person.value);
		if (!plan.ok) return plan;
		if ((await commit(ctx, state, plan.value, caller)) === "conflict")
			return "conflict";
		return { ok: true, value: await ctx.signRecord(plan.value.record) };
	});
}

/** The approval mode of the fleet the member first joined; UNSPECIFIED counts as SINGLE. */
async function approvalOf(
	ctx: Ctx,
	record: MemberRecord,
): Promise<ApprovalMode> {
	const fleet = await ctx.fleet(record.memberships[0]?.fleet ?? "");
	return fleet.ok
		? (fleet.value.policy?.approval ?? ApprovalMode.SINGLE)
		: ApprovalMode.SINGLE;
}

/** A PENDING enrollment whose bootstrap token has expired is rejected (§6.5). */
function expired(ctx: Ctx, state: Folded): boolean {
	return (
		state.record.state === MemberState.PENDING &&
		state.tokenExpiresAtMs !== undefined &&
		state.tokenExpiresAtMs <= ctx.deps.now()
	);
}

function rejectExpired(ctx: Ctx, record: MemberRecord): Plan {
	return step(ctx, record, "fleet.EnrollmentRejected", {
		state: MemberState.REJECTED,
		stateReason: "token-expired",
	});
}

export function approveKey(
	ctx: Ctx,
	memberId: string,
	request: LifecycleRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	return transition(
		ctx,
		memberId,
		caller,
		"fleet.member.approve-key",
		(state, person) => {
			const { record } = state;
			if (record.state !== MemberState.PENDING)
				return record.keyApprovedBy.length > 0 &&
					record.state === MemberState.ACTIVE
					? { ok: true, value: unchanged(record) }
					: wrongState(record, "approve-key");
			if (record.keyApprovedBy.length > 0)
				return { ok: true, value: unchanged(record) };
			return {
				ok: true,
				value: step(ctx, record, "fleet.KeyApproved", {
					keyApprovedBy: principalKey(person.principal),
					stateReason: request.reason || record.stateReason,
				}),
			};
		},
	);
}

export function accept(
	ctx: Ctx,
	memberId: string,
	request: LifecycleRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	return transition(
		ctx,
		memberId,
		caller,
		"fleet.member.accept",
		async (state, person) => {
			const { record } = state;
			if (record.state === MemberState.ACTIVE && record.acceptedBy.length > 0)
				return { ok: true, value: unchanged(record) };
			if (record.state !== MemberState.PENDING)
				return wrongState(record, "accept");
			if (record.keyApprovedBy.length === 0)
				return refuse("approval-pending", "approve-key comes before accept", {
					step: "approve-key",
				});
			const by = principalKey(person.principal);
			if (
				(await approvalOf(ctx, record)) === ApprovalMode.DUAL &&
				record.keyApprovedBy === by
			)
				return refuse(
					"fleet-policy",
					"dual control: accept needs a second principal",
					{ rule: "dual-control" },
				);
			const granted =
				request.fleets.length === 0
					? record.memberships
					: record.memberships.filter((membership) =>
							request.fleets.includes(membership.fleet),
						);
			if (granted.length === 0)
				return refuse("invalid-request", "accept grants no membership");
			const now = ctx.nowIso();
			const accepted = nextRecord(
				record,
				{ acceptedBy: by, memberships: granted },
				now,
			);
			const active = nextRecord(
				accepted,
				{
					state: MemberState.ACTIVE,
					stateReason: request.reason || "accepted",
				},
				now,
			);
			return {
				ok: true,
				value: {
					events: [
						memberEvent("fleet.EnrollmentAccepted", accepted),
						memberEvent("fleet.MemberActivated", active),
					],
					record: active,
				},
			};
		},
	);
}

export function reject(
	ctx: Ctx,
	memberId: string,
	request: LifecycleRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	return transition(ctx, memberId, caller, "fleet.member.reject", (state) => {
		const { record } = state;
		if (record.state === MemberState.REJECTED)
			return { ok: true, value: unchanged(record) };
		if (record.state !== MemberState.PENDING)
			return wrongState(record, "reject");
		return {
			ok: true,
			value: step(ctx, record, "fleet.EnrollmentRejected", {
				state: MemberState.REJECTED,
				stateReason: request.reason || "rejected",
			}),
		};
	});
}

/** A move between two states, idempotent once in `to`. */
function simple(
	ctx: Ctx,
	action: string,
	from: MemberState,
	to: MemberState,
	type: FleetEventType,
) {
	return (
		memberId: string,
		request: LifecycleRequest,
		caller: VerifiedToken | undefined,
	): Promise<Outcome<SignedEnvelope>> =>
		transition(ctx, memberId, caller, action, (state) => {
			const { record } = state;
			if (record.state === to) return { ok: true, value: unchanged(record) };
			if (record.state !== from) return wrongState(record, action);
			return {
				ok: true,
				value: step(ctx, record, type, {
					state: to,
					stateReason: request.reason || action,
				}),
			};
		});
}

export function lifecycle(ctx: Ctx) {
	return {
		suspend: simple(
			ctx,
			"fleet.member.suspend",
			MemberState.ACTIVE,
			MemberState.SUSPENDED,
			"fleet.MemberSuspended",
		),
		resume: simple(
			ctx,
			"fleet.member.resume",
			MemberState.SUSPENDED,
			MemberState.ACTIVE,
			"fleet.MemberResumed",
		),
		unlock: simple(
			ctx,
			"fleet.member.unlock",
			MemberState.LOCKED,
			MemberState.ACTIVE,
			"fleet.MemberUnlocked",
		),
	};
}

/** Revocation: terminal from any state; tells the device at once through the control channel. */
function revocation(ctx: Ctx, record: MemberRecord, reason: string): Plan {
	if (record.state === MemberState.REVOKED) return unchanged(record);
	return step(ctx, record, "fleet.MemberRevoked", {
		state: MemberState.REVOKED,
		stateReason: reason,
	});
}

async function sendControl(
	ctx: Ctx,
	memberId: MemberId,
	kind: ControlKind,
	reason: string,
): Promise<void> {
	try {
		const control = create(MemberControlSchema, {
			memberId,
			kind,
			reason,
			at: ctx.nowIso(),
		});
		await ctx.deps.bus.control.send(
			await signEnvelope(
				ctx.deps.recordSigner,
				CONTROL_CONTEXT,
				toBinary(MemberControlSchema, control),
			),
			memberId,
		);
	} catch {
		// The record change is what revokes; the control message only makes it faster.
	}
}

export async function revoke(
	ctx: Ctx,
	memberId: string,
	request: LifecycleRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	const result = await transition(
		ctx,
		memberId,
		caller,
		"fleet.member.revoke",
		(state) => ({
			ok: true,
			value: revocation(ctx, state.record, request.reason || "revoked"),
		}),
	);
	const id = parseId(memberId);
	if (result.ok && id !== undefined)
		await sendControl(
			ctx,
			id,
			ControlKind.REVOKED,
			request.reason || "revoked",
		);
	return result;
}

/** `hobo fleet leave`: a device revokes itself with its own credential. */
export async function leave(
	ctx: Ctx,
	memberId: string,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	const device = asDevice(ctx.deps, caller);
	if (!device.ok) return device;
	if (device.value.memberId !== memberId)
		return refuse("forbidden", "a device can only leave for itself");
	const id = parseMemberId(memberId);
	return withRetry(ctx, async (index) => {
		const state = index.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${memberId}`);
		const plan = revocation(ctx, state.record, "left");
		if ((await commit(ctx, state, plan, caller)) === "conflict")
			return "conflict";
		return { ok: true, value: await ctx.signRecord(plan.record) };
	});
}

/** `hobo fleet member assign`: a membership in another fleet, under that fleet's policy. */
export async function assign(
	ctx: Ctx,
	memberId: string,
	request: MembershipRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	let fleetId: FleetId;
	let name: MemberName;
	try {
		fleetId = parseFleetId(request.fleet);
		name = parseMemberName(request.name);
	} catch {
		return refuse("invalid-request", "fleet and name must be short tokens");
	}
	const fleet = await ctx.fleet(fleetId);
	if (!fleet.ok) return fleet;
	const policy = fleet.value.policy;
	if (policy === undefined)
		return refuse("fleet-policy", "the fleet has no policy", {
			rule: "policy",
		});
	const person = asPerson(ctx.deps, caller);
	if (!person.ok) return person;
	const id = parseId(memberId);
	if (id === undefined)
		return refuse("member-unknown", `no member ${memberId}`);
	if ((await ctx.catchUp()).members.get(id) === undefined)
		return refuse("member-unknown", `no member ${memberId}`);
	const decision = await ctx.governed(
		personSubject(person.value),
		"fleet.member.assign",
		{ kind: "fleet-member", id, fleet: fleetId },
	);
	if (!decision.ok) return decision;
	return withRetry(ctx, async (index) => {
		const state = index.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${memberId}`);
		const { record } = state;
		const refusal = stateRefusal<SignedEnvelope>(record);
		if (refusal !== undefined) return refusal;
		const already = record.memberships.find((m) => m.fleet === fleetId);
		if (already !== undefined) {
			if (
				already.name === name &&
				already.roles.length === request.roles.length &&
				already.roles.every((role) => request.roles.includes(role))
			)
				return { ok: true, value: await ctx.signRecord(record) };
			return refuse("invalid-request", `${memberId} is already in ${fleetId}`);
		}
		if (record.kind !== MemberKind.DEVICE && request.roles.length > 0)
			return refuse("invalid-request", "only devices have roles");
		const checks = [
			checkKind(policy, record.kind),
			checkRoles(policy, request.roles),
			checkResidency(policy, record.region),
		];
		if (record.kind === MemberKind.DEVICE)
			checks.push(
				checkClass(policy, record.deviceClass),
				checkTier(policy, record.attestationTier),
			);
		for (const check of checks) if (!check.ok) return check;
		if (nameTaken(index, fleetId, name, id))
			return refuse("name-taken", `${name} is taken in ${fleetId}`);
		const plan = step(ctx, record, "fleet.MembershipAssigned", {
			memberships: [
				...record.memberships,
				create(MembershipSchema, {
					fleet: fleetId,
					name,
					roles: [...request.roles],
					joinedAt: ctx.nowIso(),
				}),
			],
		});
		if ((await commit(ctx, state, plan, caller)) === "conflict")
			return "conflict";
		return { ok: true, value: await ctx.signRecord(plan.record) };
	});
}

// ── Violation reports ──────────────────────────────────────────────────────

function verifiedBy(
	index: MembershipIndex,
	envelope: SignedEnvelope | undefined,
	context: typeof CLAIM_CONTEXT | typeof OFFER_CONTEXT,
	memberId: string,
): boolean {
	const id = parseId(memberId);
	const state = id === undefined ? undefined : index.members.get(id);
	const ref = signRefOf(decodeBundle(state?.record.keyBundle));
	return (
		envelope !== undefined &&
		ref !== undefined &&
		verifyEnvelope(envelope, context, ref)
	);
}

function decodeClaim(envelope: SignedEnvelope): Claim | undefined {
	try {
		return fromBinary(ClaimSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

/**
 * `POST /v1/fleet/reports`: a dispatcher's evidence that a device claimed out
 * of turn or out of fleet. The authority checks the evidence itself: the
 * offer is the reporter's own, each claim is signed by the claimant's SIGN
 * key and answers that offer, and `checkClaim` (L04's rules) gives the
 * verdict the report names. Then the claimant is suspended.
 */
export async function report(
	ctx: Ctx,
	request: ViolationReport,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	const device = asDevice(ctx.deps, caller);
	if (!device.ok) return device;
	const index = await ctx.catchUp();
	const reporter = index.members.get(device.value.memberId);
	if (reporter === undefined)
		return refuse("member-unknown", "unknown reporter");
	const refusal = stateRefusal<SignedEnvelope>(reporter.record);
	if (refusal !== undefined) return refusal;
	const evidence = (message: string): Outcome<SignedEnvelope> =>
		refuse("evidence-invalid", message);
	if (!verifiedBy(index, request.offer, OFFER_CONTEXT, device.value.memberId))
		return evidence("the offer is not signed by the reporting dispatcher");
	let offer: WorkOffer;
	try {
		// SAFETY: verifiedBy returned true, so the envelope is present.
		offer = fromBinary(
			WorkOfferSchema,
			(request.offer as SignedEnvelope).payload,
		);
	} catch {
		return evidence("the offer does not decode");
	}
	if (offer.dispatcher !== device.value.memberId)
		return evidence("the offer names another dispatcher");
	const dispatches = reporter.record.memberships.some(
		(m) => m.fleet === offer.fleet && m.roles.includes(Role.DISPATCHER),
	);
	if (!dispatches)
		return refuse(
			"forbidden",
			"the reporter is not a dispatcher in that fleet",
		);
	let fleet: FleetId;
	let digest: WorkDigest;
	try {
		fleet = parseFleetId(offer.fleet);
		digest = parseWorkDigest(offer.workDigest);
	} catch {
		return evidence("the offer names no valid fleet or digest");
	}
	const wanted =
		request.kind === "claim-not-entitled"
			? { count: 1, verdict: "not-entitled" }
			: request.kind === "claim-early"
				? { count: EARLY_CLAIMS, verdict: "early" }
				: undefined;
	if (wanted === undefined) return evidence("unknown report kind");
	if (request.claims.length !== wanted.count)
		return evidence(`a ${request.kind} report carries ${wanted.count} claims`);
	const claims: Claim[] = [];
	for (const envelope of request.claims) {
		const claim = decodeClaim(envelope);
		if (
			claim === undefined ||
			claim.fleet !== offer.fleet ||
			claim.workDigest !== offer.workDigest ||
			claim.dispatcher !== offer.dispatcher ||
			!verifiedBy(index, envelope, CLAIM_CONTEXT, claim.memberId)
		)
			return evidence(
				"a claim is not signed by its claimant or answers another offer",
			);
		claims.push(claim);
	}
	const claimant = claims[0]?.memberId ?? "";
	if (claims.some((claim) => claim.memberId !== claimant))
		return evidence("the claims are from different members");
	if (request.kind === "claim-early") {
		const times = claims.map((claim) => Date.parse(claim.claimedAt));
		if (
			new Set(claims.map((claim) => claim.claimedAt)).size !== claims.length ||
			times.some((time) => Number.isNaN(time)) ||
			Math.max(...times) - Math.min(...times) > EARLY_WINDOW_MS
		)
			return evidence("three distinct early claims inside one hour are needed");
	}
	for (const envelope of request.claims) {
		let verdict: string;
		try {
			verdict = await ctx.parts.checkClaim(envelope, { fleet, digest }, offer, {
				registry: ctx.deps.bus.registry,
				ranked: [],
				nowMs: ctx.deps.now(),
				stepMs: STEP_MS,
			});
		} catch {
			return refuse("unavailable", "the claim rules could not be applied");
		}
		if (verdict !== wanted.verdict)
			return evidence(`checkClaim says ${verdict}, not ${wanted.verdict}`);
	}
	const id = parseMemberId(claimant);
	return withRetry(ctx, async (current) => {
		const state = current.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${claimant}`);
		const events: EventInput<JsonObject>[] = [
			memberFact("fleet.ViolationReported", id, {
				kind: request.kind,
				reporter: device.value.memberId,
				workDigest: offer.workDigest,
			}),
		];
		let record = state.record;
		if (record.state === MemberState.ACTIVE) {
			record = nextRecord(
				record,
				{
					state: MemberState.SUSPENDED,
					stateReason: `violation:${request.kind}`,
				},
				ctx.nowIso(),
			);
			events.push(memberEvent("fleet.MemberSuspended", record));
		}
		if ((await commit(ctx, state, { events, record }, caller)) === "conflict")
			return "conflict";
		return { ok: true, value: await ctx.signRecord(record) };
	});
}

/** `tick`: PENDING enrollments whose token has expired become REJECTED. */
export async function expirePending(ctx: Ctx): Promise<void> {
	const index = await ctx.catchUp();
	for (const [id, state] of index.members) {
		if (!expired(ctx, state)) continue;
		await withRetry(ctx, async (current) => {
			const fresh = current.members.get(id);
			if (fresh === undefined || !expired(ctx, fresh))
				return { ok: true, value: true };
			const plan = rejectExpired(ctx, fresh.record);
			if ((await commit(ctx, fresh, plan, undefined)) === "conflict")
				return "conflict";
			return { ok: true, value: true };
		});
	}
}

/** Refuses approve-key and accept on an enrollment whose token has expired, rejecting it. */
export async function refuseIfExpired(
	ctx: Ctx,
	memberId: string,
): Promise<Outcome<true>> {
	const id = parseId(memberId);
	if (id === undefined) return { ok: true, value: true };
	const state = (await ctx.catchUp()).members.get(id);
	if (state === undefined || !expired(ctx, state))
		return { ok: true, value: true };
	await expirePending(ctx);
	return refuse(
		"token-expired",
		"the enrollment's bootstrap token has expired",
	);
}

export type { Person };
