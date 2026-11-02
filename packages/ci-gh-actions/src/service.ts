import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Relay } from "./relay.js";
import { createRelayRequestHandler } from "./server.js";
import type { LeaseStore } from "./store.js";

interface EngineReadyEntry {
	readonly ready: boolean;
}
type EngineReadyMap = Record<string, EngineReadyEntry>;

export type RelayServiceLog = Readonly<{
	level: "info" | "error";
	event:
		| "service.started"
		| "service.draining"
		| "service.drained"
		| "service.drain_timeout"
		| "service.http_failed"
		| "worker.lease_failed"
		| "worker.tick_failed"
		| "readiness.failed";
	leaseId?: string;
}>;

export type RelayServiceOptions = {
	relay: Pick<
		Relay,
		"webhook" | "claim" | "reconcile" | "discover" | "dispatchPending" | "now"
	>;
	store: Pick<LeaseStore, "all" | "recover" | "close">;
	host?: string;
	port: number;
	engineId?: string;
	mountPath?: string;
	legacyRootPaths?: boolean;
	stubEngines?: Readonly<Record<string, { ready: () => boolean }>>;
	tickIntervalMs?: number;
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
	drainTimeoutMs?: number;
	readinessProbe: (signal: AbortSignal) => Promise<boolean>;
	beforeDispatch?: () => Promise<void>;
	controlHandler?: (
		request: IncomingMessage,
		response: ServerResponse,
	) => boolean | Promise<boolean>;
	trustProxy?: boolean;
	logger?: (entry: RelayServiceLog) => void;
};

function interval(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)
		throw new Error(`invalid ${name}`);
	return value;
}

/** Owns HTTP intake, reconciliation and a bounded drain of accepted work. */
export function createRelayService(options: RelayServiceOptions) {
	if (
		!Number.isInteger(options.port) ||
		options.port < 0 ||
		options.port > 65535
	)
		throw new Error("invalid relay port");
	const tickIntervalMs = interval(
		options.tickIntervalMs ?? 5_000,
		"tick interval",
	);
	const probeIntervalMs = interval(
		options.probeIntervalMs ?? 60_000,
		"probe interval",
	);
	const probeTimeoutMs = interval(
		options.probeTimeoutMs ?? 5_000,
		"probe timeout",
	);
	const drainTimeoutMs = interval(
		options.drainTimeoutMs ?? 30_000,
		"drain timeout",
	);
	let stopping = false;
	let isReady = false;
	let started: Promise<void> | undefined;
	let stoppingResult: Promise<{ drained: boolean }> | undefined;
	let worker: Promise<void> | undefined;
	let probe: Promise<boolean> | undefined;
	let lastProbeAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setInterval> | undefined;
	const requests = new Set<Promise<void>>();
	const responses = new Set<ServerResponse>();
	const handler = createRelayRequestHandler(options.relay);
	const engineId = options.engineId ?? "gh-actions";
	const mountPath =
		options.mountPath ??
		(options.engineId ? `/engines/${options.engineId}` : undefined);
	const stubEngines = options.stubEngines ?? {};
	const legacyRootPaths = options.legacyRootPaths !== false;

	function log(entry: RelayServiceLog): void {
		try {
			options.logger?.(Object.freeze(entry));
		} catch {
			// Logging must never turn a durable operation into an HTTP retry.
		}
	}
	function json(
		response: ServerResponse,
		status: number,
		result: string,
	): void {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Cache-Control", "no-store");
		response.writeHead(status).end(result);
	}
	function engineSubPath(url: string, id: string): string | undefined {
		const prefix = `/engines/${id}`;
		if (url === prefix) return "/";
		if (url.startsWith(`${prefix}/`)) return url.slice(prefix.length);
		return undefined;
	}
	function aggregateReady() {
		const engines = {
			[engineId]: { ready: ready() },
		};
		for (const [id, stub] of Object.entries(stubEngines)) {
			engines[id] = { ready: stub.ready() };
		}
		const allReady = Object.values(engines).every((entry) => entry.ready);
		return { ready: allReady, engines } satisfies {
			ready: boolean;
			engines: EngineReadyMap;
		};
	}
	async function handle(request: IncomingMessage, response: ServerResponse) {
		const url = request.url ?? "/";
		if (options.trustProxy) {
			const proto = request.headers["x-forwarded-proto"];
			if (proto !== undefined) {
				const first = (Array.isArray(proto) ? proto[0] : proto)
					?.split(",")[0]
					?.trim()
					.toLowerCase();
				if (first && first !== "https") {
					json(response, 403, '{"error":"insecure proxy forward"}');
					return;
				}
			}
		}
		if (request.method === "GET" && url === "/healthz") {
			const engines = {
				[engineId]: { ok: true },
			};
			for (const id of Object.keys(stubEngines)) engines[id] = { ok: true };
			json(response, 200, JSON.stringify({ ok: true, engines }));
			return;
		}
		if (request.method === "GET" && url === "/readyz") {
			const status = aggregateReady();
			json(response, status.ready ? 200 : 503, JSON.stringify(status));
			return;
		}
		for (const [id, stub] of Object.entries(stubEngines)) {
			const subPath = engineSubPath(url, id);
			if (!subPath) continue;
			if (request.method === "GET" && subPath === "/healthz") {
				json(response, 200, JSON.stringify({ ok: true, engine: id }));
				return;
			}
			if (request.method === "GET" && subPath === "/readyz") {
				json(
					response,
					stub.ready() ? 200 : 503,
					JSON.stringify({ ready: stub.ready(), engine: id }),
				);
				return;
			}
			json(response, 404, '{"error":"not found"}');
			return;
		}
		if (mountPath) {
			const mounted = engineSubPath(url, engineId);
			if (mounted !== undefined) request.url = mounted;
			else if (
				!legacyRootPaths &&
				url.startsWith("/engines/") &&
				engineSubPath(url, engineId) === undefined
			) {
				json(response, 404, '{"error":"not found"}');
				return;
			}
		}
		if (stopping) {
			json(response, 503, '{"error":"service unavailable"}');
			return;
		}
		if (await options.controlHandler?.(request, response)) return;
		if (
			!ready() &&
			(request.url === "/github/webhooks" ||
				request.url?.startsWith("/v1/leases/") ||
				(mountPath !== undefined &&
					request.url?.startsWith(`${mountPath}/github/webhooks`)))
		) {
			json(response, 503, '{"error":"service unavailable"}');
			return;
		}
		await handler(request, response);
	}
	const server = createServer((request, response) => {
		responses.add(response);
		const pending = handle(request, response)
			.catch(() => {
				log({ level: "error", event: "service.http_failed" });
				if (!response.headersSent)
					json(response, 503, '{"error":"service unavailable"}');
				else response.destroy();
			})
			.finally(() => {
				requests.delete(pending);
				responses.delete(response);
				if (stopping) server.closeIdleConnections();
			});
		requests.add(pending);
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;
	server.maxRequestsPerSocket = 1_000;
	server.on("error", () => {
		isReady = false;
		log({ level: "error", event: "service.http_failed" });
	});

	function ready(): boolean {
		return !stopping && isReady && Date.now() - lastProbeAt < probeIntervalMs;
	}
	function checkReadiness(): Promise<boolean> {
		if (stopping) return Promise.resolve(false);
		if (probe) return probe;
		probe = (async () => {
			const abort = new AbortController();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const available = await Promise.race([
					Promise.resolve().then(() => options.readinessProbe(abort.signal)),
					new Promise<boolean>((resolve) => {
						timeout = setTimeout(() => {
							abort.abort();
							resolve(false);
						}, probeTimeoutMs);
					}),
				]);
				isReady = !stopping && available === true;
			} catch {
				isReady = false;
			} finally {
				clearTimeout(timeout);
				lastProbeAt = Date.now();
			}
			if (!isReady && !stopping)
				log({ level: "error", event: "readiness.failed" });
			return ready();
		})().finally(() => {
			probe = undefined;
		});
		return probe;
	}
	function tick(): void {
		if (stopping || worker) return;
		worker = (async () => {
			await options.beforeDispatch?.();
			if (Date.now() - lastProbeAt >= probeIntervalMs) await checkReadiness();
			if (!ready()) return;
			for (const lease of options.store.all()) {
				if (stopping) break;
				if (
					!["running", "claiming", "dispatched", "uncertain"].includes(
						lease.state,
					)
				)
					continue;
				try {
					if (lease.hostRunId > 0)
						await options.relay.reconcile(lease.id, lease.hostRunId);
					else await options.relay.discover(lease.id);
				} catch {
					log({
						level: "error",
						event: "worker.lease_failed",
						leaseId: lease.id,
					});
				}
			}
			if (ready()) await options.relay.dispatchPending();
		})()
			.catch(() => {
				isReady = false;
				log({ level: "error", event: "worker.tick_failed" });
			})
			.finally(() => {
				worker = undefined;
			});
	}
	function start(): Promise<void> {
		if (started) return started;
		if (stopping) return Promise.reject(new Error("relay service is stopped"));
		started = (async () => {
			options.store.recover(options.relay.now());
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(options.port, options.host ?? "127.0.0.1", () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			if (stopping) return;
			timer = setInterval(tick, tickIntervalMs);
			tick();
			log({ level: "info", event: "service.started" });
		})();
		return started;
	}
	function stop(): Promise<{ drained: boolean }> {
		if (stoppingResult) return stoppingResult;
		stopping = true;
		isReady = false;
		clearInterval(timer);
		for (const response of responses)
			if (!response.headersSent) response.setHeader("Connection", "close");
		log({ level: "info", event: "service.draining" });
		stoppingResult = (async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const drained = (async () => {
				// A concurrent start must finish listening before close is called.
				await started?.catch(() => undefined);
				const closed = new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
				await Promise.all([closed, worker, probe, ...requests]);
				options.store.close();
				log({ level: "info", event: "service.drained" });
				return { drained: true };
			})();
			try {
				return await Promise.race([
					drained,
					new Promise<{ drained: boolean }>((resolve) => {
						timeout = setTimeout(() => {
							server.closeAllConnections();
							log({ level: "error", event: "service.drain_timeout" });
							resolve({ drained: false });
						}, drainTimeoutMs);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
		})();
		return stoppingResult;
	}
	return { server, start, stop, ready, checkReadiness };
}
