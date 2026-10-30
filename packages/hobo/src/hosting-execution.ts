import { fromJson } from "@bufbuild/protobuf";
import type { YardRuntime, YardSession } from "@hobo/cli";
import {
	canonicalHostingEvidence,
	createHostingPlanningPass,
	createHostingTransitionCoordinator,
	createHostingTransitionPlan,
	type DeployResultPlanned,
	type HostingTransitionCoordinatorOptions,
	HostingTransitionPhase,
	type HostingTransitionPlanInput,
	HostingTransitionPlanSchema,
	type HostingTransitionState,
	hashDeploymentPlan,
} from "@hobo/cloud";
import { isJsonObject } from "./json.js";

export interface ProductionHostingExecutionOptions
	extends HostingTransitionCoordinatorOptions {
	/** Trusted workload/source/routing approval, indexed by deployment id. The
	 * financial commitment and target hash are taken from durable gateway facts. */
	readonly templates: ReadonlyMap<string, HostingTransitionPlanInput>;
	readonly maximumStepsPerResume?: number;
	readonly decommissionTemplates?: ReadonlyMap<
		string,
		HostingTransitionPlanInput
	>;
	readonly budgetId?: string;
}

/** Production application composition over the durable coordinator. The same
 * worker serves up/down and operator resume; no legacy apply can bypass a hold. */
export function createProductionHostingExecution(
	options: ProductionHostingExecutionOptions,
) {
	const coordinator = createHostingTransitionCoordinator(options);
	const maximumSteps = options.maximumStepsPerResume ?? 32;
	if (
		!Number.isSafeInteger(maximumSteps) ||
		maximumSteps < 1 ||
		maximumSteps > 256
	)
		throw new Error("hosting worker requires a bounded step budget");
	const plans = new Map(
		[...options.templates].map(([id, input]) => [id, structuredClone(input)]),
	);
	const retirements = new Map(
		[...(options.decommissionTemplates ?? [])].map(([id, input]) => [
			id,
			structuredClone(input),
		]),
	);
	function sessionAllowed(session: YardSession) {
		if (
			session.tenant !== options.context.tenantId ||
			session.principal.id !== options.context.actor.id ||
			session.principal.kind !== options.context.actor.kind
		)
			throw new Error(
				"hosting command principal differs from the authenticated runtime scope",
			);
	}
	function template(deploymentId: string) {
		const input = plans.get(deploymentId);
		if (!input)
			throw new Error(
				"deployment has no approved hosting execution configuration",
			);
		if (
			!input.transitionId ||
			input.deploymentId !== deploymentId ||
			input.tenantId !== options.context.tenantId
		)
			throw new Error(
				"hosting execution configuration belongs to another deployment or tenant",
			);
		return input;
	}
	async function activeTransition(deploymentId: string) {
		const retirement = retirements.get(deploymentId);
		if (
			retirement?.transitionId &&
			(await coordinator.load(retirement.transitionId))
		)
			return retirement.transitionId;
		return template(deploymentId).transitionId ?? "";
	}
	async function resume(transitionId: string): Promise<HostingTransitionState> {
		let state = await coordinator.load(transitionId);
		if (!state) throw new Error("unknown hosting transition");
		for (let step = 0; step < maximumSteps; step += 1) {
			const version = state.version;
			if (
				[
					HostingTransitionPhase.SETTLED,
					HostingTransitionPhase.RESTORED,
					HostingTransitionPhase.BLOCKED,
				].includes(state.phase)
			)
				break;
			if (
				[
					HostingTransitionPhase.PROPOSED,
					HostingTransitionPhase.RESERVING,
				].includes(state.phase)
			)
				state = await coordinator.reserve(transitionId);
			else if (state.operation) {
				if (state.operation.nextObservationAtMs > options.nowMs()) break;
				state =
					!state.operation.mutationDispatched &&
					(!state.cancelRequested ||
						state.phase === HostingTransitionPhase.RESTORING) &&
					![
						HostingTransitionPhase.VERIFYING,
						HostingTransitionPhase.SETTLING,
					].includes(state.phase)
						? await coordinator.dispatch(transitionId)
						: await coordinator.observe(transitionId);
			} else break;
			if (state.version === version) break;
		}
		return state;
	}
	async function admission(admitted: DeployResultPlanned) {
		if (
			hashDeploymentPlan(admitted.plan) !== admitted.planHash ||
			!admitted.hostingReservationId
		)
			throw new Error(
				"hosting admission requires an exact funded deployment artifact",
			);
		let financial:
			| ReturnType<typeof fromJson<typeof HostingTransitionPlanSchema>>
			| undefined;
		let planned = false;
		for await (const event of options.store.read(
			`deployment:${admitted.deploymentId}`,
		)) {
			if (event.tenant !== options.context.tenantId)
				throw new Error("foreign deployment admission history");
			const data = event.data;
			if (!isJsonObject(data)) continue;
			if (
				event.type === "deployment.Planned" &&
				data.planHash === admitted.planHash &&
				canonicalHostingEvidence(data.plan) ===
					canonicalHostingEvidence(admitted.plan)
			)
				planned = true;
			if (
				event.type === "hosting.BudgetReserved" &&
				data.reservationId === admitted.hostingReservationId &&
				isJsonObject(data.commitment)
			)
				financial = fromJson(HostingTransitionPlanSchema, {
					commitment: JSON.parse(JSON.stringify(data.commitment)),
				});
		}
		if (!planned || !financial?.commitment)
			throw new Error(
				"deployment plan and financial admission are not durably recorded",
			);
		return financial.commitment;
	}
	const execution: NonNullable<YardRuntime["hostingExecution"]> = {
		async up({ admission: admitted, session }) {
			sessionAllowed(session);
			const reservationId = admitted.hostingReservationId;
			if (!reservationId)
				throw new Error("hosting execution requires a reservation");
			const input = template(admitted.deploymentId);
			const retirement = retirements.get(admitted.deploymentId);
			if (
				retirement?.transitionId &&
				(await coordinator.load(retirement.transitionId))
			)
				throw new Error(
					"deployment incarnation is retiring or retired; a new approved transition and native incarnation are required",
				);
			const commitment = await admission(admitted);
			const plan = createHostingTransitionPlan({
				...input,
				planDigest: "",
				targetPlanId: admitted.planHash,
				financialPlanHash: admitted.planHash,
				existingReservationId: reservationId,
				commitment,
			});
			await coordinator.propose(plan);
			const state = await resume(plan.transitionId);
			const complete = state.phase === HostingTransitionPhase.SETTLED;
			return {
				status: complete
					? state.restorationConfirmed
						? "rolled-back"
						: "deployed"
					: state.phase === HostingTransitionPhase.BLOCKED
						? "needs-human"
						: "waiting",
				deploymentId: admitted.deploymentId,
				planHash: admitted.planHash,
				plan: admitted.plan,
				provisioned:
					complete && !state.restorationConfirmed
						? admitted.plan.resources.map((resource) => resource.name)
						: [],
				progress: [
					{
						type: "hosting.TransitionObserved",
						detail: `${HostingTransitionPhase[state.phase]}: ${state.blockedReason}`,
					},
				],
			};
		},
		async down({ deploymentId, session, bindle }) {
			sessionAllowed(session);
			const input = template(deploymentId);
			const priorRetirement = retirements.get(deploymentId);
			if (
				priorRetirement?.transitionId &&
				(await coordinator.load(priorRetirement.transitionId))
			) {
				const observed = await resume(priorRetirement.transitionId);
				return {
					status:
						observed.phase === HostingTransitionPhase.SETTLED
							? "destroyed"
							: "needs-human",
					deploymentId,
					destroyed: [],
					progress: [
						{
							type: "hosting.DecommissionObserved",
							detail: observed.blockedReason,
						},
					],
				};
			}
			const state = await coordinator.load(input.transitionId ?? "");
			if (!state)
				throw new Error("cannot teardown an unrecorded hosting transition");
			// Normal cancellation compensates safely; retirement of a completed target
			// requires a separately funded approved transition, not an unfunded destroy.
			if (state.phase === HostingTransitionPhase.SETTLED) {
				const retirement = retirements.get(deploymentId);
				if (
					retirement?.intent !== "decommission" ||
					!options.budget.resolve ||
					!options.budgetId
				)
					throw new Error(
						"hosting teardown requires approved decommission policy and trusted cleanup quotes",
					);
				if (
					retirement.sourcePlanId !== state.plan?.targetPlanId ||
					retirement.sourceIncarnationId !== state.plan?.transitionId ||
					retirement.deploymentId !== deploymentId ||
					retirement.tenantId !== session.tenant
				)
					throw new Error(
						"decommission policy does not name the active deployment artifact",
					);
				const quoteRequest = {
					budgetId: options.budgetId,
					tenantId: session.tenant,
					bindle,
					objective: "min-cost",
					intent: "decommission" as const,
					sourcePlanId: retirement.sourcePlanId ?? "",
					sourceIncarnationId: retirement.sourceIncarnationId ?? "",
				};
				const evidence = await options.budget.resolve(quoteRequest);
				if (
					evidence.budget.tenantId !== session.tenant ||
					evidence.budget.budgetId !== options.budgetId
				)
					throw new Error("cleanup quote belongs to another tenant or budget");
				const pass = createHostingPlanningPass(evidence);
				for (const usage of evidence.usages) {
					const quotes = evidence.quotes.filter(
						(row) => row.resourceName === usage.resourceName,
					);
					const quote = quotes[0];
					if (
						quotes.length !== 1 ||
						!quote?.components?.some(
							(component) => component.costClass === "cleanup",
						)
					)
						throw new Error(
							"decommission requires exact resource-owned bounded cleanup quote components",
						);
					pass.commit(usage.resourceName, {
						id: quote.definitionId,
						providerId: quote.providerId,
						port: "hosting",
						features: [],
						regions: [],
						specificity: 0,
						priority: 0,
						cost: {
							sku: quote.definitionId,
							unit: quote.billingUnit,
							marginalPrice: "0",
						},
						satisfies: () => ({ kind: "full" }),
					});
				}
				const financial = fromJson(HostingTransitionPlanSchema, {
					commitment: JSON.parse(canonicalHostingEvidence(pass.commitment())),
				}).commitment;
				if (!financial) throw new Error("cleanup commitment is missing");
				const approved = createHostingTransitionPlan({
					...retirement,
					planDigest: "",
					existingReservationId: "",
					financialPlanHash: "",
					commitment: financial,
				});
				await coordinator.propose(approved);
				const observed = await resume(approved.transitionId);
				return {
					status:
						observed.phase === HostingTransitionPhase.SETTLED
							? "destroyed"
							: "needs-human",
					deploymentId,
					destroyed: [],
					progress: [
						{
							type: "hosting.DecommissionObserved",
							detail: observed.blockedReason,
						},
					],
				};
			}
			await coordinator.cancel(
				input.transitionId ?? "",
				"operator requested hosting teardown",
			);
			const observed = await resume(input.transitionId ?? "");
			const restored =
				[
					HostingTransitionPhase.RESTORED,
					HostingTransitionPhase.SETTLED,
				].includes(observed.phase) && observed.compensationCleanupConfirmed;
			return {
				status: restored ? "destroyed" : "needs-human",
				deploymentId,
				destroyed: [],
				progress: [
					{
						type: "hosting.TransitionObserved",
						detail: observed.blockedReason,
					},
				],
			};
		},
	};
	return {
		execution,
		resume,
		async status(deploymentId: string) {
			return coordinator.load(await activeTransition(deploymentId));
		},
		async cancel(
			deploymentId: string,
			reason = "operator requested hosting cancellation",
		) {
			return coordinator.cancel(await activeTransition(deploymentId), reason);
		},
		async resumeDeployment(deploymentId: string) {
			return resume(await activeTransition(deploymentId));
		},
		async resumeMutation(deploymentId: string) {
			return coordinator.resumeMutation(await activeTransition(deploymentId));
		},
	};
}
