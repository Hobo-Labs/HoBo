/**
 * Where `@hobo/ci`'s schema lives and how its embedded DDL is run.
 *
 * `PostgresCiStore.initialize` is still what creates these tables in
 * production. The tooling reads its DDL from `src/`, and runs it through
 * `initializeEmbedded` against a scratch database, to prove the migrations
 * match it.
 */

import { PostgresCiStore } from "../src/postgres-store.js";
import type { RelaySchemaSource } from "./tooling/index.js";

export const schemaSource: RelaySchemaSource = {
	scope: "@hobo/ci",
	// The lock `PostgresCiStore.initialize` serialises its DDL under.
	advisoryLocks: ["hobo-ci-schema-v2"],
	packageRoot: new URL("../", import.meta.url),
	directory: new URL("./migrations/", import.meta.url),
	loadSchema: () => import("./schema.js"),
	initializeEmbedded: async (pool) => {
		await new PostgresCiStore(pool, "default").initialize();
	},
};
