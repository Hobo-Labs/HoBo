import type { Pool } from "pg";
import { PostgresAppRegistration } from "./app-registration-postgres.js";
import { PostgresGithubOAuthSessionStore } from "./github-oauth-session-postgres.js";
import { PostgresAppBootstrapStore } from "./hosted-app-bootstrap.js";
import { PostgresQueuedJobRepairClaims } from "./queued-job-repair.js";
import { PostgresWebhookRepairClaims } from "./webhook-repair.js";

/** Create every table the hosted relay's GitHub stores use, without storing
 * anything. Each store creates its own tables on first use; this runs those
 * same initialisers up front, so a database that is not serving traffic (a
 * standby that receives copies) has the schema the serving one has.
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
