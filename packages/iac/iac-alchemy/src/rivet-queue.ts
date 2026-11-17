/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread -- SAFETY: HTTP, SQLite and host authority values cross validated provider boundaries. */
import { isAbsolute, resolve } from "node:path";
import { DurableObject } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import type { AnyActorDefinition } from "rivetkit";
import { AlchemyIacError } from "./plan.js";
import {
	isRivetQueueBinding,
	type RivetQueueBinding,
} from "./rivet-queue-runtime.js";
import {
	RIVET_QUEUE_CHUNK_BYTES,
	RIVET_QUEUE_TIMEOUT_MS,
	readRivetQueueStream,
} from "./rivet-queue-stream.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceFence,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

export type {
	RivetQueueBinding,
	RivetQueueOperation,
} from "./rivet-queue-runtime.js";
export {
	createRivetQueueActor,
	isRivetQueueBinding,
} from "./rivet-queue-runtime.js";

/** A single external program and exclusively owned Rivet pool for one queue. */
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
	/**
	 * Independently verify the source and artifact closure, exclusive pool, and
	 * that the deployed main starts a registry with this exact actor definition
	 * and its authorized host policies. Inspecting the in-process registry alone
	 * cannot prove that the separately bundled main actually starts it.
	 */
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
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
/** Validate the real actor registry and host-owned source attestation. */
export function bindRivetAsyncQueueSource(
	input: RivetAsyncQueueSource,
): RivetAsyncQueueSource {
	const snapshot = Object.freeze({ ...input });
	const fence = captureAlchemySourceFence(snapshot.sourceFence);
	if (!fence || fence.sourceDigest !== snapshot.sourceDigest)
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the queue requires a host-verified immutable source and artifact fence",
		);
	const source = Object.freeze({ ...snapshot, sourceFence: fence });
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
	const external = Object.getOwnPropertyDescriptor(
		source.poolHost,
		"deployExternal",
	);
	const crate = Object.getOwnPropertyDescriptor(source.poolHost, "deployCrate");
	if (
		!external ||
		!("value" in external) ||
		typeof external.value !== "function" ||
		!crate ||
		!("value" in crate) ||
		typeof crate.value !== "function"
	)
		throw new AlchemyIacError(
			"RIVET_POOL_UNVERIFIED",
			"the exclusive pool requires stable host deployment functions",
		);
	const matches = () =>
		Object.getOwnPropertyDescriptor(source.poolHost, "deployExternal")
			?.value === external.value &&
		Object.getOwnPropertyDescriptor(source.poolHost, "deployCrate")?.value ===
			crate.value &&
		isRivetQueueBinding(source.binding) &&
		source.binding.actorName === source.resourceName &&
		Object.keys(source.registry.config.use).length === 1 &&
		Object.hasOwn(source.registry.config.use, source.resourceName) &&
		source.registry.config.use[source.resourceName] === source.binding.actor;
	if (!matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_MISMATCH",
			"the standalone registry must contain exactly the named queue actor",
		);
	let verified = false;
	try {
		verified = source.verifySource(source) === true;
	} catch {
		/* A failed verifier is not proof. */
	}
	if (!verified || !matches())
		throw new AlchemyIacError(
			"RIVET_SOURCE_UNVERIFIED",
			"the host did not verify the exact queue source and exclusive pool",
		);
	return source;
}
/** Construct the real Alchemy Rivet DurableObject resource for this async queue. */
export function rivetAsyncQueueResource(input: RivetAsyncQueueSource) {
	const source = bindRivetAsyncQueueSource(input);
	const host = source.poolHost;
	const deployExternal = host.deployExternal;
	const deployCrate = host.deployCrate;
	const claim: AlchemySourceClaim = Object.freeze({
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
			bindRivetAsyncQueueSource(source);
			if (
				host.deployExternal !== deployExternal ||
				host.deployCrate !== deployCrate
			)
				return false;
			return verifyAlchemySourceFence(source.sourceFence, candidate);
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
					yield* deployExternal.call(
						host,
						Object.freeze({ id, main, resource }),
					);
					check();
				}),
			deployCrate: (object) => deployCrate.call(host, object),
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
	/** Must target the authenticated actor key and attach host-issued credentials. */
	fetch(path: string, init: RequestInit): Promise<Response>;
	/** Independently attest limits on the full response path before forwarding. */
	verifyResponseBounds?(input: {
		readonly operation: string;
		readonly maxResponseBytes: number;
		readonly maxChunkBytes: number;
	}): boolean | Promise<boolean>;
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown): value is Json {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let count = 0;
	while (pending.length) {
		const item = pending.pop();
		if (!item || ++count > 10_000 || item.depth > 64) return false;
		const current = item.value;
		if (
			current === null ||
			typeof current === "string" ||
			typeof current === "boolean"
		)
			continue;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return false;
			continue;
		}
		if (Array.isArray(current)) {
			if (Object.getOwnPropertySymbols(current).length !== 0) return false;
			const descriptors = Object.getOwnPropertyDescriptors(current);
			if (
				Object.keys(descriptors).some(
					(key) =>
						key !== "length" &&
						(!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length),
				)
			)
				return false;
			for (let index = 0; index < current.length; index++) {
				const entry = descriptors[String(index)];
				if (!entry || !("value" in entry) || !entry.enumerable) return false;
				pending.push({ value: entry.value, depth: item.depth + 1 });
			}
		} else if (object(current)) {
			const prototype = Object.getPrototypeOf(current);
			if (
				(prototype !== Object.prototype && prototype !== null) ||
				Object.getOwnPropertySymbols(current).length !== 0
			)
				return false;
			for (const entry of Object.values(
				Object.getOwnPropertyDescriptors(current),
			)) {
				if (!("value" in entry) || !entry.enumerable) return false;
				pending.push({ value: entry.value, depth: item.depth + 1 });
			}
		} else return false;
	}
	return true;
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
		this.name = "RivetAsyncQueueError";
	}
}
async function decode(
	result: Response,
	signal: AbortSignal,
	verifyBounds: (() => boolean | Promise<boolean>) | undefined,
): Promise<unknown> {
	const bytes = await readRivetQueueStream(
		result.body,
		8_388_608,
		signal,
		verifyBounds,
	);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function readMessage(value: unknown): RivetAsyncQueueMessage {
	if (
		!object(value) ||
		!name(value.messageId) ||
		!name(value.queueName) ||
		!name(value.idempotencyKey) ||
		!name(value.leaseId) ||
		typeof value.leaseExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
		typeof value.deliveryAttempt !== "number" ||
		!Number.isSafeInteger(value.deliveryAttempt) ||
		value.deliveryAttempt < 1 ||
		value.deliveryAttempt > 4_294_967_295 ||
		!Object.hasOwn(value, "body") ||
		!json(value.body)
	)
		throw new Error("invalid queue receipt");
	return {
		messageId: value.messageId,
		queueName: value.queueName,
		idempotencyKey: value.idempotencyKey,
		body: value.body,
		leaseId: value.leaseId,
		leaseExpiresAt: value.leaseExpiresAt,
		deliveryAttempt: value.deliveryAttempt,
	};
}
/** An explicitly async JSON interface; it does not claim to implement core Queue or WIT bytes/attributes. */
export function createRivetAsyncQueueClient(
	transport: RivetAsyncQueueTransport,
) {
	const fetch = transport.fetch.bind(transport);
	const verifyResponseBounds = transport.verifyResponseBounds?.bind(transport);
	async function invoke(
		path: string,
		body: object,
	): Promise<Record<string, unknown>> {
		let payload: string;
		try {
			payload = JSON.stringify(body);
		} catch {
			throw new RivetAsyncQueueError("invalid-argument", path);
		}
		if (new TextEncoder().encode(payload).length > 65_536)
			throw new RivetAsyncQueueError("invalid-argument", path);
		let result: Response;
		let data: unknown;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const work = async () => {
				const response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: payload,
					signal: controller.signal,
				});
				if (!(response instanceof Response) || controller.signal.aborted)
					throw new Error("invalid or late response");
				const verifyBounds =
					verifyResponseBounds === undefined
						? undefined
						: () =>
								verifyResponseBounds(
									Object.freeze({
										operation: path,
										maxResponseBytes: 8_388_608,
										maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
									}),
								);
				return {
					response,
					value: await decode(response, controller.signal, verifyBounds),
				};
			};
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("queue request timed out"));
				}, RIVET_QUEUE_TIMEOUT_MS);
			});
			const completed = await Promise.race([work(), deadline]);
			result = completed.response;
			data = completed.value;
		} catch {
			throw new RivetAsyncQueueError("outcome-unknown", path);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		if (!result.ok) {
			if (object(data)) {
				if (result.status === 400 && data.error === "invalid-argument")
					throw new RivetAsyncQueueError("invalid-argument", path);
				if (result.status === 403 && data.error === "forbidden")
					throw new RivetAsyncQueueError("forbidden", path);
				if (result.status === 404 && data.error === "not-found")
					throw new RivetAsyncQueueError("not-found", path);
				if (result.status === 409 && data.error === "idempotency-conflict")
					throw new RivetAsyncQueueError("idempotency-conflict", path);
				if (result.status === 409 && data.error === "lease-lost")
					throw new RivetAsyncQueueError("lease-lost", path);
				if (result.status === 429 && data.error === "capacity-exhausted")
					throw new RivetAsyncQueueError("capacity-exhausted", path);
			}
			throw new RivetAsyncQueueError("outcome-unknown", path);
		}
		if (result.status !== 200 || !object(data))
			throw new RivetAsyncQueueError("outcome-unknown", path);
		return data;
	}
	return Object.freeze({
		async enqueue(idempotencyKey: string, body: Json, availableAtMs?: number) {
			if (!name(idempotencyKey) || !json(body))
				throw new RivetAsyncQueueError("invalid-argument", "/enqueue");
			const data = await invoke("/enqueue", {
				idempotencyKey,
				body,
				...(availableAtMs === undefined ? {} : { availableAtMs }),
			});
			if (
				!name(data.messageId) ||
				data.idempotencyKey !== idempotencyKey ||
				typeof data.deduped !== "boolean"
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/enqueue");
			return {
				messageId: data.messageId,
				idempotencyKey,
				deduped: data.deduped,
			};
		},
		async dequeue(maxMessages: number, visibilityTimeoutMs: number) {
			const data = await invoke("/dequeue", {
				maxMessages,
				visibilityTimeoutMs,
			});
			if (
				!Array.isArray(data.messages) ||
				data.messages.length > maxMessages ||
				data.messages.length > 100
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/dequeue");
			let messages: RivetAsyncQueueMessage[];
			try {
				messages = data.messages.map(readMessage);
			} catch {
				throw new RivetAsyncQueueError("outcome-unknown", "/dequeue");
			}
			if (
				new Set(messages.map((row) => row.messageId)).size !== messages.length
			)
				throw new RivetAsyncQueueError("outcome-unknown", "/dequeue");
			return messages;
		},
		async complete(messageId: string, leaseId: string) {
			const data = await invoke("/complete", { messageId, leaseId });
			if (data.messageId !== messageId || typeof data.deduped !== "boolean")
				throw new RivetAsyncQueueError("outcome-unknown", "/complete");
			return { messageId, deduped: data.deduped };
		},
		async release(messageId: string, leaseId: string) {
			const data = await invoke("/release", { messageId, leaseId });
			if (data.messageId !== messageId)
				throw new RivetAsyncQueueError("outcome-unknown", "/release");
			return { messageId };
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
				receipt = readMessage(data.message);
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
