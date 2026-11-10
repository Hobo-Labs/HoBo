/**
 * Postgres schema of the native CI journal (`PostgresCiStore`).
 *
 * This module is the declared source of the `hobo_ci_*` tables the store owns.
 * It is an authoring surface only (ADR-0160): `@hobo/adapter-drizzle` ingests
 * it into the canonical schema IR, core's differ turns that into the phased
 * migration plan, and drizzle-kit renders the SQL checked in under
 * `db/migrations/`. Nothing on the request path imports it; the store keeps
 * its hand-written SQL through `pg`.
 *
 * Constraint and index names are spelled out wherever PostgreSQL would have
 * derived one, because the names are part of what an existing database already
 * holds and the migration must converge on them rather than rename them.
 */

import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	customType,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/** drizzle-orm ships no `bytea` column; the SQL type is all the schema needs. */
const bytea = customType<{ data: Buffer }>({
	dataType: () => "bytea",
});

export const partitions = pgTable(
	"hobo_ci_partitions",
	{
		id: text("id").primaryKey(),
		snapshot: bytea("snapshot"),
		storageVersion: integer("storage_version").notNull().default(0),
	},
	(table) => [
		// Refuses snapshot writes from pre-journal code once a partition migrated.
		check(
			"hobo_ci_native_snapshot_guard",
			sql`${table.storageVersion} = 0 OR ${table.snapshot} IS NULL`,
		),
	],
);

export const snapshotBackups = pgTable("hobo_ci_snapshot_backups", {
	partitionId: text("partition_id").primaryKey(),
	snapshot: bytea("snapshot").notNull(),
	migratedAt: timestamp("migrated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const events = pgTable(
	"hobo_ci_events",
	{
		seq: bigserial("seq", { mode: "number" }).primaryKey(),
		partitionId: text("partition_id").notNull(),
		body: text("body").notNull(),
	},
	(table) => [
		index("hobo_ci_events_partition_seq").on(table.partitionId, table.seq),
		index("hobo_ci_events_lease_type_seq").on(
			table.partitionId,
			sql`(${table.body}::jsonb ->> 'leaseId')`,
			sql`(${table.body}::jsonb ->> 'type')`,
			table.seq.desc().nullsFirst(),
		),
	],
);

export const leases = pgTable(
	"hobo_ci_leases",
	{
		partitionId: text("partition_id").notNull(),
		id: text("id").notNull(),
		jobKey: text("job_key").notNull(),
		body: text("body").notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_leases_pkey",
			columns: [table.partitionId, table.id],
		}),
		index("hobo_ci_leases_job").on(table.partitionId, table.jobKey),
		index("hobo_ci_leases_account").on(
			table.partitionId,
			sql`(${table.body}::jsonb ->> 'accountId')`,
		),
		index("hobo_ci_leases_state").on(
			table.partitionId,
			sql`(${table.body}::jsonb ->> 'state')`,
			table.id,
		),
		index("hobo_ci_leases_runner").on(
			table.partitionId,
			sql`(${table.body}::jsonb ->> 'runnerName')`,
		),
	],
);

export const terminalJobs = pgTable(
	"hobo_ci_terminal_jobs",
	{
		partitionId: text("partition_id").notNull(),
		jobKey: text("job_key").notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_terminal_jobs_pkey",
			columns: [table.partitionId, table.jobKey],
		}),
	],
);

export const assignedJobs = pgTable(
	"hobo_ci_assigned_jobs",
	{
		partitionId: text("partition_id").notNull(),
		jobKey: text("job_key").notNull(),
		leaseId: text("lease_id").notNull(),
		version: text("version").notNull().default(""),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_assigned_jobs_pkey",
			columns: [table.partitionId, table.jobKey],
		}),
	],
);

export const pendingJobs = pgTable(
	"hobo_ci_pending_jobs",
	{
		seq: bigserial("seq", { mode: "number" }),
		partitionId: text("partition_id").notNull(),
		jobKey: text("job_key").notNull(),
		body: text("body").notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_pending_jobs_pkey",
			columns: [table.partitionId, table.jobKey],
		}),
		index("hobo_ci_pending_order").on(table.partitionId, table.seq),
	],
);

export const configuration = pgTable("hobo_ci_configuration", {
	partitionId: text("partition_id").primaryKey(),
	body: text("body").notNull(),
});

export const controlRecords = pgTable(
	"hobo_ci_control_records",
	{
		partitionId: text("partition_id").notNull(),
		key: text("key").notNull(),
		body: text("body").notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_control_records_pkey",
			columns: [table.partitionId, table.key],
		}),
	],
);

export const sandboxEgress = pgTable(
	"hobo_ci_sandbox_egress",
	{
		partitionId: text("partition_id").notNull(),
		sandboxId: text("sandbox_id").notNull(),
		leaseId: text("lease_id").notNull(),
		accountId: text("account_id").notNull(),
		maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
		usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_sandbox_egress_pkey",
			columns: [table.partitionId, table.sandboxId],
		}),
		unique("hobo_ci_sandbox_egress_partition_id_lease_id_key").on(
			table.partitionId,
			table.leaseId,
		),
	],
);

export const sandboxProxies = pgTable(
	"hobo_ci_sandbox_proxies",
	{
		partitionId: text("partition_id").notNull(),
		leaseId: text("lease_id").notNull(),
		accountId: text("account_id").notNull(),
		proxySessionId: text("proxy_session_id").notNull(),
		tokenSha256: text("token_sha256").notNull(),
		attemptedCalls: bigint("attempted_calls", { mode: "number" })
			.notNull()
			.default(0),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_sandbox_proxies_pkey",
			columns: [table.partitionId, table.leaseId],
		}),
		unique("hobo_ci_sandbox_proxies_partition_id_proxy_session_id_key").on(
			table.partitionId,
			table.proxySessionId,
		),
		uniqueIndex("hobo_ci_sandbox_proxy_secret").on(
			table.partitionId,
			table.tokenSha256,
		),
	],
);

export const sandboxProxyRequests = pgTable(
	"hobo_ci_sandbox_proxy_requests",
	{
		partitionId: text("partition_id").notNull(),
		leaseId: text("lease_id").notNull(),
		requestId: text("request_id").notNull(),
		createdMs: bigint("created_ms", { mode: "number" }).notNull(),
		bytes: bigint("bytes", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_sandbox_proxy_requests_pkey",
			columns: [table.partitionId, table.leaseId, table.requestId],
		}),
		index("hobo_ci_proxy_request_rate").on(
			table.partitionId,
			table.leaseId,
			table.createdMs,
		),
	],
);

export const inbox = pgTable(
	"hobo_ci_inbox",
	{
		seq: bigserial("seq", { mode: "number" }),
		partitionId: text("partition_id").notNull(),
		deliveryId: text("delivery_id").notNull(),
		fingerprint: text("fingerprint").notNull(),
		event: text("event").notNull(),
		installationId: bigint("installation_id", { mode: "number" }).notNull(),
		repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
		rawBody: bytea("raw_body").notNull(),
		receivedAt: text("received_at").notNull(),
		claimToken: text("claim_token"),
		claimUntil: bigint("claim_until", { mode: "number" }).notNull().default(0),
		completed: boolean("completed").notNull().default(false),
		attempts: integer("attempts").notNull().default(0),
		quarantined: boolean("quarantined").notNull().default(false),
		bodyHash: text("body_hash").notNull().default(""),
		receivedMs: bigint("received_ms", { mode: "number" }).notNull().default(0),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_inbox_pkey",
			columns: [table.partitionId, table.deliveryId],
		}),
		index("hobo_ci_inbox_replay")
			.on(
				table.partitionId,
				table.installationId,
				table.bodyHash,
				table.receivedMs,
			)
			.where(sql`${table.bodyHash} <> ''`),
		index("hobo_ci_inbox_installation_rate").on(
			table.partitionId,
			table.installationId,
			table.receivedMs,
		),
		index("hobo_ci_inbox_installation_outstanding")
			.on(table.partitionId, table.installationId)
			.where(sql`NOT ${table.completed}`),
		index("hobo_ci_inbox_pending")
			.on(table.partitionId, table.seq)
			.where(sql`NOT ${table.completed} AND NOT ${table.quarantined}`),
	],
);
