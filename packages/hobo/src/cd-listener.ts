import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import type { FeedRequest, FeedResponse, HealthReport } from "@hobo/cd";
import { FEED_ROUTES } from "@hobo/cd/feed";
import {
	CD_SERVICE_STEPS,
	type CdControlApi,
	type CdServiceHost,
	parseReadRequest,
	serviceReason,
} from "@hobo/cd/service";
import { isJsonString } from "./json.js";

export type CdOperatorRequest = Omit<FeedRequest, "body">;

export type CdListenerAccess =
	| Readonly<{ kind: "loopback" }>
	| Readonly<{
			kind: "authenticated";
			publicOrigin: string;
			tls: Readonly<{ cert: string | Buffer; key: string | Buffer }>;
			authorizeOperator(request: CdOperatorRequest): Promise<boolean>;
	  }>;

export type CdListener = Readonly<{
	url: string;
	port: number;
	close(signal?: AbortSignal): Promise<void>;
}>;

type CdHttpStatus = Readonly<{
	ok: boolean;
	code?: string;
	checks?: HealthReport["checks"];
	simulated?: boolean;
	refusals?: readonly string[];
	reasons?: readonly Readonly<{
		code: string;
		message: string;
		remediation: string;
		subject: string;
	}>[];
}>;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DRAIN_WAIT_MS = 30_000;
const SAFE_CHECK_NAMES = new Set([
	"started",
	"store",
	"drain",
	...CD_SERVICE_STEPS.map((step) => `step:${step}`),
]);
const PUBLIC_FEED_PATHS = new Set<string>([
	FEED_ROUTES.enrollments,
	FEED_ROUTES.svidRefresh,
	FEED_ROUTES.leases,
	FEED_ROUTES.leaseRenew,
	FEED_ROUTES.leaseRelease,
	FEED_ROUTES.feed,
	FEED_ROUTES.observations,
	FEED_ROUTES.checkpoints,
]);

function loopback(host: string): boolean {
	return (
		host === "localhost" ||
		host === "::1" ||
		(isIP(host) === 4 && host.startsWith("127."))
	);
}

function publicFeed(request: CdOperatorRequest): boolean {
	const parsed = parseReadRequest({ ...request, body: new Uint8Array() });
	const path = new URL(request.path, "http://cd.invalid").pathname;
	return (
		parsed.ok &&
		parsed.value.kind === "feed" &&
		(PUBLIC_FEED_PATHS.has(path) ||
			/^\/v1\/cd\/blobs\/sha256(?::|%3a)[0-9a-f]{1,64}$/iu.test(path))
	);
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 4 MiB");
		chunks.push(buf);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function headersOf(req: IncomingMessage) {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		headers[key.toLowerCase()] = Array.isArray(value)
			? value.join(", ")
			: value;
	}
	return headers;
}

function json(status: number, value: CdHttpStatus): FeedResponse {
	return {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
		body: new TextEncoder().encode(JSON.stringify(value)),
	};
}

export function sanitizedCdHealth(report: HealthReport): HealthReport {
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	let reconcilers: boolean | undefined;
	let other: boolean | undefined;
	for (const check of report.checks) {
		if (check.name.startsWith("reconciler:")) {
			reconcilers = (reconcilers ?? true) && check.ok;
		} else if (SAFE_CHECK_NAMES.has(check.name)) {
			checks.push({
				name: check.name,
				ok: check.ok,
				detail: check.ok ? "ok" : "unavailable",
			});
		} else {
			other = (other ?? true) && check.ok;
		}
	}
	if (reconcilers !== undefined)
		checks.push({
			name: "reconcilers",
			ok: reconcilers,
			detail: reconcilers ? "ok" : "unavailable",
		});
	if (other !== undefined)
		checks.push({
			name: "dependencies",
			ok: other,
			detail: other ? "ok" : "unavailable",
		});
	return { ok: report.ok, checks };
}

function responseDrain(
	res: ServerResponse,
	timeoutMs: number,
): Promise<boolean> {
	if (res.destroyed || res.writableEnded) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (drained: boolean) => {
			clearTimeout(timer);
			res.removeListener("drain", onDrain);
			res.removeListener("close", onClose);
			res.removeListener("error", onClose);
			resolve(drained);
		};
		const onDrain = () => finish(true);
		const onClose = () => finish(false);
		const timer = setTimeout(() => {
			finish(false);
			if (!res.destroyed) res.destroy();
		}, timeoutMs);
		timer.unref?.();
		res.once("drain", onDrain);
		res.once("close", onClose);
		res.once("error", onClose);
		if (res.destroyed || res.writableEnded) finish(false);
	});
}

export async function sendCdResponse(
	res: ServerResponse,
	response: FeedResponse,
	drainTimeoutMs = MAX_DRAIN_WAIT_MS,
): Promise<void> {
	res.writeHead(response.status, { ...response.headers });
	const body = response.body;
	if (body instanceof Uint8Array) {
		res.end(Buffer.from(body));
		return;
	}
	for await (const chunk of body) {
		if (res.destroyed) break;
		if (
			!res.write(Buffer.from(chunk)) &&
			!(await responseDrain(res, drainTimeoutMs))
		)
			return;
	}
	res.end();
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function startCdListener(
	input: Readonly<{
		host: string;
		port: number;
		access: CdListenerAccess;
		runtimeOrigin?: string;
		issuerKeyId?: string;
		service: Pick<CdServiceHost, "start" | "ready" | "health" | "drain">;
		api: Pick<CdControlApi, "handle" | "pathPrefix">;
		simulated: boolean;
		refusals: readonly string[];
	}>,
): Promise<CdListener> {
	const { access, service, api } = input;
	if (access.kind === "loopback" && !loopback(input.host))
		throw new Error(
			"CD operator access without authentication requires a loopback listener",
		);
	if (access.kind === "authenticated") {
		let origin: URL;
		try {
			origin = new URL(access.publicOrigin);
		} catch {
			throw new Error("CD listener requires a public HTTPS origin");
		}
		if (
			origin.protocol !== "https:" ||
			origin.origin !== access.publicOrigin ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			access.publicOrigin !== input.runtimeOrigin
		)
			throw new Error(
				"CD listener origin must match the runtime's public HTTPS origin",
			);
		if (!input.issuerKeyId || !/^[a-f0-9]{64}$/u.test(input.issuerKeyId))
			throw new Error("CD listener requires an owner-backed SVID issuer");
		const tlsKey = createPublicKey(createPrivateKey(access.tls.key));
		const tlsKeyId = createHash("sha256")
			.update(tlsKey.export({ format: "der", type: "spki" }))
			.digest("hex");
		if (tlsKeyId === input.issuerKeyId)
			throw new Error("CD TLS and agent signing keys must be distinct");
	}
	const abort = new AbortController();
	const ready = () =>
		service.ready() &&
		input.refusals.length === 0 &&
		(access.kind === "loopback" || !input.simulated);
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			try {
				const raw = req.url ?? "/";
				const path = raw.split("?", 1)[0] ?? "/";
				if (
					!path.startsWith("/") ||
					path.startsWith("//") ||
					path.includes("\\")
				)
					return await sendCdResponse(
						res,
						json(400, { ok: false, code: "invalid-path" }),
					);
				if (path === "/healthz")
					return await sendCdResponse(res, json(200, { ok: true }));
				if (path === "/readyz") {
					const available = ready();
					return await sendCdResponse(
						res,
						json(
							available ? 200 : 503,
							access.kind === "loopback"
								? {
										...sanitizedCdHealth(service.health()),
										ok: available,
										simulated: input.simulated,
										refusals:
											input.refusals.length > 0
												? ["conductor-unavailable"]
												: [],
									}
								: { ok: available },
						),
					);
				}
				if (!path.startsWith(api.pathPrefix))
					return await sendCdResponse(
						res,
						json(404, { ok: false, code: "not-found" }),
					);
				const request: CdOperatorRequest = {
					method: req.method ?? "GET",
					path: raw,
					headers: headersOf(req),
				};
				const agentFeed = publicFeed(request);
				if (access.kind === "authenticated" && agentFeed && !ready())
					return await sendCdResponse(
						res,
						json(503, { ok: false, code: "feed-unavailable" }),
					);
				if (access.kind === "authenticated" && !agentFeed) {
					const authorized = await Promise.resolve()
						.then(() => access.authorizeOperator(request))
						.catch(() => false);
					if (authorized !== true)
						return await sendCdResponse(
							res,
							json(401, { ok: false, code: "unauthorized" }),
						);
				}
				const parsed = parseReadRequest({ ...request, body: new Uint8Array() });
				if (
					access.kind === "authenticated" &&
					input.simulated &&
					parsed.ok &&
					parsed.value.kind === "read" &&
					parsed.value.route.kind === "ready"
				) {
					const { code, message, remediation, subject } = serviceReason(
						"not-ready",
						"simulated runtime cannot serve agents",
						"simulation",
					);
					return await sendCdResponse(
						res,
						json(503, {
							ok: false,
							reasons: [{ code, message, remediation, subject }],
						}),
					);
				}
				const perRequest = new AbortController();
				res.on("close", () => perRequest.abort());
				const signal = AbortSignal.any([abort.signal, perRequest.signal]);
				const response = await api.handle(
					{ ...request, body: await readBody(req) },
					signal,
				);
				await sendCdResponse(
					res,
					access.kind === "authenticated" && agentFeed && response.status >= 500
						? json(503, { ok: false, code: "feed-unavailable" })
						: response,
				);
			} catch {
				if (!res.headersSent)
					await sendCdResponse(
						res,
						json(500, { ok: false, code: "cd-serve-error" }),
					);
				else res.destroy();
			}
		})();
	};
	const server: Server =
		access.kind === "authenticated"
			? createHttpsServer(access.tls, handler)
			: createHttpServer(handler);
	let attemptedStart = false;
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(
				input.port,
				input.host === "localhost" ? "127.0.0.1" : input.host,
				() => {
					server.removeListener("error", onError);
					resolve();
				},
			);
		});
		attemptedStart = true;
		await service.start();
	} catch (error) {
		abort.abort();
		const closed = closeServer(server);
		server.closeAllConnections();
		if (attemptedStart)
			await service.drain(AbortSignal.timeout(30_000)).catch(() => {});
		await closed.catch(() => {});
		throw error;
	}
	const address = server.address();
	const port =
		address !== null && !isJsonString(address) ? address.port : input.port;
	const urlHost = input.host.includes(":") ? `[${input.host}]` : input.host;
	const url = `${access.kind === "authenticated" ? "https" : "http"}://${urlHost}:${port}`;
	let closing: Promise<void> | undefined;
	return Object.freeze({
		url,
		port,
		close(signal?: AbortSignal) {
			closing ??= (async () => {
				abort.abort();
				const closed = closeServer(server);
				try {
					await service.drain(signal ?? AbortSignal.timeout(30_000));
				} finally {
					server.closeAllConnections();
					await closed;
				}
			})();
			return closing;
		},
	});
}
