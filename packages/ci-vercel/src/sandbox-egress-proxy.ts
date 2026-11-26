import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { defineSandboxProxy, type ProxyMeta } from "@vercel/sandbox/proxy";
import {
	matchesSandboxDomain,
	validSandboxDomainPattern,
} from "./sandbox-domains.js";

/** The ledger owns the trusted per-lease limit and validates the current session. */
export interface SandboxEgressLedger {
	reserveSandboxEgress(sandboxId: string, bytes: number): Promise<boolean>;
}
export interface SandboxEgressTransportRequest {
	url: URL;
	address: string;
	method: string;
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
	signal: AbortSignal;
}
export type SandboxEgressTransport = (
	request: SandboxEgressTransportRequest,
) => Promise<Response>;

const defaultMaxRequestBytes = 4 * 1024 * 1024;
const defaultMaxResponseBytes = 4 * 1024 * 1024;
const functionMaxBytes = 4 * 1024 * 1024;
const vmMaxBytes = 1024 * 1024 * 1024;
const maxHeaderBytes = 16 * 1024;
// A server can reply as soon as it receives the declared bytes, slightly before
// the source reports EOF. Bound that wait so a stalled client cannot hold a VM.
const uploadEofGraceMs = 1_000;
// This is an application meter, not a guarantee of Vercel's billed egress:
// it cannot measure TLS, DNS, retries, or bytes sent before the proxy receives them.
const requestOverheadBytes = 4096;
const blockedHeaders = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const allowedMethods = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);

/** Accept only globally routable IPv4; IPv6 and special-use ranges fail closed. */
export function isPublicIpv4(address: string): boolean {
	if (isIP(address) !== 4) return false;
	const parts = address.split(".").map(Number);
	const [a, b, c] = parts;
	if (a === undefined || b === undefined || c === undefined) return false;
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 &&
			(b === 168 ||
				(b === 0 && (c === 0 || c === 2)) ||
				(b === 88 && c === 99))) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function safeHosts(hosts: readonly string[]): Set<string> {
	if (hosts.length === 0) throw new Error("sandbox egress host list required");
	const result = new Set<string>();
	for (const host of hosts) {
		if (!validSandboxDomainPattern(host))
			throw new Error("invalid sandbox egress host");
		result.add(host);
	}
	return result;
}
function cleanHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	const connectionHeaders = new Set(
		(headers.get("connection") ?? "")
			.split(",")
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean),
	);
	for (const [key, value] of headers) {
		if (
			blockedHeaders.has(key) ||
			connectionHeaders.has(key) ||
			key.startsWith("vercel-")
		)
			continue;
		filtered.append(key, value);
	}
	return filtered;
}
function headerSize(headers: Headers): number {
	let bytes = 0;
	for (const [key, value] of headers)
		bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
	return bytes;
}
class EarlyUpstreamRejection extends Error {
	constructor(readonly response: Response) {
		super("upstream rejected upload");
	}
}
function declaredLength(headers: Headers): number | undefined {
	const value = headers.get("content-length");
	if (value === null) return undefined;
	if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("invalid content length");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error("invalid content length");
	return parsed;
}
async function boundedResponse(
	response: Response,
	limit: number,
	reserve: (bytes: number) => Promise<boolean>,
	signal: AbortSignal,
	method: string,
): Promise<Response> {
	let declared: number | undefined;
	try {
		declared = declaredLength(response.headers);
	} catch {
		void response.body?.cancel().catch(() => {});
		return new Response(null, { status: 502 });
	}
	if (method !== "HEAD" && declared !== undefined && declared > limit) {
		void response.body?.cancel().catch(() => {});
		return new Response(null, { status: 502 });
	}
	const headers = cleanHeaders(response.headers);
	if (declared !== undefined && (method === "HEAD" || response.body))
		headers.set("content-length", String(declared));
	const size = headerSize(response.headers);
	if (size > maxHeaderBytes || !(await reserve(size + requestOverheadBytes))) {
		void response.body?.cancel().catch(() => {});
		return new Response(null, { status: 429 });
	}
	if (!response.body)
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	let total = 0;
	let abortResponse: (() => void) | undefined;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(controller) {
				abortResponse = () =>
					controller.error(new Error("sandbox egress deadline exceeded"));
				if (signal.aborted) abortResponse();
				else signal.addEventListener("abort", abortResponse, { once: true });
			},
			async transform(chunk, controller) {
				try {
					signal.throwIfAborted();
					if (chunk.byteLength === 0) return;
					total += chunk.byteLength;
					if (
						total > limit ||
						(declared !== undefined && total > declared) ||
						!(await reserve(chunk.byteLength))
					)
						throw new Error("sandbox response budget exceeded");
					signal.throwIfAborted();
					controller.enqueue(chunk);
				} catch (error) {
					if (abortResponse) signal.removeEventListener("abort", abortResponse);
					throw error;
				}
			},
			flush() {
				if (abortResponse) signal.removeEventListener("abort", abortResponse);
				if (declared !== undefined && total !== declared)
					throw new Error("sandbox response length mismatch");
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** HTTPS with a previously verified DNS address pinned through the TLS handshake. */
export const nodeSandboxEgressTransport: SandboxEgressTransport = (input) =>
	new Promise((resolve, reject) => {
		const request = httpsRequest(
			{
				protocol: "https:",
				hostname: input.url.hostname,
				port: 443,
				servername: input.url.hostname,
				method: input.method,
				path: `${input.url.pathname}${input.url.search}`,
				headers: Object.fromEntries(input.headers),
				family: 4,
				lookup: (_hostname, _options, callback) =>
					callback(null, input.address, 4),
				timeout: 30_000,
				signal: input.signal,
			},
			(incoming) => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value))
						for (const item of value) headers.append(name, item);
					else if (value !== undefined) headers.append(name, value);
				}
				const status = incoming.statusCode ?? 502;
				const bodyAllowed =
					input.method !== "HEAD" &&
					status !== 204 &&
					status !== 205 &&
					status !== 304;
				if (!bodyAllowed) incoming.resume();
				// SAFETY: IncomingMessage yields Uint8Array chunks, which are valid Web stream chunks.
				const body = bodyAllowed
					? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
					: null;
				resolve(new Response(body, { status, headers }));
			},
		);
		request.on("error", reject);
		request.on("timeout", () => request.destroy(new Error("upstream timeout")));
		if (!input.body) {
			request.end();
			return;
		}
		const reader = input.body.getReader();
		void (async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!request.write(value)) await once(request, "drain");
				}
				request.end();
			} catch (error) {
				request.destroy(
					error instanceof Error ? error : new Error("upload failed"),
				);
			} finally {
				reader.releaseLock();
			}
		})();
	});

/** Stop waiting at the absolute deadline; late failures remain observed. */
async function beforeDeadline<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("sandbox egress deadline exceeded"));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(
					error instanceof EarlyUpstreamRejection
						? error
						: new Error("sandbox egress operation failed"),
				);
			},
		);
	});
}

/** Process only metadata already verified by defineSandboxProxy. */
export function createVerifiedSandboxEgressHandler(options: {
	teamId: string;
	projectId: string;
	hosts: readonly string[];
	ledger: SandboxEgressLedger;
	resolve?: (hostname: string) => Promise<string[]>;
	transport?: SandboxEgressTransport;
	/** Function responses are capped at 4 MiB. A dedicated VM may use larger limits. */
	transportMode?: "function" | "sandbox-vm";
	maxRequestBytes?: number;
	/** Trusted per-response limit. It never overrides the durable total quota. */
	maxResponseBytes?: number;
	/** Trusted absolute DNS + forwarding deadline, bounded to 15 minutes. */
	timeoutMs?: number;
}) {
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000)
		throw new Error("invalid sandbox egress timeout");
	const limit =
		options.transportMode === "sandbox-vm" ? vmMaxBytes : functionMaxBytes;
	const maxRequestBytes = options.maxRequestBytes ?? defaultMaxRequestBytes;
	if (
		!Number.isSafeInteger(maxRequestBytes) ||
		maxRequestBytes < 1 ||
		maxRequestBytes > limit
	)
		throw new Error("invalid sandbox request limit");
	const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
	if (
		!Number.isSafeInteger(maxResponseBytes) ||
		maxResponseBytes < 1 ||
		maxResponseBytes > limit
	)
		throw new Error("invalid sandbox response limit");
	const hosts = safeHosts(options.hosts);
	const resolveAddress = options.resolve ?? resolve4;
	const transport = options.transport ?? nodeSandboxEgressTransport;
	return async (request: Request, meta: ProxyMeta): Promise<Response> => {
		const url = new URL(request.url);
		if (
			meta.teamId !== options.teamId ||
			meta.projectId !== options.projectId ||
			!/^sbx_[A-Za-z0-9_-]+$/.test(meta.sandboxId) ||
			url.protocol !== "https:" ||
			(url.port && url.port !== "443") ||
			url.username ||
			url.password ||
			!matchesSandboxDomain(url.hostname, hosts) ||
			!allowedMethods.has(request.method)
		)
			return new Response(null, { status: 403 });
		const headers = cleanHeaders(request.headers);
		const bytes =
			headerSize(request.headers) +
			Buffer.byteLength(
				`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`,
			);
		if (bytes > maxHeaderBytes) return new Response(null, { status: 431 });
		let contentLength: number | undefined;
		try {
			contentLength = declaredLength(request.headers);
		} catch {
			return new Response(null, { status: 400 });
		}
		if (contentLength !== undefined && contentLength > maxRequestBytes)
			return new Response(null, { status: 413 });
		if (
			contentLength !== undefined &&
			(request.headers.has("transfer-encoding") ||
				(request.headers.get("connection") ?? "")
					.split(",")
					.some((value) => value.trim().toLowerCase() === "content-length") ||
				(request.body === null && contentLength !== 0))
		)
			return new Response(null, { status: 400 });
		if (contentLength !== undefined)
			headers.set("content-length", String(contentLength));
		const uploadAbort = new AbortController();
		try {
			const deadline = AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				request.signal,
			]);
			const signal = AbortSignal.any([deadline, uploadAbort.signal]);
			if (
				!(await beforeDeadline(
					options.ledger.reserveSandboxEgress(
						meta.sandboxId,
						bytes + requestOverheadBytes,
					),
					signal,
				))
			)
				return new Response(null, { status: 429 });
			const addresses = await beforeDeadline(
				resolveAddress(url.hostname),
				signal,
			);
			if (
				!addresses.length ||
				addresses.some((address) => !isPublicIpv4(address))
			)
				return new Response(null, { status: 403 });
			const address = addresses[0];
			if (!address) return new Response(null, { status: 403 });
			let total = 0;
			let bodyComplete = !request.body;
			let upstreamRejected = false;
			let resolveBody: (() => void) | undefined;
			let rejectBody: ((error: Error) => void) | undefined;
			const bodyDone = request.body
				? new Promise<void>((resolve, reject) => {
						resolveBody = resolve;
						rejectBody = reject;
					})
				: Promise.resolve();
			const source = request.body?.getReader();
			const abortSource = () => {
				if (upstreamRejected) resolveBody?.();
				else rejectBody?.(new Error("sandbox upload aborted"));
				void source?.cancel().catch(() => {});
			};
			if (source) {
				if (signal.aborted) abortSource();
				else signal.addEventListener("abort", abortSource, { once: true });
			}
			const body = source
				? new ReadableStream<Uint8Array>({
						async pull(controller) {
							try {
								signal.throwIfAborted();
								const { done, value: chunk } = await source.read();
								signal.throwIfAborted();
								if (done) {
									if (contentLength !== undefined && total !== contentLength)
										throw new Error("sandbox upload length mismatch");
									bodyComplete = true;
									signal.removeEventListener("abort", abortSource);
									resolveBody?.();
									controller.close();
									source.releaseLock();
									return;
								}
								if (chunk.byteLength === 0) return;
								total += chunk.byteLength;
								if (
									total > maxRequestBytes ||
									(contentLength !== undefined && total > contentLength) ||
									!(await beforeDeadline(
										options.ledger.reserveSandboxEgress(
											meta.sandboxId,
											chunk.byteLength,
										),
										signal,
									))
								)
									throw new Error("sandbox egress limit exceeded");
								signal.throwIfAborted();
								controller.enqueue(chunk);
							} catch (error) {
								const failure =
									error instanceof Error
										? error
										: new Error("sandbox upload failed");
								rejectBody?.(failure);
								signal.removeEventListener("abort", abortSource);
								controller.error(failure);
								void source.cancel(failure).catch(() => {});
							}
						},
						async cancel(reason) {
							signal.removeEventListener("abort", abortSource);
							rejectBody?.(new Error("sandbox upload cancelled"));
							await source.cancel(reason).catch(() => {});
						},
					})
				: null;
			const [upstream] = await beforeDeadline(
				Promise.all([
					transport({
						url,
						address,
						method: request.method,
						headers,
						body,
						signal,
					}).then(async (response) => {
						if (!bodyComplete) {
							try {
								if (response.status >= 400) {
									upstreamRejected = true;
									uploadAbort.abort();
									void response.body?.cancel().catch(() => {});
									const size = headerSize(response.headers);
									if (
										size > maxHeaderBytes ||
										!(await beforeDeadline(
											options.ledger.reserveSandboxEgress(
												meta.sandboxId,
												size + requestOverheadBytes,
											),
											deadline,
										))
									)
										throw new Error("sandbox response budget exceeded");
									throw new EarlyUpstreamRejection(response);
								}
								if (
									response.status < 200 ||
									response.status >= 300 ||
									contentLength === undefined ||
									total !== contentLength
								)
									throw new Error("upstream responded before upload completed");
								let timer: ReturnType<typeof setTimeout> | undefined;
								try {
									await Promise.race([
										bodyDone,
										new Promise<never>((_resolve, reject) => {
											timer = setTimeout(
												() => reject(new Error("sandbox upload EOF timed out")),
												uploadEofGraceMs,
											);
										}),
									]);
								} finally {
									if (timer) clearTimeout(timer);
								}
							} catch (error) {
								if (error instanceof EarlyUpstreamRejection) throw error;
								uploadAbort.abort();
								void source?.cancel().catch(() => {});
								void response.body?.cancel().catch(() => {});
								throw error;
							}
						}
						return response;
					}),
					bodyDone,
				]),
				deadline,
			);
			return await boundedResponse(
				upstream,
				maxResponseBytes,
				(bytes) =>
					beforeDeadline(
						options.ledger.reserveSandboxEgress(meta.sandboxId, bytes),
						signal,
					),
				signal,
				request.method,
			);
		} catch (error) {
			uploadAbort.abort();
			if (error instanceof EarlyUpstreamRejection) {
				void error.response.body?.cancel().catch(() => {});
				return new Response(null, {
					status: error.response.status,
					statusText: error.response.statusText,
					headers: cleanHeaders(error.response.headers),
				});
			}
			return new Response(null, { status: 503 });
		}
	};
}

/** Vercel verifies OIDC issuer, audience, signature and sandbox metadata first. */
export function createSandboxEgressProxy(
	options: Parameters<typeof createVerifiedSandboxEgressHandler>[0],
) {
	return defineSandboxProxy(createVerifiedSandboxEgressHandler(options));
}
