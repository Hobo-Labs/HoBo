import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { failureRoute, reportRelayFailure } from "./failure-log.js";

const MAX_BODY = 1024 * 1024;

function waitForDrain(response: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		const clean = () => {
			response.off("drain", onDrain);
			response.off("close", onClose);
			response.off("error", onError);
		};
		const onDrain = () => {
			clean();
			resolve();
		};
		const onClose = () => {
			clean();
			reject(new Error("client disconnected"));
		};
		const onError = () => {
			clean();
			reject(new Error("client connection failed"));
		};
		response.once("drain", onDrain);
		response.once("close", onClose);
		response.once("error", onError);
	});
}

const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * Seconds for the `Retry-After` of a 503 answered for `error`.
 *
 * An error that knows when its cause will be tried again says so in a
 * `retryAfterMs` number (the store back-off does): that is what the caller is
 * told, in whole seconds from 1 to 300. Any other error gets the 5 s default,
 * so a caller that honours the header never comes back sooner than the relay
 * will look again.
 */
export function unavailableRetryAfterSeconds(error: Error | undefined): number {
	if (!error || !("retryAfterMs" in error)) return DEFAULT_RETRY_AFTER_SECONDS;
	const milliseconds = Number(error.retryAfterMs);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0)
		return DEFAULT_RETRY_AFTER_SECONDS;
	return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(milliseconds / 1000));
}

/** Adapt a Node HTTP server or function entrypoint to the portable request handler. */
export function createNodeRelayHandler(options: {
	origin: string;
	handle: (request: Request) => Promise<Response>;
	/** A host that explicitly serves plain HTTP on loopback names that origin here. */
	allowLoopbackHttp?: boolean;
	/**
	 * Paths whose bodies are streamed in both directions and not held to the
	 * 1 MiB limit; the handler behind them owns its own quota.
	 */
	streams?: (pathname: string) => boolean;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
	const origin = new URL(options.origin);
	const loopbackHttp =
		options.allowLoopbackHttp === true &&
		origin.protocol === "http:" &&
		(origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
	if (
		(origin.protocol !== "https:" && !loopbackHttp) ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("relay origin must be an HTTPS origin");
	return async (request, response) => {
		try {
			if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
				response.writeHead(400).end();
				return;
			}
			const url = new URL(request.url, origin);
			if (url.origin !== origin.origin) {
				response.writeHead(400).end();
				return;
			}
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				if (Array.isArray(value)) {
					for (const item of value) headers.append(name, item);
				} else if (value !== undefined) headers.set(name, value);
			}
			if (options.streams?.(url.pathname) === true) {
				const method = request.method ?? "GET";
				const abort = new AbortController();
				response.once("close", () => abort.abort());
				const init: RequestInit & { duplex?: "half" } = {
					method,
					headers,
					signal: abort.signal,
				};
				if (method !== "GET" && method !== "HEAD") {
					// SAFETY: IncomingMessage yields Buffer chunks, a Uint8Array subtype.
					init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
					init.duplex = "half";
				}
				const result = await options.handle(new Request(url, init));
				response.statusCode = result.status;
				result.headers.forEach((value, name) => {
					if (name !== "set-cookie") response.setHeader(name, value);
				});
				const cookies = result.headers.getSetCookie();
				if (cookies.length) response.setHeader("set-cookie", cookies);
				if (!result.body) {
					response.end();
					return;
				}
				const reader = result.body.getReader();
				const cancel = () => {
					void reader.cancel().catch(() => undefined);
				};
				abort.signal.addEventListener("abort", cancel, { once: true });
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!response.write(value)) {
							await waitForDrain(response);
						}
					}
					response.end();
				} finally {
					abort.signal.removeEventListener("abort", cancel);
					await reader.cancel().catch(() => undefined);
				}
				return;
			}
			const chunks: Buffer[] = [];
			let length = 0;
			for await (const chunk of request) {
				const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += value.length;
				if (length > MAX_BODY) {
					response
						.writeHead(413, {
							"Cache-Control": "no-store",
							"Content-Type": "application/json",
						})
						.end('{"error":"request body too large"}');
					return;
				}
				chunks.push(value);
			}
			const method = request.method ?? "GET";
			const init: RequestInit = { method, headers };
			if (method !== "GET" && method !== "HEAD")
				init.body = new Uint8Array(Buffer.concat(chunks));
			const result = await options.handle(new Request(url, init));
			response.statusCode = result.status;
			result.headers.forEach((value, name) => {
				if (name !== "set-cookie") response.setHeader(name, value);
			});
			const cookies = result.headers.getSetCookie();
			if (cookies.length) response.setHeader("set-cookie", cookies);
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch (error) {
			reportRelayFailure(
				"hobo_ci_relay_request_failed",
				{
					method: request.method ?? "",
					route: failureRoute(request.url),
					headersSent: response.headersSent,
				},
				error instanceof Error ? error : undefined,
			);
			if (response.headersSent) {
				response.destroy();
				return;
			}
			// Tell the caller when to come back; GitHub and the worker both honour it.
			response.writeHead(503, {
				"Cache-Control": "no-store",
				"Retry-After": String(
					unavailableRetryAfterSeconds(
						error instanceof Error ? error : undefined,
					),
				),
			});
			response.end('{"error":"service unavailable"}');
		}
	};
}
