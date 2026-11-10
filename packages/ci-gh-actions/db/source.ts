/**
 * Where `@hobo/ci-gh-actions`'s schema lives and how its embedded DDL is run.
 *
 * Five stores still create these tables from their own `initialize`. The
 * tooling reads their DDL from `src/`, and runs it through `initializeEmbedded`
 * against a scratch database, to prove the migrations match it.
 */

import { randomBytes } from "node:crypto";
import type { RelaySchemaSource } from "../../ci/db/tooling/index.js";
import { PostgresAppRegistration } from "../src/app-registration-postgres.js";
import { PostgresGithubOAuthSessionStore } from "../src/github-oauth-session-postgres.js";
import { PostgresAppBootstrapStore } from "../src/hosted-app-bootstrap.js";
import { PostgresQueuedJobRepairClaims } from "../src/queued-job-repair.js";
import { PostgresWebhookRepairClaims } from "../src/webhook-repair.js";

export const schemaSource: RelaySchemaSource = {
	scope: "@hobo/ci-gh-actions",
	// The locks the transactional initialisers serialise their DDL under. The
	// repair stores take none.
	advisoryLocks: [
		"hobo-ci-app-registration-v1",
		"hobo-ci-oauth-session-v1",
		"hobo-ci-platform-app-v1",
	],
	packageRoot: new URL("../", import.meta.url),
	directory: new URL("./migrations/", import.meta.url),
	loadSchema: () => import("./schema.js"),
	initializeEmbedded: async (pool) => {
		// The encryption keys only gate construction; initialisation is DDL.
		await new PostgresAppRegistration(pool, randomBytes(32)).initialize();
		await new PostgresGithubOAuthSessionStore(
			pool,
			randomBytes(32),
		).initialize();
		await new PostgresAppBootstrapStore(pool).initialize();
		await new PostgresQueuedJobRepairClaims(pool, "1").initialize();
		await new PostgresWebhookRepairClaims(pool).initialize();
	},
};
