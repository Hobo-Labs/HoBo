/**
 * The claim coordinator reducer.
 *
 * Pure and restart-safe: every effect (provider call, rotation, destruction)
 * happens outside this module and comes back in as a command. The invariants
 * that matter live here so a provider package cannot weaken them:
 *
 *  - a provider callback reporting success never completes a claim;
 *  - an item completes only after independent verification AND every mandatory
 *    post-claim rotation/revocation;
 *  - a bundle completes only when all items complete;
 *  - partial claim is an explicit repairable state, never flattened;
 *  - a stale fence cannot mutate anything;
 *  - the human can own the infrastructure while the agent stays revoked.
 */
import {
	assertNoSecrets,
	type ClaimCommand,
	type ClaimEvent,
	claimAtomicityOf,
	outstandingObligations,
} from "./events.js";
import {
	type ClaimBundle,
	type ClaimBundleStatus,
	ClaimError,
	type ClaimItem,
	type ClaimItemStatus,
	type GuestDeploymentState,
	type GuestLease,
	type Instant,
} from "./types.js";

export type ClaimCoordinatorState = {
	readonly deploymentRef: string;
	readonly lifecycle: GuestDeploymentState;
	readonly offerId?: string;
	readonly offerDigest?: string;
	readonly acceptedAt?: Instant;
	readonly lease?: GuestLease;
	readonly bundle?: ClaimBundle;
	readonly fencingToken: string;
	/** Idempotency keys already applied, so a retry cannot double-provision. */
	readonly appliedIdempotencyKeys: readonly string[];
	readonly provisionedSubjects: readonly string[];
	/** True once the human owns the infrastructure, regardless of agent state. */
	readonly agentAuthorized: boolean;
};

export type ReduceResult = {
	readonly state: ClaimCoordinatorState;
	readonly events: readonly ClaimEvent[];
};

export function initialState(
	deploymentRef: string,
	fencingToken: string,
): ClaimCoordinatorState {
	return {
		deploymentRef,
		lifecycle: "Offered",
		fencingToken,
		appliedIdempotencyKeys: [],
		provisionedSubjects: [],
		agentAuthorized: false,
	};
}

function replaceItem(
	bundle: ClaimBundle,
	itemId: string,
	update: (item: ClaimItem) => ClaimItem,
): ClaimBundle {
	let found = false;
	const items = bundle.items.map((item) => {
		if (item.id !== itemId) return item;
		found = true;
		return update(item);
	});
	if (!found) {
		throw new ClaimError(
			"CLAIM_REPAIR_REQUIRED",
			`unknown claim item ${itemId}`,
		);
	}
	return { ...bundle, items };
}

/** Earliest deadline is derived, never stored independently. */
function deriveEarliestDeadline(
	items: readonly ClaimItem[],
): Instant | undefined {
	const deadlines: Instant[] = [];
	for (const item of items) {
		if (item.status === "completed" || item.deadline === undefined) {
			continue;
		}
		deadlines.push(item.deadline);
	}
	return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

function deriveBundleStatus(bundle: ClaimBundle): ClaimBundleStatus {
	const statuses = bundle.items.map((item) => item.status);
	if (statuses.every((status) => status === "completed")) return "complete";
	if (statuses.some((status) => status === "compensating"))
		return "compensating";
	if (statuses.some((status) => status === "failed")) return "failed";
	if (statuses.some((status) => status === "repairable-failure")) {
		return "claimed-needs-remediation";
	}
	if (statuses.some((status) => status === "expired")) {
		// Some subjects claimed, some lost: explicit, and repairable.
		return statuses.some((status) => status === "completed")
			? "partially-claimed"
			: "expired";
	}
	if (statuses.some((status) => status === "completed"))
		return "partially-claimed";
	if (statuses.some((status) => status !== "pending")) return "in-progress";
	return "pending";
}

function deriveLifecycle(
	previous: GuestDeploymentState,
	bundle: ClaimBundle | undefined,
	agentAuthorized: boolean,
): GuestDeploymentState {
	if (bundle === undefined) return previous;
	if (
		previous === "Expired" ||
		previous === "Destroyed" ||
		previous === "Compensating"
	) {
		return previous;
	}
	const status = bundle.status;
	if (status === "complete") {
		return agentAuthorized ? "OwnerAndAgentControlled" : "OwnerControlled";
	}
	if (
		status === "claimed-needs-remediation" ||
		status === "partially-claimed"
	) {
		return "RepairableFailure";
	}
	if (status === "compensating") return "Compensating";
	if (status === "expired") return "Expired";
	if (status === "in-progress") {
		const anyVerified = bundle.items.some(
			(item) => item.status === "verified" || item.status === "needs-rotation",
		);
		if (anyVerified) {
			return bundle.items.some((item) => item.status === "needs-rotation")
				? "ClaimedNeedsRotation"
				: "ClaimedNeedsVerification";
		}
		return "ClaimPending";
	}
	return previous;
}

function refreshBundle(
	state: ClaimCoordinatorState,
	bundle: ClaimBundle,
): ClaimCoordinatorState {
	const withDeadline: ClaimBundle = {
		...bundle,
		atomicity: claimAtomicityOf(bundle.items),
		status: deriveBundleStatus(bundle),
	};
	const earliest = deriveEarliestDeadline(withDeadline.items);
	const finalBundle: ClaimBundle =
		earliest === undefined
			? (() => {
					const { earliestDeadline: _dropped, ...rest } = withDeadline;
					// SAFETY: `return rest as ClaimBundle;` is required at this I/O or test boundary.
					return rest as ClaimBundle;
				})()
			: { ...withDeadline, earliestDeadline: earliest };
	return {
		...state,
		bundle: finalBundle,
		lifecycle: deriveLifecycle(
			state.lifecycle,
			finalBundle,
			state.agentAuthorized,
		),
	};
}

function emit(events: ClaimEvent[], event: ClaimEvent): void {
	assertNoSecrets(event);
	events.push(event);
}

export type ReduceOptions = {
	/** The fence the caller believes it holds. A stale worker is rejected. */
	readonly fencingToken: string;
};

/**
 * Apply one command. Unknown-but-harmless repeats are no-ops rather than
 * errors, which is what makes at-least-once delivery safe here.
 */
export function reduce(
	state: ClaimCoordinatorState,
	command: ClaimCommand,
	options: ReduceOptions,
): ReduceResult {
	if (options.fencingToken !== state.fencingToken) {
		throw new ClaimError(
			"STALE_FENCE",
			"fencing token does not match the active lease holder; refusing to mutate",
		);
	}

	const events: ClaimEvent[] = [];
	let next = state;

	switch (command.kind) {
		case "CompileDeploymentOffer": {
			next = { ...state, offerId: command.offerId, lifecycle: "Offered" };
			emit(events, {
				type: "DeploymentOfferCompiled",
				offerId: command.offerId,
				offerDigest: "",
			});
			break;
		}
		case "AcceptDeploymentOffer": {
			if (state.lifecycle !== "Offered") {
				// Accepting twice must not restart provisioning.
				break;
			}
			next = {
				...state,
				lifecycle: "Accepted",
				offerDigest: command.offerDigest,
				acceptedAt: command.acceptedAt,
			};
			emit(events, {
				type: "DeploymentOfferAccepted",
				offerId: command.offerId,
				offerDigest: command.offerDigest,
				at: command.acceptedAt,
			});
			break;
		}
		case "ReserveGuestLease": {
			next = { ...state, lease: command.lease };
			emit(events, {
				type: "GuestLeaseReserved",
				leaseId: command.lease.id,
				...(command.lease.expiresAt !== undefined
					? { expiresAt: command.lease.expiresAt }
					: undefined),
				...(command.lease.claimBy !== undefined
					? { claimBy: command.lease.claimBy }
					: undefined),
			});
			break;
		}
		case "StartGuestDeployment": {
			if (state.appliedIdempotencyKeys.includes(command.idempotencyKey)) break;
			if (state.lifecycle !== "Accepted") {
				throw new ClaimError(
					"PROVISIONING_CONFLICT",
					`cannot start a guest deployment from lifecycle ${state.lifecycle}; the offer must be accepted first`,
				);
			}
			next = {
				...state,
				lifecycle: "Provisioning",
				appliedIdempotencyKeys: [
					...state.appliedIdempotencyKeys,
					command.idempotencyKey,
				],
			};
			emit(events, {
				type: "GuestDeploymentStarted",
				deploymentRef: command.deploymentRef,
			});
			break;
		}
		case "RecordProvisionedSubject": {
			if (state.appliedIdempotencyKeys.includes(command.idempotencyKey)) break;
			next = {
				...state,
				lifecycle: "UnclaimedActive",
				appliedIdempotencyKeys: [
					...state.appliedIdempotencyKeys,
					command.idempotencyKey,
				],
				provisionedSubjects: [...state.provisionedSubjects, command.subjectRef],
			};
			emit(events, {
				type: "ProviderSubjectProvisioned",
				subjectRef: command.subjectRef,
				subjectKind: command.subjectKind,
				providerId: command.providerId,
			});
			break;
		}
		case "AttachClaimBundle": {
			if (state.bundle !== undefined) break;
			next = attachBundle(state, command.bundle);
			break;
		}
		case "RecordClaimAction": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) => ({
				...item,
				oneTimeActionRef: command.oneTimeActionRef,
				...(command.deadline !== undefined
					? { deadline: command.deadline }
					: undefined),
			}));
			next = refreshBundle(state, updated);
			emit(events, {
				type: "ClaimActionSecured",
				itemId: command.itemId,
				oneTimeActionRef: command.oneTimeActionRef,
				...(command.deadline !== undefined
					? { deadline: command.deadline }
					: undefined),
			});
			break;
		}
		case "BeginClaimBundle": {
			const bundle = requireBundle(state);
			next = refreshBundle(state, bundle);
			emit(events, { type: "ClaimBundleStarted", bundleId: command.bundleId });
			break;
		}
		case "BeginClaimItem": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) =>
				item.status === "pending" ? { ...item, status: "in-progress" } : item,
			);
			next = refreshBundle(state, updated);
			emit(events, { type: "ClaimItemStarted", itemId: command.itemId });
			break;
		}
		case "ObserveClaimItem": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) => {
				if (item.status === "completed") return item;
				if (command.observedStatus === "expired") {
					return { ...item, status: "expired" satisfies ClaimItemStatus };
				}
				// Observing "claimed" advances to observed — NOT to verified. A
				// provider saying yes is a claim, not proof.
				if (command.observedStatus === "claimed") {
					return { ...item, status: "observed" satisfies ClaimItemStatus };
				}
				return item;
			});
			next = refreshBundle(state, updated);
			emit(events, {
				type: "ClaimStatusObserved",
				itemId: command.itemId,
				observedStatus: command.observedStatus,
			});
			break;
		}
		case "VerifyOwnership": {
			const bundle = requireBundle(state);
			if (!command.verified) {
				const updated = replaceItem(bundle, command.itemId, (item) => ({
					...item,
					status: "repairable-failure" satisfies ClaimItemStatus,
					failureCode: "CLAIM_NOT_VERIFIED",
				}));
				next = refreshBundle(state, updated);
				emit(events, {
					type: "ClaimRepairRequested",
					itemId: command.itemId,
					failureCode: "CLAIM_NOT_VERIFIED",
				});
				break;
			}
			const updated = replaceItem(bundle, command.itemId, (item) => {
				const pending = outstandingObligations(item);
				return {
					...item,
					creatorAuthorityAfterClaim: command.creatorAuthorityAfterClaim,
					evidenceRef: command.evidenceRef,
					status: (pending.length > 0
						? "needs-rotation"
						: "verified") satisfies ClaimItemStatus,
				};
			});
			next = refreshBundle(state, updated);
			emit(events, {
				type: "OwnershipVerified",
				itemId: command.itemId,
				evidenceRef: command.evidenceRef,
			});
			const item = updated.items.find((entry) => entry.id === command.itemId);
			if (
				item !== undefined &&
				outstandingObligations(item).includes("rotate-binding")
			) {
				emit(events, {
					type: "CapabilityBindingRotationRequired",
					itemId: command.itemId,
				});
			}
			break;
		}
		case "RotateCapabilityBinding": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) =>
				markObligationDone(item, "rotate-binding"),
			);
			next = refreshBundle(state, updated);
			emit(events, {
				type: "CapabilityBindingRotated",
				itemId: command.itemId,
				bindingId: command.bindingId,
			});
			break;
		}
		case "RevokeBootstrapAuthority": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) => ({
				...markObligationDone(item, "revoke-bootstrap-authority"),
				creatorAuthorityAfterClaim: "absent",
			}));
			next = refreshBundle(state, updated);
			emit(events, {
				type: "BootstrapAuthorityRevoked",
				itemId: command.itemId,
				evidenceRef: command.evidenceRef,
			});
			break;
		}
		case "AuthorizePostClaimAgent": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) =>
				command.granted ? markObligationDone(item, "reauthorize-agent") : item,
			);
			// Declining is a valid terminal outcome: the human owns the work and
			// the agent stays revoked.
			next = {
				...refreshBundle(state, updated),
				agentAuthorized: command.granted,
			};
			next = refreshBundle(next, updated);
			emit(events, {
				type: command.granted
					? "PostClaimAgentAuthorized"
					: "PostClaimAgentAuthorizationRequested",
				itemId: command.itemId,
			});
			break;
		}
		case "BeginResourceMigration": {
			const bundle = requireBundle(state);
			next = refreshBundle(state, bundle);
			emit(events, {
				type: "ResourceMigrationStarted",
				itemId: command.itemId,
				migrationProfileRef: command.migrationProfileRef,
			});
			break;
		}
		case "RecordMigrationCheckpoint": {
			emit(events, {
				type: "ResourceMigrationCheckpointRecorded",
				itemId: command.itemId,
				checkpoint: command.checkpoint,
			});
			break;
		}
		case "CommitConnectorCutover": {
			const bundle = requireBundle(state);
			const item = bundle.items.find((entry) => entry.id === command.itemId);
			if (item === undefined) {
				throw new ClaimError(
					"CLAIM_REPAIR_REQUIRED",
					`unknown claim item ${command.itemId}`,
				);
			}
			// Cutover before destination verification would strand the source.
			if (item.status !== "verified" && item.status !== "needs-rotation") {
				throw new ClaimError(
					"MIGRATION_VERIFICATION_FAILED",
					`refusing connector cutover for ${command.itemId}: destination is not verified (status ${item.status})`,
				);
			}
			const updated = replaceItem(bundle, command.itemId, (entry) =>
				markObligationDone(entry, "migrate-data"),
			);
			next = refreshBundle(state, updated);
			emit(events, {
				type: "LogicalConnectorCutoverCommitted",
				itemId: command.itemId,
				connectorRef: command.connectorRef,
			});
			break;
		}
		case "CompleteClaimItem": {
			const bundle = requireBundle(state);
			const item = bundle.items.find((entry) => entry.id === command.itemId);
			if (item === undefined) {
				throw new ClaimError(
					"CLAIM_REPAIR_REQUIRED",
					`unknown claim item ${command.itemId}`,
				);
			}
			if (item.status === "completed") break;
			if (item.status !== "verified" && item.status !== "needs-rotation") {
				throw new ClaimError(
					"CLAIM_NOT_VERIFIED",
					`claim item ${command.itemId} cannot complete from status ${item.status}: ownership must be independently verified first`,
				);
			}
			const pending = outstandingObligations(item);
			if (pending.length > 0) {
				throw new ClaimError(
					pending.includes("rotate-binding")
						? "BINDING_ROTATION_REQUIRED"
						: "BOOTSTRAP_AUTHORITY_REMAINS",
					`claim item ${command.itemId} still owes ${pending.join(", ")}`,
				);
			}
			const updated = replaceItem(bundle, command.itemId, (entry) => ({
				...entry,
				status: "completed" satisfies ClaimItemStatus,
			}));
			next = refreshBundle(state, updated);
			emit(events, {
				type: "ClaimItemCompleted",
				itemId: command.itemId,
				at: command.at,
			});
			break;
		}
		case "CompleteClaimBundle": {
			const bundle = requireBundle(state);
			const refreshed = refreshBundle(state, bundle);
			if (refreshed.bundle?.status !== "complete") {
				throw new ClaimError(
					"CLAIM_PARTIALLY_COMPLETED",
					`claim bundle ${command.bundleId} is ${refreshed.bundle?.status ?? "unknown"}; it cannot be reported complete`,
				);
			}
			next = refreshed;
			emit(events, {
				type: "ClaimBundleCompleted",
				bundleId: command.bundleId,
				at: command.at,
			});
			break;
		}
		case "ExpireGuestLease": {
			if (
				state.lifecycle === "OwnerControlled" ||
				state.lifecycle === "OwnerAndAgentControlled"
			) {
				// Expiring a lease must not disturb work the human already owns.
				break;
			}
			const lease = state.lease;
			next = {
				...state,
				lifecycle: "Expired",
				...(lease !== undefined
					? { lease: { ...lease, status: "expired" as const } }
					: undefined),
			};
			emit(events, {
				type: "GuestLeaseExpired",
				leaseId: command.leaseId,
				at: command.at,
			});
			break;
		}
		case "CompensateFailedClaim": {
			next = { ...state, lifecycle: "Compensating" };
			emit(events, {
				type: "ClaimCompensationStarted",
				bundleId: command.bundleId,
				reason: command.reason,
			});
			break;
		}
		case "DestroyGuestDeployment": {
			next = { ...state, lifecycle: "Destroyed" };
			emit(events, {
				type: "GuestDeploymentDestroyed",
				deploymentRef: command.deploymentRef,
			});
			break;
		}
		case "RetryRepairableClaim": {
			const bundle = requireBundle(state);
			const updated = replaceItem(bundle, command.itemId, (item) => {
				if (item.status !== "repairable-failure") return item;
				const { failureCode: _dropped, ...rest } = item;
				return { ...rest, status: "in-progress" satisfies ClaimItemStatus };
			});
			next = refreshBundle(state, updated);
			emit(events, { type: "ClaimItemStarted", itemId: command.itemId });
			break;
		}
	}

	return { state: next, events };
}

function requireBundle(state: ClaimCoordinatorState): ClaimBundle {
	if (state.bundle === undefined) {
		throw new ClaimError(
			"CLAIM_REPAIR_REQUIRED",
			"no claim bundle is attached to this deployment",
		);
	}
	return state.bundle;
}

function markObligationDone(
	item: ClaimItem,
	action: ClaimItem["postClaimActions"][number],
): ClaimItem {
	if (!item.postClaimActions.includes(action)) return item;
	if (item.completedPostClaimActions.includes(action)) return item;
	const completed = [...item.completedPostClaimActions, action];
	const stillPending = item.postClaimActions.filter(
		(entry) => !completed.includes(entry),
	);
	return {
		...item,
		completedPostClaimActions: completed,
		status: (stillPending.length === 0 && item.status === "needs-rotation"
			? "verified"
			: item.status) satisfies ClaimItemStatus,
	};
}

export function attachBundle(
	state: ClaimCoordinatorState,
	bundle: ClaimBundle,
): ClaimCoordinatorState {
	return refreshBundle(state, bundle);
}
