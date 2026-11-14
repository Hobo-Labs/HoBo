/**
 * Shared Yard → Camp serve path for all component hosts
 * (local | wasm | oci | cloud-native).
 */

import { createServer, type Server } from "node:http";
import { discoveryEnvForDependency, readDependencyConfig } from "@hobo/bindles";
import { loadBindleDefinition } from "@hobo/cli";
import {
	attachNamedEndpoints,
	createInMemoryMeteringSink,
	createMeteringBus,
} from "@hobo/connectivity";
import type {
	FetchHandler,
	HttpRequest,
	HttpResponse,
	ParsedComponentDescriptor,
} from "@hobo/core";
import { first, must } from "@hobo/core/total-access";
import {
	createInProcessWasmtimeEngine,
	createRuntimeLocalComponentHost,
	HTTP_INCOMING_HANDLER,
} from "@hobo/runtime-local";
import {
	type BareMetalServeResult,
	type ComponentEndpoint,
	collectBindleEnvInjections,
	INTERNAL_ROUTER_HOST,
	installInternalRouter,
	internalRouterBase,
	listServableEntrypoints,
	serviceDiscoveryKey,
} from "./bare-metal-host.js";
import {
	type BareMetalYard,
	type ComponentHostKind,
	composeBareMetalTopology,
	DEFAULT_DEV_PORT,
	defaultHoboHome,
	normalizeComponentHostKind,
	openBareMetalYard,
} from "./bare-metal-yard.js";
import { servePrivateOnHost } from "./host-registry.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

interface ResolvedDependency {
	httpUrl?: string;
	connectionString?: string;
}

function jsonObjectFrom(value: JsonValue): JsonObject {
	const cloned = cloneAsJson(value);
	return isJsonObject(cloned) ? cloned : {};
}

function modulePathFromAnnotations(
	annotations:
		| readonly {
				readonly option: string;
				readonly config: { readonly [key: string]: JsonValue | undefined };
		  }[]
		| undefined,
): string | undefined {
	if (annotations === undefined) return undefined;
	for (const annotation of annotations) {
		if (annotation.option !== "module" && annotation.option !== "wasm") {
			continue;
		}
		const path =
			annotation.config.path ??
			annotation.config.module ??
			annotation.config.source;
		if (isJsonString(path) && path.length > 0) return path;
	}
	return undefined;
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
		// SAFETY: assertion required at this I/O or test boundary.
		headers: [...request.headers.entries()] as [string, string][],
		body,
	};
}

function httpResponseToWeb(response: HttpResponse): Response {
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
}

function componentDescriptor(
	id: string,
	handler: FetchHandler,
): ParsedComponentDescriptor {
	return {
		parsed: true,
		id,
		imports: [],
		exports: {
			[HTTP_INCOMING_HANDLER]: {
				// SAFETY: the export table is heterogeneous by design -- each
				// interface has its own argument shape, and `ComponentExport`
				// describes the table, not this entry. The host reads it back through
				// the matching handler type (`HttpIncomingHandler` in runtime-local),
				// so this cast is where that agreement is recorded rather
				// than a claim that the signatures line up.
				handle: (async (httpReq: HttpRequest): Promise<HttpResponse> => {
					const req = httpReq;
					const webReq = new Request(`http://component.local${req.path}`, {
						method: req.method,
						headers: Object.fromEntries(req.headers),
						...(req.body && req.method !== "GET" && req.method !== "HEAD"
							? { body: req.body }
							: undefined),
					});
					const webRes = await handler(webReq);
					return {
						status: webRes.status,
						// SAFETY: assertion required at this I/O or test boundary.
						headers: [...webRes.headers.entries()] as [string, string][],
						body: await webRes.text(),
					};
				}) as never,
			},
		},
	};
}

async function listen(handler: FetchHandler, port: number): Promise<Server> {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const body = Buffer.concat(chunks);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (isJsonString(value)) headers.set(key, value);
				else if (Array.isArray(value)) headers.set(key, value.join(", "));
			}
			const init: RequestInit = {
				method: req.method ?? "GET",
				headers,
			};
			if (req.method !== "GET" && req.method !== "HEAD") {
				init.body = body;
			}
			const response = await handler(new Request(url, init));
			res.statusCode = response.status;
			response.headers.forEach((value, key) => {
				res.setHeader(key, value);
			});
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			res.statusCode = 500;
			res.end(String(error));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	return server;
}

export type MultiHostServeResult = BareMetalServeResult & {
	readonly componentHost: ComponentHostKind;
	readonly isolation?: {
		readonly privateSandboxes: number;
		readonly privateWorkers: number;
		readonly meshHost: typeof INTERNAL_ROUTER_HOST;
		readonly isolateBoundary: string;
		readonly details?: JsonObject;
		readonly wasmtimeVersion?: string;
		readonly wasmPaths?: readonly string[];
	};
};

/**
 * Place a Bindle into a Camp using the selected component host runtime package.
 */
export async function serveProjectOnHost(options: {
	readonly projectDir: string;
	readonly componentHost: ComponentHostKind | string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<MultiHostServeResult> {
	const emit = options.emitProgress ?? (() => {});
	const kind = normalizeComponentHostKind(options.componentHost);
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const ownedYard =
		options.yard === undefined ? openBareMetalYard({ hoboHome }) : null;
	const yardHandle = options.yard ?? must(ownedYard, "ownedYard");
	const basePort =
		options.port ?? yardHandle.config.defaultPort ?? DEFAULT_DEV_PORT;

	emit(
		`hobo dev: local Yard '${yardHandle.config.name}' Camp component host=${kind}`,
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
		throw new Error("local topology produced no camps");
	}
	emit(
		`hobo dev: Camp ${campObject.id} hosts bindle ${definition.name} (provider ${topology.providerId})`,
	);

	const entrypoints = listServableEntrypoints(definition);
	const externalEntries = entrypoints.filter((e) => e.external);
	const privateEntries = entrypoints.filter((e) => !e.external);
	if (externalEntries.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no external endpoint to expose`,
		);
	}

	const bindleEnv = collectBindleEnvInjections(definition);
	// Aspire-style discovery for external / container / wasm-component deps.
	for (const [name, record] of Object.entries(definition.resources)) {
		const depConfig = readDependencyConfig(record.annotations);
		if (depConfig === null && record.kind !== "external") continue;
		const config = depConfig ?? (record.kind === "external" ? {} : null);
		if (config === null) continue;
		const resolved: ResolvedDependency = {};
		if (isJsonString(config.connectionString)) {
			resolved.connectionString = config.connectionString;
		}
		if (
			config.endpoints &&
			isJsonObject(config.endpoints) &&
			config.endpoints !== null
		) {
			// SAFETY: assertion required at this I/O or test boundary.
			const http = (config.endpoints as JsonObject).http;
			if (isJsonString(http)) resolved.httpUrl = http;
		}
		// Mesh URL for dependency kinds served on the camp mesh.
		if (
			record.kind === "container" ||
			record.kind === "wasm-component" ||
			record.kind === "api" ||
			record.kind === "service"
		) {
			resolved.httpUrl =
				resolved.httpUrl ?? internalRouterBase(definition.name, name);
		}
		const discovery = discoveryEnvForDependency(name, config, resolved);
		Object.assign(bindleEnv, discovery);
	}
	for (const [key, value] of Object.entries(bindleEnv)) {
		process.env[key] = value;
	}

	let privateServe: Awaited<ReturnType<typeof servePrivateOnHost>>;
	try {
		privateServe = await servePrivateOnHost({
			kind,
			projectDir: options.projectDir,
			hoboHome,
			bindleEnv,
			emitProgress: emit,
			privateEntries: privateEntries.map((entry) => {
				const moduleOverride = modulePathFromAnnotations(
					// SAFETY: bindle annotation config is a JSON object at the serve boundary.
					definition.resources[entry.name]?.annotations as
						| readonly {
								readonly option: string;
								readonly config: JsonObject;
						  }[]
						| undefined,
				);
				return {
					name: entry.name,
					handler: entry.handler,
					...(moduleOverride !== undefined
						? { modulePath: moduleOverride }
						: undefined),
				};
			}),
		});
	} catch (error) {
		ownedYard?.close();
		throw error;
	}

	const privateHandlers = new Map<string, FetchHandler>(privateServe.handlers);
	const uninstallMesh = installInternalRouter(privateHandlers, {
		bindleEnv,
		bindleName: definition.name,
	});

	const endpoints: ComponentEndpoint[] = [];
	const serviceDiscovery: Record<string, string> = {};

	for (const entry of privateEntries) {
		const url = internalRouterBase(definition.name, entry.name);
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
		emit(
			`hobo dev: private ${entry.kind}:${entry.name} → ${url} (host=${kind}, boundary=${privateServe.isolation.isolateBoundary})`,
		);
	}

	const host = createRuntimeLocalComponentHost({
		engine: createInProcessWasmtimeEngine(),
		appendEvent: () => {},
	});
	const servers: Server[] = [];
	let publicIndex = 0;
	for (const entry of externalEntries) {
		host.loadComponent(componentDescriptor(entry.name, entry.handler));
		const port = basePort + publicIndex;
		publicIndex += 1;
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
		const publicHandler: FetchHandler = async (request) => {
			const httpReq = await webRequestToHttp(request);
			const httpRes = await host.handleHttp(entry.name, httpReq);
			return httpResponseToWeb(httpRes);
		};
		servers.push(await listen(publicHandler, port));
		emit(`hobo dev: exposed ${entry.kind}:${entry.name} at ${url}`);
	}

	const meteringSink = createInMemoryMeteringSink(`host-${kind}`);
	const metering = createMeteringBus([meteringSink]);
	const named = await attachNamedEndpoints({
		app: definition.name,
		env: "local",
		sessionId: `host:${kind}:${campObject.id}`,
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
		`hobo dev: injected discovery [${Object.keys(serviceDiscovery).join(", ")}] ` +
			`bindle-env [${Object.keys(bindleEnv).join(", ")}] host=${kind}` +
			(named.primaryNamedUrl ? ` named=${named.primaryNamedUrl}` : ""),
	);

	const exposedEndpoints = endpoints.filter((e) => e.external);
	const primary = first(exposedEndpoints, "exposedEndpoints");
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
		uninstallMesh();
		await privateServe.close();
		await named.close();
		for (const entry of externalEntries) {
			try {
				await host.teardownComponent(entry.name);
			} catch {
				// already torn down
			}
		}
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

	const details = privateServe.isolation.details ?? {};
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
		componentHost: kind,
		isolation: {
			privateSandboxes: privateServe.isolation.privateSandboxes,
			privateWorkers: privateServe.isolation.privateSandboxes,
			meshHost: INTERNAL_ROUTER_HOST,
			isolateBoundary: privateServe.isolation.isolateBoundary,
			details: jsonObjectFrom(cloneAsJson(details)),
			...(isJsonString(details.wasmtimeVersion)
				? { wasmtimeVersion: details.wasmtimeVersion }
				: undefined),
			...(Array.isArray(details.wasmPaths)
				? {
						wasmPaths: details.wasmPaths.filter((entry): entry is string =>
							isJsonString(entry),
						),
					}
				: undefined),
		},
	};
}
