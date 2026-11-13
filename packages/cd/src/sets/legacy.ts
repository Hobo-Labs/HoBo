// Legacy fold (C1): estates deployed before @hobo/cd recorded
// `deployment.Requested/Planned/Deployed/RolledBack` on `deployment:<id>`
// streams. They are folded into a Set with SET_ORIGIN_LEGACY_FOLD so every
// estate has a current Set and a single desired-state lane.
import {
	CLOUD_EVENTS,
	type DeploymentPlan,
	type MatchSelection,
} from "@hobo/cloud";
import type { EventEnvelope } from "@hobo/core";
import { isJsonObject, member, textMember } from "./json.js";

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

const field = member;
const text = textMember;

function isPlan<T>(value: T): value is T & DeploymentPlan {
	return (
		isJsonObject(value) &&
		Array.isArray(member(value, "resources")) &&
		Array.isArray(member(value, "dependencyOrder")) &&
		textMember(value, "schema") !== undefined
	);
}

/** Pure fold of one legacy deployment stream; undefined when it never planned. */
export function foldLegacyDeployment(
	events: readonly EventEnvelope[],
): LegacyDeployment | undefined {
	let deploymentId: string | undefined;
	let tenant: string | undefined;
	let campId: string | undefined;
	let environment = "default";
	let plan: DeploymentPlan | undefined;
	let planSeq = 0;
	let plannedAt = "";
	let state: LegacyDeployment["state"] = "planned";
	let deployedAtSeq: number | undefined;
	// The plan in effect at the last Deployed: a later Planned that was never
	// deployed must not be folded as the deployed estate.
	let deployed:
		| { plan: DeploymentPlan; planSeq: number; plannedAt: string }
		| undefined;
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
				if (plan !== undefined) {
					state = "deployed";
					deployedAtSeq = event.seq;
					deployed = { plan, planSeq, plannedAt };
				}
				break;
			case LEGACY_EVENTS.rolledBack:
				state = "rolled-back";
				deployedAtSeq = undefined;
				deployed = undefined;
				break;
			default:
				break;
		}
	}
	if (plan === undefined || deploymentId === undefined) return undefined;
	if (state === "deployed" && deployed !== undefined)
		({ plan, planSeq, plannedAt } = deployed);
	const ordered = plan.resources.flatMap((resource) => {
		const match = matches.get(resource.name);
		return match === undefined ? [] : [match];
	});
	const folded = {
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
	};
	const result: LegacyDeployment =
		deployedAtSeq === undefined ? folded : { ...folded, deployedAtSeq };
	return Object.freeze(result);
}
