/**
 * AWS Signature Version 4 — the deterministic signing primitive.
 *
 * Why this lives in `@hobo/core`: AWS is the one provider on the direct-API
 * deploy path that does not accept a bearer token. Every request to S3,
 * DynamoDB, SQS, SNS, Secrets Manager, and SSM must carry a SigV4
 * `Authorization` header computed over the canonical form of the request. That
 * computation is pure, deterministic cryptography over `node:crypto` with no
 * HoBo domain semantics in it — no Yard, no Bindle, no Camp — so it belongs
 * beside the other ports rather than in a provider adapter (layer 2, which may
 * import `@hobo/core` and nothing else HoBo) or in `@hobo/connectivity`
 * (layer 3, which a provider adapter may not reach). `@hobo/connectivity`
 * re-exports this module under its original names so its Route53 signer keeps
 * working without a second copy of the algorithm.
 *
 * Spec: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * Three details are load-bearing and easy to get subtly wrong — each is
 * pinned by the official `aws-sig-v4-test-suite` vectors in
 * `test/aws-sigv4.test.ts`, because a signer that is subtly wrong fails only
 * against the live API:
 *
 * - **Ordering is by code unit, never by locale.** `localeCompare` puts
 *   `Param1` before `Param2` in every locale a developer is likely to test in
 *   and reorders other pairs in ones they are not. SigV4 specifies a byte
 *   ordering, so this module compares by code unit and a signature is a
 *   function of the request rather than of the machine that signed it.
 * - **URI encoding is RFC 3986, not `encodeURIComponent`.** The platform
 *   function leaves `!'()*` unescaped; AWS requires them percent-encoded, so
 *   the encoder here escapes them explicitly.
 * - **Header names are folded to lower case before collection, not after.**
 *   A caller that passes both `Host` and `host` would otherwise contribute two
 *   canonical `host:` lines and a `host;host` signed-headers list — a
 *   signature the service rejects for a request that looks fine on the wire.
 *
 * Duplicate header values are joined with `,` in the order supplied, which is
 * what the `get-header-key-duplicate` and `get-header-value-order` vectors
 * require; supply them as an array to model a header sent more than once.
 *
 * Path encoding is applied **once**. That matches the published vectors
 * (`get-utf8` expects `/%E1%88%B4`, not `/%25E1%2588%25B4`) and matches S3,
 * which never double-encodes. Services that double-encode their paths are not
 * on HoBo's direct-API path today, and the endpoints that are address either
 * `/` or a single DNS-safe bucket segment, where single and double encoding
 * are identical.
 *
 * Determinism: the only impurity is the signing timestamp, which SigV4
 * genuinely requires. Pass `now` and the output is byte-stable; omit it and
 * the module reads the clock once, which is why every HoBo caller passes it.
 *
 * HONEST SCOPE: this module proves the signature is computed the way the
 * published vectors say it should be. It does not prove any request was ever
 * sent, accepted, or authorized — that needs real credentials and real network
 * egress, neither of which a unit test supplies.
 */

import { createHash, createHmac } from "node:crypto";
import { isJsonString } from "../json.js";

// public-contract: the algorithm token SigV4 stamps on the Authorization header and the string-to-sign.
export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

// public-contract: the fixed terminator that closes every SigV4 credential scope and signing-key derivation.
export const AWS_SIGV4_TERMINATOR = "aws4_request";

/**
 * Credential material for one signing operation.
 *
 * This is *material*, not a locator: it is produced by a host credential
 * resolver at the moment of the call and must never be written into a record
 * that is logged, hashed, or replayed.
 */
export interface AwsCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
}

export interface SignAwsRequestInput {
	readonly method: string;
	readonly url: string;
	/**
	 * Request headers. A value given as an array models the same header sent
	 * more than once; the canonical form joins those values with `,` in the
	 * order supplied, as SigV4 requires.
	 */
	readonly headers?: Readonly<Record<string, string | readonly string[]>>;
	readonly body?: string;
	readonly region: string;
	readonly service: string;
	readonly credentials: AwsCredentials;
	/** Signing clock. Always pass it: SigV4 is otherwise pure. */
	readonly now?: Date;
	/**
	 * Whether to add and sign `x-amz-content-sha256`. S3 requires it and the
	 * other services accept it, so it defaults to `true`; the published test
	 * vectors do not include it, so they sign with `false`.
	 */
	readonly contentSha256Header?: boolean;
}

export interface SignedAwsRequest {
	/**
	 * The headers to send. Names are lower case except `Authorization`, which
	 * keeps its conventional casing; HTTP header names are case-insensitive, so
	 * a caller that wants one convention should fold them itself.
	 */
	readonly headers: Record<string, string>;
	readonly authorization: string;
	readonly amzDate: string;
	readonly credentialScope: string;
	/** The canonical request that was hashed — exposed so a test can pin it. */
	readonly canonicalRequest: string;
	readonly stringToSign: string;
	readonly signature: string;
	readonly signedHeaders: string;
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Code-unit comparison: locale-independent, so a signature is reproducible. */
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * RFC 3986 percent-encoding as SigV4 defines `UriEncode`: every byte except
 * `A-Z a-z 0-9 - . _ ~` is escaped, with upper-case hex digits.
 * `encodeURIComponent` already produces upper-case hex and leaves exactly the
 * unreserved set alone *plus* `!'()*`, so those five are escaped here.
 */
function rfc3986Encode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/gu,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

/**
 * Decode a percent-encoded component, leaving it untouched when it is not
 * valid percent-encoding. Re-encoding is what normalizes the request, and a
 * malformed escape is the caller's to answer for — throwing here would turn a
 * bad URL into a crash inside a signer.
 */
function decodeOrPassThrough(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function amzTimestamps(now: Date) {
	// 2015-08-30T12:36:00.000Z -> 20150830T123600Z
	const iso = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
	const amzDate = iso.endsWith("Z") ? iso : `${iso}Z`;
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Encode each path segment once, preserving the separators between them. */
function canonicalUri(pathname: string): string {
	if (pathname === "") return "/";
	return pathname
		.split("/")
		.map((segment) => rfc3986Encode(decodeOrPassThrough(segment)))
		.join("/");
}

/**
 * Re-encode every parameter, then sort by encoded name and encoded value. The
 * sort happens *after* encoding, which is what the spec says and what makes
 * `%20` order beside `+` predictably.
 */
function canonicalQuery(search: string): string {
	const query = search.startsWith("?") ? search.slice(1) : search;
	if (query === "") return "";
	const pairs = query.split("&").map((part) => {
		const separator = part.indexOf("=");
		const rawName = separator < 0 ? part : part.slice(0, separator);
		const rawValue = separator < 0 ? "" : part.slice(separator + 1);
		return [
			rfc3986Encode(decodeOrPassThrough(rawName)),
			rfc3986Encode(decodeOrPassThrough(rawValue)),
		] as const;
	});
	return [...pairs]
		.sort(
			(left, right) => compare(left[0], right[0]) || compare(left[1], right[1]),
		)
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
}

/** Trim, then collapse runs of whitespace to a single space, per SigV4. */
function normalizeHeaderValue(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

/**
 * Collect headers into lower-cased names with their values in supply order.
 * Folding the name *before* collection is what stops a caller who passed both
 * `Host` and `host` from producing two canonical `host:` lines.
 */
function collectHeaders(
	supplied: Readonly<Record<string, string | readonly string[]>> | undefined,
): Map<string, string[]> {
	const collected = new Map<string, string[]>();
	for (const [name, value] of Object.entries(supplied ?? {})) {
		const key = name.toLowerCase();
		const existing = collected.get(key) ?? [];
		// SAFETY: assertion required at this I/O or test boundary.
		for (const entry of Array.isArray(value) ? value : [value as string]) {
			existing.push(normalizeHeaderValue(entry));
		}
		collected.set(key, existing);
	}
	return collected;
}

/**
 * Sign an AWS request. Returns the headers to send, the `Authorization` value,
 * and the intermediate canonical request and string-to-sign so a caller can
 * pin them against published vectors.
 */
export function signAwsRequest(input: SignAwsRequestInput): SignedAwsRequest {
	const url = new URL(input.url);
	const { amzDate, dateStamp } = amzTimestamps(input.now ?? new Date());
	const payloadHash = sha256Hex(input.body ?? "");

	const collected = collectHeaders(input.headers);
	// These four are set rather than appended: they are the signer's to own,
	// and a caller-supplied copy must not become a second canonical line.
	collected.set("host", [url.host]);
	collected.set("x-amz-date", [amzDate]);
	if (input.contentSha256Header !== false) {
		collected.set("x-amz-content-sha256", [payloadHash]);
	}
	if (
		isJsonString(input.credentials.sessionToken) &&
		input.credentials.sessionToken.length > 0
	) {
		collected.set("x-amz-security-token", [input.credentials.sessionToken]);
	}

	const names = [...collected.keys()].sort(compare);
	const canonicalHeaders = `${names
		.map((name) => `${name}:${(collected.get(name) ?? []).join(",")}`)
		.join("\n")}\n`;
	const signedHeaders = names.join(";");

	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQuery(url.search),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const credentialScope = `${dateStamp}/${input.region}/${input.service}/${AWS_SIGV4_TERMINATOR}`;
	const stringToSign = [
		AWS_SIGV4_ALGORITHM,
		amzDate,
		credentialScope,
		sha256Hex(canonicalRequest),
	].join("\n");

	const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
	const regionKey = hmac(dateKey, input.region);
	const serviceKey = hmac(regionKey, input.service);
	const signingKey = hmac(serviceKey, AWS_SIGV4_TERMINATOR);
	const signature = hmac(signingKey, stringToSign).toString("hex");

	const authorization = `${AWS_SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const headers: Record<string, string> = {};
	for (const name of names) {
		headers[name] = (collected.get(name) ?? []).join(",");
	}
	headers.Authorization = authorization;

	return {
		headers,
		authorization,
		amzDate,
		credentialScope,
		canonicalRequest,
		stringToSign,
		signature,
		signedHeaders,
	};
}
