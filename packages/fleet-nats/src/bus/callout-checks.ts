/**
 * The seven checks the callout responder makes before it mints a credential
 * (§6.7, the connect sequence step 3), in order:
 *
 * 1. `request-signature`: the server's signature on the request (checked by
 *    the wire, which passes the result in);
 * 2. `ticket`: the ticket's authority signature, expiry and incarnation;
 * 3. `proof-ticket`: the proof names that ticket;
 * 4. `proof-signature`: the proof verifies against the `SIGN` key in the
 *    device's current registry record;
 * 5. `nonce`: the proof's nonce is the one the server reports for this
 *    connection; a proof without one (assumption A2's fallback) makes the
 *    ticket single use, recorded in the replay bucket;
 * 6. `not-active`: the device is `ACTIVE` and holds a role;
 * 7. `tenant`: the ticket and the record are this account's tenant.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type Clock,
	ConnectProofSchema,
	KEY_BUNDLE_CONTEXT,
	KeyBundleSchema,
	KeyPurpose,
	type MemberId,
	MemberKind,
	MemberState,
	NATS_CONNECT_CONTEXT,
	parseMemberId,
	type RegistryView,
	type ReplayStore,
	SESSION_TICKET_CONTEXT,
	type SessionTicket,
	SessionTicketSchema,
} from "@hobo/fleet";
import { parsePublicJwk, verifyEnvelope } from "@hobo/fleet/keys";
import { decodeConnectToken } from "./connect-token.js";
import { authoritySigned } from "./registry-view.js";
import { type DeviceTemplate, templateFor } from "./templates.js";

export type CalloutCheck =
	| "request-signature"
	| "ticket"
	| "proof-ticket"
	| "proof-signature"
	| "nonce"
	| "not-active"
	| "tenant";

// public-contract: the check names are the `check` field of hobo_fleet_callout_refused.
export const CALLOUT_CHECKS: readonly CalloutCheck[] = [
	"request-signature",
	"ticket",
	"proof-ticket",
	"proof-signature",
	"nonce",
	"not-active",
	"tenant",
];

/** The replay scope of single-use connect tickets. */
// public-contract: the key scope in the fleet-replay bucket, shared by every responder replica.
export const TICKET_REPLAY_SCOPE = "nats-ticket";

export type CalloutVerdict = Readonly<
	| {
			ok: true;
			memberId: MemberId;
			template: DeviceTemplate;
			expiresAtMs: number;
	  }
	| { ok: false; check: CalloutCheck; reason: string }
>;

export type CalloutInput = Readonly<{
	requestVerified: boolean;
	/** The connect options' `auth_token`. */
	token: string | undefined;
	/** The nonce the server sent this connection, as the request reports it. */
	serverNonce: string | undefined;
	registry: RegistryView;
	replay: ReplayStore;
	incarnation: number;
	now: Clock;
}>;

const refuse = (check: CalloutCheck, reason: string): CalloutVerdict => ({
	ok: false,
	check,
	reason,
});

function attempt<T>(run: () => T): T | undefined {
	try {
		return run();
	} catch {
		return undefined;
	}
}

const encoder = new TextEncoder();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export async function checkConnect(
	input: CalloutInput,
): Promise<CalloutVerdict> {
	const { registry, now } = input;
	if (!input.requestVerified)
		return refuse(
			"request-signature",
			"the server's signature on the request does not verify",
		);

	// 2. The ticket.
	const token =
		input.token === undefined ? undefined : decodeConnectToken(input.token);
	if (token?.ticket === undefined || token.proof === undefined)
		return refuse("ticket", "no connect token");
	const trust = registry.trust();
	const ticketPayload = authoritySigned(
		token.ticket,
		SESSION_TICKET_CONTEXT,
		trust,
	);
	const ticket: SessionTicket | undefined =
		ticketPayload === undefined
			? undefined
			: attempt(() => fromBinary(SessionTicketSchema, ticketPayload));
	if (ticket === undefined)
		return refuse("ticket", "the ticket is not signed by an authority key");
	const expiresAtMs = Date.parse(ticket.expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now())
		return refuse("ticket", "the ticket has expired");
	if (ticket.authorityIncarnation !== input.incarnation)
		return refuse("ticket", "the ticket is from another authority incarnation");
	const memberId = attempt(() => parseMemberId(ticket.memberId));
	if (memberId === undefined)
		return refuse("ticket", "the ticket names no member");

	// 3. The proof names the ticket.
	const proof = attempt(() =>
		fromBinary(ConnectProofSchema, token.proof?.payload ?? new Uint8Array()),
	);
	if (
		proof === undefined ||
		proof.ticketId !== ticket.ticketId ||
		ticket.ticketId === ""
	)
		return refuse("proof-ticket", "the proof names another ticket");

	// 4. The proof's signature against the SIGN key in the current registry record.
	const record = await registry.member(memberId);
	if (record === undefined || record.kind !== MemberKind.DEVICE)
		return refuse(
			"proof-signature",
			"no current registry record for the device",
		);
	const identity = parsePublicJwk(record.identityJwk);
	const bundleEnvelope = record.keyBundle;
	if (
		!identity.ok ||
		bundleEnvelope === undefined ||
		!verifyEnvelope(bundleEnvelope, KEY_BUNDLE_CONTEXT, identity.value)
	)
		return refuse("proof-signature", "the record's key bundle does not verify");
	const bundle = attempt(() =>
		fromBinary(KeyBundleSchema, bundleEnvelope.payload),
	);
	const bundleUntil = Date.parse(bundle?.notAfter ?? "");
	const sign = bundle?.keys.find((key) => key.purpose === KeyPurpose.SIGN);
	if (
		bundle === undefined ||
		bundle.memberId !== memberId ||
		!(bundleUntil > now()) ||
		sign === undefined ||
		!verifyEnvelope(token.proof, NATS_CONNECT_CONTEXT, sign)
	)
		return refuse(
			"proof-signature",
			"the proof is not signed by the device's SIGN key",
		);

	// 5. The nonce.
	if (proof.nonce.length > 0) {
		if (
			input.serverNonce === undefined ||
			!sameBytes(proof.nonce, encoder.encode(input.serverNonce))
		)
			return refuse("nonce", "the proof's nonce is not this connection's");
	}

	// 6. Active, with a role.
	const template = templateFor(record);
	if (record.state !== MemberState.ACTIVE || template === undefined)
		return refuse("not-active", "the device is not active or holds no role");

	// 7. This account's tenant.
	if (ticket.tenant !== trust.tenant || record.tenant !== trust.tenant)
		return refuse("tenant", "the ticket is for another tenant");

	// A ticket whose proof carries no nonce connects once (A2 fallback).
	if (
		proof.nonce.length === 0 &&
		!(await input.replay.firstUse(
			TICKET_REPLAY_SCOPE,
			ticket.ticketId,
			expiresAtMs,
		))
	)
		return refuse("nonce", "the ticket has already been used for a connection");

	return { ok: true, memberId, template, expiresAtMs };
}
