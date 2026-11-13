/**
 * `grantSession` (L32, private): the authority's half of §6.12. A grant names
 * both parties with their transport identity and seal key, the purpose, the
 * optional target and an expiry, and is signed under
 * `hobo-fleet/session-grant/v1`. The peer must be an `ACTIVE` device; a
 * device initiator must be `ACTIVE`, present its own registered keys, and
 * share a fleet with the peer; some fleet of the peer (shared with a device
 * initiator) must list the purpose; and `fleet.session.grant` is governed.
 * Each grant is journalled as `fleet.SessionGranted` on
 * `fleet-session-<sessionId>`.
 */
import { randomBytes } from "node:crypto";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import {
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	type MemberRecord,
	MemberState,
	type SessionGrant,
	SessionGrantSchema,
	type SessionParty,
	SessionPartySchema,
	SessionPurpose,
	type SessionRequest,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { SESSION_GRANT_CONTEXT } from "../contexts.js";
import { type MemberId, parseMemberId } from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import type { FleetIndex } from "./journal.js";
import { isSha256 } from "./policy.js";
import {
	actorOf,
	append,
	type Device,
	type FleetDeps,
	governed,
	iso,
	logEvent,
	MAX_ATTEMPTS,
	ok,
	type Person,
	type PolicyActor,
	pbJson,
	principalKey,
	refuse,
} from "./support.js";

const SESSION_STREAM = "fleet-session-";
/** §7.1: a grant lives at most an hour. */
const MAX_TTL_SECONDS = 3_600;
/** What a request that names no ttl gets. */
const DEFAULT_TTL_SECONDS = 600;
const MAX_PORT = 65_535;

function invalid<T>(message: string): Outcome<T> {
	return refuse("invalid-request", message);
}

/** The refusal a member's state means for a party that must be ACTIVE. */
function stateRefusal<T>(record: MemberRecord): Outcome<T> | undefined {
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

function bundleOf(record: MemberRecord): KeyBundle | undefined {
	const payload = record.keyBundle?.payload;
	if (payload === undefined || payload.length === 0) return undefined;
	try {
		return fromBinary(KeyBundleSchema, payload);
	} catch {
		return undefined;
	}
}

function keyOf(bundle: KeyBundle | undefined, purpose: KeyPurpose): string {
	return bundle?.keys.find((key) => key.purpose === purpose)?.value ?? "";
}

/** The request's own constraints (§7.2 `SessionRequest`), and its ttl. */
function checkRequest(request: SessionRequest): Outcome<number> {
	if (
		request.purpose !== SessionPurpose.SHELL &&
		request.purpose !== SessionPurpose.FORWARD &&
		request.purpose !== SessionPurpose.BLOB
	)
		return invalid("purpose must be SHELL, FORWARD or BLOB");
	if (
		request.purpose === SessionPurpose.FORWARD &&
		(request.port < 1 || request.port > MAX_PORT)
	)
		return invalid("a forward names a port from 1 to 65535");
	if (request.purpose === SessionPurpose.BLOB) {
		if (request.blobDigests.length === 0)
			return invalid("a blob session names its digests");
		if (request.blobDigests.some((digest) => !isSha256(digest)))
			return invalid("blob digests are sha256:<64 hex>");
	}
	if (request.ttlSeconds > MAX_TTL_SECONDS)
		return invalid("a session lives at most 3600 seconds");
	const initiator = request.initiator;
	if (
		initiator === undefined ||
		initiator.transportIdentity === "" ||
		initiator.sealPublicKey === ""
	)
		return invalid("the initiator names its transport identity and seal key");
	return ok(
		request.ttlSeconds === 0 ? DEFAULT_TTL_SECONDS : request.ttlSeconds,
	);
}

type Initiator = Readonly<{
	party: SessionParty;
	subject: PolicyActor;
	/** The device initiator's fleets; undefined for a person. */
	fleets: ReadonlySet<string> | undefined;
	record: MemberRecord | undefined;
}>;

async function deviceInitiator(
	deps: FleetDeps,
	caller: Device,
	request: SessionRequest,
	peer: MemberId,
): Promise<Outcome<Initiator>> {
	const presented = request.initiator;
	if (presented === undefined) return invalid("the initiator is missing");
	if (presented.memberId !== "" && presented.memberId !== caller.memberId)
		return invalid("a device initiates sessions only as itself");
	if (peer === caller.memberId)
		return invalid("a device does not open a session with itself");
	const self = await deps.bus.registry.member(caller.memberId);
	if (self === undefined)
		return refuse("member-unknown", `no member ${caller.memberId}`);
	const refused = stateRefusal<Initiator>(self);
	if (refused !== undefined) return refused;
	const bundle = bundleOf(self);
	const transport = keyOf(bundle, KeyPurpose.TRANSPORT) || self.memberId;
	if (
		presented.transportIdentity !== transport ||
		presented.sealPublicKey !== keyOf(bundle, KeyPurpose.SEAL)
	)
		return invalid("the initiator's keys are not the ones registered for it");
	return ok({
		party: create(SessionPartySchema, {
			memberId: self.memberId,
			principal: self.owner,
			transportIdentity: presented.transportIdentity,
			sealPublicKey: presented.sealPublicKey,
		}),
		subject: { identity: self.memberId, tags: [] },
		fleets: new Set(self.memberships.map((membership) => membership.fleet)),
		record: self,
	});
}

function personInitiator(person: Person, request: SessionRequest): Initiator {
	return {
		party: create(SessionPartySchema, {
			memberId: "",
			principal: principalKey(person.principal),
			transportIdentity: request.initiator?.transportIdentity ?? "",
			sealPublicKey: request.initiator?.sealPublicKey ?? "",
		}),
		subject: { identity: principalKey(person.principal), tags: person.tags },
		fleets: undefined,
		record: undefined,
	};
}

/** Who may ask: a person or a device of this tenant. */
function callerOf(
	deps: FleetDeps,
	caller: VerifiedToken | undefined,
): Outcome<Person | Device> {
	if (
		caller === undefined ||
		(caller.kind !== "person" && caller.kind !== "member")
	)
		return refuse("unauthenticated", "a session needs a person or a device");
	if (caller.tenant !== deps.tenant)
		return refuse("forbidden", "the credential is for another tenant");
	return ok(caller);
}

export async function grantSession(
	deps: FleetDeps,
	fleets: () => Promise<FleetIndex>,
	request: SessionRequest,
	token: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	const caller = callerOf(deps, token);
	if (!caller.ok) return caller;
	const ttl = checkRequest(request);
	if (!ttl.ok) return ttl;
	let peerId: MemberId;
	try {
		peerId = parseMemberId(request.peer, "peer");
	} catch {
		return invalid("peer must be a member id");
	}
	const peer = await deps.bus.registry.member(peerId);
	if (peer === undefined || peer.tenant !== deps.tenant)
		return refuse("member-unknown", `no member ${request.peer}`);
	if (peer.kind !== MemberKind.DEVICE)
		return invalid("sessions are opened to devices only");
	const peerRefused = stateRefusal<SignedEnvelope>(peer);
	if (peerRefused !== undefined) return peerRefused;
	const peerBundle = bundleOf(peer);
	const peerSeal = keyOf(peerBundle, KeyPurpose.SEAL);
	if (peerSeal === "") return invalid("the peer has no registered seal key");

	const initiator =
		caller.value.kind === "member"
			? await deviceInitiator(deps, caller.value, request, peerId)
			: ok(personInitiator(caller.value, request));
	if (!initiator.ok) return initiator;

	// A fleet of the peer (shared with a device initiator) whose policy allows the purpose.
	const index = await fleets();
	const candidates = peer.memberships
		.map((membership) => membership.fleet)
		.filter((fleet) => initiator.value.fleets?.has(fleet) ?? true)
		.sort();
	const fleet = candidates.find((id) =>
		[...index.values()].some(
			(state) =>
				state.record.fleetId === id &&
				(state.record.policy?.sessionPurposes ?? []).includes(request.purpose),
		),
	);
	if (fleet === undefined)
		return refuse(
			"fleet-policy",
			"no fleet the parties share allows this session purpose",
			{ rule: "session-purpose" },
		);

	const subject: PolicyActor =
		initiator.value.record === undefined
			? initiator.value.subject
			: {
					identity: initiator.value.subject.identity,
					tags: (
						initiator.value.record.memberships.find(
							(membership) => membership.fleet === fleet,
						)?.roles ?? []
					).map((role) => `role:${role}`),
				};
	const decision = await governed(deps, subject, "fleet.session.grant", {
		kind: "fleet-member",
		id: peerId,
		fleet,
	});
	if (!decision.ok) return decision;

	const nowMs = deps.now();
	const base: Omit<SessionGrant, "sessionId" | "$typeName" | "$unknown"> = {
		tenant: deps.tenant,
		initiator: initiator.value.party,
		acceptor: create(SessionPartySchema, {
			memberId: peer.memberId,
			principal: peer.owner,
			transportIdentity:
				keyOf(peerBundle, KeyPurpose.TRANSPORT) || peer.memberId,
			sealPublicKey: peerSeal,
		}),
		purpose: request.purpose,
		orderId: request.orderId,
		port: request.purpose === SessionPurpose.FORWARD ? request.port : 0,
		blobDigests:
			request.purpose === SessionPurpose.BLOB ? [...request.blobDigests] : [],
		issuedAt: iso(nowMs),
		expiresAt: iso(nowMs + ttl.value * 1_000),
	};
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const grant = create(SessionGrantSchema, {
			...base,
			sessionId: randomBytes(16).toString("hex"),
		});
		const stream = `${SESSION_STREAM}${grant.sessionId}`;
		const appended = await append(
			deps,
			stream,
			0,
			[
				{
					type: "fleet.SessionGranted",
					data: {
						subject: stream,
						subjectSequence: 0,
						sessionId: grant.sessionId,
						fleet,
						purpose: grant.purpose,
						initiator:
							initiator.value.party.memberId || initiator.value.party.principal,
						acceptor: peer.memberId,
						expiresAt: grant.expiresAt,
						grant: pbJson(toJson(SessionGrantSchema, grant)),
					},
				},
			],
			actorOf(caller.value),
		);
		if (appended === "conflict") continue;
		logEvent(deps, "fleet.SessionGranted", stream);
		return ok(
			await signEnvelope(
				deps.recordSigner,
				SESSION_GRANT_CONTEXT,
				toBinary(SessionGrantSchema, grant),
			),
		);
	}
	return refuse("conflict", "no free session id after retries");
}
