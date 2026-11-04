import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** An authenticated transport envelope; the application owns durable admission. */
export type VerifiedWebhook = Readonly<{
	deliveryId: string;
	event: "workflow_job" | "workflow_run";
	rawBody: Uint8Array;
	receivedAt: string;
}>;

/** The application must durably commit a delivery before resolving ingestWebhook. */
export type HostedRelayApplication = Readonly<{
	ingestWebhook(
		input: VerifiedWebhook,
	): Promise<"accepted" | "duplicate" | "ignored" | "requeued">;
	claim(leaseId: string, oidc: string): Promise<Response>;
	control(request: Request): Promise<Response | undefined>;
	ready(): Promise<boolean>;
}>;

const MAX_BODY = 1024 * 1024;
const LEASE =
	/^\/v1\/leases\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/jit$/;

type HttpBody = Record<string, string | boolean>;

function json(status: number, message: HttpBody): Response {
	return Response.json(message, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function noStore(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function bytes(request: Request): Promise<Uint8Array | undefined> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)
	)
		return undefined;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > MAX_BODY) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/** Vercel request adapter; no local state or background work survives the request. */
export function createVercelRelayHandler(options: {
	application: HostedRelayApplication;
	webhookSecret: string;
	now?: () => string;
}): (request: Request) => Promise<Response> {
	if (Buffer.byteLength(options.webhookSecret, "utf8") < 32)
		throw new Error("webhook secret must have at least 32 bytes");
	const now = options.now ?? (() => new Date().toISOString());
	return async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (request.method === "GET" && path === "/healthz")
			return json(200, { ok: true });
		if (request.method === "GET" && path === "/readyz") {
			try {
				const ready = await options.application.ready();
				return json(ready ? 200 : 503, { ready });
			} catch {
				return json(503, { ready: false });
			}
		}
		if (request.method === "POST" && path === "/github/webhooks") {
			const raw = await bytes(request).catch(() => undefined);
			if (!raw) return json(413, { error: "webhook body too large" });
			const signature = request.headers.get("x-hub-signature-256") ?? "";
			if (!/^sha256=[a-f0-9]{64}$/.test(signature))
				return json(401, { error: "signature required" });
			const expected = createHmac("sha256", options.webhookSecret)
				.update(raw)
				.digest();
			if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
				return json(401, { error: "webhook rejected" });
			const event = request.headers.get("x-github-event");
			if (event !== "workflow_job" && event !== "workflow_run")
				return json(202, { status: "ignored" });
			let value: unknown;
			try {
				value = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "invalid webhook body" });
			}
			const parsed = z.record(z.string(), z.unknown()).safeParse(value);
			if (
				!parsed.success ||
				Object.getOwnPropertyDescriptor(parsed.data, event) === undefined ||
				Object.getOwnPropertyDescriptor(
					parsed.data,
					event === "workflow_job" ? "workflow_run" : "workflow_job",
				) !== undefined
			)
				return json(400, { error: "webhook event mismatch" });
			const deliveryId = request.headers.get("x-github-delivery") ?? "";
			if (!/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId))
				return json(400, { error: "invalid delivery identity" });
			try {
				const status = await options.application.ingestWebhook({
					deliveryId,
					event,
					rawBody: raw,
					receivedAt: now(),
				});
				return json(202, { status });
			} catch {
				return json(503, { error: "webhook rejected" });
			}
		}
		const match = LEASE.exec(path);
		if (request.method === "POST" && match?.[1]) {
			const authorization = request.headers.get("authorization") ?? "";
			if (!/^Bearer \S{1,16384}$/.test(authorization))
				return json(403, { error: "claim rejected" });
			try {
				return noStore(
					await options.application.claim(match[1], authorization.slice(7)),
				);
			} catch {
				return json(403, { error: "claim rejected" });
			}
		}
		if (
			(path.startsWith("/v1/app-registration/") ||
				path.startsWith("/v1/accounts/self/") ||
				path.startsWith("/v2/accounts/self/")) &&
			!/%2f|%5c/i.test(path)
		) {
			try {
				const response = await options.application.control(request);
				return response ? noStore(response) : json(404, { error: "not found" });
			} catch {
				return json(503, { error: "service unavailable" });
			}
		}
		return json(404, { error: "not found" });
	};
}
