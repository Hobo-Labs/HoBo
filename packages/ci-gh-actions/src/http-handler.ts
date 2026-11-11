import { z } from "zod";
import { failureRoute, reportRelayFailure } from "./failure-log.js";
import { verifyIngressForward } from "./ingress-forward.js";
import { verifyWebhookSignature } from "./webhook-signature.js";

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
	): Promise<
		"accepted" | "duplicate" | "ignored" | "requeued" | "foreign-runner"
	>;
	claim(leaseId: string, oidc: string): Promise<Response>;
	control(request: Request): Promise<Response | undefined>;
	ready(): Promise<boolean>;
	/** The relay's MCP server (`createRelayMcp`); a host without one answers 404. */
	mcp?(request: Request): Promise<Response>;
}>;

/** An engine a host reports in health but this relay does not serve. */
export type StubEngine = Readonly<{ ready: () => boolean }>;

const MAX_BODY = 1024 * 1024;
const LEASE =
	/^\/v1\/leases\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/jit$/;

type HttpBody = { readonly [key: string]: string | boolean | HttpBody };

/** The same request addressed to `path`, for a handler that routes on the URL. */
function remount(request: Request, url: URL, path: string): Request {
	const target = new URL(url);
	target.pathname = path;
	if (!request.body)
		return new Request(target, {
			method: request.method,
			headers: request.headers,
		});
	// A streamed body needs `duplex`, which the DOM `RequestInit` does not declare.
	const init = {
		method: request.method,
		headers: request.headers,
		body: request.body,
		duplex: "half",
	} satisfies RequestInit & { duplex: "half" };
	return new Request(target, init);
}

/** The path under `/engines/{id}`, when the request is addressed to that engine. */
function engineSubPath(path: string, id: string): string | undefined {
	const prefix = `/engines/${id}`;
	if (path === prefix) return "/";
	return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : undefined;
}

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

/**
 * The relay's HTTP surface as one Fetch handler, shared by every host: the
 * Node server behind `hobo ci serve` and the container image, and the Vercel
 * function. No local state or background work survives the request.
 */
export function createRelayHandler(options: {
	application: HostedRelayApplication;
	webhookSecret: string;
	/** Accept `X-Hobo-Ingress-Forward` from a webhook ingress in place of GitHub's signature. */
	ingressForwardSecret?: string | undefined;
	/** This relay's engine: `/engines/{id}/…` serves the same routes as the root. */
	engineId?: string;
	/** Other engines the host reports at `/engines/{id}/healthz` and `/readyz`. */
	stubEngines?: Readonly<Record<string, StubEngine>>;
	/** Refuse a request a TLS-terminating proxy says it received over plain HTTP. */
	trustProxy?: boolean;
	now?: () => string;
}): (request: Request) => Promise<Response> {
	if (Buffer.byteLength(options.webhookSecret, "utf8") < 32)
		throw new Error("webhook secret must have at least 32 bytes");
	const forwardSecret = options.ingressForwardSecret;
	if (forwardSecret !== undefined && Buffer.byteLength(forwardSecret) < 32)
		throw new Error("ingress forward secret must have at least 32 bytes");
	const now = options.now ?? (() => new Date().toISOString());
	const engineId = options.engineId ?? "gh-actions";
	const stubEngines = Object.entries(options.stubEngines ?? {});
	return async (request) => {
		const url = new URL(request.url);
		if (options.trustProxy) {
			const proto = request.headers
				.get("x-forwarded-proto")
				?.split(",")[0]
				?.trim()
				.toLowerCase();
			if (proto && proto !== "https")
				return json(403, { error: "insecure proxy forward" });
		}
		for (const [id, stub] of stubEngines) {
			const subPath = engineSubPath(url.pathname, id);
			if (subPath === undefined) continue;
			if (request.method === "GET" && subPath === "/healthz")
				return json(200, { ok: true, engine: id });
			if (request.method === "GET" && subPath === "/readyz") {
				const ready = stub.ready();
				return json(ready ? 200 : 503, { ready, engine: id });
			}
			return json(404, { error: "not found" });
		}
		const mounted = engineSubPath(url.pathname, engineId);
		const path = mounted ?? url.pathname;
		if (request.method === "GET" && path === "/healthz") {
			const engines = new Map<string, HttpBody>([[engineId, { ok: true }]]);
			for (const [id] of stubEngines) engines.set(id, { ok: true });
			return json(200, { ok: true, engines: Object.fromEntries(engines) });
		}
		if (request.method === "GET" && path === "/readyz") {
			let ready = false;
			try {
				ready = await options.application.ready();
			} catch (error) {
				reportRelayFailure(
					"hobo_ci_ready_check_failed",
					{},
					error instanceof Error ? error : undefined,
				);
			}
			const engines = new Map<string, HttpBody>([[engineId, { ready }]]);
			for (const [id, stub] of stubEngines) {
				const stubReady = stub.ready();
				engines.set(id, { ready: stubReady });
				ready &&= stubReady;
			}
			return json(ready ? 200 : 503, {
				ready,
				engines: Object.fromEntries(engines),
			});
		}
		if (request.method === "POST" && path === "/github/webhooks") {
			const raw = await bytes(request).catch(() => undefined);
			if (!raw) return json(413, { error: "webhook body too large" });
			// A webhook ingress has already checked GitHub's signature over these
			// bytes; its own HMAC over the same bytes stands in for it.
			const forwarded =
				forwardSecret !== undefined &&
				verifyIngressForward(
					forwardSecret,
					raw,
					request.headers.get("x-hobo-ingress-forward") ?? undefined,
				);
			if (!forwarded) {
				const verdict = verifyWebhookSignature(
					options.webhookSecret,
					raw,
					request.headers.get("x-hub-signature-256") ?? undefined,
				);
				if (verdict === "malformed")
					return json(401, { error: "signature required" });
				if (verdict === "mismatch")
					return json(401, { error: "webhook rejected" });
			}
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
			} catch (error) {
				// GitHub redelivers on a 503, so the delivery is not lost; the
				// reason it was refused was.
				reportRelayFailure(
					"hobo_ci_webhook_ingest_failed",
					{ event },
					error instanceof Error ? error : undefined,
				);
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
				const response = await options.application.control(
					mounted === undefined ? request : remount(request, url, path),
				);
				return response ? noStore(response) : json(404, { error: "not found" });
			} catch (error) {
				reportRelayFailure(
					"hobo_ci_control_failed",
					{ method: request.method, route: failureRoute(path) },
					error instanceof Error ? error : undefined,
				);
				return json(503, { error: "service unavailable" });
			}
		}
		if (path === "/mcp" && options.application.mcp) {
			try {
				return await options.application.mcp(request);
			} catch (error) {
				reportRelayFailure(
					"hobo_ci_mcp_failed",
					{ method: request.method },
					error instanceof Error ? error : undefined,
				);
				return json(503, { error: "service unavailable" });
			}
		}
		return json(404, { error: "not found" });
	};
}
