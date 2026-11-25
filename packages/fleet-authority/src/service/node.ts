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
		const body = Readable.toWeb(message);
		if (!(body instanceof ReadableStream))
			throw new TypeError("the request body is not a web stream");
		init.body = body;
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
