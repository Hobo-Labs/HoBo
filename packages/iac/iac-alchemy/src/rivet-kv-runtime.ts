/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread -- SAFETY: request, host authority and SQLite values cross provider boundaries and absent optional fields are intentionally omitted. */
import { types as utilTypes } from "node:util";
import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
	boundedRivetKvDecision,
	RIVET_KV_NONTHENABLE,
	RIVET_KV_ONCE,
	readRivetKvStream,
	retireRivetKvStream,
	rivetKvCancelTimer,
	rivetKvDeadline,
	rivetKvNative,
	rivetKvObserve,
	rivetKvPromise,
	rivetKvRace,
	rivetKvSchedule,
} from "./rivet-kv-boundary.js";
import {
	kvActorKey,
	kvActorName,
	kvDecode,
	kvDigest,
	kvFingerprint,
	kvKey,
	kvRequestId,
	RIVET_ASYNC_KV_CAPABILITIES,
	RIVET_ASYNC_KV_LIMITS,
	type RivetAsyncKvOperation,
} from "./rivet-kv-protocol.js";
import { RIVET_QUEUE_CHUNK_BYTES } from "./rivet-queue-stream.js";

export interface RivetAsyncKvContext {
	readonly name: string;
	readonly key: readonly string[];
	readonly db: RawAccess;
}

export interface RivetAsyncKvBinding {
	readonly actorName: string;
	readonly semanticDigest: string;
	readonly capabilities: typeof RIVET_ASYNC_KV_CAPABILITIES;
	readonly actor: AnyActorDefinition;
	readonly handle: (
		context: RivetAsyncKvContext,
		request: Request,
	) => Promise<Response>;
}

export type RivetAsyncKvAuthorization = {
	readonly phase: "access" | "operation" | "delivery";
	readonly actorName: string;
	readonly actorKey: readonly string[];
	readonly semanticDigest: string;
	readonly operation: RivetAsyncKvOperation;
	readonly requestId: string;
	readonly fingerprint: string;
	readonly headers: Headers;
	readonly key?: string;
};

export interface RivetAsyncKvOptions {
	readonly actorName: string;

	readonly semanticDigest: string;

	readonly authorize: (
		input: RivetAsyncKvAuthorization,
	) => boolean | Promise<boolean>;

	readonly verifyIngress: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly semanticDigest: string;
		readonly operation: RivetAsyncKvOperation;
		readonly maxRequestBytes: number;
		readonly maxChunkBytes: number;
		readonly maxHeaderBytes: number;
		readonly maxChunks: number;
	}) => boolean | Promise<boolean>;
}

const NativeWeakMap = WeakMap;
const weakGet = NativeWeakMap.prototype.get;
const weakSet = NativeWeakMap.prototype.set;
const bindings = new NativeWeakMap<
	object,
	Readonly<{
		database: object;
		onRequest: RivetAsyncKvBinding["handle"];
		handle: RivetAsyncKvBinding["handle"];
	}>
>();
const NativeError = Error;
const NativeTypeError = TypeError;
const freeze = Object.freeze;
const create = Object.create;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const getPrototype = Object.getPrototypeOf;
const setPrototype = Object.setPrototypeOf;
const stringify = JSON.stringify;
const parse = JSON.parse;
const NativeRequest = Request;
const NativeResponse = Response;
const responseStatus = getOwnDescriptor(
	NativeResponse.prototype,
	"status",
)?.get;
const NativeHeaders = Headers;
const NativeURL = URL;
const urlSearch = getOwnDescriptor(NativeURL.prototype, "search")?.get;
const urlHash = getOwnDescriptor(NativeURL.prototype, "hash")?.get;
const urlPath = getOwnDescriptor(NativeURL.prototype, "pathname")?.get;
const headerGet = NativeHeaders.prototype.get;
const headerSet = NativeHeaders.prototype.set;
const headerForEach = NativeHeaders.prototype.forEach;

const responseHeaders = new NativeHeaders([
	["cache-control", "no-store"],
	["content-type", "application/json"],
]);
const objectPrototype = Object.prototype;
const responseRealmFields = freeze([
	"get",
	"set",
	"value",
	"writable",
	"enumerable",
	"configurable",
	"status",
	"statusText",
	"headers",
	"cache-control",
	"content-type",
]);
const NativeTextDecoder = TextDecoder;
const decodeText = NativeTextDecoder.prototype.decode;
const isSafeInteger = Number.isSafeInteger;
const byteLength = getOwnDescriptor(
	getPrototype(Uint8Array.prototype),
	"byteLength",
)?.get;
const requestPrototype = NativeRequest.prototype;
const requestBodyGetter = getOwnDescriptor(requestPrototype, "body")?.get;
const requestHeadersGetter = getOwnDescriptor(requestPrototype, "headers")?.get;
const requestMethodGetter = getOwnDescriptor(requestPrototype, "method")?.get;
const requestUrlGetter = getOwnDescriptor(requestPrototype, "url")?.get;
const signalPrototype = AbortSignal.prototype;
const signalAborted = getOwnDescriptor(signalPrototype, "aborted")?.get;
const NativeAbortController = AbortController;
const controllerSignal = getOwnDescriptor(
	NativeAbortController.prototype,
	"signal",
)?.get;
const controllerAbort = getOwnDescriptor(
	NativeAbortController.prototype,
	"abort",
)?.value;
const addListener = getOwnDescriptor(
	EventTarget.prototype,
	"addEventListener",
)?.value;
const removeListener = getOwnDescriptor(
	EventTarget.prototype,
	"removeEventListener",
)?.value;
const requestFields = ["method", "url", "headers", "body", "signal"] as const;
const signalFields = [
	"aborted",
	"addEventListener",
	"removeEventListener",
] as const;
const objectKeys = Object.keys;
const isArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const signalGetter = getOwnDescriptor(requestPrototype, "signal")?.get;
const MAX_ACTIVE = 128;
const MAX_AUTHORITY_CALLS = 64;
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !isArray(value);
}
function transactionResult<T extends object>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}
function integer(value: unknown, maximum: number): value is number {
	return (
		typeof value === "number" &&
		isSafeInteger(value) &&
		value >= 0 &&
		value <= maximum
	);
}

function captureContext(context: RivetAsyncKvContext) {
	try {
		if (typeof context !== "object" || context === null || isProxy(context))
			return undefined;
		const own = (value: object, key: string): unknown => {
			const field = getOwnDescriptor(value, key);
			return field !== undefined && hasOwn(field, "value")
				? field.value
				: undefined;
		};
		const name = own(context, "name");
		const key = kvActorKey(own(context, "key"));
		const database = own(context, "db");
		if (
			typeof name !== "string" ||
			key === undefined ||
			typeof database !== "object" ||
			database === null ||
			isProxy(database)
		)
			return undefined;
		const transaction = own(database, "transaction");
		if (typeof transaction !== "function" || isProxy(transaction))
			return undefined;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the host authenticates the non-proxy database receiver and captured transaction function.
		const capturedDatabase = database as RawAccess;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the own-data check and function check establish the callback.
		const capturedTransaction = transaction as RawAccess["transaction"];
		return freeze({
			name,
			key,
			database: capturedDatabase,
			transaction: capturedTransaction,
		});
	} catch {
		return undefined;
	}
}
function response(status: number, data: object): Response {
	const realmSafe = () => {
		if (getPrototype(objectPrototype) !== null || responseStatus === undefined)
			return false;
		for (let index = 0; index < responseRealmFields.length; index++) {
			const field = responseRealmFields[index];
			if (
				field === undefined ||
				getOwnDescriptor(objectPrototype, field) !== undefined
			)
				return false;
		}
		return true;
	};
	if (!realmSafe()) throw new NativeError("response realm unavailable");
	setPrototype(data, null);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the fresh init contains only the status and immutable headers.
	const init = create(null) as ResponseInit;
	init.status = status;
	init.headers = responseHeaders;
	const result = new NativeResponse(stringify(data), freeze(init));
	if (
		responseStatus === undefined ||
		!realmSafe() ||
		apply(responseStatus, result, []) !== status
	)
		throw new NativeError("response status unverified");
	defineProperty(result, "then", RIVET_KV_NONTHENABLE);
	return result;
}

function copyHeaders(source: Headers): Headers {
	const result = new NativeHeaders();
	apply(headerForEach, source, [
		(value: string, key: string) => {
			apply(headerSet, result, [key, value]);
		},
	]);
	return result;
}
function operation(
	method: string,
	requestUrl: string,
): RivetAsyncKvOperation | undefined {
	try {
		if (
			urlSearch === undefined ||
			urlHash === undefined ||
			urlPath === undefined
		)
			return undefined;
		const url = new NativeURL(requestUrl);
		if (
			method !== "POST" ||
			apply(urlSearch, url, []) ||
			apply(urlHash, url, [])
		)
			return undefined;
		const path: string = apply(urlPath, url, []);
		if (path === "/get") return "get";
		if (path === "/set") return "set";
		if (path === "/delete") return "delete";
		if (path === "/exists") return "exists";
		return undefined;
	} catch {
		return undefined;
	}
}

export async function migrateRivetAsyncKv(database: RawAccess): Promise<void> {
	await rivetKvNative(
		database.execute(
			"CREATE TABLE IF NOT EXISTS hobo_kv_entries (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0 AND size <= 32768))",
		),
	);
	await rivetKvNative(
		database.execute(
			"CREATE TABLE IF NOT EXISTS hobo_kv_meta (id INTEGER PRIMARY KEY CHECK(id = 1), entries INTEGER NOT NULL CHECK(entries >= 0 AND entries <= 4096), total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0 AND total_bytes <= 16777216))",
		),
	);

	await rivetKvNative(
		database.execute(
			"INSERT OR IGNORE INTO hobo_kv_meta(id,entries,total_bytes) SELECT 1,0,0 WHERE NOT EXISTS (SELECT 1 FROM hobo_kv_entries LIMIT 1)",
		),
	);
}

export function createRivetAsyncKvActor(
	options: RivetAsyncKvOptions,
): RivetAsyncKvBinding {
	if (typeof options !== "object" || options === null || isProxy(options))
		throw new NativeTypeError("a trusted actor configuration is required");
	const own = (key: string): unknown => {
		const descriptor = getOwnDescriptor(options, key);
		return descriptor !== undefined && hasOwn(descriptor, "value")
			? descriptor.value
			: undefined;
	};
	const actorName = own("actorName");
	const semanticDigest = own("semanticDigest");
	const authorize = own("authorize");
	const verifyIngress = own("verifyIngress");
	if (
		!kvActorName(actorName) ||
		!kvDigest(semanticDigest) ||
		typeof authorize !== "function" ||
		isProxy(authorize) ||
		typeof verifyIngress !== "function" ||
		isProxy(verifyIngress)
	)
		throw new NativeTypeError(
			"a bounded actor identity, semantic digest and trusted host authorities are required",
		);
	const receiver = freeze({
		actorName,
		semanticDigest,
		authorize,
		verifyIngress,
	});
	const database = db({ onMigrate: migrateRivetAsyncKv });
	let active = 0;
	let pendingAuthority = 0;
	const decide = async (
		callback: () => boolean | Promise<boolean>,
		signal: AbortSignal,
		deadline: ReturnType<typeof rivetKvDeadline>,
	): Promise<boolean | undefined> => {
		if (pendingAuthority >= MAX_AUTHORITY_CALLS || deadline.expired())
			return undefined;
		pendingAuthority++;
		let tracked = false;
		try {
			const { value: result } = await rivetKvNative(
				boundedRivetKvDecision(
					() => {
						if (deadline.expired()) throw new NativeError("request expired");
						return callback();
					},
					signal,
					deadline,
					(pending) => {
						tracked = true;
						rivetKvObserve(
							pending,
							() => {
								pendingAuthority--;
							},
							() => {
								pendingAuthority--;
							},
						);
						return pending;
					},
				),
			);
			return deadline.expired() ? undefined : result;
		} catch {
			return undefined;
		} finally {
			if (!tracked) pendingAuthority--;
		}
	};
	const handle = async (
		context: RivetAsyncKvContext,
		request: Request,
	): Promise<Response> => {
		if (active >= MAX_ACTIVE) return response(503, { error: "unavailable" });
		const capturedContext = captureContext(context);
		if (capturedContext === undefined)
			return response(503, { error: "unavailable" });
		active++;
		let sourceSignal: AbortSignal | undefined;
		let relay: (() => void) | undefined;
		let abortObserved = false;
		let relayFailed = false;
		let transactionUnobservable = false;
		const deliver = (status: number, data: object): Response => {
			try {
				return response(status, data);
			} catch (error) {
				transactionUnobservable = true;
				throw error;
			}
		};
		let expireDeadline = () => {};
		let listenerAdded = false;
		let released = false;
		const release = () => {
			if (released || relayFailed || transactionUnobservable) return;
			if (listenerAdded) {
				try {
					apply(removeListener, sourceSignal, ["abort", relay]);
				} catch {
					return;
				}
				listenerAdded = false;
			}
			released = true;
			active--;
		};
		let workRetired = false;
		let responseFinalized = false;
		const releaseAfterResponse = () => {
			if (workRetired && responseFinalized) release();
		};
		let transferAttempted = false;
		let bodyKnown = false;
		let requestBody: ReadableStream<Uint8Array> | null = null;
		let ownedRequest: Request;
		let headers: Headers;
		let method: string;
		let targetUrl: string;
		let signal: AbortSignal;
		const actorKey = capturedContext.key;
		const contextName = capturedContext.name;
		const targetDb = capturedContext.database;
		const transaction = capturedContext.transaction;
		let deadline: ReturnType<typeof rivetKvDeadline>;
		try {
			if (
				isProxy(request) ||
				getPrototype(request) !== requestPrototype ||
				requestFields.some(
					(field) => getOwnDescriptor(request, field) !== undefined,
				) ||
				signalGetter === undefined ||
				requestBodyGetter === undefined ||
				requestHeadersGetter === undefined ||
				requestMethodGetter === undefined ||
				requestUrlGetter === undefined ||
				signalAborted === undefined ||
				controllerSignal === undefined ||
				typeof controllerAbort !== "function" ||
				addListener === undefined ||
				removeListener === undefined
			)
				throw new NativeError("invalid request");
			sourceSignal = apply(signalGetter, request, []);
			if (
				sourceSignal === undefined ||
				isProxy(sourceSignal) ||
				getPrototype(sourceSignal) !== signalPrototype ||
				signalFields.some(
					(field) => getOwnDescriptor(sourceSignal, field) !== undefined,
				)
			)
				throw new NativeError("invalid request signal");
			const controller = new NativeAbortController();
			signal = apply(controllerSignal, controller, []);
			relay = () => {
				abortObserved = true;
				expireDeadline();
				try {
					apply(controllerAbort, controller, []);
					if (apply(signalAborted, signal, []) !== true) relayFailed = true;
				} catch {
					relayFailed = true;
					expireDeadline();
				}
			};
			listenerAdded = true;
			apply(addListener, sourceSignal, ["abort", relay, RIVET_KV_ONCE]);
			if (apply(signalAborted, sourceSignal, []) === true) relay();
			deadline = rivetKvDeadline(signal);
			expireDeadline = () => deadline.expire();
			if (abortObserved) {
				deadline.expire();
				throw new NativeError("request aborted");
			}
			transferAttempted = true;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the transferred request receives only the private signal.
			const init = create(null) as RequestInit;
			init.signal = signal;
			ownedRequest = new NativeRequest(request, freeze(init));
			requestBody = apply(requestBodyGetter, ownedRequest, []);
			bodyKnown = true;
			headers = copyHeaders(apply(requestHeadersGetter, ownedRequest, []));
			method = apply(requestMethodGetter, ownedRequest, []);
			targetUrl = apply(requestUrlGetter, ownedRequest, []);
		} catch {
			if (!transferAttempted) release();
			else if (bodyKnown) {
				rivetKvObserve(
					retireRivetKvStream(requestBody),
					() => {
						release();
					},
					() => {},
				);
			}

			return response(503, { error: "unavailable" });
		}
		const action = operation(method, targetUrl);
		const requestId: string | null = apply(headerGet, headers, [
			"x-hobo-kv-request-id",
		]);
		const fingerprint: string | null = apply(headerGet, headers, [
			"x-hobo-kv-fingerprint",
		]);
		const receipt =
			action !== undefined && kvRequestId(requestId) && kvDigest(fingerprint)
				? freeze({
						requestId,
						fingerprint,
						operation: action,
						semanticDigest,
					})
				: undefined;
		let bodyTaken = false;
		const run = async (): Promise<Response> => {
			try {
				if (action === undefined) return response(404, { error: "not-found" });
				if (receipt === undefined)
					return response(400, { error: "invalid-argument" });
				if (
					apply(headerGet, headers, ["x-hobo-kv-semantic-digest"]) !==
					semanticDigest
				)
					return response(503, { ...receipt, error: "unavailable" });
				const { requestId, fingerprint } = receipt;
				if (contextName !== actorName)
					return response(403, { ...receipt, error: "forbidden" });
				const { value: ingress } = await rivetKvNative(
					decide(
						() =>
							apply(verifyIngress, receiver, [
								freeze({
									actorName,
									actorKey,
									semanticDigest,
									operation: action,
									maxRequestBytes: RIVET_ASYNC_KV_LIMITS.requestBytes,
									maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
									maxHeaderBytes: 16_384,
									maxChunks: 4096,
								}),
							]),
						signal,
						deadline,
					),
				);
				if (ingress !== true)
					return response(503, { ...receipt, error: "unavailable" });
				const authorizePhase = (
					phase: RivetAsyncKvAuthorization["phase"],
					key?: string,
				) =>
					decide(
						() =>
							apply(authorize, receiver, [
								freeze({
									phase,
									actorName,
									actorKey,
									semanticDigest,
									operation: action,
									requestId,
									fingerprint,
									headers: copyHeaders(headers),
									...(key === undefined ? {} : { key }),
								}),
							]),
						signal,
						deadline,
					);
				const { value: access } = await rivetKvNative(authorizePhase("access"));
				if (access === false)
					return response(403, { ...receipt, error: "forbidden" });
				if (access !== true)
					return response(503, { ...receipt, error: "unavailable" });
				let body: unknown;
				try {
					bodyTaken = true;
					const { value: bytes } = await rivetKvNative(
						readRivetKvStream(
							requestBody,
							RIVET_ASYNC_KV_LIMITS.requestBytes,
							signal,
							deadline,
						),
					);
					body = parse(
						apply(decodeText, new NativeTextDecoder("utf-8", { fatal: true }), [
							bytes,
						]),
					);
				} catch {
					return deadline.expired()
						? response(503, { ...receipt, error: "unavailable" })
						: response(400, { ...receipt, error: "invalid-argument" });
				}
				if (
					!record(body) ||
					objectKeys(body).length !== (action === "set" ? 3 : 2) ||
					!hasOwn(body, "requestId") ||
					!hasOwn(body, "key") ||
					body.requestId !== requestId ||
					!kvKey(body.key) ||
					(action === "set" && !hasOwn(body, "value"))
				)
					return response(400, { ...receipt, error: "invalid-argument" });
				const encoded =
					action === "set" && typeof body.value === "string"
						? body.value
						: undefined;
				const value = action === "set" ? kvDecode(encoded) : undefined;
				if (byteLength === undefined)
					return response(503, { ...receipt, error: "unavailable" });
				const valueSize: number =
					value === undefined ? 0 : apply(byteLength, value, []);
				if (
					(action === "set" && value === undefined) ||
					kvFingerprint(
						semanticDigest,
						action,
						requestId,
						body.key,
						encoded,
					) !== fingerprint
				)
					return response(400, { ...receipt, error: "invalid-argument" });
				const key = body.key;
				const { value: permitted } = await rivetKvNative(
					authorizePhase("operation", key),
				);
				if (permitted === false)
					return response(403, { ...receipt, error: "forbidden" });
				if (permitted !== true || deadline.expired())
					return response(503, { ...receipt, error: "unavailable" });
				try {
					const observeStarted = <T>(start: () => Promise<T>) => {
						try {
							return rivetKvNative(start());
						} catch (error) {
							transactionUnobservable = true;
							throw error;
						}
					};
					const { value: result } = await observeStarted<
						Record<string, unknown>
					>(() =>
						apply(transaction, targetDb, [
							async (tx: RawAccess) => {
								if (typeof tx !== "object" || tx === null || isProxy(tx))
									throw new NativeError("invalid transaction");
								const field = getOwnDescriptor(tx, "execute");
								if (
									field === undefined ||
									!hasOwn(field, "value") ||
									typeof field.value !== "function" ||
									isProxy(field.value)
								)
									throw new NativeError("invalid transaction execute");
								// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the non-proxy own execute function is invoked with its captured transaction receiver.
								const execute = ((...args: Parameters<RawAccess["execute"]>) =>
									apply(field.value, tx, args)) as RawAccess["execute"];
								if (deadline.expired())
									throw new NativeError("request expired");
								const { value: meta } = await observeStarted(() =>
									execute<{
										entries: unknown;
										total_bytes: unknown;
									}>("SELECT entries,total_bytes FROM hobo_kv_meta WHERE id=1"),
								);
								if (deadline.expired())
									throw new NativeError("request expired");
								const state = meta[0];
								if (
									meta.length !== 1 ||
									!state ||
									!integer(state.entries, RIVET_ASYNC_KV_LIMITS.entries) ||
									!integer(
										state.total_bytes,
										RIVET_ASYNC_KV_LIMITS.totalValueBytes,
									)
								)
									throw new NativeError("invalid KV metadata");

								const { value: totals } = await observeStarted(() =>
									execute<{
										entries: unknown;
										total_bytes: unknown;
										invalid: unknown;
									}>(
										`WITH bounded AS (SELECT key,value,size FROM hobo_kv_entries LIMIT 4097)
						SELECT COUNT(*) AS entries,
						COALESCE(SUM(CASE WHEN typeof(size)='integer' AND size BETWEEN 0 AND 32768 THEN size ELSE 0 END),0) AS total_bytes,
						COALESCE(SUM(CASE WHEN typeof(key)='text' AND length(CAST(key AS BLOB)) <= 1024
						AND typeof(value)='text' AND typeof(size)='integer' AND size BETWEEN 0 AND 32768
						AND length(CAST(value AS BLOB)) = ((size+2)/3)*4
						AND ((size%3=0 AND substr(value,-1) <> '=') OR (size%3=1 AND substr(value,-2) = '==') OR (size%3=2 AND substr(value,-1) = '=' AND substr(value,-2,1) <> '='))
						THEN 0 ELSE 1 END),0) AS invalid FROM bounded`,
									),
								);
								if (deadline.expired())
									throw new NativeError("request expired");
								const total = totals[0];
								if (
									totals.length !== 1 ||
									!total ||
									total.invalid !== 0 ||
									total.entries !== state.entries ||
									total.total_bytes !== state.total_bytes
								)
									throw new NativeError("KV accounting mismatch");
								const { value: rows } = await observeStarted(() =>
									execute<{ value: unknown; size: unknown }>(
										"SELECT value,size FROM hobo_kv_entries WHERE key=?",
										key,
									),
								);
								if (deadline.expired())
									throw new NativeError("request expired");
								if (rows.length > 1) throw new NativeError("invalid KV rows");
								const previous = rows[0];
								const decoded =
									previous === undefined ? undefined : kvDecode(previous.value);
								let oldSize = 0;
								if (previous !== undefined) {
									if (
										decoded === undefined ||
										!integer(previous.size, RIVET_ASYNC_KV_LIMITS.valueBytes) ||
										previous.size !== apply(byteLength, decoded, []) ||
										state.entries < 1 ||
										state.total_bytes < previous.size
									)
										throw new NativeError("invalid KV value");
									oldSize = previous.size;
								}
								if (deadline.expired())
									throw new NativeError("request expired");
								if (action === "get")
									return transactionResult({
										value: previous === undefined ? null : previous.value,
									});
								if (action === "exists")
									return transactionResult({ exists: previous !== undefined });
								const nextEntries =
									state.entries +
									(action === "set" && previous === undefined
										? 1
										: action === "delete" && previous !== undefined
											? -1
											: 0);
								const nextBytes =
									state.total_bytes -
									oldSize +
									(action === "set" ? valueSize : 0);
								if (
									nextEntries > RIVET_ASYNC_KV_LIMITS.entries ||
									nextBytes > RIVET_ASYNC_KV_LIMITS.totalValueBytes
								)
									return transactionResult({ error: "capacity-exhausted" });
								if (nextEntries < 0 || nextBytes < 0)
									throw new NativeError("invalid KV accounting");
								if (action === "set")
									await observeStarted(() =>
										execute(
											"INSERT INTO hobo_kv_entries(key,value,size) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,size=excluded.size",
											key,
											encoded,
											valueSize,
										),
									);
								else
									await observeStarted(() =>
										execute("DELETE FROM hobo_kv_entries WHERE key=?", key),
									);
								if (deadline.expired())
									throw new NativeError("request expired");
								await observeStarted(() =>
									execute(
										"UPDATE hobo_kv_meta SET entries=?,total_bytes=? WHERE id=1",
										nextEntries,
										nextBytes,
									),
								);
								if (deadline.expired())
									throw new NativeError("request expired");
								return transactionResult({});
							},
						]),
					);
					const { value: deliveryAuthorized } = await rivetKvNative(
						authorizePhase("delivery", key),
					);
					if (deadline.expired() || deliveryAuthorized !== true)
						return deliver(503, { ...receipt, error: "outcome-unknown" });
					if (hasOwn(result, "error"))
						return deliver(429, { ...receipt, error: result.error });
					return deliver(200, { ...receipt, ...result });
				} catch {
					return deliver(503, { ...receipt, error: "outcome-unknown" });
				}
			} finally {
				if (!bodyTaken) await rivetKvNative(retireRivetKvStream(requestBody));
				workRetired = true;
				releaseAfterResponse();
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let resolveTimeout: (result: Response) => void = () => {};
		let rejectTimeout: (reason: unknown) => void = () => {};
		const timeout = rivetKvPromise<Response>((resolve, reject) => {
			resolveTimeout = resolve;
			rejectTimeout = reject;
		});
		try {
			timer = rivetKvSchedule(() => {
				deadline.expire();
				try {
					resolveTimeout(
						deliver(503, { ...receipt, error: "outcome-unknown" }),
					);
				} catch (error) {
					rejectTimeout(error);
				}
			}, deadline.remainingMs());
		} catch {
			rivetKvObserve(retireRivetKvStream(requestBody), release, () => {});
			return response(503, { ...receipt, error: "unavailable" });
		}
		try {
			const { value: result } = await rivetKvRace(run(), timeout);
			const finalResponse = deadline.expired()
				? deliver(503, { ...receipt, error: "outcome-unknown" })
				: result;
			responseFinalized = true;
			releaseAfterResponse();
			return finalResponse;
		} catch {
			const finalResponse = deliver(503, {
				...receipt,
				error: "outcome-unknown",
			});
			responseFinalized = true;
			releaseAfterResponse();
			return finalResponse;
		} finally {
			if (timer !== undefined) {
				try {
					rivetKvCancelTimer(timer);
				} catch {
					void timer;
				}
			}
		}
	};

	const onRequest: RivetAsyncKvBinding["handle"] = async (context, request) => {
		try {
			if (typeof context !== "object" || context === null || isProxy(context))
				return response(503, { error: "unavailable" });
			for (const key of ["name", "key", "db"] as const) {
				const field = getOwnDescriptor(context, key);
				if (field !== undefined && !hasOwn(field, "value"))
					return response(503, { error: "unavailable" });
			}
			return (
				await rivetKvNative(
					handle(
						{ name: context.name, key: context.key, db: context.db },
						request,
					),
				)
			).value;
		} catch {
			return response(503, { error: "unavailable" });
		}
	};
	freeze(database);
	const definition = actor({ db: database, onRequest });
	freeze(definition.config.actions);
	freeze(definition.config.options);
	freeze(definition.config);
	freeze(definition);
	const binding = freeze({
		actorName,
		semanticDigest,
		capabilities: RIVET_ASYNC_KV_CAPABILITIES,
		actor: definition,
		handle,
	});
	apply(weakSet, bindings, [binding, freeze({ database, onRequest, handle })]);
	return binding;
}

export function isRivetAsyncKvBinding(binding: RivetAsyncKvBinding): boolean {
	const captured: ReturnType<typeof bindings.get> = apply(weakGet, bindings, [
		binding,
	]);
	return (
		captured !== undefined &&
		isStaticActorDefinition(binding.actor) &&
		"db" in binding.actor.config &&
		binding.actor.config.db === captured.database &&
		binding.actor.config.onRequest === captured.onRequest &&
		binding.handle === captured.handle &&
		binding.capabilities === RIVET_ASYNC_KV_CAPABILITIES
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread */
