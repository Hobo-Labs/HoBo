/**
 * Credentials with clone detection, and key rotation (§6.5 "Activation,
 * refresh and clone detection", §6.6; L02 private).
 *
 * The authority remembers the last `(generation, nonce digest)` it answered:
 * a request at the current generation is answered and the generation
 * advances; a request that repeats the previous generation with the same
 * nonce is a retry after a lost response and gets the same new generation
 * again; anything else means two agents hold one key, and the device is
 * LOCKED. Only the nonce's SHA-256 and the ticket id are journalled.
 */
import { randomBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { EventInput, JsonObject } from "@hobo/core";
import {
	type CredentialRequest,
	type CredentialResponse,
	CredentialResponseSchema,
	type KeyRotationRequest,
	MemberKind,
	type MemberRecord,
	MemberState,
	type RotationStatement,
	RotationStatementSchema,
	type SessionTicket,
	SessionTicketSchema,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { ROTATION_CONTEXT, SESSION_TICKET_CONTEXT } from "../contexts.js";
import { parseMemberId } from "../ids.js";
import {
	jwkThumbprint,
	parsePublicJwk,
	signEnvelope,
	verifyEnvelope,
} from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import { decodeBundle, signThumbprint, verifyBundle } from "./bundle.js";
import {
	actorOf,
	asDevice,
	type Ctx,
	type Device,
	refuse,
	sha256Hex,
	stateRefusal,
	withRetry,
} from "./context.js";
import {
	type MemberState as Folded,
	memberEvent,
	memberFact,
	memberStream,
	streamFact,
	thumbprintStream,
} from "./journal.js";
import { checkAgentVersion } from "./policy.js";
import { nextRecord } from "./records.js";

const SVID_TTL_MS = 15 * 60 * 1_000;
const TICKET_TTL_MS = 15 * 60 * 1_000;
const NONCE_BYTES = 16;

/** The device itself, active, proving its current SIGN key. */
async function self(
	ctx: Ctx,
	memberId: string,
	caller: VerifiedToken | undefined,
): Promise<Outcome<Device>> {
	const device = asDevice(ctx.deps, caller);
	if (!device.ok) return device;
	if (device.value.memberId !== memberId)
		return refuse("forbidden", "a device acts only for itself");
	return device;
}

async function fleetFloors(
	ctx: Ctx,
	record: MemberRecord,
	agentVersion: string,
): Promise<Outcome<true>> {
	if (agentVersion.length === 0) return { ok: true, value: true };
	for (const membership of record.memberships) {
		const fleet = await ctx.fleet(membership.fleet);
		if (!fleet.ok || fleet.value.policy === undefined) continue;
		const check = checkAgentVersion(
			fleet.value.policy,
			ctx.deps.discovery.minAgentVersion,
			agentVersion,
		);
		if (!check.ok) return check;
	}
	return { ok: true, value: true };
}

async function policyOf(ctx: Ctx, record: MemberRecord) {
	const fleet = await ctx.fleet(record.memberships[0]?.fleet ?? "");
	return fleet.ok ? fleet.value.policy : undefined;
}

export async function credentials(
	ctx: Ctx,
	memberId: string,
	request: CredentialRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<CredentialResponse>> {
	const device = await self(ctx, memberId, caller);
	if (!device.ok) return device;
	if (request.refreshNonce.length !== NONCE_BYTES)
		return refuse("invalid-request", "refresh_nonce must be 16 bytes");
	const id = parseMemberId(memberId);
	const nonceDigest = sha256Hex(request.refreshNonce);

	return withRetry(ctx, async (index) => {
		const state = index.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${memberId}`);
		const { record } = state;
		if (record.kind !== MemberKind.DEVICE)
			return refuse("forbidden", "only devices hold credentials");
		const refusal = stateRefusal<CredentialResponse>(record);
		if (refusal !== undefined) return refusal;
		if (device.value.jkt !== signThumbprintOf(record))
			return refuse("proof-invalid", "the proof is not made with the SIGN key");
		const floors = await fleetFloors(ctx, record, request.agentVersion);
		if (!floors.ok) return floors;

		const retry =
			state.last !== undefined &&
			request.generation + 1 === state.generation &&
			state.last.nonceDigest === nonceDigest;
		if (!retry && request.generation !== state.generation)
			return lock(ctx, state, caller);

		let current = record;
		const events: EventInput<JsonObject>[] = [];
		if (
			request.keyBundle !== undefined &&
			!sameBundle(record, request.keyBundle)
		) {
			const renewed = await renewBundle(ctx, record, request.keyBundle);
			if (!renewed.ok) return renewed;
			current = renewed.value;
			events.push(memberEvent("fleet.KeysRotated", current));
		}
		const ticketId = randomBytes(16).toString("hex");
		const generation = retry ? state.generation : state.generation + 1;
		if (!retry)
			events.push(
				memberFact("fleet.CredentialsIssued", id, {
					ticketId,
					generation,
					nonceDigest,
				}),
			);
		if (events.length > 0) {
			const appended = await ctx.append(
				memberStream(id),
				state.seq,
				events,
				actorOf(caller),
			);
			if (appended === "conflict") return "conflict";
			ctx.logEvents(events, id);
			if (current !== record) await ctx.publish(current);
		}
		return {
			ok: true,
			value: await respond(
				ctx,
				current,
				device.value,
				request,
				ticketId,
				generation,
			),
		};
	});
}

function signThumbprintOf(record: MemberRecord): string {
	return signThumbprint(decodeBundle(record.keyBundle));
}

function sameBundle(record: MemberRecord, bundle: SignedEnvelope): boolean {
	const held = record.keyBundle;
	return (
		held !== undefined &&
		Buffer.from(held.payload).equals(Buffer.from(bundle.payload)) &&
		Buffer.from(held.signature).equals(Buffer.from(bundle.signature))
	);
}

async function renewBundle(
	ctx: Ctx,
	record: MemberRecord,
	envelope: SignedEnvelope,
): Promise<Outcome<MemberRecord>> {
	const identity = parsePublicJwk(record.identityJwk);
	const policy = await policyOf(ctx, record);
	if (!identity.ok || policy === undefined)
		return refuse(
			"invalid-request",
			"the member's identity or fleet is unusable",
		);
	const bundle = verifyBundle(envelope, identity.value, record.memberId, {
		policy,
		nowMs: ctx.deps.now(),
		after: decodeBundle(record.keyBundle)?.sequence ?? 0,
	});
	if (!bundle.ok) return bundle;
	return {
		ok: true,
		value: nextRecord(record, { keyBundle: envelope }, ctx.nowIso()),
	};
}

/** Two agents hold one key: lock the device, refuse both (E16). */
async function lock(
	ctx: Ctx,
	state: Folded,
	caller: VerifiedToken | undefined,
): Promise<Outcome<CredentialResponse> | "conflict"> {
	const id = parseMemberId(state.record.memberId);
	const record = nextRecord(
		state.record,
		{ state: MemberState.LOCKED, stateReason: "generation-mismatch" },
		ctx.nowIso(),
	);
	const event = memberEvent("fleet.MemberLocked", record);
	const appended = await ctx.append(
		memberStream(id),
		state.seq,
		[event],
		actorOf(caller),
	);
	if (appended === "conflict") return "conflict";
	ctx.logEvents([event], id);
	await ctx.publish(record);
	return refuse(
		"generation-mismatch",
		"the refresh generation does not match: the device is locked",
	);
}

async function respond(
	ctx: Ctx,
	record: MemberRecord,
	device: Device,
	request: CredentialRequest,
	ticketId: string,
	generation: number,
): Promise<CredentialResponse> {
	const at = ctx.deps.now();
	const svid = await ctx.deps.issuer.issueMember({
		member: record,
		audiences:
			request.audiences.length > 0
				? request.audiences
				: [ctx.deps.discovery.issuer],
		jkt: device.jkt,
		ttlMs: SVID_TTL_MS,
	});
	const ticket: SessionTicket = create(SessionTicketSchema, {
		ticketId,
		memberId: record.memberId,
		tenant: ctx.deps.tenant,
		issuedAt: new Date(at).toISOString(),
		expiresAt: new Date(at + TICKET_TTL_MS).toISOString(),
		authorityIncarnation: ctx.deps.incarnation,
	});
	return create(CredentialResponseSchema, {
		svid: svid.token,
		svidExpiresAt: new Date(svid.expiresAtMs).toISOString(),
		sessionTicket: await signEnvelope(
			ctx.deps.recordSigner,
			SESSION_TICKET_CONTEXT,
			toBinary(SessionTicketSchema, ticket),
		),
		generation,
		memberRecord: await ctx.signRecord(record),
		trust: ctx.deps.bus.registry.trustEnvelope(),
	});
}

/**
 * `POST /v1/fleet/members/{id}/keys`: a new key bundle at any time; a new
 * identity key only with a rotation statement signed by the old one. The
 * member id never changes, and every thumbprint the member has had stays
 * bound to it, so a retired key can never enroll as a new device.
 */
export async function rotateKeys(
	ctx: Ctx,
	memberId: string,
	request: KeyRotationRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope>> {
	const device = await self(ctx, memberId, caller);
	if (!device.ok) return device;
	const id = parseMemberId(memberId);
	return withRetry(ctx, async (index) => {
		const state = index.members.get(id);
		if (state === undefined)
			return refuse("member-unknown", `no member ${memberId}`);
		const { record } = state;
		const refusal = stateRefusal<SignedEnvelope>(record);
		if (refusal !== undefined) return refusal;
		if (device.value.jkt !== signThumbprintOf(record))
			return refuse("proof-invalid", "the proof is not made with the SIGN key");
		if (
			request.keyBundle !== undefined &&
			sameBundle(record, request.keyBundle)
		)
			return { ok: true, value: await ctx.signRecord(record) };
		const policy = await policyOf(ctx, record);
		const current = parsePublicJwk(record.identityJwk);
		if (policy === undefined || !current.ok)
			return refuse(
				"invalid-request",
				"the member's identity or fleet is unusable",
			);

		let identity = current.value;
		let statement: RotationStatement | undefined;
		if (request.rotation !== undefined) {
			if (!verifyEnvelope(request.rotation, ROTATION_CONTEXT, current.value))
				return refuse(
					"proof-invalid",
					"the rotation statement is not signed by the current identity key",
				);
			try {
				statement = fromBinary(
					RotationStatementSchema,
					request.rotation.payload,
				);
			} catch {
				return refuse(
					"invalid-request",
					"the rotation statement does not decode",
				);
			}
			if (statement.memberId !== memberId)
				return refuse(
					"invalid-request",
					"the rotation statement names another member",
				);
			const next = parsePublicJwk(statement.newIdentityJwk);
			if (!next.ok) return refuse("invalid-request", next.error.message);
			identity = next.value;
		}
		const bundle = verifyBundle(request.keyBundle, identity, memberId, {
			policy,
			nowMs: ctx.deps.now(),
			after: decodeBundle(record.keyBundle)?.sequence ?? 0,
		});
		if (!bundle.ok) return bundle;

		if (statement === undefined) {
			const next = nextRecord(
				record,
				{ keyBundle: request.keyBundle },
				ctx.nowIso(),
			);
			return finish(ctx, state, next, "fleet.KeysRotated", caller);
		}
		const thumbprint = jwkThumbprint(identity);
		const bound = index.thumbprints.get(thumbprint);
		if (bound !== undefined && bound.memberId !== id)
			return refuse(
				"key-known",
				"the new identity key belongs to another member",
			);
		if (bound === undefined) {
			const bind = await ctx.append(
				thumbprintStream(thumbprint),
				0,
				[
					streamFact("fleet.ThumbprintBound", thumbprintStream(thumbprint), {
						thumbprint,
						memberId: id,
					}),
				],
				actorOf(caller),
			);
			if (bind === "conflict") return "conflict";
		}
		const next = nextRecord(
			record,
			{
				identityJwk: JSON.stringify(identity),
				identityThumbprint: thumbprint,
				retiredThumbprints: [
					...record.retiredThumbprints,
					record.identityThumbprint,
				],
				keyBundle: request.keyBundle,
			},
			ctx.nowIso(),
		);
		return finish(ctx, state, next, "fleet.IdentityKeyRotated", caller);
	});
}

async function finish(
	ctx: Ctx,
	state: Folded,
	next: MemberRecord,
	type: "fleet.KeysRotated" | "fleet.IdentityKeyRotated",
	caller: VerifiedToken | undefined,
): Promise<Outcome<SignedEnvelope> | "conflict"> {
	const id = parseMemberId(next.memberId);
	const event = memberEvent(type, next);
	const appended = await ctx.append(
		memberStream(id),
		state.seq,
		[event],
		actorOf(caller),
	);
	if (appended === "conflict") return "conflict";
	ctx.logEvents([event], id);
	await ctx.publish(next);
	return { ok: true, value: await ctx.signRecord(next) };
}
