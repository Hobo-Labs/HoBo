import { createServer, type Server } from "node:http";
import {
	type BindleDefinition,
	evaluateBindingDeliveryGate,
} from "@hobo/bindles";
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
import { createLocalServeScope } from "./local-serve-scope.js";
import {
	type FetchHandler,
	isExternalComponent,
	type ListServableEntrypointsResult,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
	type ServableEntrypoint,
} from "./servable-entrypoints.js";

function duplexHalfInit(): RequestInit {
	return { duplex: "half" } as RequestInit;
}

export type { FetchHandler, ListServableEntrypointsResult, ServableEntrypoint };
export {
	isExternalComponent,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
};

export const INTERNAL_MESH_HOST = "hobo.internal";

export function internalMeshHost(bindleName: string): string {
	const label = sanitizeDnsLabel(bindleName);
	return label.length > 0
		? `${label}.${INTERNAL_MESH_HOST}`
		: INTERNAL_MESH_HOST;
}

export function isInternalMeshHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === INTERNAL_MESH_HOST || host.endsWith(`.${INTERNAL_MESH_HOST}`);
}

export const HOBO_ENV_HEADER_PREFIX = "x-hobo-env-";
export const HOBO_BINDLE_ENV_HEADER = "x-hobo-bindle-env";

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
	readonly url: string;
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
	readonly exposedEndpoints: readonly ComponentEndpoint[];
	readonly serviceDiscovery: Readonly<Record<string, string>>;
	readonly bindleEnv: Readonly<Record<string, string>>;
	readonly primaryUrl: string;
	readonly namedEndpoints?: readonly NamedEndpointInfo[];
	readonly primaryNamedUrl?: string | null;
	readonly probe: { readonly status: number; readonly body: string };
	readonly close: () => Promise<void>;
	readonly waitUntilStopped: () => Promise<void>;
}

export function serviceDiscoveryKey(
	resourceName: string,
	endpointName = "http",
	index = 0,
): string {
	return `services__${resourceName}__${endpointName}__${index}`;
}

export function internalMeshBase(
	bindleName: string,
	resourceName: string,
): string {
	const resource = sanitizeDnsLabel(resourceName);
	return `http://${internalMeshHost(bindleName)}/${resource}`;
}

export function collectBindleEnvInjections(definition: BindleDefinition) {
	const source = evaluateBindingDeliveryGate({ definition });
	if (!source.ok) {
		throw new Error(
			`${source.summary}: ${source.reasons.map((reason) => reason.message).join("; ")}`,
		);
	}
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
					Object.defineProperty(env, key, {
						value: String(value),
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
			}
		}
	}
	const delivery = evaluateBindingDeliveryGate({ env });
	if (!delivery.ok) {
		throw new Error(
			`${delivery.summary}: ${delivery.reasons.map((reason) => reason.message).join("; ")}`,
		);
	}
	return env;
}

export function installInternalMesh(
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
			? internalMeshHost(options.bindleName)
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
			return previous(input as RequestInfo, init);
		}
		if (!isInternalMeshHostname(url.hostname)) {
			return previous(input as RequestInfo, init);
		}
		if (
			expectedHost !== undefined &&
			url.hostname !== expectedHost &&
			url.hostname !== INTERNAL_MESH_HOST
		) {
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
					const address = server.address();
					const boundPort =
						address === null || isJsonString(address) ? port : address.port;
					const url = new URL(requestPath, `http://${host}:${boundPort}`);
					const body = Buffer.concat(chunks);
					const method = req.method ?? "GET";
					const init: RequestInit = {
						method,
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

export async function serveProjectOnBareMetalYard(options: {
	readonly projectDir: string;
	readonly yard?: BareMetalYard;
	readonly port?: number;
	readonly hoboHome?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<BareMetalServeResult> {
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
	const scope = createLocalServeScope();
	if (ownedYard !== null) scope.defer(() => ownedYard.close());
	try {
		const yardHandle = options.yard ?? must(ownedYard);
		const basePort =
			options.port ?? yardHandle.config.defaultPort ?? DEFAULT_DEV_PORT;

		emit(`hobo dev: opening bare-metal yard '${yardHandle.config.name}'`);

		const topology = composeBareMetalTopology(definition, {
			yardName: yardHandle.config.name,
			campEnv: "dev",
			dataDir: yardHandle.config.dataDir,
		});
		const campObject = topology.camps[0];
		if (campObject === undefined) {
			throw new Error("bare-metal topology produced no camps");
		}
		emit(
			`hobo dev: camp ${campObject.id} routes bindle ${definition.name} on provider ${topology.providerId}`,
		);

		const entrypoints = listServableEntrypoints(definition);
		if (entrypoints.length === 0) {
			throw new Error(
				`bindle ${definition.name} has no api/web entrypoints to serve`,
			);
		}

		const externalEntries = entrypoints.filter((entry) => entry.external);
		const privateEntries = entrypoints.filter((entry) => !entry.external);
		if (externalEntries.length === 0) {
			throw new Error(
				`bindle ${definition.name} has no external endpoint to expose (need a web resource or endpoint.external=true)`,
			);
		}

		const privateHandlers = new Map<string, FetchHandler>();
		for (const entry of privateEntries) {
			privateHandlers.set(entry.name, entry.handler);
		}
		const uninstallMesh = installInternalMesh(privateHandlers, {
			bindleName: definition.name,
		});
		scope.defer(uninstallMesh);

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
			scope.setEnv(key, url);
			emit(
				`hobo dev: private ${entry.kind}:${entry.name} on mesh ${url} (not exposed)`,
			);
		}

		let publicIndex = 0;
		for (const entry of externalEntries) {
			const requestedPort = basePort === 0 ? 0 : basePort + publicIndex;
			publicIndex += 1;
			const server = await listen(entry.handler, requestedPort);
			scope.defer(
				() =>
					new Promise<void>((resolve, reject) => {
						server.close((error) => (error ? reject(error) : resolve()));
						server.closeAllConnections();
					}),
			);
			const address = server.address();
			if (address === null || isJsonString(address)) {
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
			scope.setEnv(key, url);
			emit(`hobo dev: exposed ${entry.kind}:${entry.name} at ${url}`);
		}

		for (const [key, value] of Object.entries(bindleEnv)) {
			scope.setEnv(key, value);
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
			try {
				await scope.close();
			} finally {
				stopped?.();
			}
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
	} catch (error) {
		try {
			await scope.close();
		} catch {}
		throw error;
	}
}
