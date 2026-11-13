/**
 * `@hobo/fleet/membership` enrollment authority (L02): composes the parts the
 * other authority lanes build (sign-in, recorder, projection, fleet commands,
 * audit) and implements the member and token methods of `FleetApi` itself
 * (§6.5, §6.13, §7.5). State lives only in the `FleetEventStore`; every
 * command reads its stream, decides, and appends with `expectedSeq`, so any
 * number of instances on one store agree.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	AuditCheckpointSchema,
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	AuthorityDiscoverySchema,
	MemberListSchema,
	type WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { parseMemberId } from "../ids.js";
import type {
	AuthorityDeps,
	AuthorityParts,
	EnrollmentAuthority,
	Outcome,
	VerifiedToken,
} from "../ports.js";
import { authenticate } from "./auth.js";
import { asPerson, asReader, type Ctx, createCtx, refuse } from "./context.js";
import { credentials, rotateKeys } from "./credentials.js";
import {
	declare,
	enroll,
	issueToken,
	listTokens,
	revokeToken,
} from "./enroll.js";
import {
	accept,
	approveKey,
	assign,
	expirePending,
	leave,
	lifecycle,
	refuseIfExpired,
	reject,
	report,
	revoke,
} from "./lifecycle.js";
import { discoveryOf } from "./records.js";

const AUDITOR_TAG = "auditor";

export function createEnrollmentAuthority(
	deps: AuthorityDeps,
	parts: AuthorityParts,
): EnrollmentAuthority {
	const ctx = createCtx(deps, parts);
	const moves = lifecycle(ctx);
	const checkpoints: WitnessedEnvelope[] = [];
	deps.bus.audit.onWitnessed(async (checkpoint) => {
		checkpoints.push(checkpoint);
	});

	const auditor = (caller: VerifiedToken | undefined): Outcome<true> => {
		const person = asPerson(deps, caller);
		if (!person.ok) return person;
		return person.value.tags.includes(AUDITOR_TAG)
			? { ok: true, value: true }
			: refuse("forbidden", "the audit routes need the auditor tag");
	};
	const reader = (caller: VerifiedToken | undefined): Outcome<true> => {
		const read = asReader(deps, caller);
		return read.ok ? { ok: true, value: true } : read;
	};

	return {
		// ── Discovery ──────────────────────────────────────────────────────
		async authorityDiscovery() {
			return {
				ok: true,
				value: create(AuthorityDiscoverySchema, {
					issuer: deps.discovery.issuer,
					jwksUri: `${deps.discovery.issuer}/v1/fleet/jwks`,
					signInProviders: deps.signIn.map((provider) => provider.id),
				}),
			};
		},
		async discovery(request) {
			if (request.tenant !== deps.tenant)
				return refuse(
					"invalid-request",
					"this authority does not serve that tenant",
					{
						tenant: request.tenant,
					},
				);
			return { ok: true, value: discoveryOf(deps) };
		},
		async jwks() {
			return { ok: true, value: { jwks: deps.issuer.jwks() } };
		},

		// ── Sign-in (parts.signIn) ─────────────────────────────────────────
		signInStart: (request) => parts.signIn.start(request),
		signInCallback: (request) => parts.signIn.callback(request),
		signInDevice: (request) => parts.signIn.device(request),
		approval: (request) => parts.signIn.approval(request.state),
		approve: (request) => parts.signIn.approve(request),
		// The DPoP proof of these three is not in the method's signature (see the lane README).
		signInComplete: (request) => parts.signIn.complete(request, ""),
		signInPoll: (request) => parts.signIn.poll(request, ""),
		async signInRefresh(_request, caller) {
			if (caller === undefined)
				return refuse("unauthenticated", "refresh needs a person token");
			return parts.signIn.refresh(caller, "");
		},

		// ── Tokens and enrollment ──────────────────────────────────────────
		issueToken: (request, caller) => issueToken(ctx, request, caller),
		listTokens: (_request, caller) => listTokens(ctx, caller),
		revokeToken: (request, caller) =>
			revokeToken(ctx, request.tokenHash, caller),
		enroll: (request, caller) => enroll(ctx, request, caller),
		declare: (request, caller) => declare(ctx, request, caller),

		// ── Lifecycle ──────────────────────────────────────────────────────
		async approveKey(request, caller) {
			const live = await refuseIfExpired(ctx, request.memberId);
			if (!live.ok) return live;
			return approveKey(ctx, request.memberId, request.request, caller);
		},
		async accept(request, caller) {
			const live = await refuseIfExpired(ctx, request.memberId);
			if (!live.ok) return live;
			return accept(ctx, request.memberId, request.request, caller);
		},
		reject: (request, caller) =>
			reject(ctx, request.memberId, request.request, caller),
		suspend: (request, caller) =>
			moves.suspend(request.memberId, request.request, caller),
		resume: (request, caller) =>
			moves.resume(request.memberId, request.request, caller),
		unlock: (request, caller) =>
			moves.unlock(request.memberId, request.request, caller),
		revoke: (request, caller) =>
			revoke(ctx, request.memberId, request.request, caller),
		assign: (request, caller) =>
			assign(ctx, request.memberId, request.request, caller),
		credentials: (request, caller) =>
			credentials(ctx, request.memberId, request.request, caller),
		rotateKeys: (request, caller) =>
			rotateKeys(ctx, request.memberId, request.request, caller),
		leave: (request, caller) => leave(ctx, request.memberId, caller),
		report: (request, caller) => report(ctx, request, caller),

		// ── Member reads ───────────────────────────────────────────────────
		async listMembers(request, caller) {
			const read = reader(caller);
			if (!read.ok) return read;
			const index = await ctx.catchUp();
			const records = [...index.members.values()]
				.map((state) => state.record)
				.filter(
					(record) =>
						request.fleet === undefined ||
						record.memberships.some((m) => m.fleet === request.fleet),
				)
				.sort((a, b) => a.memberId.localeCompare(b.memberId));
			return {
				ok: true,
				value: create(MemberListSchema, {
					members: await Promise.all(records.map((r) => ctx.signRecord(r))),
				}),
			};
		},
		async getMember(request, caller) {
			const read = reader(caller);
			if (!read.ok) return read;
			return memberRead(ctx, request.memberId);
		},

		// ── Fleets, sessions, work (parts.fleets, parts.recorder) ──────────
		listFleets: (request, caller) => parts.fleets.listFleets(request, caller),
		getFleet: (request, caller) => parts.fleets.getFleet(request, caller),
		defineFleet: (request, caller) => parts.fleets.defineFleet(request, caller),
		fleetView: (request, caller) => parts.fleets.fleetView(request, caller),
		fleetVerdict: (request, caller) =>
			parts.fleets.fleetVerdict(request, caller),
		grantSession: (request, caller) =>
			parts.fleets.grantSession(request, caller),
		submitWork: (request, caller) => parts.fleets.submitWork(request, caller),
		async workStatus(request, caller) {
			const read = reader(caller);
			if (!read.ok) return read;
			return parts.recorder.workStatus(request.submissionId);
		},
		async workLogs(request, caller) {
			const read = reader(caller);
			if (!read.ok) return read;
			return parts.recorder.workLogs(request.submissionId);
		},

		// ── Audit reads ────────────────────────────────────────────────────
		async auditCheckpoints(request, caller) {
			const allowed = auditor(caller);
			if (!allowed.ok) return allowed;
			const from = request.fromSequence ?? 0;
			return {
				ok: true,
				value: create(AuditCheckpointsSchema, {
					checkpoints: checkpoints.filter((checkpoint) => {
						try {
							const payload = checkpoint.authority?.payload;
							return (
								payload !== undefined &&
								fromBinary(AuditCheckpointSchema, payload).sequence >= from
							);
						} catch {
							return false;
						}
					}),
				}),
			};
		},
		async auditEntries(request, caller) {
			const allowed = auditor(caller);
			if (!allowed.ok) return allowed;
			if (
				!Number.isSafeInteger(request.from) ||
				!Number.isSafeInteger(request.to) ||
				request.from < 0 ||
				request.to < request.from
			)
				return refuse("invalid-request", "from and to must be a range");
			try {
				const entries = await deps.bus.audit.entries(request.from, request.to);
				return {
					ok: true,
					value: create(AuditEntriesSchema, { entries: [...entries] }),
				};
			} catch {
				return refuse("unavailable", "the audit log could not be read");
			}
		},

		authenticate: (request) => authenticate(ctx, request),
		async tick() {
			await expirePending(ctx);
			await parts.projection.tick();
			await parts.audit.tick();
		},
	};
}

async function memberRead(ctx: Ctx, memberId: string) {
	let id: ReturnType<typeof parseMemberId>;
	try {
		id = parseMemberId(memberId);
	} catch {
		return refuse<never>("member-unknown", `no member ${memberId}`);
	}
	const state = (await ctx.catchUp()).members.get(id);
	if (state === undefined)
		return refuse<never>("member-unknown", `no member ${memberId}`);
	return { ok: true as const, value: await ctx.signRecord(state.record) };
}
