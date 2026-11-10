import { createBootstrapEntry } from "./bootstrap-entry.js";
import { createVercelApplication } from "./composition.js";
import type { RelayDatabase } from "./database-connections.js";
import { createDatabaseFleet } from "./database-fleet.js";
import { parseDatabaseFleet } from "./database-fleet-config.js";

type RelayOptions = {
	env: NodeJS.ProcessEnv;
	notify: (deliveryId: string) => Promise<void>;
	continueRepair: () => Promise<void>;
	scheduledRepair: () => Promise<void>;
	expectedGithubOwnerId?: number;
};

/** Compose the relay for this environment.
 *
 * Without `HOBO_CI_DATABASE_BACKENDS` this is the single-database relay,
 * exactly as before: bootstrap mode when a bootstrap token is configured, the
 * full application otherwise. With one backend listed it is the same relay on
 * that backend. With more than one, the same application runs behind the
 * database fleet, on whichever backend is the writer. */
export function composeRelay(options: RelayOptions) {
	const { env } = options;
	const fleet = parseDatabaseFleet(env);
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
	if (!fleet) return build();
	const [only] = fleet.backends;
	if (fleet.backends.length === 1 && only) return build(only.database);
	return createDatabaseFleet({
		env,
		config: fleet,
		build: async (database) => build(database),
		scheduledRepair: options.scheduledRepair,
	});
}
