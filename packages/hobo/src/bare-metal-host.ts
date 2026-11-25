import { createServer, type Server } from "node:http";
import type { BindleDefinition } from "@hobo/bindles";
import { loadBindleDefinition } from "@hobo/cli";
import { sanitizeDnsLabel } from "@hobo/core";
import { first, must } from "@hobo/core/total-access";
import type { Yard } from "@hobo/yards";
import {
	type BareMetalYard,
	composeBareMetalTopology,
	DEFAULT_DEV_PORT,
	openBareMetalYard,
} from "./bare-metal-yard.js";
import { isJsonBoolean, isJsonNumber, isJsonString } from "./json.js";
import {
	type FetchHandler,
	isExternalComponent,
	type ListServableEntrypointsResult,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
	type ServableEntrypoint,
} from "./servable-entrypoints.js";

// Mesh + exposure primitives for a **local Yard** placing Bindles into a **Camp**.
// Glossary: Yard = control plane; Camp = placement target; Component host =
// Camp capability that executes components (see local-yard-serve / isolated-wasm).
//
// Privacy model (wasm-cloud / Aspire external-endpoint posture):
//   - Only components marked *external* open a public TCP listener.
//   - By default `web` is external; `api` / `service` stay private.
//   - Private components are reached only via mesh URLs injected as
//     services__<name>__http__0 = http://<bindle>.hobo.internal/<name>
//   - The Yard/Camp intermediary keeps private surfaces off the public wire.
//
// Session Replay (ADR-0137): listServableEntrypoints wraps Bindle `web`
// handlers — see servable-entrypoints.ts.

function duplexHalfInit(): RequestInit {
	// SAFETY: Node fetch requires duplex when forwarding a streamed request body.
	return { duplex: "half" } as RequestInit;
}

export type { FetchHandler, ListServableEntrypointsResult, ServableEntrypoint };
export {
	isExternalComponent,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
};

// public-contract: reserved zone for in-mesh hops between components.
export const INTERNAL_ROUTER_HOST = "hobo.internal";

export function internalRouterHost(bindleName: string): string {
	const label = sanitizeDnsLabel(bindleName);
	return label.length > 0
		? `${label}.${INTERNAL_ROUTER_HOST}`
		: INTERNAL_ROUTER_HOST;
}

export function isInternalRouterHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === INTERNAL_ROUTER_HOST || host.endsWith(`.${INTERNAL_ROUTER_HOST}`)
	);
}

/**
 * HTTP header prefix HoBo mesh uses to inject bindle env into private hops
 * (including isolated-wasm sandboxes). Guests must read camp config from these
 * headers, not from host process.env.
 */
// public-contract: wire prefix for per-key bindle env injected over mesh hops.
export const HOBO_ENV_HEADER_PREFIX = "x-hobo-env-";
/** JSON map of all bindle env keys for guests that prefer one parse. */
// public-contract: wire header carrying the whole bindle env as one JSON map.
export const HOBO_BINDLE_ENV_HEADER = "x-hobo-bindle-env";

/** Apply HoBo bindle env onto Headers for a mesh hop into a private component. */
export function applyHoboMeshEnvHeaders(
	headers: Headers,
	bindleEnv: Readonly<Record<string, string>>,
): Headers {
	const next = new Headers(headers);
	for (const [key, value] of Object.entries(bindleEnv)) {
		next.set(`${HOBO_ENV_HEADER_PREFIX}${key.toLowerCase()}`, value);
	}
	next.set(HOBO_BINDLE_ENV_HEADER, JSON.stringify(bindleEnv));
	return next;
}

export interface ComponentEndpoint {
	readonly resourceName: string;
	readonly kind: string;
	/** Discovery URL (public http://127.0.0.1:port or private http://<bindle>.hobo.internal/name). */
	readonly url: string;
	/** Public TCP port when external; null when private (no listener). */
	readonly port: number | null;
	readonly external: boolean;
	readonly serviceDiscoveryKey: string;
}

export interface NamedEndpointInfo {
	readonly resourceName: string;
	readonly hostname: string;
	readonly url: string;
	readonly backendUrl: string;
	readonly mode: "local" | "overlay";
	readonly external: boolean;
	readonly serviceDiscoveryKey: string;
}

export interface BareMetalServeResult {
	readonly projectDir: string;
	readonly bindleName: string;
	readonly yard: Yard;
	readonly campId: string;
	readonly endpoints: readonly ComponentEndpoint[];
	/** Only external endpoints (what the camp actually exposes on the wire). */
	readonly exposedEndpoints: readonly ComponentEndpoint[];
	readonly serviceDiscovery: Readonly<Record<string, string>>;
	/** Env keys injected from bindle `.with({ option: "env", config })` annotations. */
	readonly bindleEnv: Readonly<Record<string, string>>;
	readonly primaryUrl: string;
	/** Hierarchical DNS-valid named endpoints (HoBo-owned naming). */
	readonly namedEndpoints?: readonly NamedEndpointInfo[];
	/** Preferred hierarchical HTTPS URL for the primary external endpoint. */
	readonly primaryNamedUrl?: string | null;
	readonly probe: { readonly status: number; readonly body: string };
	readonly close: () => Promise<void>;
	/** Block until the host is stopped (SIGINT/SIGTERM or close()). */
	readonly waitUntilStopped: () => Promise<void>;
}

export function serviceDiscoveryKey(
	resourceName: string,
	endpointName = "http",
	index = 0,
): string {
	return `services__${resourceName}__${endpointName}__${index}`;
}

export function internalRouterBase(
	bindleName: string,
	resourceName: string,
): string {
	const resource = sanitizeDnsLabel(resourceName);
	return `http://${internalRouterHost(bindleName)}/${resource}`;
}

/**
 * Collect process env the camp must inject from bindle resource annotations.
 * Convention: `.with({ provider, option: "env", config: { KEY: "value" } })`.
 */
export function collectBindleEnvInjections(definition: BindleDefinition) {
	const env: Record<string, string> = {};
	for (const record of Object.values(definition.resources)) {
		for (const annotation of record.annotations) {
			if (annotation.option !== "env") continue;
			for (const [key, value] of Object.entries(annotation.config)) {
				if (
					isJsonString(value) ||
					isJsonNumber(value) ||
					isJsonBoolean(value)
				) {
					env[key] = String(value);
				}
			}
		}
	}
	return env;
}

/**
 * Install a process-wide fetch interceptor that routes
 * http://<bindle>.hobo.internal/<name>/... to private component handlers.
 * Restores the previous fetch on dispose.
 *
 * When `bindleEnv` is provided, HoBo injects those values onto the mesh hop as
 * `x-hobo-env-*` / `x-hobo-bindle-env` headers so isolated-wasm sandboxes receive
 * camp config through the Camp mesh (not baked into .wasm artifacts).
 */
export function installInternalRouter(
	privateHandlers: ReadonlyMap<string, FetchHandler>,
	options: {
		readonly bindleEnv?: Readonly<Record<string, string>>;
		readonly bindleName?: string;
	} = {},
): () => void {
	const previous = globalThis.fetch;
	const bindleEnv = options.bindleEnv ?? {};
	const expectedHost =
		options.bindleName !== undefined
			? internalRouterHost(options.bindleName)
			: undefined;
	const meshFetch: typeof fetch = async (input, init) => {
		const raw = isJsonString(input)
			? input
			: input instanceof URL
				? input.href
				: input.url;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			// SAFETY: assertion required at this I/O or test boundary.
			return previous(input as RequestInfo, init);
		}
		if (!isInternalRouterHostname(url.hostname)) {
			// SAFETY: assertion required at this I/O or test boundary.
			return previous(input as RequestInfo, init);
		}
		if (
			expectedHost !== undefined &&
			url.hostname !== expectedHost &&
			url.hostname !== INTERNAL_ROUTER_HOST
		) {
			// SAFETY: assertion required at this I/O or test boundary.
			return previous(input as RequestInfo, init);
		}
		const segments = url.pathname.split("/").filter(Boolean);
		const resourceName = segments[0];
		if (resourceName === undefined) {
			return new Response("hobo.internal: missing component name", {
				status: 404,
			});
		}
		const handler = privateHandlers.get(resourceName);
		if (handler === undefined) {
			return new Response(`hobo.internal: unknown component ${resourceName}`, {
				status: 404,
			});
		}
		const restPath = `/${segments.slice(1).join("/")}${url.search}`;
		const method =
			input instanceof Request ? input.method : (init?.method ?? "GET");
		const baseHeaders =
			input instanceof Request
				? new Headers(input.headers)
				: init?.headers !== undefined
					? new Headers(init.headers)
					: new Headers();
		// Camp mesh injects bindle `.with({ option: "env" })` values for private hops.
		const headers =
			Object.keys(bindleEnv).length > 0
				? applyHoboMeshEnvHeaders(baseHeaders, bindleEnv)
				: baseHeaders;
		let body: BodyInit | null | undefined;
		if (input instanceof Request && method !== "GET" && method !== "HEAD") {
			body = input.body;
		} else if (
			init?.body !== undefined &&
			method !== "GET" &&
			method !== "HEAD"
		) {
			body = init.body;
		}
		const requestInit: RequestInit = {
			method,
			headers,
			...(body !== undefined && body !== null ? { body } : undefined),
			// Request bodies from the original may be streams; duplex for node.
			...(body !== undefined && body !== null ? duplexHalfInit() : undefined),
		};
		return handler(
			new Request(`http://component.local${restPath}`, requestInit),
		);
	};
	globalThis.fetch = meshFetch;
	return () => {
		globalThis.fetch = previous;
	};
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
					const requestPath =
						req.url?.startsWith("http://") || req.url?.startsWith("https://")
							? `${new URL(req.url).pathname}${new URL(req.url).search}`
							: (req.url ?? "/");
					const url = new URL(requestPath, `http://${host}:${port}`);
					const body = Buffer.concat(chunks);
					const method = req.method ?? "GET";
					const init: RequestInit = {
						method,
						// SAFETY: assertion required at this I/O or test boundary.
						headers: req.headers as HeadersInit,
					};
					if (!["GET", "HEAD"].includes(method) && body.length > 0) {
						init.body = body;
					}
					const request = new Request(url, init);
					const response = await handler(request);
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

/**
 * Serve a project's bindle on the bare-metal Yard:
 * load bindle → compose Camp/Yard → private mesh for non-external components →
 * public listener only for external (web) surfaces.
 */
export async function serveProjectOnBareMetalYard(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<BareMetalServeResult> {
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

	emit(`hobo dev: opening bare-metal yard '${yardHandle.config.name}'`);
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
		throw new Error("bare-metal topology produced no camps");
	}
	emit(
		`hobo dev: camp ${campObject.id} routes bindle ${definition.name} on provider ${topology.providerId}`,
	);

	const entrypoints = listServableEntrypoints(definition);
	if (entrypoints.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no api/web entrypoints to serve`,
		);
	}

	const externalEntries = entrypoints.filter((entry) => entry.external);
	const privateEntries = entrypoints.filter((entry) => !entry.external);
	if (externalEntries.length === 0) {
		ownedYard?.close();
		throw new Error(
			`bindle ${definition.name} has no external endpoint to expose (need a web resource or endpoint.external=true)`,
		);
	}

	// Private mesh: in-process only — no TCP listener.
	const privateHandlers = new Map<string, FetchHandler>();
	for (const entry of privateEntries) {
		privateHandlers.set(entry.name, entry.handler);
	}
	const uninstallMesh = installInternalRouter(privateHandlers, {
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
			`hobo dev: private ${entry.kind}:${entry.name} on mesh ${url} (not exposed)`,
		);
	}

	// Public listeners: one port per external component (typically a single web).
	const servers: Server[] = [];
	let publicIndex = 0;
	for (const entry of externalEntries) {
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
		const server = await listen(entry.handler, port);
		servers.push(server);
		emit(`hobo dev: exposed ${entry.kind}:${entry.name} at ${url}`);
	}

	const bindleEnv = collectBindleEnvInjections(definition);
	for (const [key, value] of Object.entries(bindleEnv)) {
		process.env[key] = value;
	}
	emit(
		`hobo dev: injected discovery [${Object.keys(serviceDiscovery).join(", ")}] ` +
			`bindle-env [${Object.keys(bindleEnv).join(", ")}]`,
	);

	const exposedEndpoints = endpoints.filter((endpoint) => endpoint.external);
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
						server.closeAllConnections();
					}),
			),
		);
		uninstallMesh();
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
		probe,
		close,
		waitUntilStopped,
	};
}
