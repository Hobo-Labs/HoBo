import {
	clone,
	create,
	type "MessageInitShape" as MessageInitializer,
	toJson,
} from "@bufbuild/protobuf";
import {
	applyResilienceProfile,
	type EffectSpec,
	type ResilienceProfile,
} from "@hobo/contracts";
import type {
	DurableEffectInput,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	PrincipalRef,
	ResourceMutationJournal,
} from "@hobo/core";
import {
	HostingTransitionAction as Action,
	HostingDestinationLiabilitySchema,
	HostingTransitionEventSchema,
	type HostingTransitionObservation,
	HostingTransitionObservationSchema,
	type HostingTransitionOperation,
	HostingTransitionOperationSchema,
	type HostingTransitionPlan,
	HostingTransitionPlanSchema,
	type HostingTransitionState,
	HostingTransitionStateSchema,
	HostingTransitionPhase as Phase,
} from "../_generated/hosting_transition_pb.js";
import type { HostingPlanCommitment } from "../planner/hosting-budget.js";
import type { SharedHostingBudgetAuthority } from "./budget-authority.js";
import {
	hostingEffectFacts,
	hostingTransitionContracts,
	validateHostingAdapterContract,
} from "./contracts.js";
import {
	createHostingTransitionPlan,
	foldHostingTransition,
	type HostingTransitionPlanInput,
	hostingDigest,
	hostingInteger,
	hostingName,
	hostingTransitionStream,
	initialHostingTransition,
} from "./model.js";

export interface HostingOperationRequest {
	readonly plan: HostingTransitionPlan;
	readonly operation: HostingTransitionOperation;
	readonly reservationId: string;
	readonly fenceToken: bigint;
	readonly signal: AbortSignal;
}

/** Mutation acknowledgement is deliberately void: advancement requires independent observation. */
export interface HostingTransitionProvider {
	readonly contractId: string;
	/** Adapter conformance must prove stale/duplicate commands cannot repeat external effects. */
	readonly executionGuarantee: "fenced-operation" | "idempotent-operation";
	readonly effects: EffectSpec;
	readonly resilience: ResilienceProfile;
	/** The same durable journal used by this adapter to guard non-idempotent
	 * substeps. Required for explicitly approved mutation resumption. */
	readonly mutationJournal?: ResourceMutationJournal;
	/** Production adapters require native liability proof for every destination.
	 * Local protocol fixtures may omit this capability. */
	readonly requiresDestinationLiabilityProof?: boolean;
	/** Computed from the production adapter's immutable source inventory. */
	readonly requiresSourceLiabilityProof?: boolean;
	/** Pure lookup in the adapter's immutable artifact catalog. The catalog and
	 * policy participate in contractId; this lookup performs no I/O. */
	readonly requiresSourceLiabilityProofFor?: (
		plan: HostingTransitionPlan,
	) => boolean;
	execute(request: HostingOperationRequest): Promise<void>;
	observe(
		request: HostingOperationRequest,
	): Promise<MessageInitializer<typeof HostingTransitionObservationSchema>>;
}

export interface HostingTransitionCoordinatorOptions {
	readonly store: DurableEventStore;
	readonly budget: SharedHostingBudgetAuthority;
	readonly provider: HostingTransitionProvider;
	readonly context: {
		readonly tenantId: string;
		readonly actor: PrincipalRef;
		readonly fenceToken: bigint;
	};
	readonly nowMs: () => number;
	/** Authoritative policy/quote/period/source-revision check before each external mutation. */
	readonly authorize: (
		request: Omit<HostingOperationRequest, "signal"> & {
			reason: "optimization" | "restore" | "retirement";
		},
	) => Promise<{ allowed: boolean; reason?: string }>;
}

type Loaded = { state: HostingTransitionState; seq: number };

export function hostingAdapterContractDigest(
	provider: Pick<
		HostingTransitionProvider,
		| "contractId"
		| "effects"
		| "resilience"
		| "executionGuarantee"
		| "mutationJournal"
		| "requiresDestinationLiabilityProof"
		| "requiresSourceLiabilityProof"
		| "requiresSourceLiabilityProofFor"
	>,
): string {
	return hostingDigest({
		contractId: provider.contractId,
		effects: provider.effects,
		resilience: provider.resilience,
		executionGuarantee: provider.executionGuarantee,
		mutationJournalPersistence: provider.mutationJournal?.persistence ?? "",
		requiresDestinationLiabilityProof:
			provider.requiresDestinationLiabilityProof === true,
		requiresSourceLiabilityProof:
			provider.requiresSourceLiabilityProof === true,
		requiresSourceLiabilityProofFor:
			provider.requiresSourceLiabilityProofFor !== undefined,
	});
}
function planOf(state: HostingTransitionState): HostingTransitionPlan {
	if (!state.plan?.commitment || !state.plan.constraints)
		throw new Error("incomplete hosting transition state");
	return state.plan;
}
function operationOf(
	state: HostingTransitionState,
): HostingTransitionOperation {
	if (!state.operation)
		throw new Error("hosting transition has no pending operation");
	return state.operation;
}
function commitmentOf(state: HostingTransitionState): HostingPlanCommitment {
	const commitment = planOf(state).commitment;
	if (!commitment?.evidence?.budget)
		throw new Error("hosting transition lacks pinned financial evidence");
	return {
		...commitment,
		evidence: { ...commitment.evidence, budget: commitment.evidence.budget },
	};
}
function readAction(action: Action): boolean {
	return action === Action.VERIFY || action === Action.SETTLE;
}
function phaseFor(action: Action): Phase {
	switch (action) {
		case Action.PREPARE:
			return Phase.PREPARING;
		case Action.SHIFT:
			return Phase.SHIFTING;
		case Action.VERIFY:
			return Phase.VERIFYING;
		case Action.RESTORE:
			return Phase.RESTORING;
		case Action.RETIRE:
			return Phase.RETIRING;
		case Action.SETTLE:
			return Phase.SETTLING;
		default:
			throw new Error("invalid hosting action");
	}
}

/** No effects occur while loading/replaying. Methods are explicit command/effect boundaries. */
export function createHostingTransitionCoordinator(
	options: HostingTransitionCoordinatorOptions,
) {
	if (options.budget.persistence !== "durable-cas")
		throw new Error(
			"hard hosting budgets require durable shared financial authority",
		);
	if (!options.store.commit || options.context.fenceToken < 1n)
		throw new Error("durable commits and positive writer fence are required");
	validateHostingAdapterContract(
		options.provider.effects,
		options.provider.resilience,
	);
	if (
		!["fenced-operation", "idempotent-operation"].includes(
			options.provider.executionGuarantee,
		)
	)
		throw new Error(
			"hosting adapter requires proven operation fencing or idempotency",
		);
	const tenantId = hostingName(options.context.tenantId, "tenant");
	const now = () => hostingInteger(options.nowMs(), "clock");
	const identity = (state: HostingTransitionState) => ({
		reservationId: state.reservationId,
		tenantId,
		commitmentHash: commitmentOf(state).commitmentHash,
	});

	async function read(transitionId: string): Promise<Loaded | undefined> {
		const events: EventEnvelope[] = [];
		for await (const event of options.store.read(
			hostingTransitionStream(tenantId, transitionId),
		))
			events.push(event);
		const state = foldHostingTransition(events);
		if (!state) return undefined;
		if (planOf(state).tenantId !== tenantId)
			throw new Error("foreign tenant transition history");
		return { state, seq: events.at(-1)?.seq ?? 0 };
	}
	async function required(transitionId: string): Promise<Loaded> {
		const loaded = await read(transitionId);
		if (!loaded) throw new Error("unknown hosting transition");
		return loaded;
	}
	async function write(
		loaded: Loaded,
		state: HostingTransitionState,
		kind: string,
		effects: DurableEffectInput[] = [],
		facts: EventInput[] = [],
	): Promise<Loaded> {
		const plan = planOf(state);
		state.version = loaded.state.version + 1;
		const eventId = `${plan.transitionId}:${state.version}:${kind}`;
		const data = toJson(
			HostingTransitionEventSchema,
			create(HostingTransitionEventSchema, {
				eventId,
				kind,
				state,
				recordedAtMs: now(),
			}),
			{ enumAsInteger: true },
		);
		const result = await options.store.commit({
			streamId: hostingTransitionStream(tenantId, plan.transitionId),
			events: [
				{ type: kind, data, meta: { idempotencyKey: eventId } },
				...facts,
			],
			append: {
				expectedSeq: loaded.seq,
				tenant: tenantId,
				actor: options.context.actor,
				fenceToken: options.context.fenceToken,
			},
			effects,
		});
		return { state, seq: result.appended.at(-1)?.seq ?? loaded.seq };
	}
	function copy(state: HostingTransitionState) {
		return clone(HostingTransitionStateSchema, state);
	}
	function operationMessage(
		state: HostingTransitionState,
		destination: string,
	): DurableEffectInput {
		const plan = planOf(state);
		return {
			kind: "outbox",
			destination,
			idempotencyKey: `${destination}:${operationOf(state).operationId}`,
			payload: {
				tenantId,
				transitionId: plan.transitionId,
				operationId: operationOf(state).operationId,
			},
		};
	}
	function timer(
		state: HostingTransitionState,
		dueAtMs: number,
	): DurableEffectInput {
		const operation = operationOf(state);
		return {
			kind: "timer",
			timerKind: "reminder",
			subjectId: hostingTransitionStream(tenantId, planOf(state).transitionId),
			idempotencyKey: `hosting:${operation.operationId}:${operation.observationAttempts}:${dueAtMs}`,
			dueAt: new Date(dueAtMs).toISOString(),
			payload: {
				tenantId,
				transitionId: planOf(state).transitionId,
				operationId: operation.operationId,
			},
		};
	}
	async function schedule(loaded: Loaded, action: Action): Promise<Loaded> {
		const state = copy(loaded.state);
		const plan = planOf(state);
		state.operationSequence += 1;
		const operationId = `${plan.transitionId}:${state.operationSequence}:${Action[action]}`;
		const at = now();
		const deadline = hostingInteger(
			at + plan.operationTimeoutMs,
			"operation deadline",
		);
		state.operation = create(HostingTransitionOperationSchema, {
			operationId,
			action,
			operationDigest: hostingDigest({
				planDigest: plan.planDigest,
				operationId,
				action,
			}),
			startedAtMs: at,
			deadlineAtMs: deadline,
			nextObservationAtMs: at,
		});
		state.phase = phaseFor(action);
		state.blockedReason = "";
		return write(loaded, state, "hosting.TransitionScheduled", [
			operationMessage(
				state,
				readAction(action)
					? "hosting.transition.observe"
					: "hosting.transition.dispatch",
			),
			timer(state, deadline),
		]);
	}
	async function block(
		loaded: Loaded,
		reason: string,
	): Promise<HostingTransitionState> {
		const state = copy(loaded.state);
		state.phase = Phase.BLOCKED;
		state.blockedReason = reason;
		return (await write(loaded, state, "hosting.TransitionBlocked")).state;
	}
	async function pending(
		loaded: Loaded,
		reason: string,
		attempted: boolean,
	): Promise<HostingTransitionState> {
		const state = copy(loaded.state);
		const operation = operationOf(state);
		if (attempted) operation.observationAttempts += 1;
		if (
			operation.observationAttempts >= planOf(state).maximumObservationAttempts
		)
			return block(loaded, `observation budget exhausted: ${reason}`);
		state.phase = Phase.RECONCILING;
		state.blockedReason = reason;
		operation.nextObservationAtMs = hostingInteger(
			now() + planOf(state).observationBackoffMs,
			"next observation",
		);
		return (
			await write(loaded, state, "hosting.TransitionUncertain", [
				timer(state, operation.nextObservationAtMs),
			])
		).state;
	}
	async function withDeadline<T>(
		work: (signal: AbortSignal) => Promise<T>,
		timeoutMs: number,
	): Promise<T> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
			throw {
				failureClass: "deadline",
				message: "hosting execution window expired before invocation",
			};
		const abort = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work(abort.signal),
				new Promise<T>((_resolve, reject) => {
					timeout = setTimeout(() => {
						abort.abort();
						reject({
							failureClass: "deadline",
							message:
								"hosting operation deadline expired; outcome must be observed",
						});
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
	async function reserve(
		transitionId: string,
	): Promise<HostingTransitionState> {
		let loaded = await required(transitionId);
		const plan = planOf(loaded.state);
		if (
			loaded.state.phase !== Phase.PROPOSED &&
			loaded.state.phase !== Phase.RESERVING
		)
			return loaded.state;
		const financialPlanHash = plan.financialPlanHash || plan.planDigest;
		const previousGrant = loaded.state.reservationId
			? await options.budget.lookup(identity(loaded.state))
			: undefined;
		const alreadyHeld =
			previousGrant !== undefined &&
			["held", "uncertain"].includes(previousGrant.status) &&
			previousGrant.reservedMicros >=
				commitmentOf(loaded.state).reservedMicros &&
			previousGrant.commitmentHash ===
				commitmentOf(loaded.state).commitmentHash &&
			previousGrant.financialPlanHash === financialPlanHash;
		if (
			(commitmentOf(loaded.state).validUntilMs <= now() ||
				plan.horizonEndMs <= now()) &&
			!(loaded.state.cancelRequested && alreadyHeld)
		)
			return block(loaded, "financial evidence expired before reservation");
		if (loaded.state.phase === Phase.PROPOSED) {
			const state = copy(loaded.state);
			state.phase = Phase.RESERVING;
			state.reservationId =
				plan.existingReservationId ||
				`hosting:${tenantId}:${plan.transitionId}`;
			loaded = await write(loaded, state, "hosting.TransitionReserving", [
				{
					kind: "outbox",
					destination: "hosting.budget.reserve",
					idempotencyKey: state.reservationId,
					payload: { transitionId, tenantId, planDigest: plan.planDigest },
				},
			]);
		}
		// A crash after reserve/claim and before recording reuses both identities.
		if (!plan.existingReservationId && !alreadyHeld) {
			const result = await options.budget.reserve({
				reservationId: loaded.state.reservationId,
				planHash: financialPlanHash,
				commitment: commitmentOf(loaded.state),
			});
			if (!result.ok) return block(loaded, result.reason);
			if (result.reservationId !== loaded.state.reservationId)
				return block(
					loaded,
					"authority returned a different reservation identity",
				);
		}
		const grant = await options.budget.lookup(identity(loaded.state));
		if (
			!["held", "uncertain"].includes(grant.status) ||
			grant.reservedMicros < commitmentOf(loaded.state).reservedMicros ||
			grant.commitmentHash !== commitmentOf(loaded.state).commitmentHash ||
			grant.financialPlanHash !== financialPlanHash
		)
			return block(
				loaded,
				"financial reservation could not be independently confirmed",
			);
		const claim = await options.budget.claimExecution({
			...identity(loaded.state),
			financialPlanHash,
			executionDigest: plan.planDigest,
		});
		if (!claim.ok) return block(loaded, claim.reason);
		// Cancellation or another worker may have advanced the local journal while
		// the shared authority was committing. Re-read before scheduling any effect.
		loaded = await required(transitionId);
		if (loaded.state.phase !== Phase.RESERVING) return loaded.state;
		if (loaded.state.cancelRequested && plan.intent === "decommission")
			return block(
				loaded,
				"decommission was cancelled before retirement; unused financial exposure is retained",
			);
		return (
			await schedule(
				loaded,
				loaded.state.cancelRequested
					? Action.RESTORE
					: plan.intent === "decommission"
						? Action.RETIRE
						: Action.PREPARE,
			)
		).state;
	}
	async function dispatchClaimed(
		transitionId: string,
		resumeCount?: number,
	): Promise<HostingTransitionState> {
		let loaded = await required(transitionId);
		if (
			[Phase.BLOCKED, Phase.SETTLED, Phase.RESTORED].includes(
				loaded.state.phase,
			)
		)
			return loaded.state;
		if ([Phase.PROPOSED, Phase.RESERVING].includes(loaded.state.phase))
			return reserve(transitionId);
		const operation = operationOf(loaded.state);
		const resuming = resumeCount !== undefined;
		if (
			resuming &&
			(operation.mutationResumes !== resumeCount ||
				loaded.state.phase !== Phase.RECONCILING ||
				!operation.mutationDispatched)
		)
			throw new Error(
				"mutation resume claim no longer owns the current operation",
			);
		if (
			!resuming &&
			(readAction(operation.action) ||
				operation.mutationDispatched ||
				loaded.state.phase === Phase.RECONCILING)
		)
			return observe(transitionId);
		const plan = planOf(loaded.state);
		const needsFreshFinancialEvidence =
			resuming ||
			plan.intent === "decommission" ||
			operation.action === Action.PREPARE ||
			operation.action === Action.SHIFT;
		const expired = () =>
			now() >= operation.deadlineAtMs ||
			(needsFreshFinancialEvidence &&
				(now() >= commitmentOf(loaded.state).validUntilMs ||
					now() >= plan.horizonEndMs ||
					operation.deadlineAtMs > plan.horizonEndMs)) ||
			([Action.PREPARE, Action.SHIFT].includes(operation.action) &&
				plan.destinationLiabilities.some(
					(proof) =>
						proof.expiresAtMs !== 0 &&
						operation.deadlineAtMs > proof.expiresAtMs,
				));
		if (expired())
			return block(
				loaded,
				"operation or quote expired before external dispatch",
			);
		if (
			hostingAdapterContractDigest(options.provider) !==
			plan.adapterContractDigest
		)
			return block(loaded, "adapter contract changed after approval");
		const grant = await options.budget.lookup(identity(loaded.state));
		if (
			!["held", "uncertain"].includes(grant.status) ||
			grant.reservedMicros < commitmentOf(loaded.state).reservedMicros ||
			grant.executionDigest !== plan.planDigest ||
			grant.financialPlanHash !== (plan.financialPlanHash || plan.planDigest)
		)
			return block(loaded, "financial reservation no longer covers operation");
		const authorization = await options.authorize({
			plan: clone(HostingTransitionPlanSchema, plan),
			operation: clone(HostingTransitionOperationSchema, operation),
			reservationId: loaded.state.reservationId,
			fenceToken: options.context.fenceToken,
			reason:
				operation.action === Action.RESTORE
					? "restore"
					: operation.action === Action.RETIRE
						? "retirement"
						: "optimization",
		});
		if (!authorization.allowed)
			return block(
				loaded,
				authorization.reason ?? "authoritative policy refused operation",
			);
		if (expired())
			return block(
				loaded,
				"authorization outlived the operation deadline, quote, or funded horizon",
			);
		if (
			hostingAdapterContractDigest(options.provider) !==
			plan.adapterContractDigest
		)
			return block(
				loaded,
				"adapter contract changed while authorization was pending",
			);
		if (resuming) {
			try {
				resumeEvidence(plan, operation, loaded.state);
			} catch {
				return block(
					loaded,
					"pending observation expired while resume authorization was pending",
				);
			}
		}
		const resumeJournal = resuming
			? options.provider.mutationJournal
			: undefined;
		const resumeMutationId = `hosting-resume:${tenantId}:${operation.operationId}:${operation.mutationResumes}`;
		if (resuming) {
			if (
				options.provider.executionGuarantee !== "idempotent-operation" ||
				resumeJournal?.persistence !== "durable-cas"
			)
				return block(
					loaded,
					"mutation resumption requires idempotency and the adapter's durable mutation journal",
				);
			const permission = await resumeJournal.claim({
				mutationId: resumeMutationId,
				requestDigest: operation.operationDigest,
			});
			if (permission.status !== "claimed")
				return pending(
					loaded,
					"mutation resume permission was already used; observe before another explicit command",
					false,
				);
			if (expired())
				return block(
					loaded,
					"mutation resume journal claim outlived the approved execution window",
				);
		}
		const state = copy(loaded.state);
		operationOf(state).mutationDispatched = true;
		const effectFacts = hostingEffectFacts(
			options.provider.contractId,
			"mutate",
			new Date(now()).toISOString(),
		).map((fact) => ({ type: fact.type, data: fact }));
		// CAS before I/O is the single-dispatch claim. Reopening starts with observation.
		loaded = await write(
			loaded,
			state,
			"hosting.TransitionDispatched",
			[timer(state, operation.deadlineAtMs)],
			effectFacts,
		);
		if (expired())
			return block(
				loaded,
				"durable dispatch claim outlived the approved execution window",
			);
		if (
			hostingAdapterContractDigest(options.provider) !==
			plan.adapterContractDigest
		)
			return block(
				loaded,
				"adapter contract changed before provider execution",
			);
		const current = await required(transitionId);
		if (current.seq !== loaded.seq) return current.state;
		if (expired())
			return block(
				loaded,
				"hosting execution window expired before provider invocation",
			);
		if (resuming) {
			try {
				resumeEvidence(plan, operation, loaded.state);
			} catch {
				return block(
					loaded,
					"pending observation expired before resumed provider execution",
				);
			}
		}
		const result = await applyResilienceProfile({
			profile: hostingTransitionContracts.mutate.resilience,
			now: () => new Date(now()).toISOString(),
			op: () =>
				withDeadline(
					(signal) =>
						options.provider.execute({
							plan: clone(HostingTransitionPlanSchema, plan),
							operation: clone(
								HostingTransitionOperationSchema,
								operationOf(loaded.state),
							),
							reservationId: loaded.state.reservationId,
							fenceToken: options.context.fenceToken,
							signal,
						}),
					operation.deadlineAtMs - now(),
				),
		});
		if (result.facts.length) {
			loaded = await write(
				loaded,
				copy(loaded.state),
				"hosting.TransitionResilienceEvaluated",
				[],
				result.facts.map((fact) => ({ type: fact.type, data: fact })),
			);
		}
		if (!result.ok) {
			if (resumeJournal)
				await resumeJournal.uncertain(
					resumeMutationId,
					operation.operationDigest,
				);
			const uncertain = await pending(
				loaded,
				`mutation outcome unconfirmed: ${result.failureClass}`,
				false,
			);
			await options.budget.uncertain({
				...identity(uncertain),
				reason: uncertain.blockedReason,
			});
			return uncertain;
		}
		if (resumeJournal)
			await resumeJournal.acknowledge(
				resumeMutationId,
				operation.operationDigest,
			);
		return loaded.state;
	}
	async function dispatch(transitionId: string) {
		return dispatchClaimed(transitionId);
	}
	function resumeEvidence(
		plan: HostingTransitionPlan,
		operation: HostingTransitionOperation,
		state: HostingTransitionState,
	): void {
		const observation = state.lastObservation;
		if (
			!observation ||
			observation.operationId !== operation.operationId ||
			observation.outcome !== "pending"
		)
			throw new Error(
				"mutation resumption requires an independent pending observation of this operation",
			);
		evidenceFailure(plan, operation, observation, state);
	}
	async function resumeMutation(
		transitionId: string,
	): Promise<HostingTransitionState> {
		const loaded = await required(transitionId);
		const plan = planOf(loaded.state),
			operation = operationOf(loaded.state);
		const journal = options.provider.mutationJournal;
		if (
			options.provider.executionGuarantee !== "idempotent-operation" ||
			journal?.persistence !== "durable-cas"
		)
			throw new Error(
				"mutation resumption requires proven idempotency and a durable mutation journal",
			);
		if (
			loaded.state.phase !== Phase.RECONCILING ||
			!operation.mutationDispatched ||
			readAction(operation.action) ||
			loaded.state.cancelRequested
		)
			throw new Error(
				"only an active, non-cancelled uncertain mutation can be explicitly resumed",
			);
		if (
			!plan.maximumMutationResumes ||
			operation.mutationResumes >= plan.maximumMutationResumes
		)
			throw new Error("approved mutation resume budget exhausted");
		resumeEvidence(plan, operation, loaded.state);
		const at = now();
		const deadline = Math.min(
			hostingInteger(at + plan.operationTimeoutMs, "resume deadline"),
			plan.horizonEndMs,
			commitmentOf(loaded.state).validUntilMs,
		);
		if (deadline <= at)
			throw new Error(
				"fresh financial quote and funded horizon are required before resuming",
			);
		const resumed = copy(loaded.state);
		operationOf(resumed).mutationResumes += 1;
		operationOf(resumed).deadlineAtMs = deadline;
		const claimed = await write(
			loaded,
			resumed,
			"hosting.TransitionMutationResumeRequested",
			[timer(resumed, deadline)],
		);
		return dispatchClaimed(
			transitionId,
			operationOf(claimed.state).mutationResumes,
		);
	}
	function evidenceFailure(
		plan: HostingTransitionPlan,
		operation: HostingTransitionOperation,
		observation: HostingTransitionObservation,
		state: HostingTransitionState,
	): string | undefined {
		const constraints = plan.constraints;
		if (!constraints) return "missing approved constraints";
		for (const field of [
			"observedAtMs",
			"healthyBackends",
			"latencyMs",
			"sourceQuiescentSequence",
			"destinationAppliedSequence",
			"settledMicros",
			"writeOwnershipEpoch",
		] as const)
			hostingInteger(observation[field], field);
		if (
			observation.tenantId !== tenantId ||
			observation.transitionId !== plan.transitionId ||
			observation.operationId !== operation.operationId ||
			observation.operationDigest !== operation.operationDigest
		)
			throw new Error("foreign or wrong-operation hosting evidence");
		if (
			observation.sourcePlanId !== plan.sourcePlanId ||
			observation.targetPlanId !== plan.targetPlanId
		)
			throw new Error(
				"provider evidence refers to a different source or destination",
			);
		if (
			!observation.evidenceRef ||
			observation.observedAtMs < operation.startedAtMs ||
			observation.observedAtMs > now() ||
			now() - observation.observedAtMs > constraints.observationMaxAgeMs ||
			(state.lastObservation &&
				observation.observedAtMs < state.lastObservation.observedAtMs)
		)
			throw new Error("stale, future, or unreferenced hosting evidence");
		if (
			!["applied", "absent", "pending", "failed"].includes(observation.outcome)
		)
			throw new Error("unknown hosting observation outcome");
		if (observation.outcome !== "applied") return undefined;
		const retiringWithoutDestination =
			plan.intent === "decommission" &&
			[Action.RETIRE, Action.SETTLE].includes(operation.action);
		if (retiringWithoutDestination) {
			if (operation.action === Action.RETIRE && !observation.sourceRetired)
				return "source retirement is unconfirmed";
			if (
				operation.action === Action.SETTLE &&
				!state.sourceRetirementConfirmed
			)
				return "source retirement must be confirmed before final settlement";
			// An absent source has no live latency, jurisdiction or serving capability.
			// Approval binds the source inventory before mutation; absence proof binds
			// the exact source/operation above and must not invent serving metadata.
			return undefined;
		}
		if (
			plan.destinationLiabilities.length &&
			operation.action !== Action.RESTORE &&
			!state.compensationCleanupConfirmed
		) {
			const canonical = (proofs: typeof plan.destinationLiabilities) =>
				hostingDigest(
					[...proofs]
						.sort((a, b) =>
							a.resourceName < b.resourceName
								? -1
								: a.resourceName > b.resourceName
									? 1
									: 0,
						)
						.map((proof) => toJson(HostingDestinationLiabilitySchema, proof)),
				);
			if (
				canonical(plan.destinationLiabilities) !==
				canonical(observation.destinationLiabilities)
			)
				return "independent destination liability evidence differs from the approved native bound";
		}
		if (
			operation.action === Action.SETTLE &&
			observation.targetRetired &&
			observation.destinationLiabilityFinalized &&
			plan.destinationLiabilities.length &&
			plan.destinationLiabilities.every(
				(proof) =>
					proof.expiresAtMs !== 0 &&
					proof.expiresAtMs <= observation.observedAtMs,
			)
		)
			return undefined;
		if (
			!observation.ready ||
			observation.healthyBackends < constraints.minimumHealthyBackends ||
			observation.latencyMs > constraints.maximumLatencyMs ||
			!constraints.allowedJurisdictions.includes(observation.jurisdiction) ||
			observation.capabilityDigest !== constraints.requiredCapabilityDigest
		)
			return "observed hosting constraints are not satisfied";
		if (
			operation.action === Action.PREPARE &&
			constraints.movementClass !== "stateless"
		) {
			if (
				!observation.checksumEqual ||
				observation.destinationAppliedSequence !==
					observation.sourceQuiescentSequence ||
				(constraints.movementClass === "single-writer" &&
					(!observation.sourceFenced || !observation.sourceFenceToken))
			)
				return "write-fence/checkpoint/checksum prerequisites are missing";
		}
		if (
			operation.action === Action.SHIFT &&
			constraints.movementClass === "single-writer" &&
			(!observation.destinationOwnsWrites ||
				observation.writeOwnershipEpoch <= constraints.sourceOwnershipEpoch)
		)
			return "destination write ownership is unconfirmed";
		if (
			operation.action === Action.RESTORE &&
			state.destinationOwnsWrites &&
			(!observation.reverseTransferSafe ||
				observation.writeOwnershipEpoch <= state.writeOwnershipEpoch)
		)
			return "reverse write ownership transfer is unconfirmed";
		if (operation.action === Action.RETIRE && !observation.sourceRetired)
			return "source retirement is unconfirmed";
		return undefined;
	}
	async function restore(
		transitionId: string,
	): Promise<HostingTransitionState> {
		const loaded = await required(transitionId);
		if (planOf(loaded.state).intent === "decommission")
			return block(
				loaded,
				"decommission cannot recreate or blindly restore the retired workload",
			);
		if (
			[Phase.PROPOSED, Phase.RESERVING, Phase.SETTLED].includes(
				loaded.state.phase,
			) ||
			!loaded.state.reservationId
		)
			throw new Error("transition has no compensable hosting operation");
		const pendingOperation = operationOf(loaded.state);
		const observation = loaded.state.lastObservation;
		// A scheduled operation without a durable dispatch claim cannot have run.
		// Read-only verification creates no new external mutation to reconcile.
		if (
			pendingOperation.mutationDispatched &&
			(!observation ||
				observation.operationId !== pendingOperation.operationId ||
				!["applied", "failed", "absent"].includes(observation.outcome))
		)
			throw new Error(
				"restoration requires a terminal authoritative observation of the current operation",
			);
		if (loaded.state.sourceRetirementConfirmed)
			return block(loaded, "retired source cannot be blindly restored");
		if (pendingOperation.action === Action.RESTORE) return loaded.state;
		if (loaded.state.destinationOwnsWrites && !loaded.state.reverseTransferSafe)
			return block(
				loaded,
				"stateful restoration requires proven safe reverse synchronization",
			);
		return (await schedule(loaded, Action.RESTORE)).state;
	}
	async function observe(
		transitionId: string,
	): Promise<HostingTransitionState> {
		let loaded = await required(transitionId);
		if ([Phase.BLOCKED, Phase.SETTLED].includes(loaded.state.phase))
			return loaded.state;
		if ([Phase.PROPOSED, Phase.RESERVING].includes(loaded.state.phase))
			return reserve(transitionId);
		const operation = operationOf(loaded.state);
		if (!operation.mutationDispatched && !readAction(operation.action))
			return loaded.state;
		if (now() < operation.nextObservationAtMs) return loaded.state;
		const plan = planOf(loaded.state);
		const facts = hostingEffectFacts(
			options.provider.contractId,
			"observe",
			new Date(now()).toISOString(),
		).map((fact) => ({ type: fact.type, data: fact }));
		// Claim one observation so concurrent workers cannot consume the retry budget twice.
		const reading = copy(loaded.state);
		operationOf(reading).nextObservationAtMs = hostingInteger(
			now() + plan.observationBackoffMs,
			"next observation",
		);
		loaded = await write(
			loaded,
			reading,
			"hosting.TransitionObserving",
			[],
			facts,
		);
		const result = await applyResilienceProfile({
			profile: hostingTransitionContracts.observe.resilience,
			now: () => new Date(now()).toISOString(),
			op: () =>
				withDeadline(
					(signal) =>
						options.provider.observe({
							plan: clone(HostingTransitionPlanSchema, plan),
							operation: clone(HostingTransitionOperationSchema, operation),
							reservationId: loaded.state.reservationId,
							fenceToken: options.context.fenceToken,
							signal,
						}),
					plan.operationTimeoutMs,
				),
		});
		if (result.facts.length) {
			loaded = await write(
				loaded,
				copy(loaded.state),
				"hosting.TransitionResilienceEvaluated",
				[],
				result.facts.map((fact) => ({ type: fact.type, data: fact })),
			);
		}
		if (!result.ok || !result.value) {
			if (
				["policy.Decided", "terminal", "cancellation"].includes(
					result.failureClass ?? "terminal",
				)
			)
				return block(loaded, `observation stopped: ${result.failureClass}`);
			return pending(
				loaded,
				`observation unavailable: ${result.failureClass}`,
				true,
			);
		}
		const observation = create(
			HostingTransitionObservationSchema,
			result.value,
		);
		let failure: string | undefined;
		try {
			if (
				result.value.usageFinal &&
				!Object.hasOwn(result.value, "settledMicros")
			)
				throw new Error(
					"final usage requires an explicit settled monetary amount",
				);
			failure = evidenceFailure(plan, operation, observation, loaded.state);
		} catch (error) {
			await block(
				loaded,
				"provider supplied invalid, stale, or incorrectly scoped evidence",
			);
			throw error;
		}
		const state = copy(loaded.state);
		state.lastObservation = observation;
		state.destinationOwnsWrites ||= observation.destinationOwnsWrites;
		state.reverseTransferSafe = observation.reverseTransferSafe;
		state.writeOwnershipEpoch = Math.max(
			state.writeOwnershipEpoch,
			observation.writeOwnershipEpoch,
		);
		// Retirement may succeed before the enclosing operation reports a failure.
		// Positive retirement evidence still forbids blindly reactivating the source.
		if (observation.sourceRetired) {
			state.sourceRetirementConfirmed = true;
			state.retirementEvidenceRef = observation.evidenceRef;
		}
		loaded = await write(loaded, state, "hosting.TransitionObserved");
		if (failure || ["failed", "absent"].includes(observation.outcome)) {
			if (
				operation.action === Action.RESTORE ||
				operation.action === Action.RETIRE ||
				operation.action === Action.SETTLE
			)
				return block(loaded, failure ?? "provider operation failed");
			return restore(transitionId);
		}
		if (observation.outcome !== "applied")
			return pending(
				loaded,
				`provider outcome is ${observation.outcome}`,
				true,
			);
		if (
			state.cancelRequested &&
			plan.intent !== "decommission" &&
			operation.action !== Action.RESTORE &&
			operation.action !== Action.SETTLE
		)
			return restore(transitionId);
		switch (operation.action) {
			case Action.PREPARE:
				return (await schedule(loaded, Action.SHIFT)).state;
			case Action.SHIFT:
				return (await schedule(loaded, Action.VERIFY)).state;
			case Action.VERIFY:
				if (now() < (plan.constraints?.rollbackHoldUntilMs ?? 0))
					return pending(
						loaded,
						"approved rollback retention window is still open",
						false,
					);
				return (await schedule(loaded, Action.RETIRE)).state;
			case Action.RETIRE: {
				const retired = copy(loaded.state);
				retired.sourceRetirementConfirmed = true;
				retired.retirementEvidenceRef = observation.evidenceRef;
				loaded = await write(
					loaded,
					retired,
					"hosting.TransitionSourceRetired",
				);
				return (await schedule(loaded, Action.SETTLE)).state;
			}
			case Action.RESTORE: {
				const restored = copy(loaded.state);
				restored.restorationConfirmed = true;
				restored.compensationCleanupConfirmed = observation.targetRetired;
				if (observation.targetRetired)
					restored.retirementEvidenceRef = observation.evidenceRef;
				if (!observation.targetRetired) {
					restored.phase = Phase.RESTORED;
					restored.blockedReason =
						"service restored; target liabilities remain reserved";
					return (
						await write(loaded, restored, "hosting.TransitionRestored", [
							timer(restored, now() + plan.observationBackoffMs),
						])
					).state;
				}
				loaded = await write(loaded, restored, "hosting.TransitionRestored");
				return (await schedule(loaded, Action.SETTLE)).state;
			}
			case Action.SETTLE: {
				if (
					!observation.usageFinal ||
					(plan.destinationLiabilities.length > 0 &&
						!state.compensationCleanupConfirmed &&
						!observation.destinationLiabilityFinalized) ||
					(!state.sourceRetirementConfirmed &&
						!state.compensationCleanupConfirmed)
				)
					return pending(
						loaded,
						"final usage, retired source, and finalized destination liability are required for settlement",
						true,
					);
				const settled = await options.budget.settle({
					...identity(state),
					settledMicros: observation.settledMicros,
					evidenceRef: observation.evidenceRef,
					sourceStoppedEvidenceRef: state.retirementEvidenceRef,
				});
				if (!settled.ok) return pending(loaded, settled.reason, true);
				const confirmed = await options.budget.lookup(identity(state));
				if (
					confirmed.status !== "settled" ||
					confirmed.settledMicros !== observation.settledMicros
				)
					return pending(
						loaded,
						"financial settlement could not be confirmed",
						true,
					);
				const completed = copy(state);
				completed.phase = Phase.SETTLED;
				completed.settledMicros = observation.settledMicros;
				completed.operation = undefined;
				return (await write(loaded, completed, "hosting.TransitionSettled"))
					.state;
			}
			default:
				return block(loaded, "unsupported hosting action");
		}
	}
	return {
		async propose(
			input: HostingTransitionPlanInput,
		): Promise<HostingTransitionState> {
			const plan = createHostingTransitionPlan(input);
			if (plan.tenantId !== tenantId)
				throw new Error("foreign tenant transition request");
			if (
				options.provider.requiresDestinationLiabilityProof &&
				plan.intent !== "decommission" &&
				!plan.destinationLiabilities.length
			)
				throw new Error(
					"production hosting requires provider-enforced destination liability proof",
				);
			if (
				(options.provider.requiresSourceLiabilityProof ||
					options.provider.requiresSourceLiabilityProofFor?.(
						clone(HostingTransitionPlanSchema, plan),
					)) &&
				!plan.sourceLiabilities.length
			)
				throw new Error(
					"production hosting requires provider-enforced source liability proof",
				);
			if (
				plan.destinationLiabilities.some(
					(proof) => proof.expiresAtMs !== 0 && proof.expiresAtMs <= now(),
				)
			)
				throw new Error("native destination liability proof has expired");
			if (
				plan.adapterContractDigest !==
				hostingAdapterContractDigest(options.provider)
			)
				throw new Error("adapter contract differs from approved proposal");
			if (
				plan.maximumMutationResumes &&
				(options.provider.executionGuarantee !== "idempotent-operation" ||
					options.provider.mutationJournal?.persistence !== "durable-cas")
			)
				throw new Error(
					"approved resumption requires the idempotent adapter's durable mutation journal",
				);
			const previous = await read(plan.transitionId);
			if (previous) {
				if (planOf(previous.state).planDigest !== plan.planDigest)
					throw new Error("transition identity reused with different proposal");
				return previous.state;
			}
			if (now() >= plan.horizonEndMs)
				throw new Error("transition horizon has expired");
			const initial = initialHostingTransition(plan);
			return (
				await write(
					{ state: initial, seq: 0 },
					copy(initial),
					"hosting.TransitionProposed",
					[
						{
							kind: "outbox",
							destination: "hosting.transition.reserve",
							idempotencyKey: `reserve:${tenantId}:${plan.transitionId}`,
							payload: { tenantId, transitionId: plan.transitionId },
						},
					],
				)
			).state;
		},
		reserve,
		dispatch,
		resumeMutation,
		observe,
		restore,
		async cancel(transitionId: string, reason = "cancellation requested") {
			const loaded = await required(transitionId);
			if (loaded.state.phase === Phase.SETTLED) return loaded.state;
			if (
				planOf(loaded.state).intent === "decommission" &&
				!loaded.state.operation?.mutationDispatched
			) {
				const stopped = copy(loaded.state);
				stopped.cancelRequested = true;
				stopped.phase = Phase.BLOCKED;
				stopped.blockedReason =
					"decommission cancelled before retirement; source is intact and the financial hold is retained for unused-liability reconciliation";
				const cancelled = await write(
					loaded,
					stopped,
					"hosting.TransitionCancelled",
				);
				if (stopped.reservationId)
					await options.budget.uncertain({ ...identity(stopped), reason });
				return cancelled.state;
			}
			const state = copy(loaded.state);
			state.cancelRequested = true;
			state.blockedReason = reason;
			state.phase = state.operation
				? !state.operation.mutationDispatched &&
					state.operation.action === Action.RESTORE
					? Phase.RESTORING
					: Phase.RECONCILING
				: state.reservationId
					? Phase.RESERVING
					: Phase.BLOCKED;
			const cancelled = (
				await write(
					loaded,
					state,
					"hosting.TransitionCancelled",
					state.operation
						? [timer(state, now() + planOf(state).observationBackoffMs)]
						: [],
				)
			).state;
			if (state.reservationId)
				await options.budget.uncertain({ ...identity(state), reason });
			if (
				state.operation &&
				!state.operation.mutationDispatched &&
				!readAction(state.operation.action)
			)
				return restore(transitionId);
			return cancelled;
		},
		async load(transitionId: string) {
			return (await read(transitionId))?.state;
		},
	};
}
