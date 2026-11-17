import { createHash } from "node:crypto";
import type {
	AppendOptions,
	EventEnvelope,
	EventStore,
	PrincipalRef,
} from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";
import {
	CLOUD_EVENTS,
	type ResourceReconciledData,
	resourceReconciled,
} from "../events.js";
import { isJsonObject, isJsonString } from "../json.js";
import { collectStream, currentFenceToken } from "../store/index.js";
import { resourceActorKey } from "./resource-actor.js";

export interface ReconciliationFinancialEvidence {
	readonly disposition: "none" | "held" | "settled" | "released";
	readonly reservationId?: string;
	readonly evidenceRef: string;
}

export type ReconciliationOutcome =
	| {
			readonly kind: "applied";
			readonly outputs: Readonly<Record<string, string>>;
	  }
	| { readonly kind: "destroyed"; readonly finalStateHash: string }
	| { readonly kind: "no-effect"; readonly baseline?: "absent" };

export type ReconciliationBaseline =
	| { readonly state: "unknown" }
	| { readonly state: "provisioned" | "absent"; readonly eventId: string };

export interface ResourceReconciliationClaim {
	readonly tenant: string;
	readonly deploymentId: string;
	readonly resourceId: string;
	readonly failureEventId: string;
	readonly operation: "apply" | "destroy";
	readonly evidenceRef: string;
	readonly financial: ReconciliationFinancialEvidence;
	readonly outcome: ReconciliationOutcome;
}

export interface ResourceReconciliationVerification {
	readonly claim: ResourceReconciliationClaim;
	readonly actor: PrincipalRef;
	readonly failure: EventEnvelope;
	readonly baseline: ReconciliationBaseline;
	/** The exact application whose result is being verified, when available. */
	readonly provisioning?: EventEnvelope;
}

/** Both verifiers are independently trusted host ports; neither executes recovery. */
export interface ResourceReconciliationDeps {
	readonly store: EventStore;
	readonly actorHost: ActorHost;
	readonly authorize: (input: {
		readonly actor: PrincipalRef;
		readonly tenant: string;
		readonly deploymentId: string;
		readonly resourceId: string;
	}) => boolean | Promise<boolean>;
	readonly verifyOutcome: (
		input: ResourceReconciliationVerification,
	) => boolean | Promise<boolean>;
	readonly verifyFinancial: (
		input: ResourceReconciliationVerification,
	) => boolean | Promise<boolean>;
}

export class ResourceReconciliationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "ResourceReconciliationError";
	}
}

function fail(code: string, message: string): never {
	throw new ResourceReconciliationError(code, message);
}

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function copyActor(
	actor: PrincipalRef,
	seen = new Set<PrincipalRef>(),
): PrincipalRef {
	if (
		seen.size >= 16 ||
		seen.has(actor) ||
		!name(actor.id) ||
		!["user", "agent", "service", "system"].includes(actor.kind)
	)
		fail("RECONCILIATION_INVALID", "invalid operator identity");
	seen.add(actor);
	const copy: PrincipalRef = { kind: actor.kind, id: actor.id };
	if (actor.delegatedBy !== undefined)
		copy.delegatedBy = copyActor(actor.delegatedBy, seen);
	return copy;
}

function copyClaim(
	input: ResourceReconciliationClaim,
): ResourceReconciliationClaim {
	if (
		![
			input.tenant,
			input.deploymentId,
			input.resourceId,
			input.failureEventId,
			input.evidenceRef,
			input.financial.evidenceRef,
		].every(name) ||
		!["apply", "destroy"].includes(input.operation) ||
		!["none", "held", "settled", "released"].includes(
			input.financial.disposition,
		) ||
		(input.financial.reservationId !== undefined &&
			!name(input.financial.reservationId)) ||
		(input.financial.disposition === "none") !==
			(input.financial.reservationId === undefined) ||
		(input.outcome.kind === "no-effect" &&
			input.financial.disposition === "held") ||
		(input.outcome.kind === "applied" &&
			["settled", "released"].includes(input.financial.disposition)) ||
		(input.outcome.kind === "applied" && input.operation !== "apply") ||
		(input.outcome.kind === "destroyed" && input.operation !== "destroy")
	)
		fail(
			"RECONCILIATION_INVALID",
			"invalid operation, scope or financial disposition",
		);
	let outcome: ReconciliationOutcome;
	if (input.outcome.kind === "applied") {
		const descriptors = Object.getOwnPropertyDescriptors(input.outcome.outputs);
		const keys = Object.keys(descriptors).sort();
		if (
			keys.length > 256 ||
			Object.getOwnPropertySymbols(input.outcome.outputs).length > 0
		)
			fail(
				"RECONCILIATION_INVALID",
				"outputs exceed the bounded output contract",
			);
		const outputs: Record<string, string> = Object.create(null);
		let size = 0;
		for (const key of keys) {
			const descriptor = descriptors[key];
			/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: verified infrastructure outputs cross a runtime boundary. */
			if (
				!name(key) ||
				descriptor === undefined ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				typeof descriptor.value !== "string" ||
				descriptor.value.length > 65_536
			)
				fail("RECONCILIATION_INVALID", "outputs must be bounded string data");
			/* oxlint-enable anti-slop/no-runtime-typeof */
			size += key.length + descriptor.value.length;
			if (size > 1_048_576)
				fail(
					"RECONCILIATION_INVALID",
					"outputs exceed the bounded output contract",
				);
			outputs[key] = descriptor.value;
		}
		outcome = { kind: "applied", outputs };
	} else if (input.outcome.kind === "destroyed") {
		if (!name(input.outcome.finalStateHash))
			fail("RECONCILIATION_INVALID", "final state evidence is required");
		outcome = {
			kind: "destroyed",
			finalStateHash: input.outcome.finalStateHash,
		};
	} else if (input.outcome.kind === "no-effect") {
		if (
			input.outcome.baseline !== undefined &&
			input.outcome.baseline !== "absent"
		)
			fail("RECONCILIATION_INVALID", "invalid baseline claim");
		outcome =
			input.outcome.baseline === "absent"
				? { kind: "no-effect", baseline: "absent" }
				: { kind: "no-effect" };
	} else {
		fail("RECONCILIATION_INVALID", "unknown outcome");
	}
	const financial: ReconciliationFinancialEvidence =
		input.financial.reservationId === undefined
			? {
					disposition: input.financial.disposition,
					evidenceRef: input.financial.evidenceRef,
				}
			: {
					disposition: input.financial.disposition,
					reservationId: input.financial.reservationId,
					evidenceRef: input.financial.evidenceRef,
				};
	return {
		tenant: input.tenant,
		deploymentId: input.deploymentId,
		resourceId: input.resourceId,
		failureEventId: input.failureEventId,
		operation: input.operation,
		evidenceRef: input.evidenceRef,
		financial,
		outcome,
	};
}

function claimDigest(claim: ResourceReconciliationClaim): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(claim)).digest("hex")}`;
}

function baselineBeforeFailure(
	events: readonly EventEnvelope[],
	claim: ResourceReconciliationClaim,
): ReconciliationBaseline {
	let baseline: ReconciliationBaseline = { state: "unknown" };
	const failures = new Set<string>();
	for (const event of events) {
		if (event.id === claim.failureEventId) break;
		if (!isJsonObject(event.data) || event.data.resourceId !== claim.resourceId)
			continue;
		if (
			event.type === CLOUD_EVENTS.ResourceFailed &&
			event.data.requiresReconciliation === true
		)
			failures.add(event.id);
		if (
			event.type === CLOUD_EVENTS.ResourceReconciled &&
			isJsonString(event.data.failureEventId) &&
			isJsonString(event.data.outcome) &&
			["applied", "destroyed", "no-effect"].includes(event.data.outcome)
		) {
			const matched = failures.delete(event.data.failureEventId);
			if (matched && failures.size === 0) {
				if (
					event.data.outcome === "applied" ||
					(event.data.outcome === "no-effect" &&
						event.data.restoredState === "provisioned")
				)
					baseline = { state: "provisioned", eventId: event.id };
				else if (
					event.data.outcome === "destroyed" ||
					(event.data.outcome === "no-effect" &&
						(event.data.restoredState === "destroyed" ||
							event.data.restoredState === "failed"))
				)
					baseline = { state: "absent", eventId: event.id };
			}
		}
		if (failures.size === 0) {
			if (event.type === CLOUD_EVENTS.ResourceDestroyed)
				baseline = { state: "absent", eventId: event.id };
			else if (event.type === CLOUD_EVENTS.ResourceProvisioned) {
				if (
					isJsonString(event.data.specHash) &&
					/^sha256:[a-f0-9]{64}$/u.test(event.data.specHash)
				)
					baseline = { state: "provisioned", eventId: event.id };
				else baseline = { state: "unknown" };
			}
		}
	}
	return baseline;
}

function restoredState(
	claim: ResourceReconciliationClaim,
	baseline: ReconciliationBaseline,
): "provisioned" | "destroyed" | "failed" {
	return baseline.state === "provisioned"
		? "provisioned"
		: claim.operation === "destroy"
			? "destroyed"
			: "failed";
}

function recoveryRecord(
	events: readonly EventEnvelope[],
	claim: ResourceReconciliationClaim,
	digest: string,
): EventEnvelope | undefined {
	for (const event of events) {
		if (
			isJsonObject(event.data) &&
			event.data.resourceId === claim.resourceId &&
			(event.tenant !== claim.tenant ||
				event.data.deploymentId !== claim.deploymentId)
		)
			fail(
				"RECONCILIATION_SCOPE_MISMATCH",
				"resource history belongs to another scope",
			);
	}
	const record = events.find(
		(event) =>
			event.type === CLOUD_EVENTS.ResourceReconciled &&
			isJsonObject(event.data) &&
			event.data.failureEventId === claim.failureEventId &&
			event.data.resourceId === claim.resourceId,
	);
	if (record === undefined) return undefined;
	if (
		record.tenant !== claim.tenant ||
		!isJsonObject(record.data) ||
		record.data.claimDigest !== digest ||
		record.data.deploymentId !== claim.deploymentId ||
		record.data.operation !== claim.operation ||
		record.data.outcome !== claim.outcome.kind ||
		record.data.evidenceRef !== claim.evidenceRef ||
		record.data.financialEvidenceRef !== claim.financial.evidenceRef ||
		record.data.financialDisposition !== claim.financial.disposition ||
		record.data.reservationId !== claim.financial.reservationId
	)
		fail(
			"RECONCILIATION_CONFLICT",
			"failure was resolved using a different claim",
		);
	const failure = events.find((event) => event.id === claim.failureEventId);
	if (
		failure === undefined ||
		failure.seq >= record.seq ||
		failure.tenant !== claim.tenant ||
		failure.type !== CLOUD_EVENTS.ResourceFailed ||
		!isJsonObject(failure.data) ||
		failure.data.deploymentId !== claim.deploymentId ||
		failure.data.resourceId !== claim.resourceId ||
		failure.data.requiresReconciliation !== true ||
		failure.data.reconciliationOperation !== claim.operation ||
		(failure.data.reservationId !== undefined &&
			failure.data.reservationId !== claim.financial.reservationId)
	)
		fail(
			"RECONCILIATION_OUTCOME_UNKNOWN",
			"recovery fact has no matching original failure",
		);
	if (claim.outcome.kind === "no-effect") {
		const baseline = baselineBeforeFailure(events, claim);
		if (
			(baseline.state === "unknown" && claim.outcome.baseline !== "absent") ||
			(baseline.state === "provisioned" &&
				claim.outcome.baseline === "absent") ||
			record.data.restoredState !== restoredState(claim, baseline)
		)
			fail(
				"RECONCILIATION_OUTCOME_UNKNOWN",
				"recorded baseline differs from the verified claim",
			);
	}
	if (claim.outcome.kind !== "no-effect") {
		if (
			claim.outcome.kind === "destroyed" &&
			record.data.finalStateHash !== claim.outcome.finalStateHash
		)
			fail(
				"RECONCILIATION_OUTCOME_UNKNOWN",
				"destroyed state differs from the verified claim",
			);
		if (claim.outcome.kind === "applied") {
			const outputs = record.data.outputs;
			const expectedOutputs = claim.outcome.outputs;
			const keys = Object.keys(expectedOutputs);
			if (
				!isJsonObject(outputs) ||
				Object.keys(outputs).length !== keys.length ||
				keys.some((key) => outputs[key] !== expectedOutputs[key])
			)
				fail(
					"RECONCILIATION_OUTCOME_UNKNOWN",
					"recorded outputs differ from the verified claim",
				);
			let original: EventEnvelope | undefined;
			for (const event of events) {
				if (event.id === claim.failureEventId) break;
				if (
					!isJsonObject(event.data) ||
					event.data.resourceId !== claim.resourceId
				)
					continue;
				if (event.type === CLOUD_EVENTS.ResourceProvisioning) original = event;
				if (
					event.type === CLOUD_EVENTS.ResourceProvisioned ||
					event.type === CLOUD_EVENTS.ResourceDestroyed ||
					event.type === CLOUD_EVENTS.ResourceDestroying
				)
					original = undefined;
			}
			if (
				!isJsonObject(original?.data) ||
				record.data.execId !== original.data.execId ||
				record.data.specHash !== original.data.specHash
			)
				fail(
					"RECONCILIATION_OUTCOME_UNKNOWN",
					"recorded application differs from the verified provenance",
				);
		}
	}
	return record;
}

/** Verify an exact unresolved operation before atomically recording its recovery. */
export async function resolveResourceReconciliation(
	deps: ResourceReconciliationDeps,
	input: ResourceReconciliationClaim & { readonly actor: PrincipalRef },
): Promise<{
	readonly status: "resolved" | "replay";
	readonly eventId: string;
}> {
	const claim = copyClaim(input);
	const digest = claimDigest(claim);
	const actor = copyActor(input.actor);
	async function requireAuthorization(): Promise<void> {
		let authorized: boolean;
		try {
			authorized =
				(await deps.authorize({
					actor: structuredClone(actor),
					tenant: claim.tenant,
					deploymentId: claim.deploymentId,
					resourceId: claim.resourceId,
				})) === true;
		} catch {
			fail(
				"RECONCILIATION_AUTHORIZATION_UNAVAILABLE",
				"operator authorization failed",
			);
		}
		if (!authorized)
			fail(
				"RECONCILIATION_UNAUTHORIZED",
				"operator is not authorized for this resource",
			);
	}
	await requireAuthorization();
	const key = resourceActorKey(claim.deploymentId, claim.resourceId);
	const lease = deps.actorHost.acquire(key, {
		holderId: `resource-recovery:${key}`,
	});
	const stream = `deployment:${claim.deploymentId}`;
	try {
		const events = await collectStream(deps.store, stream);
		const replay = recoveryRecord(events, claim, digest);
		if (replay !== undefined) return { status: "replay", eventId: replay.id };
		const failures = new Map<
			string,
			{ failure: EventEnvelope; provisioning: EventEnvelope | undefined }
		>();
		let provisioning: EventEnvelope | undefined;
		for (const event of events) {
			if (
				!isJsonObject(event.data) ||
				event.data.resourceId !== claim.resourceId
			)
				continue;
			if (
				event.tenant !== claim.tenant ||
				event.data.deploymentId !== claim.deploymentId
			)
				fail(
					"RECONCILIATION_SCOPE_MISMATCH",
					"resource history belongs to another scope",
				);
			if (event.type === CLOUD_EVENTS.ResourceProvisioning)
				provisioning = event;
			if (
				event.type === CLOUD_EVENTS.ResourceFailed &&
				event.data.requiresReconciliation === true
			)
				failures.set(event.id, {
					failure: event,
					provisioning,
				});
			if (
				event.type === CLOUD_EVENTS.ResourceProvisioned ||
				event.type === CLOUD_EVENTS.ResourceDestroyed
			) {
				provisioning = undefined;
			}
			if (event.type === CLOUD_EVENTS.ResourceDestroying)
				provisioning = undefined;
			if (
				event.type === CLOUD_EVENTS.ResourceReconciled &&
				isJsonString(event.data.outcome) &&
				["applied", "destroyed", "no-effect"].includes(event.data.outcome) &&
				isJsonString(event.data.failureEventId)
			) {
				failures.delete(event.data.failureEventId);
				if (event.data.outcome !== "no-effect") provisioning = undefined;
			}
		}
		const unresolved = failures.get(claim.failureEventId);
		const failure = unresolved?.failure;
		provisioning = unresolved?.provisioning;
		const baseline = baselineBeforeFailure(events, claim);
		if (
			failure === undefined ||
			!isJsonObject(failure.data) ||
			failure.data.reconciliationOperation !== claim.operation
		)
			fail(
				"RECONCILIATION_STALE",
				"the named failure is not the current unresolved operation",
			);
		if (failures.size > 1 && claim.outcome.kind !== "no-effect")
			fail(
				"RECONCILIATION_MULTIPLE_UNRESOLVED",
				"other uncertain effects must be resolved before recording a terminal outcome",
			);
		if (claim.outcome.kind === "no-effect") {
			if (baseline.state === "unknown" && claim.outcome.baseline !== "absent")
				fail(
					"RECONCILIATION_BASELINE_UNKNOWN",
					"the prior resource state is unknown; independently verify absence before retry",
				);
			if (
				baseline.state === "provisioned" &&
				claim.outcome.baseline === "absent"
			)
				fail(
					"RECONCILIATION_BASELINE_CONFLICT",
					"an existing resource cannot be treated as absent",
				);
		}
		const originalReservation = failure.data.reservationId;
		if (
			originalReservation !== undefined &&
			(!isJsonString(originalReservation) ||
				originalReservation !== claim.financial.reservationId)
		)
			fail(
				"RECONCILIATION_SCOPE_MISMATCH",
				"financial evidence does not cover the original reservation",
			);
		let execId: string | undefined;
		let specHash: string | undefined;
		if (claim.outcome.kind === "applied") {
			const data = provisioning?.data;
			if (
				!isJsonObject(data) ||
				!isJsonString(data.execId) ||
				!name(data.execId) ||
				!isJsonString(data.specHash) ||
				!/^sha256:[a-f0-9]{64}$/u.test(data.specHash)
			)
				fail(
					"RECONCILIATION_PROVENANCE_MISSING",
					"the original apply and its desired spec must be recorded",
				);
			execId = data.execId;
			specHash = data.specHash;
		}
		const verification: ResourceReconciliationVerification =
			provisioning === undefined
				? { claim, actor: structuredClone(actor), failure, baseline }
				: {
						claim,
						actor: structuredClone(actor),
						failure,
						provisioning,
						baseline,
					};
		let verified: boolean;
		try {
			verified =
				(await deps.verifyOutcome(structuredClone(verification))) === true &&
				(await deps.verifyFinancial(structuredClone(verification))) === true;
		} catch {
			fail(
				"RECONCILIATION_VERIFIER_UNAVAILABLE",
				"recovery verification failed",
			);
		}
		if (!verified)
			fail(
				"RECONCILIATION_UNVERIFIED",
				"outcome and financial disposition must both be verified",
			);
		await requireAuthorization();
		if (
			claim.outcome.kind === "applied" &&
			(execId === undefined || specHash === undefined)
		)
			fail("RECONCILIATION_PROVENANCE_MISSING", "missing apply provenance");
		const recordedData: ResourceReconciledData = {
			deploymentId: claim.deploymentId,
			resourceId: claim.resourceId,
			failureEventId: claim.failureEventId,
			operation: claim.operation,
			outcome: claim.outcome.kind,
			evidenceRef: claim.evidenceRef,
			financialEvidenceRef: claim.financial.evidenceRef,
			financialDisposition: claim.financial.disposition,
			claimDigest: digest,
		};
		if (claim.financial.reservationId !== undefined)
			recordedData.reservationId = claim.financial.reservationId;
		if (
			claim.outcome.kind === "applied" &&
			execId !== undefined &&
			specHash !== undefined
		) {
			recordedData.outputs = { ...claim.outcome.outputs };
			recordedData.execId = execId;
			recordedData.specHash = specHash;
		} else if (claim.outcome.kind === "destroyed")
			recordedData.finalStateHash = claim.outcome.finalStateHash;
		else if (claim.outcome.kind === "no-effect")
			recordedData.restoredState = restoredState(claim, baseline);
		const recorded = resourceReconciled(recordedData);
		const fenceToken = currentFenceToken(deps.store, stream);
		try {
			const expectedSeq = events.at(-1)?.seq ?? 0;
			const options: AppendOptions = {
				expectedSeq,
				actor,
				tenant: claim.tenant,
			};
			if (fenceToken !== undefined) options.fenceToken = fenceToken;
			const saved = await emit(deps.store, stream, [recorded], options);
			const event = saved.appended[0];
			if (
				event === undefined ||
				saved.appended.length !== 1 ||
				event.seq !== expectedSeq + 1 ||
				event.streamId !== stream
			)
				fail(
					"RECONCILIATION_OUTCOME_UNKNOWN",
					"append did not return the expected recovery fact",
				);
			const after = await collectStream(deps.store, stream);
			const committed = recoveryRecord(after, claim, digest);
			if (
				committed === undefined ||
				committed.id !== event.id ||
				committed.seq !== event.seq
			)
				fail(
					"RECONCILIATION_OUTCOME_UNKNOWN",
					"the recovery fact could not be confirmed",
				);
			return { status: "resolved", eventId: committed.id };
		} catch {
			let after: EventEnvelope[];
			try {
				after = await collectStream(deps.store, stream);
			} catch {
				fail(
					"RECONCILIATION_OUTCOME_UNKNOWN",
					"the recovery append must be checked before retry",
				);
			}
			const committed = recoveryRecord(after, claim, digest);
			if (committed !== undefined)
				return { status: "replay", eventId: committed.id };
			fail(
				"RECONCILIATION_OUTCOME_UNKNOWN",
				"the recovery append was not acknowledged; re-read before retry",
			);
		}
	} finally {
		lease.release();
	}
}
