/**
 * The wire half of the typed client (design §6.15; L07 private): one HTTP
 * request per call, protobuf JSON bodies, DPoP on every authenticated call,
 * and §7.6 errors read back into a `FleetFailure`.
 *
 * Three kinds of authentication, by route:
 * - `none`: discovery, the JWKS and the start of a sign-in;
 * - `proof`: a DPoP proof alone, made with the caller's key (sign-in
 *   completion and polling with the sign-in key, enrollment with the identity
 *   key, credentials with the SIGN key);
 * - `token`: `Authorization: DPoP <token>` and a proof carrying `ath`. When
 *   `token()` answers an empty string the call falls back to a bare proof.
 */
import type { Message } from "@bufbuild/protobuf";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { FleetErrorSchema } from "../_generated/fleet_pb.js";
import { FLEET_ERROR_CODES, type FleetErrorCode } from "../errors.js";
import { mintDpopProof } from "../keys/index.js";
import type { FleetFailure, Outcome, PublicJwk, Signer } from "../ports.js";

export type ClientAuth = Readonly<{
	token(): Promise<string>;
	signer: Signer;
	publicJwk: PublicJwk;
}>;

export type AuthKind = "none" | "proof" | "token";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type Wire = Readonly<{
	origin: string;
	fetch: typeof fetch;
	auth: ClientAuth | undefined;
}>;

const JSON_TYPE = "application/json";
const KNOWN_CODES: ReadonlySet<string> = new Set(FLEET_ERROR_CODES);

function failure(
	code: FleetErrorCode,
	message: string,
	detail?: Readonly<Record<string, string>>,
): Outcome<never> {
	const error: FleetFailure =
		detail === undefined ? { code, message } : { code, message, detail };
	return { ok: false, error };
}

/** A path segment, escaped. */
export function segment(value: string): string {
	return encodeURIComponent(value);
}

/** `?a=1&b=2` for the defined entries, or "". */
export function query(
	entries: readonly Readonly<[string, string | number | undefined]>[],
): string {
	const params = new URLSearchParams();
	for (const [name, value] of entries)
		if (value !== undefined) params.set(name, String(value));
	const text = params.toString();
	return text.length === 0 ? "" : `?${text}`;
}

/** Protobuf JSON of a record, for a request body. */
export function body<T extends Message>(
	schema: GenMessage<T>,
	message: T,
): string {
	return toJsonString(schema, message);
}

/** Reads a response body as the named record; unknown fields are ignored so a newer authority stays readable. */
export function record<T extends Message>(
	schema: GenMessage<T>,
): (text: string) => T {
	return (text) =>
		fromJsonString(schema, text.length === 0 ? "{}" : text, {
			ignoreUnknownFields: true,
		});
}

/** The code a status implies when the body is not a `FleetError`. */
function codeOfStatus(status: number): FleetErrorCode {
	if (status >= 500) return "unavailable";
	if (status === 401) return "unauthenticated";
	if (status === 403) return "forbidden";
	if (status === 404) return "member-unknown";
	if (status === 409) return "conflict";
	if (status === 423) return "member-locked";
	if (status === 426) return "agent-outdated";
	if (status === 428) return "sign-in-pending";
	if (status === 429) return "quota-exceeded";
	return "invalid-request";
}

function readError(status: number, text: string): Outcome<never> {
	try {
		const error = fromJsonString(FleetErrorSchema, text, {
			ignoreUnknownFields: true,
		});
		if (KNOWN_CODES.has(error.code)) {
			const code = FLEET_ERROR_CODES.find((known) => known === error.code);
			if (code !== undefined)
				return failure(
					code,
					error.message,
					Object.keys(error.detail).length === 0
						? undefined
						: { ...error.detail },
				);
		}
	} catch {
		// Not a FleetError body: fall through to the status.
	}
	return failure(codeOfStatus(status), `HTTP ${status}`);
}

async function headersFor(
	wire: Wire,
	auth: AuthKind,
	method: HttpMethod,
	url: string,
	hasBody: boolean,
): Promise<Headers> {
	const headers = new Headers({ accept: JSON_TYPE });
	if (hasBody) headers.set("content-type", JSON_TYPE);
	if (auth === "none" || wire.auth === undefined) return headers;
	const token = auth === "token" ? await wire.auth.token() : "";
	const nowMs = Date.now();
	const proof = await mintDpopProof(
		wire.auth.signer,
		wire.auth.publicJwk,
		token.length > 0
			? { htm: method, htu: url, nowMs, accessToken: token }
			: { htm: method, htu: url, nowMs },
	);
	headers.set("dpop", proof);
	if (token.length > 0) headers.set("authorization", `DPoP ${token}`);
	return headers;
}

/** One call: build the URL and headers, send, and read the answer or the §7.6 error. */
export async function send<T>(
	wire: Wire,
	request: Readonly<{
		method: HttpMethod;
		path: string;
		auth: AuthKind;
		body?: string;
		parse: (text: string) => T;
	}>,
): Promise<Outcome<T>> {
	const url = `${wire.origin.replace(/\/+$/u, "")}${request.path}`;
	let response: Response;
	try {
		const headers = await headersFor(
			wire,
			request.auth,
			request.method,
			url,
			request.body !== undefined,
		);
		response = await wire.fetch(
			url,
			request.body === undefined
				? { method: request.method, headers }
				: { method: request.method, headers, body: request.body },
		);
	} catch (error) {
		return failure(
			"unavailable",
			error instanceof Error ? error.message : "the request failed",
		);
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return failure("unavailable", "the response body could not be read");
	}
	if (!response.ok) return readError(response.status, text);
	try {
		return { ok: true, value: request.parse(text) };
	} catch {
		return failure(
			"invalid-request",
			"the authority's answer does not parse as the expected record",
		);
	}
}
