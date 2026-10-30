import type { ManifestV1 } from "@hobo/bindles";
import {
	collectStream,
	type DeploymentPlan,
	type DeployResult,
	type DeployResultPlanned,
	deploy,
	type GatewayContext,
	type GatewayDeps,
	manifestHostingPolicy,
	type OrchestratorDeps,
	type OrchestratorResult,
	type PlannerRegistry,
	type PlanRemediation,
	type PlanResult,
	plan as planDeployment,
	runCompensation,
	runOrchestrator,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";

// The Yard-client seam (S2-08): the single in-process call path the four cloud
// verbs (login/plan/up/down) share. The CLI dispatch layer is the source of
// truth for the CLI<->Yard boundary; MCP parity (S3-01) reuses this same seam.
//
// `src/` stays adapter-free: the concrete EventStore/ActorHost/Executor/
// IacProvider and provider registry are INJECTED via YardRuntime (tests populate
// them from @hobo/runtime-local + @hobo/provider-cloudflare + an in-memory
// IacProvider). Un-injected, the cloud verbs fall back to their shell stubs.

// A dev/mocked-lane session. The gateway accepts any attributable (non-system,
// non-empty-id) principal (gateway.authorize), so a fixture principal suffices
// for the mocked lane; @hobo/identity SVID brokering is a later slice.
export interface YardSession {
	readonly tenant: string;
	readonly principal: PrincipalRef;
	readonly token: string;
	readonly issuedAt: string;
}

// The env-specific runtime the Yard drives. Every field is sourced structurally
// from @hobo/cloud re-exports so `src/` never imports an infra adapter directly.
export interface YardRuntime {
	readonly store: GatewayDeps["store"];
	readonly actorHost: GatewayDeps["actorHost"];
	readonly executor: OrchestratorDeps["executor"];
	readonly broker: OrchestratorDeps["broker"];
	readonly registry: PlannerRegistry;
	/** Authoritative financial evidence and admission; never supplied by a CLI flag. */
	readonly hostingBudgetAuthority?: SharedHostingBudgetAuthority;
	readonly defaultHostingBudgetId?: string;
	readonly hostingBudgetRequired?: boolean;
	/** The production hosting supervisor owns provider effects and observed teardown. */
	readonly hostingExecution?: {
		up(request: {
			admission: DeployResultPlanned;
			session: YardSession;
		}): Promise<UpResult>;
		down(request: {
			deploymentId: string;
			session: YardSession;
			bindle: ManifestV1;
		}): Promise<DownResult>;
	};
}

export interface DeployConfig {
	readonly objective?: string;
	readonly region?: string;
	readonly budgetId?: string;
}

export interface PlanRenderedSuccess {
	readonly ok: true;
	readonly deploymentId: string;
	readonly planHash: string;
	readonly plan: DeploymentPlan;
	readonly resources: DeploymentPlan["resources"];
	readonly dependencyOrder: string[];
}

export interface PlanRenderedRejection {
	readonly ok: false;
	readonly deploymentId: string;
	readonly reason: string;
	readonly remediations: PlanRemediation[];
}

export type PlanRendered = PlanRenderedSuccess | PlanRenderedRejection;

export interface ProgressEvent {
	readonly type: string;
	readonly resourceId?: string;
	readonly detail: string;
}

export interface UpRejected {
	readonly status: "rejected";
	readonly deploymentId: string;
	readonly reason: string;
	readonly remediations: PlanRemediation[];
}

export interface UpRealized {
	readonly status: OrchestratorResult["status"];
	readonly deploymentId: string;
	readonly planHash: string;
	readonly plan: DeploymentPlan;
	readonly provisioned: string[];
	readonly progress: ProgressEvent[];
}

export type UpResult = UpRejected | UpRealized;

export interface DownResult {
	// CLI-facing teardown status: "destroyed" when the compensation/destroy path
	// tore everything down, "needs-human" when a destroy failed mid-rollback.
	readonly status: "destroyed" | "needs-human";
	readonly deploymentId: string;
	readonly destroyed: string[];
	readonly progress: ProgressEvent[];
}

export interface YardClient {
	readonly planAuthoritatively: (
		bindle: ManifestV1,
		options: {
			deploymentId: string;
			session: YardSession;
			config?: DeployConfig;
		},
	) => Promise<PlanRendered>;
	readonly plan: (
		bindle: ManifestV1,
		options: { deploymentId: string; config?: DeployConfig },
	) => PlanRendered;
	readonly up: (
		bindle: ManifestV1,
		options: {
			deploymentId: string;
			session: YardSession;
			config?: DeployConfig;
		},
	) => Promise<UpResult>;
	readonly down: (
		bindle: ManifestV1,
		options: { deploymentId: string; session: YardSession },
	) => Promise<DownResult>;
}

function progressFrom(events: OrchestratorResult["events"]): ProgressEvent[] {
	const progress: ProgressEvent[] = [];
	for (const event of events) {
		if (
			!event.type.startsWith("exec.") &&
			!event.type.startsWith("resource.")
		) {
			continue;
		}
		// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
		const data = event.data as {
			resourceId?: string;
			summary?: string;
			reason?: string;
		};
		const resourceId = data.resourceId;
		const detail = data.summary ?? data.reason ?? event.type;
		progress.push(
			resourceId !== undefined
				? { type: event.type, resourceId, detail }
				: { type: event.type, detail },
		);
	}
	return progress;
}

interface PlanConfigInput {
	deploymentId: string;
	objective?: string;
	region?: string;
}

function planConfig(
	deploymentId: string,
	config?: DeployConfig,
): PlanConfigInput {
	return {
		deploymentId,
		...(config?.objective !== undefined
			? { objective: config.objective }
			: undefined),
		...(config?.region !== undefined ? { region: config.region } : undefined),
	};
}

export function createYardClient(runtime: YardRuntime): YardClient {
	const gatewayDeps: GatewayDeps = {
		store: runtime.store,
		actorHost: runtime.actorHost,
		registry: runtime.registry,
	};
	if (runtime.hostingBudgetAuthority)
		gatewayDeps.hostingBudgetAuthority = runtime.hostingBudgetAuthority;
	const orchestratorDeps: OrchestratorDeps = {
		store: runtime.store,
		actorHost: runtime.actorHost,
		executor: runtime.executor,
		broker: runtime.broker,
	};

	function pureplan(
		bindle: ManifestV1,
		deploymentId: string,
		config?: DeployConfig,
	): PlanResult {
		return planDeployment(
			bindle,
			planConfig(deploymentId, config),
			runtime.registry,
		);
	}

	return {
		async planAuthoritatively(bindle, { deploymentId, session, config }) {
			const budgetId = config?.budgetId ?? runtime.defaultHostingBudgetId;
			const authority = runtime.hostingBudgetAuthority;
			if (
				!budgetId ||
				!authority?.resolve ||
				authority.persistence !== "durable-cas"
			)
				return {
					ok: false,
					deploymentId,
					reason: "authoritative hosting budget is not configured",
					remediations: [],
				};
			const evidence = await authority.resolve({
				budgetId,
				tenantId: session.tenant,
				bindle,
				objective:
					config?.objective ??
					manifestHostingPolicy(bindle).budgetPolicy?.objective ??
					"min-cost",
			});
			if (
				evidence.budget.tenantId !== session.tenant ||
				evidence.budget.budgetId !== budgetId
			)
				throw new Error("hosting evidence belongs to another tenant or budget");
			const result = planDeployment(
				bindle,
				{ ...planConfig(deploymentId, config), hostingBudget: evidence },
				runtime.registry,
			);
			return result.ok
				? {
						ok: true,
						deploymentId,
						planHash: result.planHash,
						plan: result.plan,
						resources: result.plan.resources,
						dependencyOrder: result.plan.dependencyOrder,
					}
				: {
						ok: false,
						deploymentId,
						reason: result.reason,
						remediations: result.remediations,
					};
		},
		plan(bindle, { deploymentId, config }) {
			const result = pureplan(bindle, deploymentId, config);
			if (!result.ok) {
				return {
					ok: false,
					deploymentId,
					reason: result.reason,
					remediations: result.remediations,
				};
			}
			return {
				ok: true,
				deploymentId,
				planHash: result.planHash,
				plan: result.plan,
				resources: result.plan.resources,
				dependencyOrder: result.plan.dependencyOrder,
			};
		},

		async up(bindle, { deploymentId, session, config }) {
			const budgetId = config?.budgetId ?? runtime.defaultHostingBudgetId;
			const requiresHosting =
				runtime.hostingBudgetRequired === true ||
				budgetId !== undefined ||
				manifestHostingPolicy(bindle).required;
			if (requiresHosting && (!runtime.hostingExecution || !budgetId))
				return {
					status: "rejected",
					deploymentId,
					reason:
						"budgeted hosting requires a configured production supervisor and budget ID",
					remediations: [],
				};
			const context: GatewayContext = {
				tenant: session.tenant,
				actor: session.principal,
				correlationId: `deploy:${deploymentId}`,
			};
			const effectiveConfig = { ...config };
			if (budgetId) effectiveConfig.budgetId = budgetId;
			const deployResult: DeployResult = await deploy(
				gatewayDeps,
				{
					deploymentId,
					bindle,
					config: effectiveConfig,
				},
				context,
			);
			if (deployResult.status === "rejected") {
				return {
					status: "rejected",
					deploymentId,
					reason: deployResult.reason,
					remediations: deployResult.remediations,
				};
			}
			if (requiresHosting) {
				if (!deployResult.hostingReservationId || !runtime.hostingExecution)
					throw new Error(
						"budgeted plan has no authoritative reservation or supervisor",
					);
				return runtime.hostingExecution.up({
					admission: deployResult,
					session,
				});
			}

			const orchestrated = await runOrchestrator(
				orchestratorDeps,
				deployResult.plan,
				deploymentId,
				{
					tenant: session.tenant,
					actor: session.principal,
					correlationId: `deploy:${deploymentId}`,
				},
			);

			return {
				status: orchestrated.status,
				deploymentId,
				planHash: deployResult.planHash,
				plan: deployResult.plan,
				provisioned: orchestrated.provisioned,
				progress: progressFrom(orchestrated.events),
			};
		},

		async down(bindle, { deploymentId, session }) {
			const history = await collectStream(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			if (
				runtime.hostingBudgetRequired ||
				history.some((event) => event.type === "hosting.BudgetReserved") ||
				manifestHostingPolicy(bindle).required
			) {
				if (!runtime.hostingExecution)
					return {
						status: "needs-human",
						deploymentId,
						destroyed: [],
						progress: [],
					};
				return runtime.hostingExecution.down({ deploymentId, session, bindle });
			}
			const planResult = pureplan(bindle, deploymentId);
			if (!planResult.ok) {
				return {
					status: "needs-human",
					deploymentId,
					destroyed: [],
					progress: [],
				};
			}
			const deploymentPlan = planResult.plan;
			const first = deploymentPlan.resources[0];
			const compensation = await runCompensation(
				orchestratorDeps,
				deploymentPlan,
				deploymentId,
				{
					resourceId: first?.name ?? deploymentId,
					reason: "operator-requested teardown",
				},
				{
					tenant: session.tenant,
					actor: session.principal,
					correlationId: `down:${deploymentId}`,
				},
			);
			const events = await collectStream(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			return {
				status:
					compensation.status === "rolled-back" ? "destroyed" : "needs-human",
				deploymentId,
				destroyed: compensation.destroyedOrder,
				progress: progressFrom(events),
			};
		},
	};
}
