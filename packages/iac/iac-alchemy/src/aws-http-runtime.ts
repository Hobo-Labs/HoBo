/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: host values and application handlers cross a checked runtime boundary. */
import { types } from "node:util";
import {
	type DurableQueue,
	type DurableQueueLimits,
	inspectAtomicDurableQueue,
} from "@hobo/runtime/atomic-durable-queue";
import {
	type BoundaryPending,
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import { captureAwsHttpGraph } from "./aws-http-graph.js";
import {
	AwsKvError,
	type AwsKvGrant,
	type AwsKvStore,
	inspectAwsDynamoKvStore,
} from "./aws-kv.js";
import { inspectAwsQueueAtomicStore } from "./aws-queue-atomic-store.js";
import {
	AwsS3Error,
	type AwsS3Grant,
	type AwsS3Store,
	inspectAwsS3Store,
} from "./aws-s3.js";
import { scopeAwsQueue } from "./aws-scoped-queue.js";
import {
	AwsSecretError,
	type AwsSecretGrant,
	type AwsSecretStore,
	inspectAwsSecretStore,
} from "./aws-secret.js";
import type { BindleForAlchemy } from "./bindle.js";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export const AWS_HTTP_MAX_IN_FLIGHT = 32;
export const AWS_HTTP_MAX_RESPONSE_BYTES = 1_048_576;
export const AWS_HTTP_MAX_RESPONSE_HEADERS = 128;
export const AWS_HTTP_MAX_RESPONSE_HEADER_BYTES = 16_384;
export const AWS_HTTP_DEADLINE_MS = 10_000;
const maxChunks = 1024;
const NativeResponse = Response;
const NativeRequest = Request;
const NativeHeaders = Headers;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const byteOffset = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteOffset",
)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;
const contextBindings = new WeakMap<object, AwsHttpBindings>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const apply = Reflect.apply;
const define = Object.defineProperty;
const freeze = Object.freeze;
const schedule = setTimeout;
const cancelTimer = clearTimeout;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const NativeSet = Set;
const arrayPush = Array.prototype.push;
const arrayIncludes = Array.prototype.includes;
const responseStatus = Object.getOwnPropertyDescriptor(
	Response.prototype,
	"status",
)?.get;
const responseBody = Object.getOwnPropertyDescriptor(
	Response.prototype,
	"body",
)?.get;
const responseHeaders = Object.getOwnPropertyDescriptor(
	Response.prototype,
	"headers",
)?.get;
const requestMethod = Object.getOwnPropertyDescriptor(
	Request.prototype,
	"method",
)?.get;
const headersGet = Headers.prototype.get;
const headersForEach = Headers.prototype.forEach;
const headersAppend = Headers.prototype.append;
const headersGetSetCookie = Headers.prototype.getSetCookie;
const responseStatusText = Object.getOwnPropertyDescriptor(
	Response.prototype,
	"statusText",
)?.get;
const getReader = ReadableStream.prototype.getReader;
const cancelStream = ReadableStream.prototype.cancel;
const read = ReadableStreamDefaultReader.prototype.read;
const cancel = ReadableStreamDefaultReader.prototype.cancel;
const release = ReadableStreamDefaultReader.prototype.releaseLock;
const bytesSet = Uint8Array.prototype.set;
const nonThenable: PropertyDescriptor = Object.create(null);
nonThenable.value = undefined;
nonThenable.writable = false;
nonThenable.enumerable = false;
nonThenable.configurable = false;
freeze(nonThenable);

type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { readonly [key: string]: Json };
type FetchHandler = (request: Request) => Response | Promise<Response>;
type EntrypointResult =
	| Json
	| { readonly [key: string]: Json | undefined }
	| FetchHandler
	| { readonly fetch: FetchHandler };
export interface AwsContextRef {
	connector(...args: never[]): object;
}
export interface AwsConnectorBinding {
	readonly kind: "connector";
}
export interface AwsBindleContext extends AwsContextRef {
	connector(binding: AwsConnectorBinding): never;
}
export interface AwsHttpBindings {
	kv(name: string): AwsKvStore;
	bucket(name: string): AwsS3Store;
	secret(name: string): AwsSecretStore;
	queue(name: string): DurableQueue;
}
export type AwsHttpEntrypoint = (
	context?: AwsBindleContext,
) => EntrypointResult;
export type AwsHttpBindingClaim = Readonly<
	{ bindleName: string; applicationName: string; resourceName: string } & (
		| { kind: "kv"; grant: AwsKvGrant }
		| { kind: "bucket"; grant: AwsS3Grant }
		| { kind: "secret"; grant: AwsSecretGrant }
		| {
				kind: "queue";
				grant: AwsKvGrant;
				limits: DurableQueueLimits;
				allow: readonly string[];
		  }
	)
>;
export interface AwsBindleApplication {
	fetch(request: Request): Promise<Response>;
}

export function awsHttpBindings(context?: AwsContextRef): AwsHttpBindings {
	if (context === undefined || types.isProxy(context))
		throw new Error("AWS Bindle context is unavailable");
	const result: AwsHttpBindings | undefined = apply(weakGet, contextBindings, [
		context,
	]);
	if (!result) throw new Error("AWS Bindle context is unavailable");
	return result;
}
function protect(response: Response): Response {
	define(response, "then", nonThenable);
	return response;
}
const fallbackUnavailable = freeze(
	protect(new NativeResponse(null, { status: 503 })),
);
function unavailable(): Response {
	try {
		const response = new NativeResponse(null, { status: 503 });
		if (!responseStatus || apply(responseStatus, response, []) !== 503)
			return fallbackUnavailable;
		return protect(response);
	} catch {
		return fallbackUnavailable;
	}
}
function validResponse(value: unknown): value is Response {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		!responseStatus ||
		!responseBody ||
		!responseHeaders ||
		!responseStatusText
	)
		return false;
	try {
		apply(responseStatus, value, []);
		apply(responseBody, value, []);
		apply(responseHeaders, value, []);
		apply(responseStatusText, value, []);
		return true;
	} catch {
		return false;
	}
}
async function bufferResponse(
	response: Response,
	request: Request,
): Promise<Response> {
	if (
		!responseStatus ||
		!responseBody ||
		!responseHeaders ||
		!responseStatusText ||
		!requestMethod
	)
		throw new Error("invalid response");
	const status: number = apply(responseStatus, response, []);
	const statusText: string = apply(responseStatusText, response, []);
	const originalHeaders: Headers = apply(responseHeaders, response, []);
	const headers = new NativeHeaders();
	let headerCount = 0;
	let headerBytes = 0;
	const encoder = new TextEncoder();
	const appendHeader = (name: string, value: string) => {
		headerCount++;
		if (name.length + value.length > AWS_HTTP_MAX_RESPONSE_HEADER_BYTES)
			throw new Error("response headers too large");
		headerBytes += encoder.encode(name).length + encoder.encode(value).length;
		if (
			headerCount > AWS_HTTP_MAX_RESPONSE_HEADERS ||
			headerBytes > AWS_HTTP_MAX_RESPONSE_HEADER_BYTES
		)
			throw new Error("response headers too large");
		apply(headersAppend, headers, [name, value]);
	};
	apply(headersForEach, originalHeaders, [
		(value: string, name: string) => {
			if (name !== "set-cookie") appendHeader(name, value);
		},
	]);
	const cookies: string[] = apply(headersGetSetCookie, originalHeaders, []);
	for (let index = 0; index < cookies.length; index++) {
		const cookie = cookies[index];
		if (cookie === undefined) throw new Error("invalid cookie header");
		appendHeader("set-cookie", cookie);
	}

	if (statusText.length > 256)
		throw new Error("response status text too large");
	const body: ReadableStream<Uint8Array> | null = apply(
		responseBody,
		response,
		[],
	);
	const declaredLength: string | null = apply(headersGet, headers, [
		"content-length",
	]);
	if (declaredLength !== null && !/^(0|[1-9][0-9]*)$/u.test(declaredLength))
		throw new Error("invalid content length");
	const method: string = apply(requestMethod, request, []);
	if (body === null) {
		if (
			declaredLength !== null &&
			declaredLength !== "0" &&
			method !== "HEAD" &&
			status !== 304
		)
			throw new Error("invalid content length");
		return protect(new NativeResponse(null, { status, statusText, headers }));
	}
	// SAFETY: getReader is invoked on a native response body without BYOB options.
	const reader = apply(
		getReader,
		body,
		[],
	) as ReadableStreamDefaultReader<Uint8Array>;
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	try {
		for (let count = 0; count <= maxChunks; count++) {
			const part: ReadableStreamReadResult<Uint8Array> = await apply(
				read,
				reader,
				[],
			);
			if (part.done) {
				complete = true;
				break;
			}
			if (count === maxChunks) throw new Error("response has too many chunks");
			if (
				!(part.value instanceof Uint8Array) ||
				types.isProxy(part.value) ||
				!byteLength ||
				!byteOffset ||
				!byteBuffer
			)
				throw new Error("invalid response bytes");
			const length: number = apply(byteLength, part.value, []);
			const offset: number = apply(byteOffset, part.value, []);
			const buffer: unknown = apply(byteBuffer, part.value, []);
			if (
				length > AWS_HTTP_MAX_RESPONSE_BYTES - total ||
				!(buffer instanceof ArrayBuffer)
			)
				throw new Error("response too large");
			total += length;
			chunks[chunks.length] = new Uint8Array(
				new Uint8Array(buffer, offset, length),
			);
		}
		if (!complete) throw new Error("response has too many chunks");
	} finally {
		if (!complete) {
			try {
				await apply(cancel, reader, []);
			} catch {}
		}
		try {
			apply(release, reader, []);
		} catch {}
	}
	if (declaredLength !== null && declaredLength !== String(total))
		throw new Error("invalid content length");
	const bytes = new Uint8Array(total);
	let written = 0;
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (chunk === undefined || !byteLength)
			throw new Error("invalid response bytes");
		const chunkLength: number = apply(byteLength, chunk, []);
		if (chunkLength > total - written)
			throw new Error("invalid response bytes");
		apply(bytesSet, bytes, [chunk, written]);
		written += chunkLength;
	}
	if (written !== total) throw new Error("invalid response bytes");
	return protect(new NativeResponse(bytes, { status, statusText, headers }));
}
async function bufferResponseSafely(
	response: Response,
	request: Request,
): Promise<Response> {
	try {
		return await bufferResponse(response, request);
	} catch {
		try {
			const body: ReadableStream<Uint8Array> | null = responseBody
				? apply(responseBody, response, [])
				: null;
			if (body) await apply(cancelStream, body, []);
		} catch {}
		throw new Error("response could not be buffered");
	}
}
function responseFrom(value: unknown): BoundaryPending<Response> {
	const result = createBoundaryDeferred<Response>();
	if (validResponse(value)) result.resolve(value);
	else if (
		!observeOrdinaryPromise(
			value,
			(response) =>
				validResponse(response)
					? result.resolve(response)
					: result.reject(new Error("invalid response")),
			() => result.reject(new Error("handler failed")),
		)
	)
		result.reject(new Error("invalid handler result"));
	return result.promise;
}

function samePermissions(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length || left.length > 256) return false;
	for (let index = 0; index < left.length; index++) {
		const value = left[index];
		if (typeof value !== "string" || !apply(arrayIncludes, right, [value]))
			return false;
		for (let prior = 0; prior < index; prior++)
			if (left[prior] === value) return false;
	}
	return true;
}

export function createAwsBindleApplication<Requirements>(options: {
	readonly bindle: BindleForAlchemy<AwsHttpEntrypoint, Requirements>;
	readonly applicationName: string;
	readonly stores: Readonly<
		Record<string, AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue>
	>;
	readonly verifyBinding: (claim: AwsHttpBindingClaim) => boolean;
}): AwsBindleApplication {
	if (
		!options ||
		types.isProxy(options) ||
		Reflect.ownKeys(options).length !== 4 ||
		["bindle", "applicationName", "stores", "verifyBinding"].some((key) => {
			const field = Object.getOwnPropertyDescriptor(options, key);
			return !field || !Object.hasOwn(field, "value") || !field.enumerable;
		}) ||
		!options.bindle ||
		types.isProxy(options.bindle) ||
		!options.stores ||
		typeof options.stores !== "object" ||
		types.isProxy(options.stores) ||
		Array.isArray(options.stores) ||
		typeof options.verifyBinding !== "function" ||
		types.isProxy(options.verifyBinding)
	)
		throw new Error("invalid AWS application options");
	const { bindle, applicationName, verifyBinding } = options;
	const graph = captureAwsHttpGraph(bindle, applicationName);
	const { entrypoint } = graph;
	if (
		Object.getOwnPropertySymbols(options.stores).length !== 0 ||
		Reflect.ownKeys(options.stores).length !== graph.bindings.length
	)
		throw new Error("AWS application dependencies are incomplete");
	const physicalIdentities = new NativeSet<string>();
	const entries: {
		name: string;
		claim: AwsHttpBindingClaim;
		store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
	}[] = [];
	for (let index = 0; index < graph.bindings.length; index++) {
		const binding = graph.bindings[index];
		if (!binding) throw new Error("AWS application dependency is invalid");
		const { name } = binding;
		const field = Object.getOwnPropertyDescriptor(options.stores, name);
		if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
			throw new Error("AWS application dependency is invalid");
		const kv = inspectAwsDynamoKvStore(field.value);
		const bucket = inspectAwsS3Store(field.value);
		const secret = inspectAwsSecretStore(field.value);
		const queue = inspectAtomicDurableQueue(field.value);
		const queueGrant =
			queue === undefined ? undefined : inspectAwsQueueAtomicStore(queue.store);
		const claim =
			kv && binding.kind === "kv" && samePermissions(binding.allow, kv.allow)
				? Object.freeze({
						bindleName: graph.bindleName,
						applicationName,
						resourceName: name,
						kind: "kv" as const,
						grant: kv,
					})
				: bucket &&
						binding.kind === "bucket" &&
						samePermissions(binding.allow, bucket.allow)
					? Object.freeze({
							bindleName: graph.bindleName,
							applicationName,
							resourceName: name,
							kind: "bucket" as const,
							grant: bucket,
						})
					: secret &&
							binding.kind === "secret" &&
							samePermissions(binding.allow, secret.allow)
						? Object.freeze({
								bindleName: graph.bindleName,
								applicationName,
								resourceName: name,
								kind: "secret" as const,
								grant: secret,
							})
						: queue &&
								queueGrant &&
								binding.kind === "queue" &&
								apply(arrayIncludes, queueGrant.allow, ["get"]) &&
								apply(arrayIncludes, queueGrant.allow, ["set"])
							? Object.freeze({
									bindleName: graph.bindleName,
									applicationName,
									resourceName: name,
									kind: "queue" as const,
									grant: queueGrant,
									limits: queue.limits,
									allow: binding.allow,
								})
							: undefined;
		if (!claim)
			throw new Error("AWS store does not match its declared dependency");
		const identity =
			claim.kind === "kv" || claim.kind === "queue"
				? `kv|${claim.grant.partition}|${claim.grant.accountId}|${claim.grant.region}|${claim.grant.tableName}`
				: claim.kind === "bucket"
					? `bucket|${claim.grant.bucketName}`
					: `secret|${claim.grant.secretArn}`;
		if (apply(setHas, physicalIdentities, [identity]))
			throw new Error("AWS store identities must be unique");
		apply(setAdd, physicalIdentities, [identity]);
		apply(arrayPush, entries, [{ name, claim, store: field.value }]);
	}

	const verified = (claim: AwsHttpBindingClaim) => {
		try {
			return acceptSynchronousTrue(verifyBinding(claim));
		} catch {
			return false;
		}
	};
	const verifiedAll = () => {
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry || !verified(entry.claim)) return false;
		}
		return true;
	};
	if (!verifiedAll()) throw new Error("AWS binding is not authorized");
	let inFlight = 0;
	return Object.freeze({
		async fetch(request: Request): Promise<Response> {
			if (
				!(request instanceof NativeRequest) ||
				types.isProxy(request) ||
				!verifiedAll() ||
				inFlight >= AWS_HTTP_MAX_IN_FLIGHT
			)
				return unavailable();
			let active = true;
			const live = (claim: AwsHttpBindingClaim) => active && verified(claim);
			const scoped = new Map<
				string,
				{
					kind: "kv" | "bucket" | "secret" | "queue";
					store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
				}
			>();
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				if (!entry) return unavailable();
				const claim = entry.claim;
				if (claim.kind === "queue") {
					// SAFETY: the factory queue and its exact AWS store grant were checked above.
					const store = entry.store as DurableQueue;
					apply(mapSet, scoped, [
						entry.name,
						{
							kind: "queue",
							store: scopeAwsQueue(store, claim.limits, claim.allow, () =>
								live(claim),
							),
						},
					]);
				} else if (claim.kind === "kv") {
					// SAFETY: the store's KV brand and matching claim were checked at construction.
					const store = entry.store as AwsKvStore;
					const before = () => {
						if (!live(claim))
							throw new AwsKvError(
								"AWS_KV_DENIED",
								"request grant is unavailable",
							);
					};
					const after = (mutation: boolean) => {
						if (!live(claim))
							throw new AwsKvError(
								mutation
									? "AWS_KV_MUTATION_OUTCOME_UNKNOWN"
									: "AWS_KV_READ_UNAVAILABLE",
								"request grant changed",
							);
					};
					apply(mapSet, scoped, [
						entry.name,
						{
							kind: "kv",
							store: Object.freeze({
								async get(key: string) {
									before();
									const value = await store.get(key);
									after(false);
									return value;
								},
								async exists(key: string) {
									before();
									const value = await store.exists(key);
									after(false);
									return value;
								},
								async set(value: Parameters<AwsKvStore["set"]>[0]) {
									before();
									await store.set(value);
									after(true);
								},
								async delete(key: string) {
									before();
									await store.delete(key);
									after(true);
								},
							}),
						},
					]);
				} else if (claim.kind === "bucket") {
					// SAFETY: the store's S3 brand and matching claim were checked at construction.
					const store = entry.store as AwsS3Store;
					const before = () => {
						if (!live(claim))
							throw new AwsS3Error(
								"AWS_S3_DENIED",
								"request grant is unavailable",
							);
					};
					const after = (mutation: boolean) => {
						if (!live(claim))
							throw new AwsS3Error(
								mutation
									? "AWS_S3_MUTATION_OUTCOME_UNKNOWN"
									: "AWS_S3_READ_UNAVAILABLE",
								"request grant changed",
							);
					};
					apply(mapSet, scoped, [
						entry.name,
						{
							kind: "bucket",
							store: Object.freeze({
								async read(key: string) {
									before();
									const value = await store.read(key);
									after(false);
									return value;
								},
								async write(value: Parameters<AwsS3Store["write"]>[0]) {
									before();
									await store.write(value);
									after(true);
								},
								async delete(key: string) {
									before();
									await store.delete(key);
									after(true);
								},
							}),
						},
					]);
				} else {
					// SAFETY: the store's secret brand and matching claim were checked at construction.
					const store = entry.store as AwsSecretStore;
					const before = () => {
						if (!live(claim))
							throw new AwsSecretError(
								"AWS_SECRET_DENIED",
								"request grant is unavailable",
							);
					};
					const after = (versionId?: string) => {
						if (!live(claim))
							throw new AwsSecretError(
								versionId === undefined
									? "AWS_SECRET_READ_UNAVAILABLE"
									: "AWS_SECRET_MUTATION_OUTCOME_UNKNOWN",
								"request grant changed",
								versionId,
							);
					};
					apply(mapSet, scoped, [
						entry.name,
						{
							kind: "secret",
							store: Object.freeze({
								async put(value: Uint8Array, versionId: string) {
									before();
									const result = await store.put(value, versionId);
									after(versionId);
									return result;
								},
								async access() {
									before();
									const result = await store.access();
									after();
									return result;
								},
								async accessVersion(versionId: string) {
									before();
									const result = await store.accessVersion(versionId);
									after();
									return result;
								},
								async listVersions() {
									before();
									const result = await store.listVersions();
									after();
									return result;
								},
							}),
						},
					]);
				}
			}
			const context: AwsBindleContext = Object.freeze({
				connector: () => {
					throw new Error("connectors are unsupported");
				},
			});
			const resources: AwsHttpBindings = Object.freeze({
				kv(name: string) {
					// SAFETY: scoped is the private map populated with checked entries.
					const item:
						| {
								kind: "kv" | "bucket" | "secret" | "queue";
								store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
						  }
						| undefined = apply(mapGet, scoped, [name]);
					if (!active || item?.kind !== "kv")
						throw new Error("KV binding is unavailable");
					// SAFETY: the scoped entry's kind was checked above.
					return item.store as AwsKvStore;
				},
				bucket(name: string) {
					// SAFETY: scoped is the private map populated with checked entries.
					const item:
						| {
								kind: "kv" | "bucket" | "secret" | "queue";
								store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
						  }
						| undefined = apply(mapGet, scoped, [name]);
					if (!active || item?.kind !== "bucket")
						throw new Error("bucket binding is unavailable");
					// SAFETY: the scoped entry's kind was checked above.
					return item.store as AwsS3Store;
				},
				queue(name: string) {
					// SAFETY: scoped is the private map populated with checked entries.
					const item:
						| {
								kind: "kv" | "bucket" | "secret" | "queue";
								store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
						  }
						| undefined = apply(mapGet, scoped, [name]);
					if (!active || item?.kind !== "queue")
						throw new Error("queue binding is unavailable");
					// SAFETY: the scoped entry's kind was checked above.
					return item.store as DurableQueue;
				},
				secret(name: string) {
					// SAFETY: scoped is the private map populated with checked entries.
					const item:
						| {
								kind: "kv" | "bucket" | "secret" | "queue";
								store: AwsKvStore | AwsS3Store | AwsSecretStore | DurableQueue;
						  }
						| undefined = apply(mapGet, scoped, [name]);
					if (!active || item?.kind !== "secret")
						throw new Error("secret binding is unavailable");
					// SAFETY: the scoped entry's kind was checked above.
					return item.store as AwsSecretStore;
				},
			});
			apply(weakSet, contextBindings, [context, resources]);
			inFlight++;
			const pending = (async () => {
				const handler = entrypoint(context);
				if (
					typeof handler !== "function" ||
					types.isProxy(handler) ||
					!verifiedAll()
				)
					throw new Error("handler is unavailable");
				const result = await responseFrom(apply(handler, undefined, [request]));
				return bufferResponseSafely(result.value, request);
			})();
			const work = createBoundaryDeferred<Response>();
			if (
				!observeOrdinaryPromise(
					pending,
					(value) => {
						inFlight--;
						if (validResponse(value)) work.resolve(value);
						else work.reject(new Error("invalid response"));
					},
					() => {
						inFlight--;
						work.reject(new Error("handler failed"));
					},
				)
			) {
				active = false;
				return unavailable();
			}
			const deadline = createBoundaryDeferred<Response>();
			const timer = schedule(
				() => deadline.reject(new Error("deadline")),
				AWS_HTTP_DEADLINE_MS,
			);
			observeBoundary(
				work.promise,
				() => {},
				() => {},
			);
			try {
				const response = (await raceBoundary(work.promise, deadline.promise))
					.value;
				if (!verifiedAll()) return unavailable();
				return response;
			} catch {
				return unavailable();
			} finally {
				active = false;
				cancelTimer(timer);
			}
		},
	});
}
