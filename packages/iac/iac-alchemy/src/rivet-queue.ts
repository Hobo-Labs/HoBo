/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread, anti-slop/no-reflect-apply -- SAFETY: host values cross provider boundaries, and Reflect.apply avoids mutable function.call properties. */
import { createHash, Hash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { DurableObject } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import type { AnyActorDefinition } from "rivetkit";
import {
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import { AlchemyIacError } from "./plan.js";
import {
	isRivetQueueBinding,
	type RivetQueueBinding,
} from "./rivet-queue-runtime.js";
import {
	boundedRivetQueueDecision,
	cancelRivetQueueStream,
	captureRivetQueueTimers,
	RIVET_QUEUE_CHUNK_BYTES,
	RIVET_QUEUE_TIMEOUT_MS,
	type RivetQueueTrack,
	readRivetQueueStream,
	rivetQueueObserveNative,
} from "./rivet-queue-stream.js";
import { inspectRivetRegistry, rivetOwnData } from "./rivet-source-boundary.js";
import { isRivetSynchronousTrue } from "./rivet-synchronous-authority.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

const applyTransport = Reflect.apply;
const freeze = Object.freeze;
const create = Object.create;
const define = Object.defineProperty;
const NativeSet = Set;
const setHas = NativeSet.prototype.has;
const setAdd = NativeSet.prototype.add;
const setDelete = NativeSet.prototype.delete;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const isFiniteNumber = Number.isFinite;
const isSafeInteger = Number.isSafeInteger;
const trim = String.prototype.trim;
const regexpTest = RegExp.prototype.test;
const controlCharacters = /[\p{Cc}]/u;
const dateParse = Date.parse;
const NativeError = Error;
const parseJson = JSON.parse;
const NativeTextDecoder = TextDecoder;
const decodeText = NativeTextDecoder.prototype.decode;
const NativeTextEncoder = TextEncoder;
const encodeText = NativeTextEncoder.prototype.encode;
const hashUpdate = Hash.prototype.update;
const hashDigest = Hash.prototype.digest;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedByteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const NativeAbortController = AbortController;
const controllerSignal = Object.getOwnPropertyDescriptor(
	NativeAbortController.prototype,
	"signal",
)?.get;
const controllerAbort = Object.getOwnPropertyDescriptor(
	NativeAbortController.prototype,
	"abort",
)?.value;
const signalAborted = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"aborted",
)?.get;
const decoderOptions: TextDecoderOptions = create(null);
decoderOptions.fatal = true;
freeze(decoderOptions);
const responsePrototype = Response.prototype;
const responseDescriptor = Object.getOwnPropertyDescriptor;
const responsePrototypeOf = Object.getPrototypeOf;
const isProxy = types.isProxy;
const hasOwnDescriptor = Object.hasOwn;
const responseStatus = responseDescriptor(responsePrototype, "status")?.get;
const responseBody = responseDescriptor(responsePrototype, "body")?.get;
const performanceNow = performance.now;
const monotonicNow = () => applyTransport(performanceNow, performance, []);
const maxOutstandingQueueCalls = 32;
const nonThenable: PropertyDescriptor = create(null);
nonThenable.value = undefined;
freeze(nonThenable);

function protectValue<T extends object>(value: T): T {
	define(value, "then", nonThenable);
	return value;
}

function append<T>(array: T[], value: T): void {
	const field: PropertyDescriptor = create(null);
	field.value = value;
	field.writable = true;
	field.enumerable = true;
	field.configurable = true;
	define(array, `${array.length}`, field);
}

function isSignalAborted(signal: AbortSignal): boolean {
	try {
		return (
			isProxy(signal) ||
			signalAborted === undefined ||
			applyTransport(signalAborted, signal, []) !== false
		);
	} catch {
		return true;
	}
}

export type {
	RivetQueueBinding,
	RivetQueueOperation,
} from "./rivet-queue-runtime.js";
export {
	createRivetQueueActor,
	isRivetQueueBinding,
} from "./rivet-queue-runtime.js";

export interface RivetAsyncQueueSource {
	readonly main: string;
	readonly resourceName: string;
	readonly bindleName: string;
	readonly sourceDigest: string;
	readonly sourceFence: AlchemySourceFence;
	readonly poolDigest: string;
	readonly isolationDigest: string;
	readonly poolHost: PoolHost["Service"];
	readonly registry: {
		readonly config: {
			readonly use: Readonly<Record<string, AnyActorDefinition>>;
		};
	};
	readonly binding: RivetQueueBinding;

	readonly verifySource: (source: {
		readonly main: string;
		readonly sourceDigest: string;
		readonly sourceFence: AlchemySourceFence;
		readonly bindleName: string;
		readonly poolDigest: string;
		readonly isolationDigest: string;
		readonly poolHost: PoolHost["Service"];
		readonly resourceName: string;
		readonly registry: RivetAsyncQueueSource["registry"];
		readonly binding: RivetQueueBinding;
	}) => boolean;
}
const applyCaptured = Reflect.apply;

interface RivetQueuePoolMethods {
	readonly deployExternal: PoolHost["Service"]["deployExternal"];
	readonly deployCrate: PoolHost["Service"]["deployCrate"];
}

interface CapturedRivetQueueSource {
	readonly source: RivetAsyncQueueSource;
	readonly pool: RivetQueuePoolMethods;
}

function captureRivetQueuePoolMethods(
	host: unknown,
): RivetQueuePoolMethods | undefined {
	try {
		if (typeof host !== "object" || host === null || isProxy(host))
			return undefined;
		const external = responseDescriptor(host, "deployExternal");
		const crate = responseDescriptor(host, "deployCrate");
		if (
			!external ||
			!hasOwnDescriptor(external, "value") ||
			typeof external.value !== "function" ||
			isProxy(external.value) ||
			!crate ||
			!hasOwnDescriptor(crate, "value") ||
			typeof crate.value !== "function" ||
			isProxy(crate.value)
		)
			return undefined;
		return freeze({ deployExternal: external.value, deployCrate: crate.value });
	} catch {
		return undefined;
	}
}

function sameRivetQueuePoolMethods(
	expected: RivetQueuePoolMethods,
	actual: RivetQueuePoolMethods | undefined,
): boolean {
	return (
		actual !== undefined &&
		actual.deployExternal === expected.deployExternal &&
		actual.deployCrate === expected.deployCrate
	);
}

function matchesRivetQueueSource(
	source: RivetAsyncQueueSource,
	pool: RivetQueuePoolMethods,
): boolean {
	if (
		!sameRivetQueuePoolMethods(
			pool,
			captureRivetQueuePoolMethods(source.poolHost),
		) ||
		!isRivetQueueBinding(source.binding) ||
		source.binding.actorName !== source.resourceName
	)
		return false;
	const actors = inspectRivetRegistry(source.registry);
	return (
		actors?.names.length === 1 &&
		actors.actor(source.resourceName) === source.binding.actor
	);
}

function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		applyTransport(trim, value, []) === value &&
		!applyTransport(regexpTest, controlCharacters, [value])
	);
}
function captureRivetAsyncQueueSource(
	input: RivetAsyncQueueSource,
): CapturedRivetQueueSource {
	const main = rivetOwnData<string>(input, "main");
	const resourceName = rivetOwnData<string>(input, "resourceName");
	const bindleName = rivetOwnData<string>(input, "bindleName");
	const sourceDigest = rivetOwnData<string>(input, "sourceDigest");
	const sourceFence = rivetOwnData<AlchemySourceFence>(input, "sourceFence");
	const poolDigest = rivetOwnData<string>(input, "poolDigest");
	const isolationDigest = rivetOwnData<string>(input, "isolationDigest");
	const poolHost = rivetOwnData<PoolHost["Service"]>(input, "poolHost");
	const registry = rivetOwnData<RivetAsyncQueueSource["registry"]>(
		input,
		"registry",
	);
	const binding = rivetOwnData<RivetQueueBinding>(input, "binding");
	const verifySource = rivetOwnData<RivetAsyncQueueSource["verifySource"]>(
		input,
		"verifySource",
	);
	if (
		typeof main !== "string" ||
		typeof resourceName !== "string" ||
		typeof bindleName !== "string" ||
		typeof sourceDigest !== "string" ||
		typeof poolDigest !== "string" ||
		typeof isolationDigest !== "string" ||
		poolHost === undefined ||
		registry === undefined ||
		binding === undefined ||
		typeof verifySource !== "function" ||
		isProxy(verifySource) ||
		isProxy(sourceFence) ||
		isProxy(poolHost)
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"source and pool fields must be bounded own data",
		);
	const verifyFence = rivetOwnData<AlchemySourceFence["verify"]>(
		sourceFence,
		"verify",
	);
	const fence =
		typeof verifyFence === "function" && !isProxy(verifyFence)
			? captureAlchemySourceFence(sourceFence)
			: undefined;
	if (!fence || fence.sourceDigest !== sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the queue requires a host-verified immutable source and artifact fence`,
		);
	const source = freeze({
		main,
		resourceName,
		bindleName,
		sourceDigest,
		sourceFence: fence,
		poolDigest,
		isolationDigest,
		poolHost,
		registry,
		binding,
		verifySource,
	});
	if (
		!isAbsolute(source.main) ||
		source.main.length > 4096 ||
		/[\p{Cc}]/u.test(source.main) ||
		!name(source.resourceName) ||
		!name(source.bindleName) ||
		typeof source.sourceDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.sourceDigest) ||
		typeof source.poolDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.poolDigest) ||
		typeof source.isolationDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(source.isolationDigest) ||
		typeof source.poolHost !== "object" ||
		source.poolHost === null ||
		typeof source.verifySource !== "function"
	)
		throw new AlchemyIacError(
			"RIVET_SOURCE_INVALID",
			"a bounded source, resource identity and host attestation are required",
		);
	const pool = captureRivetQueuePoolMethods(source.poolHost);
	if (!pool)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"the exclusive pool requires stable host deployment functions",
		);
	const matches = () => matchesRivetQueueSource(source, pool);
	if (!matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			`the standalone registry must contain exactly the named queue actor`,
		);
	let verified = false;
	try {
		verified = isRivetSynchronousTrue(source.verifySource(source));
	} catch {
		verified = false;
	}
	if (!verified || !matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			`the host did not verify the exact queue source and exclusive pool`,
		);
	return { source, pool };
}

export function bindRivetAsyncQueueSource(
	input: RivetAsyncQueueSource,
): RivetAsyncQueueSource {
	return captureRivetAsyncQueueSource(input).source;
}

export function rivetAsyncQueueResource(input: RivetAsyncQueueSource) {
	const { source, pool } = captureRivetAsyncQueueSource(input);
	const host = source.poolHost;
	const { deployExternal, deployCrate } = pool;
	const claim: AlchemySourceClaim = freeze({
		resourceId: source.resourceName,
		resourceType: "Rivet.DurableObject",
		bindleName: source.bindleName,
		applicationName: source.resourceName,
		sourceKind: "rivet-async-queue",
		sourcePath: resolve(source.main),
		sourceDigest: source.sourceDigest,
		environmentDigest: source.sourceFence.environmentDigest,
		proofRef: source.sourceFence.proofRef,
	});
	const verify = (candidate: AlchemySourceClaim): boolean => {
		try {
			if (
				candidate.resourceId !== claim.resourceId ||
				candidate.resourceType !== claim.resourceType ||
				candidate.bindleName !== claim.bindleName ||
				candidate.applicationName !== claim.applicationName ||
				candidate.sourceKind !== claim.sourceKind ||
				candidate.sourcePath !== claim.sourcePath ||
				candidate.sourceDigest !== claim.sourceDigest ||
				candidate.environmentDigest !== claim.environmentDigest ||
				candidate.proofRef !== claim.proofRef
			)
				return false;
			const checked = captureRivetAsyncQueueSource(source);
			if (!sameRivetQueuePoolMethods(pool, checked.pool)) return false;
			return (
				verifyAlchemySourceFence(source.sourceFence, candidate) &&
				matchesRivetQueueSource(source, pool)
			);
		} catch {
			return false;
		}
	};
	const check = () => {
		if (!verify(claim))
			throw new AlchemyIacError(
				"RIVET_SOURCE_UNVERIFIED",
				"the queue source, artifact and exclusive pool fence could not be verified",
			);
	};
	return Effect.gen(function* () {
		check();
		let registered: object | undefined;
		const protectedHost: PoolHost["Service"] = {
			deployExternal: ({ id, main, resource }) =>
				Effect.gen(function* () {
					if (
						registered !== undefined ||
						id !== claim.resourceId ||
						main !== claim.sourcePath ||
						resource.FQN !== claim.resourceId ||
						resource.Type !== claim.resourceType
					)
						throw new AlchemyIacError(
							"RIVET_SOURCE_MISMATCH",
							"the pool deployment differs from the queue source claim",
						);
					check();
					registerAlchemySource(resource, { claim, verify });
					registered = resource;
					yield* applyCaptured(deployExternal, host, [
						freeze({ id, main, resource }),
					]);
					check();
				}),
			deployCrate: (object) => applyCaptured(deployCrate, host, [object]),
		};
		const primary = yield* DurableObject(source.resourceName, {
			main: source.main,
		}).pipe(Effect.provideService(PoolHost, protectedHost));
		if (
			primary.FQN !== claim.resourceId ||
			primary.Type !== claim.resourceType ||
			(registered !== undefined && registered !== primary)
		)
			throw new AlchemyIacError(
				"RIVET_SOURCE_MISMATCH",
				"the queue resource differs from its source claim",
			);
		if (registered === undefined)
			registerAlchemySource(primary, { claim, verify });
		check();
		return primary;
	});
}

type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { readonly [key: string]: Json };
export interface RivetAsyncQueueMessage {
	readonly messageId: string;
	readonly queueName: string;
	readonly idempotencyKey: string;
	readonly body: Json;
	readonly leaseId: string;
	readonly leaseExpiresAt: string;
	readonly deliveryAttempt: number;
}
export interface RivetAsyncQueueTransport {
	readonly scope: {
		readonly tenantId: string;
		readonly instanceId: string;
		readonly actorName: string;
		readonly actorKey: readonly string[];
	};

	fetch(path: string, init: RequestInit): Promise<Response>;

	verifyDispatch(
		input: {
			readonly scope: RivetAsyncQueueTransport["scope"];
			readonly operation: string;
			readonly requestBody: string;
			readonly maxAttempts: 1;
			readonly fetch: RivetAsyncQueueTransport["fetch"];
			readonly receiver: RivetAsyncQueueTransport;
		} & (
			| { readonly phase: "before" }
			| {
					readonly phase: "after";
					readonly responseStatus: number;
					readonly responseDigest: string;
			  }
		),
	): boolean | Promise<boolean>;

	verifyResponseBounds?(input: {
		readonly scope: RivetAsyncQueueTransport["scope"];
		readonly operation: string;
		readonly maxResponseBytes: number;
		readonly maxChunkBytes: number;
	}): boolean | Promise<boolean>;
}
function object(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!isProxy(value) &&
		!arrayIsArray(value)
	);
}
const invalidJson = Symbol("invalid-json");
const encodePrimitive = JSON.stringify;
const arrayIsArray = Array.isArray;
const objectKeys = Object.keys;

function snapshotJson(value: unknown): Json | typeof invalidJson {
	const ancestors = new NativeSet<object>();
	let nodes = 10_000;
	let characters = 65_536;
	const copy = (current: unknown, depth: number): Json | typeof invalidJson => {
		if (--nodes < 0 || depth > 64) return invalidJson;
		if (current === null || typeof current === "boolean") return current;
		if (typeof current === "number")
			return isFiniteNumber(current) ? current : invalidJson;
		if (typeof current === "string") {
			characters -= current.length;
			return characters >= 0 ? current : invalidJson;
		}
		if (
			typeof current !== "object" ||
			isProxy(current) ||
			applyTransport(setHas, ancestors, [current])
		)
			return invalidJson;
		const array = arrayIsArray(current);
		const prototype = getPrototype(current);
		if (
			(array && prototype !== arrayPrototype) ||
			(!array && prototype !== objectPrototype && prototype !== null)
		)
			return invalidJson;
		const keys = ownKeys(current);
		if (keys.length > 10_001) return invalidJson;
		for (let index = 0; index < keys.length; index++)
			if (typeof keys[index] !== "string") return invalidJson;
		applyTransport(setAdd, ancestors, [current]);
		try {
			if (array) {
				const lengthField = responseDescriptor(current, "length");
				const length =
					lengthField && hasOwnDescriptor(lengthField, "value")
						? lengthField.value
						: undefined;
				if (
					!isSafeInteger(length) ||
					length < 0 ||
					length > 10_000 ||
					keys.length !== length + 1
				)
					return invalidJson;
				const result: Json[] = [];
				for (let index = 0; index < length; index++) {
					const item = responseDescriptor(current, `${index}`);
					if (
						item === undefined ||
						!hasOwnDescriptor(item, "value") ||
						!item.enumerable
					)
						return invalidJson;
					const captured = copy(item.value, depth + 1);
					if (captured === invalidJson) return invalidJson;
					append(result, captured);
				}
				return result;
			}
			const result: Record<string, Json> = create(null);
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				if (typeof key !== "string") return invalidJson;
				characters -= key.length;
				if (characters < 0) return invalidJson;
				const item = responseDescriptor(current, key);
				if (
					item === undefined ||
					!hasOwnDescriptor(item, "value") ||
					!item.enumerable
				)
					return invalidJson;
				const captured = copy(item.value, depth + 1);
				if (captured === invalidJson) return invalidJson;
				const field: PropertyDescriptor = create(null);
				field.value = captured;
				field.enumerable = true;
				define(result, key, field);
			}
			return result;
		} finally {
			applyTransport(setDelete, ancestors, [current]);
		}
	};
	try {
		return copy(value, 0);
	} catch {
		return invalidJson;
	}
}

function encodeSnapshot(value: Json): string {
	if (value === null || typeof value !== "object")
		return encodePrimitive(value);
	if (arrayIsArray(value)) {
		let result = "[";
		for (let index = 0; index < value.length; index++) {
			if (index !== 0) result += ",";
			const item = value[index];
			if (item === undefined) throw new NativeError("invalid snapshot");
			result += encodeSnapshot(item);
		}
		return `${result}]`;
	}
	let result = "{";
	const keys = objectKeys(value);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key === undefined) throw new NativeError("invalid snapshot");
		const item = value[key];
		if (item === undefined) throw new NativeError("invalid snapshot");
		if (index !== 0) result += ",";
		result += `${encodePrimitive(key)}:${encodeSnapshot(item)}`;
	}
	return `${result}}`;
}

export class RivetAsyncQueueError extends Error {
	constructor(
		readonly code:
			| "invalid-argument"
			| "forbidden"
			| "not-found"
			| "lease-lost"
			| "idempotency-conflict"
			| "capacity-exhausted"
			| "outcome-unknown",
		readonly operation: string,
	) {
		super(`queue ${operation}: ${code}`);
		const field: PropertyDescriptor = create(null);
		field.value = "RivetAsyncQueueError";
		field.writable = true;
		field.configurable = true;
		define(this, "name", field);
	}
}
async function decode(
	body: ReadableStream<Uint8Array> | null,
	signal: AbortSignal,
	verifyBounds: (() => boolean | Promise<boolean>) | undefined,
	trackPending: RivetQueueTrack,
	markUncertain: () => void,
	withinDeadline: () => boolean,
	timers: ReturnType<typeof captureRivetQueueTimers>,
) {
	const bytes = (
		await readRivetQueueStream(
			body,
			8_388_608,
			signal,
			verifyBounds,
			trackPending,
			markUncertain,
			withinDeadline,
			timers,
		)
	).value;
	const hash = createHash("sha256");
	applyTransport(hashUpdate, hash, [bytes]);
	const result: { value: unknown; digest: string } = create(null);
	result.value = applyTransport(parseJson, undefined, [
		applyTransport(decodeText, new NativeTextDecoder("utf-8", decoderOptions), [
			bytes,
		]),
	]);
	result.digest = `sha256:${applyTransport(hashDigest, hash, ["hex"])}`;
	return freeze(result);
}

function captureResponse(value: unknown) {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		responsePrototypeOf(value) !== responsePrototype ||
		responseDescriptor(value, "status") !== undefined ||
		responseDescriptor(value, "ok") !== undefined ||
		responseDescriptor(value, "body") !== undefined ||
		responseStatus === undefined ||
		responseBody === undefined
	)
		throw new NativeError("invalid response");
	const status: unknown = applyTransport(responseStatus, value, []);
	const body: unknown = applyTransport(responseBody, value, []);
	if (
		typeof status !== "number" ||
		!isSafeInteger(status) ||
		status < 200 ||
		status > 599
	)
		throw new NativeError("invalid response status");
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native body getter supplies the platform Response body.
	return { status, body: body as ReadableStream<Uint8Array> | null };
}
function exactReceipt(
	value: unknown,
	fields: readonly string[],
): value is Record<string, unknown> {
	if (!object(value) || objectKeys(value).length !== fields.length)
		return false;
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field === undefined || !hasOwnDescriptor(value, field)) return false;
	}
	return true;
}
function readMessage(
	value: unknown,
	queueName: string,
): RivetAsyncQueueMessage {
	if (
		!exactReceipt(value, [
			"messageId",
			"queueName",
			"idempotencyKey",
			"leaseId",
			"leaseExpiresAt",
			"deliveryAttempt",
			"body",
		]) ||
		!name(value.messageId) ||
		value.queueName !== queueName ||
		!name(value.idempotencyKey) ||
		!name(value.leaseId) ||
		typeof value.leaseExpiresAt !== "string" ||
		!isFiniteNumber(
			applyTransport(dateParse, undefined, [value.leaseExpiresAt]),
		) ||
		typeof value.deliveryAttempt !== "number" ||
		!isSafeInteger(value.deliveryAttempt) ||
		value.deliveryAttempt < 1 ||
		value.deliveryAttempt > 4_294_967_295
	)
		throw new NativeError("invalid queue receipt");
	const body = snapshotJson(value.body);
	if (body === invalidJson) throw new NativeError("invalid queue receipt");
	return protectValue({
		messageId: value.messageId,
		queueName: value.queueName,
		idempotencyKey: value.idempotencyKey,
		body,
		leaseId: value.leaseId,
		leaseExpiresAt: value.leaseExpiresAt,
		deliveryAttempt: value.deliveryAttempt,
	});
}

export function createRivetAsyncQueueClient(
	transport: RivetAsyncQueueTransport,
) {
	if (
		typeof transport !== "object" ||
		transport === null ||
		isProxy(transport) ||
		Array.isArray(transport)
	)
		throw new TypeError("queue transport must be an own-data host authority");
	const fetchField = Object.getOwnPropertyDescriptor(transport, "fetch");
	const dispatchField = Object.getOwnPropertyDescriptor(
		transport,
		"verifyDispatch",
	);
	const scopeField = Object.getOwnPropertyDescriptor(transport, "scope");
	const boundsField = Object.getOwnPropertyDescriptor(
		transport,
		"verifyResponseBounds",
	);
	if (
		fetchField === undefined ||
		!hasOwnDescriptor(fetchField, "value") ||
		!fetchField.enumerable ||
		typeof fetchField.value !== "function" ||
		isProxy(fetchField.value) ||
		dispatchField === undefined ||
		!hasOwnDescriptor(dispatchField, "value") ||
		!dispatchField.enumerable ||
		typeof dispatchField.value !== "function" ||
		isProxy(dispatchField.value) ||
		scopeField === undefined ||
		!hasOwnDescriptor(scopeField, "value") ||
		!scopeField.enumerable ||
		(boundsField !== undefined &&
			(!hasOwnDescriptor(boundsField, "value") ||
				!boundsField.enumerable ||
				(boundsField.value !== undefined &&
					(typeof boundsField.value !== "function" ||
						isProxy(boundsField.value)))))
	)
		throw new TypeError("queue transport callbacks must be own data functions");
	const scopeData = snapshotJson(scopeField.value);
	if (
		scopeData === invalidJson ||
		!object(scopeData) ||
		Object.keys(scopeData).length !== 4 ||
		!name(scopeData.tenantId) ||
		!name(scopeData.instanceId) ||
		!name(scopeData.actorName) ||
		!Array.isArray(scopeData.actorKey) ||
		scopeData.actorKey.length < 1 ||
		scopeData.actorKey.length > 16 ||
		scopeData.actorKey.some((part) => !name(part))
	)
		throw new TypeError(
			"queue transport scope must identify one tenant and actor",
		);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: every actor-key element was checked as a bounded string above.
	const actorKey = Object.freeze([...scopeData.actorKey] as string[]);
	const scope = Object.freeze({
		tenantId: scopeData.tenantId,
		instanceId: scopeData.instanceId,
		actorName: scopeData.actorName,
		actorKey,
	});
	const originalFetch = fetchField.value;
	const originalDispatch = dispatchField.value;
	const originalBounds = boundsField?.value;
	const fetch: RivetAsyncQueueTransport["fetch"] = (path, init) =>
		applyTransport(originalFetch, transport, [path, init]);
	const verifyDispatch: RivetAsyncQueueTransport["verifyDispatch"] = (claim) =>
		applyTransport(originalDispatch, transport, [claim]);
	const verifyResponseBounds: RivetAsyncQueueTransport["verifyResponseBounds"] =
		originalBounds === undefined
			? undefined
			: (claim) => applyTransport(originalBounds, transport, [claim]);
	const timers = captureRivetQueueTimers();
	let outstanding = 0;
	async function invoke(
		path: string,
		body: object,
	): Promise<Record<string, unknown>> {
		let payload: string;
		try {
			const snapshot = snapshotJson(body);
			if (snapshot === invalidJson) throw new NativeError("invalid request");
			payload = encodeSnapshot(snapshot);
		} catch {
			throw new RivetAsyncQueueError("invalid-argument", path);
		}
		if (
			typedByteLength === undefined ||
			applyTransport(
				typedByteLength,
				applyTransport(encodeText, new NativeTextEncoder(), [payload]),
				[],
			) > 65_536
		)
			throw new RivetAsyncQueueError("invalid-argument", path);
		if (outstanding >= maxOutstandingQueueCalls)
			throw new RivetAsyncQueueError("capacity-exhausted", path);
		let status: number;
		let data: unknown;
		if (controllerSignal === undefined || typeof controllerAbort !== "function")
			throw new RivetAsyncQueueError("outcome-unknown", path);
		const controller = new NativeAbortController();
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native getter returns this controller's signal.
		const signal = applyTransport(
			controllerSignal,
			controller,
			[],
		) as AbortSignal;
		const expiresAt = monotonicNow() + RIVET_QUEUE_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending = 0;
		let finished = false;
		let outerFinished = false;
		let released = false;
		let quarantined = false;
		let abortObserved = false;
		let workStarted = false;
		const release = () => {
			if (
				finished &&
				outerFinished &&
				pending === 0 &&
				!released &&
				!quarantined
			) {
				released = true;
				outstanding--;
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
		const current = () =>
			!abortObserved && !isSignalAborted(signal) && monotonicNow() < expiresAt;
		const abort = () => {
			abortObserved = true;
			try {
				applyTransport(controllerAbort, controller, []);
				if (!isSignalAborted(signal) && workStarted) quarantined = true;
			} catch {
				if (workStarted) quarantined = true;
			}
		};
		const start = createBoundaryDeferred<void>();
		const deadline = createBoundaryDeferred<never>();
		observeBoundary(
			deadline.promise,
			() => {},
			() => {},
		);
		try {
			const work = async () => {
				await start.promise;
				try {
					const claim = freeze({
						scope,
						operation: path,
						requestBody: payload,
						maxAttempts: 1 as const,
						fetch: originalFetch,
						receiver: transport,
					});
					const verified = (
						await boundedRivetQueueDecision(
							() => {
								if (!current()) throw undefined;
								return verifyDispatch(
									freeze({ ...claim, phase: "before" as const }),
								);
							},
							signal,
							track,
							timers,
							() => {
								quarantined = true;
							},
						)
					).value;
					if (verified !== true || !current()) throw undefined;

					const headers: Record<string, string> = create(null);
					headers["content-type"] = "application/json";
					freeze(headers);
					const init: RequestInit = create(null);
					init.method = "POST";
					init.redirect = "error";
					init.headers = headers;
					init.body = payload;
					init.signal = signal;
					freeze(init);
					let inspectable = true;
					let fetching: unknown;
					try {
						fetching = fetch(path, init);
					} catch {
						quarantined = true;
						throw undefined;
					}
					const pendingFetch = rivetQueueObserveNative<Response>(
						fetching,
						() => {
							inspectable = false;
							quarantined = true;
						},
					);
					track(pendingFetch);
					if (!inspectable) throw undefined;
					const fetched = (await pendingFetch).value;
					let captured: ReturnType<typeof captureResponse>;
					try {
						captured = captureResponse(fetched);
					} catch {
						quarantined = true;
						throw undefined;
					}
					if (!current()) {
						if (captured.body !== null) {
							try {
								const cancellation = rivetQueueObserveNative<void>(
									cancelRivetQueueStream(captured.body),
									() => {
										quarantined = true;
									},
								);
								observeBoundary(
									cancellation,
									() => {},
									() => {
										quarantined = true;
									},
								);
								track(cancellation);
								await cancellation;
							} catch {
								quarantined = true;
							}
						}
						throw undefined;
					}
					const verifyBounds =
						verifyResponseBounds === undefined
							? undefined
							: () =>
									verifyResponseBounds(
										freeze({
											scope,
											operation: path,
											maxResponseBytes: 8_388_608,
											maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
										}),
									);
					let readable = true;
					const pendingDecode = rivetQueueObserveNative<
						Awaited<ReturnType<typeof decode>>
					>(
						decode(
							captured.body,
							signal,
							verifyBounds,
							track,
							() => {
								quarantined = true;
							},
							current,
							timers,
						),
						() => {
							readable = false;
							quarantined = true;
						},
					);
					track(pendingDecode);
					if (!readable) throw undefined;
					const decoded = (await pendingDecode).value;
					if (!current()) throw undefined;
					const stillVerified = (
						await boundedRivetQueueDecision(
							() => {
								if (!current()) throw undefined;
								return verifyDispatch(
									freeze({
										...claim,
										phase: "after" as const,
										responseStatus: captured.status,
										responseDigest: decoded.digest,
									}),
								);
							},
							signal,
							track,
							timers,
							() => {
								quarantined = true;
							},
						)
					).value;
					if (stillVerified !== true || !current()) throw undefined;
					const result: { status: number; value: unknown } = create(null);
					result.status = captured.status;
					result.value = decoded.value;
					return freeze(result);
				} finally {
					finished = true;
					release();
				}
			};
			timer = applyTransport(timers.schedule, undefined, [
				() => {
					abort();
					deadline.reject(undefined);
				},
				RIVET_QUEUE_TIMEOUT_MS,
			]);
			if (!current()) throw undefined;
			outstanding++;
			let inspectable = true;
			const pendingWork = rivetQueueObserveNative<
				Awaited<ReturnType<typeof work>>
			>(work(), () => {
				inspectable = false;
				quarantined = true;
			});
			if (!inspectable) {
				finished = true;
				throw undefined;
			}
			workStarted = true;
			start.resolve(undefined);
			const completed = (await raceBoundary(pendingWork, deadline.promise))
				.value;
			if (!current()) throw undefined;
			status = completed.status;
			data = completed.value;
		} catch {
			abort();
			throw new RivetAsyncQueueError("outcome-unknown", path);
		} finally {
			if (timer !== undefined) {
				try {
					applyTransport(timers.cancel, undefined, [timer]);
				} catch {
					if (workStarted) quarantined = true;
				}
			}
			outerFinished = true;
			release();
		}
		if (status < 200 || status >= 300) {
			if (exactReceipt(data, ["error"])) {
				if (status === 400 && data.error === "invalid-argument")
					throw new RivetAsyncQueueError("invalid-argument", path);
				if (status === 403 && data.error === "forbidden")
					throw new RivetAsyncQueueError("forbidden", path);
				if (status === 404 && data.error === "not-found")
					throw new RivetAsyncQueueError("not-found", path);
				if (status === 409 && data.error === "idempotency-conflict")
					throw new RivetAsyncQueueError("idempotency-conflict", path);
				if (status === 409 && data.error === "lease-lost")
					throw new RivetAsyncQueueError("lease-lost", path);
				if (status === 429 && data.error === "capacity-exhausted")
					throw new RivetAsyncQueueError("capacity-exhausted", path);
			}
			throw new RivetAsyncQueueError("outcome-unknown", path);
		}
		const fields =
			path === "/enqueue"
				? ["messageId", "idempotencyKey", "deduped"]
				: path === "/dequeue"
					? ["messages"]
					: path === "/complete"
						? ["messageId", "deduped"]
						: path === "/release"
							? ["messageId"]
							: path === "/extend"
								? ["message"]
								: undefined;
		if (status !== 200 || fields === undefined || !exactReceipt(data, fields))
			throw new RivetAsyncQueueError("outcome-unknown", path);
		return protectValue(data);
	}
	return freeze({
		async enqueue(idempotencyKey: string, body: Json, availableAtMs?: number) {
			if (!name(idempotencyKey))
				throw new RivetAsyncQueueError("invalid-argument", "/enqueue");
			const capturedBody = snapshotJson(body);
			if (capturedBody === invalidJson)
				throw new RivetAsyncQueueError("invalid-argument", "/enqueue");
			const data = await invoke("/enqueue", {
				idempotencyKey,
				body: capturedBody,
				...(availableAtMs === undefined ? {} : { availableAtMs }),
			});
			if (
				!hasOwnDescriptor(data, "messageId") ||
				!hasOwnDescriptor(data, "idempotencyKey") ||
				!hasOwnDescriptor(data, "deduped") ||
				!name(data.messageId) ||
				data.idempotencyKey !== idempotencyKey ||
				typeof data.deduped !== "boolean"
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/enqueue");
			return protectValue({
				messageId: data.messageId,
				idempotencyKey,
				deduped: data.deduped,
			});
		},
		async dequeue(maxMessages: number, visibilityTimeoutMs: number) {
			const data = await invoke("/dequeue", {
				maxMessages,
				visibilityTimeoutMs,
			});
			if (
				!hasOwnDescriptor(data, "messages") ||
				!arrayIsArray(data.messages) ||
				data.messages.length > maxMessages ||
				data.messages.length > 100
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/dequeue");
			const messages: RivetAsyncQueueMessage[] = [];
			const seen = new NativeSet<string>();
			try {
				for (let index = 0; index < data.messages.length; index++) {
					const message = readMessage(data.messages[index], scope.actorName);
					if (applyTransport(setHas, seen, [message.messageId]))
						throw undefined;
					applyTransport(setAdd, seen, [message.messageId]);
					append(messages, message);
				}
			} catch {
				throw new RivetAsyncQueueError("outcome-unknown", "/dequeue");
			}
			return protectValue(messages);
		},
		async complete(messageId: string, leaseId: string) {
			const data = await invoke("/complete", { messageId, leaseId });
			if (
				!hasOwnDescriptor(data, "messageId") ||
				!hasOwnDescriptor(data, "deduped") ||
				data.messageId !== messageId ||
				typeof data.deduped !== "boolean"
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/complete");
			return protectValue({ messageId, deduped: data.deduped });
		},
		async release(messageId: string, leaseId: string) {
			const data = await invoke("/release", { messageId, leaseId });
			if (!hasOwnDescriptor(data, "messageId") || data.messageId !== messageId)
				throw new RivetAsyncQueueError("outcome-unknown", "/release");
			return protectValue({ messageId });
		},
		async extend(
			messageId: string,
			leaseId: string,
			visibilityTimeoutMs: number,
		) {
			const data = await invoke("/extend", {
				messageId,
				leaseId,
				visibilityTimeoutMs,
			});
			let receipt: RivetAsyncQueueMessage;
			try {
				if (!hasOwnDescriptor(data, "message"))
					throw new NativeError("missing message");
				receipt = readMessage(data.message, scope.actorName);
			} catch {
				throw new RivetAsyncQueueError("outcome-unknown", "/extend");
			}
			if (receipt.messageId !== messageId || receipt.leaseId !== leaseId)
				throw new RivetAsyncQueueError("outcome-unknown", "/extend");
			return receipt;
		},
	});
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread */
