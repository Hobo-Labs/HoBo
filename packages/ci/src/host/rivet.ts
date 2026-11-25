import * as DomainRivet from "@alchemy.run/domain/Rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import {
	CiFleet,
	CiFleetHandlers,
	JobDispatchId,
	type JobDispatchId as JobDispatchIdType,
	NonNegativeMicros,
	type NonNegativeMicros as NonNegativeMicrosType,
	type RunnerBackend,
	RunnerPoolId,
	type RunnerPoolId as RunnerPoolIdType,
	type RunnerTier,
	SlotId,
	type SlotId as SlotIdType,
} from "../domain/index.js";

export type RunnerBackendService = Layer.Success<
	ReturnType<typeof RunnerBackend.toLayer>
>;

export interface CiFleetRivetHostOptions<PoolReq, BackendErr, BackendReq> {
	readonly name?: string;
	readonly main: string;
	readonly handler?: string;
	readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
	readonly runnerBackend: Layer.Layer<
		RunnerBackendService,
		BackendErr,
		BackendReq
	>;
}

export function createCiFleetRivetLayer<PoolReq, BackendErr, BackendReq>(
	options: CiFleetRivetHostOptions<PoolReq, BackendErr, BackendReq>,
) {
	const rivetPlatform = DomainRivet.layerDurableObjects<PoolReq>({
		name: options.name ?? "CiFleet",
		main: options.main,
		handler: options.handler ?? "default",
		pool: options.pool,
	});
	return CiFleet.layer(CiFleetHandlers).pipe(
		Layer.provide(Layer.merge(rivetPlatform, options.runnerBackend)),
	);
}

const LeaseStatusSchema = Schema.Literals(["active", "completed", "expired"]);
export type CiStationLeaseStatus = typeof LeaseStatusSchema.Type;

const LeaseRowSchema = Schema.Struct({
	slot_id: Schema.NonEmptyString,
	job_id: Schema.NonEmptyString,
	pool_id: Schema.NonEmptyString,
	tier: Schema.Literals(["local", "hostinger", "agent37", "boat", "hosted"]),
	reserved_micros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	status: LeaseStatusSchema,
	settled_micros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	created_at_ms: Schema.Int,
	expires_at_ms: Schema.Int,
});

const decodeLeaseRows = Schema.decodeUnknownSync(Schema.Array(LeaseRowSchema));

export interface CiStationLeaseRecord {
	readonly slotId: string;
	readonly jobId: string;
	readonly poolId: string;
	readonly tier: RunnerTier;
	readonly reservedMicros: number;
	readonly status: CiStationLeaseStatus;
	readonly settledMicros: number;
	readonly createdAtMs: number;
	readonly expiresAtMs: number;
}

export interface CiStationLeaseEvent {
	readonly action: "acquired" | "completed" | "expired";
	readonly lease: CiStationLeaseRecord;
}

export interface AcquireCiLeaseInput {
	readonly slotId: SlotIdType;
	readonly jobId: JobDispatchIdType;
	readonly poolId: RunnerPoolIdType;
	readonly tier: RunnerTier;
	readonly reservedMicros: NonNegativeMicrosType;
	readonly ttlMs: number;
}

const AcquireCiLeaseInputSchema = Schema.Struct({
	slotId: SlotId,
	jobId: JobDispatchId,
	poolId: RunnerPoolId,
	tier: Schema.Literals(["local", "hostinger", "agent37", "boat", "hosted"]),
	reservedMicros: NonNegativeMicros,
	ttlMs: Schema.Int,
});

const decodeAcquireCiLeaseInput = Schema.decodeSync(AcquireCiLeaseInputSchema);

export interface CompleteCiLeaseInput {
	readonly slotId: SlotIdType;
	readonly settledMicros: NonNegativeMicrosType;
}

const CompleteCiLeaseInputSchema = Schema.Struct({
	slotId: SlotId,
	settledMicros: NonNegativeMicros,
});

const decodeCompleteCiLeaseInput = Schema.decodeSync(
	CompleteCiLeaseInputSchema,
);

function toLeaseRecord(row: typeof LeaseRowSchema.Type): CiStationLeaseRecord {
	return {
		slotId: row.slot_id,
		jobId: row.job_id,
		poolId: row.pool_id,
		tier: row.tier,
		reservedMicros: row.reserved_micros,
		status: row.status,
		settledMicros: row.settled_micros,
		createdAtMs: row.created_at_ms,
		expiresAtMs: row.expires_at_ms,
	};
}

export interface CiStationLeaseRegistryOptions {
	readonly endpoint?: string;
	readonly token?: string;
	readonly httpHost?: string;
	readonly httpPort?: number;
	readonly startEngine?: boolean;
	readonly noWelcome?: boolean;
	readonly shutdown?: {
		readonly gracePeriodMs?: number;
		readonly disableSignalHandlers?: boolean;
	};
}

export function createCiStationLeaseRegistry(
	options: CiStationLeaseRegistryOptions = {},
) {
	const stationLease = actor({
		db: db({
			onMigrate: async (client) => {
				await client.execute(`
					CREATE TABLE IF NOT EXISTS ci_station_leases (
						slot_id TEXT PRIMARY KEY,
						job_id TEXT NOT NULL UNIQUE,
						pool_id TEXT NOT NULL,
						tier TEXT NOT NULL,
						reserved_micros INTEGER NOT NULL,
						status TEXT NOT NULL,
						settled_micros INTEGER NOT NULL,
						created_at_ms INTEGER NOT NULL,
						expires_at_ms INTEGER NOT NULL
					)
				`);
			},
		}),
		actions: {
			acquireLease: async (
				c,
				input: AcquireCiLeaseInput,
			): Promise<CiStationLeaseRecord> => {
				const validated = decodeAcquireCiLeaseInput(input);
				const existingRows = decodeLeaseRows(
					await c.db.execute(
						"SELECT slot_id, job_id, pool_id, tier, reserved_micros, status, settled_micros, created_at_ms, expires_at_ms FROM ci_station_leases WHERE job_id = ?",
						validated.jobId,
					),
				);
				const existing = existingRows[0];
				if (existing !== undefined) {
					return toLeaseRecord(existing);
				}

				const nowMs = Date.now();
				const ttlMs = Math.max(10, Math.trunc(validated.ttlMs));
				const expiresAtMs = nowMs + ttlMs;
				await c.db.execute(
					`INSERT INTO ci_station_leases
						(slot_id, job_id, pool_id, tier, reserved_micros, status, settled_micros, created_at_ms, expires_at_ms)
					VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
					validated.slotId,
					validated.jobId,
					validated.poolId,
					validated.tier,
					validated.reservedMicros,
					nowMs,
					expiresAtMs,
				);
				const lease: CiStationLeaseRecord = {
					slotId: validated.slotId,
					jobId: validated.jobId,
					poolId: validated.poolId,
					tier: validated.tier,
					reservedMicros: validated.reservedMicros,
					status: "active",
					settledMicros: 0,
					createdAtMs: nowMs,
					expiresAtMs,
				};
				await c.schedule.after(ttlMs, "expireLease", validated.slotId);
				c.broadcast("leaseUpdated", { action: "acquired", lease });
				return lease;
			},
			completeLease: async (
				c,
				input: CompleteCiLeaseInput,
			): Promise<CiStationLeaseRecord | null> => {
				const validated = decodeCompleteCiLeaseInput(input);
				const rows = decodeLeaseRows(
					await c.db.execute(
						"SELECT slot_id, job_id, pool_id, tier, reserved_micros, status, settled_micros, created_at_ms, expires_at_ms FROM ci_station_leases WHERE slot_id = ?",
						validated.slotId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) return null;
				if (existing.status !== "active") return toLeaseRecord(existing);

				await c.db.execute(
					"UPDATE ci_station_leases SET status = 'completed', settled_micros = ? WHERE slot_id = ? AND status = 'active'",
					validated.settledMicros,
					validated.slotId,
				);
				const updated: CiStationLeaseRecord = {
					...toLeaseRecord(existing),
					status: "completed",
					settledMicros: validated.settledMicros,
				};
				c.broadcast("leaseUpdated", { action: "completed", lease: updated });
				return updated;
			},
			expireLease: async (
				c,
				slotId: string,
			): Promise<{ readonly expired: boolean; readonly slotId: string }> => {
				const rows = decodeLeaseRows(
					await c.db.execute(
						"SELECT slot_id, job_id, pool_id, tier, reserved_micros, status, settled_micros, created_at_ms, expires_at_ms FROM ci_station_leases WHERE slot_id = ?",
						slotId,
					),
				);
				const existing = rows[0];
				if (existing === undefined || existing.status !== "active") {
					return { expired: false, slotId };
				}
				if (Date.now() < existing.expires_at_ms) {
					return { expired: false, slotId };
				}
				await c.db.execute(
					"UPDATE ci_station_leases SET status = 'expired' WHERE slot_id = ? AND status = 'active'",
					slotId,
				);
				const expiredLease: CiStationLeaseRecord = {
					...toLeaseRecord(existing),
					status: "expired",
				};
				c.broadcast("leaseUpdated", {
					action: "expired",
					lease: expiredLease,
				});
				return { expired: true, slotId };
			},
			listLeases: async (c): Promise<readonly CiStationLeaseRecord[]> => {
				const rows = decodeLeaseRows(
					await c.db.execute(
						"SELECT slot_id, job_id, pool_id, tier, reserved_micros, status, settled_micros, created_at_ms, expires_at_ms FROM ci_station_leases ORDER BY created_at_ms ASC, slot_id ASC",
					),
				);
				return rows.map(toLeaseRecord);
			},
		},
	});

	return setup({
		use: {
			stationLease,
		},
		...(options.endpoint !== undefined
			? { endpoint: options.endpoint }
			: undefined),
		...(options.token !== undefined ? { token: options.token } : undefined),
		...(options.httpHost !== undefined
			? { httpHost: options.httpHost }
			: undefined),
		...(options.httpPort !== undefined
			? { httpPort: options.httpPort }
			: undefined),
		...(options.startEngine !== undefined
			? { startEngine: options.startEngine }
			: undefined),
		...(options.noWelcome !== undefined
			? { noWelcome: options.noWelcome }
			: undefined),
		...(options.shutdown !== undefined
			? { shutdown: options.shutdown }
			: undefined),
	});
}
