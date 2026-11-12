// AWS Signature Version 4 for one request with a JSON body and no query
// string — all the CloudWatch source needs. node:crypto only, no SDK. Pinned
// against botocore's SigV4Auth in test/verification/sources/sigv4.test.ts.
import { createHash, createHmac } from "node:crypto";

/** The headers to send: the inputs lower-cased, plus x-amz-date, an optional x-amz-security-token and authorization. */
export type SignedHeaders = Readonly<Record<string, string>>;

export type AwsCredentials = Readonly<{
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}>;

const sha256Hex = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) =>
	createHmac("sha256", key).update(value, "utf8").digest();

function amzDate(atMs: number): string {
	return new Date(atMs)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/** Returns the request headers plus `x-amz-date`, optional `x-amz-security-token` and `authorization`. */
export function signV4(
	input: Readonly<{
		method: string;
		url: string;
		headers: Readonly<Record<string, string>>;
		body: string;
		region: string;
		service: string;
		credentials: AwsCredentials;
		atMs: number;
	}>,
): SignedHeaders {
	const url = new URL(input.url);
	const stamp = amzDate(input.atMs);
	const day = stamp.slice(0, 8);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(input.headers))
		headers[name.toLowerCase()] = value;
	headers.host = url.host;
	headers["x-amz-date"] = stamp;
	if (input.credentials.sessionToken)
		headers["x-amz-security-token"] = input.credentials.sessionToken;
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names
		.map(
			(name) =>
				`${name}:${(headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`,
		)
		.join("");
	const signedHeaders = names.join(";");
	const canonicalRequest = [
		input.method,
		url.pathname || "/",
		url.search.slice(1),
		canonicalHeaders,
		signedHeaders,
		sha256Hex(input.body),
	].join("\n");
	const scope = `${day}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		stamp,
		scope,
		sha256Hex(canonicalRequest),
	].join("\n");
	const key = hmac(
		hmac(
			hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region),
			input.service,
		),
		"aws4_request",
	);
	const signature = createHmac("sha256", key)
		.update(stringToSign, "utf8")
		.digest("hex");
	const { host: _host, ...sent } = headers;
	return {
		...sent,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}
