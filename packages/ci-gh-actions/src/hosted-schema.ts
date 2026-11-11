import type { Pool } from "pg";
import { PostgresAppRegistration } from "./app-registration-postgres.js";
import { PostgresGithubOAuthSessionStore } from "./github-oauth-session-postgres.js";
import { PostgresAppBootstrapStore } from "./hosted-app-bootstrap.js";
import { PostgresQueuedJobRepairClaims } from "./queued-job-repair.js";
import { PostgresWebhookRepairClaims } from "./webhook-repair.js";

/** `@hobo/ci-gh-actions`'s checked-in migrations: the tables of the hosted
 * relay's GitHub stores. A host applies them, with `applyMigrations` from
 * `@hobo/ci/schema-migrations`, to a database the stores themselves never
 * initialise: a standby that only receives copies. */
export { schemaMigrations as hostedRelaySchemaMigrations } from "./_generated-assets/schema-migrations.js";

/** Create every table the hosted relay's GitHub stores use, by running the
 * stores' own initialisers. Each store creates its own tables on first use;
 * this runs them up front on the database the relay writes to, and it is how
 * a database from an earlier release is brought forward to today's layout.
 * It is not for a standby: the initialisers are the application's, and a
 * standby gets its schema from `hostedRelaySchemaMigrations`.
 *
 * The stores that encrypt take a key and the scanner takes an App id, but
 * creating tables uses neither, so placeholders are passed and never used. */
export async function initializeHostedRelaySchema(pool: Pool): Promise<void> {
	const unusedKey = new Uint8Array(32);
	await new PostgresAppRegistration(pool, unusedKey).initialize();
	await new PostgresGithubOAuthSessionStore(pool, unusedKey).initialize();
	await new PostgresAppBootstrapStore(pool).initialize();
	await new PostgresWebhookRepairClaims(pool).initialize();
	await new PostgresQueuedJobRepairClaims(pool, "1").initialize();
}
