import { createServer, type Server } from "node:http";
import { loadBindleDefinition } from "@hobo/cli";
import {
	attachNamedEndpoints,
	createInMemoryMeteringSink,
	createMeteringBus,
} from "@hobo/connectivity";
import type { HttpRequest, HttpResponse } from "@hobo/core";
import { first, must } from "@hobo/core/total-access";
import { applySessionReplayToEntrypoints } from "@hobo/replay";
import {
	createInProcessWasmtimeEngine,
	createRuntimeLocalComponentHost,
	createWasmtimeCliEngine,
} from "@hobo/runtime-local";
import {
	type BareMetalServeResult,
	type ComponentEndpoint,
	collectBindleEnvInjections,
	type FetchHandler,
	installInternalMesh,
	internalMeshBase,
	serviceDiscoveryKey,
} from "./bare-metal-host.js";
import {
	type BareMetalYard,
	composeBareMetalTopology,
	DEFAULT_DEV_PORT,
	openBareMetalYard,
} from "./bare-metal-yard.js";
import { createHttpComponentDescriptor } from "./component-http.js";
import { isJsonObject, isJsonString } from "./json.js";
import { orderLocalComponents } from "./local-component-order.js";
import {
	localHttpHealthCheck,
	waitForLocalHttpHealth,
} from "./local-health.js";
import { listServableEntrypointFactories } from "./servable-entrypoints.js";

export type LocalYardServeResult = BareMetalServeResult & {
	readonly componentHost: "local";
	readonly engine: {
		readonly source: "cli" | "in-process";
		readonly version: string;
	};
};

function resolveEngine() {
	try {
		const engine = createWasmtimeCliEngine();
		return {
			source: "cli" as const,
			version: engine.version,
			engine,
		};
	} catch {
		const engine = createInProcessWasmtimeEngine();
		return {
			source: "in-process" as const,
			version: engine.version,
			engine,
		};
	}
}

async function webRequestToHttp(request: Request): Promise<HttpRequest> {
	const url = new URL(request.url);
	const body =
		request.method === "GET" || request.method === "HEAD"
			? ""
			: await request.text();
	return {
		method: request.method,
		path: `${url.pathname}${url.search}`,
		headers: [...request.headers.entries()] as [string, string][],
		body,
	};
}

function httpResponseToWeb(response: HttpResponse): Response {
	return new Response(Buffer.from(response.body, "latin1"), {
		status: response.status,
		headers: Object.fromEntries(response.headers),
	});
}

async function listen(
	handler: FetchHandler,
	port: number,
	host = "127.0.0.1",
): Promise<Server> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			void (async () => {
				try {
					const bound = server.address();
					const boundPort =
						bound !== null && isJsonObject(bound) ? bound.port : port;
					const authority =
						isJsonString(req.headers.host) && req.headers.host.length > 0
							? req.headers.host
							: `${host}:${boundPort}`;
					const url = new URL(req.url ?? "/", `http://${authority}`);
					const body = Buffer.concat(chunks);
					const method = req.method ?? "GET";
					const init: RequestInit = {
						method,
						headers: req.headers as HeadersInit,
					};
					if (!["GET", "HEAD"].includes(method) && body.length > 0) {
						init.body = body;
					}
					const response = await handler(new Request(url, init));
					res.writeHead(
						response.status,
						Object.fromEntries(response.headers.entries()),
					);
					res.end(Buffer.from(await response.arrayBuffer()));
				} catch (error) {
					res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
					res.end(String(error));
				}
			})();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	return server;
}

export async function serveBindleOnLocalYard(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<LocalYardServeResult> {
	const emit = options.emitProgress ?? (() => {});
	const definition = await loadBindleDefinition(options.projectDir);
	if (definition === null) {
		throw new Error(
			`no loadable bindle in ${options.projectDir} (need src/bindle.ts or dist/bindle.js)`,
		);
	}
	const bindleEnv = collectBindleEnvInjections(definition);

	const ownedYard =
		options.yard === undefined
			? openBareMetalYard({
					...(options.hoboHome !== undefined
						? { hoboHome: options.hoboHome }
						: undefined),
				})
			: null;
	const yardHandle = options.yard ?? must(ownedYard);
	const basePort =
		options.port ?? yardHandle.config.defaultPort ?? DEFAULT_DEV_PORT;

	const engineInfo = resolveEngine();
	emit(
		`hobo dev: local Yard '${yardHandle.config.name}' placing Camp (component host=local, engine=${engineInfo.source} ${engineInfo.version})`,
	);

	const topology = composeBareMetalTopology(definition, {
		yardName: yardHandle.config.name,
		campEnv: "dev",
		dataDir: yardHandle.config.dataDir,
	});
	const campObject = topology.camps[0];
	if (campObject === undefined) {
		ownedYard?.close();
		throw new Error("Yard topology produced no Camps");
	}
	emit(
		`hobo dev: Camp ${campObject.id} hosts bindle ${definition.name} (provider ${topology.providerId})`,
	);

	let entrypoints: ReturnType<typeof listServableEntrypointFactories>;
	let healthChecks: Map<string, ReturnType<typeof localHttpHealthCheck>>;
	try {
		const factories = listServableEntrypointFactories(definition);
		const rank = (entry: (typeof factories)[number]) =>
			entry.external ? 0 : entry.kind === "api" ? 1 : 2;
		entrypoints = orderLocalComponents(
			factories.sort((a, b) => rank(a) - rank(b)),
			definition.edges,
		);
		healthChecks = new Map(
			entrypoints.map((entry) => [
				entry.name,
				localHttpHealthCheck(must(definition.resources[entry.name])),
			]),
		);
	} catch (error) {
		ownedYard?.close();
		throw error;
	}
	if (entrypoints.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no api/web entrypoints to serve`,
		);
	}

	const componentHost = createRuntimeLocalComponentHost({
		engine: engineInfo.engine,
		appendEvent: (event) => emit(JSON.stringify(event)),
	});
	if (!entrypoints.some((entry) => entry.external)) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no external endpoint to expose`,
		);
	}
	const replayEnv = { ...process.env };
	const replay = applySessionReplayToEntrypoints([], definition, {
		env: replayEnv,
	});
	const privateHandlers = new Map<string, FetchHandler>();
	const uninstallMesh = installInternalMesh(privateHandlers, {
		bindleName: definition.name,
	});
	const endpoints: ComponentEndpoint[] = [];
	const serviceDiscovery: Record<string, string> = {};
	const servers: Server[] = [];
	const loaded: string[] = [];
	const started = new Set<string>();
	const candidateNames = new Set(entrypoints.map((entry) => entry.name));
	const originalEnv = new Map<string, string | undefined>();
	const installedEnv = new Map<string, string>();
	const setEnv = (key: string, value: string) => {
		if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
		installedEnv.set(key, value);
		process.env[key] = value;
	};
	let named: Awaited<ReturnType<typeof attachNamedEndpoints>> | undefined;
	let stopped: (() => void) | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			const serverResults = await Promise.allSettled(
				servers.map(
					(server) =>
						new Promise<void>((resolve, reject) => {
							server.close((error) => (error ? reject(error) : resolve()));
						}),
				),
			);
			for (const name of [...loaded].reverse()) {
				try {
					await componentHost.teardownComponent(name);
				} catch {}
			}
			uninstallMesh();
			try {
				await named?.close();
			} finally {
				for (const [key, value] of installedEnv) {
					if (process.env[key] !== value) continue;
					const previous = originalEnv.get(key);
					if (previous === undefined) delete process.env[key];
					else process.env[key] = previous;
				}
				ownedYard?.close();
				stopped?.();
			}
			const failure = serverResults.find(
				(result) => result.status === "rejected",
			);
			if (failure?.status === "rejected") throw failure.reason;
		})();
		return closing;
	};
	const waitUntilStopped = () =>
		new Promise<void>((resolve) => {
			stopped = resolve;
			const onSignal = () => {
				void close().then(resolve);
			};
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
		});
	try {
		for (const [key, value] of Object.entries(bindleEnv)) {
			setEnv(key, value);
		}
		const startupAbort = new AbortController();
		const order = new Map(
			entrypoints.map((entry, index) => [entry.name, index]),
		);
		const publicPorts = new Map<string, number>();
		let publicIndex = 0;
		for (const entry of entrypoints) {
			if (!entry.external) continue;
			publicPorts.set(entry.name, basePort === 0 ? 0 : basePort + publicIndex);
			publicIndex += 1;
		}
		const startEntry = async (entry: (typeof entrypoints)[number]) => {
			startupAbort.signal.throwIfAborted();
			const missing = definition.edges.find(
				(edge) =>
					edge.from === entry.name &&
					candidateNames.has(edge.to) &&
					!started.has(edge.to),
			);
			if (missing) {
				throw new Error(
					`local component ${entry.name} requires ${missing.to}, which did not start`,
				);
			}
			const handler = entry.createHandler();
			if (handler === null) return;
			const wrapped = first(
				applySessionReplayToEntrypoints(
					[
						{
							name: entry.name,
							kind: entry.kind,
							external: entry.external,
							handler,
						},
					],
					definition,
					{ env: replayEnv, store: replay.store },
				).entrypoints,
			);
			loaded.push(entry.name);
			componentHost.loadComponent(
				createHttpComponentDescriptor(entry.name, wrapped.handler, "latin1"),
			);
			emit(
				`hobo dev: component host loaded ${entry.kind}:${entry.name}` +
					(entry.external ? " (external)" : " (private mesh)"),
			);
			const componentId = entry.name;
			const componentHandler: FetchHandler = async (request) => {
				const httpReq = await webRequestToHttp(request);
				const httpRes = await componentHost.handleHttp(componentId, httpReq);
				return httpResponseToWeb(httpRes);
			};
			let url: string;
			let port: number | null = null;
			if (entry.external) {
				const server = await listen(
					componentHandler,
					must(publicPorts.get(entry.name)),
				);
				servers.push(server);
				startupAbort.signal.throwIfAborted();
				const address = server.address();
				if (address === null || isJsonString(address)) {
					throw new Error(
						`external ${entry.kind}:${entry.name} has no TCP port`,
					);
				}
				port = address.port;
				url = `http://127.0.0.1:${port}`;
				emit(`hobo dev: Yard exposed ${entry.kind}:${entry.name} at ${url}`);
			} else {
				privateHandlers.set(entry.name, componentHandler);
				url = internalMeshBase(definition.name, entry.name);
				emit(`hobo dev: private ${entry.kind}:${entry.name} → ${url} (no TCP)`);
			}
			const key = serviceDiscoveryKey(entry.name);
			endpoints.push({
				resourceName: entry.name,
				kind: entry.kind,
				url,
				port,
				external: entry.external,
				serviceDiscoveryKey: key,
			});
			const health = healthChecks.get(entry.name);
			if (health) {
				await waitForLocalHttpHealth(
					entry.name,
					url,
					health,
					startupAbort.signal,
				);
				emit(
					`hobo dev: ${entry.kind}:${entry.name} passed its HTTP health check`,
				);
			}
			serviceDiscovery[key] = url;
			setEnv(key, url);
			started.add(entry.name);
		};
		const tasks = new Map<string, Promise<void>>();
		let failed = false;
		let startupFailure: unknown;
		for (const entry of entrypoints) {
			const dependencies = definition.edges
				.filter(
					(edge) => edge.from === entry.name && candidateNames.has(edge.to),
				)
				.map((edge) => must(tasks.get(edge.to)));
			const task = Promise.all(dependencies)
				.then(() => startEntry(entry))
				.catch((error) => {
					const failure =
						error instanceof Error ? error : new Error(String(error));
					if (!failed) {
						failed = true;
						startupFailure = failure;
						startupAbort.abort(failure);
					}
					throw failure;
				});
			tasks.set(entry.name, task);
		}
		await Promise.allSettled(tasks.values());
		if (failed) throw startupFailure;
		endpoints.sort(
			(a, b) =>
				must(order.get(a.resourceName)) - must(order.get(b.resourceName)),
		);
		const exposedEndpoints = endpoints.filter((entry) => entry.external);
		if (exposedEndpoints.length === 0) {
			throw new Error(
				`bindle ${definition.name} has no external endpoint to expose`,
			);
		}
		const meteringSink = createInMemoryMeteringSink("local-yard");
		const metering = createMeteringBus([meteringSink]);
		named = await attachNamedEndpoints({
			app: definition.name,
			env: "local",
			sessionId: `local-yard:${campObject.id}`,
			metering,
			emitProgress: emit,
			processEnv: { ...process.env },
			endpoints: endpoints.map((endpoint) => ({
				resourceName: endpoint.resourceName,
				kind: endpoint.kind,
				backendUrl: endpoint.url,
				external: endpoint.external,
				serviceDiscoveryKey: endpoint.serviceDiscoveryKey,
			})),
		});
		for (const [key, value] of Object.entries(named.serviceDiscovery)) {
			serviceDiscovery[key] = value;
			setEnv(key, value);
		}
		for (const endpoint of named.namedEndpoints) {
			setEnv(
				`HOBO_NAMED_${endpoint.resourceName.toUpperCase()}_URL`,
				endpoint.url,
			);
		}
		emit(
			`hobo dev: Camp injected discovery [${Object.keys(serviceDiscovery).join(", ")}] ` +
				`bindle-env [${Object.keys(bindleEnv).join(", ")}]` +
				(named.primaryNamedUrl ? ` named=${named.primaryNamedUrl}` : ""),
		);
		const primary = first(exposedEndpoints);
		let probe = { status: 0, body: "" };
		try {
			const response = await fetch(`${primary.url}/`);
			probe = { status: response.status, body: await response.text() };
		} catch (error) {
			probe = { status: 0, body: String(error) };
		}
		emit(`hobo dev: probe ${primary.url}/ -> ${probe.status}`);
		return {
			projectDir: options.projectDir,
			bindleName: definition.name,
			yard: topology,
			campId: campObject.id,
			endpoints,
			exposedEndpoints,
			serviceDiscovery,
			bindleEnv,
			primaryUrl: primary.url,
			namedEndpoints: named.namedEndpoints,
			primaryNamedUrl: named.primaryNamedUrl,
			probe,
			close,
			waitUntilStopped,
			componentHost: "local",
			engine: {
				source: engineInfo.source,
				version: engineInfo.version,
			},
		};
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}

/** @deprecated */
export const serveProjectOnLocalCamp = serveBindleOnLocalYard;
export type LocalCampServeResult = LocalYardServeResult;
