/**
 * The accepting device's grant check (design §6.12 "Authorisation is the
 * same for all three"): the authority's signature against the pinned trust
 * record, the record's constraints (§7.2), the tenant, the time window, that
 * the grant names this device as acceptor and the proven peer as initiator,
 * that both members are `ACTIVE`, and that fleet policy allows the purpose.
 * Every refusal is `session-denied` with `detail.check` naming the check.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type MemberRecord,
	MemberState,
	type SessionGrant,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { SESSION_GRANT_CONTEXT } from "../contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseMemberId,
} from "../ids.js";
import { verifyEnvelope } from "../keys/index.js";
import type { Outcome, RegistryView } from "../ports.js";

/** How far ahead of this device's clock a grant's `issued_at` may be. */
const ISSUED_SKEW_MS = 60_000;
/** `SessionRequest.ttl_seconds` is at most 3600. */
const MAX_LIFETIME_MS = 3_600_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const denied = (check: string, message: string): Outcome<SessionGrant> => ({
	ok: false,
	error: { code: "session-denied", message, detail: { check } },
});

function memberIdOf(value: string): MemberId | undefined {
	try {
		return parseMemberId(value);
	} catch {
		return undefined;
	}
}

function fleetIdOf(value: string): FleetId | undefined {
	try {
		return parseFleetId(value);
	} catch {
		return undefined;
	}
}

function constraintsHold(grant: SessionGrant): boolean {
	if (grant.sessionId.length === 0) return false;
	switch (grant.purpose) {
		case SessionPurpose.SHELL:
			return true;
		case SessionPurpose.FORWARD:
			return grant.port >= 1 && grant.port <= 65_535;
		case SessionPurpose.BLOB:
			return (
				grant.blobDigests.length > 0 &&
				grant.blobDigests.every((digest) => SHA256.test(digest))
			);
		default:
			return false;
	}
}

async function activeMember(
	registry: RegistryView,
	value: string,
): Promise<MemberRecord | undefined> {
	const id = memberIdOf(value);
	if (id === undefined) return undefined;
	const record = await registry.member(id);
	return record?.state === MemberState.ACTIVE ? record : undefined;
}

async function purposeAllowed(
	registry: RegistryView,
	acceptor: MemberRecord,
	purpose: SessionPurpose,
): Promise<boolean> {
	for (const membership of acceptor.memberships) {
		const id = fleetIdOf(membership.fleet);
		if (id === undefined) continue;
		const fleet = await registry.fleet(id);
		if (fleet?.policy?.sessionPurposes.includes(purpose) === true) return true;
	}
	return false;
}

export async function authorise(
	peer: string,
	envelope: SignedEnvelope,
	context: Readonly<{ self: MemberId; registry: RegistryView; nowMs: number }>,
): Promise<Outcome<SessionGrant>> {
	if (envelope.context !== SESSION_GRANT_CONTEXT)
		return denied("context", "no session grant was presented");
	const trust = context.registry.trust();
	const key = trust.authorityKeys.find((ref) => ref.keyId === envelope.keyId);
	if (
		key === undefined ||
		!verifyEnvelope(envelope, SESSION_GRANT_CONTEXT, key)
	)
		return denied("signature", "the grant is not signed by the authority");
	let grant: SessionGrant;
	try {
		grant = fromBinary(SessionGrantSchema, envelope.payload);
	} catch {
		return denied("constraint", "the grant does not decode");
	}
	if (!constraintsHold(grant))
		return denied("constraint", "the grant breaks a record constraint");
	if (grant.tenant !== trust.tenant)
		return denied("tenant", "the grant is for another tenant");
	const issued = Date.parse(grant.issuedAt);
	const expires = Date.parse(grant.expiresAt);
	if (Number.isNaN(issued) || issued > context.nowMs + ISSUED_SKEW_MS)
		return denied("issued", "the grant is not yet valid");
	if (Number.isNaN(expires) || expires <= context.nowMs)
		return denied("expired", "the grant has expired");
	if (expires - issued > MAX_LIFETIME_MS)
		return denied("lifetime", "the grant lives longer than an hour");
	if (grant.acceptor?.memberId !== context.self)
		return denied("acceptor", "the grant names another acceptor");
	const initiator = grant.initiator;
	if (
		initiator === undefined ||
		peer.length === 0 ||
		initiator.transportIdentity !== peer
	)
		return denied("peer", "the peer is not the grant's initiator");
	const acceptor = await activeMember(context.registry, context.self);
	if (acceptor === undefined)
		return denied("acceptor-state", "this device is not ACTIVE");
	if (initiator.memberId.length > 0) {
		if (
			(await activeMember(context.registry, initiator.memberId)) === undefined
		)
			return denied("initiator-state", "the initiator is not ACTIVE");
	} else if (initiator.principal.length === 0) {
		return denied("initiator-state", "the initiator names no member or person");
	}
	if (!(await purposeAllowed(context.registry, acceptor, grant.purpose)))
		return denied("purpose", "fleet policy does not allow this purpose");
	return { ok: true, value: grant };
}
