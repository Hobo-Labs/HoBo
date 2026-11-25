import * as DomainRivet from "@alchemy.run/domain/Rivet";
import type { JsonValue } from "@hobo/core";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import {
	CampTargetId,
	type CampTargetId as CampTargetIdType,
	type CdCampRealizer,
	CdPromotionId,
	type CdPromotionId as CdPromotionIdType,
	CdRelease,
	CdReleaseHandlers,
	type CdVerificationGate,
	FreightDigest,
	type FreightDigest as FreightDigestType,
	type NonEmptyReason,
} from "../domain/index.js";

export type CdCampRealizerService = Layer.Success<
	ReturnType<typeof CdCampRealizer.toLayer>
>;

export type CdVerificationGateService = Layer.Success<
	ReturnType<typeof CdVerificationGate.toLayer>
>;

export interface CdReleaseRivetHostOptions<
	PoolReq,
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
> {
	readonly name?: string;
	readonly main: string;
	readonly handler?: string;
	readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
	readonly realizer: Layer.Layer<
		CdCampRealizerService,
		RealizerErr,
		RealizerReq
	>;
	readonly verificationGate: Layer.Layer<
		CdVerificationGateService,
		GateErr,
		GateReq
	>;
}

export function createCdReleaseRivetLayer<
	PoolReq,
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
>(
	options: CdReleaseRivetHostOptions<
		PoolReq,
		RealizerErr,
		RealizerReq,
		GateErr,
		GateReq
	>,
) {
	const rivetPlatform = DomainRivet.layerDurableObjects<PoolReq>({
		name: options.name ?? "CdRelease",
		main: options.main,
		handler: options.handler ?? "default",
		pool: options.pool,
	});
	return CdRelease.layer(CdReleaseHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(rivetPlatform, options.realizer, options.verificationGate),
		),
	);
}

const GateStatusSchema = Schema.Literals([
	"pending",
	"passed",
	"failed",
	"expired",
]);
export type CdPromotionGateStatus = typeof GateStatusSchema.Type;

const GateRowSchema = Schema.Struct({
	promotion_id: Schema.NonEmptyString,
	camp_id: Schema.NonEmptyString,
	freight_digest: Schema.NonEmptyString,
	status: GateStatusSchema,
	summary: Schema.NullOr(Schema.String),
	created_at_ms: Schema.Int,
	deadline_at_ms: Schema.Int,
});

const decodeGateRows = Schema.decodeUnknownSync(Schema.Array(GateRowSchema));

export interface CdPromotionGateRecord {
	readonly promotionId: string;
	readonly campId: string;
	readonly freightDigest: string;
	readonly status: CdPromotionGateStatus;
	readonly summary: string | null;
	readonly createdAtMs: number;
	readonly deadlineAtMs: number;
}

export interface CdPromotionGateEvent {
	readonly action: "opened" | "resolved" | "expired";
	readonly gate: CdPromotionGateRecord;
}

export interface OpenCdPromotionGateInput {
	readonly promotionId: CdPromotionIdType;
	readonly campId: CampTargetIdType;
	readonly freightDigest: FreightDigestType;
	readonly deadlineMs: number;
}

const OpenCdPromotionGateInputSchema = Schema.Struct({
	promotionId: CdPromotionId,
	campId: CampTargetId,
	freightDigest: FreightDigest,
	deadlineMs: Schema.Int,
});

const decodeOpenCdPromotionGateInput = Schema.decodeUnknownSync(
	OpenCdPromotionGateInputSchema,
);

export interface ResolveCdPromotionGateInput {
	readonly promotionId: CdPromotionId;
	readonly passed: boolean;
	readonly summary: NonEmptyReason;
}

function toGateRecord(row: typeof GateRowSchema.Type): CdPromotionGateRecord {
	return {
		promotionId: row.promotion_id,
		campId: row.camp_id,
		freightDigest: row.freight_digest,
		status: row.status,
		summary: row.summary,
		createdAtMs: row.created_at_ms,
		deadlineAtMs: row.deadline_at_ms,
	};
}

export interface CdPromotionGateRegistryOptions {
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

export function createCdPromotionGateRegistry(
	options: CdPromotionGateRegistryOptions = {},
) {
	const promotionGate = actor({
		db: db({
			onMigrate: async (client) => {
				await client.execute(`
					CREATE TABLE IF NOT EXISTS cd_promotion_gates (
						promotion_id TEXT PRIMARY KEY,
						camp_id TEXT NOT NULL,
						freight_digest TEXT NOT NULL,
						status TEXT NOT NULL,
						summary TEXT,
						created_at_ms INTEGER NOT NULL,
						deadline_at_ms INTEGER NOT NULL
					)
				`);
			},
		}),
		actions: {
			openGate: async (
				c,
				raw: JsonValue,
			): Promise<CdPromotionGateRecord> => {
				const input = decodeOpenCdPromotionGateInput(raw);
				const existingRows = decodeGateRows(
					await c.db.execute(
						"SELECT promotion_id, camp_id, freight_digest, status, summary, created_at_ms, deadline_at_ms FROM cd_promotion_gates WHERE promotion_id = ?",
						input.promotionId,
					),
				);
				const existing = existingRows[0];
				if (existing !== undefined) {
					return toGateRecord(existing);
				}

				const nowMs = Date.now();
				const deadlineMs = Math.max(10, Math.trunc(input.deadlineMs));
				const deadlineAtMs = nowMs + deadlineMs;
				await c.db.execute(
					`INSERT INTO cd_promotion_gates
						(promotion_id, camp_id, freight_digest, status, summary, created_at_ms, deadline_at_ms)
					VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
					input.promotionId,
					input.campId,
					input.freightDigest,
					nowMs,
					deadlineAtMs,
				);
				const gate: CdPromotionGateRecord = {
					promotionId: input.promotionId,
					campId: input.campId,
					freightDigest: input.freightDigest,
					status: "pending",
					summary: null,
					createdAtMs: nowMs,
					deadlineAtMs,
				};
				await c.schedule.after(deadlineMs, "expireGate", input.promotionId);
				c.broadcast("gateUpdated", { action: "opened", gate });
				return gate;
			},
			resolveGate: async (
				c,
				input: ResolveCdPromotionGateInput,
			): Promise<CdPromotionGateRecord | null> => {
				const rows = decodeGateRows(
					await c.db.execute(
						"SELECT promotion_id, camp_id, freight_digest, status, summary, created_at_ms, deadline_at_ms FROM cd_promotion_gates WHERE promotion_id = ?",
						input.promotionId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) return null;
				if (existing.status !== "pending") return toGateRecord(existing);

				const nextStatus: CdPromotionGateStatus = input.passed
					? "passed"
					: "failed";
				await c.db.execute(
					"UPDATE cd_promotion_gates SET status = ?, summary = ? WHERE promotion_id = ? AND status = 'pending'",
					nextStatus,
					input.summary,
					input.promotionId,
				);
				const updated: CdPromotionGateRecord = {
					...toGateRecord(existing),
					status: nextStatus,
					summary: input.summary,
				};
				c.broadcast("gateUpdated", { action: "resolved", gate: updated });
				return updated;
			},
			expireGate: async (
				c,
				promotionId: string,
			): Promise<{
				readonly expired: boolean;
				readonly promotionId: string;
			}> => {
				const rows = decodeGateRows(
					await c.db.execute(
						"SELECT promotion_id, camp_id, freight_digest, status, summary, created_at_ms, deadline_at_ms FROM cd_promotion_gates WHERE promotion_id = ?",
						promotionId,
					),
				);
				const existing = rows[0];
				if (existing === undefined || existing.status !== "pending") {
					return { expired: false, promotionId };
				}
				if (Date.now() < existing.deadline_at_ms) {
					return { expired: false, promotionId };
				}
				await c.db.execute(
					"UPDATE cd_promotion_gates SET status = 'expired', summary = 'verification-deadline-elapsed' WHERE promotion_id = ? AND status = 'pending'",
					promotionId,
				);
				const expiredGate: CdPromotionGateRecord = {
					...toGateRecord(existing),
					status: "expired",
					summary: "verification-deadline-elapsed",
				};
				c.broadcast("gateUpdated", { action: "expired", gate: expiredGate });
				return { expired: true, promotionId };
			},
			listGates: async (c): Promise<readonly CdPromotionGateRecord[]> => {
				const rows = decodeGateRows(
					await c.db.execute(
						"SELECT promotion_id, camp_id, freight_digest, status, summary, created_at_ms, deadline_at_ms FROM cd_promotion_gates ORDER BY created_at_ms ASC, promotion_id ASC",
					),
				);
				return rows.map(toGateRecord);
			},
		},
	});

	return setup({
		use: {
			promotionGate,
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
