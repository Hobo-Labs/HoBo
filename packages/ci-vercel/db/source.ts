/**
 * Where `@hobo/ci-vercel`'s schema lives and how its embedded DDL is run.
 *
 * The probe table is created by `verifyRepairDatabase` on its way to comparing
 * two connections, the health table by `PostgresWorkerHealth.initialize`, and
 * the store selection marker by `ensureStoreSelectionTable`. The tooling reads
 * their DDL from `src/`, and runs all three through `initializeEmbedded`
 * against a scratch database, to prove the migrations match it.
 */

import type { RelaySchemaSource } from "../../ci/db/tooling/index.js";
import { verifyRepairDatabase } from "../src/database-connections.js";
import { pgExecutor } from "../src/database-fleet-executor.js";
import {
	ensureStoreSelectionTable,
	STORE_SELECTION_LOCK,
} from "../src/database-selection-marker.js";
import { PostgresWorkerHealth } from "../src/worker-health.js";

export const schemaSource: RelaySchemaSource = {
	scope: "@hobo/ci-vercel",
	// The locks `verifyRepairDatabase` and store selection create their
	// tables under. The health store takes none.
	advisoryLocks: ["hobo-ci-database-probe-v1", STORE_SELECTION_LOCK],
	packageRoot: new URL("../", import.meta.url),
	directory: new URL("./migrations/", import.meta.url),
	loadSchema: () => import("./schema.js"),
	loadShipped: () => import("../src/_generated-assets/schema-migrations.js"),
	initializeEmbedded: async (pool) => {
		// Both arguments are the same database, so the probe succeeds and
		// removes its own marker row.
		await verifyRepairDatabase(pool, pool);
		await new PostgresWorkerHealth(pool).initialize();
		await ensureStoreSelectionTable(pgExecutor(pool));
	},
};
