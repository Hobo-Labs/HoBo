/**
 * Contract-asserted Trail fixtures for hobo dev (ADR-0070 fidelity).
 */

import { createContractAssertedDataDualFixtures } from "./data-steps.js";
import { defineTrail } from "./definition.js";
import {
	createHandsOffIdentityTrail,
	type IdentityTrailHandle,
} from "./identity-trail.js";
import { PLATFORM_RECIPES } from "./recipes.js";
import { TrailRunner } from "./runner.js";

export type LocalTrailFixtures = Readonly<{
	identity: IdentityTrailHandle;
	/** App-authored data + identity composition example. */
	appTrail: ReturnType<typeof defineTrail>;
	runner: TrailRunner;
	label: "contract-asserted-trail-fixtures";
	fidelity: "simulated";
}>;

/**
 * Offline fixtures: continuous identity hands-off + sample app data Trail.
 */
export function createContractAssertedTrailFixtures(input?: {
	readonly tenant?: string;
	readonly target?: string;
}): LocalTrailFixtures {
	const tenant = input?.tenant ?? "tenant-dev";
	const target = input?.target ?? "local-dev";
	const identity = createHandsOffIdentityTrail({ tenant });
	const appTrail = defineTrail({
		id: "app.checkout.migrate",
		version: "2026.07.27.1",
		description: "Checkout schema expand + data dual + identity continuous",
		targets: [target],
		recipeList: [
			PLATFORM_RECIPES.IdentityContinuous,
			PLATFORM_RECIPES.ValidationOracle,
			PLATFORM_RECIPES.CutoverGate,
		],
		steps: [
			{
				id: "schema-v1",
				kind: "schema",
				schema: {
					mode: "expand-contract",
					version: "2026072701",
					sql: "ALTER TABLE checkout ADD COLUMN tip_cents INT DEFAULT 0",
				},
				progressive: true,
			},
			{
				id: "data-dual",
				kind: "continuous-dual-data",
				dependsOn: ["schema-v1"],
				data: {
					mode: "cdc-dual",
					transformId: "checkout.tip-backfill",
					checksum:
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
				progressive: true,
			},
		],
	});
	const runner = new TrailRunner({
		tenant,
		target,
		dataFixture: createContractAssertedDataDualFixtures(),
		dualOracleReady: true,
		junctionHealthy: true,
	});
	return Object.freeze({
		identity,
		appTrail,
		runner,
		label: "contract-asserted-trail-fixtures",
		fidelity: "simulated",
	});
}
