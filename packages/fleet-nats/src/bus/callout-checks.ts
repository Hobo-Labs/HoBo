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
	token: string | undefined;
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

	const proof = attempt(() =>
		fromBinary(ConnectProofSchema, token.proof?.payload ?? new Uint8Array()),
	);
	if (
		proof === undefined ||
		proof.ticketId !== ticket.ticketId ||
		ticket.ticketId === ""
	)
		return refuse("proof-ticket", "the proof names another ticket");

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

	if (proof.nonce.length > 0) {
		if (
			input.serverNonce === undefined ||
			!sameBytes(proof.nonce, encoder.encode(input.serverNonce))
		)
			return refuse("nonce", "the proof's nonce is not this connection's");
	}

	const template = templateFor(record);
	if (record.state !== MemberState.ACTIVE || template === undefined)
		return refuse("not-active", "the device is not active or holds no role");

	if (ticket.tenant !== trust.tenant || record.tenant !== trust.tenant)
		return refuse("tenant", "the ticket is for another tenant");

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
