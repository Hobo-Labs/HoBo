// Legacy fold (C1): estates deployed before @hobo/cd recorded
// `deployment.Requested/Planned/Deployed/RolledBack` on `deployment:<id>`
// streams. They are folded into a Set with SET_ORIGIN_LEGACY_FOLD so every
// estate has a current Set and a single desired-state lane.
import { CLOUD_EVENTS, type DeploymentPlan, type MatchSelection } from "@hobo/cloud";
import type { EventEnvelope } from "@hobo/core";

// public-contract: the legacy event types this module folds (owned by @hobo/cloud).
export const LEGACY_EVENTS = Object.freeze({
	requested: CLOUD_EVENTS.DeploymentRequested,
	matchDecided: CLOUD_EVENTS.MatchDecided,
	planned: CLOUD_EVENTS.DeploymentPlanned,
	deployed: CLOUD_EVENTS.DeploymentDeployed,
	rolledBack: CLOUD_EVENTS.DeploymentRolledBack,
} as const);

export type LegacyDeployment = Readonly<{
	streamId: string;
	deploymentId: string;
	tenant: string;
	/** `config.campId` when the deployment recorded one, else the deployment id. */
	campId: string;
	environment: string;
	plan: DeploymentPlan;
	planSeq: number;
	plannedAt: string;
	matches: readonly MatchSelection[];
	state: "planned" | "deployed" | "rolled-back";
	deployedAtSeq?: number;
}>;

const tagOf = Object.prototype.toString;

function field(data: unknown, key: string): unknown {
	if (data === null || typeof data !== "object") return undefined;
	return (data as Readonly<Record<string, unknown>>)[key];
}

function text(data: unknown, key: string): string | undefined {
	const value = field(data, key);
	return tagOf.call(value) === "[object String]" && value !== "" ? String(value) : undefined;
}

function isPlan(value: unknown): value is DeploymentPlan {
	return (
		value !== null &&
		typeof value === "object" &&
		Array.isArray(field(value, "resources")) &&
		Array.isArray(field(value, "dependencyOrder")) &&
		text(value, "schema") !== undefined
	);
}

/** Pure fold of one legacy deployment stream; undefined when it never planned. */
export function foldLegacyDeployment(events: readonly EventEnvelope[]): LegacyDeployment | undefined {
	let deploymentId: string | undefined;
	let tenant: string | undefined;
	let campId: string | undefined;
	let environment = "default";
	let plan: DeploymentPlan | undefined;
	let planSeq = 0;
	let plannedAt = "";
	let state: LegacyDeployment["state"] = "planned";
	let deployedAtSeq: number | undefined;
	const matches = new Map<string, MatchSelection>();
	let streamId = "";
	for (const event of events) {
		streamId = event.streamId;
		deploymentId ??= text(event.data, "deploymentId");
		switch (event.type) {
			case LEGACY_EVENTS.requested: {
				tenant = text(event.data, "tenant") ?? event.tenant;
				const config = field(event.data, "config");
				campId = text(config, "campId") ?? campId;
				environment = text(config, "environment") ?? environment;
				break;
			}
			case LEGACY_EVENTS.matchDecided: {
				const resource = text(event.data, "resource");
				const providerId = text(event.data, "providerId");
				if (resource !== undefined && providerId !== undefined) {
					matches.set(resource, {
						resource,
						providerId,
						port: text(event.data, "port") ?? "",
						rationale: text(event.data, "rationale") ?? "",
					});
				}
				break;
			}
			case LEGACY_EVENTS.planned: {
				const candidate = field(event.data, "plan");
				if (isPlan(candidate)) {
					plan = candidate;
					planSeq = event.seq;
					plannedAt = event.ts;
				}
				break;
			}
			case LEGACY_EVENTS.deployed:
				state = "deployed";
				deployedAtSeq = event.seq;
				break;
			case LEGACY_EVENTS.rolledBack:
				state = "rolled-back";
				deployedAtSeq = undefined;
				break;
			default:
				break;
		}
	}
	if (plan === undefined || deploymentId === undefined) return undefined;
	const ordered = plan.resources.flatMap((resource) => {
		const match = matches.get(resource.name);
		return match === undefined ? [] : [match];
	});
	return Object.freeze({
		streamId,
		deploymentId,
		tenant: tenant ?? events[0]?.tenant ?? "",
		campId: campId ?? deploymentId,
		environment,
		plan,
		planSeq,
		plannedAt,
		matches: Object.freeze(ordered),
		state,
		...(deployedAtSeq !== undefined ? { deployedAtSeq } : {}),
	});
}
