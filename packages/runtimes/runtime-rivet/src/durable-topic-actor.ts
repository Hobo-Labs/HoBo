/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: HTTP and actor host data cross validated boundaries. */
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import {
	type DurableMessagingOperation,
	parseDurableMessagingOperation,
} from "@hobo/core";
import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
	migrateDurableReceiptJournal,
	RIVET_DURABLE_JOURNAL_BOUNDS,
	runDurableReceiptJournal,
} from "./durable-receipt-journal.js";
import {
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
	readRivetTopicBusAudit,
	reduceRivetTopicBus,
} from "./durable-topic-bus.js";
import {
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
	readRivetTopicAudit,
	readRivetTopicLog,
	reduceRivetTopicLog,
} from "./durable-topic-log.js";
import { synchronousResult } from "./synchronous-result.js";

export interface RivetDurableTopicContext {
	readonly name: string;
	readonly key: readonly string[];
	readonly db: RawAccess;
}
type TopicScope = { readonly tenant: string; readonly instance: string };
type TopicClaim = Readonly<
	TopicScope & {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly semanticDigest: string;
		readonly method: string;
		readonly operation?: DurableMessagingOperation;
		readonly requestBase64: string;
		readonly headers: Headers;
	}
>;
export interface RivetDurableTopicBinding {
	readonly actorName: string;
	readonly semanticDigest: string;
	readonly actor: AnyActorDefinition;
	readonly handle: (
		context: RivetDurableTopicContext,
		request: Request,
	) => Promise<Response>;
	readonly limits: typeof RIVET_DURABLE_TOPIC_LOG_LIMITS;
	readonly capabilities: typeof RIVET_DURABLE_TOPIC_LOG_CAPABILITIES;
}
export interface RivetDurableTopicBusBinding {
	readonly actorName: string;
	readonly semanticDigest: string;
	readonly actor: AnyActorDefinition;
	readonly handle: (
		context: RivetDurableTopicContext,
		request: Request,
	) => Promise<Response>;
	readonly limits: typeof RIVET_DURABLE_TOPIC_BUS_LIMITS;
	readonly capabilities: typeof RIVET_DURABLE_TOPIC_BUS_CAPABILITIES;
}
export interface RivetDurableTopicOptions {
	readonly actorName: string;
	readonly semanticDigest: string;
	readonly now: () => number;
	readonly resolveScope: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
	}) => TopicScope;
	readonly authorize: (claim: TopicClaim) => boolean;
	readonly verifyIngress: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly maxRequestBytes: number;
		readonly maxChunkBytes: number;
		readonly maxChunks: number;
		readonly maxHeaderBytes: number;
	}) => boolean;
}
export interface RivetDurableTopicBusOptions extends RivetDurableTopicOptions {
	readonly authorizeInstanceScope: (claim: TopicClaim) => boolean;
}
const intrinsicApply = Reflect.apply;
const intrinsicWeakGet = WeakMap.prototype.get;
const intrinsicWeakSet = WeakMap.prototype.set;

function readPrivate<K extends object, V>(table: WeakMap<K, V>, key: K): V | undefined {
	// SAFETY: the private table determines the value type for this key.
	return intrinsicApply(intrinsicWeakGet, table, [key]) as V | undefined;
}
function writePrivate<K extends object, V>(
	table: WeakMap<K, V>,
	key: K,
	value: V,
): void {
	intrinsicApply(intrinsicWeakSet, table, [key, value]);
}

const registered = new WeakMap<
	object,
	Readonly<{ database: object; semanticDigest: string; mode: "log" | "bus" }>
>();
const MAX_CHUNK_BYTES = 65_536;
const MAX_CHUNKS = 4_096;
const MAX_HEADER_BYTES = 16_384;
const READ_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();
const monotonicNow = performance.now.bind(performance);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;
const intrinsicSet = Uint8Array.prototype.set;
class IngressUnavailable extends Error {}
const mutations = new Set([
	"ensure-topic",
	"ensure-subscription",
	"publish",
	"consume",
	"ack",
	"nack",
	"compact",
]);
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		!/[\p{Cc}\uD800-\uDFFF]/u.test(value) &&
		encoder.encode(value).length <= 128
	);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function snapshotScope(value: unknown): TopicScope {
	if (utilTypes.isProxy(value) || !record(value))
		throw new Error("invalid scope");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error("invalid scope prototype");
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== 2 ||
		!keys.includes("tenant") ||
		!keys.includes("instance")
	)
		throw new Error("invalid scope keys");
	const tenant = Object.getOwnPropertyDescriptor(value, "tenant");
	const instance = Object.getOwnPropertyDescriptor(value, "instance");
	if (
		tenant === undefined ||
		instance === undefined ||
		!Object.hasOwn(tenant, "value") ||
		!Object.hasOwn(instance, "value") ||
		!tenant.enumerable ||
		!instance.enumerable ||
		!name(tenant.value) ||
		!name(instance.value)
	)
		throw new Error("invalid scope values");
	return Object.freeze({ tenant: tenant.value, instance: instance.value });
}
function canonical(input: unknown): string {
	let visited = 0;
	function encode(value: unknown, depth: number): string {
		if (++visited > 10_000 || depth > 32)
			throw new Error("JSON exceeds bounds");
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return JSON.stringify(value);
		if (typeof value === "number" && Number.isFinite(value))
			return JSON.stringify(value);
		if (Array.isArray(value))
			return `[${value.map((entry) => encode(entry, depth + 1)).join(",")}]`;
		if (record(value))
			return `{${Object.keys(value)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`)
				.join(",")}}`;
		throw new Error("invalid JSON");
	}
	return encode(input, 0);
}
function reply(status: number, body: Record<string, unknown>): Response {
	const text = canonical(body);
	if (
		encoder.encode(text).byteLength > RIVET_DURABLE_JOURNAL_BOUNDS.receiptBytes
	)
		return new Response(null, { status: 503 });
	return new Response(text, {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});
}
function headersSnapshot(
	headers: Headers,
): readonly (readonly [string, string])[] {
	const result: Array<readonly [string, string]> = [];
	let bytes = 0;
	for (const [key, value] of headers) {
		if (
			result.length >= 64 ||
			key.length > MAX_HEADER_BYTES ||
			value.length > MAX_HEADER_BYTES
		)
			throw new Error("headers exceed bounds");
		bytes += encoder.encode(key).length + encoder.encode(value).length;
		if (bytes > MAX_HEADER_BYTES) throw new Error("headers exceed bounds");
		result.push(Object.freeze([key, value]));
	}
	return Object.freeze(result);
}
async function readBody(
	request: Request,
	verify: () => boolean,
): Promise<Uint8Array> {
	if (request.body === null) throw new Error("missing body");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let chunkCount = 0;
	const deadline = monotonicNow() + READ_TIMEOUT_MS;
	try {
		for (;;) {
			if (
				request.signal.aborted ||
				monotonicNow() >= deadline ||
				!verify() ||
				monotonicNow() >= deadline
			)
				throw new IngressUnavailable("ingress unavailable");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new IngressUnavailable("request expired")),
					Math.max(1, deadline - monotonicNow()),
				);
			});
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new IngressUnavailable("request aborted"));
				request.signal.addEventListener("abort", onAbort, { once: true });
				if (request.signal.aborted) onAbort();
			});
			let next: ReadableStreamReadResult<Uint8Array>;
			try {
				next = await Promise.race([reader.read(), timeout, aborted]);
			} catch {
				throw new IngressUnavailable("request read failed");
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				if (onAbort !== undefined)
					request.signal.removeEventListener("abort", onAbort);
			}
			if (
				request.signal.aborted ||
				monotonicNow() >= deadline ||
				!verify() ||
				monotonicNow() >= deadline
			)
				throw new IngressUnavailable("ingress unavailable");
			if (next.done) break;
			if (++chunkCount > MAX_CHUNKS) throw new Error("too many chunks");
			if (
				utilTypes.isProxy(next.value) ||
				!(next.value instanceof Uint8Array) ||
				intrinsicByteLength === undefined ||
				intrinsicBuffer === undefined
			)
				throw new Error("invalid chunk");
			const length: unknown = intrinsicByteLength.call(next.value);
			const buffer: unknown = intrinsicBuffer.call(next.value);
			if (
				typeof length !== "number" ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_CHUNK_BYTES ||
				utilTypes.isSharedArrayBuffer(buffer)
			)
				throw new Error("invalid chunk");
			size += length;
			if (size > RIVET_DURABLE_JOURNAL_BOUNDS.requestBytes)
				throw new Error("request too large");
			const chunk = new Uint8Array(length);
			intrinsicSet.call(chunk, next.value);
			chunks.push(chunk);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function buildTopicActor(
	options: RivetDurableTopicOptions,
	mode: "log",
): RivetDurableTopicBinding;
function buildTopicActor(
	options: RivetDurableTopicBusOptions,
	mode: "bus",
): RivetDurableTopicBusBinding;
function buildTopicActor(
	options: RivetDurableTopicOptions | RivetDurableTopicBusOptions,
	mode: "log" | "bus",
): RivetDurableTopicBinding | RivetDurableTopicBusBinding {
	const {
		actorName,
		semanticDigest,
		now,
		resolveScope,
		authorize,
		verifyIngress,
	} = options;
	const authorizeInstanceScope =
		"authorizeInstanceScope" in options
			? options.authorizeInstanceScope
			: undefined;
	if (
		!name(actorName) ||
		typeof semanticDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/u.test(semanticDigest) ||
		typeof now !== "function" ||
		typeof resolveScope !== "function" ||
		typeof authorize !== "function" ||
		typeof verifyIngress !== "function" ||
		(mode === "bus" && typeof authorizeInstanceScope !== "function")
	)
		throw new TypeError(
			"actor identity, semantic digest and trusted host functions are required",
		);
	const database = db({ onMigrate: migrateDurableReceiptJournal });
	const handle = async (
		context: RivetDurableTopicContext,
		request: Request,
	): Promise<Response> => {
		const method = new URL(request.url).pathname.slice(1);
		if (
			request.method !== "POST" ||
			(!mutations.has(method) &&
				method !== "events" &&
				method !== "read-log") ||
			(mode === "bus" && method === "read-log")
		)
			return reply(404, { error: "not-found" });
		if (
			context.name !== actorName ||
			!Array.isArray(context.key) ||
			context.key.length < 1 ||
			context.key.length > 16 ||
			!context.key.every(name)
		)
			return reply(403, { error: "forbidden" });
		const actorKey = Object.freeze([...context.key]);
		const ingressClaim = Object.freeze({
			actorName,
			actorKey,
			maxRequestBytes: RIVET_DURABLE_JOURNAL_BOUNDS.requestBytes,
			maxChunkBytes: MAX_CHUNK_BYTES,
			maxChunks: MAX_CHUNKS,
			maxHeaderBytes: MAX_HEADER_BYTES,
		});
		const ingressVerified = () => {
			try {
				return synchronousResult(verifyIngress(ingressClaim)) === true;
			} catch {
				return false;
			}
		};
		let headerEntries: readonly (readonly [string, string])[];
		let scope: TopicScope;
		try {
			headerEntries = headersSnapshot(request.headers);
			if (!ingressVerified()) throw new Error("unverified ingress");
			scope = snapshotScope(
				synchronousResult(resolveScope(Object.freeze({ actorName, actorKey }))),
			);
		} catch {
			if (request.body !== null) void request.body.cancel().catch(() => {});
			return reply(503, { error: "authority-unavailable" });
		}
		let body: Record<string, unknown>;
		let bytes: Uint8Array;
		try {
			bytes = await readBody(request, ingressVerified);
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const value: unknown = JSON.parse(text);
			if (!record(value) || canonical(value) !== text)
				throw new Error("noncanonical body");
			body = value;
		} catch (error) {
			if (error instanceof IngressUnavailable)
				return reply(503, { error: "ingress-unavailable" });
			return reply(400, { error: "invalid-request" });
		}
		const requestBase64 = Buffer.from(bytes).toString("base64");
		let operation: DurableMessagingOperation | undefined;
		if (mutations.has(method)) {
			try {
				operation = parseDurableMessagingOperation(body.operation);
			} catch {
				return reply(400, { error: "invalid-operation" });
			}
		}
		const check = () => {
			try {
				const currentScope = snapshotScope(
					synchronousResult(
						resolveScope(Object.freeze({ actorName, actorKey })),
					),
				);
				if (
					!ingressVerified() ||
					currentScope.tenant !== scope.tenant ||
					currentScope.instance !== scope.instance
				)
					return false;
				const claim = () => {
					const base = {
						...scope,
						actorName,
						actorKey,
						semanticDigest,
						method,
						requestBase64,
						headers: new Headers(
							headerEntries.map(([key, value]): [string, string] => [
								key,
								value,
							]),
						),
					};
					return operation === undefined
						? Object.freeze(base)
						: Object.freeze({ ...base, operation });
				};
				return (
					synchronousResult(authorize(claim())) === true &&
					(mode === "log" ||
						synchronousResult(authorizeInstanceScope?.(claim())) === true)
				);
			} catch {
				return false;
			}
		};
		if (!check()) return reply(503, { error: "authority-unavailable" });
		try {
			if (operation !== undefined) {
				const outcome = await runDurableReceiptJournal(
					context.db,
					{ operation, scope, semanticDigest, method, request: bytes },
					now,
					(claim) =>
						claim.tenant === scope.tenant &&
						claim.instance === scope.instance &&
						claim.semanticDigest === semanticDigest &&
						claim.method === method &&
						claim.operation.id === operation.id &&
						claim.operation.expiresAtMs === operation.expiresAtMs &&
						claim.requestBase64 === requestBase64 &&
						check(),
					(prior, timestamp, detached) => {
						const decoded: unknown = JSON.parse(
							Buffer.from(detached, "base64").toString("utf8"),
						);
						return mode === "log"
							? reduceRivetTopicLog(prior, method, decoded)
							: reduceRivetTopicBus(prior, method, decoded, timestamp);
					},
				);
				if (!check()) return reply(503, { error: "authority-unavailable" });
				if (outcome.status === "committed")
					return reply(200, {
						status: "committed",
						value: JSON.parse(outcome.value),
					});
				return reply(200, outcome);
			}
			const result = await context.db.transaction(async (tx) => {
				if (!check()) throw new Error("revoked");
				const pins = await tx.execute<{ digest: string }>(
					"SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest ELSE NULL END AS digest FROM hobo_dm_semantics WHERE tenant=? AND instance=?",
					scope.tenant,
					scope.instance,
				);
				if (
					pins.length > 1 ||
					(pins.length === 1 && pins[0]?.digest !== semanticDigest)
				)
					throw new Error("unverified state owner");
				if (pins.length === 0) {
					const rows = await tx.execute<{ present: number }>(
						"SELECT (EXISTS(SELECT 1 FROM hobo_dm_receipt_clock WHERE tenant=? AND instance=?) OR EXISTS(SELECT 1 FROM hobo_dm_topic_state WHERE tenant=? AND instance=?) OR EXISTS(SELECT 1 FROM hobo_dm_receipts WHERE tenant=? AND instance=?)) AS present",
						scope.tenant,
						scope.instance,
						scope.tenant,
						scope.instance,
						scope.tenant,
						scope.instance,
					);
					if (rows.length !== 1 || rows[0]?.present !== 0)
						throw new Error("unverified prior state");
				}
				const rows = await tx.execute<{ value: string }>(
					"SELECT CASE WHEN length(CAST(value AS BLOB))<=4194304 THEN value ELSE NULL END AS value FROM hobo_dm_topic_state WHERE tenant=? AND instance=?",
					scope.tenant,
					scope.instance,
				);
				if (
					rows.length > 1 ||
					(rows.length === 1 && typeof rows[0]?.value !== "string")
				)
					throw new Error("invalid state");
				const value =
					mode === "bus"
						? readRivetTopicBusAudit(rows[0]?.value, body)
						: method === "events"
							? readRivetTopicAudit(rows[0]?.value, body)
							: readRivetTopicLog(rows[0]?.value, body);
				if (!check()) throw new Error("revoked");
				return value;
			});
			if (!check()) return reply(503, { error: "authority-unavailable" });
			return reply(200, result);
		} catch {
			return reply(503, { error: "unavailable" });
		}
	};
	Object.freeze(database);
	const definition = actor({ db: database, onRequest: handle });
	Object.freeze(definition.config.actions);
	Object.freeze(definition.config.options);
	Object.freeze(definition.config);
	Object.freeze(definition);
	const base = {
		actorName,
		semanticDigest,
		actor: definition,
		handle,
	};
	const binding =
		mode === "log"
			? Object.freeze({
					...base,
					limits: RIVET_DURABLE_TOPIC_LOG_LIMITS,
					capabilities: RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
				})
			: Object.freeze({
					...base,
					limits: RIVET_DURABLE_TOPIC_BUS_LIMITS,
					capabilities: RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
				});
	writePrivate(
		registered,
		binding,
		Object.freeze({ database, semanticDigest, mode }),
	);
	return binding;
}
export function createRivetDurableTopicActor(
	options: RivetDurableTopicOptions,
): RivetDurableTopicBinding {
	return buildTopicActor(options, "log");
}
export function createRivetDurableTopicBusActor(
	options: RivetDurableTopicBusOptions,
): RivetDurableTopicBusBinding {
	return buildTopicActor(options, "bus");
}
export function isRivetDurableTopicBinding(
	binding: RivetDurableTopicBinding,
): boolean {
	const identity = readPrivate(registered, binding);
	return (
		identity !== undefined &&
		identity.mode === "log" &&
		binding.semanticDigest === identity.semanticDigest &&
		isStaticActorDefinition(binding.actor) &&
		"db" in binding.actor.config &&
		binding.actor.config.db === identity.database &&
		binding.actor.config.onRequest === binding.handle
	);
}
export function isRivetDurableTopicBusBinding(
	binding: RivetDurableTopicBusBinding,
): boolean {
	const identity = readPrivate(registered, binding);
	return (
		identity !== undefined &&
		identity.mode === "bus" &&
		binding.semanticDigest === identity.semanticDigest &&
		isStaticActorDefinition(binding.actor) &&
		"db" in binding.actor.config &&
		binding.actor.config.db === identity.database &&
		binding.actor.config.onRequest === binding.handle
	);
}
