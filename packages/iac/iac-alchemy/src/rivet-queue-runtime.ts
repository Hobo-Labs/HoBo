/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread -- SAFETY: HTTP, SQLite and host authority values cross validated provider boundaries. */
import { randomUUID } from "node:crypto";
import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
	RIVET_QUEUE_CHUNK_BYTES,
	readRivetQueueStream,
} from "./rivet-queue-stream.js";

/** Async queue operations provided by a Rivet actor. The synchronous HoBo core
 * Queue port cannot make remote calls; this is the asynchronous WIT-shaped port. */
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

const registered = new WeakMap<object, object>();
const MAX_MESSAGES = 10_000;
const MAX_BODY_BYTES = 65_536;
const MAX_LEASE_MS = 86_400_000;
const MAX_BATCH = 100;
const encoder = new TextEncoder();

function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
function integer(value: unknown, min: number, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validJson(value: unknown): boolean {
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
			for (const child of current)
				pending.push({ value: child, depth: item.depth + 1 });
		} else if (record(current)) {
			for (const child of Object.values(current))
				pending.push({ value: child, depth: item.depth + 1 });
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
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	throw new Error("invalid JSON");
}
function response(status: number, data: object): Response {
	return Response.json(data, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
async function readBody(
	request: Request,
	verifyIngress: (() => boolean | Promise<boolean>) | undefined,
): Promise<unknown> {
	const bytes = await readRivetQueueStream(
		request.body,
		MAX_BODY_BYTES,
		request.signal,
		verifyIngress,
	);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function operation(request: Request): RivetQueueOperation | undefined {
	if (request.method !== "POST") return undefined;
	const path = new URL(request.url).pathname;
	if (path === "/enqueue") return "enqueue";
	if (path === "/dequeue") return "dequeue";
	if (path === "/complete") return "complete";
	if (path === "/release") return "release";
	if (path === "/extend") return "extend";
	return undefined;
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
		!integer(row.lease_expires_at, 0, Number.MAX_SAFE_INTEGER)
	)
		throw new Error("corrupt queue record");
	return {
		messageId: row.message_id,
		queueName,
		idempotencyKey: row.idempotency_key,
		body: JSON.parse(row.body),
		leaseId: row.lease_id,
		leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
		deliveryAttempt: row.attempt,
	};
}
/** A genuine RivetKit actor with per-instance, transactionally persisted queue state.
 * Authorization is host-owned; a client-provided actor key is not authority. */
export function createRivetQueueActor(options: {
	readonly actorName: string;
	readonly authorize: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly operation: RivetQueueOperation;
		readonly headers: Headers;
	}) => boolean | Promise<boolean>;
	/** Trusted clock shared by actor generations; it must not jump ahead of real time. */
	readonly now: () => number;
	/** Independently attest the entire native ingress enforces these limits before forwarding. */
	readonly verifyIngress?: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly operation: RivetQueueOperation;
		readonly maxRequestBytes: number;
		readonly maxChunkBytes: number;
	}) => boolean | Promise<boolean>;
}): RivetQueueBinding {
	const { actorName, authorize, now, verifyIngress } = options;
	if (
		!name(actorName) ||
		typeof authorize !== "function" ||
		typeof now !== "function" ||
		(verifyIngress !== undefined && typeof verifyIngress !== "function")
	)
		throw new TypeError(
			"queue actor name, host authorization and trusted clock are required",
		);
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
	const handle = async (
		context: RivetQueueContext,
		request: Request,
	): Promise<Response> => {
		const action = operation(request);
		if (!action) return response(404, { error: "not-found" });
		if (
			context.name !== actorName ||
			!Array.isArray(context.key) ||
			context.key.length === 0 ||
			context.key.length > 16 ||
			!context.key.every(name)
		)
			return response(403, { error: "forbidden" });
		const actorKey = Object.freeze([...context.key]);
		try {
			if (
				(await authorize({
					actorName,
					actorKey,
					operation: action,
					headers: new Headers(request.headers),
				})) !== true
			)
				return response(403, { error: "forbidden" });
		} catch {
			return response(403, { error: "forbidden" });
		}
		let body: unknown;
		try {
			body = await readBody(
				request,
				verifyIngress === undefined
					? undefined
					: () =>
							verifyIngress(
								Object.freeze({
									actorName,
									actorKey,
									operation: action,
									maxRequestBytes: MAX_BODY_BYTES,
									maxChunkBytes: RIVET_QUEUE_CHUNK_BYTES,
								}),
							),
			);
		} catch {
			return response(400, { error: "invalid-argument" });
		}
		if (!record(body)) return response(400, { error: "invalid-argument" });
		let current: number;
		try {
			current = now();
		} catch {
			return response(503, { error: "clock-unavailable" });
		}
		if (!integer(current, 0, 8_640_000_000_000_000 - MAX_LEASE_MS))
			return response(503, { error: "clock-unavailable" });
		if (
			action === "enqueue" &&
			(!name(body.idempotencyKey) ||
				!Object.hasOwn(body, "body") ||
				!validJson(body.body) ||
				(body.availableAtMs !== undefined &&
					!integer(body.availableAtMs, 0, 8_640_000_000_000_000)))
		)
			return response(400, { error: "invalid-argument" });
		if (
			action === "dequeue" &&
			(!integer(body.maxMessages, 1, MAX_BATCH) ||
				!integer(body.visibilityTimeoutMs, 1, MAX_LEASE_MS))
		)
			return response(400, { error: "invalid-argument" });
		if (
			(action === "complete" || action === "release" || action === "extend") &&
			(!name(body.messageId) ||
				!name(body.leaseId) ||
				(action === "extend" &&
					!integer(body.visibilityTimeoutMs, 1, MAX_LEASE_MS)))
		)
			return response(400, { error: "invalid-argument" });
		try {
			return await context.db.transaction(async (tx) => {
				const clock = await tx.execute<{ observed_at: number }>(
					"SELECT observed_at FROM hobo_queue_clock WHERE id=1",
				);
				if (
					clock.length &&
					(!integer(clock[0]?.observed_at, 0, Number.MAX_SAFE_INTEGER) ||
						clock[0].observed_at > current)
				)
					return response(503, { error: "clock-regressed" });
				await tx.execute(
					"INSERT INTO hobo_queue_clock(id,observed_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at",
					current,
				);
				if (action === "enqueue") {
					const encoded = canonical(body.body);
					if (encoder.encode(encoded).length > MAX_BODY_BYTES)
						return response(400, { error: "invalid-argument" });
					const requestedAt = body.availableAtMs ?? null;
					const previous = await tx.execute<StoredMessage>(
						"SELECT * FROM hobo_queue_messages WHERE idempotency_key=?",
						body.idempotencyKey,
					);
					if (previous[0]) {
						if (
							!name(previous[0].message_id) ||
							typeof previous[0].body !== "string" ||
							(previous[0].requested_available_at !== null &&
								!integer(
									previous[0].requested_available_at,
									0,
									Number.MAX_SAFE_INTEGER,
								))
						)
							throw new Error("corrupt queue record");
						if (
							previous[0].body !== encoded ||
							previous[0].requested_available_at !== requestedAt
						)
							return response(409, { error: "idempotency-conflict" });
						return response(200, {
							messageId: previous[0].message_id,
							idempotencyKey: body.idempotencyKey,
							deduped: true,
						});
					}
					const count = await tx.execute<{ n: number }>(
						"SELECT COUNT(*) AS n FROM hobo_queue_messages",
					);
					if (
						!integer(count[0]?.n, 0, MAX_MESSAGES) ||
						count[0].n >= MAX_MESSAGES
					)
						return response(429, { error: "capacity-exhausted" });
					const id = randomUUID();
					await tx.execute(
						"INSERT INTO hobo_queue_messages(idempotency_key,message_id,body,available_at,requested_available_at,state,attempt) VALUES(?,?,?,?,?,'pending',0)",
						body.idempotencyKey,
						id,
						encoded,
						body.availableAtMs ?? current,
						requestedAt,
					);
					return response(200, {
						messageId: id,
						idempotencyKey: body.idempotencyKey,
						deduped: false,
					});
				}
				if (action === "dequeue") {
					const rows = await tx.execute<StoredMessage>(
						"SELECT * FROM hobo_queue_messages WHERE (state='pending' AND available_at<=?) OR (state='leased' AND lease_expires_at<=?) ORDER BY available_at,message_id LIMIT ?",
						current,
						current,
						body.maxMessages,
					);
					const leased = [];
					for (const row of rows) {
						if (!integer(row.attempt, 0, 4_294_967_294))
							throw new Error("queue delivery attempts exhausted");
						const leaseId = `${row.message_id}:${row.attempt + 1}:${randomUUID()}`;
						const expiresAt = current + Number(body.visibilityTimeoutMs);
						await tx.execute(
							"UPDATE hobo_queue_messages SET state='leased',lease_id=?,lease_expires_at=?,attempt=attempt+1 WHERE message_id=?",
							leaseId,
							expiresAt,
							row.message_id,
						);
						leased.push(
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
					return response(200, { messages: leased });
				}
				const rows = await tx.execute<StoredMessage>(
					"SELECT * FROM hobo_queue_messages WHERE message_id=?",
					body.messageId,
				);
				const row = rows[0];
				if (!row) return response(404, { error: "not-found" });
				if (
					action === "complete" &&
					row.state === "completed" &&
					row.completed_lease_id === body.leaseId
				)
					return response(200, { messageId: body.messageId, deduped: true });
				if (
					row.state !== "leased" ||
					row.lease_id !== body.leaseId ||
					!integer(row.lease_expires_at, 0, Number.MAX_SAFE_INTEGER) ||
					row.lease_expires_at <= current
				)
					return response(409, { error: "lease-lost" });
				if (action === "complete") {
					await tx.execute(
						"UPDATE hobo_queue_messages SET state='completed',completed_lease_id=lease_id,lease_id=NULL,lease_expires_at=NULL WHERE message_id=?",
						body.messageId,
					);
					return response(200, { messageId: body.messageId, deduped: false });
				}
				if (action === "release") {
					await tx.execute(
						"UPDATE hobo_queue_messages SET state='pending',available_at=?,lease_id=NULL,lease_expires_at=NULL WHERE message_id=?",
						current,
						body.messageId,
					);
					return response(200, { messageId: body.messageId });
				}
				const expiresAt = current + Number(body.visibilityTimeoutMs);
				await tx.execute(
					"UPDATE hobo_queue_messages SET lease_expires_at=? WHERE message_id=?",
					expiresAt,
					body.messageId,
				);
				return response(200, {
					message: message({ ...row, lease_expires_at: expiresAt }, actorName),
				});
			});
		} catch {
			return response(503, { error: "queue-unavailable" });
		}
	};
	Object.freeze(database);
	const definition = actor({ db: database, onRequest: handle });
	Object.freeze(definition.config.actions);
	Object.freeze(definition.config.options);
	Object.freeze(definition.config);
	Object.freeze(definition);
	const binding = Object.freeze({ actorName, actor: definition, handle });
	registered.set(binding, database);
	return binding;
}
export function isRivetQueueBinding(binding: RivetQueueBinding): boolean {
	return (
		registered.has(binding) &&
		isStaticActorDefinition(binding.actor) &&
		"db" in binding.actor.config &&
		binding.actor.config.db === registered.get(binding) &&
		binding.actor.config.onRequest === binding.handle
	);
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-conditional-empty-object-spread */
