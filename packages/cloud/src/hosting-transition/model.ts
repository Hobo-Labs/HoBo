import { createHash } from "node:crypto";
import {
	clone,
	create,
	fromJson,
	type "MessageInitShape" as MessageInitializer,
	toJson,
} from "@bufbuild/protobuf";
import {
	canonicalJson,
	parseEffectSpec,
	parseResilienceProfile,
	validateResilienceAgainstEffects,
} from "@hobo/contracts";
import type { EventEnvelope } from "@hobo/core";
import {
	HostingTransitionAction,
	HostingTransitionEventSchema,
	HostingTransitionPhase,
	type HostingTransitionPlan,
	HostingTransitionPlanSchema,
	type HostingTransitionState,
	HostingTransitionStateSchema,
} from "../_generated/hosting_transition_pb.js";

export type {
	HostingDestinationLiability,
	HostingTransitionObservation,
	HostingTransitionOperation,
	HostingTransitionPlan,
	HostingTransitionState,
} from "../_generated/hosting_transition_pb.js";
export {
	HostingDestinationLiabilitySchema,
	HostingTransitionAction,
	HostingTransitionObservationSchema,
	HostingTransitionPhase,
	HostingTransitionPlanSchema,
} from "../_generated/hosting_transition_pb.js";
export type HostingTransitionPlanInput = MessageInitializer<
	typeof HostingTransitionPlanSchema
>;

export function hostingDigest<T>(value: T): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
export function hostingInteger(
	value: number,
	field: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw new Error(`${field} must be a safe integer >= ${minimum}`);
	return value;
}
export function hostingName(value: string, field: string): string {
	if (
		Object.prototype.toString.call(value) !== "[object String]" ||
		value.length === 0 ||
		value.length > 1000
	)
		throw new Error(`${field} is required`);
	return value;
}
function safeSum(values: readonly number[]): number {
	const total = values.reduce(
		(sum, value) => sum + BigInt(hostingInteger(value, "money")),
		0n,
	);
	if (total > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("money overflows safe integer");
	return Number(total);
}

/** Pure constructor: all workload declarations and financial identities participate in its digest. */
export function createHostingTransitionPlan(
	input: HostingTransitionPlanInput,
): HostingTransitionPlan {
	// Initializers may mix a spread wire record with plain nested values. Removing
	// root metadata prevents protobuf create() from skipping nested conversion.
	const initializer = { ...input };
	Reflect.deleteProperty(initializer, "$typeName");
	const plan = clone(
		HostingTransitionPlanSchema,
		create(HostingTransitionPlanSchema, initializer),
	);
	if (plan.schemaVersion !== "hobo.hosting-transition/v1")
		throw new Error("unsupported hosting transition schema");
	for (const field of [
		"transitionId",
		"tenantId",
		"deploymentId",
		"sourcePlanId",
		"targetPlanId",
		"workloadContractId",
		"adapterContractDigest",
	] as const)
		hostingName(plan[field], field);
	if (plan.sourcePlanId === plan.targetPlanId)
		throw new Error(
			"hosting transition requires distinct source and destination",
		);
	if (!["", "move", "decommission"].includes(plan.intent))
		throw new Error("unsupported hosting lifecycle intent");
	if (plan.existingReservationId && !plan.financialPlanHash)
		throw new Error(
			"reservation adoption requires the original financial plan hash",
		);
	if (
		plan.financialPlanHash &&
		!/^sha256:[0-9a-f]{64}$/.test(plan.financialPlanHash)
	)
		throw new Error(
			"financial approval requires an immutable sha256 artifact hash",
		);
	if (
		plan.existingReservationId &&
		plan.targetPlanId !== plan.financialPlanHash
	)
		throw new Error(
			"adopted reservation destination artifact differs from financial approval",
		);
	const commitment = plan.commitment;
	const constraints = plan.constraints;
	if (!commitment || !constraints)
		throw new Error(
			"financial commitment and execution constraints are required",
		);
	if (commitment.tenantId !== plan.tenantId)
		throw new Error("foreign tenant financial commitment");
	for (const field of [
		"budgetId",
		"scopeId",
		"periodId",
		"policyRevision",
		"commitmentHash",
	] as const)
		hostingName(commitment[field], field);
	if (!/^[A-Z]{3}$/.test(commitment.currency))
		throw new Error("commitment currency is required");
	for (const field of [
		"ledgerSeq",
		"expectedMicros",
		"reservedMicros",
		"validUntilMs",
	] as const)
		hostingInteger(commitment[field], field);
	if (
		commitment.expectedMicros > commitment.reservedMicros ||
		commitment.allocations.length === 0
	)
		throw new Error(
			"bounded commitment must cover expected cost and identify allocations",
		);
	const resources = new Set<string>();
	for (const allocation of commitment.allocations) {
		for (const field of [
			"resourceName",
			"definitionId",
			"quoteId",
			"providerAccountId",
		] as const)
			hostingName(allocation[field], field);
		if (resources.has(allocation.resourceName))
			throw new Error("duplicate hosting resource allocation");
		resources.add(allocation.resourceName);
		hostingInteger(allocation.reservedMicros, "reserved allocation");
		hostingInteger(allocation.expectedMicros, "expected allocation");
		if (allocation.expectedMicros > allocation.reservedMicros)
			throw new Error("allocation lacks an enforceable bound");
	}
	if (
		safeSum(
			commitment.allocations.map((allocation) => allocation.reservedMicros),
		) !== commitment.reservedMicros ||
		safeSum(
			commitment.allocations.map((allocation) => allocation.expectedMicros),
		) !== commitment.expectedMicros
	)
		throw new Error("commitment totals differ from allocations");
	hostingInteger(
		constraints.minimumHealthyBackends,
		"minimumHealthyBackends",
		plan.intent === "decommission" ? 0 : 1,
	);
	if (plan.intent === "decommission" && !constraints.interruptionAllowed)
		throw new Error("decommission requires explicit interruption approval");
	hostingInteger(constraints.maximumLatencyMs, "maximumLatencyMs", 1);
	hostingInteger(constraints.observationMaxAgeMs, "observationMaxAgeMs", 1);
	hostingInteger(constraints.rollbackHoldUntilMs, "rollbackHoldUntilMs");
	hostingName(constraints.requiredCapabilityDigest, "requiredCapabilityDigest");
	hostingInteger(constraints.sourceOwnershipEpoch, "sourceOwnershipEpoch");
	if (
		!constraints.allowedJurisdictions.length ||
		constraints.allowedJurisdictions.some((value) => !value)
	)
		throw new Error("allowed jurisdictions are required");
	if (
		!["stateless", "replicated", "single-writer"].includes(
			constraints.movementClass,
		)
	)
		throw new Error("movement class must be explicitly declared");
	const workloadEffects = parseEffectSpec(
		JSON.parse(hostingName(plan.workloadEffectsJson, "workload effects")),
	);
	const workloadResilience = parseResilienceProfile(
		JSON.parse(hostingName(plan.workloadResilienceJson, "workload resilience")),
	);
	validateResilienceAgainstEffects(workloadResilience, workloadEffects);
	const workloadContractDigest = hostingDigest({
		contractId: plan.workloadContractId,
		effects: workloadEffects,
		resilience: workloadResilience,
	});
	if (
		plan.workloadContractDigest &&
		plan.workloadContractDigest !== workloadContractDigest
	)
		throw new Error(
			"workload contract digest differs from declared effects and resilience",
		);
	plan.workloadContractDigest = workloadContractDigest;
	if (
		constraints.movementClass === "single-writer" &&
		!constraints.interruptionAllowed
	)
		throw new Error(
			"single-writer fencing requires declared interruption tolerance",
		);
	for (const field of [
		"operationTimeoutMs",
		"observationBackoffMs",
		"maximumObservationAttempts",
		"horizonEndMs",
	] as const)
		hostingInteger(plan[field], field, 1);
	hostingInteger(plan.maximumMutationResumes, "maximumMutationResumes");
	if (
		plan.maximumObservationAttempts > 100 ||
		plan.maximumMutationResumes > 10 ||
		constraints.rollbackHoldUntilMs > plan.horizonEndMs
	)
		throw new Error(
			"unbounded observation budget or unfunded retention window",
		);
	if (plan.intent === "decommission" && plan.destinationLiabilities.length)
		throw new Error("decommission cannot declare a surviving destination");
	if (plan.destinationLiabilities.length) {
		if (plan.destinationLiabilities.length !== commitment.allocations.length)
			throw new Error("destination liability must cover every funded resource");
		const seen = new Set<string>();
		for (const liability of plan.destinationLiabilities) {
			for (const field of [
				"resourceName",
				"providerId",
				"providerAccountId",
				"evidenceRef",
			] as const)
				hostingName(liability[field], field);
			if (!/^sha256:[0-9a-f]{64}$/.test(liability.artifactDigest))
				throw new Error(
					"destination liability requires the immutable resource artifact",
				);
			hostingInteger(liability.maximumMicros, "destination liability maximum");
			hostingInteger(liability.expiresAtMs, "destination liability expiration");
			const allocation = commitment.allocations.find(
				(value) => value.resourceName === liability.resourceName,
			);
			const quote = commitment.evidence?.quotes.find(
				(value) =>
					value.id === allocation?.quoteId &&
					value.resourceName === liability.resourceName &&
					value.definitionId === allocation.definitionId,
			);
			if (
				seen.has(liability.resourceName) ||
				!allocation ||
				!quote ||
				quote.providerId !== liability.providerId ||
				quote.providerAccountId !== liability.providerAccountId ||
				allocation.providerAccountId !== liability.providerAccountId ||
				liability.maximumMicros > allocation.reservedMicros
			)
				throw new Error(
					"destination liability differs from funded resource/account/bound",
				);
			seen.add(liability.resourceName);
			if (liability.expiresAtMs > plan.horizonEndMs)
				throw new Error(
					"native destination lifetime exceeds the funded horizon",
				);
			if (liability.mode === "provider-funded-zero") {
				if (liability.maximumMicros !== 0)
					throw new Error(
						"provider-funded destination cannot impose customer liability",
					);
			} else if (
				liability.mode !== "native-finite-term" ||
				!liability.expiresAtMs
			)
				throw new Error(
					"destination requires an enforceable provider-funded or finite native term",
				);
			if (liability.expiresAtMs && !constraints.interruptionAllowed)
				throw new Error(
					"native destination expiration requires explicit interruption approval",
				);
		}
		plan.destinationLiabilities.sort((a, b) =>
			a.resourceName < b.resourceName
				? -1
				: a.resourceName > b.resourceName
					? 1
					: 0,
		);
	}
	const sourceResources = new Set<string>();
	if (plan.sourceIncarnationId || plan.sourceLiabilities.length)
		hostingName(plan.sourceIncarnationId, "source incarnation identity");
	for (const liability of plan.sourceLiabilities) {
		for (const field of [
			"resourceName",
			"providerId",
			"providerAccountId",
			"evidenceRef",
		] as const)
			hostingName(liability[field], `source ${field}`);
		if (!/^sha256:[0-9a-f]{64}$/.test(liability.artifactDigest))
			throw new Error(
				"source liability requires the immutable resource artifact",
			);
		hostingInteger(liability.maximumMicros, "source liability maximum");
		hostingInteger(liability.expiresAtMs, "source liability expiration");
		if (sourceResources.has(liability.resourceName))
			throw new Error("duplicate source liability resource");
		sourceResources.add(liability.resourceName);
		if (liability.expiresAtMs > plan.horizonEndMs)
			throw new Error("native source liability exceeds the funded horizon");
		if (liability.mode === "provider-funded-zero") {
			if (liability.maximumMicros !== 0)
				throw new Error(
					"provider-funded source cannot impose customer liability",
				);
		} else if (
			liability.mode !== "native-finite-term" ||
			!liability.expiresAtMs
		)
			throw new Error(
				"source requires an enforceable provider-funded or finite native term",
			);
	}
	const allLiabilities = [
		...plan.destinationLiabilities,
		...plan.sourceLiabilities,
	];
	if (
		new Set(allLiabilities.map((value) => value.evidenceRef)).size !==
		allLiabilities.length
	)
		throw new Error(
			"native liability evidence cannot be reused for another resource incarnation",
		);
	if (
		safeSum(allLiabilities.map((value) => value.maximumMicros)) >
		commitment.reservedMicros
	)
		throw new Error(
			"combined source and destination liabilities exceed the financial commitment",
		);
	const accountMaximums = new Map<string, number>();
	const accountReservations = new Map<string, number>();
	for (const liability of allLiabilities)
		accountMaximums.set(
			liability.providerAccountId,
			safeSum([
				accountMaximums.get(liability.providerAccountId) ?? 0,
				liability.maximumMicros,
			]),
		);
	for (const allocation of commitment.allocations)
		for (const charge of allocation.providerCharges)
			accountReservations.set(
				charge.providerAccountId,
				safeSum([
					accountReservations.get(charge.providerAccountId) ?? 0,
					charge.reservedMicros,
				]),
			);
	for (const [account, maximum] of accountMaximums)
		if (maximum > (accountReservations.get(account) ?? 0))
			throw new Error(
				"native liability has no matching provider-account financial reservation",
			);
	plan.sourceLiabilities.sort((a, b) =>
		a.resourceName < b.resourceName
			? -1
			: a.resourceName > b.resourceName
				? 1
				: 0,
	);
	const suppliedDigest = plan.planDigest;
	plan.planDigest = "";
	const computed = hostingDigest(toJson(HostingTransitionPlanSchema, plan));
	if (suppliedDigest && suppliedDigest !== computed)
		throw new Error("hosting plan digest mismatch");
	plan.planDigest = computed;
	return plan;
}

export function hostingTransitionStream(
	tenantId: string,
	transitionId: string,
): string {
	return `hosting-transition:${encodeURIComponent(hostingName(tenantId, "tenant"))}:${encodeURIComponent(hostingName(transitionId, "transition"))}`;
}

/** Read-only replay never consults a clock, authority, or provider. */
export function foldHostingTransition(
	events: readonly EventEnvelope[],
): HostingTransitionState | undefined {
	let state: HostingTransitionState | undefined;
	for (const event of events) {
		if (!event.type.startsWith("hosting.Transition")) continue;
		const parsed = fromJson(
			HostingTransitionEventSchema,
			JSON.parse(JSON.stringify(event.data)),
		);
		if (!parsed.state?.plan) throw new Error("hosting event lacks typed state");
		const next = parsed.state;
		const plan = parsed.state.plan;
		if (!plan) throw new Error("hosting event lacks approved plan");
		createHostingTransitionPlan(plan);
		if (
			next.version !== (state?.version ?? 0) + 1 ||
			(state && plan.planDigest !== state.plan?.planDigest)
		)
			throw new Error("hosting event history is inconsistent");
		hostingInteger(next.operationSequence, "operation sequence");
		if (next.operation) {
			const operation = next.operation;
			hostingInteger(operation.mutationResumes, "mutation resumes");
			hostingInteger(operation.observationAttempts, "observation attempts");
			hostingInteger(operation.action, "operation action", 1);
			hostingInteger(operation.startedAtMs, "operation start");
			hostingInteger(operation.deadlineAtMs, "operation deadline");
			hostingInteger(operation.nextObservationAtMs, "next observation");
			if (
				operation.action > 6 ||
				operation.deadlineAtMs <= operation.startedAtMs
			)
				throw new Error("hosting journal has an invalid operation/deadline");
			if (operation.mutationResumes > plan.maximumMutationResumes)
				throw new Error(
					"hosting journal exceeds approved mutation resume bound",
				);
			const expectedId = `${plan.transitionId}:${next.operationSequence}:${HostingTransitionAction[operation.action]}`;
			if (
				!next.operationSequence ||
				operation.operationId !== expectedId ||
				operation.operationDigest !==
					hostingDigest({
						planDigest: plan.planDigest,
						operationId: operation.operationId,
						action: operation.action,
					})
			)
				throw new Error("hosting journal changes operation identity");
			if (state?.operation?.operationId === operation.operationId) {
				const difference =
					operation.mutationResumes - state.operation.mutationResumes;
				if (
					(event.type === "hosting.TransitionMutationResumeRequested" &&
						difference !== 1) ||
					(event.type !== "hosting.TransitionMutationResumeRequested" &&
						difference !== 0)
				)
					throw new Error(
						"hosting journal changes the mutation resume counter without an explicit command",
					);
			} else if (operation.mutationResumes !== 0)
				throw new Error(
					"new hosting operation starts with consumed resume attempts",
				);
		}
		state = create(HostingTransitionStateSchema, next);
	}
	return state;
}

export function initialHostingTransition(
	plan: HostingTransitionPlan,
): HostingTransitionState {
	return create(HostingTransitionStateSchema, {
		plan,
		phase: HostingTransitionPhase.PROPOSED,
	});
}
