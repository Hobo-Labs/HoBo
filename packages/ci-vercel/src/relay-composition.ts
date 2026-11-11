import { createBootstrapEntry } from "./bootstrap-entry.js";
import { createVercelApplication } from "./composition.js";
import type { RelayDatabase } from "./database-connections.js";
import { createDatabaseFleet } from "./database-fleet.js";
import {
	type DatabaseFleetConfig,
	parseDatabaseFleet,
} from "./database-fleet-config.js";
import {
	createSelectedRelay,
	type SelectableStore,
	selectableStores,
} from "./database-selection-relay.js";

type RelayOptions = {
	env: NodeJS.ProcessEnv;
	notify: (deliveryId: string) => Promise<void>;
	continueRepair: () => Promise<void>;
	scheduledRepair: () => Promise<void>;
	expectedGithubOwnerId?: number;
};

/** Which databases the relay runs on, and who decides. */
export type RelayStorePlan =
	/** The one database the environment names, as before. */
	| { kind: "environment" }
	/** Several attached stores and nothing that says which: the relay chooses. */
	| { kind: "selection"; stores: SelectableStore[] }
	/** `HOBO_CI_DATABASE_BACKENDS`: one listed backend, or the fleet. */
	| { kind: "fleet"; config: DatabaseFleetConfig };

/** Read the plan from the environment alone. Nothing is dialled here, so the
 * answer is the same on every instance of a deployment. */
export function planRelayStore(env: NodeJS.ProcessEnv): RelayStorePlan {
	const config = parseDatabaseFleet(env);
	if (config) return { kind: "fleet", config };
	if (env.HOBO_CI_DATABASE_ENV_PREFIX) return { kind: "environment" };
	const stores = selectableStores(env);
	return stores.length < 2
		? { kind: "environment" }
		: { kind: "selection", stores };
}

/** Compose the relay for this environment.
 *
 * Without `HOBO_CI_DATABASE_BACKENDS` this is the single-database relay:
 * bootstrap mode when a bootstrap token is configured, the full application
 * otherwise. Which database that is:
 *
 * - `HOBO_CI_DATABASE_ENV_PREFIX` set, or at most one database attached that
 *   the relay could run on: the one the environment names, exactly as before.
 *   Nothing is probed and no marker is written.
 * - Otherwise more than one store is attached and nobody said which to use,
 *   so the relay chooses (`database-selection.ts`) and the same application
 *   runs on the chosen store.
 *
 * With one backend listed in `HOBO_CI_DATABASE_BACKENDS` it is the same relay
 * on that backend. With more than one, the same application runs behind the
 * database fleet, on whichever backend is the writer. */
export function composeRelay(options: RelayOptions) {
	const { env } = options;
	const build = (database?: RelayDatabase) => {
		const resolved: Parameters<typeof createBootstrapEntry>[0] = {
			env,
			notify: options.notify,
			continueRepair: options.continueRepair,
			scheduledRepair: options.scheduledRepair,
		};
		if (database) resolved.database = database;
		if (!env.HOBO_CI_BOOTSTRAP_TOKEN_SHA256)
			return createVercelApplication(resolved);
		if (options.expectedGithubOwnerId)
			resolved.expectedGithubOwnerId = options.expectedGithubOwnerId;
		return createBootstrapEntry(resolved);
	};
	const plan = planRelayStore(env);
	if (plan.kind === "environment") return build();
	if (plan.kind === "selection")
		return createSelectedRelay({
			env,
			stores: plan.stores,
			build: async (database) => build(database),
		});
	const [only] = plan.config.backends;
	if (plan.config.backends.length === 1 && only) return build(only.database);
	return createDatabaseFleet({
		env,
		config: plan.config,
		build: async (database) => build(database),
		scheduledRepair: options.scheduledRepair,
	});
}
