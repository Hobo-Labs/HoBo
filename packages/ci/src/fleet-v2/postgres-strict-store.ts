/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-conditional-empty-object-spread */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
	type CapacityGroup,
	CapacityGroupSchema,
	type CiDemand,
	CiDemandSchema,
	type ControllerIncarnation,
	ControllerIncarnationSchema,
	type Effect,
	EffectSchema,
	type ExecutionClaim,
	ExecutionClaimSchema,
	type ExecutionProfile,
	ExecutionProfileSchema,
	type FleetEvent,
	FleetEventSchema,
	FleetEventType,
	FleetRejectionCode,
	ObservationSchema,
	type OfferAdmission,
	OfferAdmissionSchema,
	type Outbox,
	OutboxSchema,
	type RunnerSlot,
	RunnerSlotSchema,
	type WorkerDelivery,
	WorkerDeliverySchema,
} from "../_generated/fleet_v2_pb.js";
import {
	executionAccountId,
	executionKeyId,
	type ParsedCapacityGroup,
	type ParsedCiDemand,
	type ParsedControllerIncarnation,
	type ParsedDaggerStartInput,
	type ParsedExecutionKey,
	type ParsedExecutionProfile,
	type ParsedObservation,
	type ParsedOfferAdmission,
	type ParsedStartBindingInput,
} from "./parse.js";
import {
	CAPACITY_GROUP_STATES,
	type CapacityGroupState,
	type CiDemandState,
	type EffectState,
	type ExecutionClaimState,
	type RunnerSlotState,
	rejectFleet,
	transitionCapacityGroup,
	transitionCiDemand,
	transitionEffect,
	transitionExecutionClaim,
	transitionRunnerSlot,
} from "./state-machine.js";
import type {
	CompleteExecutionInput,
	EffectClaimInput,
	EffectFenceInput,
	ReserveCapacityInput,
	StrictFleetStore,
} from "./strict-store.js";

const Body = z.object({ body: z.string() });
const Now = z.object({ now: z.string() });
const DaggerAllocation = z.object({
	claim_id: z.string(),
	account_id: z.string(),
	pipeline_id: z.string(),
	capacity_group_id: z.string(),
	capacity_cost_units: z.number().int().positive(),
	engine_endpoint_hash: z.string(),
	offer_observation_hash: z.string(),
	policy_revision: z.number().int().positive(),
});
const NOW_SQL = `to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function body(row: unknown): string {
	return Body.parse(row).body;
}

function positiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff)
		rejectFleet(FleetRejectionCode.INVALID_RECORD, `invalid ${field}`);
}

function leaseDuration(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 300000)
		rejectFleet(FleetRejectionCode.INVALID_RECORD, "invalid delivery lease");
}

export class PostgresStrictFleetStore implements StrictFleetStore {
	private initialization: Promise<void> | undefined;

	constructor(
		private readonly pool: Pool,
		private readonly partition = "default",
	) {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(partition))
			throw new Error("invalid fleet partition");
	}

	initialize(): Promise<void> {
		this.initialization ??= this.initializeOnce();
		return this.initialization;
	}

	private async initializeOnce(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-fleet-v2-schema'))",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_partitions(id text PRIMARY KEY)",
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_incarnations(
				 partition_id text NOT NULL,id text NOT NULL,current boolean NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,id))`,
			);
			await client.query(
				`CREATE UNIQUE INDEX IF NOT EXISTS hobo_ci_fleet_v2_one_incarnation
				 ON hobo_ci_fleet_v2_incarnations(partition_id) WHERE current`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_profiles(
				 partition_id text NOT NULL,id text NOT NULL,body text NOT NULL,PRIMARY KEY(partition_id,id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_offers(
				 partition_id text NOT NULL,offer_id text NOT NULL,account_id text NOT NULL,
				 observation_hash text NOT NULL,policy_revision integer NOT NULL,state text NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,offer_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_demands(
				 partition_id text NOT NULL,key text NOT NULL,account_id text NOT NULL,state text NOT NULL,
				 policy_revision integer NOT NULL,required_profile_id text NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,key))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_demand_deliveries(
				 partition_id text NOT NULL,delivery_id text NOT NULL,demand_key text NOT NULL,
				 PRIMARY KEY(partition_id,delivery_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_capacity_groups(
				 partition_id text NOT NULL,id text NOT NULL,account_id text NOT NULL,
				 approved_units integer NOT NULL,reserved_units integer NOT NULL,seq integer NOT NULL,
				 state text NOT NULL,body text NOT NULL,PRIMARY KEY(partition_id,id),
				 CHECK(reserved_units>=0 AND reserved_units<=approved_units))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_runner_slots(
				 partition_id text NOT NULL,id text NOT NULL,account_id text NOT NULL,offer_id text NOT NULL,
				 profile_id text NOT NULL,runner_name text NOT NULL,state text NOT NULL,capacity_group_id text NOT NULL,
				 capacity_cost_units integer NOT NULL,offer_observation_hash text NOT NULL,binding_secret_hash text NOT NULL,
				 incarnation_id text NOT NULL,demand_key text,body text NOT NULL,PRIMARY KEY(partition_id,id),
				 UNIQUE(partition_id,account_id,runner_name))`,
			);
			await client.query(
				`CREATE UNIQUE INDEX IF NOT EXISTS hobo_ci_fleet_v2_one_open_slot_per_demand
				 ON hobo_ci_fleet_v2_runner_slots(partition_id,demand_key)
				 WHERE state IN ('reserved','provisioning','registered','bound')`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_fleet_v2_unresolved_slot_per_demand
				 ON hobo_ci_fleet_v2_runner_slots(partition_id,demand_key)
				 WHERE state IN ('draining','uncertain')`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_execution_claims(
				 partition_id text NOT NULL,id text NOT NULL,key text NOT NULL,runner_slot_id text NOT NULL,
				 state text NOT NULL,start_authorized_at text NOT NULL,body text NOT NULL,PRIMARY KEY(partition_id,id),
				 UNIQUE(partition_id,key),UNIQUE(partition_id,runner_slot_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_dagger_allocations(
				 partition_id text NOT NULL,claim_id text NOT NULL,account_id text NOT NULL,pipeline_id text NOT NULL,
				 capacity_group_id text NOT NULL,capacity_cost_units integer NOT NULL,engine_endpoint_hash text NOT NULL,
				 offer_observation_hash text NOT NULL,policy_revision integer NOT NULL,PRIMARY KEY(partition_id,claim_id),
				 UNIQUE(partition_id,account_id,pipeline_id))`,
			);
			await client.query(
				`CREATE OR REPLACE FUNCTION hobo_ci_fleet_v2_immutable_start_time() RETURNS trigger LANGUAGE plpgsql AS $$
				 BEGIN IF OLD.start_authorized_at<>NEW.start_authorized_at THEN RAISE EXCEPTION 'start authorization time is immutable'; END IF; RETURN NEW; END; $$`,
			);
			await client.query(
				`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='hobo_ci_fleet_v2_start_time_immutable') THEN
				 CREATE TRIGGER hobo_ci_fleet_v2_start_time_immutable BEFORE UPDATE OF start_authorized_at
				 ON hobo_ci_fleet_v2_execution_claims FOR EACH ROW EXECUTE FUNCTION hobo_ci_fleet_v2_immutable_start_time(); END IF; END; $$`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_effects(
				 partition_id text NOT NULL,id text NOT NULL,subject_type text NOT NULL,subject_id text NOT NULL,
				 kind text NOT NULL,sequence integer NOT NULL,state text NOT NULL,idempotency_key text NOT NULL,
				 provider_scope text NOT NULL,next_fence integer NOT NULL,body text NOT NULL,PRIMARY KEY(partition_id,id),
				 UNIQUE(partition_id,subject_type,subject_id,kind,sequence),UNIQUE(partition_id,provider_scope,idempotency_key))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_outbox(
				 partition_id text NOT NULL,id text NOT NULL,effect_id text NOT NULL,state text NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,id),UNIQUE(partition_id,effect_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_deliveries(
				 partition_id text NOT NULL,id text NOT NULL,effect_id text NOT NULL,worker_id text NOT NULL,
				 owner_epoch integer NOT NULL,fence integer NOT NULL,expires_at text NOT NULL,state text NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,id),UNIQUE(partition_id,effect_id,fence))`,
			);
			await client.query(
				`CREATE UNIQUE INDEX IF NOT EXISTS hobo_ci_fleet_v2_one_active_delivery
				 ON hobo_ci_fleet_v2_deliveries(partition_id,effect_id) WHERE state='claimed'`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_observations(
				 partition_id text NOT NULL,worker_id text NOT NULL,sequence integer NOT NULL,body text NOT NULL,
				 PRIMARY KEY(partition_id,worker_id,sequence))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_observation_watermarks(
				 partition_id text NOT NULL,worker_id text NOT NULL,account_id text NOT NULL,sequence integer NOT NULL,
				 PRIMARY KEY(partition_id,worker_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_capacity_releases(
				 partition_id text NOT NULL,claim_id text NOT NULL,capacity_group_id text NOT NULL,
				 units integer NOT NULL,released_at text NOT NULL,PRIMARY KEY(partition_id,claim_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_fleet_v2_events(
				 seq bigserial PRIMARY KEY,partition_id text NOT NULL,id text NOT NULL,body text NOT NULL,
				 UNIQUE(partition_id,id))`,
			);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_partitions(id) VALUES($1) ON CONFLICT DO NOTHING",
				[this.partition],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			this.initialization = undefined;
			throw error;
		} finally {
			client.release();
		}
	}

	private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
		await this.initialize();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const locked = await client.query(
				"SELECT id FROM hobo_ci_fleet_v2_partitions WHERE id=$1 FOR UPDATE",
				[this.partition],
			);
			if (locked.rowCount !== 1) throw new Error("fleet partition missing");
			const output = await fn(client);
			await client.query("COMMIT");
			return output;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async now(client: PoolClient): Promise<string> {
		const result = await client.query(`SELECT ${NOW_SQL} AS now`);
		return Now.parse(result.rows[0]).now;
	}

	private async expiry(client: PoolClient, leaseMs: number): Promise<string> {
		const result = await client.query(
			`SELECT to_char((now()+($1*interval '1 millisecond')) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
			[leaseMs],
		);
		return Now.parse(result.rows[0]).now;
	}

	private async event(
		client: PoolClient,
		type: FleetEventType,
		at: string,
		accountId: string,
		subjectType: string,
		subjectId: string,
		executionKey?: import("../_generated/fleet_v2_pb.js").ExecutionKey,
		incarnationId?: string,
	): Promise<void> {
		const id = randomUUID();
		const event = create(FleetEventSchema, {
			id,
			type,
			at,
			accountId,
			subjectType,
			subjectId,
			...(executionKey ? { executionKey } : {}),
			...(incarnationId ? { incarnationId } : {}),
		});
		await client.query(
			"INSERT INTO hobo_ci_fleet_v2_events(partition_id,id,body) VALUES($1,$2,$3)",
			[this.partition, id, toJsonString(FleetEventSchema, event)],
		);
	}

	private async demandInside(
		client: PoolClient,
		key: string,
		lock = false,
	): Promise<CiDemand | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_demands WHERE partition_id=$1 AND key=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, key],
		);
		return result.rows[0]
			? fromJsonString(CiDemandSchema, body(result.rows[0]))
			: undefined;
	}

	private async slotInside(
		client: PoolClient,
		id: string,
		lock = false,
	): Promise<RunnerSlot | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_runner_slots WHERE partition_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(RunnerSlotSchema, body(result.rows[0]))
			: undefined;
	}

	private async claimInside(
		client: PoolClient,
		key: string,
		lock = false,
	): Promise<ExecutionClaim | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_execution_claims WHERE partition_id=$1 AND key=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, key],
		);
		return result.rows[0]
			? fromJsonString(ExecutionClaimSchema, body(result.rows[0]))
			: undefined;
	}

	private async claimByIdInside(
		client: PoolClient,
		id: string,
		lock = false,
	): Promise<ExecutionClaim | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_execution_claims WHERE partition_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(ExecutionClaimSchema, body(result.rows[0]))
			: undefined;
	}

	private async capacityInside(
		client: PoolClient,
		id: string,
		lock = false,
	): Promise<CapacityGroup | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_capacity_groups WHERE partition_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(CapacityGroupSchema, body(result.rows[0]))
			: undefined;
	}

	private async effectInside(
		client: PoolClient,
		id: string,
		lock = false,
	): Promise<Effect | undefined> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_effects WHERE partition_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(EffectSchema, body(result.rows[0]))
			: undefined;
	}

	private async offerInside(
		client: PoolClient,
		id: string,
	): Promise<OfferAdmission | undefined> {
		const result = await client.query(
			"SELECT body FROM hobo_ci_fleet_v2_offers WHERE partition_id=$1 AND offer_id=$2",
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(OfferAdmissionSchema, body(result.rows[0]))
			: undefined;
	}

	private async profileInside(
		client: PoolClient,
		id: string,
	): Promise<ExecutionProfile | undefined> {
		const result = await client.query(
			"SELECT body FROM hobo_ci_fleet_v2_profiles WHERE partition_id=$1 AND id=$2",
			[this.partition, id],
		);
		return result.rows[0]
			? fromJsonString(ExecutionProfileSchema, body(result.rows[0]))
			: undefined;
	}

	private async outboxInside(
		client: PoolClient,
		effectId: string,
	): Promise<Outbox | undefined> {
		const result = await client.query(
			"SELECT body FROM hobo_ci_fleet_v2_outbox WHERE partition_id=$1 AND effect_id=$2",
			[this.partition, effectId],
		);
		return result.rows[0]
			? fromJsonString(OutboxSchema, body(result.rows[0]))
			: undefined;
	}

	private async currentIncarnationInside(
		client: PoolClient,
	): Promise<ControllerIncarnation | undefined> {
		const result = await client.query(
			"SELECT body FROM hobo_ci_fleet_v2_incarnations WHERE partition_id=$1 AND current",
			[this.partition],
		);
		return result.rows[0]
			? fromJsonString(ControllerIncarnationSchema, body(result.rows[0]))
			: undefined;
	}

	private async saveDemand(
		client: PoolClient,
		demand: CiDemand,
	): Promise<void> {
		await client.query(
			"UPDATE hobo_ci_fleet_v2_demands SET state=$3,body=$4 WHERE partition_id=$1 AND key=$2",
			[
				this.partition,
				executionKeyId(demand.key),
				demand.state,
				toJsonString(CiDemandSchema, demand),
			],
		);
	}

	private async saveSlot(client: PoolClient, slot: RunnerSlot): Promise<void> {
		await client.query(
			"UPDATE hobo_ci_fleet_v2_runner_slots SET state=$3,body=$4 WHERE partition_id=$1 AND id=$2",
			[
				this.partition,
				slot.id,
				slot.state,
				toJsonString(RunnerSlotSchema, slot),
			],
		);
	}

	private async saveClaim(
		client: PoolClient,
		claim: ExecutionClaim,
	): Promise<void> {
		await client.query(
			"UPDATE hobo_ci_fleet_v2_execution_claims SET state=$3,body=$4 WHERE partition_id=$1 AND id=$2",
			[
				this.partition,
				claim.id,
				claim.state,
				toJsonString(ExecutionClaimSchema, claim),
			],
		);
	}

	private async saveCapacity(
		client: PoolClient,
		group: CapacityGroup,
	): Promise<void> {
		await client.query(
			`UPDATE hobo_ci_fleet_v2_capacity_groups SET approved_units=$3,reserved_units=$4,seq=$5,state=$6,body=$7
			 WHERE partition_id=$1 AND id=$2`,
			[
				this.partition,
				group.id,
				group.approvedUnits,
				group.reservedUnits,
				group.seq,
				group.state,
				toJsonString(CapacityGroupSchema, group),
			],
		);
	}

	private async saveEffect(client: PoolClient, effect: Effect): Promise<void> {
		await client.query(
			"UPDATE hobo_ci_fleet_v2_effects SET state=$3,body=$4 WHERE partition_id=$1 AND id=$2",
			[
				this.partition,
				effect.id,
				effect.state,
				toJsonString(EffectSchema, effect),
			],
		);
	}

	private async saveOutbox(client: PoolClient, outbox: Outbox): Promise<void> {
		await client.query(
			"UPDATE hobo_ci_fleet_v2_outbox SET state=$3,body=$4 WHERE partition_id=$1 AND effect_id=$2",
			[
				this.partition,
				outbox.effectId,
				outbox.state,
				toJsonString(OutboxSchema, outbox),
			],
		);
	}

	createIncarnation(incarnation: ParsedControllerIncarnation): Promise<void> {
		return this.tx(async (client) => {
			await client.query(
				"UPDATE hobo_ci_fleet_v2_incarnations SET current=false WHERE partition_id=$1 AND current",
				[this.partition],
			);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_incarnations(partition_id,id,current,body) VALUES($1,$2,true,$3)",
				[
					this.partition,
					incarnation.id,
					toJsonString(ControllerIncarnationSchema, incarnation),
				],
			);
			await this.event(
				client,
				FleetEventType.CONTROLLER_INCARNATION_CREATED,
				incarnation.createdAt,
				"system",
				"controller-incarnation",
				incarnation.id,
				undefined,
				incarnation.id,
			);
		});
	}

	currentIncarnation(): Promise<ControllerIncarnation | undefined> {
		return this.tx((client) => this.currentIncarnationInside(client));
	}

	putExecutionProfile(profile: ParsedExecutionProfile): Promise<void> {
		return this.tx(async (client) => {
			const existing = await this.profileInside(client, profile.id);
			if (
				existing &&
				toJsonString(ExecutionProfileSchema, existing) !==
					toJsonString(ExecutionProfileSchema, profile)
			)
				rejectFleet(
					FleetRejectionCode.PROFILE_INCOMPATIBLE,
					"execution profile definitions are immutable",
				);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_profiles(partition_id,id,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
				[
					this.partition,
					profile.id,
					toJsonString(ExecutionProfileSchema, profile),
				],
			);
		});
	}

	putOfferAdmission(offer: ParsedOfferAdmission): Promise<void> {
		return this.tx(async (client) => {
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_offers(partition_id,offer_id,account_id,observation_hash,policy_revision,state,body)
				 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(partition_id,offer_id) DO UPDATE SET
				 observation_hash=EXCLUDED.observation_hash,policy_revision=EXCLUDED.policy_revision,state=EXCLUDED.state,body=EXCLUDED.body`,
				[
					this.partition,
					offer.offerId,
					offer.accountId,
					offer.observationHash,
					offer.policyRevision,
					offer.state,
					toJsonString(OfferAdmissionSchema, offer),
				],
			);
		});
	}

	putCapacityGroup(group: ParsedCapacityGroup): Promise<CapacityGroup> {
		return this.tx(async (client) => {
			const existing = await this.capacityInside(client, group.id);
			if (!existing) {
				if (group.seq !== 0)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"new capacity sequence must be zero",
					);
				await client.query(
					`INSERT INTO hobo_ci_fleet_v2_capacity_groups(partition_id,id,account_id,approved_units,reserved_units,seq,state,body)
					 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
					[
						this.partition,
						group.id,
						group.accountId,
						group.approvedUnits,
						group.reservedUnits,
						group.seq,
						group.state,
						toJsonString(CapacityGroupSchema, group),
					],
				);
				return group;
			}
			if (
				existing.seq !== group.seq ||
				existing.reservedUnits !== group.reservedUnits ||
				existing.accountId !== group.accountId
			)
				rejectFleet(
					FleetRejectionCode.CAPACITY_CONFLICT,
					"capacity group update conflict",
				);
			transitionCapacityGroup(
				existing.state as CapacityGroupState,
				group.state as CapacityGroupState,
			);
			const updated = clone(CapacityGroupSchema, group);
			updated.seq += 1;
			const changed = await client.query(
				`UPDATE hobo_ci_fleet_v2_capacity_groups SET approved_units=$3,seq=seq+1,state=$4,body=$5
				 WHERE partition_id=$1 AND id=$2 AND seq=$6 AND reserved_units=$7`,
				[
					this.partition,
					group.id,
					updated.approvedUnits,
					updated.state,
					toJsonString(CapacityGroupSchema, updated),
					group.seq,
					group.reservedUnits,
				],
			);
			if (changed.rowCount !== 1)
				rejectFleet(
					FleetRejectionCode.CAPACITY_CONFLICT,
					"capacity group update conflict",
				);
			if (updated.state === "quarantined")
				await this.event(
					client,
					FleetEventType.CAPACITY_QUARANTINED,
					await this.now(client),
					updated.accountId,
					"capacity-group",
					updated.id,
				);
			return updated;
		});
	}

	intake(
		demand: ParsedCiDemand,
	): Promise<{ demand: CiDemand; duplicate: boolean }> {
		return this.tx(async (client) => {
			const key = executionKeyId(demand.key);
			for (const deliveryId of demand.sourceDeliveryIds) {
				const result = await client.query(
					"SELECT demand_key FROM hobo_ci_fleet_v2_demand_deliveries WHERE partition_id=$1 AND delivery_id=$2",
					[this.partition, deliveryId],
				);
				if (
					result.rows[0] &&
					z.string().parse(result.rows[0].demand_key) !== key
				)
					rejectFleet(
						FleetRejectionCode.DEMAND_CONFLICT,
						"source delivery belongs to another demand",
					);
			}
			const existing = await this.demandInside(client, key, true);
			if (!existing) {
				await client.query(
					`INSERT INTO hobo_ci_fleet_v2_demands(partition_id,key,account_id,state,policy_revision,required_profile_id,body)
					 VALUES($1,$2,$3,$4,$5,$6,$7)`,
					[
						this.partition,
						key,
						executionAccountId(demand.key),
						demand.state,
						demand.policyRevision,
						demand.requiredProfileId,
						toJsonString(CiDemandSchema, demand),
					],
				);
				for (const deliveryId of demand.sourceDeliveryIds)
					await client.query(
						"INSERT INTO hobo_ci_fleet_v2_demand_deliveries(partition_id,delivery_id,demand_key) VALUES($1,$2,$3)",
						[this.partition, deliveryId, key],
					);
				await this.event(
					client,
					FleetEventType.DEMAND_OBSERVED,
					demand.lastObservedAt,
					executionAccountId(demand.key),
					"demand",
					key,
					demand.key,
				);
				return { demand, duplicate: false };
			}
			if (
				existing.policyRevision !== demand.policyRevision ||
				existing.requiredProfileId !== demand.requiredProfileId
			)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"demand identity changed policy or profile",
				);
			const updated = clone(CiDemandSchema, existing);
			updated.lastObservedAt =
				Date.parse(existing.lastObservedAt) >= Date.parse(demand.lastObservedAt)
					? existing.lastObservedAt
					: demand.lastObservedAt;
			const deliveries = new Set(updated.sourceDeliveryIds);
			for (const deliveryId of demand.sourceDeliveryIds)
				deliveries.add(deliveryId);
			updated.sourceDeliveryIds = [...deliveries].sort();
			if (existing.state === "observed" && demand.state === "eligible") {
				transitionCiDemand("observed", "eligible");
				updated.state = "eligible";
			}
			for (const deliveryId of demand.sourceDeliveryIds)
				await client.query(
					"INSERT INTO hobo_ci_fleet_v2_demand_deliveries(partition_id,delivery_id,demand_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
					[this.partition, deliveryId, key],
				);
			await this.saveDemand(client, updated);
			await this.event(
				client,
				FleetEventType.DEMAND_DEDUPLICATED,
				updated.lastObservedAt,
				executionAccountId(demand.key),
				"demand",
				key,
				demand.key,
			);
			return { demand: updated, duplicate: true };
		});
	}

	reserveCapacity(input: ReserveCapacityInput): Promise<RunnerSlot> {
		return this.tx(async (client) => {
			if (input.demandKey.key.case !== "githubJob")
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"runner slots require a GitHub job",
				);
			positiveInteger(input.expectedPolicyRevision, "policy revision");
			if (
				!Number.isSafeInteger(input.expectedCapacitySeq) ||
				input.expectedCapacitySeq < 0
			)
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"invalid capacity sequence",
				);
			const key = executionKeyId(input.demandKey);
			const demand = await this.demandInside(client, key, true);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "demand not found");
			const current = await this.currentIncarnationInside(client);
			if (!current || input.slot.incarnationId !== current.id)
				rejectFleet(
					FleetRejectionCode.INCARNATION_STALE,
					"slot belongs to a stale controller incarnation",
				);
			if (
				input.slot.state !== "reserved" ||
				input.slot.accountId !== executionAccountId(input.demandKey) ||
				input.slot.profileId !== demand.requiredProfileId ||
				demand.policyRevision !== input.expectedPolicyRevision
			)
				rejectFleet(
					FleetRejectionCode.POLICY_REVISION_CONFLICT,
					"admission snapshot does not match demand",
				);
			if (
				!["observed", "eligible"].includes(demand.state) ||
				(await this.claimInside(client, key))
			)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"demand is not available for admission",
				);
			const offer = await this.offerInside(client, input.slot.offerId);
			if (!offer || offer.accountId !== input.slot.accountId)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "Offer admission not found");
			if (offer.state !== "active")
				rejectFleet(FleetRejectionCode.OFFER_REVOKED, "Offer is revoked");
			if (
				offer.policyRevision !== input.expectedPolicyRevision ||
				offer.observationHash !== input.slot.offerObservationHash
			)
				rejectFleet(
					FleetRejectionCode.OFFER_OBSERVATION_CONFLICT,
					"Offer observation or policy changed before admission",
				);
			const profile = await this.profileInside(client, input.slot.profileId);
			if (!profile)
				rejectFleet(
					FleetRejectionCode.NOT_FOUND,
					"execution profile not found",
				);
			if (profile.guarantee !== "start-fenced")
				rejectFleet(
					FleetRejectionCode.GUARANTEE_REQUIRED,
					"strict admission requires a start-fenced profile",
				);
			if (
				input.effect.subjectType !== "runner-slot" ||
				input.effect.subjectId !== input.slot.id ||
				input.effect.state !== "planned" ||
				input.outbox.effectId !== input.effect.id ||
				input.outbox.state !== "pending"
			)
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"reservation effect/outbox linkage is invalid",
				);
			const group = await this.capacityInside(
				client,
				input.slot.capacityGroupId,
			);
			if (!group)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
			if (group.accountId !== executionAccountId(input.demandKey))
				rejectFleet(
					FleetRejectionCode.CAPACITY_INELIGIBLE,
					"capacity group account does not match demand account",
				);
			const unresolvedSlot = await client.query(
				`SELECT id FROM hobo_ci_fleet_v2_runner_slots
				 WHERE partition_id=$1 AND demand_key=$2 AND state IN ('reserved','provisioning','registered','bound','draining','uncertain') FOR UPDATE`,
				[this.partition, key],
			);
			if ((unresolvedSlot.rowCount ?? 0) > 0)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"demand already has an open capacity reservation",
				);
			const reserved = await client.query(
				`UPDATE hobo_ci_fleet_v2_capacity_groups SET reserved_units=reserved_units+$3,seq=seq+1
				 WHERE partition_id=$1 AND id=$2 AND seq=$4 AND state='active' AND reserved_units+$3<=approved_units`,
				[
					this.partition,
					group.id,
					input.slot.capacityCostUnits,
					input.expectedCapacitySeq,
				],
			);
			if (reserved.rowCount !== 1) {
				const latest = await this.capacityInside(client, group.id);
				if (latest?.seq !== input.expectedCapacitySeq)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"capacity sequence changed before admission",
					);
				if (latest?.state !== "active")
					rejectFleet(
						FleetRejectionCode.CAPACITY_INELIGIBLE,
						"capacity group is not active",
					);
				rejectFleet(
					FleetRejectionCode.CAPACITY_EXHAUSTED,
					"capacity group has insufficient units",
				);
			}
			const at = await this.now(client);
			const slot = clone(RunnerSlotSchema, input.slot);
			slot.createdAt = at;
			const effect = clone(EffectSchema, input.effect);
			effect.createdAt = at;
			const outbox = clone(OutboxSchema, input.outbox);
			outbox.createdAt = at;
			outbox.availableAt = at;
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_runner_slots(partition_id,id,account_id,offer_id,profile_id,runner_name,state,
				 capacity_group_id,capacity_cost_units,offer_observation_hash,binding_secret_hash,incarnation_id,demand_key,body)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
				[
					this.partition,
					slot.id,
					slot.accountId,
					slot.offerId,
					slot.profileId,
					slot.runnerName,
					slot.state,
					slot.capacityGroupId,
					slot.capacityCostUnits,
					slot.offerObservationHash,
					slot.bindingSecretHash,
					slot.incarnationId,
					key,
					toJsonString(RunnerSlotSchema, slot),
				],
			);
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_effects(partition_id,id,subject_type,subject_id,kind,sequence,state,
				 idempotency_key,provider_scope,next_fence,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)`,
				[
					this.partition,
					effect.id,
					effect.subjectType,
					effect.subjectId,
					effect.kind,
					effect.sequence,
					effect.state,
					effect.idempotencyKey,
					effect.providerScope,
					toJsonString(EffectSchema, effect),
				],
			);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_outbox(partition_id,id,effect_id,state,body) VALUES($1,$2,$3,$4,$5)",
				[
					this.partition,
					outbox.id,
					outbox.effectId,
					outbox.state,
					toJsonString(OutboxSchema, outbox),
				],
			);
			const updatedGroup = clone(CapacityGroupSchema, group);
			updatedGroup.reservedUnits += slot.capacityCostUnits;
			updatedGroup.seq += 1;
			await this.saveCapacity(client, updatedGroup);
			const updatedDemand = clone(CiDemandSchema, demand);
			transitionCiDemand(demand.state as CiDemandState, "eligible");
			updatedDemand.state = "eligible";
			await this.saveDemand(client, updatedDemand);
			await this.event(
				client,
				FleetEventType.CAPACITY_RESERVED,
				at,
				slot.accountId,
				"runner-slot",
				slot.id,
				input.demandKey,
				current.id,
			);
			await this.event(
				client,
				FleetEventType.EFFECT_PLANNED,
				at,
				slot.accountId,
				"effect",
				effect.id,
				input.demandKey,
				current.id,
			);
			return slot;
		});
	}

	transitionRunnerSlot(
		id: string,
		expected: RunnerSlotState,
		next: RunnerSlotState,
		externalRunnerId?: string,
	): Promise<RunnerSlot> {
		return this.tx(async (client) => {
			const slot = await this.slotInside(client, id, true);
			if (!slot)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "runner slot not found");
			if (slot.state !== expected)
				rejectFleet(
					FleetRejectionCode.INVALID_TRANSITION,
					`runner slot expected ${expected}, found ${slot.state}`,
				);
			transitionRunnerSlot(expected, next);
			if (
				next === "released" &&
				["reserved", "provisioning", "registered", "draining"].includes(
					expected,
				)
			) {
				const claim = await client.query(
					"SELECT key FROM hobo_ci_fleet_v2_execution_claims WHERE partition_id=$1 AND runner_slot_id=$2",
					[this.partition, slot.id],
				);
				if ((claim.rowCount ?? 0) > 0)
					rejectFleet(
						FleetRejectionCode.INVALID_TRANSITION,
						"claimed runner release requires execution settlement",
					);
				const changed = await client.query(
					`UPDATE hobo_ci_fleet_v2_capacity_groups SET reserved_units=reserved_units-$3,seq=seq+1
					 WHERE partition_id=$1 AND id=$2 AND reserved_units>=$3`,
					[this.partition, slot.capacityGroupId, slot.capacityCostUnits],
				);
				if (changed.rowCount !== 1)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"capacity release would make reserved units negative",
					);
				const currentGroup = await this.capacityInside(
					client,
					slot.capacityGroupId,
				);
				if (currentGroup) {
					const group = clone(CapacityGroupSchema, currentGroup);
					group.reservedUnits -= slot.capacityCostUnits;
					group.seq += 1;
					await this.saveCapacity(client, group);
				}
			}
			slot.state = next;
			if (externalRunnerId !== undefined)
				slot.externalRunnerId = externalRunnerId;
			await this.saveSlot(client, slot);
			await this.event(
				client,
				FleetEventType.RUNNER_SLOT_TRANSITIONED,
				await this.now(client),
				slot.accountId,
				"runner-slot",
				slot.id,
				undefined,
				slot.incarnationId,
			);
			return slot;
		});
	}

	quarantineRunnerSlot(
		id: string,
		expected: RunnerSlotState,
	): Promise<RunnerSlot> {
		return this.tx(async (client) => {
			const slot = await this.slotInside(client, id, true);
			if (!slot)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "runner slot not found");
			if (slot.state !== expected)
				rejectFleet(
					FleetRejectionCode.INVALID_TRANSITION,
					`runner slot expected ${expected}, found ${slot.state}`,
				);
			const group = await this.capacityInside(
				client,
				slot.capacityGroupId,
				true,
			);
			if (!group)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
			transitionRunnerSlot(expected, "uncertain");
			transitionCapacityGroup(
				z.enum(CAPACITY_GROUP_STATES).parse(group.state),
				"quarantined",
			);
			slot.state = "uncertain";
			group.state = "quarantined";
			group.seq += 1;
			await this.saveSlot(client, slot);
			await this.saveCapacity(client, group);
			const at = await this.now(client);
			await this.event(
				client,
				FleetEventType.RUNNER_SLOT_TRANSITIONED,
				at,
				slot.accountId,
				"runner-slot",
				slot.id,
				undefined,
				slot.incarnationId,
			);
			await this.event(
				client,
				FleetEventType.CAPACITY_QUARANTINED,
				at,
				group.accountId,
				"capacity-group",
				group.id,
			);
			return slot;
		});
	}

	private async assertEffectIncarnationCurrent(
		client: PoolClient,
		effect: Effect,
	): Promise<void> {
		const slot =
			effect.subjectType === "runner-slot"
				? await this.slotInside(client, effect.subjectId)
				: effect.subjectType === "execution-claim"
					? await (async () => {
							const claim = await this.claimByIdInside(
								client,
								effect.subjectId,
							);
							return claim
								? this.slotInside(client, claim.runnerSlotId)
								: undefined;
						})()
					: undefined;
		if (!slot) return;
		const current = await this.currentIncarnationInside(client);
		if (!current || slot.incarnationId !== current.id)
			rejectFleet(
				FleetRejectionCode.INCARNATION_STALE,
				"effect belongs to a stale controller incarnation",
			);
	}

	claimEffect(input: EffectClaimInput): Promise<WorkerDelivery> {
		leaseDuration(input.leaseMs);
		positiveInteger(input.ownerEpoch, "owner epoch");
		return this.tx(async (client) => {
			const effect = await this.effectInside(client, input.effectId, true);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			await this.assertEffectIncarnationCurrent(client, effect);
			const now = await this.now(client);
			const activeResult = await client.query(
				"SELECT body FROM hobo_ci_fleet_v2_deliveries WHERE partition_id=$1 AND effect_id=$2 AND state='claimed' FOR UPDATE",
				[this.partition, effect.id],
			);
			if (activeResult.rows[0]) {
				const active = fromJsonString(
					WorkerDeliverySchema,
					body(activeResult.rows[0]),
				);
				if (active.expiresAt > now) {
					if (
						active.workerId === input.workerId &&
						active.ownerEpoch === input.ownerEpoch
					)
						return active;
					rejectFleet(
						FleetRejectionCode.EFFECT_DELIVERY_ACTIVE,
						"another worker holds the active effect delivery",
					);
				}
				active.state = "expired";
				await client.query(
					"UPDATE hobo_ci_fleet_v2_deliveries SET state='expired',body=$3 WHERE partition_id=$1 AND id=$2 AND state='claimed'",
					[
						this.partition,
						active.id,
						toJsonString(WorkerDeliverySchema, active),
					],
				);
				if (effect.state !== "planned")
					rejectFleet(
						FleetRejectionCode.EFFECT_NOT_CLAIMABLE,
						"an ambiguous effect cannot be reissued",
					);
			}
			if (effect.state !== "planned")
				rejectFleet(
					FleetRejectionCode.EFFECT_NOT_CLAIMABLE,
					"effect is not planned",
				);
			const fenceResult = await client.query<{ next_fence: number }>(
				"SELECT next_fence FROM hobo_ci_fleet_v2_effects WHERE partition_id=$1 AND id=$2",
				[this.partition, effect.id],
			);
			const fence =
				z.number().int().nonnegative().parse(fenceResult.rows[0]?.next_fence) +
				1;
			const delivery = create(WorkerDeliverySchema, {
				id: randomUUID(),
				effectId: effect.id,
				workerId: input.workerId,
				ownerEpoch: input.ownerEpoch,
				fence,
				expiresAt: await this.expiry(client, input.leaseMs),
				state: "claimed",
			});
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_deliveries(partition_id,id,effect_id,worker_id,owner_epoch,fence,expires_at,state,body)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				[
					this.partition,
					delivery.id,
					delivery.effectId,
					delivery.workerId,
					delivery.ownerEpoch,
					delivery.fence,
					delivery.expiresAt,
					delivery.state,
					toJsonString(WorkerDeliverySchema, delivery),
				],
			);
			await client.query(
				"UPDATE hobo_ci_fleet_v2_effects SET next_fence=$3 WHERE partition_id=$1 AND id=$2",
				[this.partition, effect.id, fence],
			);
			const outbox = await this.outboxInside(client, effect.id);
			if (outbox) {
				outbox.state = "claimed";
				await this.saveOutbox(client, outbox);
			}
			const slot = await this.slotInside(client, effect.subjectId);
			await this.event(
				client,
				FleetEventType.EFFECT_DELIVERY_CLAIMED,
				now,
				slot?.accountId ?? "system",
				"effect",
				effect.id,
				undefined,
				slot?.incarnationId,
			);
			return delivery;
		});
	}

	private async fenceInside(
		client: PoolClient,
		input: EffectFenceInput,
	): Promise<WorkerDelivery> {
		const result = await client.query(
			`SELECT body FROM hobo_ci_fleet_v2_deliveries WHERE partition_id=$1 AND effect_id=$2 AND worker_id=$3
			 AND owner_epoch=$4 AND fence=$5 AND state='claimed' FOR UPDATE`,
			[
				this.partition,
				input.effectId,
				input.workerId,
				input.ownerEpoch,
				input.fence,
			],
		);
		if (!result.rows[0])
			rejectFleet(
				FleetRejectionCode.STALE_DELIVERY_FENCE,
				"worker, owner epoch or fence is stale",
			);
		const delivery = fromJsonString(WorkerDeliverySchema, body(result.rows[0]));
		if (delivery.expiresAt <= (await this.now(client)))
			rejectFleet(
				FleetRejectionCode.STALE_DELIVERY_FENCE,
				"delivery lease expired",
			);
		return delivery;
	}

	renewEffectDelivery(
		input: EffectFenceInput & { leaseMs: number },
	): Promise<WorkerDelivery> {
		leaseDuration(input.leaseMs);
		return this.tx(async (client) => {
			const delivery = await this.fenceInside(client, input);
			delivery.expiresAt = await this.expiry(client, input.leaseMs);
			const changed = await client.query(
				`UPDATE hobo_ci_fleet_v2_deliveries SET expires_at=$6,body=$7 WHERE partition_id=$1 AND id=$2
				 AND effect_id=$3 AND worker_id=$4 AND owner_epoch=$5 AND fence=$8 AND state='claimed'`,
				[
					this.partition,
					delivery.id,
					input.effectId,
					input.workerId,
					input.ownerEpoch,
					delivery.expiresAt,
					toJsonString(WorkerDeliverySchema, delivery),
					input.fence,
				],
			);
			if (changed.rowCount !== 1)
				rejectFleet(
					FleetRejectionCode.STALE_DELIVERY_FENCE,
					"delivery renewal fence changed",
				);
			return delivery;
		});
	}

	markEffectDispatching(input: EffectFenceInput): Promise<Effect> {
		return this.tx(async (client) => {
			await this.fenceInside(client, input);
			const effect = await this.effectInside(client, input.effectId, true);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			await this.assertEffectIncarnationCurrent(client, effect);
			transitionEffect(effect.state as EffectState, "dispatching");
			effect.state = "dispatching";
			await this.saveEffect(client, effect);
			const slot = await this.slotInside(client, effect.subjectId);
			await this.event(
				client,
				FleetEventType.EFFECT_DISPATCHING,
				await this.now(client),
				slot?.accountId ?? "system",
				"effect",
				effect.id,
				undefined,
				slot?.incarnationId,
			);
			return effect;
		});
	}

	acknowledgeEffect(
		input: EffectFenceInput & {
			outcome: "confirmed" | "uncertain" | "pre-mutation-refusal";
		},
	): Promise<Effect> {
		return this.tx(async (client) => {
			const delivery = await this.fenceInside(client, input);
			const effect = await this.effectInside(client, input.effectId, true);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			await this.assertEffectIncarnationCurrent(client, effect);
			const nextEffect =
				input.outcome === "confirmed"
					? "confirmed"
					: input.outcome === "uncertain"
						? "uncertain"
						: "planned";
			transitionEffect(effect.state as EffectState, nextEffect);
			effect.state = nextEffect;
			delivery.state =
				input.outcome === "pre-mutation-refusal" ? "superseded" : "acked";
			await this.saveEffect(client, effect);
			await client.query(
				"UPDATE hobo_ci_fleet_v2_deliveries SET state=$3,body=$4 WHERE partition_id=$1 AND id=$2",
				[
					this.partition,
					delivery.id,
					delivery.state,
					toJsonString(WorkerDeliverySchema, delivery),
				],
			);
			const outbox = await this.outboxInside(client, effect.id);
			if (outbox) {
				outbox.state =
					nextEffect === "confirmed"
						? "done"
						: nextEffect === "uncertain"
							? "uncertain"
							: "pending";
				await this.saveOutbox(client, outbox);
			}
			const slot = await this.slotInside(client, effect.subjectId);
			await this.event(
				client,
				nextEffect === "confirmed"
					? FleetEventType.EFFECT_CONFIRMED
					: nextEffect === "uncertain"
						? FleetEventType.EFFECT_UNCERTAIN
						: FleetEventType.EFFECT_PLANNED,
				await this.now(client),
				slot?.accountId ?? "system",
				"effect",
				effect.id,
				undefined,
				slot?.incarnationId,
			);
			return effect;
		});
	}

	private async verifyStart(
		client: PoolClient,
		slot: RunnerSlot,
		demand: CiDemand,
		input: ParsedStartBindingInput,
	): Promise<void> {
		const current = await this.currentIncarnationInside(client);
		if (!current || slot.incarnationId !== current.id)
			rejectFleet(
				FleetRejectionCode.INCARNATION_STALE,
				"runner slot incarnation is stale",
			);
		if (
			slot.accountId !== input.assignment.accountId ||
			slot.runnerName !== input.assignment.runnerName ||
			slot.profileId !== input.assignment.profileId ||
			demand.requiredProfileId !== slot.profileId ||
			slot.accountId !== executionAccountId(input.key)
		)
			rejectFleet(
				FleetRejectionCode.ASSIGNMENT_MISMATCH,
				"verified assignment does not match slot or demand",
			);
		const expected = Buffer.from(slot.bindingSecretHash, "hex");
		const actual = createHash("sha256").update(input.bindingSecret).digest();
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
			rejectFleet(
				FleetRejectionCode.BINDING_SECRET_MISMATCH,
				"binding secret does not match slot",
			);
		const offer = await this.offerInside(client, slot.offerId);
		if (offer?.state !== "active" || offer.accountId !== slot.accountId)
			rejectFleet(FleetRejectionCode.OFFER_REVOKED, "Offer is revoked");
		const slotRow = await client.query(
			"SELECT demand_key FROM hobo_ci_fleet_v2_runner_slots WHERE partition_id=$1 AND id=$2",
			[this.partition, slot.id],
		);
		const reservedKey = z
			.object({ demand_key: z.string() })
			.safeParse(slotRow.rows[0]);
		const reservedDemand = reservedKey.success
			? await this.demandInside(client, reservedKey.data.demand_key)
			: undefined;
		if (!reservedDemand)
			rejectFleet(FleetRejectionCode.NOT_FOUND, "reservation demand not found");
		if (
			offer.policyRevision !== reservedDemand.policyRevision ||
			offer.policyRevision !== demand.policyRevision
		)
			rejectFleet(
				FleetRejectionCode.POLICY_REVISION_CONFLICT,
				"runner policy revision changed",
			);
		if (offer.observationHash !== slot.offerObservationHash)
			rejectFleet(
				FleetRejectionCode.OFFER_OBSERVATION_CONFLICT,
				"runner Offer observation changed",
			);
		const group = await this.capacityInside(client, slot.capacityGroupId);
		if (group?.state === "quarantined")
			rejectFleet(
				FleetRejectionCode.QUARANTINED,
				"capacity group is quarantined",
			);
		if (
			group?.state !== "active" ||
			group.accountId !== slot.accountId ||
			group.reservedUnits < slot.capacityCostUnits
		)
			rejectFleet(
				FleetRejectionCode.CAPACITY_INELIGIBLE,
				"worker or capacity group is not start-eligible",
			);
		const profile = await this.profileInside(client, slot.profileId);
		if (profile?.guarantee !== "start-fenced")
			rejectFleet(
				FleetRejectionCode.GUARANTEE_REQUIRED,
				"start binding requires a start-fenced profile",
			);
	}

	startDagger(
		input: ParsedDaggerStartInput,
	): Promise<{ claim: ExecutionClaim; created: boolean }> {
		return this.tx(async (client) => {
			const key = executionKeyId(input.key);
			if (input.key.key.case !== "daggerPipeline")
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"Dagger pipeline key required",
				);
			const pipeline = input.key.key.value;
			const result = await client.query(
				"SELECT * FROM hobo_ci_fleet_v2_dagger_allocations WHERE partition_id=$1 AND account_id=$2 AND pipeline_id=$3",
				[this.partition, pipeline.accountId, pipeline.pipelineId],
			);
			if (result.rows[0]) {
				const allocation = DaggerAllocation.parse(result.rows[0]);
				const existing = await this.claimByIdInside(
					client,
					allocation.claim_id,
				);
				if (
					!existing ||
					existing.id !== input.claimId ||
					executionKeyId(existing.key) !== key ||
					existing.profileId !== input.profileId ||
					existing.offerId !== input.offerId ||
					existing.policyHash !== input.policyHash ||
					existing.quoteHash !== input.quoteHash ||
					existing.incarnationId !== input.incarnationId ||
					allocation.capacity_group_id !== input.capacityGroupId ||
					allocation.capacity_cost_units !== input.capacityCostUnits ||
					allocation.engine_endpoint_hash !== input.engineEndpointHash ||
					allocation.offer_observation_hash !== input.offerObservationHash ||
					allocation.policy_revision !== input.expectedPolicyRevision
				)
					rejectFleet(
						FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
						"pipeline identity is already claimed",
					);
				return { claim: existing, created: false };
			}
			if (
				(await this.claimInside(client, key)) ||
				(await this.claimByIdInside(client, input.claimId))
			)
				rejectFleet(
					FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
					"execution claim already exists",
				);
			const demand = await this.demandInside(client, key, true);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "pipeline demand not found");
			if (!["observed", "eligible"].includes(demand.state))
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"pipeline demand is not available",
				);
			const incarnation = await this.currentIncarnationInside(client);
			if (!incarnation || incarnation.id !== input.incarnationId)
				rejectFleet(
					FleetRejectionCode.INCARNATION_STALE,
					"controller incarnation changed",
				);
			if (
				demand.requiredProfileId !== input.profileId ||
				demand.policyRevision !== input.expectedPolicyRevision
			)
				rejectFleet(
					FleetRejectionCode.POLICY_REVISION_CONFLICT,
					"pipeline policy or profile changed",
				);
			const offer = await this.offerInside(client, input.offerId);
			if (!offer || offer.accountId !== pipeline.accountId)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "Offer admission not found");
			if (offer.state !== "active")
				rejectFleet(FleetRejectionCode.OFFER_REVOKED, "Offer is revoked");
			if (
				offer.policyRevision !== input.expectedPolicyRevision ||
				offer.observationHash !== input.offerObservationHash
			)
				rejectFleet(
					FleetRejectionCode.OFFER_OBSERVATION_CONFLICT,
					"Offer observation or policy changed",
				);
			const profile = await this.profileInside(client, input.profileId);
			if (!profile)
				rejectFleet(
					FleetRejectionCode.NOT_FOUND,
					"execution profile not found",
				);
			if (profile.guarantee !== "start-fenced")
				rejectFleet(
					FleetRejectionCode.GUARANTEE_REQUIRED,
					"strict admission requires a start-fenced profile",
				);
			const group = await this.capacityInside(client, input.capacityGroupId);
			if (!group)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
			if (group.accountId !== pipeline.accountId)
				rejectFleet(
					FleetRejectionCode.CAPACITY_INELIGIBLE,
					"capacity account differs from pipeline account",
				);
			if (group.seq !== input.expectedCapacitySeq)
				rejectFleet(
					FleetRejectionCode.CAPACITY_CONFLICT,
					"capacity sequence changed before admission",
				);
			if (group.state !== "active")
				rejectFleet(
					FleetRejectionCode.CAPACITY_INELIGIBLE,
					"capacity group is not active",
				);
			if (group.reservedUnits + input.capacityCostUnits > group.approvedUnits)
				rejectFleet(
					FleetRejectionCode.CAPACITY_EXHAUSTED,
					"capacity group has insufficient units",
				);
			const at = await this.now(client);
			const claim = create(ExecutionClaimSchema, {
				id: input.claimId,
				key: input.key,
				state: "start-authorized",
				profileId: input.profileId,
				policyHash: input.policyHash,
				offerId: input.offerId,
				quoteHash: input.quoteHash,
				startAuthorizedAt: at,
				incarnationId: input.incarnationId,
			});
			const updatedGroup = clone(CapacityGroupSchema, group);
			updatedGroup.reservedUnits += input.capacityCostUnits;
			updatedGroup.seq += 1;
			await this.saveCapacity(client, updatedGroup);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_execution_claims(partition_id,id,key,runner_slot_id,state,start_authorized_at,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
				[
					this.partition,
					claim.id,
					key,
					`!dagger:${claim.id}`,
					claim.state,
					at,
					toJsonString(ExecutionClaimSchema, claim),
				],
			);
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_dagger_allocations(partition_id,claim_id,account_id,pipeline_id,capacity_group_id,capacity_cost_units,engine_endpoint_hash,offer_observation_hash,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
				[
					this.partition,
					claim.id,
					pipeline.accountId,
					pipeline.pipelineId,
					group.id,
					input.capacityCostUnits,
					input.engineEndpointHash,
					input.offerObservationHash,
					input.expectedPolicyRevision,
				],
			);
			if (demand.state === "observed")
				transitionCiDemand("observed", "eligible");
			transitionCiDemand("eligible", "satisfied");
			demand.state = "satisfied";
			await this.saveDemand(client, demand);
			await this.event(
				client,
				FleetEventType.CAPACITY_RESERVED,
				at,
				pipeline.accountId,
				"execution-claim",
				claim.id,
				input.key,
				incarnation.id,
			);
			await this.event(
				client,
				FleetEventType.EXECUTION_START_AUTHORIZED,
				at,
				pipeline.accountId,
				"execution-claim",
				claim.id,
				input.key,
				incarnation.id,
			);
			return { claim, created: true };
		});
	}

	assertDaggerStartAllowed(input: ParsedDaggerStartInput): Promise<void> {
		return this.tx(async (client) => {
			const key = executionKeyId(input.key);
			if (input.key.key.case !== "daggerPipeline")
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"Dagger pipeline key required",
				);
			const result = await client.query(
				"SELECT * FROM hobo_ci_fleet_v2_dagger_allocations WHERE partition_id=$1 AND claim_id=$2",
				[this.partition, input.claimId],
			);
			const claim = await this.claimByIdInside(client, input.claimId);
			if (!result.rows[0] || !claim)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "pipeline claim not found");
			const allocation = DaggerAllocation.parse(result.rows[0]);
			if (
				claim.state !== "start-authorized" ||
				executionKeyId(claim.key) !== key ||
				claim.profileId !== input.profileId ||
				claim.offerId !== input.offerId ||
				claim.policyHash !== input.policyHash ||
				claim.quoteHash !== input.quoteHash ||
				claim.incarnationId !== input.incarnationId ||
				allocation.account_id !== input.key.key.value.accountId ||
				allocation.capacity_group_id !== input.capacityGroupId ||
				allocation.capacity_cost_units !== input.capacityCostUnits ||
				allocation.engine_endpoint_hash !== input.engineEndpointHash ||
				allocation.offer_observation_hash !== input.offerObservationHash ||
				allocation.policy_revision !== input.expectedPolicyRevision
			)
				rejectFleet(
					FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
					"pipeline claim no longer permits a start",
				);
			const demand = await this.demandInside(client, key);
			if (
				!demand ||
				demand.state !== "satisfied" ||
				demand.requiredProfileId !== input.profileId ||
				demand.policyRevision !== input.expectedPolicyRevision
			)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"pipeline demand changed",
				);
			if (
				(await this.currentIncarnationInside(client))?.id !==
				input.incarnationId
			)
				rejectFleet(
					FleetRejectionCode.INCARNATION_STALE,
					"controller incarnation changed",
				);
			const offer = await this.offerInside(client, input.offerId);
			if (
				!offer ||
				offer.accountId !== allocation.account_id ||
				offer.state !== "active"
			)
				rejectFleet(
					FleetRejectionCode.OFFER_REVOKED,
					"Offer is unavailable or revoked",
				);
			if (
				offer.policyRevision !== input.expectedPolicyRevision ||
				offer.observationHash !== input.offerObservationHash
			)
				rejectFleet(
					FleetRejectionCode.OFFER_OBSERVATION_CONFLICT,
					"Offer observation or policy changed",
				);
			if (
				(await this.profileInside(client, input.profileId))?.guarantee !==
				"start-fenced"
			)
				rejectFleet(
					FleetRejectionCode.GUARANTEE_REQUIRED,
					"strict execution profile unavailable",
				);
			const group = await this.capacityInside(
				client,
				allocation.capacity_group_id,
			);
			if (
				!group ||
				group.accountId !== allocation.account_id ||
				group.state !== "active" ||
				group.reservedUnits < allocation.capacity_cost_units
			)
				rejectFleet(
					FleetRejectionCode.CAPACITY_INELIGIBLE,
					"reserved capacity is unavailable",
				);
		});
	}

	bindStart(
		input: ParsedStartBindingInput,
	): Promise<{ claim: ExecutionClaim; idempotent: boolean }> {
		return this.tx(async (client) => {
			const slot = await this.slotInside(client, input.slotId, true);
			if (!slot)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "runner slot not found");
			const key = executionKeyId(input.key);
			const existing = await this.claimInside(client, key, true);
			if (existing) {
				if (
					existing.id !== input.claimId ||
					existing.runnerSlotId !== slot.id ||
					(existing.state !== "start-authorized" &&
						existing.state !== "running")
				)
					rejectFleet(
						FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
						"actual job is already claimed",
					);
				const demand = await this.demandInside(client, key, true);
				if (!demand)
					rejectFleet(FleetRejectionCode.NOT_FOUND, "actual demand not found");
				await this.verifyStart(client, slot, demand, input);
				return { claim: existing, idempotent: true };
			}
			if (await this.claimByIdInside(client, input.claimId))
				rejectFleet(
					FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
					"claim id is already used by another execution",
				);
			const demand = await this.demandInside(client, key, true);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "actual demand not found");
			await this.verifyStart(client, slot, demand, input);
			if (slot.state === "bound")
				rejectFleet(
					FleetRejectionCode.SLOT_ALREADY_BOUND,
					"runner slot is already bound to another job",
				);
			if (slot.state !== "registered")
				rejectFleet(
					FleetRejectionCode.SLOT_NOT_REGISTERED,
					"runner slot is not registered",
				);
			const slotClaim = await client.query(
				"SELECT key FROM hobo_ci_fleet_v2_execution_claims WHERE partition_id=$1 AND runner_slot_id=$2",
				[this.partition, slot.id],
			);
			if (slotClaim.rowCount)
				rejectFleet(
					FleetRejectionCode.SLOT_ALREADY_BOUND,
					"runner slot already has an execution claim",
				);
			const at = await this.now(client);
			const claim = create(ExecutionClaimSchema, {
				id: input.claimId,
				key: input.key,
				runnerSlotId: slot.id,
				state: "start-authorized",
				profileId: slot.profileId,
				policyHash: slot.policyHash,
				offerId: slot.offerId,
				quoteHash: slot.quoteHash,
				startAuthorizedAt: at,
				incarnationId: slot.incarnationId,
			});
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_execution_claims(partition_id,id,key,runner_slot_id,state,start_authorized_at,body)
				 VALUES($1,$2,$3,$4,$5,$6,$7)`,
				[
					this.partition,
					claim.id,
					key,
					slot.id,
					claim.state,
					at,
					toJsonString(ExecutionClaimSchema, claim),
				],
			);
			transitionRunnerSlot("registered", "bound");
			slot.state = "bound";
			await this.saveSlot(client, slot);
			transitionCiDemand(demand.state as CiDemandState, "satisfied");
			demand.state = "satisfied";
			await this.saveDemand(client, demand);
			await this.event(
				client,
				FleetEventType.EXECUTION_START_AUTHORIZED,
				at,
				slot.accountId,
				"execution-claim",
				claim.id,
				input.key,
				slot.incarnationId,
			);
			return { claim, idempotent: false };
		});
	}

	completeExecution(input: CompleteExecutionInput): Promise<{
		claim: ExecutionClaim;
		settled: boolean;
		capacityReleased: boolean;
	}> {
		return this.tx(async (client) => {
			const initial = await this.claimByIdInside(client, input.claimId);
			if (!initial)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "execution claim not found");
			if (initial.key?.key.case === "daggerPipeline")
				return this.completeDaggerInside(client, initial, input);
			const slot = await this.slotInside(client, initial.runnerSlotId, true);
			if (!slot)
				rejectFleet(
					FleetRejectionCode.NOT_FOUND,
					"claimed runner slot not found",
				);
			const claim = await this.claimByIdInside(client, input.claimId, true);
			if (!claim)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "execution claim not found");
			const terminal = ["completed", "failed", "cancelled"].includes(
				claim.state,
			);
			if (terminal && claim.state !== input.state)
				rejectFleet(
					FleetRejectionCode.SETTLEMENT_CONFLICT,
					"execution claim already has a different terminal outcome",
				);
			if (
				input.actualStartedAt &&
				claim.actualStartedAt &&
				input.actualStartedAt !== claim.actualStartedAt
			)
				rejectFleet(
					FleetRejectionCode.SETTLEMENT_CONFLICT,
					"actual start time is already pinned",
				);
			let settled = false;
			if (!terminal || claim.state === "uncertain") {
				transitionExecutionClaim(
					claim.state as ExecutionClaimState,
					input.state,
				);
				claim.state = input.state;
				if (input.actualStartedAt)
					claim.actualStartedAt = input.actualStartedAt;
				claim.terminalAt = ["completed", "failed", "cancelled"].includes(
					input.state,
				)
					? await this.now(client)
					: claim.terminalAt;
				await this.saveClaim(client, claim);
				if (slot.state === "bound") {
					transitionRunnerSlot("bound", "draining");
					slot.state = "draining";
					await this.saveSlot(client, slot);
				}
				settled = true;
				const eventType = {
					completed: FleetEventType.EXECUTION_COMPLETED,
					failed: FleetEventType.EXECUTION_FAILED,
					cancelled: FleetEventType.EXECUTION_CANCELLED,
					uncertain: FleetEventType.EXECUTION_UNCERTAIN,
				}[input.state];
				await this.event(
					client,
					eventType,
					await this.now(client),
					slot.accountId,
					"execution-claim",
					claim.id,
					claim.key,
					claim.incarnationId,
				);
			}
			let capacityReleased = false;
			if (input.teardownConfirmed) {
				const inserted = await client.query(
					`INSERT INTO hobo_ci_fleet_v2_capacity_releases(partition_id,claim_id,capacity_group_id,units,released_at)
					 VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
					[
						this.partition,
						claim.id,
						slot.capacityGroupId,
						slot.capacityCostUnits,
						await this.now(client),
					],
				);
				if (inserted.rowCount === 1) {
					const changed = await client.query(
						`UPDATE hobo_ci_fleet_v2_capacity_groups SET reserved_units=reserved_units-$3,seq=seq+1
						 WHERE partition_id=$1 AND id=$2 AND reserved_units>=$3`,
						[this.partition, slot.capacityGroupId, slot.capacityCostUnits],
					);
					if (changed.rowCount !== 1)
						rejectFleet(
							FleetRejectionCode.CAPACITY_CONFLICT,
							"capacity release would make reserved units negative",
						);
					const currentGroup = await this.capacityInside(
						client,
						slot.capacityGroupId,
					);
					if (!currentGroup)
						rejectFleet(
							FleetRejectionCode.NOT_FOUND,
							"capacity group not found",
						);
					const group = clone(CapacityGroupSchema, currentGroup);
					group.reservedUnits -= slot.capacityCostUnits;
					group.seq += 1;
					await this.saveCapacity(client, group);
					transitionRunnerSlot(slot.state as RunnerSlotState, "released");
					slot.state = "released";
					await this.saveSlot(client, slot);
					capacityReleased = true;
					await this.event(
						client,
						FleetEventType.CAPACITY_RELEASED,
						await this.now(client),
						slot.accountId,
						"capacity-group",
						slot.capacityGroupId,
						claim.key,
						claim.incarnationId,
					);
				}
			}
			return { claim, settled, capacityReleased };
		});
	}

	private async completeDaggerInside(
		client: PoolClient,
		claim: ExecutionClaim,
		input: CompleteExecutionInput,
	): Promise<{
		claim: ExecutionClaim;
		settled: boolean;
		capacityReleased: boolean;
	}> {
		const result = await client.query(
			"SELECT * FROM hobo_ci_fleet_v2_dagger_allocations WHERE partition_id=$1 AND claim_id=$2",
			[this.partition, claim.id],
		);
		if (!result.rows[0])
			rejectFleet(
				FleetRejectionCode.NOT_FOUND,
				"pipeline allocation not found",
			);
		const allocation = DaggerAllocation.parse(result.rows[0]);
		const terminal = ["completed", "failed", "cancelled"].includes(claim.state);
		if (terminal && claim.state !== input.state)
			rejectFleet(
				FleetRejectionCode.SETTLEMENT_CONFLICT,
				"execution claim already has a different terminal outcome",
			);
		if (
			input.actualStartedAt &&
			claim.actualStartedAt &&
			input.actualStartedAt !== claim.actualStartedAt
		)
			rejectFleet(
				FleetRejectionCode.SETTLEMENT_CONFLICT,
				"actual start time is already pinned",
			);
		let settled = false;
		if (!terminal && claim.state !== input.state) {
			transitionExecutionClaim(claim.state as ExecutionClaimState, input.state);
			claim.state = input.state;
			if (input.actualStartedAt) claim.actualStartedAt = input.actualStartedAt;
			if (["completed", "failed", "cancelled"].includes(input.state))
				claim.terminalAt = await this.now(client);
			await this.saveClaim(client, claim);
			settled = true;
			const eventType = {
				completed: FleetEventType.EXECUTION_COMPLETED,
				failed: FleetEventType.EXECUTION_FAILED,
				cancelled: FleetEventType.EXECUTION_CANCELLED,
				uncertain: FleetEventType.EXECUTION_UNCERTAIN,
			}[input.state];
			await this.event(
				client,
				eventType,
				await this.now(client),
				allocation.account_id,
				"execution-claim",
				claim.id,
				claim.key,
				claim.incarnationId,
			);
		} else if (input.actualStartedAt && !claim.actualStartedAt) {
			claim.actualStartedAt = input.actualStartedAt;
			await this.saveClaim(client, claim);
		}
		let capacityReleased = false;
		if (input.teardownConfirmed) {
			const inserted = await client.query(
				"INSERT INTO hobo_ci_fleet_v2_capacity_releases(partition_id,claim_id,capacity_group_id,units,released_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
				[
					this.partition,
					claim.id,
					allocation.capacity_group_id,
					allocation.capacity_cost_units,
					await this.now(client),
				],
			);
			if (inserted.rowCount === 1) {
				const group = await this.capacityInside(
					client,
					allocation.capacity_group_id,
				);
				if (!group)
					rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
				if (group.reservedUnits < allocation.capacity_cost_units)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"capacity release would make reserved units negative",
					);
				group.reservedUnits -= allocation.capacity_cost_units;
				group.seq += 1;
				await this.saveCapacity(client, group);
				capacityReleased = true;
				await this.event(
					client,
					FleetEventType.CAPACITY_RELEASED,
					await this.now(client),
					allocation.account_id,
					"capacity-group",
					group.id,
					claim.key,
					claim.incarnationId,
				);
			}
		}
		return { claim, settled, capacityReleased };
	}

	observe(observation: ParsedObservation): Promise<void> {
		return this.tx(async (client) => {
			const result = await client.query(
				"SELECT account_id,sequence FROM hobo_ci_fleet_v2_observation_watermarks WHERE partition_id=$1 AND worker_id=$2 FOR UPDATE",
				[this.partition, observation.workerId],
			);
			if (result.rows[0]) {
				const current = z
					.object({ account_id: z.string(), sequence: z.number().int() })
					.parse(result.rows[0]);
				if (
					current.account_id !== observation.accountId ||
					observation.sequence <= current.sequence
				)
					rejectFleet(
						FleetRejectionCode.OBSERVATION_SEQUENCE_REGRESSED,
						"worker observation sequence regressed or account changed",
					);
			}
			await client.query(
				"INSERT INTO hobo_ci_fleet_v2_observations(partition_id,worker_id,sequence,body) VALUES($1,$2,$3,$4)",
				[
					this.partition,
					observation.workerId,
					observation.sequence,
					toJsonString(ObservationSchema, observation),
				],
			);
			await client.query(
				`INSERT INTO hobo_ci_fleet_v2_observation_watermarks(partition_id,worker_id,account_id,sequence) VALUES($1,$2,$3,$4)
				 ON CONFLICT(partition_id,worker_id) DO UPDATE SET sequence=EXCLUDED.sequence`,
				[
					this.partition,
					observation.workerId,
					observation.accountId,
					observation.sequence,
				],
			);
			await this.event(
				client,
				FleetEventType.OBSERVATION_ACCEPTED,
				observation.observedAt,
				observation.accountId,
				"worker",
				observation.workerId,
			);
		});
	}

	demand(key: ParsedExecutionKey): Promise<CiDemand | undefined> {
		return this.tx((client) => this.demandInside(client, executionKeyId(key)));
	}

	runnerSlot(id: string): Promise<RunnerSlot | undefined> {
		return this.tx((client) => this.slotInside(client, id));
	}

	executionClaim(key: ParsedExecutionKey): Promise<ExecutionClaim | undefined> {
		return this.tx((client) => this.claimInside(client, executionKeyId(key)));
	}

	executionClaimById(id: string): Promise<ExecutionClaim | undefined> {
		return this.tx((client) => this.claimByIdInside(client, id));
	}

	capacityGroup(id: string): Promise<CapacityGroup | undefined> {
		return this.tx((client) => this.capacityInside(client, id));
	}

	effect(id: string): Promise<Effect | undefined> {
		return this.tx((client) => this.effectInside(client, id));
	}

	outbox(effectId: string): Promise<Outbox | undefined> {
		return this.tx((client) => this.outboxInside(client, effectId));
	}

	deliveries(effectId: string): Promise<WorkerDelivery[]> {
		return this.tx(async (client) => {
			const result = await client.query(
				"SELECT body FROM hobo_ci_fleet_v2_deliveries WHERE partition_id=$1 AND effect_id=$2 ORDER BY fence",
				[this.partition, effectId],
			);
			return result.rows.map((row) =>
				fromJsonString(WorkerDeliverySchema, body(row)),
			);
		});
	}

	observationSequence(workerId: string): Promise<number> {
		return this.tx(async (client) => {
			const result = await client.query(
				"SELECT sequence FROM hobo_ci_fleet_v2_observation_watermarks WHERE partition_id=$1 AND worker_id=$2",
				[this.partition, workerId],
			);
			return result.rows[0]
				? z.number().int().parse(result.rows[0].sequence)
				: 0;
		});
	}

	events(): Promise<FleetEvent[]> {
		return this.tx(async (client) => {
			const result = await client.query(
				"SELECT body FROM hobo_ci_fleet_v2_events WHERE partition_id=$1 ORDER BY seq",
				[this.partition],
			);
			return result.rows.map((row) =>
				fromJsonString(FleetEventSchema, body(row)),
			);
		});
	}
}
