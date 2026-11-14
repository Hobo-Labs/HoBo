/**
 * How a fleet reporter proves a report is its own (ADR-0180): an Ed25519
 * signature over a fixed text that names the relay, the route, the body, the
 * time and a sequence. No bearer or other secret travels (ADR-0027), and the
 * key can do nothing but sign reports.
 *
 * The signing input is defined once, here: the reporter on the box and the
 * hosted relay both import `fleetVerdictSigningInput`, and its three test
 * vectors (`test/fleet-verdict-auth.test.ts`) are the contract between them.
 */
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

/** A reporter's id, as enrolled and as sent in `X-HoBo-Reporter`. */
export const FLEET_REPORTER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A raw Ed25519 public key, base64url without padding. */
export const FLEET_REPORTER_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** A positive decimal integer, as `X-HoBo-Sequence` carries it. */
const SEQUENCE = /^[1-9][0-9]{0,19}$/;
/** RFC 3339 in UTC with milliseconds, as `X-HoBo-Issued-At` carries it. */
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE = /^ed25519=([A-Za-z0-9_-]{86})$/;
/** The highest sequence there can be: an unsigned 64-bit integer. */
const MAX_SEQUENCE = 18_446_744_073_709_551_615n;

/** What one signed report covers. */
export type FleetVerdictSigningFields = Readonly<{
	/** The relay's public origin, e.g. `https://hobo-ci.vercel.app`. */
	origin: string;
	/** The request path, e.g. `/v1/fleet/verdicts/hobo-labs/hobo`. */
	path: string;
	/** The request body exactly as sent. */
	body: string | Uint8Array;
	/** RFC 3339, UTC, milliseconds: `2026-11-12T16:00:05.000Z`. */
	issuedAt: string;
	/** The report's sequence, a positive decimal integer. */
	sequence: string;
}>;

/** True when `value` is a sequence a report may carry. */
export function isFleetVerdictSequence(value: string): boolean {
	return SEQUENCE.test(value) && BigInt(value) <= MAX_SEQUENCE;
}

/** True when `value` is an issued-at a report may carry. */
export function isFleetVerdictIssuedAt(value: string): boolean {
	return ISSUED_AT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * The exact text a report's signature covers: seven fields joined by a
 * single `\n`, with no spaces and no trailing newline. The context, `PUT`,
 * the origin (lower case, no trailing slash), the path (lower case), the
 * lower-case hex SHA-256 of the body's bytes, the issued-at and the
 * sequence. Throws on an issued-at or sequence a report may not carry.
 */
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
		// Text is hashed as its UTF-8 bytes, as it is sent.
		createHash("sha256").update(fields.body).digest("hex"),
		fields.issuedAt,
		fields.sequence,
	].join("\n");
}

/** Anything that signs with an Ed25519 key it keeps to itself (a `MeshIdentity`). */
export type FleetVerdictSigner = Readonly<{
	/** The Ed25519 signature over `payload`'s UTF-8 bytes, base64url. */
	sign(payload: string): string;
}>;

/** The `X-HoBo-Signature` value for a report: `ed25519=<base64url>`. */
export function signFleetVerdictReport(
	identity: FleetVerdictSigner,
	fields: FleetVerdictSigningFields,
): string {
	return `ed25519=${identity.sign(fleetVerdictSigningInput(fields))}`;
}

/**
 * Whether `signature` (the `X-HoBo-Signature` value) is the enrolled key's
 * signature over these fields. False for anything malformed, never a throw.
 */
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

/** One signed report, ready to send with `fetch`. */
export type SignedFleetVerdictRequest = Readonly<{
	url: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	body: string;
}>;

/**
 * The whole request a reporter sends for one repository: the lower-case
 * path, the four headers and the body it signed. `origin` is the relay's
 * public origin, which the relay signs against whatever host answers.
 */
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
