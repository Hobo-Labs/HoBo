/**
 * Contract-asserted CD fixtures for hobo dev / offline path (ADR-0042 / 0070).
 */
import { DEPLOYMENT_PLAN_SCHEMA, type DeploymentPlan } from "../plan-types.js";
import { createContinuousDeliveryPlane } from "./cd-plane.js";
import { createResolvedDeploymentSet } from "./resolved-set.js";

export type LocalCdFixtures = Readonly<{
	set: ReturnType<typeof createResolvedDeploymentSet>;
	plane: ReturnType<typeof createContinuousDeliveryPlane>;
	label: "contract-asserted-cd-fixtures";
	fidelity: "simulated";
}>;

export function createContractAssertedCdFixtures(input?: {
	readonly tenant?: string;
	readonly environment?: string;
}): LocalCdFixtures {
	const tenant = input?.tenant ?? "tenant-dev";
	const environment = input?.environment ?? "local-dev";
	const plan = {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: [
			{
				name: "web",
				port: "hobo:web-app",
				provider: "local-host",
				// SAFETY: `deps: [] as string[],` is required at this I/O or test boundary.
				deps: [] as string[],
			},
			{
				name: "api",
				port: "hobo:http-service",
				provider: "local-host",
				deps: ["web"],
			},
		],
		dependencyOrder: ["web", "api"],
		objective: "min-cost",
	} satisfies DeploymentPlan;
	const set = createResolvedDeploymentSet({
		tenant,
		environment,
		campId: "camp-local",
		plan,
		matches: [
			{
				resource: "web",
				providerId: "local-host",
				port: "hobo:web-app",
				rationale: "local fixture match",
			},
			{
				resource: "api",
				providerId: "local-host",
				port: "hobo:http-service",
				rationale: "local fixture match",
			},
		],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "gk_fixture_local",
			obligations: ["require-canary"],
			decidedAt: new Date().toISOString(),
		},
		secretRefs: ["secretRef:fixture:db"],
		progressive: {
			flag: "fixture-feature",
			stages: [10, 100],
			traffic: "gateway-weighted",
			autoRollback: true,
		},
	});
	const plane = createContinuousDeliveryPlane({ mode: "simulate" });
	return Object.freeze({
		set,
		plane,
		label: "contract-asserted-cd-fixtures",
		fidelity: "simulated",
	});
}
