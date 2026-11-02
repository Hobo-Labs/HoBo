import {
	createServer,
	type IncomingMessage,
	type RequestListener,
} from "node:http";
import { toJsonString } from "@bufbuild/protobuf";
import { JitBootstrapResponseSchema } from "./_generated/jit_bootstrap_response_pb.js";
import type { Relay } from "./relay.js";

function headerString(
	value: string | string[] | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	const single = Array.isArray(value) ? value[0] : value;
	return single && single.length > 0 ? single : undefined;
}

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += next.length;
		if (bytes > 1024 * 1024) throw new Error("body too large");
		chunks.push(next);
	}
	return Buffer.concat(chunks);
}

export function createRelayRequestHandler(
	relay: Pick<Relay, "webhook" | "claim">,
): RequestListener {
	return async (request, response) => {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Cache-Control", "no-store");
		if (request.method === "GET" && request.url === "/healthz") {
			response.end('{"ok":true}');
			return;
		}
		if (request.method === "POST" && request.url === "/github/webhooks") {
			try {
				const signature = request.headers["x-hub-signature-256"];
				const ingressForward = request.headers["x-hobo-ingress-forward"];
				const event = headerString(request.headers["x-github-event"]);
				const forwardHeader = headerString(ingressForward);
				const signatureHeader = headerString(signature);
				const hasForward = forwardHeader !== undefined;
				const hasGithubSignature = signatureHeader !== undefined;
				if (!event || (!hasGithubSignature && !hasForward)) {
					response.writeHead(401).end('{"error":"signature required"}');
					return;
				}
				const result = await relay.webhook(
					await body(request),
					hasGithubSignature ? signatureHeader : "",
					event,
					hasForward ? forwardHeader : undefined,
				);
				response.writeHead(202).end(JSON.stringify({ status: result }));
			} catch (error) {
				const signatureError =
					error instanceof Error &&
					error.message === "invalid webhook signature";
				const parseError =
					error instanceof SyntaxError ||
					(error instanceof Error && error.name === "ZodError");
				response
					.writeHead(signatureError ? 401 : parseError ? 400 : 503)
					.end('{"error":"webhook rejected"}');
			}
			return;
		}
		const claim = /^\/v1\/leases\/([a-f0-9-]{36})\/jit$/.exec(
			request.url ?? "",
		);
		if (request.method === "POST" && claim?.[1]) {
			try {
				const auth = request.headers.authorization;
				if (!auth?.startsWith("Bearer ")) throw new Error("identity required");
				const result = await relay.claim(claim[1], auth.slice(7));
				response.end(toJsonString(JitBootstrapResponseSchema, result));
			} catch {
				response.writeHead(403).end('{"error":"claim rejected"}');
			}
			return;
		}
		response.writeHead(404).end('{"error":"not found"}');
	};
}

export function createRelayServer(relay: Pick<Relay, "webhook" | "claim">) {
	return createServer(createRelayRequestHandler(relay));
}
