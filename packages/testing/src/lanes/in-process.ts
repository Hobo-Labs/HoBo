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
 * deployed host — hence `simulated`, never `real`. Queue and topic resources
 * expose local port implementations. Data, kv, bucket, secret, auth and the
 * rest get only a handle and a binding locator: they are labelled `mocked`.
 * `container` and `wasm-component` are labelled `camp-only`. Built-in
 * emulators contact no provider, broker no credentials and write no `.hobo/`
 * state. Caller-supplied factories run their own code.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { BindingResolverPort, Messaging } from "@hobo/core";
import { createLocalBindingResolver } from "@hobo/runtime-local";
import {
	createQueueEmulator,
	createTopicEmulator,
	type QueueEmulator,
	type ServiceEmulator,
	type ServiceEmulatorFactories,
} from "./../emulators.js";
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
	readonly queues: ReadonlyMap<string, QueueEmulator>;
	readonly topics: ReadonlyMap<string, ServiceEmulator<Messaging>>;
}

type FetchLikeHandler = (request: Request) => Response | Promise<Response>;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the collected Bindle entrypoint is an untyped application boundary; each callable is checked before it is invoked. */
function resolveFetchHandler(
	bindle: unknown,
	alias: string,
): FetchLikeHandler | undefined {
	if (typeof bindle !== "object" || bindle === null) return undefined;
	const entrypoint = (bindle as Record<string, unknown>).entrypoint;
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
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion */

async function readRequestBody(
	request: IncomingMessage,
): Promise<Blob | undefined> {
	const method = (request.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		// SAFETY: Node's IncomingMessage stream yields Buffer or string chunks.
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	if (chunks.length === 0) return undefined;
	return new Blob([Buffer.concat(chunks)]);
}

function toWebRequest(
	incoming: IncomingMessage,
	origin: string,
	body: Blob | undefined,
): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(incoming.headers)) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Node headers are strings or string arrays at this HTTP boundary.
		if (typeof value === "string") headers.set(key, value);
		else if (Array.isArray(value))
			for (const item of value) headers.append(key, item);
	}
	const url = new URL(incoming.url ?? "/", origin);
	const method = (incoming.method ?? "GET").toUpperCase();
	return new Request(url, {
		method,
		headers,
		...(body !== undefined ? { body } : undefined),
	});
}

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
				// SAFETY: this listener is opened on a TCP host and port below.
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
	// SAFETY: this listener was opened on a TCP host and port.
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

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this is the parse boundary for untyped JavaScript factory results; it checks the port, clock, close and fidelity before exposure. */
function validateFactories(value: unknown): void {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		("queue" in value &&
			value.queue !== undefined &&
			typeof value.queue !== "function") ||
		("topic" in value &&
			value.topic !== undefined &&
			typeof value.topic !== "function")
	) {
		throw new TestHarnessError(
			"HARNESS_EMULATOR_INVALID",
			"the emulator overrides are not service factories",
			"provide queue and topic factories as functions, or omit the overrides",
		);
	}
}

function validateEmulator(
	value: unknown,
	alias: string,
	kind: "queue" | "topic",
): void {
	const record =
		typeof value === "object" && value !== null ? value : undefined;
	const service = record as Record<string, unknown> | undefined;
	const port = service?.port;
	const portRecord =
		typeof port === "object" && port !== null
			? (port as Record<string, unknown>)
			: undefined;
	const methods =
		kind === "queue"
			? [
					"enqueue",
					"dequeue",
					"handle",
					"complete",
					"release",
					"simulateRedelivery",
					"signal",
				]
			: [
					"ensureTopic",
					"ensureSubscription",
					"publish",
					"consume",
					"subscribe",
					"ack",
					"nack",
					"events",
				];
	const clock = service?.clock;
	const clockRecord =
		typeof clock === "object" && clock !== null
			? (clock as Record<string, unknown>)
			: undefined;
	if (
		(service?.fidelity !== "simulated" && service?.fidelity !== "mocked") ||
		(service.close !== undefined && typeof service.close !== "function") ||
		portRecord === undefined ||
		methods.some((method) => typeof portRecord[method] !== "function") ||
		(kind === "topic" &&
			(typeof portRecord.backend !== "string" ||
				typeof portRecord.capabilities !== "object" ||
				portRecord.capabilities === null)) ||
		(kind === "queue" &&
			clock !== undefined &&
			(clockRecord === undefined ||
				["now", "nowMs", "sleep", "cron", "advance", "trace"].some(
					(method) => typeof clockRecord[method] !== "function",
				)))
	) {
		throw new TestHarnessError(
			"HARNESS_EMULATOR_INVALID",
			`the ${kind} emulator for "${alias}" does not implement its port or declare its fidelity`,
			`return a ${kind} emulator with the complete @hobo/core port and fidelity "simulated" or "mocked"`,
		);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */

/**
 * Boot the collected graph in dependency order. Every handle carries its
 * ADR-0042 fidelity label; nothing is labelled `real`.
 */
/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: parseTestTopology checks the collected Bindle before deployment. */
export async function deployInProcess(
	bindle: unknown,
	stage: string,
	factories: ServiceEmulatorFactories = {},
): Promise<InProcessDeployment> {
	validateFactories(factories);
	const topology = parseTestTopology(bindle);
	const order = deploymentOrder(topology);
	const byAlias = new Map(topology.nodes.map((node) => [node.alias, node]));
	const handles = new Map<string, ResourceHandle>();
	const servers = new Map<string, Server>();
	const queues = new Map<string, QueueEmulator>();
	const topics = new Map<string, ServiceEmulator<Messaging>>();
	const bindings: Record<string, Record<string, string>> = {};

	try {
		for (const alias of order) {
			const node = byAlias.get(alias);
			if (node === undefined) continue;
			const context = Object.freeze({ alias, stage });
			if (node.kind === "queue") {
				const emulator = await (factories.queue ?? createQueueEmulator)(
					context,
				);
				queues.set(alias, emulator);
				validateEmulator(emulator, alias, "queue");
			} else if (node.kind === "topic") {
				const emulator = await (
					factories.topic ?? (() => createTopicEmulator())
				)(context);
				topics.set(alias, emulator);
				validateEmulator(emulator, alias, "topic");
			}
			const handler =
				isHttpServedKind(node.kind) && node.hasEntrypoint
					? resolveFetchHandler(bindle, alias)
					: undefined;

			let endpoint: string | undefined;
			if (handler !== undefined) {
				const opened = await listen(handler);
				servers.set(alias, opened.server);
				endpoint = opened.endpoint;
			}

			const fidelity =
				queues.get(alias)?.fidelity ??
				topics.get(alias)?.fidelity ??
				inProcessFidelity(node.kind, endpoint !== undefined);
			handles.set(
				alias,
				Object.freeze({
					alias,
					kind: node.kind,
					fidelity,
					...(endpoint !== undefined ? { endpoint } : undefined),
				}),
			);
			bindings[alias] = Object.freeze({
				locator: `hobo-test://${stage}/${node.kind}/${alias}`,
				fidelity,
				...(endpoint !== undefined ? { endpoint } : undefined),
			});
		}
	} catch (cause) {
		const cleanupErrors = await closeResources(
			order.slice().reverse(),
			servers,
			queues,
			topics,
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[cause, ...cleanupErrors],
				"deployment failed and cleanup also failed",
			);
		}
		throw cause;
	}

	return Object.freeze({
		stage,
		topology,
		handles,
		bindings: Object.freeze(bindings),
		resolver: createLocalBindingResolver(bindings),
		servers,
		queues,
		topics,
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * Tear down in reverse dependency order and report the order walked, so a
 * suite can assert the ordering rather than take it on trust.
 */
export async function destroyInProcess(
	deployment: InProcessDeployment,
): Promise<readonly string[]> {
	const existing = teardownRuns.get(deployment);
	if (existing !== undefined) return existing;
	const pending = (async () => {
		const order = teardownOrder(deployment.topology);
		const errors = await closeResources(
			order,
			deployment.servers,
			deployment.queues,
			deployment.topics,
		);
		if (errors.length > 0)
			throw new AggregateError(errors, "emulator teardown failed");
		return order;
	})();
	teardownRuns.set(deployment, pending);
	return pending;
}

const teardownRuns = new WeakMap<
	InProcessDeployment,
	Promise<readonly string[]>
>();

async function closeResources(
	order: readonly string[],
	servers: ReadonlyMap<string, Server>,
	queues: ReadonlyMap<string, QueueEmulator>,
	topics: ReadonlyMap<string, ServiceEmulator<Messaging>>,
): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (const alias of order) {
		const server = servers.get(alias);
		const emulator = queues.get(alias) ?? topics.get(alias);
		try {
			if (server?.listening) {
				await new Promise<void>((resolve, reject) => {
					server.closeAllConnections?.();
					server.close((error) => (error ? reject(error) : resolve()));
				});
			}
		} catch (error) {
			errors.push(error);
		}
		try {
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: cleanup also handles an invalid JavaScript factory result.
			if (typeof emulator?.close === "function") await emulator.close();
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}
