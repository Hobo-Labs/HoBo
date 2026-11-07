import { canonicalManifestHash, type ManifestV1 } from "@hobo/bindles";
import { canonicalJson } from "@hobo/contracts";
import type {
	EventEnvelope,
	EventInput,
	EventStore,
	PrincipalRef,
} from "@hobo/core";
import type { ActorHost, JsonObject } from "@hobo/data";
import {
	type Aggregate,
	AggregateInvariantError,
	defineAggregate,
} from "@hobo/data";
import { emit } from "@hobo/events";
import {
	deploymentPlanned,
	deploymentPlanRejected,
	deploymentRequested,
	matchDecided,
} from "../events.js";
import type { SharedHostingBudgetAuthority } from "../hosting-transition/budget-authority.js";
import { isJsonObject, isJsonString } from "../json.js";
import type {
	DeploymentPlan,
	MatchDecided,
	PlanRemediation,
} from "../plan-types.js";
import { manifestHostingPolicy } from "../planner/hosting-budget.js";
import type { PlanResult } from "../planner/plan.js";
import { type PlanConfig, plan } from "../planner/plan.js";
import type { PlannerRegistry } from "../registry/catalog.js";

// The Gateway (control-plane.md "Services"): command ingress. It authenticates
// the principal, authorizes against tenant + scope, turns a command into events,
// and serves read models. Commands are never stored — only past-tense facts are
// appended (control-plane.md "Command / event API surface"). Stateless.

export interface DeployCommand {
	deploymentId: string;
	bindle: ManifestV1;
	config?: { objective?: string; region?: string; budgetId?: string };
}

export interface GatewayContext {
	tenant: string;
	actor: PrincipalRef;
	correlationId?: string;
}

export interface GatewayDeps {
	store: EventStore;
	actorHost: ActorHost;
	registry: PlannerRegistry;
	/** Trusted snapshot/quote resolution and durable shared-budget admission. */
	hostingBudgetAuthority?: SharedHostingBudgetAuthority;
}

export interface AuthzResult {
	allowed: boolean;
	reason?: string;
}

export class UnauthorizedCommandError extends Error {
	readonly code = "gateway.unauthorized";
	constructor(reason: string) {
		super(reason);
		this.name = "UnauthorizedCommandError";
	}
}

// Stubbed authorization (S2-01 scope): only attributable principals may issue
// deploy commands. Full tenant/scope enforcement is S3 (MCP auth).
export function authorize(actor: PrincipalRef): AuthzResult {
	if (
		!actor ||
		Object.prototype.toString.call(actor.id) !== "[object String]" ||
		actor.id.length === 0
	) {
		return { allowed: false, reason: "missing principal" };
	}
	if (actor.kind === "system") {
		return { allowed: false, reason: "system principals may not issue Deploy" };
	}
	return { allowed: true };
}

interface DeploymentState {
	requested: boolean;
}

// The write-model aggregate behind the deployment stream: a single-writer actor
// (ActorHost lease + fencing) whose only invariant is idempotent request-once.
const deploymentAggregate: Aggregate<
	DeploymentState,
	DeployCommand & { bindleHash: string; tenant: string }
> = defineAggregate<
	DeploymentState,
	DeployCommand & { bindleHash: string; tenant: string }
>({
	name: "deployment",
	initialState: { requested: false },
	evolve: (state, event) =>
		event.type === "deployment.Requested" ? { requested: true } : state,
	decide: (state, command, emitter) => {
		if (state.requested) {
			throw new AggregateInvariantError(
				`deployment ${command.deploymentId} already requested`,
			);
		}
		const requested = deploymentRequested({
			deploymentId: command.deploymentId,
			bindleHash: command.bindleHash,
			tenant: command.tenant,
			config: command.config ?? {},
		});
		// SAFETY: DeploymentRequested payload is JSON event data.
		emitter.emit("deployment.Requested", requested.data as JsonObject);
	},
});

export interface DeployResultPlanned {
	status: "planned";
	streamId: string;
	deploymentId: string;
	seq: number;
	planHash: string;
	plan: DeploymentPlan;
	decisions: MatchDecided[];
	hostingReservationId?: string;
}

export interface DeployResultRejected {
	status: "rejected";
	streamId: string;
	deploymentId: string;
	seq: number;
	reason: string;
	remediations: PlanRemediation[];
}

export type DeployResult = DeployResultPlanned | DeployResultRejected;

export function deploymentStreamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

export async function deploy(
	deps: GatewayDeps,
	command: DeployCommand,
	context: GatewayContext,
): Promise<DeployResult> {
	const authz = authorize(context.actor);
	if (!authz.allowed) {
		throw new UnauthorizedCommandError(authz.reason ?? "unauthorized");
	}

	const streamId = deploymentStreamId(command.deploymentId);
	const bindleHash = canonicalManifestHash(command.bindle);
	const prior: EventEnvelope[] = [];
	for await (const event of deps.store.read(streamId)) prior.push(event);
	const original = prior.find((event) => event.type === "deployment.Requested");
	if (original && isJsonObject(original.data)) {
		if (original.data.tenant !== context.tenant)
			throw new UnauthorizedCommandError(
				"deployment belongs to a different tenant",
			);
		if (
			original.data.bindleHash !== bindleHash ||
			canonicalJson(original.data.config ?? {}) !==
				canonicalJson(command.config ?? {})
		)
			throw new AggregateInvariantError(
				"deployment ID was already bound to different input",
			);
		const completed = [...prior]
			.reverse()
			.find(
				(event) =>
					event.type === "deployment.Planned" ||
					event.type === "deployment.PlanRejected",
			);
		if (completed && isJsonObject(completed.data)) {
			if (completed.type === "deployment.Planned") {
				// SAFETY: this writer's durable event carries the previously typed plan.
				const data = (
					completed as EventEnvelope<{ plan: DeploymentPlan; planHash: string }>
				).data;
				const decisions = prior
					.filter((event) => event.type === "match.Decided")
					.map((event) => {
						// SAFETY: match.Decided was emitted by the pure planner on this stream.
						return event.data as MatchDecided;
					});
				const reservation = prior.find(
					(event) => event.type === "hosting.BudgetReserved",
				);
				const reservationId =
					reservation && isJsonObject(reservation.data)
						? reservation.data.reservationId
						: undefined;
				const replay: DeployResultPlanned = {
					status: "planned",
					streamId,
					deploymentId: command.deploymentId,
					seq: completed.seq,
					plan: data.plan,
					planHash: data.planHash,
					decisions,
				};
				if (isJsonString(reservationId))
					replay.hostingReservationId = reservationId;
				return replay;
			}
			// SAFETY: deployment.PlanRejected was produced by this gateway.
			const rejected = (
				completed as EventEnvelope<{
					reason: string;
					remediations: PlanRemediation[];
				}>
			).data;
			return {
				status: "rejected",
				streamId,
				deploymentId: command.deploymentId,
				seq: completed.seq,
				...rejected,
			};
		}
		throw new AggregateInvariantError(
			"deployment is pending; reconcile its recorded effects before retrying admission",
		);
	}

	// 1. Command -> fact: append deployment.Requested under the single-writer lease.
	const requested = await deploymentAggregate.execute(
		{ store: deps.store, actorHost: deps.actorHost },
		streamId,
		{ ...command, bindleHash, tenant: context.tenant },
		{
			tenant: context.tenant,
			actor: context.actor,
			...(context.correlationId !== undefined
				? { correlationId: context.correlationId }
				: undefined),
		},
	);

	// 2. Run the pure Planner and append its facts (choreography fan-out path).
	const planConfig: PlanConfig = { deploymentId: command.deploymentId };
	if (command.config?.objective !== undefined)
		planConfig.objective = command.config.objective;
	if (command.config?.region !== undefined)
		planConfig.region = command.config.region;

	let outcome: PlanResult;
	let hostingReservationId: string | undefined;
	const budgetId = command.config?.budgetId;
	if (budgetId !== undefined) {
		const authority = deps.hostingBudgetAuthority;
		if (!authority?.resolve || authority.persistence !== "durable-cas") {
			outcome = admissionRejected(
				command.deploymentId,
				"budget.authority-required",
				"budget-aware deployment requires a durable shared authority with trusted quote resolution",
			);
		} else {
			const input = await authority.resolve({
				budgetId,
				tenantId: context.tenant,
				bindle: command.bindle,
				objective:
					planConfig.objective ??
					manifestHostingPolicy(command.bindle).budgetPolicy?.objective ??
					"min-cost",
			});
			if (
				input.budget.budgetId !== budgetId ||
				input.budget.tenantId !== context.tenant
			)
				outcome = admissionRejected(
					command.deploymentId,
					"budget.scope-mismatch",
					"resolved budget belongs to a different requested scope or tenant",
				);
			else {
				planConfig.hostingBudget = input;
				outcome = plan(command.bindle, planConfig, deps.registry);
				if (outcome.ok && outcome.hostingCommitment) {
					const reservationId = `hosting:${context.tenant}:${command.deploymentId}`;
					const reserved = await authority.reserve({
						reservationId,
						planHash: outcome.planHash,
						commitment: outcome.hostingCommitment,
					});
					if (!reserved.ok)
						outcome = admissionRejected(
							command.deploymentId,
							"budget.reservation-denied",
							reserved.reason,
						);
					else hostingReservationId = reserved.reservationId;
				}
			}
		}
	} else outcome = plan(command.bindle, planConfig, deps.registry);

	const facts: EventInput[] = [];
	if (outcome.ok) {
		if (hostingReservationId && outcome.hostingCommitment)
			facts.push({
				type: "hosting.BudgetReserved",
				data: {
					deploymentId: command.deploymentId,
					reservationId: hostingReservationId,
					commitment: outcome.hostingCommitment,
				},
			});
		for (const decision of outcome.decisions)
			facts.push(matchDecided(decision));
		facts.push(
			deploymentPlanned({
				deploymentId: command.deploymentId,
				planHash: outcome.planHash,
				plan: outcome.plan,
			}),
		);
	} else {
		facts.push(
			deploymentPlanRejected({
				deploymentId: command.deploymentId,
				reason: outcome.reason,
				remediations: outcome.remediations,
			}),
		);
	}

	// The aggregate append fenced the stream (owner_epoch = lease fence); the
	// choreography fan-out below is the same logical writer, so it continues
	// under the same fencing token instead of bypassing the fence.
	const emitted = await emit(deps.store, streamId, facts, {
		expectedSeq: requested.seq,
		actor: context.actor,
		tenant: context.tenant,
		fenceToken: requested.fenceToken,
		...(context.correlationId !== undefined
			? { correlationId: context.correlationId }
			: undefined),
	});

	if (outcome.ok) {
		const result: DeployResultPlanned = {
			status: "planned",
			streamId,
			deploymentId: command.deploymentId,
			seq: emitted.seq,
			planHash: outcome.planHash,
			plan: outcome.plan,
			decisions: outcome.decisions,
		};
		if (hostingReservationId)
			result.hostingReservationId = hostingReservationId;
		return result;
	}
	return {
		status: "rejected",
		streamId,
		deploymentId: command.deploymentId,
		seq: emitted.seq,
		reason: outcome.reason,
		remediations: outcome.remediations,
	};
}

function admissionRejected(
	deploymentId: string,
	code: string,
	reason: string,
): PlanResult {
	return {
		ok: false,
		deploymentId,
		reason,
		remediations: [
			{
				resource: "*",
				code,
				requiredPort: "*",
				requiredFeatures: [],
				missing: [],
				remediation: reason,
			},
		],
	};
}
