/**
 * Postgres schema of the GitHub App relay's own state: App registration and
 * credentials, OAuth state and sessions, the platform-App bootstrap fence, and
 * the webhook and queued-job repair cursors.
 *
 * This module is the declared source of the `hobo_ci_*` tables this package
 * owns. It is an authoring surface only (ADR-0160): `@hobo/adapter-drizzle`
 * ingests it into the canonical schema IR, core's differ produces the phased
 * migration plan, and drizzle-kit renders the SQL checked in under
 * `db/migrations/`. Nothing on the request path imports it; the stores keep
 * their hand-written SQL through `pg`.
 *
 * Constraint names are spelled out wherever PostgreSQL would have derived one,
 * because an existing database already holds those names. Column order follows
 * what the embedded DDL produces on a new database, including columns it adds
 * with `ALTER TABLE` after creating the table.
 */

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	customType,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
} from "drizzle-orm/pg-core";

/** drizzle-orm ships no `bytea` column; the SQL type is all the schema needs. */
const bytea = customType<{ data: Buffer }>({
	dataType: () => "bytea",
});

// --- App registration (`PostgresAppRegistration`) ---

export const appStates = pgTable("hobo_ci_app_states", {
	digest: text("digest").primaryKey(),
	purpose: text("purpose").notNull(),
	accountId: text("account_id").notNull(),
	subject: text("subject").notNull(),
	expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
});

export const appCredentials = pgTable("hobo_ci_app_credentials", {
	appId: bigint("app_id", { mode: "number" }).primaryKey(),
	ciphertext: bytea("ciphertext").notNull(),
});

export const appInstallations = pgTable("hobo_ci_app_installations", {
	installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
	appId: bigint("app_id", { mode: "number" }).notNull(),
	accountId: text("account_id").notNull(),
});

// --- OAuth state and sessions (`PostgresGithubOAuthSessionStore`) ---

export const oauthStates = pgTable(
	"hobo_ci_oauth_states",
	{
		digest: text("digest").primaryKey(),
		browserDigest: text("browser_digest").notNull(),
		accountId: text("account_id").notNull(),
		secret: bytea("secret").notNull(),
		expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
	},
	(table) => [index("hobo_ci_oauth_states_expires_idx").on(table.expiresMs)],
);

export const oauthSessions = pgTable(
	"hobo_ci_oauth_sessions",
	{
		digest: text("digest").primaryKey(),
		accountId: text("account_id").notNull(),
		githubId: bigint("github_id", { mode: "number" }).notNull(),
		secret: bytea("secret").notNull(),
		expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
	},
	(table) => [index("hobo_ci_oauth_sessions_expires_idx").on(table.expiresMs)],
);

// --- Platform App bootstrap fence (`PostgresAppBootstrapStore`) ---

export const platformApp = pgTable(
	"hobo_ci_platform_app",
	{
		singleton: boolean("singleton").primaryKey().default(true),
		status: text("status").notNull(),
		sessionDigest: text("session_digest").notNull(),
		tokenDigest: text("token_digest").notNull(),
		stateDigest: text("state_digest").notNull(),
		expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
		appId: bigint("app_id", { mode: "number" }),
		ownerMetadata: jsonb("owner_metadata"),
		ownerSessionStartedMs: bigint("owner_session_started_ms", {
			mode: "number",
		})
			.notNull()
			.default(0),
	},
	(table) => [
		// One row at most: the primary key admits `true` and `false`, the check
		// removes `false`.
		check("hobo_ci_platform_app_singleton_check", sql`${table.singleton}`),
	],
);

export const platformAppAttempts = pgTable(
	"hobo_ci_platform_app_attempts",
	{
		sessionDigest: text("session_digest").primaryKey(),
		status: text("status").notNull(),
		createdMs: bigint("created_ms", { mode: "number" }).notNull(),
		expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
		appId: bigint("app_id", { mode: "number" }),
		metadata: jsonb("metadata"),
	},
	(table) => [
		index("hobo_ci_platform_app_attempts_expiry").on(table.expiresMs),
	],
);

export const platformAppInvitations = pgTable(
	"hobo_ci_platform_app_invitations",
	{
		invitationDigest: text("invitation_digest").primaryKey(),
		// Nullable on purpose: the embedded DDL creates it NOT NULL and then
		// drops the constraint, so a consumed invitation can release its session.
		sessionDigest: text("session_digest").unique(
			"hobo_ci_platform_app_invitations_session_digest_key",
		),
		expiresMs: bigint("expires_ms", { mode: "number" }).notNull(),
	},
);

// --- Queued-job repair (`PostgresQueuedJobRepairClaims`) ---

export const queuedScans = pgTable(
	"hobo_ci_queued_scans",
	{
		appId: text("app_id").notNull(),
		scanKey: text("scan_key").notNull(),
		cursor: jsonb("cursor").notNull(),
		dueMs: bigint("due_ms", { mode: "number" }).notNull().default(0),
		touchedMs: bigint("touched_ms", { mode: "number" }).notNull().default(0),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_queued_scans_pkey",
			columns: [table.appId, table.scanKey],
		}),
	],
);

export const queuedApiBudget = pgTable(
	"hobo_ci_queued_api_budget",
	{
		appId: text("app_id").notNull(),
		usedMs: bigint("used_ms", { mode: "number" }).notNull(),
	},
	(table) => [
		index("hobo_ci_queued_api_budget_time").on(table.appId, table.usedMs),
	],
);

// --- Webhook delivery repair (`PostgresWebhookRepairClaims`) ---

export const webhookRepairs = pgTable(
	"hobo_ci_webhook_repairs",
	{
		appId: text("app_id").notNull(),
		guid: text("guid").notNull(),
		attemptedMs: bigint("attempted_ms", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_webhook_repairs_pkey",
			columns: [table.appId, table.guid],
		}),
	],
);

export const webhookScanCursors = pgTable("hobo_ci_webhook_scan_cursors", {
	appId: text("app_id").primaryKey(),
	cursorUrl: text("cursor_url"),
});

export const webhookSuccesses = pgTable(
	"hobo_ci_webhook_successes",
	{
		appId: text("app_id").notNull(),
		guid: text("guid").notNull(),
		seenMs: bigint("seen_ms", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({
			name: "hobo_ci_webhook_successes_pkey",
			columns: [table.appId, table.guid],
		}),
	],
);
