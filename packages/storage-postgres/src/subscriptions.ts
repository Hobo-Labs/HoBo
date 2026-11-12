import {
	CheckpointRegressionError,
	type EventPosition,
	type FenceToken,
	type PartitionId,
	parsePartitionId,
	parseSubscriptionId,
	StaleFenceError,
	type SubscriptionCheckpoint,
	type SubscriptionId,
	type SubscriptionLease,
} from "@hobo/core";
import { StoragePostgresError } from "./errors.js";
import { requireInt8, requireNonEmpty } from "./parse.js";
import { int8, type PgClientLike, type PgRow, text } from "./pg.js";

/** Parsed (subscription, partition) key. */
export type LeaseKey = Readonly<{
	subscriptionId: SubscriptionId;
	partitionId: PartitionId;
}>;

export function parseLeaseKey(options: {
	subscriptionId: string;
	partitionId: string;
}): LeaseKey {
	return Object.freeze({
		subscriptionId: parseSubscriptionId(options.subscriptionId),
		partitionId: parsePartitionId(options.partitionId),
	});
}

function label(key: LeaseKey): string {
	return `${key.subscriptionId}/${key.partitionId}`;
}

function brandFence(value: bigint): FenceToken {
	// SAFETY: value came from a CHECK (fence_token > 0) int8 column or was range-checked.
	return value as FenceToken;
}

function brandPosition(value: bigint): EventPosition {
	// SAFETY: value came from a CHECK (position >= 0) int8 column or was range-checked.
	return value as EventPosition;
}

function addMs(iso: string, ms: number): string {
	return new Date(Date.parse(iso) + ms).toISOString();
}

type LeaseRow = Readonly<{
	holderId: string;
	fenceToken: bigint;
	expiresAt: string;
	released: boolean;
}>;

function leaseRow(row: PgRow): LeaseRow {
	return {
		holderId: text(row, "holder_id"),
		fenceToken: int8(row, "fence_token"),
		expiresAt: text(row, "expires_at"),
		released: row.released === true,
	};
}

async function lockLease(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
): Promise<LeaseRow | undefined> {
	const result = await client.query(
		`SELECT holder_id, fence_token, expires_at, released
     FROM ${s}.subscription_leases
     WHERE subscription_id = $1 AND partition_id = $2
     FOR UPDATE`,
		[key.subscriptionId, key.partitionId],
	);
	const row = result.rows[0];
	return row === undefined ? undefined : leaseRow(row);
}

function lease(
	key: LeaseKey,
	holderId: string,
	fenceToken: bigint,
	expiresAt: string,
): SubscriptionLease {
	return Object.freeze({
		subscriptionId: key.subscriptionId,
		partitionId: key.partitionId,
		holderId,
		fenceToken: brandFence(fenceToken),
		expiresAt,
	});
}

/**
 * Claim a lease. A free, expired or released lease is granted with the next
 * fence token (tokens never repeat, even across release); a live lease held
 * by someone else is refused with `lease-held`. Re-claiming one's own live
 * lease also rotates the fence, matching `@hobo/storage-sqlite`.
 *
 * Concurrency: the first claimant inserts the row; a racing claimant blocks
 * on the primary key until that commits, then sees the row and is refused.
 */
export async function claimLease(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	holderIdInput: string,
	ttlMs: number,
	now: string,
): Promise<SubscriptionLease> {
	const holderId = requireNonEmpty(holderIdInput, "holderId");
	const expiresAt = addMs(now, ttlMs);
	const inserted = await client.query(
		`INSERT INTO ${s}.subscription_leases
       (subscription_id, partition_id, holder_id, fence_token, expires_at, released)
     VALUES ($1, $2, $3, 1, $4, false)
     ON CONFLICT (subscription_id, partition_id) DO NOTHING
     RETURNING fence_token`,
		[key.subscriptionId, key.partitionId, holderId, expiresAt],
	);
	if (inserted.rows[0] !== undefined) {
		return lease(key, holderId, 1n, expiresAt);
	}
	const current = await lockLease(client, s, key);
	if (current === undefined) {
		throw new StoragePostgresError(
			"unavailable",
			`lease row for ${label(key)} vanished during claim; retry`,
		);
	}
	const live = !current.released && Date.parse(current.expiresAt) > Date.parse(now);
	if (live && current.holderId !== holderId) {
		throw new StoragePostgresError(
			"lease-held",
			`subscription ${label(key)} is leased by ${current.holderId} until ${current.expiresAt} (fence ${current.fenceToken})`,
		);
	}
	const fenceToken = current.fenceToken + 1n;
	await client.query(
		`UPDATE ${s}.subscription_leases
     SET holder_id = $3, fence_token = $4, expires_at = $5, released = false
     WHERE subscription_id = $1 AND partition_id = $2`,
		[key.subscriptionId, key.partitionId, holderId, fenceToken.toString(), expiresAt],
	);
	return lease(key, holderId, fenceToken, expiresAt);
}

/** Verify that `holderId` still owns `fence` on a locked lease row. */
function requireOwner(
	key: LeaseKey,
	current: LeaseRow | undefined,
	holderId: string,
	fence: bigint,
): LeaseRow {
	if (current === undefined) {
		throw new StaleFenceError(label(key), fence, 0n);
	}
	if (current.fenceToken !== fence || current.holderId !== holderId) {
		throw new StaleFenceError(label(key), fence, current.fenceToken);
	}
	if (current.released) {
		throw new StoragePostgresError(
			"lease-not-held",
			`subscription ${label(key)} fence ${fence} was released by ${holderId}`,
		);
	}
	return current;
}

/**
 * Extend a lease without rotating the fence. The fence is the safety
 * property: renewing after expiry succeeds only while nobody has claimed
 * since (the fence is still current); after a takeover it is `STALE_FENCE`.
 */
export async function renewLease(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	holderIdInput: string,
	fenceInput: bigint,
	ttlMs: number,
	now: string,
): Promise<SubscriptionLease> {
	const holderId = requireNonEmpty(holderIdInput, "holderId");
	const fence = requireInt8(fenceInput, "fenceToken");
	requireOwner(key, await lockLease(client, s, key), holderId, fence);
	const expiresAt = addMs(now, ttlMs);
	await client.query(
		`UPDATE ${s}.subscription_leases SET expires_at = $3
     WHERE subscription_id = $1 AND partition_id = $2`,
		[key.subscriptionId, key.partitionId, expiresAt],
	);
	return lease(key, holderId, fence, expiresAt);
}

/** Give a lease up so the next claimant need not wait for expiry. */
export async function releaseLease(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	holderIdInput: string,
	fenceInput: bigint,
	now: string,
): Promise<void> {
	const holderId = requireNonEmpty(holderIdInput, "holderId");
	const fence = requireInt8(fenceInput, "fenceToken");
	const current = await lockLease(client, s, key);
	if (current?.released === true && current.fenceToken === fence) return;
	requireOwner(key, current, holderId, fence);
	await client.query(
		`UPDATE ${s}.subscription_leases SET released = true, expires_at = $3
     WHERE subscription_id = $1 AND partition_id = $2`,
		[key.subscriptionId, key.partitionId, now],
	);
}

function checkpoint(row: PgRow, key: LeaseKey): SubscriptionCheckpoint {
	return Object.freeze({
		subscriptionId: key.subscriptionId,
		partitionId: key.partitionId,
		position: brandPosition(int8(row, "position")),
		fenceToken: brandFence(int8(row, "fence_token")),
		updatedAt: text(row, "updated_at"),
	});
}

export async function loadCheckpoint(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
): Promise<SubscriptionCheckpoint | undefined> {
	const result = await client.query(
		`SELECT position, fence_token, updated_at FROM ${s}.subscription_checkpoints
     WHERE subscription_id = $1 AND partition_id = $2`,
		[key.subscriptionId, key.partitionId],
	);
	const row = result.rows[0];
	return row === undefined ? undefined : checkpoint(row, key);
}

async function appendLog(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	entry: Readonly<{
		position: bigint;
		fence: bigint;
		holderId: string;
		kind: "advance" | "reset";
		now: string;
	}>,
): Promise<void> {
	await client.query(
		`INSERT INTO ${s}.checkpoint_log
       (subscription_id, partition_id, entry, position, fence_token, holder_id, kind, committed_at)
     SELECT $1, $2, COALESCE(MAX(entry), 0) + 1, $3, $4, $5, $6, $7
     FROM ${s}.checkpoint_log WHERE subscription_id = $1 AND partition_id = $2`,
		[
			key.subscriptionId,
			key.partitionId,
			entry.position.toString(),
			entry.fence.toString(),
			entry.holderId,
			entry.kind,
			entry.now,
		],
	);
}

export type CheckpointOutcome = "advanced" | "unchanged";

/**
 * Commit a checkpoint under the lease row lock. Only the current fence may
 * commit (a stale holder gets `STALE_FENCE` and nothing is written);
 * positions never move backwards (`CHECKPOINT_REGRESSION`); every advance is
 * appended to `checkpoint_log`, and re-committing the current position is an
 * idempotent no-op, so no position is ever recorded twice.
 */
export async function commitCheckpoint(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	positionInput: bigint,
	fenceInput: bigint,
	now: string,
): Promise<{ checkpoint: SubscriptionCheckpoint; outcome: CheckpointOutcome }> {
	const position = requireInt8(positionInput, "position");
	const fence = requireInt8(fenceInput, "fenceToken");
	const current = await lockLease(client, s, key);
	if (current === undefined) throw new StaleFenceError(label(key), fence, 0n);
	if (current.fenceToken !== fence) {
		throw new StaleFenceError(label(key), fence, current.fenceToken);
	}
	if (current.released) {
		throw new StoragePostgresError(
			"lease-not-held",
			`subscription ${label(key)} fence ${fence} was released`,
		);
	}
	const existing = await loadCheckpoint(client, s, key);
	if (existing !== undefined && position < existing.position) {
		throw new CheckpointRegressionError(
			key.subscriptionId,
			key.partitionId,
			position,
			existing.position,
		);
	}
	if (existing !== undefined && position === existing.position) {
		await client.query(
			`UPDATE ${s}.subscription_checkpoints SET fence_token = $3
       WHERE subscription_id = $1 AND partition_id = $2`,
			[key.subscriptionId, key.partitionId, fence.toString()],
		);
		return {
			checkpoint: Object.freeze({ ...existing, fenceToken: brandFence(fence) }),
			outcome: "unchanged",
		};
	}
	await client.query(
		`INSERT INTO ${s}.subscription_checkpoints
       (subscription_id, partition_id, position, fence_token, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subscription_id, partition_id) DO UPDATE SET
       position = EXCLUDED.position,
       fence_token = EXCLUDED.fence_token,
       updated_at = EXCLUDED.updated_at`,
		[key.subscriptionId, key.partitionId, position.toString(), fence.toString(), now],
	);
	await appendLog(client, s, key, {
		position,
		fence,
		holderId: current.holderId,
		kind: "advance",
		now,
	});
	return {
		checkpoint: Object.freeze({
			subscriptionId: key.subscriptionId,
			partitionId: key.partitionId,
			position: brandPosition(position),
			fenceToken: brandFence(fence),
			updatedAt: now,
		}),
		outcome: "advanced",
	};
}

/**
 * Administrative reset (may move backwards). Recorded in `checkpoint_log`
 * as a `reset` entry by `holderId`, carrying the lease's current fence (or 1
 * when the subscription was never leased).
 */
export async function resetCheckpoint(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
	positionInput: bigint,
	holderIdInput: string,
	now: string,
): Promise<SubscriptionCheckpoint> {
	const position = requireInt8(positionInput, "position");
	const holderId = requireNonEmpty(holderIdInput, "holderId");
	const current = await lockLease(client, s, key);
	const fence = current?.fenceToken ?? 1n;
	await client.query(
		`INSERT INTO ${s}.subscription_checkpoints
       (subscription_id, partition_id, position, fence_token, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subscription_id, partition_id) DO UPDATE SET
       position = EXCLUDED.position,
       fence_token = EXCLUDED.fence_token,
       updated_at = EXCLUDED.updated_at`,
		[key.subscriptionId, key.partitionId, position.toString(), fence.toString(), now],
	);
	await appendLog(client, s, key, {
		position,
		fence,
		holderId,
		kind: "reset",
		now,
	});
	return Object.freeze({
		subscriptionId: key.subscriptionId,
		partitionId: key.partitionId,
		position: brandPosition(position),
		fenceToken: brandFence(fence),
		updatedAt: now,
	});
}

/** One row of the checkpoint audit log. */
export type CheckpointLogEntry = Readonly<{
	entry: bigint;
	position: EventPosition;
	fenceToken: FenceToken;
	holderId: string;
	kind: "advance" | "reset";
	committedAt: string;
}>;

export async function readCheckpointLog(
	client: PgClientLike,
	s: string,
	key: LeaseKey,
): Promise<readonly CheckpointLogEntry[]> {
	const result = await client.query(
		`SELECT entry, position, fence_token, holder_id, kind, committed_at
     FROM ${s}.checkpoint_log
     WHERE subscription_id = $1 AND partition_id = $2
     ORDER BY entry`,
		[key.subscriptionId, key.partitionId],
	);
	return Object.freeze(
		result.rows.map((row) =>
			Object.freeze({
				entry: int8(row, "entry"),
				position: brandPosition(int8(row, "position")),
				fenceToken: brandFence(int8(row, "fence_token")),
				holderId: text(row, "holder_id"),
				kind: text(row, "kind") === "reset" ? "reset" : "advance",
				committedAt: text(row, "committed_at"),
			}),
		),
	);
}
