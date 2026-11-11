/**
 * Postgres schema of the Vercel deployment's own state: the marker table the
 * repair path uses to prove two connection strings reach the same database, and
 * the worker liveness evidence shared by function instances.
 *
 * This module is the declared source of the `hobo_ci_*` tables this package
 * owns. It is an authoring surface only (ADR-0160): `@hobo/adapter-drizzle`
 * ingests it into the canonical schema IR, core's differ produces the phased
 * migration plan, and drizzle-kit renders the SQL checked in under
 * `db/migrations/`. Nothing on the request path imports it.
 */

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** `verifyRepairDatabase`: a committed random marker, pruned after a day. */
export const databaseProbes = pgTable("hobo_ci_database_probes", {
	id: uuid("id").primaryKey(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/** `PostgresWorkerHealth`: last success and failure per worker component. */
export const workerHealth = pgTable("hobo_ci_worker_health", {
	component: text("component").primaryKey(),
	successAt: timestamp("success_at", { withTimezone: true }),
	failureAt: timestamp("failure_at", { withTimezone: true }),
});
