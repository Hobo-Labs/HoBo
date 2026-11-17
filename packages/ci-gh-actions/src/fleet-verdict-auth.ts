import { createHash, createPublicKey, verify } from "node:crypto";

// public-contract: the domain separator of the signed text; a change to what is signed needs a new one.
export const FLEET_VERDICT_SIGNING_CONTEXT = "hobo-fleet-verdict-v1";

// public-contract: the headers a signed report carries.
export const FLEET_VERDICT_HEADERS = Object.freeze({
	reporter: "X-HoBo-Reporter",
	sequence: "X-HoBo-Sequence",
	issuedAt: "X-HoBo-Issued-At",
	signature: "X-HoBo-Signature",
});

export const FLEET_REPORTER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const FLEET_REPORTER_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SEQUENCE = /^[1-9][0-9]{0,19}$/;
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE = /^ed25519=([A-Za-z0-9_-]{86})$/;
const MAX_SEQUENCE = 18_446_744_073_709_551_615n;

export type FleetVerdictSigningFields = Readonly<{
	origin: string;
	path: string;
	body: string | Uint8Array;
	issuedAt: string;
	sequence: string;
}>;

export function isFleetVerdictSequence(value: string): boolean {
	return SEQUENCE.test(value) && BigInt(value) <= MAX_SEQUENCE;
}

export function isFleetVerdictIssuedAt(value: string): boolean {
	return ISSUED_AT.test(value) && Number.isFinite(Date.parse(value));
}

export function fleetVerdictSigningInput(
	fields: FleetVerdictSigningFields,
): string {
	if (!isFleetVerdictIssuedAt(fields.issuedAt))
		throw new Error("fleet verdict issued-at must be RFC 3339 UTC with ms");
	if (!isFleetVerdictSequence(fields.sequence))
		throw new Error("fleet verdict sequence must be a positive integer");
	const origin = fields.origin.toLowerCase().replace(/\/$/u, "");
	return [
		FLEET_VERDICT_SIGNING_CONTEXT,
		"PUT",
		origin,
		fields.path.toLowerCase(),
		createHash("sha256").update(fields.body).digest("hex"),
		fields.issuedAt,
		fields.sequence,
	].join("\n");
}

export type FleetVerdictSigner = Readonly<{
	sign(payload: string): string;
}>;

export function signFleetVerdictReport(
	identity: FleetVerdictSigner,
	fields: FleetVerdictSigningFields,
): string {
	return `ed25519=${identity.sign(fleetVerdictSigningInput(fields))}`;
}

export function verifyFleetVerdictReport(
	publicKey: string,
	fields: FleetVerdictSigningFields,
	signature: string,
): boolean {
	const match = SIGNATURE.exec(signature);
	if (!match?.[1] || !FLEET_REPORTER_PUBLIC_KEY.test(publicKey)) return false;
	try {
		return verify(
			null,
			Buffer.from(fleetVerdictSigningInput(fields), "utf8"),
			createPublicKey({
				key: { kty: "OKP", crv: "Ed25519", x: publicKey },
				format: "jwk",
			}),
			Buffer.from(match[1], "base64url"),
		);
	} catch {
		return false;
	}
}

export type SignedFleetVerdictRequest = Readonly<{
	url: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	body: string;
}>;

export function signedFleetVerdictRequest(input: {
	identity: FleetVerdictSigner;
	reporterId: string;
	origin: string;
	repository: string;
	body: string;
	issuedAt: string;
	sequence: string;
}): SignedFleetVerdictRequest {
	if (!FLEET_REPORTER_ID.test(input.reporterId))
		throw new Error("fleet reporter id must match ^[A-Za-z0-9_-]{1,64}$");
	const origin = input.origin.toLowerCase().replace(/\/$/u, "");
	const path = `/v1/fleet/verdicts/${input.repository.toLowerCase()}`;
	const fields = {
		origin,
		path,
		body: input.body,
		issuedAt: input.issuedAt,
		sequence: input.sequence,
	};
	return {
		url: `${origin}${path}`,
		path,
		headers: {
			"Content-Type": "application/json",
			[FLEET_VERDICT_HEADERS.reporter]: input.reporterId,
			[FLEET_VERDICT_HEADERS.sequence]: input.sequence,
			[FLEET_VERDICT_HEADERS.issuedAt]: input.issuedAt,
			[FLEET_VERDICT_HEADERS.signature]: signFleetVerdictReport(
				input.identity,
				fields,
			),
		},
		body: input.body,
	};
}
