import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ConnectProofSchema,
	type ConnectToken,
	ConnectTokenSchema,
	type DeviceKeys,
	NATS_CONNECT_CONTEXT,
	SessionTicketSchema,
	type SignedEnvelope,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";

export function encodeConnectToken(token: ConnectToken): string {
	return Buffer.from(toBinary(ConnectTokenSchema, token)).toString("base64url");
}

export function decodeConnectToken(text: string): ConnectToken | undefined {
	const bytes = Buffer.from(text, "base64url");
	if (bytes.length === 0 || bytes.toString("base64url") !== text)
		return undefined;
	try {
		return fromBinary(ConnectTokenSchema, bytes);
	} catch {
		return undefined;
	}
}

export async function mintConnectToken(
	keys: DeviceKeys,
	ticket: SignedEnvelope,
	nonce: Uint8Array = new Uint8Array(),
): Promise<string> {
	const { ticketId } = fromBinary(SessionTicketSchema, ticket.payload);
	const proof = await signEnvelope(
		keys.sign,
		NATS_CONNECT_CONTEXT,
		toBinary(
			ConnectProofSchema,
			create(ConnectProofSchema, { ticketId, nonce }),
		),
	);
	return encodeConnectToken(create(ConnectTokenSchema, { ticket, proof }));
}
