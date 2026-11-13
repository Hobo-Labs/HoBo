/**
 * Serves the fetch-style handler over `node:http`. TLS ends in front of the
 * service (the deployment's load balancer or proxy), so the request URL is
 * built on the configured issuer, never on the `Host` header. Header, request
 * and keep-alive times are bounded.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 35_000;
const KEEP_ALIVE_MS = 5_000;
const MAX_HEADER_BYTES = 16 * 1024;

function toRequest(message: IncomingMessage, origin: string): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(message.headers)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value])
			headers.append(name, item);
	}
	const method = message.method ?? "GET";
	const init: RequestInit & { duplex?: "half" } = { method, headers };
	if (method !== "GET" && method !== "HEAD") {
		// SAFETY: a node Readable is a web ReadableStream source of bytes; Readable.toWeb converts it.
		init.body = Readable.toWeb(message) as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(`${origin}${message.url ?? "/"}`, init);
}

export function serveAuthority(
	handler: (request: Request) => Promise<Response>,
	options: Readonly<{ origin: string; host: string; port: number }>,
): Promise<Server> {
	const server = createServer(
		{ maxHeaderSize: MAX_HEADER_BYTES },
		(message, reply) => {
			void (async () => {
				let response: Response;
				try {
					response = await handler(toRequest(message, options.origin));
				} catch {
					response = Response.json(
						{ code: "unavailable", message: "the authority failed to answer" },
						{ status: 503 },
					);
				}
				reply.statusCode = response.status;
				for (const [name, value] of response.headers)
					reply.setHeader(name, value);
				reply.end(Buffer.from(await response.arrayBuffer()));
			})();
		},
	);
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = KEEP_ALIVE_MS;
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => resolve(server));
	});
}
