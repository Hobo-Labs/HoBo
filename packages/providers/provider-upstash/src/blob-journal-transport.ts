import type { RequestOptions } from "node:http";
import {
	Agent as NodeHttpsAgent,
	request as nodeHttpsRequest,
} from "node:https";
import { guardTransport, type HttpTransport } from "@hobo/core";
import {
	createJournalHttpTransport,
	type JournalHttpRequest,
} from "./blob-journal-http.js";
import { isJsonString } from "./json.js";

/** The provider-controlled scope is independently verified by the host. */
export type UpstashBlobJournalTransportScope = Readonly<{
	r2AccountId: string;
	bucketId: string;
	namespace: string;
	maxObjectBytes: number;
}>;

const transports = new WeakMap<
	HttpTransport,
	UpstashBlobJournalTransportScope
>();
const nativeRequest: JournalHttpRequest = nodeHttpsRequest;
const NativeAgent = NodeHttpsAgent;
// Leave room in each 32 KiB budget allowance for the request/status line and
// headers added by the native HTTP client.
const MAX_HEADERS_BYTES = 16_384;
const MAX_MINT_RESPONSE_BYTES = 16_384;

function validScope(scope: UpstashBlobJournalTransportScope): boolean {
	return (
		/^[a-f0-9]{32}$/u.test(scope.r2AccountId) &&
		/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(scope.bucketId) &&
		scope.namespace.length <= 700 &&
		/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(scope.namespace) &&
		Number.isSafeInteger(scope.maxObjectBytes) &&
		scope.maxObjectBytes >= 1024 &&
		scope.maxObjectBytes <= 8 * 1024 * 1024
	);
}

function headerBytes(headers: Readonly<Record<string, string>>): number {
	let bytes = 0;
	for (const [name, value] of Object.entries(headers)) {
		if (
			!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
			!isJsonString(value) ||
			/[\r\n]/u.test(value)
		)
			throw new Error("Upstash Blob journal HTTP headers are invalid");
		bytes +=
			Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
	}
	return bytes;
}

/**
 * Construct a scoped, but unenrolled, transport. The public factory below is
 * the only path that binds the imported Node HTTPS implementation to the
 * enrollment proof; supplying a sender here cannot establish provenance.
 */
export function createUnenrolledUpstashBlobJournalTransport(
	input: UpstashBlobJournalTransportScope,
	request: JournalHttpRequest,
	agent?: RequestOptions["agent"],
): HttpTransport {
	const scope = Object.freeze({ ...input });
	if (!validScope(scope))
		throw new Error("Upstash Blob journal transport scope is invalid");
	const r2Host = `${scope.r2AccountId}.r2.cloudflarestorage.com`;
	const objectPrefix = `/${scope.bucketId}/${scope.namespace}/`;
	const send = guardTransport(createJournalHttpTransport(request, agent), {
		allowedHosts: ["blob.upstash.io", r2Host],
		allowedPathPrefixes: ["/v1/credentials", objectPrefix],
		maxTimeoutMs: 30_000,
		maxResponseBytes: Math.max(scope.maxObjectBytes, MAX_MINT_RESPONSE_BYTES),
	});
	const transport: HttpTransport = async (request) => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			throw new Error("Upstash Blob journal HTTP scope is invalid");
		}
		const mint =
			url.hostname === "blob.upstash.io" &&
			url.pathname === "/v1/credentials" &&
			request.method === "POST" &&
			request.body === undefined;
		const object =
			url.hostname === r2Host &&
			url.pathname.startsWith(objectPrefix) &&
			/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(
				url.pathname.slice(objectPrefix.length),
			) &&
			(request.method === "GET" || request.method === "PUT") &&
			(request.method === "PUT"
				? isJsonString(request.body)
				: request.body === undefined);
		const hosts = Object.entries(request.headers).filter(
			([name]) => name.toLowerCase() === "host",
		);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			hosts.length > 1 ||
			(hosts[0] !== undefined && hosts[0][1] !== url.host) ||
			(!mint && !object) ||
			!Number.isSafeInteger(request.maxResponseBytes) ||
			request.maxResponseBytes < 1 ||
			request.maxResponseBytes >
				(mint ? MAX_MINT_RESPONSE_BYTES : scope.maxObjectBytes) ||
			(request.body !== undefined &&
				Buffer.byteLength(request.body, "utf8") > scope.maxObjectBytes)
		)
			throw new Error("Upstash Blob journal HTTP scope is invalid");
		const headers = Object.fromEntries(
			Object.entries(request.headers).filter(
				([name]) => name.toLowerCase() !== "accept-encoding",
			),
		);
		headers["accept-encoding"] = "identity";
		if (headerBytes(headers) > MAX_HEADERS_BYTES)
			throw new Error("Upstash Blob journal HTTP headers exceed their bound");
		const response = await send({ ...request, headers });
		if (
			headerBytes(response.headers) > MAX_HEADERS_BYTES ||
			(response.headers["content-encoding"] &&
				response.headers["content-encoding"] !== "identity")
		)
			throw new Error("Upstash Blob journal HTTP response exceeds its bound");
		return response;
	};
	return Object.freeze(transport);
}

/** The imported Node HTTPS client sends a single request, never follows a
 * redirect, and enforces a total deadline and streaming response limits. The
 * supervisor must separately prove provider quotas, physical egress bounds and
 * funding; they are not implied by transport provenance. */
export function createUpstashBlobJournalTransport(
	input: UpstashBlobJournalTransportScope,
): HttpTransport {
	const scope = Object.freeze({ ...input });
	const transport = createUnenrolledUpstashBlobJournalTransport(
		scope,
		nativeRequest,
		new NativeAgent({ keepAlive: false, rejectUnauthorized: true }),
	);
	transports.set(transport, scope);
	return transport;
}

/** A structural callback, another bucket or another capacity cannot establish
 * that the installed replica uses this provider-owned transport. */
export function assertUpstashBlobJournalTransport(
	transport: HttpTransport,
	expected: UpstashBlobJournalTransportScope,
): void {
	const scope = transports.get(transport);
	if (
		!scope ||
		!validScope(expected) ||
		scope.r2AccountId !== expected.r2AccountId ||
		scope.bucketId !== expected.bucketId ||
		scope.namespace !== expected.namespace ||
		scope.maxObjectBytes !== expected.maxObjectBytes
	)
		throw new Error(
			"Upstash Blob journal transport is not enrolled for this scope",
		);
}
