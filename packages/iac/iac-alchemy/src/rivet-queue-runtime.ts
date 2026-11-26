/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread -- SAFETY: HTTP, SQLite and host authority values cross validated provider boundaries. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import { rivetProtectResponse } from "./rivet-http-response.js";
import {
	boundedRivetQueueDecision,
	cancelRivetQueueStream,
	captureRivetQueueTimers,
	RIVET_QUEUE_CHUNK_BYTES,
	RIVET_QUEUE_TIMEOUT_MS,
	type RivetQueueTrack,
	readRivetQueueStream,
	rivetQueueObserveNative,
	rivetQueueStreamErrorCode,
} from "./rivet-queue-stream.js";

export type RivetQueueOperation =
	| "enqueue"
	| "dequeue"
	| "complete"
	| "release"
	| "extend";
export interface RivetQueueContext {
	readonly name: string;
	readonly key: readonly string[];
	readonly db: RawAccess;
}
export interface RivetQueueBinding {
	readonly actorName: string;
	readonly actor: AnyActorDefinition;
	readonly handle: (
		context: RivetQueueContext,
		request: Request,
	) => Promise<Response>;
}

const NativeWeakMap = WeakMap;
const weakGet = NativeWeakMap.prototype.get;
const weakSet = NativeWeakMap.prototype.set;
const registered = new NativeWeakMap<
	object,
	{ readonly database: object; readonly onRequest: RivetQueueBinding["handle"] }
>();
const MAX_MESSAGES = 10_000;
const MAX_BODY_BYTES = 65_536;
const MAX_LEASE_MS = 86_400_000;
const MAX_BATCH = 100;
const NativeTextEncoder = TextEncoder;
const encoder = new NativeTextEncoder();
const encodeText = NativeTextEncoder.prototype.encode;
const applyHost = Reflect.apply;
const isProxy = types.isProxy;
const isArray = Array.isArray;
const arrayPrototype = Array.prototype;
const hasOwn = Object.hasOwn;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const apply = Reflect.apply;
const isSafeInteger = Number.isSafeInteger;
const maxSafeInteger = Number.MAX_SAFE_INTEGER;
const NativeError = Error;
const isFiniteNumber = Number.isFinite;
const arrayPop = Array.prototype.pop;
const arraySort = Array.prototype.sort;
const trim = String.prototype.trim;
const test = RegExp.prototype.test;
const controlCharacters = /[\p{Cc}]/u;
const isPromise = types.isPromise;
const hasOwnDescriptor = Object.hasOwn;
const objectKeys = Object.keys;
const objectValues = Object.values;
const getPrototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const typedArrayPrototype = getPrototype(Uint8Array.prototype);
const typedByteLength = descriptor(typedArrayPrototype, "byteLength")?.get;
const ownKeys = Reflect.ownKeys;
const setPrototype = Object.setPrototypeOf;
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;
const NativeResponse = Response;
const responseStatus = descriptor(NativeResponse.prototype, "status")?.get;
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
	"toJSON",
]);
const responseHeaders = new Headers([
	["cache-control", "no-store"],
	["content-type", "application/json"],
]);
const NativeURL = URL;
const urlPath = descriptor(NativeURL.prototype, "pathname")?.get;
const NativeDate = Date;
const dateIso = NativeDate.prototype.toISOString;
const NativeTextDecoder = TextDecoder;
const decodeText = NativeTextDecoder.prototype.decode;
const decoderOptions: TextDecoderOptions = create(null);
decoderOptions.fatal = true;
freeze(decoderOptions);
const listenerOptions: AddEventListenerOptions = create(null);
listenerOptions.once = true;
freeze(listenerOptions);
const requestPrototype = Request.prototype;
const nativeHeaders = Headers;
const headersPrototype = Headers.prototype;
const headersForEach = descriptor(headersPrototype, "forEach")?.value;
const headersSet = descriptor(headersPrototype, "set")?.value;
const signalPrototype = AbortSignal.prototype;
const signalAborted = descriptor(signalPrototype, "aborted")?.get;
const NativeAbortController = AbortController;
const controllerSignal = descriptor(
	NativeAbortController.prototype,
	"signal",
)?.get;
const controllerAbort = descriptor(
	NativeAbortController.prototype,
	"abort",
)?.value;
const addListener = descriptor(
	EventTarget.prototype,
	"addEventListener",
)?.value;
const removeListener = descriptor(
	EventTarget.prototype,
	"removeEventListener",
)?.value;
const requestFields = ["method", "url", "headers", "body", "signal"] as const;
const requestGetters = requestFields.map(
	(field) => descriptor(requestPrototype, field)?.get,
);
const performanceNow = performance.now;
const monotonicNow = () => applyHost(performanceNow, performance, []);
const MAX_ACTIVE_REQUESTS = 32;
const nativePromise = Promise;
const promisePrototype = nativePromise.prototype;
const promiseThen = nativePromise.prototype.then;
const promiseResolve = nativePromise.resolve;
const promiseSpecies = descriptor(nativePromise, Symbol.species)?.get;

function isSignalAborted(signal: AbortSignal): boolean {
	try {
		return (
			isProxy(signal) ||
			signalAborted === undefined ||
			applyHost(signalAborted, signal, []) !== false
		);
	} catch {
		return true;
	}
}

function observeUnexpectedPromise(value: unknown): void {
	try {
		if (
			isProxy(value) ||
			!isPromise(value) ||
			getPrototype(value) !== promisePrototype ||
			descriptor(value, "constructor") !== undefined
		)
			return;
		const constructorField = descriptor(promisePrototype, "constructor");
		const species = descriptor(nativePromise, Symbol.species);
		if (
			constructorField === undefined ||
			!hasOwnDescriptor(constructorField, "value") ||
			constructorField.value !== nativePromise ||
			species === undefined ||
			!hasOwnDescriptor(species, "get") ||
			species.get !== promiseSpecies ||
			promiseSpecies === undefined
		)
			return;
		applyHost(promiseThen, value, [() => undefined, () => undefined]);
	} catch {}
}

function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		apply(trim, value, []) === value &&
		!apply(test, controlCharacters, [value])
	);
}

function captureContext(value: unknown):
	| {
			readonly name: string;
			readonly key: readonly string[];
			readonly database: RawAccess;
			readonly transaction: RawAccess["transaction"];
	  }
	| undefined {
	try {
		if (typeof value !== "object" || value === null || isProxy(value)) return;
		const nameField = descriptor(value, "name");
		const keyField = descriptor(value, "key");
		const dbField = descriptor(value, "db");
		if (
			nameField === undefined ||
			!hasOwn(nameField, "value") ||
			keyField === undefined ||
			!hasOwn(keyField, "value") ||
			dbField === undefined ||
			!hasOwn(dbField, "value") ||
			typeof nameField.value !== "string"
		)
			return;
		const key: unknown = keyField.value;
		const database: unknown = dbField.value;
		if (
			isProxy(key) ||
			!isArray(key) ||
			getPrototype(key) !== arrayPrototype ||
			typeof database !== "object" ||
			database === null ||
			isProxy(database)
		)
			return;
		const length = descriptor(key, "length");
		if (
			length === undefined ||
			!hasOwn(length, "value") ||
			typeof length.value !== "number" ||
			!isSafeInteger(length.value) ||
			length.value < 1 ||
			length.value > 16 ||
			ownKeys(key).length !== length.value + 1
		)
			return;
		const parts: string[] = [];
		for (let index = 0; index < length.value; index++) {
			const part = descriptor(key, `${index}`);
			if (
				part === undefined ||
				!hasOwn(part, "value") ||
				!hasOwn(part, "enumerable") ||
				part.enumerable !== true ||
				!name(part.value)
			)
				return;
			const field: PropertyDescriptor = create(null);
			field.value = part.value;
			field.enumerable = true;
			field.writable = true;
			field.configurable = true;
			define(parts, `${index}`, field);
		}
		const transaction = descriptor(database, "transaction");
		if (
			transaction === undefined ||
			!hasOwn(transaction, "value") ||
			typeof transaction.value !== "function" ||
			isProxy(transaction.value)
		)
			return;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured own data fields establish this RawAccess capability.
		return {
			name: nameField.value,
			key: freeze(parts),
			database: database as RawAccess,
			transaction: transaction.value as RawAccess["transaction"],
		};
	} catch {
		return;
	}
}

function integer(value: unknown, min: number, max: number): value is number {
	return (
		typeof value === "number" &&
		isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !isArray(value);
}

function append<T>(array: T[], value: T): void {
	const field: PropertyDescriptor = create(null);
	field.value = value;
	field.enumerable = true;
	field.writable = true;
	field.configurable = true;
	define(array, `${array.length}`, field);
}
function validJson(value: unknown): boolean {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let count = 0;
	while (pending.length) {
		const item: { value: unknown; depth: number } | undefined = applyHost(
			arrayPop,
			pending,
			[],
		);
		if (!item || ++count > 10_000 || item.depth > 64) return false;
		const current = item.value;
		if (
			current === null ||
			typeof current === "string" ||
			typeof current === "boolean"
		)
			continue;
		if (typeof current === "number") {
			if (!isFiniteNumber(current)) return false;
			continue;
		}
		if (isArray(current)) {
			for (let index = 0; index < current.length; index++)
				append(pending, { value: current[index], depth: item.depth + 1 });
		} else if (record(current)) {
			const values = objectValues(current);
			for (let index = 0; index < values.length; index++)
				append(pending, { value: values[index], depth: item.depth + 1 });
		} else return false;
	}
	return true;
}
function canonical(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number"
	)
		return applyHost(stringifyJson, undefined, [value]);
	if (isArray(value)) {
		let output = "[";
		for (let index = 0; index < value.length; index++) {
			if (index > 0) output += ",";
			output += canonical(value[index]);
		}
		return `${output}]`;
	}
	if (record(value)) {
		const keys = objectKeys(value);
		applyHost(arraySort, keys, []);
		let output = "{";
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (key === undefined) throw undefined;
			if (index > 0) output += ",";
			output += `${applyHost(stringifyJson, undefined, [key])}:${canonical(value[key])}`;
		}
		return `${output}}`;
	}
	throw undefined;
}
function response(status: number, data: object): Response {
	const realmSafe = () => {
		if (
			getPrototype(objectPrototype) !== null ||
			responseStatus === undefined ||
			descriptor(arrayPrototype, "toJSON") !== undefined
		)
			return false;
		for (let index = 0; index < responseRealmFields.length; index++) {
			const field = responseRealmFields[index];
			if (
				field === undefined ||
				descriptor(objectPrototype, field) !== undefined
			)
				return false;
		}
		return true;
	};
	if (!realmSafe()) throw undefined;
	setPrototype(data, null);
	const init: ResponseInit = create(null);
	init.status = status;
	init.headers = responseHeaders;
	const result = new NativeResponse(
		applyHost(stringifyJson, undefined, [data]),
		freeze(init),
	);
	if (
		!realmSafe() ||
		responseStatus === undefined ||
		applyHost(responseStatus, result, []) !== status ||
		!rivetProtectResponse(result)
	)
		throw undefined;
	return result;
}
function parseBody(bytes: Uint8Array): unknown {
	const body: unknown = applyHost(parseJson, undefined, [
		applyHost(decodeText, new NativeTextDecoder("utf-8", decoderOptions), [
			bytes,
		]),
	]);

	if (typeof body === "object" && body !== null) setPrototype(body, null);
	return body;
}
function operation(
	method: string,
	url: string,
): RivetQueueOperation | undefined {
	if (method !== "POST") return undefined;
	if (urlPath === undefined) return undefined;
	const path: unknown = applyHost(urlPath, new NativeURL(url), []);
	if (path === "/enqueue") return "enqueue";
	if (path === "/dequeue") return "dequeue";
	if (path === "/complete") return "complete";
	if (path === "/release") return "release";
	if (path === "/extend") return "extend";
	return undefined;
}

function captureRequest(request: Request) {
	try {
		if (
			typeof request !== "object" ||
			request === null ||
			isProxy(request) ||
			getPrototype(request) !== requestPrototype ||
			requestFields.some((field) => descriptor(request, field) !== undefined) ||
			requestGetters.some((getter) => getter === undefined) ||
			headersForEach === undefined ||
			headersSet === undefined ||
			signalAborted === undefined ||
			addListener === undefined ||
			removeListener === undefined
		)
			return undefined;
		const [method, url, headers, body, signal] = requestGetters.map(
			(getter) => {
				if (getter === undefined)
					throw new NativeError("missing native request getter");
				return applyHost(getter, request, []);
			},
		);
		if (
			typeof method !== "string" ||
			method.length > 16 ||
			typeof url !== "string" ||
			url.length > 4096 ||
			typeof headers !== "object" ||
			headers === null ||
			isProxy(headers) ||
			getPrototype(headers) !== headersPrototype ||
			typeof signal !== "object" ||
			signal === null ||
			isProxy(signal) ||
			getPrototype(signal) !== signalPrototype ||
			descriptor(signal, "aborted") !== undefined ||
			descriptor(signal, "addEventListener") !== undefined ||
			descriptor(signal, "removeEventListener") !== undefined
		)
			return undefined;
		const copied = new nativeHeaders();
		let fields = 0;
		let chars = 0;
		applyHost(headersForEach, headers, [
			(value: string, key: string) => {
				fields++;
				chars += key.length + value.length;
				if (fields > 256 || chars > 65_536)
					throw new NativeError("headers exceed bounds");
				applyHost(headersSet, copied, [key, value]);
			},
		]);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: genuine native Request getters provide its stream and signal.
		return freeze({
			method,
			url,
			headers: copied,
			body: body as ReadableStream<Uint8Array> | null,
			signal: signal as AbortSignal,
		});
	} catch {
		return undefined;
	}
}
interface StoredMessage extends Record<string, unknown> {
	message_id: string;
	idempotency_key: string;
	body: string;
	available_at: number;
	requested_available_at: number | null;
	state: string;
	lease_id: string | null;
	lease_expires_at: number | null;
	attempt: number;
	completed_lease_id: string | null;
}
function message(row: StoredMessage, queueName: string) {
	if (
		!name(row.message_id) ||
		!name(row.idempotency_key) ||
		!integer(row.attempt, 1, 4_294_967_295) ||
		!name(row.lease_id) ||
		!integer(row.lease_expires_at, 0, maxSafeInteger)
	)
		throw new NativeError("corrupt queue record");
	return {
		messageId: row.message_id,
		queueName,
		idempotencyKey: row.idempotency_key,
		body: applyHost(parseJson, undefined, [row.body]),
		leaseId: row.lease_id,
		leaseExpiresAt: applyHost(
			dateIso,
			new NativeDate(row.lease_expires_at),
			[],
		),
		deliveryAttempt: row.attempt,
	};
}

export function createRivetQueueActor(options: {
	readonly actorName: string;
	readonly authorize: (input: {
		readonly phase: "before" | "after";
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly operation: RivetQueueOperation;
		readonly headers: Headers;
	}) => boolean | Promise<boolean>;

	readonly now: () => number;

	readonly verifyIngress?: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly operation: RivetQueueOperation;
		readonly maxRequestBytes: number;
		readonly maxChunkBytes: number;
	}) => boolean | Promise<boolean>;
}): RivetQueueBinding {
	if (
		isProxy(options) ||
		typeof options !== "object" ||
		options === null ||
		isArray(options)
	)
		throw new TypeError("queue actor options must be own data");
	const actorNameField = descriptor(options, "actorName");
	const authorizeField = descriptor(options, "authorize");
	const nowField = descriptor(options, "now");
	const ingressField = descriptor(options, "verifyIngress");
	if (
		actorNameField === undefined ||
		!hasOwnDescriptor(actorNameField, "value") ||
		!actorNameField.enumerable ||
		!name(actorNameField.value) ||
		authorizeField === undefined ||
		!hasOwnDescriptor(authorizeField, "value") ||
		!authorizeField.enumerable ||
		typeof authorizeField.value !== "function" ||
		isProxy(authorizeField.value) ||
		nowField === undefined ||
		!hasOwnDescriptor(nowField, "value") ||
		!nowField.enumerable ||
		typeof nowField.value !== "function" ||
		isProxy(nowField.value) ||
		(ingressField !== undefined &&
			(!hasOwnDescriptor(ingressField, "value") ||
				!ingressField.enumerable ||
				(ingressField.value !== undefined &&
					(typeof ingressField.value !== "function" ||
						isProxy(ingressField.value)))))
	)
		throw new TypeError(
			"queue actor name, host authorization and trusted clock are required",
		);
	const actorName = actorNameField.value;
	const originalAuthorize = authorizeField.value;
	const originalNow = nowField.value;
	const originalIngress = ingressField?.value;
	const authorize: typeof options.authorize = (claim) =>
		applyHost(originalAuthorize, options, [claim]);
	const now: typeof options.now = () => applyHost(originalNow, options, []);
	const verifyIngress: typeof options.verifyIngress =
		originalIngress === undefined
			? undefined
			: (claim) => applyHost(originalIngress, options, [claim]);
	const timers = captureRivetQueueTimers();
	const database = db({
		onMigrate: async (sql) => {
			await sql.execute(
				"CREATE TABLE IF NOT EXISTS hobo_queue_messages (idempotency_key TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, available_at INTEGER NOT NULL, requested_available_at INTEGER, state TEXT NOT NULL, lease_id TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL, completed_lease_id TEXT)",
			);
			await sql.execute(
				"CREATE TABLE IF NOT EXISTS hobo_queue_clock (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL)",
			);
		},
	});
	const handleRequest = async (
		identity: NonNullable<ReturnType<typeof captureContext>>,
		request: NonNullable<ReturnType<typeof captureRequest>>,
		signal: AbortSignal,
		deadlineAt: number,
		track: RivetQueueTrack,
		markUncertain: () => void,
		bodyStarted: () => void,
		fallback: Response,
	): Promise<Response> => {
		const reply = (status: number, data: object): Response => {
			try {
				return response(status, data);
			} catch {
				markUncertain();
				return fallback;
			}
		};
		if (identity.name !== actorName) return reply(403, { error: "forbidden" });
		const action = operation(request.method, request.url);
		if (!action) return reply(404, { error: "not-found" });
		const actorKey = identity.key;
		const database = identity.database;
		const transaction = identity.transaction;
		const requestBody = request.body;
		const headers = new nativeHeaders(request.headers);
		const authorizePhase = (phase: "before" | "after") =>
			authorize({
				phase,
				actorName,
				actorKey,
				operation: action,
				headers: new nativeHeaders(headers),
			});
		try {
			if (isSignalAborted(signal) || monotonicNow() >= deadlineAt)
				return reply(503, { error: "request-timeout" });
			const decision = (
				await boundedRivetQueueDecision(
					() => authorizePhase("before"),
					signal,
					track,
					timers,
					markUncertain,
				)
			).value;
			if (isSignalAborted(signal) || monotonicNow() >= deadlineAt)
				return reply(503, { error: "request-timeout" });
			if (decision === false) {
				return reply(403, { error: "forbidden" });
			}
			if (
				decision !== true ||
				isSignalAborted(signal) ||
				monotonicNow() >= deadlineAt
			)
				throw new NativeError("invalid or late policy decision");
		} catch {
			return reply(503, { error: "policy-unavailable" });
		}
		let body: unknown;
		try {
			bodyStarted();
			const bytes = (
				await readRivetQueueStream(
					requestBody,
					MAX_BODY_BYTES,
					signal,
					verifyIngress === undefined
						? undefined
						: () =>
								verifyIngress(
									freeze({
										actorName,
										actorKey,
										operation: action,
										maxRequestBytes: MAX_BODY_BYTES,
										maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
									}),
								),
					track,
					markUncertain,
					() => !isSignalAborted(signal) && monotonicNow() < deadlineAt,
					timers,
				)
			).value;
			body = parseBody(bytes);
		} catch (error) {
			const streamCode = rivetQueueStreamErrorCode(error);
			if (streamCode !== undefined && streamCode !== "invalid") {
				const reason =
					streamCode === "unverified"
						? "ingress-unverified"
						: streamCode === "timeout"
							? "request-timeout"
							: "request-unavailable";
				return reply(503, { error: reason });
			}
			return reply(400, { error: "invalid-argument" });
		}
		if (!record(body)) return reply(400, { error: "invalid-argument" });
		if (isSignalAborted(signal) || monotonicNow() >= deadlineAt)
			return reply(503, { error: "request-timeout" });
		let current: number;
		try {
			current = now();
			observeUnexpectedPromise(current);
		} catch {
			return reply(503, { error: "clock-unavailable" });
		}
		if (!integer(current, 0, 8_640_000_000_000_000 - MAX_LEASE_MS))
			return reply(503, { error: "clock-unavailable" });
		const fields = objectKeys(body);
		const availableAt = hasOwnDescriptor(body, "availableAtMs")
			? body.availableAtMs
			: undefined;
		const allowed =
			action === "enqueue"
				? ["idempotencyKey", "body", "availableAtMs"]
				: action === "dequeue"
					? ["maxMessages", "visibilityTimeoutMs"]
					: action === "extend"
						? ["messageId", "leaseId", "visibilityTimeoutMs"]
						: ["messageId", "leaseId"];
		for (let index = 0; index < fields.length; index++) {
			let permitted = false;
			for (let candidate = 0; candidate < allowed.length; candidate++)
				if (fields[index] === allowed[candidate]) permitted = true;
			if (!permitted) return reply(400, { error: "invalid-argument" });
		}
		if (
			action === "enqueue" &&
			(!hasOwnDescriptor(body, "idempotencyKey") ||
				!name(body.idempotencyKey) ||
				!hasOwnDescriptor(body, "body") ||
				!validJson(body.body) ||
				(availableAt !== undefined &&
					!integer(availableAt, 0, 8_640_000_000_000_000)))
		)
			return reply(400, { error: "invalid-argument" });
		if (
			action === "dequeue" &&
			(!hasOwnDescriptor(body, "maxMessages") ||
				!hasOwnDescriptor(body, "visibilityTimeoutMs") ||
				!integer(body.maxMessages, 1, MAX_BATCH) ||
				!integer(body.visibilityTimeoutMs, 1, MAX_LEASE_MS))
		)
			return reply(400, { error: "invalid-argument" });
		if (
			(action === "complete" || action === "release" || action === "extend") &&
			(!hasOwnDescriptor(body, "messageId") ||
				!hasOwnDescriptor(body, "leaseId") ||
				(action === "extend" &&
					!hasOwnDescriptor(body, "visibilityTimeoutMs")) ||
				!name(body.messageId) ||
				!name(body.leaseId) ||
				(action === "extend" &&
					!integer(body.visibilityTimeoutMs, 1, MAX_LEASE_MS)))
		)
			return reply(400, { error: "invalid-argument" });
		try {
			if (isSignalAborted(signal) || monotonicNow() >= deadlineAt)
				return reply(503, { error: "request-timeout" });
			let transactionInspectable = true;
			let transactionInvocations = 0;
			let transactionResponse: Response | undefined;
			const transactionReply = (status: number, data: object) => {
				transactionResponse = reply(status, data);
				return transactionResponse;
			};
			const startTransaction = createBoundaryDeferred<void>();
			let transactionWork: unknown;
			try {
				transactionWork = applyHost(transaction, database, [
					async (tx: RawAccess) => {
						transactionInvocations++;
						if (transactionInvocations !== 1) {
							markUncertain();
							throw undefined;
						}

						await startTransaction.promise;
						if (
							transactionInvocations !== 1 ||
							isSignalAborted(signal) ||
							monotonicNow() >= deadlineAt
						)
							throw new NativeError("request expired before transaction work");
						if (typeof tx !== "object" || tx === null || isProxy(tx))
							throw new NativeError("invalid transaction");
						const executeField = descriptor(tx, "execute");
						if (
							executeField === undefined ||
							!hasOwnDescriptor(executeField, "value") ||
							typeof executeField.value !== "function" ||
							isProxy(executeField.value)
						)
							throw new NativeError("invalid transaction executor");
						const originalExecute = executeField.value;
						const execute = <
							T extends Record<string, unknown> = Record<string, unknown>,
						>(
							query: string,
							...args: unknown[]
						) => {
							const output = createBoundaryDeferred<T[]>();
							if (
								transactionInvocations !== 1 ||
								isSignalAborted(signal) ||
								monotonicNow() >= deadlineAt
							) {
								output.reject(undefined);
								return output.promise;
							}
							const parameters: unknown[] = [];
							append(parameters, query);
							for (let index = 0; index < args.length; index++)
								append(parameters, args[index]);
							let sqlWork: unknown;
							try {
								sqlWork = applyHost(originalExecute, tx, parameters);
							} catch {
								markUncertain();
								output.reject(undefined);
								return output.promise;
							}
							const pending = rivetQueueObserveNative<T[]>(
								sqlWork,
								markUncertain,
							);
							track(pending);
							observeBoundary(
								pending,
								(rows) => {
									if (
										transactionInvocations !== 1 ||
										isSignalAborted(signal) ||
										monotonicNow() >= deadlineAt ||
										isProxy(rows) ||
										!isArray(rows)
									)
										output.reject(undefined);
									else output.resolve(rows);
								},
								() => output.reject(undefined),
							);
							return output.promise;
						};
						const clock = (
							await execute<{ observed_at: number }>(
								"SELECT observed_at FROM hobo_queue_clock WHERE id=1",
							)
						).value;
						if (
							clock.length &&
							(!integer(clock[0]?.observed_at, 0, maxSafeInteger) ||
								clock[0].observed_at > current)
						)
							return transactionReply(503, { error: "clock-regressed" });
						await execute(
							"INSERT INTO hobo_queue_clock(id,observed_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at",
							current,
						);
						if (action === "enqueue") {
							const encoded = canonical(body.body);
							if (
								typedByteLength === undefined ||
								applyHost(
									typedByteLength,
									applyHost(encodeText, encoder, [encoded]),
									[],
								) > MAX_BODY_BYTES
							)
								return transactionReply(400, { error: "invalid-argument" });
							const requestedAt = availableAt ?? null;
							const previous = (
								await execute<StoredMessage>(
									"SELECT * FROM hobo_queue_messages WHERE idempotency_key=?",
									body.idempotencyKey,
								)
							).value;
							if (previous[0]) {
								if (
									!name(previous[0].message_id) ||
									typeof previous[0].body !== "string" ||
									(previous[0].requested_available_at !== null &&
										!integer(
											previous[0].requested_available_at,
											0,
											maxSafeInteger,
										))
								)
									throw new NativeError("corrupt queue record");
								if (
									previous[0].body !== encoded ||
									previous[0].requested_available_at !== requestedAt
								)
									return transactionReply(409, {
										error: "idempotency-conflict",
									});
								return transactionReply(200, {
									messageId: previous[0].message_id,
									idempotencyKey: body.idempotencyKey,
									deduped: true,
								});
							}
							const count = (
								await execute<{ n: number }>(
									"SELECT COUNT(*) AS n FROM hobo_queue_messages",
								)
							).value;
							if (
								!integer(count[0]?.n, 0, MAX_MESSAGES) ||
								count[0].n >= MAX_MESSAGES
							)
								return transactionReply(429, { error: "capacity-exhausted" });
							const id = randomUUID();
							await execute(
								"INSERT INTO hobo_queue_messages(idempotency_key,message_id,body,available_at,requested_available_at,state,attempt) VALUES(?,?,?,?,?,'pending',0)",
								body.idempotencyKey,
								id,
								encoded,
								availableAt ?? current,
								requestedAt,
							);
							return transactionReply(200, {
								messageId: id,
								idempotencyKey: body.idempotencyKey,
								deduped: false,
							});
						}
						if (action === "dequeue") {
							const rows = (
								await execute<StoredMessage>(
									"SELECT * FROM hobo_queue_messages WHERE (state='pending' AND available_at<=?) OR (state='leased' AND lease_expires_at<=?) ORDER BY available_at,message_id LIMIT ?",
									current,
									current,
									body.maxMessages,
								)
							).value;
							const leased: ReturnType<typeof message>[] = [];
							for (let index = 0; index < rows.length; index++) {
								const row = rows[index];
								if (row === undefined) throw undefined;
								if (!integer(row.attempt, 0, 4_294_967_294))
									throw new NativeError("queue delivery attempts exhausted");
								const leaseId = `${row.message_id}:${row.attempt + 1}:${randomUUID()}`;
								// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: dequeue visibility was validated before the transaction.
								const expiresAt =
									current + (body.visibilityTimeoutMs as number);
								await execute(
									"UPDATE hobo_queue_messages SET state='leased',lease_id=?,lease_expires_at=?,attempt=attempt+1 WHERE message_id=?",
									leaseId,
									expiresAt,
									row.message_id,
								);
								append(
									leased,
									message(
										{
											...row,
											lease_id: leaseId,
											lease_expires_at: expiresAt,
											attempt: row.attempt + 1,
										},
										actorName,
									),
								);
							}
							return transactionReply(200, { messages: leased });
						}
						const rows = (
							await execute<StoredMessage>(
								"SELECT * FROM hobo_queue_messages WHERE message_id=?",
								body.messageId,
							)
						).value;
						const row = rows[0];
						if (!row) return transactionReply(404, { error: "not-found" });
						if (
							action === "complete" &&
							row.state === "completed" &&
							row.completed_lease_id === body.leaseId
						)
							return transactionReply(200, {
								messageId: body.messageId,
								deduped: true,
							});
						if (
							row.state !== "leased" ||
							row.lease_id !== body.leaseId ||
							!integer(row.lease_expires_at, 0, maxSafeInteger) ||
							row.lease_expires_at <= current
						)
							return transactionReply(409, { error: "lease-lost" });
						if (action === "complete") {
							await execute(
								"UPDATE hobo_queue_messages SET state='completed',completed_lease_id=lease_id,lease_id=NULL,lease_expires_at=NULL WHERE message_id=?",
								body.messageId,
							);
							return transactionReply(200, {
								messageId: body.messageId,
								deduped: false,
							});
						}
						if (action === "release") {
							await execute(
								"UPDATE hobo_queue_messages SET state='pending',available_at=?,lease_id=NULL,lease_expires_at=NULL WHERE message_id=?",
								current,
								body.messageId,
							);
							return transactionReply(200, { messageId: body.messageId });
						}
						// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: extend visibility was validated before the transaction.
						const expiresAt = current + (body.visibilityTimeoutMs as number);
						await execute(
							"UPDATE hobo_queue_messages SET lease_expires_at=? WHERE message_id=?",
							expiresAt,
							body.messageId,
						);
						return transactionReply(200, {
							message: message(
								{ ...row, lease_expires_at: expiresAt },
								actorName,
							),
						});
					},
				]);
			} catch {
				markUncertain();
				throw undefined;
			}
			const pendingTransaction = rivetQueueObserveNative<Response>(
				transactionWork,
				() => {
					transactionInspectable = false;
					markUncertain();
				},
			);
			track(pendingTransaction);
			if (!transactionInspectable) throw undefined;
			startTransaction.resolve(undefined);
			const result = (await pendingTransaction).value;
			if (
				transactionInvocations !== 1 ||
				result !== transactionResponse ||
				!rivetProtectResponse(result)
			) {
				markUncertain();
				throw undefined;
			}
			if (isSignalAborted(signal) || monotonicNow() >= deadlineAt)
				return reply(503, { error: "request-timeout" });
			const verified = (
				await boundedRivetQueueDecision(
					() => authorizePhase("after"),
					signal,
					track,
					timers,
					markUncertain,
				)
			).value;
			if (
				verified !== true ||
				isSignalAborted(signal) ||
				monotonicNow() >= deadlineAt
			)
				return reply(503, { error: "policy-unavailable" });
			return result;
		} catch {
			return reply(503, { error: "queue-unavailable" });
		}
	};
	let active = 0;
	const handle = async (
		context: RivetQueueContext,
		request: Request,
	): Promise<Response> => {
		const identity = captureContext(context);
		if (identity === undefined) return response(403, { error: "forbidden" });
		if (active >= MAX_ACTIVE_REQUESTS)
			return response(503, { error: "capacity-exhausted" });

		const fallback = response(503, { error: "queue-unavailable" });
		const timeoutResponse = response(503, { error: "request-timeout" });
		const unavailableResponse = response(503, { error: "request-unavailable" });
		const captured = captureRequest(request);
		if (
			captured === undefined ||
			signalAborted === undefined ||
			controllerSignal === undefined ||
			typeof controllerAbort !== "function"
		)
			return response(400, { error: "invalid-argument" });
		active++;
		const controller = new NativeAbortController();
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native getter returns the controller's native signal.
		const privateSignal = applyHost(
			controllerSignal,
			controller,
			[],
		) as AbortSignal;
		const expiresAt = monotonicNow() + RIVET_QUEUE_TIMEOUT_MS;
		let pending = 0;
		let finished = false;
		let outerFinished = false;
		let released = false;
		let quarantined = false;
		let bodyOwned = true;
		let abortObserved = false;
		const deadline = createBoundaryDeferred<Response>();
		const release = () => {
			if (
				finished &&
				outerFinished &&
				pending === 0 &&
				!released &&
				!quarantined
			) {
				released = true;
				active--;
			}
		};
		const track: RivetQueueTrack = (promise) => {
			pending++;
			observeBoundary(
				promise,
				() => {
					pending--;
					release();
				},
				() => {
					pending--;
					release();
				},
			);
		};
		const abort = () => {
			abortObserved = true;
			try {
				applyHost(controllerAbort, controller, []);
				if (!isSignalAborted(privateSignal)) quarantined = true;
			} catch {
				quarantined = true;
			}
			deadline.resolve(timeoutResponse);
		};
		const cancelUnread = () => {
			if (!bodyOwned) return;
			bodyOwned = false;
			if (captured.body === null) return;
			try {
				const cancelled = rivetQueueObserveNative<void>(
					cancelRivetQueueStream(captured.body),
					() => {
						quarantined = true;
					},
				);
				observeBoundary(
					cancelled,
					() => {},
					() => {
						quarantined = true;
					},
				);
				track(cancelled);
			} catch {
				quarantined = true;
			}
		};
		const start = createBoundaryDeferred<void>();
		const work = async () => {
			await start.promise;
			try {
				let inspectable = true;
				const admitted = rivetQueueObserveNative<Response>(
					handleRequest(
						identity,
						captured,
						privateSignal,
						expiresAt,
						track,
						() => {
							quarantined = true;
						},
						() => {
							bodyOwned = false;
						},
						fallback,
					),
					() => {
						inspectable = false;
						quarantined = true;
						abort();
					},
				);
				if (!inspectable) return fallback;
				return (await admitted).value;
			} catch {
				return fallback;
			} finally {
				cancelUnread();
				finished = true;
				release();
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let launched = false;
		let listenerAdded = false;
		let outcome: Response = unavailableResponse;
		try {
			timer = applyHost(timers.schedule, undefined, [
				abort,
				RIVET_QUEUE_TIMEOUT_MS,
			]);
			if (applyHost(signalAborted, captured.signal, []) === true) abort();
			else {
				applyHost(addListener, captured.signal, [
					"abort",
					abort,
					listenerOptions,
				]);
				listenerAdded = true;
			}
			if (
				abortObserved ||
				isSignalAborted(privateSignal) ||
				monotonicNow() >= expiresAt
			) {
				abort();
				cancelUnread();
				finished = true;
				outcome = timeoutResponse;
			} else {
				let inspectable = true;
				const pendingWork = rivetQueueObserveNative<Response>(work(), () => {
					inspectable = false;
					quarantined = true;
				});
				if (!inspectable) {
					abort();
					cancelUnread();
					finished = true;
					outcome = unavailableResponse;
				} else {
					launched = true;
					start.resolve(undefined);
					outcome = (await raceBoundary(pendingWork, deadline.promise)).value;
					if (
						abortObserved ||
						isSignalAborted(privateSignal) ||
						monotonicNow() >= expiresAt
					)
						outcome = timeoutResponse;
				}
			}
		} catch {
			abort();
			if (!launched) {
				cancelUnread();
				finished = true;
			}
			outcome = unavailableResponse;
		} finally {
			try {
				if (timer !== undefined) applyHost(timers.cancel, undefined, [timer]);
				if (listenerAdded)
					applyHost(removeListener, captured.signal, ["abort", abort]);
			} catch {
				quarantined = true;
				outcome = unavailableResponse;
			}
			outerFinished = true;
			release();
		}
		return outcome;
	};

	const onRequest: RivetQueueBinding["handle"] = (context, request) => {
		const forbidden = response(403, { error: "forbidden" });
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: captured native Promise.resolve receives a protected native Response.
		const refuse = (): Promise<Response> =>
			applyHost(promiseResolve, nativePromise, [
				forbidden,
			]) as Promise<Response>;
		try {
			if (typeof context !== "object" || context === null || isProxy(context))
				return refuse();
			const fields = ["name", "key", "db"] as const;
			for (let index = 0; index < fields.length; index++) {
				const key = fields[index];
				if (key === undefined) return refuse();
				const field = descriptor(context, key);
				if (field !== undefined && !hasOwn(field, "value")) return refuse();
			}
			return handle(
				{ name: context.name, key: context.key, db: context.db },
				request,
			);
		} catch {
			return refuse();
		}
	};
	freeze(database);
	const definition = actor({ db: database, onRequest });
	freeze(definition.config.actions);
	freeze(definition.config.options);
	freeze(definition.config);
	freeze(definition);
	const binding = freeze({ actorName, actor: definition, handle });
	applyHost(weakSet, registered, [binding, { database, onRequest }]);
	return binding;
}
export function isRivetQueueBinding(binding: RivetQueueBinding): boolean {
	const captured:
		| {
				readonly database: object;
				readonly onRequest: RivetQueueBinding["handle"];
		  }
		| undefined = applyHost(weakGet, registered, [binding]);
	return (
		captured !== undefined &&
		isStaticActorDefinition(binding.actor) &&
		"db" in binding.actor.config &&
		binding.actor.config.db === captured.database &&
		binding.actor.config.onRequest === captured.onRequest
	);
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread */
