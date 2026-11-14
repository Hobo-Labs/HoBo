import type { DurableEffectInput, DurableEffectReceipt } from "@hobo/core";
import { StoragePostgresError } from "./errors.js";
import { type PgClientLike, text } from "./pg.js";
import { JSON_CODEC } from "./rows.js";

function json<T>(value: T): string {
	return JSON.stringify(value ?? {});
}

function deterministicId(prefix: string, parts: readonly string[]): string {
	return `${prefix}:${parts.join(":")}`;
}

/**
 * Stage one durable effect inside the caller's commit transaction, with the
 * same identities and dedupe rules as `@hobo/storage-sqlite`: a retried
 * commit returns the existing effect with `deduped: true`.
 */
export async function stageEffect(
	client: PgClientLike,
	s: string,
	effect: DurableEffectInput,
	now: string,
	createdPosition: bigint,
): Promise<DurableEffectReceipt> {
	const position = createdPosition > 0n ? createdPosition.toString() : null;
	switch (effect.kind) {
		case "queue":
		case "actor-signal": {
			const queueName =
				effect.kind === "queue" ? effect.queueName : `actor:${effect.actorKey}`;
			const messageId = deterministicId("msg", [
				queueName,
				effect.idempotencyKey,
			]);
			const availableAt =
				effect.kind === "queue" ? (effect.availableAt ?? now) : now;
			const inserted = await client.query(
				`INSERT INTO ${s}.queue_messages (
           message_id, queue_name, actor_key, idempotency_key, body_codec, body,
           state, available_at, delivery_attempt, created_position
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 0, $8)
         ON CONFLICT (queue_name, idempotency_key) DO NOTHING
         RETURNING message_id`,
				[
					messageId,
					queueName,
					effect.actorKey ?? null,
					effect.idempotencyKey,
					JSON_CODEC,
					json(effect.body),
					availableAt,
					position,
				],
			);
			const fresh = inserted.rows[0];
			if (fresh !== undefined) {
				return Object.freeze({
					kind: effect.kind,
					id: text(fresh, "message_id"),
					idempotencyKey: effect.idempotencyKey,
					deduped: false,
				});
			}
			const existing = await client.query(
				`SELECT message_id FROM ${s}.queue_messages
         WHERE queue_name = $1 AND idempotency_key = $2`,
				[queueName, effect.idempotencyKey],
			);
			const row = existing.rows[0];
			if (row === undefined) throw lost(effect.kind, effect.idempotencyKey);
			return Object.freeze({
				kind: effect.kind,
				id: text(row, "message_id"),
				idempotencyKey: effect.idempotencyKey,
				deduped: true,
			});
		}
		case "timer": {
			const timerId =
				effect.timerId ??
				deterministicId("timer", [effect.subjectId, effect.idempotencyKey]);
			const inserted = await client.query(
				`INSERT INTO ${s}.durable_timers (
           timer_id, timer_kind, subject_id, idempotency_key, due_at,
           occurrence, payload_codec, payload, created_position
         ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING timer_id`,
				[
					timerId,
					effect.timerKind,
					effect.subjectId,
					effect.idempotencyKey,
					effect.dueAt,
					JSON_CODEC,
					json(effect.payload),
					position,
				],
			);
			if (inserted.rows[0] !== undefined) {
				return Object.freeze({
					kind: "timer",
					id: timerId,
					idempotencyKey: effect.idempotencyKey,
					deduped: false,
				});
			}
			const existing = await client.query(
				`SELECT timer_id FROM ${s}.durable_timers
         WHERE subject_id = $1 AND idempotency_key = $2`,
				[effect.subjectId, effect.idempotencyKey],
			);
			const row = existing.rows[0];
			if (row === undefined) throw lost("timer", effect.idempotencyKey);
			return Object.freeze({
				kind: "timer",
				id: text(row, "timer_id"),
				idempotencyKey: effect.idempotencyKey,
				deduped: true,
			});
		}
		case "cron": {
			const result = await client.query(
				`INSERT INTO ${s}.cron_schedules
           (schedule_id, every_ms, start_at, next_fire_at, occurrence, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (schedule_id) DO UPDATE SET
           every_ms = EXCLUDED.every_ms,
           start_at = EXCLUDED.start_at,
           next_fire_at = EXCLUDED.next_fire_at,
           occurrence = EXCLUDED.occurrence,
           updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS inserted`,
				[
					effect.scheduleId,
					effect.everyMs,
					effect.startAt,
					effect.nextFireAt,
					effect.occurrence ?? 0,
					now,
				],
			);
			return Object.freeze({
				kind: "cron",
				id: effect.scheduleId,
				idempotencyKey: effect.scheduleId,
				deduped: result.rows[0]?.inserted !== true,
			});
		}
		case "outbox": {
			const outboxId = deterministicId("outbox", [
				effect.destination,
				effect.idempotencyKey,
			]);
			const inserted = await client.query(
				`INSERT INTO ${s}.outbox (
           outbox_id, destination, idempotency_key, payload_codec, payload,
           headers_codec, headers, state, available_at, attempt_count, created_position
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 0, $9)
         ON CONFLICT (destination, idempotency_key) DO NOTHING
         RETURNING outbox_id`,
				[
					outboxId,
					effect.destination,
					effect.idempotencyKey,
					JSON_CODEC,
					json(effect.payload),
					JSON_CODEC,
					json(effect.headers ?? {}),
					effect.availableAt ?? now,
					position,
				],
			);
			const fresh = inserted.rows[0];
			if (fresh !== undefined) {
				return Object.freeze({
					kind: "outbox",
					id: text(fresh, "outbox_id"),
					idempotencyKey: effect.idempotencyKey,
					deduped: false,
				});
			}
			const existing = await client.query(
				`SELECT outbox_id FROM ${s}.outbox
         WHERE destination = $1 AND idempotency_key = $2`,
				[effect.destination, effect.idempotencyKey],
			);
			const row = existing.rows[0];
			if (row === undefined) throw lost("outbox", effect.idempotencyKey);
			return Object.freeze({
				kind: "outbox",
				id: text(row, "outbox_id"),
				idempotencyKey: effect.idempotencyKey,
				deduped: true,
			});
		}
		default: {
			const unknownEffect: never = effect;
			throw new StoragePostgresError(
				"invalid-input",
				`unknown effect kind: ${JSON.stringify(unknownEffect)}`,
			);
		}
	}
}

function lost(kind: string, key: string): StoragePostgresError {
	return new StoragePostgresError(
		"invalid-input",
		`${kind} effect ${key} conflicted on its primary key with a different idempotency key`,
	);
}
