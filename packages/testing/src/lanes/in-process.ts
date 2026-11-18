/**
 * The in-process whole-graph lane (ADR-0159 §2a) — and its honest boundary.
 *
 * WHAT THIS EXECUTES. The collected topology is ordered dependencies-first.
 * For every HTTP-shaped alias whose collected entrypoint factory resolves to a
 * fetch handler, a real `node:http` listener is opened on an ephemeral
 * loopback port and requests are adapted to/from the platform `Request`/
 * `Response` types. Real application code runs; real HTTP crosses the wire.
 * Binding values for the whole graph are served through `runtime-local`'s
 * `createLocalBindingResolver`, so the lane resolves bindings the same way the
 * local runtime does.
 *
 * WHAT THIS DOES NOT EXECUTE. `runtime-local` does not execute real `.wasm`
 * component bytes today, so nothing here is the deployed artifact on the
 * deployed host — hence `simulated`, never `real`. Data, kv, bucket, queue,
 * topic, secret, auth and the rest get a handle and a binding locator and
 * nothing behind them: they are labelled `mocked`. `container` and
 * `wasm-component` are labelled `camp-only`. No provider is contacted, no
 * credential is brokered, no `.hobo/` state is written.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { BindingResolverPort } from "@hobo/core";
import { createLocalBindingResolver } from "@hobo/runtime-local";
import { TestHarnessError } from "./../errors.js";
import { inProcessFidelity, isHttpServedKind } from "./../fidelity.js";
import {
	deploymentOrder,
	parseTestTopology,
	type TestTopology,
	teardownOrder,
} from "./../graph.js";
import type { ResourceHandle } from "./../types.js";

export interface InProcessDeployment {
	readonly stage: string;
	readonly topology: TestTopology;
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly bindings: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly resolver: BindingResolverPort;
	readonly servers: ReadonlyMap<string, Server>;
}

type FetchLikeHandler = (request: Request) => Response | Promise<Response>;

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns -- SAFETY: this boundary probes the dynamically supplied Bindle entrypoint and checks each returned callable before invoking it. */
function resolveFetchHandler(
	bindle: Record<string, unknown>,
	alias: string,
): FetchLikeHandler | undefined {
	const entrypoint = bindle.entrypoint;
	if (typeof entrypoint !== "function") return undefined;
	let factory: unknown;
	try {
		factory = (entrypoint as (name: string) => unknown).call(bindle, alias);
	} catch {
		return undefined;
	}
	if (typeof factory !== "function") return undefined;
	let handler: unknown;
	try {
		handler = (factory as () => unknown)();
	} catch {
		return undefined;
	}
	return typeof handler === "function"
		? (handler as FetchLikeHandler)
		: undefined;
}
/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns */

async function readRequestBody(
	request: IncomingMessage,
): Promise<Blob | undefined> {
	const method = (request.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		// SAFETY: node:http emits Buffer or encoded string request chunks.
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	if (chunks.length === 0) return undefined;
	return new Blob([Buffer.concat(chunks)]);
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- SAFETY: node:http supplies string or string-array header values; an absent body must stay omitted. */
function toWebRequest(
	incoming: IncomingMessage,
	origin: string,
	body: Blob | undefined,
): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(key, value);
		else if (Array.isArray(value))
			for (const item of value) headers.append(key, item);
	}
	const url = new URL(incoming.url ?? "/", origin);
	const method = (incoming.method ?? "GET").toUpperCase();
	return new Request(url, {
		method,
		headers,
		...(body !== undefined ? { body } : {}),
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread */

async function writeWebResponse(
	response: Response,
	outgoing: ServerResponse,
): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const buffer = Buffer.from(await response.arrayBuffer());
	outgoing.writeHead(response.status, headers);
	outgoing.end(buffer);
}

async function listen(handler: FetchLikeHandler): Promise<{
	readonly server: Server;
	readonly endpoint: string;
}> {
	const server = createServer((incoming, outgoing) => {
		void (async () => {
			try {
				// SAFETY: this server listens on a TCP loopback port, not a Unix socket.
				const address = server.address() as AddressInfo | null;
				const origin = `http://127.0.0.1:${address?.port ?? 0}`;
				const body = await readRequestBody(incoming);
				const response = await handler(toWebRequest(incoming, origin, body));
				await writeWebResponse(response, outgoing);
			} catch (cause) {
				const detail = cause instanceof Error ? cause.message : String(cause);
				outgoing.writeHead(500, { "content-type": "application/json" });
				outgoing.end(JSON.stringify({ code: "HARNESS_HANDLER_THREW", detail }));
			}
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	// SAFETY: this server listens on a TCP loopback port, not a Unix socket.
	const address = server.address() as AddressInfo | null;
	if (address === null) {
		server.close();
		throw new TestHarnessError(
			"HARNESS_ENDPOINT_UNAVAILABLE",
			"the loopback listener reported no address after binding",
			"re-run the suite; if it persists, the sandbox is blocking loopback listeners and only the ephemeral-camp lane can serve HTTP",
		);
	}
	return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

async function closeServers(servers: readonly Server[]): Promise<void> {
	const failures: unknown[] = [];
	for (const server of servers) {
		if (!server.listening) continue;
		try {
			await new Promise<void>((resolve, reject) => {
				let closeConnectionsFailure: { cause: unknown } | undefined;
				server.close((error) => {
					if (error) reject(error);
					else if (closeConnectionsFailure)
						reject(closeConnectionsFailure.cause);
					else resolve();
				});
				try {
					server.closeAllConnections?.();
				} catch (cause) {
					closeConnectionsFailure = { cause };
				}
			});
		} catch (cause) {
			failures.push(cause);
		}
	}
	if (failures.length > 0)
		throw new AggregateError(failures, "in-process listener cleanup failed");
}

export class InProcessStartupCleanupError extends Error {
	readonly cleanupCause: unknown;
	readonly #servers: readonly Server[];

	/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: JavaScript permits throwing any value; both causes are retained as diagnostic evidence. */
	constructor(
		startupCause: unknown,
		cleanupCause: unknown,
		servers: readonly Server[],
	) {
		super("in-process startup failed and listener cleanup is incomplete", {
			cause: startupCause,
		});
		this.name = "InProcessStartupCleanupError";
		this.cleanupCause = cleanupCause;
		this.#servers = servers;
		Object.freeze(this);
	}
	/* oxlint-enable anti-slop/no-unknown-parameters */

	async retryCleanup(): Promise<void> {
		await closeServers(this.#servers);
	}
}

/**
 * Boot the collected graph in dependency order. Every handle carries its
 * ADR-0042 fidelity label; nothing is labelled `real`.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- SAFETY: parseTestTopology validates the Bindle object before the existing entrypoint probe; optional endpoints are deliberately omitted when unavailable. */
export async function deployInProcess(
	bindle: unknown,
	stage: string,
): Promise<InProcessDeployment> {
	const topology = parseTestTopology(bindle);
	const order = deploymentOrder(topology);
	const byAlias = new Map(topology.nodes.map((node) => [node.alias, node]));
	const handles = new Map<string, ResourceHandle>();
	const servers = new Map<string, Server>();
	const bindings: Record<string, Record<string, string>> = {};

	try {
		for (const alias of order) {
			const node = byAlias.get(alias);
			if (node === undefined) continue;
			const handler =
				isHttpServedKind(node.kind) && node.hasEntrypoint
					? resolveFetchHandler(bindle as Record<string, unknown>, alias)
					: undefined;

			let endpoint: string | undefined;
			if (handler !== undefined) {
				const opened = await listen(handler);
				servers.set(alias, opened.server);
				endpoint = opened.endpoint;
			}

			const fidelity = inProcessFidelity(node.kind, endpoint !== undefined);
			handles.set(
				alias,
				Object.freeze({
					alias,
					kind: node.kind,
					fidelity,
					...(endpoint !== undefined ? { endpoint } : {}),
				}),
			);
			bindings[alias] = Object.freeze({
				locator: `hobo-test://${stage}/${node.kind}/${alias}`,
				fidelity,
				...(endpoint !== undefined ? { endpoint } : {}),
			});
		}

		return Object.freeze({
			stage,
			topology,
			handles,
			bindings: Object.freeze(bindings),
			resolver: createLocalBindingResolver(bindings),
			servers,
		});
	} catch (cause) {
		const opened = [...servers.values()].reverse();
		try {
			await closeServers(opened);
		} catch (cleanupCause) {
			throw new InProcessStartupCleanupError(cause, cleanupCause, opened);
		}
		throw cause;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread */

/**
 * Tear down in reverse dependency order and report the order walked, so a
 * suite can assert the ordering rather than take it on trust.
 */
export async function destroyInProcess(
	deployment: InProcessDeployment,
): Promise<readonly string[]> {
	const order = teardownOrder(deployment.topology);
	await closeServers(
		order.flatMap((alias) => {
			const server = deployment.servers.get(alias);
			return server === undefined ? [] : [server];
		}),
	);
	return order;
}
