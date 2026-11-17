import { createHash, createHmac } from "node:crypto";
import { isJsonString } from "../json.js";

// public-contract: the algorithm token SigV4 stamps on the Authorization header and the string-to-sign.
export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

// public-contract: the fixed terminator that closes every SigV4 credential scope and signing-key derivation.
export const AWS_SIGV4_TERMINATOR = "aws4_request";

export interface AwsCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
}

export interface SignAwsRequestInput {
	readonly method: string;
	readonly url: string;
	readonly headers?: Readonly<Record<string, string | readonly string[]>>;
	readonly body?: string;
	readonly region: string;
	readonly service: string;
	readonly credentials: AwsCredentials;
	readonly now?: Date;
	readonly contentSha256Header?: boolean;
}

export interface SignedAwsRequest {
	readonly headers: Record<string, string>;
	readonly authorization: string;
	readonly amzDate: string;
	readonly credentialScope: string;
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

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function rfc3986Encode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/gu,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

function decodeOrPassThrough(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function amzTimestamps(now: Date) {
	const iso = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
	const amzDate = iso.endsWith("Z") ? iso : `${iso}Z`;
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalUri(pathname: string): string {
	if (pathname === "") return "/";
	return pathname
		.split("/")
		.map((segment) => rfc3986Encode(decodeOrPassThrough(segment)))
		.join("/");
}

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

function normalizeHeaderValue(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function collectHeaders(
	supplied: Readonly<Record<string, string | readonly string[]>> | undefined,
): Map<string, string[]> {
	const collected = new Map<string, string[]>();
	for (const [name, value] of Object.entries(supplied ?? {})) {
		const key = name.toLowerCase();
		const existing = collected.get(key) ?? [];
		for (const entry of Array.isArray(value) ? value : [value as string]) {
			existing.push(normalizeHeaderValue(entry));
		}
		collected.set(key, existing);
	}
	return collected;
}

export function signAwsRequest(input: SignAwsRequestInput): SignedAwsRequest {
	const url = new URL(input.url);
	const { amzDate, dateStamp } = amzTimestamps(input.now ?? new Date());
	const payloadHash = sha256Hex(input.body ?? "");

	const collected = collectHeaders(input.headers);
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
