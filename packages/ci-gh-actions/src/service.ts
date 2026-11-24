import { createServer, type ServerResponse } from "node:http";
import type { HostedRelayApplication } from "./http-handler.js";
import { createNodeRelayHandler } from "./node-http.js";

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
		| "agent.tick_failed"
		| "readiness.failed";
	leaseId?: string;
}>;

export type RelayServiceOptions = {
	origin: string;
	allowLoopbackHttp?: boolean;
	handle: (ready: () => boolean) => (request: Request) => Promise<Response>;
	tick: () => Promise<void>;
	agentTick?: () => Promise<void>;
	agentIntervalMs?: number;
	close: () => void;
	streams?: (pathname: string) => boolean;
	quiesce?: () => Promise<void>;
	host?: string;
	port: number;
	tickIntervalMs?: number;
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
	drainTimeoutMs?: number;
	readinessProbe: (signal: AbortSignal) => Promise<boolean>;
	logger?: (entry: RelayServiceLog) => void;
};

function interval(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)
		throw new Error(`invalid ${name}`);
	return value;
}

export function admitWhenReady(
	application: HostedRelayApplication,
	ready: () => boolean,
): HostedRelayApplication {
	const startFence = application.startFence;
	const gated: HostedRelayApplication = {
		...application,
		ready: async () => ready(),
		async ingestWebhook(input) {
			if (!ready()) throw new Error("relay is not ready");
			return application.ingestWebhook(input);
		},
		async claim(leaseId, oidc) {
			if (!ready()) throw new Error("relay is not ready");
			return application.claim(leaseId, oidc);
		},
	};
	if (!startFence) return gated;
	return {
		...gated,
		async startFence(request: Request) {
			if (!ready())
				return Response.json(
					{ ok: false },
					{ status: 503, headers: { "Cache-Control": "no-store" } },
				);
			return startFence(request);
		},
	};
}

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
	const agentIntervalMs = interval(
		options.agentIntervalMs ?? 60_000,
		"agent interval",
	);
	let stopping = false;
	let isReady = false;
	let agentWorker: Promise<void> | undefined;
	let agentTimer: ReturnType<typeof setInterval> | undefined;
	let started: Promise<void> | undefined;
	let stoppingResult: Promise<{ drained: boolean }> | undefined;
	let worker: Promise<void> | undefined;
	let probe: Promise<boolean> | undefined;
	let lastProbeAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setInterval> | undefined;
	const requests = new Set<Promise<void>>();
	const responses = new Set<ServerResponse>();

	function log(entry: RelayServiceLog): void {
		try {
			options.logger?.(Object.freeze(entry));
		} catch {
		}
	}
	async function unavailable(response: ServerResponse): Promise<void> {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Cache-Control", "no-store");
		response.writeHead(503).end('{"error":"service unavailable"}');
	}
	function ready(): boolean {
		return !stopping && isReady && Date.now() - lastProbeAt < probeIntervalMs;
	}
	const handle = options.handle(ready);
	const handler = createNodeRelayHandler({
		origin: options.origin,
		allowLoopbackHttp: options.allowLoopbackHttp === true,
		streams: (pathname) => options.streams?.(pathname) === true,
		async handle(request) {
			try {
				return await handle(request);
			} catch (error) {
				log({ level: "error", event: "service.http_failed" });
				throw error;
			}
		},
	});
	const server = createServer((request, response) => {
		responses.add(response);
		const probing =
			request.method === "GET" &&
			/\/(?:healthz|readyz)$/.test(request.url ?? "");
		const pending = (
			stopping && !probing ? unavailable(response) : handler(request, response)
		)
			.catch(() => {
				log({ level: "error", event: "service.http_failed" });
				if (!response.headersSent) void unavailable(response);
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
			if (Date.now() - lastProbeAt >= probeIntervalMs) await checkReadiness();
			if (!ready()) return;
			await options.tick();
		})()
			.catch(() => {
				log({ level: "error", event: "worker.tick_failed" });
			})
			.finally(() => {
				worker = undefined;
			});
	}
	function agentTick(): void {
		const pass = options.agentTick;
		if (!pass || stopping || agentWorker || !ready()) return;
		agentWorker = Promise.resolve()
			.then(pass)
			.catch(() => {
				log({ level: "error", event: "agent.tick_failed" });
			})
			.finally(() => {
				agentWorker = undefined;
			});
	}
	function start(): Promise<void> {
		if (started) return started;
		if (stopping) return Promise.reject(new Error("relay service is stopped"));
		started = (async () => {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(options.port, options.host ?? "127.0.0.1", () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			if (stopping) return;
			timer = setInterval(tick, tickIntervalMs);
			if (options.agentTick)
				agentTimer = setInterval(agentTick, agentIntervalMs);
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
		clearInterval(agentTimer);
		for (const response of responses)
			if (!response.headersSent) response.setHeader("Connection", "close");
		log({ level: "info", event: "service.draining" });
		stoppingResult = (async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const drained = (async () => {
				await started?.catch(() => undefined);
				await options.quiesce?.().catch(() => undefined);
				const closed = new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
				await Promise.all([closed, worker, agentWorker, probe, ...requests]);
				options.close();
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
