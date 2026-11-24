/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread -- SAFETY: transport, authority and provider responses cross checked boundaries and absent optional fields are intentionally omitted. */
import { createHash, Hash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { AlchemyIacError } from "./plan.js";
import {
	boundedRivetKvDecision,
	RIVET_KV_NONTHENABLE,
	type RivetKvBox,
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
	kvValue,
	RIVET_ASYNC_KV_LIMITS,
	type RivetAsyncKvOperation,
} from "./rivet-kv-protocol.js";
import {
	isRivetAsyncKvBinding,
	type RivetAsyncKvBinding,
} from "./rivet-kv-runtime.js";
import { RIVET_QUEUE_CHUNK_BYTES } from "./rivet-queue-stream.js";
import { rivetOwnData } from "./rivet-source-boundary.js";
import {
	bindRivetStandaloneSource,
	type RivetStandaloneSource,
	rivetStandaloneResource,
} from "./rivet-standalone.js";
import {
	type AlchemySourceFence,
	captureAlchemySourceFence,
} from "./source-fence.js";

export type { RivetAsyncKvOperation } from "./rivet-kv-protocol.js";
export {
	RIVET_ASYNC_KV_CAPABILITIES,
	RIVET_ASYNC_KV_LIMITS,
} from "./rivet-kv-protocol.js";
export type {
	RivetAsyncKvAuthorization,
	RivetAsyncKvBinding,
	RivetAsyncKvContext,
	RivetAsyncKvOptions,
} from "./rivet-kv-runtime.js";
export {
	createRivetAsyncKvActor,
	isRivetAsyncKvBinding,
} from "./rivet-kv-runtime.js";

export type RivetAsyncKvSource = RivetStandaloneSource<RivetAsyncKvBinding>;

export function bindRivetAsyncKvSource(
	input: RivetAsyncKvSource,
): RivetAsyncKvSource {
	const inputFence = rivetOwnData<AlchemySourceFence>(input, "sourceFence");
	const verifyFence = rivetOwnData<AlchemySourceFence["verify"]>(
		inputFence,
		"verify",
	);
	const sourceFence =
		isProxy(inputFence) ||
		typeof verifyFence !== "function" ||
		isProxy(verifyFence)
			? undefined
			: captureAlchemySourceFence(inputFence);
	if (!sourceFence)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the key-value actor requires an immutable source and artifact fence",
		);
	return bindRivetStandaloneSource(
		input,
		(binding) =>
			isRivetAsyncKvBinding(binding) &&
			binding.semanticDigest === sourceFence.environmentDigest,
		"key-value actor",
	);
}

export function rivetAsyncKvResource(input: RivetAsyncKvSource) {
	const source = bindRivetAsyncKvSource(input);
	return rivetStandaloneResource(
		source,
		(binding) =>
			isRivetAsyncKvBinding(binding) &&
			binding.semanticDigest === source.sourceFence.environmentDigest,
		"key-value actor",
		"rivet-async-kv",
	);
}

export type RivetAsyncKvResult<T> =
	| { readonly status: "ok"; readonly value: T }
	| {
			readonly status: "denied";
			readonly code:
				| "invalid-argument"
				| "forbidden"
				| "capacity-exhausted"
				| "unavailable";
	  }
	| {
			readonly status: "unknown";
			readonly code: "outcome-unknown";
			readonly operation: Readonly<{
				readonly requestId: string;
				readonly fingerprint: string;
			}>;
	  };

export type RivetAsyncKvTransportClaim = Readonly<{
	readonly actorName: string;
	readonly actorId: string;
	readonly actorKey: readonly string[];
	readonly singleDispatch: true;
	readonly semanticDigest: string;
	readonly operation: RivetAsyncKvOperation;
	readonly requestId: string;
	readonly fingerprint: string;
	readonly fetch: RivetAsyncKvTransport["fetch"];
	readonly receiver: RivetAsyncKvTransport;
	readonly request: Readonly<{
		readonly method: "POST";
		readonly path: string;
		readonly redirect: "error";
		readonly byteLength: number;
		readonly sha256: string;
	}>;
	readonly maxResponseBytes: number;
	readonly maxChunkBytes: number;
}> &
	(
		| { readonly phase: "dispatch" }
		| {
				readonly phase: "receipt";
				readonly response: Readonly<{
					readonly status: number;
					readonly byteLength: number;
					readonly sha256: string;
				}>;
		  }
	);

export interface RivetAsyncKvTransport {
	readonly actorName: string;

	readonly actorId: string;
	readonly actorKey: readonly string[];
	readonly semanticDigest: string;

	readonly fetch: (path: string, init: RequestInit) => Promise<Response>;

	readonly verifyTransport: (
		claim: RivetAsyncKvTransportClaim,
	) => boolean | Promise<boolean>;
}

const NativeError = Error;
const NativeTypeError = TypeError;
const freeze = Object.freeze;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const objectKeys = Object.keys;
const setPrototype = Object.setPrototypeOf;
const stringify = JSON.stringify;
const parse = JSON.parse;
const isArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const NativeBuffer = Buffer;
const bufferFrom = NativeBuffer.from;
const bufferToString = NativeBuffer.prototype.toString;
const bufferByteLength = NativeBuffer.byteLength;
const hashUpdate = Hash.prototype.update;
const hashDigest = Hash.prototype.digest;
const NativeTextDecoder = TextDecoder;
const decodeText = NativeTextDecoder.prototype.decode;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = getOwnDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const statusGetter = getOwnDescriptor(Response.prototype, "status")?.get;
const bodyGetter = getOwnDescriptor(Response.prototype, "body")?.get;
const NativeAbortController = AbortController;
const controllerSignal = getOwnDescriptor(
	NativeAbortController.prototype,
	"signal",
)?.get;
const controllerAbort = getOwnDescriptor(
	NativeAbortController.prototype,
	"abort",
)?.value;
const signalAborted = getOwnDescriptor(AbortSignal.prototype, "aborted")?.get;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !isArray(value);
}
function fields(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	if (objectKeys(value).length !== keys.length) return false;
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key === undefined || !hasOwn(value, key)) return false;
	}
	return true;
}

function digestBytes(value: string | Uint8Array): string {
	const hash = createHash("sha256");
	apply(hashUpdate, hash, [value]);
	return `sha256:${apply(hashDigest, hash, ["hex"])}`;
}
function outcome<T extends object>(value: T): T {
	setPrototype(value, null);
	return value;
}
const unavailable = (): RivetAsyncKvResult<never> =>
	outcome({
		status: "denied",
		code: "unavailable",
	});
const invalid = (): RivetAsyncKvResult<never> =>
	outcome({
		status: "denied",
		code: "invalid-argument",
	});

export function createRivetAsyncKvClient(transport: RivetAsyncKvTransport) {
	if (typeof transport !== "object" || transport === null || isProxy(transport))
		throw new NativeTypeError("a trusted transport is required");
	const own = (key: string): unknown => {
		const descriptor = getOwnDescriptor(transport, key);
		return descriptor !== undefined && hasOwn(descriptor, "value")
			? descriptor.value
			: undefined;
	};
	const actorName = own("actorName");
	const actorId = own("actorId");
	const keySnapshot = kvActorKey(own("actorKey"));
	const semanticDigest = own("semanticDigest");
	const fetchValue = own("fetch");
	const verifierValue = own("verifyTransport");
	if (
		!kvActorName(actorName) ||
		!kvActorName(actorId) ||
		keySnapshot === undefined ||
		!kvDigest(semanticDigest) ||
		typeof fetchValue !== "function" ||
		isProxy(fetchValue) ||
		typeof verifierValue !== "function" ||
		isProxy(verifierValue)
	)
		throw new NativeTypeError(
			"a bounded actor identity and trusted transport authorities are required",
		);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the checks above establish the named host-owned callback capabilities.
	const fetch = fetchValue as RivetAsyncKvTransport["fetch"];
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the verifier was captured from an own data field and checked callable.
	const verifyTransport =
		verifierValue as RivetAsyncKvTransport["verifyTransport"];
	const stableActorName = actorName;
	const stableActorId = actorId;
	const stableActorKey = keySnapshot;
	const stableSemanticDigest = semanticDigest;
	const receiver: RivetAsyncKvTransport = freeze({
		actorName,
		actorId,
		actorKey: keySnapshot,
		semanticDigest,
		fetch,
		verifyTransport,
	});
	let active = 0;
	let pendingAuthority = 0;
	const decide = async (
		callback: () => boolean | Promise<boolean>,
		signal: AbortSignal,
		deadline: ReturnType<typeof rivetKvDeadline>,
	): Promise<boolean> => {
		if (pendingAuthority >= 64 || deadline.expired()) return false;
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
			return !deadline.expired() && result === true;
		} catch {
			return false;
		} finally {
			if (!tracked) pendingAuthority--;
		}
	};
	async function invokeChecked(
		operation: RivetAsyncKvOperation,
		key: string,
		value?: Uint8Array,
	): Promise<RivetAsyncKvResult<Uint8Array | boolean | undefined>> {
		if (controllerSignal === undefined || typeof controllerAbort !== "function")
			return unavailable();
		const controller = new NativeAbortController();
		const transportController = new NativeAbortController();
		const privateSignal: AbortSignal = apply(controllerSignal, controller, []);
		const transportSignal: AbortSignal = apply(
			controllerSignal,
			transportController,
			[],
		);
		const deadline = rivetKvDeadline(privateSignal);
		if (!kvKey(key)) return invalid();
		const copied = operation === "set" ? kvValue(value) : undefined;
		if (operation === "set" && copied === undefined) return invalid();
		if (active >= 128) return unavailable();
		const encodedRaw: unknown =
			copied === undefined
				? undefined
				: apply(bufferToString, apply(bufferFrom, NativeBuffer, [copied]), [
						"base64",
					]);
		if (encodedRaw !== undefined && typeof encodedRaw !== "string")
			return invalid();
		const encoded = encodedRaw;
		const requestId = randomUUID();
		const fingerprint = kvFingerprint(
			stableSemanticDigest,
			operation,
			requestId,
			key,
			encoded,
		);
		const path = `/${operation}`;
		const requestBody = {
			requestId,
			key,
			...(encoded === undefined ? {} : { value: encoded }),
		};
		setPrototype(requestBody, null);
		const body = stringify(requestBody);
		const headers = freeze(
			outcome({
				"content-type": "application/json",
				"x-hobo-kv-request-id": requestId,
				"x-hobo-kv-fingerprint": fingerprint,
				"x-hobo-kv-semantic-digest": stableSemanticDigest,
			}),
		);
		const init = freeze(
			outcome({
				method: "POST" as const,
				redirect: "error" as const,
				headers,
				body,
				signal: transportSignal,
			}),
		);
		const request = freeze({
			method: "POST" as const,
			path,
			redirect: "error" as const,
			byteLength: apply(bufferByteLength, NativeBuffer, [body]),
			sha256: digestBytes(body),
		});
		const operationRef = freeze({ requestId, fingerprint });
		let dispatched = false;
		let forcedUnknown = false;
		const failure = (): RivetAsyncKvResult<never> =>
			dispatched || forcedUnknown
				? outcome({
						status: "unknown",
						code: "outcome-unknown",
						operation: operationRef,
					})
				: unavailable();
		const claim = freeze({
			actorName: stableActorName,
			actorId: stableActorId,
			singleDispatch: true as const,
			actorKey: stableActorKey,
			semanticDigest: stableSemanticDigest,
			operation,
			requestId,
			fingerprint,
			fetch,
			receiver,
			request,
			maxResponseBytes: RIVET_ASYNC_KV_LIMITS.responseBytes,
			maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
		});
		const dispatchClaim = freeze({
			...claim,
			phase: "dispatch" as const,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let workStarted = false;
		let retainSlot = false;
		const abortControllers = (): void => {
			let failed = signalAborted === undefined;

			try {
				apply(controllerAbort, controller, []);
			} catch {
				failed = true;
			}
			try {
				apply(controllerAbort, transportController, []);
			} catch {
				failed = true;
			}
			if (signalAborted !== undefined) {
				try {
					if (apply(signalAborted, privateSignal, []) !== true) failed = true;
				} catch {
					failed = true;
				}
				try {
					if (apply(signalAborted, transportSignal, []) !== true) failed = true;
				} catch {
					failed = true;
				}
			}
			if (failed && workStarted) {
				forcedUnknown = true;
				retainSlot = true;
			}
		};
		active++;
		try {
			const work = async (): Promise<
				RivetAsyncKvResult<Uint8Array | boolean | undefined>
			> => {
				if (
					!(
						await rivetKvNative(
							decide(
								() => apply(verifyTransport, receiver, [dispatchClaim]),
								privateSignal,
								deadline,
							),
						)
					).value
				)
					return failure();
				if (deadline.expired()) return failure();
				dispatched = true;
				let transportWork: Promise<RivetKvBox<Response>>;
				try {
					transportWork = rivetKvNative<Response>(
						apply(fetch, receiver, [path, init]),
					);
				} catch {
					retainSlot = true;
					return failure();
				}
				const { value: response } = await transportWork;
				if (
					isProxy(response) ||
					statusGetter === undefined ||
					bodyGetter === undefined
				) {
					retainSlot = true;
					return failure();
				}

				try {
					const then = getOwnDescriptor(response, "then");
					if (
						then !== undefined &&
						(!hasOwn(then, "value") || then.value !== undefined)
					) {
						retainSlot = true;
						return failure();
					}
					defineProperty(response, "then", RIVET_KV_NONTHENABLE);
				} catch {
					retainSlot = true;
					return failure();
				}
				let status: number;
				let stream: ReadableStream<Uint8Array> | null;
				try {
					status = apply(statusGetter, response, []);
					stream = apply(bodyGetter, response, []);
				} catch {
					retainSlot = true;
					return failure();
				}
				if (deadline.expired()) {
					await rivetKvNative(retireRivetKvStream(stream));
					return failure();
				}
				const { value: bytes } = await rivetKvNative(
					readRivetKvStream(
						stream,
						RIVET_ASYNC_KV_LIMITS.responseBytes,
						privateSignal,
						deadline,
					),
				);
				if (typedArrayLength === undefined) return failure();
				const responseEvidence = freeze({
					status,
					byteLength: apply(typedArrayLength, bytes, []),
					sha256: digestBytes(bytes),
				});
				const receiptClaim = freeze({
					...claim,
					phase: "receipt" as const,
					response: responseEvidence,
				});
				if (
					!(
						await rivetKvNative(
							decide(
								() => apply(verifyTransport, receiver, [receiptClaim]),
								privateSignal,
								deadline,
							),
						)
					).value
				)
					return failure();
				if (deadline.expired()) return failure();
				const data: unknown = parse(
					apply(decodeText, new NativeTextDecoder("utf-8", { fatal: true }), [
						bytes,
					]),
				);
				const receiptKeys = [
					"requestId",
					"fingerprint",
					"operation",
					"semanticDigest",
					...(status !== 200
						? ["error"]
						: operation === "get"
							? ["value"]
							: operation === "exists"
								? ["exists"]
								: []),
				];
				if (
					!record(data) ||
					!fields(data, receiptKeys) ||
					data.requestId !== requestId ||
					data.fingerprint !== fingerprint ||
					data.operation !== operation ||
					data.semanticDigest !== stableSemanticDigest
				)
					return failure();
				if (deadline.expired()) return failure();
				if (status !== 200) {
					if (
						!fields(data, [
							"requestId",
							"fingerprint",
							"operation",
							"semanticDigest",
							"error",
						])
					)
						return failure();
					const code = data.error;
					if (
						(status === 400 && code === "invalid-argument") ||
						(status === 403 && code === "forbidden") ||
						(status === 429 && code === "capacity-exhausted")
					)
						return outcome({ status: "denied" as const, code });
					return failure();
				}
				if (operation === "get") {
					if (
						!fields(data, [
							"requestId",
							"fingerprint",
							"operation",
							"semanticDigest",
							"value",
						])
					)
						return failure();
					if (data.value === null)
						return outcome({ status: "ok" as const, value: undefined });
					const decoded = kvDecode(data.value);
					return decoded === undefined
						? failure()
						: outcome({ status: "ok" as const, value: decoded });
				}
				if (operation === "exists")
					return fields(data, [
						"requestId",
						"fingerprint",
						"operation",
						"semanticDigest",
						"exists",
					]) && typeof data.exists === "boolean"
						? outcome({ status: "ok" as const, value: data.exists })
						: failure();
				return fields(data, [
					"requestId",
					"fingerprint",
					"operation",
					"semanticDigest",
				])
					? outcome({ status: "ok" as const, value: undefined })
					: failure();
			};
			let resolveTimeout: (result: RivetAsyncKvResult<never>) => void =
				() => {};
			const timeout = rivetKvPromise<RivetAsyncKvResult<never>>((resolve) => {
				resolveTimeout = resolve;
			});
			timer = rivetKvSchedule(() => {
				deadline.expire();
				abortControllers();
				resolveTimeout(failure());
			}, deadline.remainingMs());
			const pending = work();
			workStarted = true;
			rivetKvObserve(
				pending,
				() => {
					if (!retainSlot) active--;
				},
				() => {
					if (!retainSlot) active--;
				},
			);
			const { value: result } = await rivetKvRace(pending, timeout);
			return deadline.expired() ? failure() : result;
		} catch {
			deadline.expire();
			abortControllers();
			return failure();
		} finally {
			if (!workStarted) active--;
			if (timer !== undefined) {
				try {
					rivetKvCancelTimer(timer);
				} catch {
					void timer;
				}
			}
		}
	}
	async function invoke(
		operation: RivetAsyncKvOperation,
		key: string,
		value?: Uint8Array,
	): Promise<RivetAsyncKvResult<Uint8Array | boolean | undefined>> {
		try {
			return (await rivetKvNative(invokeChecked(operation, key, value))).value;
		} catch {
			return unavailable();
		}
	}
	return freeze({
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: invoke validates the result shape separately for each operation.
		get: (key: string) =>
			invoke("get", key) as Promise<RivetAsyncKvResult<Uint8Array | undefined>>,
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: invoke validates the result shape separately for each operation.
		set: (key: string, value: Uint8Array) =>
			invoke("set", key, value) as Promise<RivetAsyncKvResult<undefined>>,
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: invoke validates the result shape separately for each operation.
		delete: (key: string) =>
			invoke("delete", key) as Promise<RivetAsyncKvResult<undefined>>,
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: invoke validates the result shape separately for each operation.
		exists: (key: string) =>
			invoke("exists", key) as Promise<RivetAsyncKvResult<boolean>>,
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread */
