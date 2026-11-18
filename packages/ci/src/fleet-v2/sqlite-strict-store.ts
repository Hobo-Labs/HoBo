/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-conditional-empty-object-spread */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
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
	type ParsedCiDemand,
	type ParsedControllerIncarnation,
	type ParsedDaggerStartInput,
	type ParsedExecutionProfile,
	type ParsedObservation,
	type ParsedStartBindingInput,
} from "./parse.js";
import {
	CAPACITY_GROUP_STATES,
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
const FenceRow = z.object({
	id: z.string(),
	expires_at: z.string(),
});
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
const TIME = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

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

export class SqliteStrictFleetStore implements StrictFleetStore {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS fleet_v2_incarnations (
				id TEXT PRIMARY KEY, current INTEGER NOT NULL, body TEXT NOT NULL);
			CREATE UNIQUE INDEX IF NOT EXISTS fleet_v2_one_incarnation
				ON fleet_v2_incarnations(current) WHERE current = 1;
			CREATE TABLE IF NOT EXISTS fleet_v2_profiles (
				id TEXT PRIMARY KEY, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_offers (
				offer_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
				observation_hash TEXT NOT NULL, policy_revision INTEGER NOT NULL,
				state TEXT NOT NULL, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_demands (
				key TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL,
				policy_revision INTEGER NOT NULL, required_profile_id TEXT NOT NULL,
				body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_demand_deliveries (
				delivery_id TEXT PRIMARY KEY, demand_key TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_capacity_groups (
				id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
				approved_units INTEGER NOT NULL, reserved_units INTEGER NOT NULL,
				seq INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
				CHECK(reserved_units >= 0 AND reserved_units <= approved_units));
			CREATE TABLE IF NOT EXISTS fleet_v2_runner_slots (
				id TEXT PRIMARY KEY, account_id TEXT NOT NULL, offer_id TEXT NOT NULL,
				profile_id TEXT NOT NULL, runner_name TEXT NOT NULL, state TEXT NOT NULL,
				capacity_group_id TEXT NOT NULL, capacity_cost_units INTEGER NOT NULL,
				offer_observation_hash TEXT NOT NULL, binding_secret_hash TEXT NOT NULL,
				incarnation_id TEXT NOT NULL, demand_key TEXT, body TEXT NOT NULL,
				UNIQUE(account_id, runner_name));
			CREATE UNIQUE INDEX IF NOT EXISTS fleet_v2_one_open_slot_per_demand
				ON fleet_v2_runner_slots(demand_key)
				WHERE state IN ('reserved','provisioning','registered','bound');
			CREATE INDEX IF NOT EXISTS fleet_v2_unresolved_slot_per_demand
				ON fleet_v2_runner_slots(demand_key)
				WHERE state IN ('draining','uncertain');
			CREATE TABLE IF NOT EXISTS fleet_v2_execution_claims (
				id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
				runner_slot_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
				start_authorized_at TEXT NOT NULL, body TEXT NOT NULL);
			CREATE TRIGGER IF NOT EXISTS fleet_v2_start_time_immutable
				BEFORE UPDATE OF start_authorized_at ON fleet_v2_execution_claims
				WHEN OLD.start_authorized_at <> NEW.start_authorized_at
				BEGIN SELECT RAISE(ABORT, 'start authorization time is immutable'); END;
			CREATE TABLE IF NOT EXISTS fleet_v2_dagger_allocations (
				claim_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
				capacity_group_id TEXT NOT NULL, capacity_cost_units INTEGER NOT NULL,
				engine_endpoint_hash TEXT NOT NULL, offer_observation_hash TEXT NOT NULL,
				policy_revision INTEGER NOT NULL, UNIQUE(account_id, pipeline_id));
			CREATE TABLE IF NOT EXISTS fleet_v2_effects (
				id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
				kind TEXT NOT NULL, sequence INTEGER NOT NULL, state TEXT NOT NULL,
				idempotency_key TEXT NOT NULL, provider_scope TEXT NOT NULL,
				next_fence INTEGER NOT NULL, body TEXT NOT NULL,
				UNIQUE(subject_type, subject_id, kind, sequence),
				UNIQUE(provider_scope, idempotency_key));
			CREATE TABLE IF NOT EXISTS fleet_v2_outbox (
				id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL, body TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_deliveries (
				id TEXT PRIMARY KEY, effect_id TEXT NOT NULL, worker_id TEXT NOT NULL,
				owner_epoch INTEGER NOT NULL, fence INTEGER NOT NULL,
				expires_at TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
				UNIQUE(effect_id, fence));
			CREATE UNIQUE INDEX IF NOT EXISTS fleet_v2_one_active_delivery
				ON fleet_v2_deliveries(effect_id) WHERE state = 'claimed';
			CREATE TABLE IF NOT EXISTS fleet_v2_observations (
				worker_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
				PRIMARY KEY(worker_id, sequence));
			CREATE TABLE IF NOT EXISTS fleet_v2_observation_watermarks (
				worker_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sequence INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_capacity_releases (
				claim_id TEXT PRIMARY KEY, capacity_group_id TEXT NOT NULL,
				units INTEGER NOT NULL, released_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS fleet_v2_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
				body TEXT NOT NULL);
		`);
	}

	initialize(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {
		this.db.close();
	}

	private tx<T>(fn: () => T): Promise<T> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return Promise.resolve(result);
		} catch (error) {
			this.db.exec("ROLLBACK");
			return Promise.reject(error);
		}
	}

	private read<T>(fn: () => T): Promise<T> {
		try {
			return Promise.resolve(fn());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private now(): string {
		return Now.parse(this.db.prepare(`SELECT ${TIME} AS now`).get()).now;
	}

	private expiry(leaseMs: number): string {
		return Now.parse(
			this.db
				.prepare(
					`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('%f seconds', ? / 1000.0)) AS now`,
				)
				.get(leaseMs),
		).now;
	}

	private event(
		type: FleetEventType,
		at: string,
		accountId: string,
		subjectType: string,
		subjectId: string,
		executionKey?: import("../_generated/fleet_v2_pb.js").ExecutionKey,
		incarnationId?: string,
	): void {
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
		this.db
			.prepare("INSERT INTO fleet_v2_events(id,body) VALUES(?,?)")
			.run(id, toJsonString(FleetEventSchema, event));
	}

	private demandInside(key: string): CiDemand | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_demands WHERE key=?")
			.get(key);
		return row ? fromJsonString(CiDemandSchema, body(row)) : undefined;
	}

	private slotInside(id: string): RunnerSlot | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_runner_slots WHERE id=?")
			.get(id);
		return row ? fromJsonString(RunnerSlotSchema, body(row)) : undefined;
	}

	private claimInside(key: string): ExecutionClaim | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_execution_claims WHERE key=?")
			.get(key);
		return row ? fromJsonString(ExecutionClaimSchema, body(row)) : undefined;
	}

	private claimByIdInside(id: string): ExecutionClaim | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_execution_claims WHERE id=?")
			.get(id);
		return row ? fromJsonString(ExecutionClaimSchema, body(row)) : undefined;
	}

	private capacityInside(id: string): CapacityGroup | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_capacity_groups WHERE id=?")
			.get(id);
		return row ? fromJsonString(CapacityGroupSchema, body(row)) : undefined;
	}

	private effectInside(id: string): Effect | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_effects WHERE id=?")
			.get(id);
		return row ? fromJsonString(EffectSchema, body(row)) : undefined;
	}

	private offerInside(id: string): OfferAdmission | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_offers WHERE offer_id=?")
			.get(id);
		return row ? fromJsonString(OfferAdmissionSchema, body(row)) : undefined;
	}

	private profileInside(id: string): ExecutionProfile | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_profiles WHERE id=?")
			.get(id);
		return row ? fromJsonString(ExecutionProfileSchema, body(row)) : undefined;
	}

	private saveDemand(demand: CiDemand): void {
		const key = executionKeyId(demand.key);
		this.db
			.prepare("UPDATE fleet_v2_demands SET state=?,body=? WHERE key=?")
			.run(demand.state, toJsonString(CiDemandSchema, demand), key);
	}

	private saveSlot(slot: RunnerSlot): void {
		this.db
			.prepare("UPDATE fleet_v2_runner_slots SET state=?,body=? WHERE id=?")
			.run(slot.state, toJsonString(RunnerSlotSchema, slot), slot.id);
	}

	private saveClaim(claim: ExecutionClaim): void {
		this.db
			.prepare("UPDATE fleet_v2_execution_claims SET state=?,body=? WHERE id=?")
			.run(claim.state, toJsonString(ExecutionClaimSchema, claim), claim.id);
	}

	private saveCapacity(group: CapacityGroup): void {
		this.db
			.prepare(
				"UPDATE fleet_v2_capacity_groups SET approved_units=?,reserved_units=?,seq=?,state=?,body=? WHERE id=?",
			)
			.run(
				group.approvedUnits,
				group.reservedUnits,
				group.seq,
				group.state,
				toJsonString(CapacityGroupSchema, group),
				group.id,
			);
	}

	private saveEffect(effect: Effect): void {
		this.db
			.prepare("UPDATE fleet_v2_effects SET state=?,body=? WHERE id=?")
			.run(effect.state, toJsonString(EffectSchema, effect), effect.id);
	}

	private saveOutbox(outbox: Outbox): void {
		this.db
			.prepare("UPDATE fleet_v2_outbox SET state=?,body=? WHERE effect_id=?")
			.run(outbox.state, toJsonString(OutboxSchema, outbox), outbox.effectId);
	}

	private outboxInside(effectId: string): Outbox | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_outbox WHERE effect_id=?")
			.get(effectId);
		return row ? fromJsonString(OutboxSchema, body(row)) : undefined;
	}

	createIncarnation(incarnation: ParsedControllerIncarnation): Promise<void> {
		return this.tx(() => {
			this.db.exec(
				"UPDATE fleet_v2_incarnations SET current=0 WHERE current=1",
			);
			this.db
				.prepare(
					"INSERT INTO fleet_v2_incarnations(id,current,body) VALUES(?,1,?)",
				)
				.run(
					incarnation.id,
					toJsonString(ControllerIncarnationSchema, incarnation),
				);
			this.event(
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
		return this.read(() => {
			const row = this.db
				.prepare("SELECT body FROM fleet_v2_incarnations WHERE current=1")
				.get();
			return row
				? fromJsonString(ControllerIncarnationSchema, body(row))
				: undefined;
		});
	}

	putExecutionProfile(profile: ParsedExecutionProfile): Promise<void> {
		return this.tx(() => {
			const existing = this.profileInside(profile.id);
			if (
				existing &&
				toJsonString(ExecutionProfileSchema, existing) !==
					toJsonString(ExecutionProfileSchema, profile)
			)
				rejectFleet(
					FleetRejectionCode.PROFILE_INCOMPATIBLE,
					"execution profile definitions are immutable",
				);
			this.db
				.prepare(
					"INSERT INTO fleet_v2_profiles(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
				)
				.run(profile.id, toJsonString(ExecutionProfileSchema, profile));
		});
	}

	putOfferAdmission(
		offer: import("./parse.js").ParsedOfferAdmission,
	): Promise<void> {
		return this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO fleet_v2_offers(offer_id,account_id,observation_hash,policy_revision,state,body)
					 VALUES(?,?,?,?,?,?) ON CONFLICT(offer_id) DO UPDATE SET
					 observation_hash=excluded.observation_hash,policy_revision=excluded.policy_revision,
					 state=excluded.state,body=excluded.body`,
				)
				.run(
					offer.offerId,
					offer.accountId,
					offer.observationHash,
					offer.policyRevision,
					offer.state,
					toJsonString(OfferAdmissionSchema, offer),
				);
		});
	}

	putCapacityGroup(
		group: import("./parse.js").ParsedCapacityGroup,
	): Promise<CapacityGroup> {
		return this.tx(() => {
			const existing = this.capacityInside(group.id);
			if (!existing) {
				if (group.seq !== 0)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"new capacity sequence must be zero",
					);
				this.db
					.prepare(
						"INSERT INTO fleet_v2_capacity_groups(id,account_id,approved_units,reserved_units,seq,state,body) VALUES(?,?,?,?,?,?,?)",
					)
					.run(
						group.id,
						group.accountId,
						group.approvedUnits,
						group.reservedUnits,
						group.seq,
						group.state,
						toJsonString(CapacityGroupSchema, group),
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
				existing.state as import("./state-machine.js").CapacityGroupState,
				group.state as import("./state-machine.js").CapacityGroupState,
			);
			const updated = clone(CapacityGroupSchema, group);
			updated.seq += 1;
			const changed = this.db
				.prepare(
					"UPDATE fleet_v2_capacity_groups SET approved_units=?,seq=seq+1,state=?,body=? WHERE id=? AND seq=? AND reserved_units=?",
				)
				.run(
					updated.approvedUnits,
					updated.state,
					toJsonString(CapacityGroupSchema, updated),
					group.id,
					group.seq,
					group.reservedUnits,
				).changes;
			if (changed !== 1)
				rejectFleet(
					FleetRejectionCode.CAPACITY_CONFLICT,
					"capacity group update conflict",
				);
			if (updated.state === "quarantined")
				this.event(
					FleetEventType.CAPACITY_QUARANTINED,
					this.now(),
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
		return this.tx(() => {
			const key = executionKeyId(demand.key);
			for (const deliveryId of demand.sourceDeliveryIds) {
				const row = this.db
					.prepare(
						"SELECT demand_key FROM fleet_v2_demand_deliveries WHERE delivery_id=?",
					)
					.get(deliveryId);
				if (row && z.string().parse(row.demand_key) !== key)
					rejectFleet(
						FleetRejectionCode.DEMAND_CONFLICT,
						"source delivery belongs to another demand",
					);
			}
			const existing = this.demandInside(key);
			if (!existing) {
				this.db
					.prepare(
						"INSERT INTO fleet_v2_demands(key,account_id,state,policy_revision,required_profile_id,body) VALUES(?,?,?,?,?,?)",
					)
					.run(
						key,
						executionAccountId(demand.key),
						demand.state,
						demand.policyRevision,
						demand.requiredProfileId,
						toJsonString(CiDemandSchema, demand),
					);
				for (const deliveryId of demand.sourceDeliveryIds)
					this.db
						.prepare(
							"INSERT INTO fleet_v2_demand_deliveries(delivery_id,demand_key) VALUES(?,?)",
						)
						.run(deliveryId, key);
				this.event(
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
			if (existing.state === "observed" && demand.state === "eligible")
				transitionCiDemand("observed", "eligible");
			if (existing.state === "observed" && demand.state === "eligible")
				updated.state = "eligible";
			for (const deliveryId of demand.sourceDeliveryIds)
				this.db
					.prepare(
						"INSERT INTO fleet_v2_demand_deliveries(delivery_id,demand_key) VALUES(?,?) ON CONFLICT(delivery_id) DO NOTHING",
					)
					.run(deliveryId, key);
			this.saveDemand(updated);
			this.event(
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
		return this.tx(() => {
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
			const demand = this.demandInside(key);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "demand not found");
			const current = this.currentIncarnationSync();
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
				this.claimInside(key)
			)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"demand is not available for admission",
				);
			const offer = this.offerInside(input.slot.offerId);
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
			const profile = this.profileInside(input.slot.profileId);
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
			const group = this.capacityInside(input.slot.capacityGroupId);
			if (!group)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
			if (group.accountId !== executionAccountId(input.demandKey))
				rejectFleet(
					FleetRejectionCode.CAPACITY_INELIGIBLE,
					"capacity group account does not match demand account",
				);
			const unresolvedSlot = this.db
				.prepare(
					`SELECT id FROM fleet_v2_runner_slots
					 WHERE demand_key=? AND state IN ('reserved','provisioning','registered','bound','draining','uncertain')`,
				)
				.get(key);
			if (unresolvedSlot)
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"demand already has an open capacity reservation",
				);
			const reserved = this.db
				.prepare(
					`UPDATE fleet_v2_capacity_groups SET reserved_units=reserved_units+?,seq=seq+1
					 WHERE id=? AND seq=? AND state='active' AND reserved_units+?<=approved_units`,
				)
				.run(
					input.slot.capacityCostUnits,
					group.id,
					input.expectedCapacitySeq,
					input.slot.capacityCostUnits,
				).changes;
			if (reserved !== 1) {
				const latest = this.capacityInside(group.id);
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
			const at = this.now();
			const slot = clone(RunnerSlotSchema, input.slot);
			slot.createdAt = at;
			const effect = clone(EffectSchema, input.effect);
			effect.createdAt = at;
			const outbox = clone(OutboxSchema, input.outbox);
			outbox.createdAt = at;
			outbox.availableAt = at;
			this.db
				.prepare(
					`INSERT INTO fleet_v2_runner_slots(id,account_id,offer_id,profile_id,runner_name,state,
					 capacity_group_id,capacity_cost_units,offer_observation_hash,binding_secret_hash,incarnation_id,demand_key,body)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
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
				);
			this.db
				.prepare(
					`INSERT INTO fleet_v2_effects(id,subject_type,subject_id,kind,sequence,state,
					 idempotency_key,provider_scope,next_fence,body) VALUES(?,?,?,?,?,?,?,?,0,?)`,
				)
				.run(
					effect.id,
					effect.subjectType,
					effect.subjectId,
					effect.kind,
					effect.sequence,
					effect.state,
					effect.idempotencyKey,
					effect.providerScope,
					toJsonString(EffectSchema, effect),
				);
			this.db
				.prepare(
					"INSERT INTO fleet_v2_outbox(id,effect_id,state,body) VALUES(?,?,?,?)",
				)
				.run(
					outbox.id,
					outbox.effectId,
					outbox.state,
					toJsonString(OutboxSchema, outbox),
				);
			const updatedGroup = clone(CapacityGroupSchema, group);
			updatedGroup.reservedUnits += slot.capacityCostUnits;
			updatedGroup.seq += 1;
			this.saveCapacity(updatedGroup);
			const updatedDemand = clone(CiDemandSchema, demand);
			transitionCiDemand(
				demand.state as import("./state-machine.js").CiDemandState,
				"eligible",
			);
			updatedDemand.state = "eligible";
			this.saveDemand(updatedDemand);
			this.event(
				FleetEventType.CAPACITY_RESERVED,
				at,
				slot.accountId,
				"runner-slot",
				slot.id,
				input.demandKey,
				current.id,
			);
			this.event(
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

	private currentIncarnationSync(): ControllerIncarnation | undefined {
		const row = this.db
			.prepare("SELECT body FROM fleet_v2_incarnations WHERE current=1")
			.get();
		return row
			? fromJsonString(ControllerIncarnationSchema, body(row))
			: undefined;
	}

	transitionRunnerSlot(
		id: string,
		expected: RunnerSlotState,
		next: RunnerSlotState,
		externalRunnerId?: string,
	): Promise<RunnerSlot> {
		return this.tx(() => {
			const slot = this.slotInside(id);
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
				const claim = this.db
					.prepare(
						"SELECT key FROM fleet_v2_execution_claims WHERE runner_slot_id=?",
					)
					.get(slot.id);
				if (claim)
					rejectFleet(
						FleetRejectionCode.INVALID_TRANSITION,
						"claimed runner release requires execution settlement",
					);
				const changed = this.db
					.prepare(
						"UPDATE fleet_v2_capacity_groups SET reserved_units=reserved_units-?,seq=seq+1 WHERE id=? AND reserved_units>=?",
					)
					.run(
						slot.capacityCostUnits,
						slot.capacityGroupId,
						slot.capacityCostUnits,
					).changes;
				if (changed !== 1)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"capacity release would make reserved units negative",
					);
				const currentGroup = this.capacityInside(slot.capacityGroupId);
				if (currentGroup) {
					const group = clone(CapacityGroupSchema, currentGroup);
					group.reservedUnits -= slot.capacityCostUnits;
					group.seq += 1;
					this.saveCapacity(group);
				}
			}
			slot.state = next;
			if (externalRunnerId !== undefined)
				slot.externalRunnerId = externalRunnerId;
			this.saveSlot(slot);
			this.event(
				FleetEventType.RUNNER_SLOT_TRANSITIONED,
				this.now(),
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
		return this.tx(() => {
			const slot = this.slotInside(id);
			if (!slot)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "runner slot not found");
			if (slot.state !== expected)
				rejectFleet(
					FleetRejectionCode.INVALID_TRANSITION,
					`runner slot expected ${expected}, found ${slot.state}`,
				);
			const group = this.capacityInside(slot.capacityGroupId);
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
			this.saveSlot(slot);
			this.saveCapacity(group);
			const at = this.now();
			this.event(
				FleetEventType.RUNNER_SLOT_TRANSITIONED,
				at,
				slot.accountId,
				"runner-slot",
				slot.id,
				undefined,
				slot.incarnationId,
			);
			this.event(
				FleetEventType.CAPACITY_QUARANTINED,
				at,
				group.accountId,
				"capacity-group",
				group.id,
			);
			return slot;
		});
	}

	private assertEffectIncarnationCurrent(effect: Effect): void {
		const slot =
			effect.subjectType === "runner-slot"
				? this.slotInside(effect.subjectId)
				: effect.subjectType === "execution-claim"
					? (() => {
							const claim = this.claimByIdInside(effect.subjectId);
							return claim ? this.slotInside(claim.runnerSlotId) : undefined;
						})()
					: undefined;
		if (!slot) return;
		const current = this.currentIncarnationSync();
		if (!current || slot.incarnationId !== current.id)
			rejectFleet(
				FleetRejectionCode.INCARNATION_STALE,
				"effect belongs to a stale controller incarnation",
			);
	}

	claimEffect(input: EffectClaimInput): Promise<WorkerDelivery> {
		leaseDuration(input.leaseMs);
		positiveInteger(input.ownerEpoch, "owner epoch");
		return this.tx(() => {
			const effect = this.effectInside(input.effectId);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			this.assertEffectIncarnationCurrent(effect);
			const now = this.now();
			const activeRow = this.db
				.prepare(
					"SELECT body FROM fleet_v2_deliveries WHERE effect_id=? AND state='claimed'",
				)
				.get(effect.id);
			if (activeRow) {
				const active = fromJsonString(WorkerDeliverySchema, body(activeRow));
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
				this.db
					.prepare(
						"UPDATE fleet_v2_deliveries SET state='expired',body=? WHERE id=? AND state='claimed'",
					)
					.run(toJsonString(WorkerDeliverySchema, active), active.id);
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
			const fenceRow = z
				.object({ next_fence: z.number().int().nonnegative() })
				.parse(
					this.db
						.prepare("SELECT next_fence FROM fleet_v2_effects WHERE id=?")
						.get(effect.id),
				);
			const fence = fenceRow.next_fence + 1;
			const expiresAt = this.expiry(input.leaseMs);
			const delivery = create(WorkerDeliverySchema, {
				id: randomUUID(),
				effectId: effect.id,
				workerId: input.workerId,
				ownerEpoch: input.ownerEpoch,
				fence,
				expiresAt,
				state: "claimed",
			});
			this.db
				.prepare(
					"INSERT INTO fleet_v2_deliveries(id,effect_id,worker_id,owner_epoch,fence,expires_at,state,body) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(
					delivery.id,
					delivery.effectId,
					delivery.workerId,
					delivery.ownerEpoch,
					delivery.fence,
					delivery.expiresAt,
					delivery.state,
					toJsonString(WorkerDeliverySchema, delivery),
				);
			this.db
				.prepare("UPDATE fleet_v2_effects SET next_fence=? WHERE id=?")
				.run(fence, effect.id);
			const outbox = this.outboxInside(effect.id);
			if (outbox) {
				outbox.state = "claimed";
				this.saveOutbox(outbox);
			}
			const slot = this.slotInside(effect.subjectId);
			this.event(
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

	private fenceInside(input: EffectFenceInput): WorkerDelivery {
		const row = this.db
			.prepare(
				`SELECT id,expires_at FROM fleet_v2_deliveries
				 WHERE effect_id=? AND worker_id=? AND owner_epoch=? AND fence=? AND state='claimed'`,
			)
			.get(input.effectId, input.workerId, input.ownerEpoch, input.fence);
		if (!row)
			rejectFleet(
				FleetRejectionCode.STALE_DELIVERY_FENCE,
				"worker, owner epoch or fence is stale",
			);
		const fence = FenceRow.parse(row);
		if (fence.expires_at <= this.now())
			rejectFleet(
				FleetRejectionCode.STALE_DELIVERY_FENCE,
				"delivery lease expired",
			);
		const full = this.db
			.prepare("SELECT body FROM fleet_v2_deliveries WHERE id=?")
			.get(fence.id);
		return fromJsonString(WorkerDeliverySchema, body(full));
	}

	renewEffectDelivery(
		input: EffectFenceInput & { leaseMs: number },
	): Promise<WorkerDelivery> {
		leaseDuration(input.leaseMs);
		return this.tx(() => {
			const delivery = this.fenceInside(input);
			delivery.expiresAt = this.expiry(input.leaseMs);
			const changed = this.db
				.prepare(
					`UPDATE fleet_v2_deliveries SET expires_at=?,body=?
					 WHERE id=? AND effect_id=? AND worker_id=? AND owner_epoch=? AND fence=? AND state='claimed'`,
				)
				.run(
					delivery.expiresAt,
					toJsonString(WorkerDeliverySchema, delivery),
					delivery.id,
					input.effectId,
					input.workerId,
					input.ownerEpoch,
					input.fence,
				).changes;
			if (changed !== 1)
				rejectFleet(
					FleetRejectionCode.STALE_DELIVERY_FENCE,
					"delivery renewal fence changed",
				);
			return delivery;
		});
	}

	markEffectDispatching(input: EffectFenceInput): Promise<Effect> {
		return this.tx(() => {
			this.fenceInside(input);
			const effect = this.effectInside(input.effectId);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			this.assertEffectIncarnationCurrent(effect);
			transitionEffect(
				effect.state as import("./state-machine.js").EffectState,
				"dispatching",
			);
			effect.state = "dispatching";
			this.saveEffect(effect);
			const slot = this.slotInside(effect.subjectId);
			this.event(
				FleetEventType.EFFECT_DISPATCHING,
				this.now(),
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
		return this.tx(() => {
			const delivery = this.fenceInside(input);
			const effect = this.effectInside(input.effectId);
			if (!effect)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "effect not found");
			this.assertEffectIncarnationCurrent(effect);
			const nextEffect =
				input.outcome === "confirmed"
					? "confirmed"
					: input.outcome === "uncertain"
						? "uncertain"
						: "planned";
			transitionEffect(
				effect.state as import("./state-machine.js").EffectState,
				nextEffect,
			);
			effect.state = nextEffect;
			delivery.state =
				input.outcome === "pre-mutation-refusal" ? "superseded" : "acked";
			this.saveEffect(effect);
			this.db
				.prepare("UPDATE fleet_v2_deliveries SET state=?,body=? WHERE id=?")
				.run(
					delivery.state,
					toJsonString(WorkerDeliverySchema, delivery),
					delivery.id,
				);
			const outbox = this.outboxInside(effect.id);
			if (outbox) {
				outbox.state =
					nextEffect === "confirmed"
						? "done"
						: nextEffect === "uncertain"
							? "uncertain"
							: "pending";
				this.saveOutbox(outbox);
			}
			const slot = this.slotInside(effect.subjectId);
			this.event(
				nextEffect === "confirmed"
					? FleetEventType.EFFECT_CONFIRMED
					: nextEffect === "uncertain"
						? FleetEventType.EFFECT_UNCERTAIN
						: FleetEventType.EFFECT_PLANNED,
				this.now(),
				slot?.accountId ?? "system",
				"effect",
				effect.id,
				undefined,
				slot?.incarnationId,
			);
			return effect;
		});
	}

	private verifyStart(
		slot: RunnerSlot,
		demand: CiDemand,
		input: ParsedStartBindingInput,
	): void {
		const current = this.currentIncarnationSync();
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
		const offer = this.offerInside(slot.offerId);
		if (offer?.state !== "active" || offer.accountId !== slot.accountId)
			rejectFleet(FleetRejectionCode.OFFER_REVOKED, "Offer is revoked");
		const reservedKey = z
			.object({ demand_key: z.string() })
			.safeParse(
				this.db
					.prepare("SELECT demand_key FROM fleet_v2_runner_slots WHERE id=?")
					.get(slot.id),
			);
		const reservedDemand = reservedKey.success
			? this.demandInside(reservedKey.data.demand_key)
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
		const group = this.capacityInside(slot.capacityGroupId);
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
		const profile = this.profileInside(slot.profileId);
		if (profile?.guarantee !== "start-fenced")
			rejectFleet(
				FleetRejectionCode.GUARANTEE_REQUIRED,
				"start binding requires a start-fenced profile",
			);
	}

	startDagger(
		input: ParsedDaggerStartInput,
	): Promise<{ claim: ExecutionClaim; created: boolean }> {
		return this.tx(() => {
			const key = executionKeyId(input.key);
			if (input.key.key.case !== "daggerPipeline")
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"Dagger pipeline key required",
				);
			const pipeline = input.key.key.value;
			const row = this.db
				.prepare(
					"SELECT * FROM fleet_v2_dagger_allocations WHERE account_id=? AND pipeline_id=?",
				)
				.get(pipeline.accountId, pipeline.pipelineId);
			if (row) {
				const allocation = DaggerAllocation.parse(row);
				const existing = this.claimByIdInside(allocation.claim_id);
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
			if (this.claimInside(key) || this.claimByIdInside(input.claimId))
				rejectFleet(
					FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
					"execution claim already exists",
				);
			const demand = this.demandInside(key);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "pipeline demand not found");
			if (!["observed", "eligible"].includes(demand.state))
				rejectFleet(
					FleetRejectionCode.DEMAND_CONFLICT,
					"pipeline demand is not available",
				);
			const incarnation = this.currentIncarnationSync();
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
			const offer = this.offerInside(input.offerId);
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
			const profile = this.profileInside(input.profileId);
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
			const group = this.capacityInside(input.capacityGroupId);
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
			const at = this.now();
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
			this.saveCapacity(updatedGroup);
			this.db
				.prepare(
					"INSERT INTO fleet_v2_execution_claims(id,key,runner_slot_id,state,start_authorized_at,body) VALUES(?,?,?,?,?,?)",
				)
				.run(
					claim.id,
					key,
					`!dagger:${claim.id}`,
					claim.state,
					at,
					toJsonString(ExecutionClaimSchema, claim),
				);
			this.db
				.prepare(
					"INSERT INTO fleet_v2_dagger_allocations(claim_id,account_id,pipeline_id,capacity_group_id,capacity_cost_units,engine_endpoint_hash,offer_observation_hash,policy_revision) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(
					claim.id,
					pipeline.accountId,
					pipeline.pipelineId,
					group.id,
					input.capacityCostUnits,
					input.engineEndpointHash,
					input.offerObservationHash,
					input.expectedPolicyRevision,
				);
			if (demand.state === "observed")
				transitionCiDemand("observed", "eligible");
			transitionCiDemand("eligible", "satisfied");
			demand.state = "satisfied";
			this.saveDemand(demand);
			this.event(
				FleetEventType.CAPACITY_RESERVED,
				at,
				pipeline.accountId,
				"execution-claim",
				claim.id,
				input.key,
				incarnation.id,
			);
			this.event(
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
		return this.tx(() => {
			const key = executionKeyId(input.key);
			if (input.key.key.case !== "daggerPipeline")
				rejectFleet(
					FleetRejectionCode.INVALID_RECORD,
					"Dagger pipeline key required",
				);
			const row = this.db
				.prepare("SELECT * FROM fleet_v2_dagger_allocations WHERE claim_id=?")
				.get(input.claimId);
			const claim = this.claimByIdInside(input.claimId);
			if (!row || !claim)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "pipeline claim not found");
			const allocation = DaggerAllocation.parse(row);
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
			const demand = this.demandInside(key);
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
			if (this.currentIncarnationSync()?.id !== input.incarnationId)
				rejectFleet(
					FleetRejectionCode.INCARNATION_STALE,
					"controller incarnation changed",
				);
			const offer = this.offerInside(input.offerId);
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
			if (this.profileInside(input.profileId)?.guarantee !== "start-fenced")
				rejectFleet(
					FleetRejectionCode.GUARANTEE_REQUIRED,
					"strict execution profile unavailable",
				);
			const group = this.capacityInside(allocation.capacity_group_id);
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
		return this.tx(() => {
			const slot = this.slotInside(input.slotId);
			if (!slot)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "runner slot not found");
			const key = executionKeyId(input.key);
			const existing = this.claimInside(key);
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
				const demand = this.demandInside(key);
				if (!demand)
					rejectFleet(FleetRejectionCode.NOT_FOUND, "actual demand not found");
				this.verifyStart(slot, demand, input);
				return { claim: existing, idempotent: true };
			}
			if (this.claimByIdInside(input.claimId))
				rejectFleet(
					FleetRejectionCode.EXECUTION_ALREADY_CLAIMED,
					"claim id is already used by another execution",
				);
			const demand = this.demandInside(key);
			if (!demand)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "actual demand not found");
			this.verifyStart(slot, demand, input);
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
			const slotClaim = this.db
				.prepare(
					"SELECT key FROM fleet_v2_execution_claims WHERE runner_slot_id=?",
				)
				.get(slot.id);
			if (slotClaim)
				rejectFleet(
					FleetRejectionCode.SLOT_ALREADY_BOUND,
					"runner slot already has an execution claim",
				);
			const at = this.now();
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
			this.db
				.prepare(
					"INSERT INTO fleet_v2_execution_claims(id,key,runner_slot_id,state,start_authorized_at,body) VALUES(?,?,?,?,?,?)",
				)
				.run(
					claim.id,
					key,
					slot.id,
					claim.state,
					at,
					toJsonString(ExecutionClaimSchema, claim),
				);
			transitionRunnerSlot("registered", "bound");
			slot.state = "bound";
			this.saveSlot(slot);
			transitionCiDemand(
				demand.state as import("./state-machine.js").CiDemandState,
				"satisfied",
			);
			demand.state = "satisfied";
			this.saveDemand(demand);
			this.event(
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
		return this.tx(() => {
			const initial = this.claimByIdInside(input.claimId);
			if (!initial)
				rejectFleet(FleetRejectionCode.NOT_FOUND, "execution claim not found");
			if (initial.key?.key.case === "daggerPipeline")
				return this.completeDaggerInside(initial, input);
			const slot = this.slotInside(initial.runnerSlotId);
			if (!slot)
				rejectFleet(
					FleetRejectionCode.NOT_FOUND,
					"claimed runner slot not found",
				);
			const claim = this.claimByIdInside(input.claimId);
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
					claim.state as import("./state-machine.js").ExecutionClaimState,
					input.state,
				);
				claim.state = input.state;
				if (input.actualStartedAt)
					claim.actualStartedAt = input.actualStartedAt;
				claim.terminalAt = ["completed", "failed", "cancelled"].includes(
					input.state,
				)
					? this.now()
					: claim.terminalAt;
				this.saveClaim(claim);
				if (slot.state === "bound") {
					transitionRunnerSlot("bound", "draining");
					slot.state = "draining";
					this.saveSlot(slot);
				}
				settled = true;
				const eventType = {
					completed: FleetEventType.EXECUTION_COMPLETED,
					failed: FleetEventType.EXECUTION_FAILED,
					cancelled: FleetEventType.EXECUTION_CANCELLED,
					uncertain: FleetEventType.EXECUTION_UNCERTAIN,
				}[input.state];
				this.event(
					eventType,
					this.now(),
					slot.accountId,
					"execution-claim",
					claim.id,
					claim.key,
					claim.incarnationId,
				);
			}
			let capacityReleased = false;
			if (input.teardownConfirmed) {
				const inserted = this.db
					.prepare(
						"INSERT INTO fleet_v2_capacity_releases(claim_id,capacity_group_id,units,released_at) VALUES(?,?,?,?) ON CONFLICT(claim_id) DO NOTHING",
					)
					.run(
						claim.id,
						slot.capacityGroupId,
						slot.capacityCostUnits,
						this.now(),
					).changes;
				if (inserted === 1) {
					const changed = this.db
						.prepare(
							"UPDATE fleet_v2_capacity_groups SET reserved_units=reserved_units-?,seq=seq+1 WHERE id=? AND reserved_units>=?",
						)
						.run(
							slot.capacityCostUnits,
							slot.capacityGroupId,
							slot.capacityCostUnits,
						).changes;
					if (changed !== 1)
						rejectFleet(
							FleetRejectionCode.CAPACITY_CONFLICT,
							"capacity release would make reserved units negative",
						);
					const currentGroup = this.capacityInside(slot.capacityGroupId);
					if (!currentGroup)
						rejectFleet(
							FleetRejectionCode.NOT_FOUND,
							"capacity group not found",
						);
					const group = clone(CapacityGroupSchema, currentGroup);
					group.reservedUnits -= slot.capacityCostUnits;
					group.seq += 1;
					this.saveCapacity(group);
					transitionRunnerSlot(slot.state as RunnerSlotState, "released");
					slot.state = "released";
					this.saveSlot(slot);
					capacityReleased = true;
					this.event(
						FleetEventType.CAPACITY_RELEASED,
						this.now(),
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

	private completeDaggerInside(
		claim: ExecutionClaim,
		input: CompleteExecutionInput,
	) {
		const row = this.db
			.prepare("SELECT * FROM fleet_v2_dagger_allocations WHERE claim_id=?")
			.get(claim.id);
		if (!row)
			rejectFleet(
				FleetRejectionCode.NOT_FOUND,
				"pipeline allocation not found",
			);
		const allocation = DaggerAllocation.parse(row);
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
			transitionExecutionClaim(
				claim.state as import("./state-machine.js").ExecutionClaimState,
				input.state,
			);
			claim.state = input.state;
			if (input.actualStartedAt) claim.actualStartedAt = input.actualStartedAt;
			if (["completed", "failed", "cancelled"].includes(input.state))
				claim.terminalAt = this.now();
			this.saveClaim(claim);
			settled = true;
			const eventType = {
				completed: FleetEventType.EXECUTION_COMPLETED,
				failed: FleetEventType.EXECUTION_FAILED,
				cancelled: FleetEventType.EXECUTION_CANCELLED,
				uncertain: FleetEventType.EXECUTION_UNCERTAIN,
			}[input.state];
			this.event(
				eventType,
				this.now(),
				allocation.account_id,
				"execution-claim",
				claim.id,
				claim.key,
				claim.incarnationId,
			);
		} else if (input.actualStartedAt && !claim.actualStartedAt) {
			claim.actualStartedAt = input.actualStartedAt;
			this.saveClaim(claim);
		}
		let capacityReleased = false;
		if (input.teardownConfirmed) {
			const inserted = this.db
				.prepare(
					"INSERT INTO fleet_v2_capacity_releases(claim_id,capacity_group_id,units,released_at) VALUES(?,?,?,?) ON CONFLICT(claim_id) DO NOTHING",
				)
				.run(
					claim.id,
					allocation.capacity_group_id,
					allocation.capacity_cost_units,
					this.now(),
				).changes;
			if (inserted === 1) {
				const group = this.capacityInside(allocation.capacity_group_id);
				if (!group)
					rejectFleet(FleetRejectionCode.NOT_FOUND, "capacity group not found");
				if (group.reservedUnits < allocation.capacity_cost_units)
					rejectFleet(
						FleetRejectionCode.CAPACITY_CONFLICT,
						"capacity release would make reserved units negative",
					);
				group.reservedUnits -= allocation.capacity_cost_units;
				group.seq += 1;
				this.saveCapacity(group);
				capacityReleased = true;
				this.event(
					FleetEventType.CAPACITY_RELEASED,
					this.now(),
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
		return this.tx(() => {
			const row = this.db
				.prepare(
					"SELECT account_id,sequence FROM fleet_v2_observation_watermarks WHERE worker_id=?",
				)
				.get(observation.workerId);
			if (row) {
				const current = z
					.object({ account_id: z.string(), sequence: z.number().int() })
					.parse(row);
				if (
					current.account_id !== observation.accountId ||
					observation.sequence <= current.sequence
				)
					rejectFleet(
						FleetRejectionCode.OBSERVATION_SEQUENCE_REGRESSED,
						"worker observation sequence regressed or account changed",
					);
			}
			this.db
				.prepare(
					"INSERT INTO fleet_v2_observations(worker_id,sequence,body) VALUES(?,?,?)",
				)
				.run(
					observation.workerId,
					observation.sequence,
					toJsonString(ObservationSchema, observation),
				);
			this.db
				.prepare(
					`INSERT INTO fleet_v2_observation_watermarks(worker_id,account_id,sequence) VALUES(?,?,?)
					 ON CONFLICT(worker_id) DO UPDATE SET sequence=excluded.sequence`,
				)
				.run(observation.workerId, observation.accountId, observation.sequence);
			this.event(
				FleetEventType.OBSERVATION_ACCEPTED,
				observation.observedAt,
				observation.accountId,
				"worker",
				observation.workerId,
			);
		});
	}

	demand(
		key: import("./parse.js").ParsedExecutionKey,
	): Promise<CiDemand | undefined> {
		return this.read(() => this.demandInside(executionKeyId(key)));
	}

	runnerSlot(id: string): Promise<RunnerSlot | undefined> {
		return this.read(() => this.slotInside(id));
	}

	executionClaim(
		key: import("./parse.js").ParsedExecutionKey,
	): Promise<ExecutionClaim | undefined> {
		return this.read(() => this.claimInside(executionKeyId(key)));
	}

	executionClaimById(id: string): Promise<ExecutionClaim | undefined> {
		return this.read(() => this.claimByIdInside(id));
	}

	capacityGroup(id: string): Promise<CapacityGroup | undefined> {
		return this.read(() => this.capacityInside(id));
	}

	effect(id: string): Promise<Effect | undefined> {
		return this.read(() => this.effectInside(id));
	}

	outbox(effectId: string): Promise<Outbox | undefined> {
		return this.read(() => this.outboxInside(effectId));
	}

	deliveries(effectId: string): Promise<WorkerDelivery[]> {
		return this.read(() =>
			this.db
				.prepare(
					"SELECT body FROM fleet_v2_deliveries WHERE effect_id=? ORDER BY fence",
				)
				.all(effectId)
				.map((row) => fromJsonString(WorkerDeliverySchema, body(row))),
		);
	}

	observationSequence(workerId: string): Promise<number> {
		return this.read(() => {
			const row = this.db
				.prepare(
					"SELECT sequence FROM fleet_v2_observation_watermarks WHERE worker_id=?",
				)
				.get(workerId);
			return row ? z.number().int().parse(row.sequence) : 0;
		});
	}

	events(): Promise<FleetEvent[]> {
		return this.read(() =>
			this.db
				.prepare("SELECT body FROM fleet_v2_events ORDER BY seq")
				.all()
				.map((row) => fromJsonString(FleetEventSchema, body(row))),
		);
	}
}
