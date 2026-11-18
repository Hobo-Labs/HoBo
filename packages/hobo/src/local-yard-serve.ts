import { createServer, type Server } from "node:http";
import { loadBindleDefinition } from "@hobo/cli";
import {
	attachNamedEndpoints,
	createInMemoryMeteringSink,
	createMeteringBus,
} from "@hobo/connectivity";
import type {
	HttpRequest,
	HttpResponse,
} from "@hobo/core";
import { first, must } from "@hobo/core/total-access";
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
	listServableEntrypoints,
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

	const definition = await loadBindleDefinition(options.projectDir);
	if (definition === null) {
		ownedYard?.close();
		throw new Error(
			`no loadable bindle in ${options.projectDir} (need src/bindle.ts or dist/bindle.js)`,
		);
	}

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

	const entrypoints = listServableEntrypoints(definition);
	if (entrypoints.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no api/web entrypoints to serve`,
		);
	}

	const componentHost = createRuntimeLocalComponentHost({
		engine: engineInfo.engine,
		appendEvent: () => {},
	});
	for (const entry of entrypoints) {
		componentHost.loadComponent(
			createHttpComponentDescriptor(entry.name, entry.handler, "latin1"),
		);
		emit(
			`hobo dev: component host loaded ${entry.kind}:${entry.name}` +
				(entry.external ? " (external)" : " (private mesh)"),
		);
	}

	const externalEntries = entrypoints.filter((e) => e.external);
	const privateEntries = entrypoints.filter((e) => !e.external);
	if (externalEntries.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no external endpoint to expose`,
		);
	}

	const privateHandlers = new Map<string, FetchHandler>();
	for (const entry of privateEntries) {
		const componentId = entry.name;
		privateHandlers.set(componentId, async (request) => {
			const httpReq = await webRequestToHttp(request);
			const httpRes = await componentHost.handleHttp(componentId, httpReq);
			return httpResponseToWeb(httpRes);
		});
	}
	const uninstallMesh = installInternalMesh(privateHandlers, {
		bindleName: definition.name,
	});

	const endpoints: ComponentEndpoint[] = [];
	const serviceDiscovery: Record<string, string> = {};

	for (const entry of privateEntries) {
		const url = internalMeshBase(definition.name, entry.name);
		const key = serviceDiscoveryKey(entry.name);
		endpoints.push({
			resourceName: entry.name,
			kind: entry.kind,
			url,
			port: null,
			external: false,
			serviceDiscoveryKey: key,
		});
		serviceDiscovery[key] = url;
		process.env[key] = url;
		emit(`hobo dev: private ${entry.kind}:${entry.name} → ${url} (no TCP)`);
	}

	const servers: Server[] = [];
	let publicIndex = 0;
	for (const entry of externalEntries) {
		const requestedPort = basePort === 0 ? 0 : basePort + publicIndex;
		publicIndex += 1;
		const componentId = entry.name;
		const publicHandler: FetchHandler = async (request) => {
			const httpReq = await webRequestToHttp(request);
			const httpRes = await componentHost.handleHttp(componentId, httpReq);
			return httpResponseToWeb(httpRes);
		};
		const server = await listen(publicHandler, requestedPort);
		const address = server.address();
		if (address === null || isJsonString(address)) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			throw new Error(`external ${entry.kind}:${entry.name} has no TCP port`);
		}
		const port = address.port;
		const url = `http://127.0.0.1:${port}`;
		const key = serviceDiscoveryKey(entry.name);
		endpoints.push({
			resourceName: entry.name,
			kind: entry.kind,
			url,
			port,
			external: true,
			serviceDiscoveryKey: key,
		});
		serviceDiscovery[key] = url;
		process.env[key] = url;
		servers.push(server);
		emit(`hobo dev: Yard exposed ${entry.kind}:${entry.name} at ${url}`);
	}

	const bindleEnv = collectBindleEnvInjections(definition);
	for (const [key, value] of Object.entries(bindleEnv)) {
		process.env[key] = value;
	}

	const meteringSink = createInMemoryMeteringSink("local-yard");
	const metering = createMeteringBus([meteringSink]);
	const named = await attachNamedEndpoints({
		app: definition.name,
		env: "local",
		sessionId: `local-yard:${campObject.id}`,
		metering,
		emitProgress: emit,
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
		process.env[key] = value;
	}

	emit(
		`hobo dev: Camp injected discovery [${Object.keys(serviceDiscovery).join(", ")}] ` +
			`bindle-env [${Object.keys(bindleEnv).join(", ")}]` +
			(named.primaryNamedUrl ? ` named=${named.primaryNamedUrl}` : ""),
	);

	const exposedEndpoints = endpoints.filter((e) => e.external);
	const primary = first(exposedEndpoints);
	let probe = { status: 0, body: "" };
	try {
		const response = await fetch(`${primary.url}/`);
		probe = { status: response.status, body: await response.text() };
	} catch (error) {
		probe = { status: 0, body: String(error) };
	}
	emit(`hobo dev: probe ${primary.url}/ -> ${probe.status}`);

	let stopped: (() => void) | undefined;
	const waitUntilStopped = () =>
		new Promise<void>((resolve) => {
			stopped = resolve;
			const onSignal = () => {
				void close().then(resolve);
			};
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
		});

	const close = async () => {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.close((error) => (error ? reject(error) : resolve()));
					}),
			),
		);
		for (const entry of entrypoints) {
			try {
				await componentHost.teardownComponent(entry.name);
			} catch {
			}
		}
		uninstallMesh();
		await named.close();
		for (const key of Object.keys(serviceDiscovery)) {
			if (process.env[key] === serviceDiscovery[key]) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(bindleEnv)) {
			if (process.env[key] === value) {
				delete process.env[key];
			}
		}
		ownedYard?.close();
		stopped?.();
	};

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
}

/** @deprecated */
export const serveProjectOnLocalCamp = serveBindleOnLocalYard;
export type LocalCampServeResult = LocalYardServeResult;
