/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- fleet v2 parse boundary; zod + protobuf refine untrusted input */
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
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
	type ExecutionKey,
	ExecutionKeySchema,
	type ExecutionProfile,
	ExecutionProfileSchema,
	type FleetEvent,
	FleetEventSchema,
	FleetEventType,
	FleetRejectionCode,
	type Observation,
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
	CAPACITY_GROUP_STATES,
	CI_DEMAND_STATES,
	EFFECT_STATES,
	EXECUTION_CLAIM_STATES,
	FleetRejection,
	OUTBOX_STATES,
	RUNNER_SLOT_STATES,
	WORKER_DELIVERY_STATES,
} from "./state-machine.js";

declare const parsedFleetRecord: unique symbol;
export type ParsedFleetRecord<T> = T & {
	readonly [parsedFleetRecord]: true;
};
export type ParsedExecutionKey = ParsedFleetRecord<ExecutionKey>;
export type ParsedExecutionProfile = ParsedFleetRecord<ExecutionProfile>;
export type ParsedCiDemand = ParsedFleetRecord<CiDemand>;
export type ParsedRunnerSlot = ParsedFleetRecord<RunnerSlot>;
export type ParsedExecutionClaim = ParsedFleetRecord<ExecutionClaim>;
export type ParsedEffect = ParsedFleetRecord<Effect>;
export type ParsedWorkerDelivery = ParsedFleetRecord<WorkerDelivery>;
export type ParsedCapacityGroup = ParsedFleetRecord<CapacityGroup>;
export type ParsedControllerIncarnation =
	ParsedFleetRecord<ControllerIncarnation>;
export type ParsedOutbox = ParsedFleetRecord<Outbox>;
export type ParsedObservation = ParsedFleetRecord<Observation>;
export type ParsedOfferAdmission = ParsedFleetRecord<OfferAdmission>;
export type ParsedFleetEvent = ParsedFleetRecord<FleetEvent>;

export interface StartBindingInput {
	slotId: string;
	claimId: string;
	key: ParsedExecutionKey;
	bindingSecret: string;
	assignment: {
		verified: true;
		accountId: string;
		runnerName: string;
		profileId: string;
	};
}
export type ParsedStartBindingInput = ParsedFleetRecord<StartBindingInput>;

const idPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const timePattern =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
const demandSources = new Set([
	"webhook",
	"pull",
	"scale-set",
	"repair",
	"pipeline",
]);
const isolationModes = new Set([
	"trusted-process",
	"isolated-container",
	"kubernetes-approved",
	"sandbox",
	"operator-engine",
]);
const lifecycleModes = new Set([
	"persistent-capacity",
	"ephemeral-environment",
]);
const guaranteeModes = new Set(["start-fenced", "external-assignment"]);
const effectSubjects = new Set([
	"runner-slot",
	"execution-claim",
	"worker-binding",
]);
const eventSubjects = new Set([
	"demand",
	"runner-slot",
	"execution-claim",
	"effect",
	"capacity-group",
	"worker",
	"controller-incarnation",
]);

function invalid(message: string): never {
	throw new FleetRejection(FleetRejectionCode.INVALID_RECORD, message);
}

function requireRecord(condition: unknown, message: string): asserts condition {
	if (!condition) invalid(message);
}

function id(value: string, field = "id"): void {
	requireRecord(idPattern.test(value), `invalid fleet ${field}`);
}

function positive(value: number, field: string): void {
	requireRecord(
		Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff,
		`invalid fleet ${field}`,
	);
}

function nonnegative(value: number, field: string): void {
	requireRecord(
		Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
		`invalid fleet ${field}`,
	);
}

function timestamp(value: string, field: string): void {
	requireRecord(
		timePattern.test(value) && Number.isFinite(Date.parse(value)),
		`invalid fleet ${field}`,
	);
}

function hash(value: string, field: string): void {
	requireRecord(hashPattern.test(value), `invalid fleet ${field}`);
}

function oneOf(
	value: string,
	values: ReadonlySet<string>,
	field: string,
): void {
	requireRecord(values.has(value), `invalid fleet ${field}`);
}

function state(value: string, values: readonly string[], field: string): void {
	requireRecord(values.includes(value), `invalid fleet ${field}`);
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

function branded<T>(value: T): ParsedFleetRecord<T> {
	// SAFETY: every caller has completed the record-specific invariant checks above.
	return deepFreeze(value) as ParsedFleetRecord<T>;
}

function message<T extends import("@bufbuild/protobuf").Message>(
	schema: GenMessage<T>,
	json: string,
): T {
	try {
		return fromJsonString(schema, json);
	} catch (error) {
		throw new FleetRejection(
			FleetRejectionCode.INVALID_RECORD,
			`invalid fleet protobuf JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validateExecutionKey(key: ExecutionKey | undefined): void {
	requireRecord(key, "execution key required");
	if (key.key.case === "githubJob") {
		const github = key.key.value;
		requireRecord(github.kind === "github-job", "invalid GitHub job kind");
		requireRecord(github.engineId === "gh-actions", "invalid GitHub engine");
		id(github.accountId, "account ID");
		for (const [field, value] of [
			["installation ID", github.installationId],
			["repository ID", github.repositoryId],
			["run ID", github.runId],
			["job ID", github.jobId],
		] as const)
			requireRecord(value.length > 0, `empty GitHub ${field}`);
		positive(github.runAttempt, "run attempt");
		return;
	}
	if (key.key.case === "daggerPipeline") {
		const dagger = key.key.value;
		requireRecord(
			dagger.kind === "dagger-pipeline",
			"invalid Dagger pipeline kind",
		);
		requireRecord(dagger.engineId === "dagger", "invalid Dagger engine");
		id(dagger.accountId, "account ID");
		requireRecord(dagger.pipelineId.length > 0, "empty Dagger pipeline ID");
		requireRecord(
			dagger.pipelineDigest.length > 0,
			"empty Dagger pipeline digest",
		);
		return;
	}
	invalid("execution key variant required");
}

export function parseExecutionKey(json: string): ParsedExecutionKey {
	const key = message(ExecutionKeySchema, json);
	validateExecutionKey(key);
	return branded(key);
}

export function executionKeyId(key: ExecutionKey | undefined): string {
	requireRecord(key, "execution key required");
	validateExecutionKey(key);
	return toJsonString(ExecutionKeySchema, key);
}

export function executionAccountId(key: ExecutionKey | undefined): string {
	requireRecord(key, "execution key required");
	validateExecutionKey(key);
	if (key.key.case === "githubJob" || key.key.case === "daggerPipeline")
		return key.key.value.accountId;
	return invalid("execution key variant required");
}

export function parseExecutionProfile(json: string): ParsedExecutionProfile {
	const profile = message(ExecutionProfileSchema, json);
	id(profile.id);
	requireRecord(profile.os === "linux", "only linux profiles are supported");
	requireRecord(
		profile.architecture === "x64",
		"only x64 profiles are supported",
	);
	oneOf(profile.isolation, isolationModes, "isolation");
	oneOf(profile.lifecycle, lifecycleModes, "lifecycle");
	oneOf(profile.guarantee, guaranteeModes, "guarantee");
	return branded(profile);
}

export function parseCiDemand(json: string): ParsedCiDemand {
	const demand = message(CiDemandSchema, json);
	validateExecutionKey(demand.key);
	state(demand.state, CI_DEMAND_STATES, "demand state");
	timestamp(demand.firstObservedAt, "first observation time");
	timestamp(demand.lastObservedAt, "last observation time");
	requireRecord(
		Date.parse(demand.firstObservedAt) <= Date.parse(demand.lastObservedAt),
		"demand observation times regress",
	);
	positive(demand.policyRevision, "policy revision");
	id(demand.requiredProfileId, "required profile ID");
	oneOf(demand.source, demandSources, "demand source");
	requireRecord(
		demand.sourceDeliveryIds.length > 0 &&
			demand.sourceDeliveryIds.every((value) => value.length > 0) &&
			new Set(demand.sourceDeliveryIds).size ===
				demand.sourceDeliveryIds.length,
		"demand source delivery IDs must be nonempty and unique",
	);
	return branded(demand);
}

export function parseRunnerSlot(json: string): ParsedRunnerSlot {
	const slot = message(RunnerSlotSchema, json);
	id(slot.id);
	id(slot.accountId, "account ID");
	id(slot.offerId, "Offer ID");
	id(slot.profileId, "profile ID");
	requireRecord(
		/^hobo-[A-Za-z0-9-]{1,100}$/.test(slot.runnerName),
		"invalid runner name",
	);
	state(slot.state, RUNNER_SLOT_STATES, "runner slot state");
	id(slot.capacityGroupId, "capacity group ID");
	positive(slot.capacityCostUnits, "capacity cost");
	hash(slot.policyHash, "policy hash");
	hash(slot.offerObservationHash, "Offer observation hash");
	if (slot.quoteHash) hash(slot.quoteHash, "quote hash");
	if (slot.bindingSecretHash)
		hash(slot.bindingSecretHash, "binding secret hash");
	id(slot.incarnationId, "incarnation ID");
	timestamp(slot.createdAt, "slot creation time");
	return branded(slot);
}

export function parseExecutionClaim(json: string): ParsedExecutionClaim {
	const claim = message(ExecutionClaimSchema, json);
	id(claim.id);
	validateExecutionKey(claim.key);
	if (claim.runnerSlotId) id(claim.runnerSlotId, "runner slot ID");
	state(claim.state, EXECUTION_CLAIM_STATES, "execution claim state");
	id(claim.profileId, "profile ID");
	hash(claim.policyHash, "policy hash");
	id(claim.offerId, "Offer ID");
	if (claim.quoteHash) hash(claim.quoteHash, "quote hash");
	timestamp(claim.startAuthorizedAt, "start authorization time");
	if (claim.actualStartedAt)
		timestamp(claim.actualStartedAt, "actual start time");
	if (claim.terminalAt) timestamp(claim.terminalAt, "terminal time");
	requireRecord(
		!["completed", "failed", "cancelled"].includes(claim.state) ||
			!!claim.terminalAt,
		"terminal execution claim requires terminal time",
	);
	id(claim.incarnationId, "incarnation ID");
	return branded(claim);
}

export function parseEffect(json: string): ParsedEffect {
	const effect = message(EffectSchema, json);
	id(effect.id);
	oneOf(effect.subjectType, effectSubjects, "effect subject type");
	id(effect.subjectId, "effect subject ID");
	requireRecord(
		/^[a-z][a-z0-9.-]{0,100}$/.test(effect.kind),
		"invalid effect kind",
	);
	positive(effect.sequence, "effect sequence");
	state(effect.state, EFFECT_STATES, "effect state");
	requireRecord(effect.idempotencyKey.length > 0, "empty idempotency key");
	timestamp(effect.createdAt, "effect creation time");
	requireRecord(effect.providerScope.length > 0, "empty provider scope");
	return branded(effect);
}

export function parseWorkerDelivery(json: string): ParsedWorkerDelivery {
	const delivery = message(WorkerDeliverySchema, json);
	id(delivery.id);
	id(delivery.effectId, "effect ID");
	id(delivery.workerId, "worker ID");
	positive(delivery.ownerEpoch, "owner epoch");
	positive(delivery.fence, "delivery fence");
	timestamp(delivery.expiresAt, "delivery expiry");
	state(delivery.state, WORKER_DELIVERY_STATES, "delivery state");
	return branded(delivery);
}

export function parseCapacityGroup(json: string): ParsedCapacityGroup {
	const group = message(CapacityGroupSchema, json);
	id(group.id);
	id(group.accountId, "account ID");
	nonnegative(group.approvedUnits, "approved units");
	nonnegative(group.reservedUnits, "reserved units");
	nonnegative(group.seq, "capacity sequence");
	requireRecord(
		group.reservedUnits <= group.approvedUnits,
		"capacity group is over-reserved",
	);
	state(group.state, CAPACITY_GROUP_STATES, "capacity group state");
	return branded(group);
}

export function parseControllerIncarnation(
	json: string,
): ParsedControllerIncarnation {
	const incarnation = message(ControllerIncarnationSchema, json);
	id(incarnation.id);
	timestamp(incarnation.createdAt, "incarnation creation time");
	oneOf(
		incarnation.reason,
		new Set(["bootstrap", "restore", "explicit-fence"]),
		"incarnation reason",
	);
	return branded(incarnation);
}

export function parseOutbox(json: string): ParsedOutbox {
	const outbox = message(OutboxSchema, json);
	id(outbox.id);
	id(outbox.effectId, "effect ID");
	state(outbox.state, OUTBOX_STATES, "outbox state");
	timestamp(outbox.availableAt, "outbox availability time");
	timestamp(outbox.createdAt, "outbox creation time");
	return branded(outbox);
}

export function parseObservation(json: string): ParsedObservation {
	const observation = message(ObservationSchema, json);
	id(observation.workerId, "worker ID");
	id(observation.accountId, "account ID");
	positive(observation.sequence, "observation sequence");
	timestamp(observation.observedAt, "observation time");
	hash(observation.contentHash, "observation content hash");
	return branded(observation);
}

export function parseOfferAdmission(json: string): ParsedOfferAdmission {
	const offer = message(OfferAdmissionSchema, json);
	id(offer.offerId, "Offer ID");
	id(offer.accountId, "account ID");
	hash(offer.observationHash, "Offer observation hash");
	positive(offer.policyRevision, "policy revision");
	oneOf(offer.state, new Set(["active", "revoked"]), "Offer state");
	return branded(offer);
}

export function parseFleetEvent(json: string): ParsedFleetEvent {
	const event = message(FleetEventSchema, json);
	id(event.id);
	requireRecord(
		Number.isInteger(event.type) &&
			event.type >= FleetEventType.DEMAND_OBSERVED &&
			event.type <= FleetEventType.CAPACITY_QUARANTINED,
		"invalid fleet event type",
	);
	timestamp(event.at, "event time");
	id(event.accountId, "account ID");
	oneOf(event.subjectType, eventSubjects, "event subject type");
	id(event.subjectId, "event subject ID");
	if (event.executionKey) validateExecutionKey(event.executionKey);
	if (event.incarnationId) id(event.incarnationId, "incarnation ID");
	requireRecord(
		Number.isInteger(event.rejectionCode) &&
			event.rejectionCode >= FleetRejectionCode.UNSPECIFIED &&
			event.rejectionCode <= FleetRejectionCode.QUARANTINED,
		"invalid fleet rejection code",
	);
	return branded(event);
}

const startBindingSchema = z
	.object({
		slotId: z.string().regex(idPattern),
		claimId: z.string().regex(idPattern),
		key: z.unknown(),
		bindingSecret: z.string().min(32).max(1024),
		assignment: z
			.object({
				verified: z.literal(true),
				accountId: z.string().regex(idPattern),
				runnerName: z.string().min(1),
				profileId: z.string().regex(idPattern),
			})
			.strict(),
	})
	.strict();

export function parseStartBindingInput(
	input: unknown,
): ParsedStartBindingInput {
	const parsed = startBindingSchema.parse(input);
	const key = parseExecutionKey(JSON.stringify(parsed.key));
	requireRecord(
		executionAccountId(key) === parsed.assignment.accountId,
		"start assignment account differs from execution key",
	);
	return branded({
		slotId: parsed.slotId,
		claimId: parsed.claimId,
		key,
		bindingSecret: parsed.bindingSecret,
		assignment: parsed.assignment,
	});
}
