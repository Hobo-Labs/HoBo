/**
 * What every enrollment command shares (L02, private): the folded index and
 * its catch-up from `readAll`, compare-and-set appends with retry, signing of
 * member records, refusals, logging, and the caller checks.
 */
import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type EventInput,
	type EventPosition,
	type JsonObject,
	OptimisticSequenceConflictError,
	type PolicyDecision,
	type PrincipalRef,
} from "@hobo/core";
import {
	type FleetRecord,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { MEMBER_RECORD_CONTEXT } from "../contexts.js";
import type { FleetErrorCode } from "../errors.js";
import { FLEET_LOG_EVENTS, type FleetEventType } from "../events.js";
import { decideGoverned } from "../governed.js";
import { type FleetId, type MemberId, parseFleetId } from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import type {
	AuthorityDeps,
	AuthorityParts,
	FleetFailure,
	FleetLogEvent,
	Outcome,
	VerifiedToken,
} from "../ports.js";
import { applyEvent, emptyIndex, type MembershipIndex } from "./journal.js";

/** Up to 8 compare-and-set attempts per command (§7.5). */
const MAX_ATTEMPTS = 8;
/** A member record is valid for at most 30 minutes after it is signed (§7.1). */
const RECORD_TTL_MS = 30 * 60 * 1_000;
const AUTHORITY_ACTOR: PrincipalRef = {
	kind: "service",
	id: "hobo-fleet-authority",
};

/** domain-view: who a governed decision is about (the subject of a PolicyRequest, before the tenant is added). */
export type PolicyActor = Readonly<{
	identity: string;
	tags: readonly string[];
}>;
export type Person = Extract<VerifiedToken, { kind: "person" }>;
export type Device = Extract<VerifiedToken, { kind: "member" }>;

export type Ctx = Readonly<{
	deps: AuthorityDeps;
	parts: AuthorityParts;
	index: MembershipIndex;
	catchUp(): Promise<MembershipIndex>;
	/** Appends at `expectedSeq`; "conflict" when another writer got there first. */
	append(
		stream: string,
		expectedSeq: number,
		events: readonly EventInput<JsonObject>[],
		actor: PrincipalRef,
	): Promise<"appended" | "conflict">;
	nowIso(): string;
	signRecord(record: MemberRecord): Promise<SignedEnvelope>;
	/** Publishes the signed record to the registry at once (revocation and locks take effect on live readers). */
	publish(record: MemberRecord): Promise<void>;
	logEvents(events: readonly EventInput<JsonObject>[], id: string): void;
	governed(
		subject: PolicyActor,
		action: string,
		resource: Readonly<{ kind: string; id: string; fleet: string }>,
	): Promise<Outcome<PolicyDecision>>;
	fleet(id: string): Promise<Outcome<FleetRecord>>;
}>;

export function createCtx(deps: AuthorityDeps, parts: AuthorityParts): Ctx {
	const index = emptyIndex();
	let position: EventPosition | undefined;
	let catching: Promise<MembershipIndex> | undefined;

	const catchUpOnce = async (): Promise<MembershipIndex> => {
		const options = position === undefined ? {} : { after: position };
		for await (const positioned of deps.store.readAll(options)) {
			applyEvent(index, positioned.event);
			position = positioned.position;
		}
		return index;
	};

	const ctx: Ctx = {
		deps,
		parts,
		index,
		catchUp() {
			// One reader at a time; a caller arriving mid-read waits for it and reads again.
			const run = (catching ?? Promise.resolve(index)).then(catchUpOnce);
			catching = run.catch(() => index);
			return run;
		},
		async append(stream, expectedSeq, events, actor) {
			try {
				await deps.store.append(stream, [...events], {
					expectedSeq,
					actor,
					tenant: deps.tenant,
				});
				return "appended";
			} catch (error) {
				if (error instanceof OptimisticSequenceConflictError) return "conflict";
				throw error;
			}
		},
		nowIso() {
			return new Date(deps.now()).toISOString();
		},
		async signRecord(record) {
			const at = deps.now();
			const signed = create(MemberRecordSchema, {
				...record,
				authorityIncarnation: deps.incarnation,
				issuedAt: new Date(at).toISOString(),
				notAfter: new Date(at + RECORD_TTL_MS).toISOString(),
			});
			return signEnvelope(
				deps.recordSigner,
				MEMBER_RECORD_CONTEXT,
				toBinary(MemberRecordSchema, signed),
			);
		},
		async publish(record) {
			try {
				await deps.bus.publisher.putMember(
					await ctx.signRecord(record),
					// SAFETY: every record in the index came from a parsed member id.
					record.memberId as MemberId,
				);
			} catch {
				// The projection re-publishes on its next tick; the journal is the truth.
			}
		},
		logEvents(events, id) {
			for (const event of events) {
				const name = logNameOf(event.type);
				if (name !== undefined)
					deps.log(name, { subject: id, tenant: deps.tenant });
			}
		},
		async governed(subject, action, resource) {
			return decideGoverned(deps, {
				subject: {
					identity: subject.identity,
					tenantId: deps.tenant,
					tags: subject.tags,
				},
				action,
				resource: {
					kind: resource.kind,
					id: resource.id,
					tenantId: deps.tenant,
					attributes: { fleet: resource.fleet },
				},
			});
		},
		async fleet(id) {
			let fleetId: FleetId;
			try {
				fleetId = parseFleetId(id);
			} catch {
				return refuse("invalid-request", "fleet must be a short token");
			}
			const record = await deps.bus.registry.fleet(fleetId);
			if (record === undefined || record.tenant !== deps.tenant)
				return refuse("fleet-unknown", `no fleet ${id}`, { fleet: id });
			return { ok: true, value: record };
		},
	};
	return ctx;
}

/** Runs `attempt` until its append lands, at most 8 times (§7.5). */
export async function withRetry<T>(
	ctx: Ctx,
	attempt: (index: MembershipIndex) => Promise<Outcome<T> | "conflict">,
): Promise<Outcome<T>> {
	for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
		const result = await attempt(await ctx.catchUp());
		if (result !== "conflict") return result;
	}
	return refuse("conflict", "another writer kept winning the compare-and-set");
}

export function refuse<T>(
	code: FleetErrorCode,
	message: string,
	detail?: Readonly<Record<string, string>>,
): Outcome<T> {
	const error: FleetFailure =
		detail === undefined ? { code, message } : { code, message, detail };
	return { ok: false, error };
}

export function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

/** The policy subject of a signed-in person. */
export function personSubject(person: Person): PolicyActor {
	return { identity: principalKey(person.principal), tags: person.tags };
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function actorOf(caller: VerifiedToken | undefined): PrincipalRef {
	if (caller === undefined) return AUTHORITY_ACTOR;
	if (caller.kind === "person" || caller.kind === "account")
		return caller.principal;
	if (caller.kind === "member") return { kind: "agent", id: caller.memberId };
	return { kind: "service", id: `${caller.issuer}#${caller.subject}` };
}

/** A person of this tenant, or the refusal. */
export function asPerson(
	deps: AuthorityDeps,
	caller: VerifiedToken | undefined,
): Outcome<Person> {
	if (caller === undefined || caller.kind !== "person")
		return refuse("unauthenticated", "this route needs a person token");
	if (caller.tenant !== deps.tenant)
		return refuse("forbidden", "the person token is for another tenant");
	return { ok: true, value: caller };
}

/** A member of this tenant, or the refusal. */
export function asDevice(
	deps: AuthorityDeps,
	caller: VerifiedToken | undefined,
): Outcome<Device> {
	if (caller === undefined || caller.kind !== "member")
		return refuse("unauthenticated", "this route needs a device credential");
	if (caller.tenant !== deps.tenant)
		return refuse("forbidden", "the credential is for another tenant");
	return { ok: true, value: caller };
}

/** Readers: a person, a device or an account credential of this tenant. */
export function asReader(
	deps: AuthorityDeps,
	caller: VerifiedToken | undefined,
): Outcome<VerifiedToken> {
	if (
		caller === undefined ||
		(caller.kind !== "person" &&
			caller.kind !== "member" &&
			caller.kind !== "account")
	)
		return refuse("unauthenticated", "this route needs a credential");
	if (caller.tenant !== deps.tenant)
		return refuse("forbidden", "the credential is for another tenant");
	return { ok: true, value: caller };
}

/** The refusal a member's state means for a route that needs it ACTIVE. */
export function stateRefusal<T>(record: MemberRecord): Outcome<T> | undefined {
	switch (record.state) {
		case MemberState.ACTIVE:
			return undefined;
		case MemberState.PENDING:
			return refuse("approval-pending", `${record.memberId} is pending`);
		case MemberState.SUSPENDED:
			return refuse("member-suspended", `${record.memberId} is suspended`);
		case MemberState.LOCKED:
			return refuse("member-locked", `${record.memberId} is locked`);
		case MemberState.REVOKED:
			return refuse("member-revoked", `${record.memberId} is revoked`);
		default:
			return refuse("forbidden", `${record.memberId} is not active`);
	}
}

const LOG_NAMES: ReadonlySet<string> = new Set(FLEET_LOG_EVENTS);

/** `fleet.MemberRevoked` → `hobo_fleet_member_revoked` (§7.5). */
function logNameOf(type: string): FleetLogEvent | undefined {
	const name = `hobo_fleet_${type
		.replace(/^fleet\./u, "")
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()}`;
	return LOG_NAMES.has(name)
		? FLEET_LOG_EVENTS.find((candidate) => candidate === name)
		: undefined;
}

export type { FleetEventType };
