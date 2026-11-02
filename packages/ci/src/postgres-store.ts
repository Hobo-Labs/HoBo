import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
	type Account,
	CiEventSchema,
	type Configuration,
	ConfigurationStateSchema,
	ControlRecordSchema,
	type Job,
	JobSchema,
	type Lease,
	LeaseSchema,
	type PipelineResult,
	type SandboxAllowance,
	SandboxAllowanceSchema,
	type SandboxMeasuredUsage,
	SandboxPricingSchema,
} from "./_generated/ci_pb.js";
import { allocationQuote } from "./accounting.js";
import { effectiveCiAccount, parseCiPolicy } from "./policy.js";
import { ACTIVE_STATES, route } from "./routing.js";
import {
	sandboxProxyOnlyUsageQuote,
	sandboxUsageQuote,
} from "./sandbox-pricing.js";
import { LeaseStore, type RateReattestation } from "./store.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WEBHOOK_BODY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_RATE_WINDOW_MS = 60 * 1000;
const MAX_WEBHOOKS_PER_INSTALLATION_WINDOW = 600;
const MAX_OUTSTANDING_WEBHOOKS_PER_INSTALLATION = 10000;
const MAX_OUTSTANDING_WEBHOOK_BYTES_PER_INSTALLATION = 64 * 1024 * 1024;

/** Validate provider-confirmed terminal usage before using it in accounting. */
function measuredUsage(
	usage: SandboxMeasuredUsage | undefined,
	sessionId: string,
	minVcpus: number,
	minMemoryMb: number,
	at: string,
) {
	if (
		!usage ||
		usage.sessionId !== sessionId ||
		!sessionId ||
		!Number.isFinite(Date.parse(usage.stoppedAt)) ||
		Date.parse(usage.stoppedAt) > Date.parse(at)
	)
		throw new Error("sandbox stop proof unavailable");
	for (const value of [
		usage.cpuMs,
		usage.durationMs,
		usage.memoryMb,
		usage.vcpus,
		usage.egressBytes,
		usage.ingressBytes,
	])
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("invalid sandbox usage proof");
	if (
		usage.vcpus < minVcpus ||
		usage.memoryMb < minMemoryMb ||
		!Number.isSafeInteger(usage.durationMs * usage.vcpus)
	)
		throw new Error("sandbox usage resource mismatch");
	return usage;
}
export interface WebhookInput {
	deliveryId: string;
	event: string;
	installationId: number;
	repositoryId: number;
	rawBody: Uint8Array;
	receivedAt: string;
}
export interface ClaimedWebhook extends WebhookInput {
	token: string;
}
interface SnapshotDatabase extends DatabaseSync {
	deserialize(data: Uint8Array): void;
}

/** Native PostgreSQL journal. Each partition's mutations serialize at its lock row. */
export class PostgresCiStore {
	private initialization: Promise<void> | undefined;
	constructor(
		private readonly pool: Pool,
		private readonly partition = "default",
	) {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(partition))
			throw new Error("invalid partition");
	}
	async initialize(): Promise<void> {
		this.initialization ??= this.initializeOnce();
		try {
			await this.initialization;
		} catch (error) {
			this.initialization = undefined;
			throw error;
		}
	}
	private async initializeOnce(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-ci-schema-v2'))",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_ci_partitions (id text PRIMARY KEY, snapshot bytea)",
			);
			await client.query(
				"ALTER TABLE hobo_ci_partitions ADD COLUMN IF NOT EXISTS storage_version integer NOT NULL DEFAULT 0",
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_snapshot_backups (partition_id text PRIMARY KEY, snapshot bytea NOT NULL, migrated_at timestamptz NOT NULL DEFAULT now())`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_events (seq bigserial PRIMARY KEY, partition_id text NOT NULL, body text NOT NULL)`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_events_partition_seq ON hobo_ci_events(partition_id,seq)`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_events_lease_type_seq ON hobo_ci_events(partition_id, (body::jsonb ->> 'leaseId'), (body::jsonb ->> 'type'), seq DESC)`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_leases (partition_id text NOT NULL, id text NOT NULL, job_key text NOT NULL, body text NOT NULL, PRIMARY KEY(partition_id,id))`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_leases_job ON hobo_ci_leases(partition_id,job_key)`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_leases_account ON hobo_ci_leases(partition_id,(body::jsonb ->> 'accountId'))`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_leases_state ON hobo_ci_leases(partition_id,(body::jsonb ->> 'state'),id)`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_leases_runner ON hobo_ci_leases(partition_id,(body::jsonb ->> 'runnerName'))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_terminal_jobs (partition_id text NOT NULL, job_key text NOT NULL, PRIMARY KEY(partition_id,job_key))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_assigned_jobs (partition_id text NOT NULL, job_key text NOT NULL, lease_id text NOT NULL, PRIMARY KEY(partition_id,job_key))`,
			);
			await client.query(
				"ALTER TABLE hobo_ci_assigned_jobs ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT ''",
			);
			await client.query(
				"UPDATE hobo_ci_assigned_jobs SET version=gen_random_uuid()::text WHERE version=''",
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_pending_jobs (seq bigserial, partition_id text NOT NULL, job_key text NOT NULL, body text NOT NULL, PRIMARY KEY(partition_id,job_key))`,
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_pending_order ON hobo_ci_pending_jobs(partition_id,seq)`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_configuration (partition_id text PRIMARY KEY, body text NOT NULL)`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_control_records (partition_id text NOT NULL, key text NOT NULL, body text NOT NULL, PRIMARY KEY(partition_id,key))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_sandbox_egress (partition_id text NOT NULL, sandbox_id text NOT NULL, lease_id text NOT NULL, account_id text NOT NULL, max_bytes bigint NOT NULL, used_bytes bigint NOT NULL DEFAULT 0, PRIMARY KEY(partition_id,sandbox_id), UNIQUE(partition_id,lease_id))`,
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_sandbox_proxies (partition_id text NOT NULL,lease_id text NOT NULL,account_id text NOT NULL,proxy_session_id text NOT NULL,token_sha256 text NOT NULL,PRIMARY KEY(partition_id,lease_id),UNIQUE(partition_id,proxy_session_id))`,
			);
			await client.query(
				"ALTER TABLE hobo_ci_sandbox_proxies ADD COLUMN IF NOT EXISTS attempted_calls bigint NOT NULL DEFAULT 0",
			);
			await client.query(
				"CREATE UNIQUE INDEX IF NOT EXISTS hobo_ci_sandbox_proxy_secret ON hobo_ci_sandbox_proxies(partition_id,token_sha256)",
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_sandbox_proxy_requests (partition_id text NOT NULL,lease_id text NOT NULL,request_id text NOT NULL,created_ms bigint NOT NULL,bytes bigint NOT NULL,PRIMARY KEY(partition_id,lease_id,request_id))`,
			);
			await client.query(
				"CREATE INDEX IF NOT EXISTS hobo_ci_proxy_request_rate ON hobo_ci_sandbox_proxy_requests(partition_id,lease_id,created_ms)",
			);
			await client.query(
				`CREATE TABLE IF NOT EXISTS hobo_ci_inbox (seq bigserial, partition_id text NOT NULL, delivery_id text NOT NULL, fingerprint text NOT NULL, event text NOT NULL, installation_id bigint NOT NULL, repository_id bigint NOT NULL, raw_body bytea NOT NULL, received_at text NOT NULL, claim_token text, claim_until bigint NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0, quarantined boolean NOT NULL DEFAULT false, PRIMARY KEY(partition_id,delivery_id))`,
			);
			await client.query(
				"ALTER TABLE hobo_ci_inbox ADD COLUMN IF NOT EXISTS body_hash text NOT NULL DEFAULT ''",
			);
			await client.query(
				"ALTER TABLE hobo_ci_inbox ADD COLUMN IF NOT EXISTS received_ms bigint NOT NULL DEFAULT 0",
			);
			await client.query(
				"CREATE INDEX IF NOT EXISTS hobo_ci_inbox_replay ON hobo_ci_inbox(partition_id,installation_id,body_hash,received_ms) WHERE body_hash <> ''",
			);
			await client.query(
				"CREATE INDEX IF NOT EXISTS hobo_ci_inbox_installation_rate ON hobo_ci_inbox(partition_id,installation_id,received_ms)",
			);
			await client.query(
				"CREATE INDEX IF NOT EXISTS hobo_ci_inbox_installation_outstanding ON hobo_ci_inbox(partition_id,installation_id) WHERE NOT completed",
			);
			await client.query(
				`CREATE INDEX IF NOT EXISTS hobo_ci_inbox_pending ON hobo_ci_inbox(partition_id,seq) WHERE NOT completed AND NOT quarantined`,
			);
			await client.query(
				"INSERT INTO hobo_ci_partitions(id) VALUES($1) ON CONFLICT DO NOTHING",
				[this.partition],
			);
			const row = (
				await client.query<{
					snapshot: Buffer | null;
					storage_version: number;
				}>(
					"SELECT snapshot,storage_version FROM hobo_ci_partitions WHERE id=$1 FOR UPDATE",
					[this.partition],
				)
			).rows[0];
			if (!row) throw new Error("CI partition missing");
			if (row.storage_version > 1)
				throw new Error("unsupported CI store version");
			if (row.storage_version === 0) {
				if (row.snapshot) await this.importSnapshot(client, row.snapshot);
				await client.query(
					"UPDATE hobo_ci_partitions SET snapshot=NULL,storage_version=1 WHERE id=$1",
					[this.partition],
				);
			}
			// Existing native rows may predate replay hashes. Retained payloads can be
			// backfilled; already-erased completed payloads cannot be reconstructed.
			await client.query(
				`UPDATE hobo_ci_inbox SET body_hash=encode(sha256(raw_body),'hex'), received_ms=(extract(epoch from received_at::timestamptz)*1000)::bigint
				WHERE partition_id=$1 AND body_hash='' AND octet_length(raw_body)>0`,
				[this.partition],
			);
			// Imported marker rows need nonempty fencing tokens too.
			await client.query(
				"UPDATE hobo_ci_assigned_jobs SET version=gen_random_uuid()::text WHERE partition_id=$1 AND version=''",
				[this.partition],
			);
			// Old code only writes snapshots. Refuse those writes after migration so
			// rolling back a deployment cannot silently discard native journal updates.
			await client.query(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hobo_ci_native_snapshot_guard') THEN ALTER TABLE hobo_ci_partitions ADD CONSTRAINT hobo_ci_native_snapshot_guard CHECK (storage_version=0 OR snapshot IS NULL); END IF; END $$`,
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	private async importSnapshot(
		client: PoolClient,
		bytes: Buffer,
	): Promise<void> {
		const db = new DatabaseSync(":memory:");
		try {
			if (!("deserialize" in db))
				throw new Error("Node SQLite snapshot support required for migration");
			// SAFETY: Node 24 provides deserialize, and the runtime capability is checked above.
			const snapshotDb = db as SnapshotDatabase;
			snapshotDb.deserialize(bytes);
			await client.query(
				"INSERT INTO hobo_ci_snapshot_backups(partition_id,snapshot) VALUES($1,$2) ON CONFLICT DO NOTHING",
				[this.partition, bytes],
			);
			const tables = [
				[
					"events",
					"SELECT body FROM events ORDER BY seq",
					"INSERT INTO hobo_ci_events(partition_id,body) VALUES($1,$2)",
					["body"],
				],
				[
					"leases",
					"SELECT id,job_key,body FROM leases ORDER BY id",
					"INSERT INTO hobo_ci_leases(partition_id,id,job_key,body) VALUES($1,$2,$3,$4)",
					["id", "job_key", "body"],
				],
				[
					"terminal_jobs",
					"SELECT job_key FROM terminal_jobs ORDER BY rowid",
					"INSERT INTO hobo_ci_terminal_jobs(partition_id,job_key) VALUES($1,$2)",
					["job_key"],
				],
				[
					"pending_jobs",
					"SELECT job_key,body FROM pending_jobs ORDER BY rowid",
					"INSERT INTO hobo_ci_pending_jobs(partition_id,job_key,body) VALUES($1,$2,$3)",
					["job_key", "body"],
				],
				[
					"configuration_state",
					"SELECT body FROM configuration_state WHERE id=1",
					"INSERT INTO hobo_ci_configuration(partition_id,body) VALUES($1,$2)",
					["body"],
				],
				[
					"control_records",
					"SELECT key,body FROM control_records ORDER BY rowid",
					"INSERT INTO hobo_ci_control_records(partition_id,key,body) VALUES($1,$2,$3)",
					["key", "body"],
				],
			] as const;
			for (const [, select, insert, fields] of tables)
				for (const row of db.prepare(select).iterate())
					await client.query(insert, [
						this.partition,
						...fields.map((field) => row[field]),
					]);
			if (
				db
					.prepare(
						"SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='assigned_jobs'",
					)
					.get()
			) {
				for (const row of db
					.prepare("SELECT job_key,lease_id FROM assigned_jobs ORDER BY rowid")
					.iterate())
					await client.query(
						"INSERT INTO hobo_ci_assigned_jobs(partition_id,job_key,lease_id) VALUES($1,$2,$3)",
						[this.partition, row.job_key, row.lease_id],
					);
			}
			const inboxExists = db
				.prepare(
					"SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='ci_host_inbox'",
				)
				.get();
			if (inboxExists) {
				const columns = new Set(
					db
						.prepare("PRAGMA table_info(ci_host_inbox)")
						.all()
						.map((row) => String(row.name)),
				);
				const attempts = columns.has("attempts") ? "attempts" : "0 AS attempts";
				const quarantined = columns.has("quarantined")
					? "quarantined"
					: "0 AS quarantined";
				for (const row of db
					.prepare(
						`SELECT delivery_id,fingerprint,event,installation_id,repository_id,raw_body,received_at,claim_token,claim_until,completed,${attempts},${quarantined} FROM ci_host_inbox ORDER BY rowid`,
					)
					.iterate()) {
					const raw = z.instanceof(Uint8Array).parse(row.raw_body);
					const received = Date.parse(z.string().parse(row.received_at));
					const digest = raw.byteLength
						? createHash("sha256").update(raw).digest("hex")
						: "";
					await client.query(
						`INSERT INTO hobo_ci_inbox(partition_id,delivery_id,fingerprint,event,installation_id,repository_id,raw_body,received_at,claim_token,claim_until,completed,attempts,quarantined,body_hash,received_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
						[
							this.partition,
							row.delivery_id,
							row.fingerprint,
							row.event,
							row.installation_id,
							row.repository_id,
							row.raw_body,
							row.received_at,
							row.claim_token,
							row.claim_until,
							Boolean(row.completed),
							row.attempts,
							Boolean(row.quarantined),
							digest,
							Number.isFinite(received) ? received : 0,
						],
					);
				}
			}
		} finally {
			db.close();
		}
	}
	private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
		await this.initialize();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const row = (
				await client.query<{ storage_version: number }>(
					"SELECT storage_version FROM hobo_ci_partitions WHERE id=$1 FOR UPDATE",
					[this.partition],
				)
			).rows[0];
			if (row?.storage_version !== 1)
				throw new Error("CI partition storage version changed");
			const output = await fn(client);
			await client.query("COMMIT");
			return output;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	private async readConfiguration(client: PoolClient) {
		const row = (
			await client.query<{ body: string }>(
				"SELECT body FROM hobo_ci_configuration WHERE partition_id=$1",
				[this.partition],
			)
		).rows[0];
		return row ? fromJsonString(ConfigurationStateSchema, row.body) : undefined;
	}
	private async checkRevision(
		client: PoolClient,
		expected: number | undefined,
	) {
		if (
			expected !== undefined &&
			(await this.readConfiguration(client))?.revision !== expected
		)
			throw new Error("configuration revision conflict");
	}
	private async readLeases(client: PoolClient): Promise<Lease[]> {
		return (
			await client.query<{ body: string }>(
				"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 ORDER BY id",
				[this.partition],
			)
		).rows.map((row) => fromJsonString(LeaseSchema, row.body));
	}
	private async readJobLeases(
		client: PoolClient,
		jobKey: string,
	): Promise<Lease[]> {
		const rows = await client.query<{ body: string }>(
			"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 AND job_key=$2 ORDER BY id",
			[this.partition, jobKey],
		);
		return rows.rows.map((row) => fromJsonString(LeaseSchema, row.body));
	}
	private async readActiveLeases(client: PoolClient): Promise<Lease[]> {
		const rows = await client.query<{ body: string }>(
			"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 AND body::jsonb ->> 'state' = ANY($2::text[]) ORDER BY id",
			[this.partition, [...ACTIVE_STATES]],
		);
		return rows.rows.map((row) => fromJsonString(LeaseSchema, row.body));
	}
	private async readAccountLeases(
		client: PoolClient,
		accountId: string,
	): Promise<Lease[]> {
		const rows = await client.query<{ body: string }>(
			"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 AND body::jsonb ->> 'accountId'=$2 ORDER BY id",
			[this.partition, accountId],
		);
		return rows.rows.map((row) => fromJsonString(LeaseSchema, row.body));
	}
	private async readLease(
		client: PoolClient,
		id: string,
	): Promise<Lease | undefined> {
		const row = (
			await client.query<{ body: string }>(
				"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 AND id=$2",
				[this.partition, id],
			)
		).rows[0];
		return row ? fromJsonString(LeaseSchema, row.body) : undefined;
	}
	private async readRecord(client: PoolClient, key: string) {
		const row = (
			await client.query<{ body: string }>(
				"SELECT body FROM hobo_ci_control_records WHERE partition_id=$1 AND key=$2",
				[this.partition, key],
			)
		).rows[0];
		return row ? fromJsonString(ControlRecordSchema, row.body) : undefined;
	}
	private async event(
		client: PoolClient,
		type: string,
		at: string,
		detail: string,
		accountId = "",
		leaseId = "",
	) {
		await client.query(
			"INSERT INTO hobo_ci_events(partition_id,body) VALUES($1,$2)",
			[
				this.partition,
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, { type, at, detail, accountId, leaseId }),
				),
			],
		);
	}
	private key(lease: Lease) {
		return lease.pipelineId
			? `pipeline:${lease.accountId}:${lease.pipelineId}`
			: `${lease.repositoryId}:${lease.jobId}:${lease.runAttempt}`;
	}
	private async append(
		client: PoolClient,
		lease: Lease,
		type: string,
		at: string,
	) {
		const body = toJsonString(LeaseSchema, lease);
		await this.event(client, type, at, body, lease.accountId, lease.id);
		await client.query(
			"INSERT INTO hobo_ci_leases(partition_id,id,job_key,body) VALUES($1,$2,$3,$4) ON CONFLICT(partition_id,id) DO UPDATE SET body=EXCLUDED.body",
			[this.partition, lease.id, this.key(lease), body],
		);
	}
	async ready(): Promise<boolean> {
		try {
			await this.tx(async (c) => {
				await c.query("SELECT 1");
			});
			return true;
		} catch {
			return false;
		}
	}
	configuration() {
		return this.tx((c) => this.readConfiguration(c));
	}
	policySnapshot() {
		return this.tx(async (c) => {
			const state = await this.readConfiguration(c);
			const policies = [];
			for (const account of state?.configuration?.accounts ?? []) {
				const record = await this.readRecord(c, `ci-policy:${account.id}`);
				if (record)
					policies.push({ accountId: account.id, bodyJson: record.bodyJson });
			}
			return { state, policies };
		});
	}
	private async configureInside(
		client: PoolClient,
		config: Configuration,
		revision: number,
		at: string,
	) {
		// Reuse the existing policy validation verbatim while the native rows stay
		// locked. Only configuration and live lease identities affect validation.
		const db = new DatabaseSync(":memory:");
		const store = new LeaseStore(":memory:", db);
		try {
			const previous = await this.readConfiguration(client);
			if (previous)
				db.prepare("INSERT INTO configuration_state(id,body) VALUES(1,?)").run(
					toJsonString(ConfigurationStateSchema, previous),
				);
			for (const lease of await this.readActiveLeases(client))
				if (ACTIVE_STATES.has(lease.state))
					db.prepare("INSERT INTO leases(id,job_key,body) VALUES(?,?,?)").run(
						lease.id,
						this.key(lease),
						toJsonString(LeaseSchema, lease),
					);
			const state = store.configure(config, revision, at);
			const body = toJsonString(ConfigurationStateSchema, state);
			await this.event(client, "ci.ConfigurationChanged", at, body);
			await client.query(
				"INSERT INTO hobo_ci_configuration(partition_id,body) VALUES($1,$2) ON CONFLICT(partition_id) DO UPDATE SET body=EXCLUDED.body",
				[this.partition, body],
			);
			return state;
		} finally {
			store.close();
		}
	}
	configure(config: Configuration, revision: number, at: string) {
		return this.tx((c) => this.configureInside(c, config, revision, at));
	}
	/** Atomically re-attest a zero-credit rate without changing its usage snapshot. */
	reattestRate(input: RateReattestation, revision: number, at: string) {
		return this.tx(async (client) => {
			const db = new DatabaseSync(":memory:");
			const store = new LeaseStore(":memory:", db);
			try {
				const previous = await this.readConfiguration(client);
				if (previous)
					db.prepare(
						"INSERT INTO configuration_state(id,body) VALUES(1,?)",
					).run(toJsonString(ConfigurationStateSchema, previous));
				const state = store.reattestRate(input, revision, at);
				for (const event of store.events())
					await this.event(
						client,
						event.type,
						event.at,
						event.detail,
						event.accountId,
						event.leaseId,
					);
				const body = toJsonString(ConfigurationStateSchema, state);
				await client.query(
					"INSERT INTO hobo_ci_configuration(partition_id,body) VALUES($1,$2) ON CONFLICT(partition_id) DO UPDATE SET body=EXCLUDED.body",
					[this.partition, body],
				);
				return state;
			} finally {
				store.close();
			}
		});
	}
	configureWithRecord(
		config: Configuration,
		revision: number,
		at: string,
		key: string,
		accountId: string,
		bodyJson: string,
	) {
		return this.tx(async (c) => {
			const state = await this.configureInside(c, config, revision, at);
			await this.putRecordInside(c, key, accountId, bodyJson, at);
			return state;
		});
	}
	controlRecord(key: string) {
		return this.tx((c) => this.readRecord(c, key));
	}
	private async putRecordInside(
		c: PoolClient,
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
	) {
		if (
			!/^[A-Za-z0-9:_-]{1,200}$/.test(key) ||
			!/^[A-Za-z0-9_-]{1,80}$/.test(accountId) ||
			Buffer.byteLength(bodyJson) > 1024 * 1024
		)
			throw new Error("invalid control record");
		z.record(z.string(), z.json()).parse(JSON.parse(bodyJson));
		const old = await this.readRecord(c, key);
		if (old && old.accountId !== accountId)
			throw new Error("control record belongs to another account");
		const detail = toJsonString(
			ControlRecordSchema,
			create(ControlRecordSchema, { key, accountId, bodyJson, updatedAt: at }),
		);
		await this.event(c, "ci.ControlRecordUpdated", at, detail, accountId);
		await c.query(
			"INSERT INTO hobo_ci_control_records(partition_id,key,body) VALUES($1,$2,$3) ON CONFLICT(partition_id,key) DO UPDATE SET body=EXCLUDED.body",
			[this.partition, key, detail],
		);
	}
	putControlRecord(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
	) {
		return this.tx((c) =>
			this.putRecordInside(c, key, accountId, bodyJson, at),
		);
	}
	putControlRecordMonotonic(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
		terminalStatus: string,
	) {
		return this.tx(async (c) => {
			const schema = z.object({ status: z.string() });
			const incoming = schema.parse(JSON.parse(bodyJson));
			const old = await this.readRecord(c, key);
			if (old && old.accountId !== accountId)
				throw new Error("control record belongs to another account");
			if (
				old &&
				schema.parse(JSON.parse(old.bodyJson)).status === terminalStatus &&
				incoming.status !== terminalStatus
			)
				return old;
			await this.putRecordInside(c, key, accountId, bodyJson, at);
			return this.readRecord(c, key);
		});
	}
	all() {
		return this.tx((c) => this.readLeases(c));
	}
	activeLeases() {
		return this.tx((c) => this.readActiveLeases(c));
	}
	accountLeases(accountId: string) {
		return this.tx((c) => this.readAccountLeases(c, accountId));
	}
	get(id: string) {
		return this.tx((c) => this.readLease(c, id));
	}
	events() {
		return this.tx(async (c) =>
			(
				await c.query<{ body: string }>(
					"SELECT body FROM hobo_ci_events WHERE partition_id=$1 ORDER BY seq",
					[this.partition],
				)
			).rows.map((r) => fromJsonString(CiEventSchema, r.body)),
		);
	}
	/** Latest dispatch/claim intent for each active lease, without scanning history. */
	latestLeaseIntents(ids: readonly string[]) {
		if (ids.length === 0) return Promise.resolve([]);
		return this.tx(async (client) => {
			const result = await client.query<{ body: string }>(
				`SELECT DISTINCT ON (body::jsonb ->> 'leaseId',body::jsonb ->> 'type') body
				 FROM hobo_ci_events WHERE partition_id=$1 AND body::jsonb ->> 'leaseId'=ANY($2::text[])
				 AND body::jsonb ->> 'type'=ANY($3::text[])
				 ORDER BY body::jsonb ->> 'leaseId',body::jsonb ->> 'type',seq DESC`,
				[
					this.partition,
					ids,
					["ci.DispatchRequested", "ci.RunnerClaimed", "ci.SandboxCreated"],
				],
			);
			return result.rows.map((row) => fromJsonString(CiEventSchema, row.body));
		});
	}
	pendingJobs() {
		return this.tx(async (c) =>
			(
				await c.query<{ body: string }>(
					"SELECT body FROM hobo_ci_pending_jobs WHERE partition_id=$1 ORDER BY seq",
					[this.partition],
				)
			).rows.map((r) => fromJsonString(JobSchema, r.body)),
		);
	}
	private jobKey(job: Job) {
		return `${job.repositoryId}:${job.id}:${job.runAttempt}`;
	}
	private async queueInside(c: PoolClient, job: Job, at: string) {
		const key = this.jobKey(job);
		if (
			(
				await c.query(
					"SELECT 1 FROM hobo_ci_terminal_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				)
			).rowCount ||
			(
				await c.query(
					"SELECT 1 FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				)
			).rowCount ||
			(
				await c.query(
					"SELECT 1 FROM hobo_ci_pending_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				)
			).rowCount ||
			(await this.readJobLeases(c, key)).some(
				(l) =>
					l.repositoryId === job.repositoryId &&
					l.jobId === job.id &&
					l.runAttempt === job.runAttempt &&
					ACTIVE_STATES.has(l.state),
			)
		)
			return;
		const body = toJsonString(JobSchema, job);
		await this.event(c, "ci.JobQueued", at, body);
		await c.query(
			"INSERT INTO hobo_ci_pending_jobs(partition_id,job_key,body) VALUES($1,$2,$3)",
			[this.partition, key, body],
		);
	}
	assignedJob(
		job: Job,
	): Promise<{ leaseId: string; version: string } | undefined> {
		return this.tx(async (c) => {
			const row = (
				await c.query<{ lease_id: string; version: string }>(
					"SELECT lease_id,version FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, this.jobKey(job)],
				)
			).rows[0];
			return row ? { leaseId: row.lease_id, version: row.version } : undefined;
		});
	}
	/** Clear only after fresh GitHub queued proof and a terminal owner, with an exact token fence. */
	clearAssignedJob(
		job: Job,
		leaseId: string,
		version: string,
		at: string,
		expectedRevision: number,
	): Promise<boolean> {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			const lease = await this.readLease(c, leaseId);
			if (!lease || ACTIVE_STATES.has(lease.state)) return false;
			const removed = await c.query(
				"DELETE FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2 AND lease_id=$3 AND version=$4",
				[this.partition, this.jobKey(job), leaseId, version],
			);
			if (removed.rowCount)
				await this.event(
					c,
					"ci.JobAssignmentCleared",
					at,
					toJsonString(JobSchema, job),
					"",
					leaseId,
				);
			return removed.rowCount === 1;
		});
	}

	queue(job: Job, at: string, expectedRevision?: number) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			await this.queueInside(c, job, at);
		});
	}
	observe(job: Job, at: string, expectedRevision?: number) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			if (job.action === "completed") {
				const key = this.jobKey(job);
				await c.query(
					"INSERT INTO hobo_ci_terminal_jobs(partition_id,job_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
					[this.partition, key],
				);
				await c.query(
					"DELETE FROM hobo_ci_pending_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				);
				await c.query(
					"DELETE FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				);
				await this.event(
					c,
					"ci.JobCompleted",
					at,
					toJsonString(JobSchema, job),
				);
			}
			if (job.runnerName) {
				const runnerRows = await c.query<{ body: string }>(
					"SELECT body FROM hobo_ci_leases WHERE partition_id=$1 AND body::jsonb ->> 'runnerName'=$2 ORDER BY id",
					[this.partition, job.runnerName],
				);
				const lease = runnerRows.rows
					.map((row) => fromJsonString(LeaseSchema, row.body))
					.find(
						(l) =>
							l.repositoryId === job.repositoryId &&
							l.installationId === job.installationId &&
							l.repository.toLowerCase() === job.repository.toLowerCase() &&
							l.runnerName === job.runnerName,
					);
				const settledSandbox =
					lease?.state === "completed" &&
					lease.provider === "vercel" &&
					lease.sandboxStage === "stopped" &&
					lease.runnerDeletionConfirmed &&
					!!lease.settledAt;
				if (lease && (ACTIVE_STATES.has(lease.state) || settledSandbox)) {
					if (lease.actualJobId && lease.actualJobId !== job.id)
						throw new Error("runner job assignment conflict");
					lease.actualJobId = job.id;
					await this.append(
						c,
						lease,
						settledSandbox ? "ci.LateJobObserved" : "ci.JobObserved",
						at,
					);
					// A stopped runner cannot take new work. Late in-progress
					// assignment is attribution only; a fresh completion must still
					// cancel reservations for the now-terminal job.
					if (settledSandbox && job.action !== "completed") return;
					// Terminal observations win over delayed in-progress deliveries.
					const terminal =
						job.action === "in_progress" &&
						(
							await c.query(
								"SELECT 1 FROM hobo_ci_terminal_jobs WHERE partition_id=$1 AND job_key=$2",
								[this.partition, this.jobKey(job)],
							)
						).rowCount;
					if (terminal) return;
					if (job.action === "in_progress" || job.action === "completed") {
						if (job.action === "in_progress") {
							const assigned = (
								await c.query<{ lease_id: string }>(
									"SELECT lease_id FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2",
									[this.partition, this.jobKey(job)],
								)
							).rows[0];
							if (assigned && assigned.lease_id !== lease.id)
								throw new Error("job assigned to another runner");
							const version = randomUUID();
							await c.query(
								"INSERT INTO hobo_ci_assigned_jobs(partition_id,job_key,lease_id,version) VALUES($1,$2,$3,$4) ON CONFLICT(partition_id,job_key) DO UPDATE SET version=EXCLUDED.version",
								[this.partition, this.jobKey(job), lease.id, version],
							);
							await this.event(
								c,
								"ci.JobAssigned",
								at,
								JSON.stringify({
									job: JSON.parse(toJsonString(JobSchema, job)),
									version,
								}),
								lease.accountId,
								lease.id,
							);
						}
						for (const duplicate of await this.readJobLeases(
							c,
							this.jobKey(job),
						)) {
							if (
								duplicate.id !== lease.id &&
								duplicate.accountId === lease.accountId &&
								duplicate.state === "reserved"
							) {
								duplicate.state = "cancelled";
								await this.append(c, duplicate, "ci.LeaseCancelled", at);
							}
						}
						await c.query(
							"DELETE FROM hobo_ci_pending_jobs WHERE partition_id=$1 AND job_key=$2",
							[this.partition, this.jobKey(job)],
						);
					}
				}
			}
		});
	}
	reserve(account: Account, job: Job, at: string, expectedRevision?: number) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			const config = (await this.readConfiguration(c))?.configuration;
			const binding = config?.connections.find(
				(entry) =>
					entry.repositoryId === job.repositoryId &&
					entry.installationId === job.installationId &&
					entry.repository.toLowerCase() === job.repository.toLowerCase(),
			);
			if (!binding || binding.accountId !== account.id)
				throw new Error("connection revoked");
			const requiresIsolation = job.isolatedRequired || binding.isolatedOnly;
			const current = config?.accounts.find(
				(entry) => entry.id === binding.accountId,
			);
			if (!current) throw new Error("account revoked");
			const desired = await this.readRecord(c, `ci-policy:${current.id}`);
			const effective = desired
				? effectiveCiAccount(current, parseCiPolicy(desired.bodyJson))
				: current;
			const key = this.jobKey(job);
			if (
				(
					await c.query(
						"SELECT 1 FROM hobo_ci_terminal_jobs WHERE partition_id=$1 AND job_key=$2",
						[this.partition, key],
					)
				).rowCount
			)
				return undefined;
			if (
				(
					await c.query(
						"SELECT 1 FROM hobo_ci_assigned_jobs WHERE partition_id=$1 AND job_key=$2",
						[this.partition, key],
					)
				).rowCount
			)
				return undefined;
			const leases = await this.readAccountLeases(c, effective.id);
			const existing = (await this.readJobLeases(c, key)).find(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt &&
					ACTIVE_STATES.has(lease.state),
			);
			if (existing) {
				if (
					requiresIsolation &&
					existing.provider !== "vercel" &&
					existing.provider !== "kubernetes" &&
					existing.provider !== "hobo-box-worker"
				) {
					if (existing.state === "reserved") {
						existing.state = "cancelled";
						await this.append(c, existing, "ci.LeaseCancelled", at);
						await this.queueInside(c, job, at);
					}
					return undefined;
				}
				await c.query(
					"DELETE FROM hobo_ci_pending_jobs WHERE partition_id=$1 AND job_key=$2",
					[this.partition, key],
				);
				return existing;
			}
			const selected = route(
				{
					...effective,
					offers: effective.offers.filter((offer) =>
						requiresIsolation
							? (offer.provider === "vercel" &&
									offer.backend === "sandbox" &&
									offer.freeMinutes === 0) ||
								((offer.provider === "kubernetes" ||
									offer.provider === "hobo-box-worker") &&
									offer.backend === "isolated-container" &&
									offer.freeMinutes === 0 &&
									offer.priceMicrosPerMinute === 0)
							: !offer.backend || offer.backend === "gh-actions",
					),
				},
				leases,
				at,
			);
			if (!selected) return undefined;
			const id = randomUUID();
			const lease = create(LeaseSchema, {
				id,
				accountId: effective.id,
				offerId: selected.offer.id,
				provider: selected.offer.provider,
				jobId: job.id,
				originalRunId: job.runId,
				runAttempt: job.runAttempt,
				repositoryId: job.repositoryId,
				repository: job.repository,
				installationId: job.installationId,
				state: "reserved",
				priceMicrosPerMinute: selected.offer.priceMicrosPerMinute,
				freeValidUntil: selected.offer.validUntil,
				sandboxPricing: selected.offer.sandboxPricing
					? clone(SandboxPricingSchema, selected.offer.sandboxPricing)
					: undefined,
				sandboxReservedAllowance: selected.sandboxReservedAllowance
					? clone(SandboxAllowanceSchema, selected.sandboxReservedAllowance)
					: undefined,
				reservedMinutes: selected.minutes,
				reservedFreeMinutes: selected.freeMinutes,
				reservedPaidMicros: selected.paidMicros,
				runnerName: `hobo-${id}`,
				createdAt: at,
			});
			await this.append(c, lease, "ci.LeaseReserved", at);
			await c.query(
				"DELETE FROM hobo_ci_pending_jobs WHERE partition_id=$1 AND job_key=$2",
				[this.partition, key],
			);
			return lease;
		});
	}
	transition(
		id: string,
		expected: readonly string[],
		update: (lease: Lease) => void,
		type: string,
		at: string,
		expectedRevision?: number,
	) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			const lease = await this.readLease(c, id);
			if (!lease || !expected.includes(lease.state)) return undefined;
			update(lease);
			await this.append(c, lease, type, at);
			return lease;
		});
	}
	cancelAndRequeue(id: string, job: Job, at: string) {
		return this.tx(async (c) => {
			const lease = await this.readLease(c, id);
			if (lease?.state !== "reserved") return;
			lease.state = "cancelled";
			await this.append(c, lease, "ci.LeaseCancelled", at);
			await this.queueInside(c, job, at);
		});
	}
	abortIsolatedAndRequeue(id: string, job: Job, at: string) {
		const recoverable = new Set([
			"reserved",
			"dispatching",
			"claiming",
			"dispatched",
			"running",
			"uncertain",
		]);
		const isolatedProviders = new Set([
			"vercel",
			"kubernetes",
			"hobo-box-worker",
		]);
		return this.tx(async (c) => {
			const lease = await this.readLease(c, id);
			if (!lease || !recoverable.has(lease.state)) return;
			if (!isolatedProviders.has(lease.provider)) return;
			lease.state = "cancelled";
			await this.append(c, lease, "ci.LeaseCancelled", at);
			await this.queueInside(c, job, at);
		});
	}
	private async settleInside(
		c: PoolClient,
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt = at,
		result?: PipelineResult,
	) {
		const lease = await this.readLease(c, id);
		if (!lease || !ACTIVE_STATES.has(lease.state)) return undefined;
		if (lease.provider === "vercel")
			throw new Error("sandbox requires native cost settlement");
		if (lease.hostRunId !== 0 && lease.hostRunId !== hostRunId)
			throw new Error("host run mismatch");
		if (
			!Number.isFinite(billedMinutes) ||
			billedMinutes < 0 ||
			billedMinutes > Number.MAX_SAFE_INTEGER
		)
			throw new Error("invalid settlement");
		lease.hostRunId = hostRunId;
		lease.state = "completed";
		lease.billedMinutes = billedMinutes;
		const quote = allocationQuote(
			Date.parse(completedAt) <= Date.parse(lease.freeValidUntil)
				? lease.reservedFreeMinutes
				: 0,
			[],
			billedMinutes,
			lease.priceMicrosPerMinute,
		);
		if (!Number.isSafeInteger(quote.paid))
			throw new Error("unsafe settlement cost");
		lease.billedFreeMinutes = quote.reservedFree;
		lease.paidMicros = quote.paid;
		lease.settledAt = at;
		lease.usageCompletedAt = completedAt;
		if (result) lease.result = result;
		await this.append(c, lease, "ci.HostSettled", at);
		if (unmet) await this.queueInside(c, unmet, at);
		return lease;
	}
	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt?: string,
		result?: PipelineResult,
	) {
		return this.tx((c) =>
			this.settleInside(
				c,
				id,
				hostRunId,
				billedMinutes,
				at,
				unmet,
				completedAt,
				result,
			),
		);
	}
	settleObserved(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet: Job | undefined,
		completedAt: string,
		observed: Pick<Lease, "state" | "hostRunId" | "runnerId">,
	) {
		return this.tx(async (c) => {
			const current = await this.readLease(c, id);
			if (
				!current ||
				current.state !== observed.state ||
				current.hostRunId !== observed.hostRunId ||
				current.runnerId !== observed.runnerId
			)
				return undefined;
			return this.settleInside(
				c,
				id,
				hostRunId,
				billedMinutes,
				at,
				unmet,
				completedAt,
			);
		});
	}
	/** Bind a quota to the verified lease and sandbox. The caller is the trusted control plane. */
	configureSandboxEgress(
		accountId: string,
		leaseId: string,
		sandboxId: string,
		maxBytes: number,
		expectedRevision: number,
	) {
		if (!sandboxId || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
			throw new Error("invalid sandbox egress limit");
		return this.tx(async (client) => {
			await this.checkRevision(client, expectedRevision);
			const lease = await this.readLease(client, leaseId);
			if (
				!lease ||
				lease.accountId !== accountId ||
				!ACTIVE_STATES.has(lease.state) ||
				lease.sandboxSessionId !== sandboxId ||
				!lease.sandboxPricing ||
				lease.sandboxPricing.maxEgressBytes !== maxBytes
			)
				throw new Error("sandbox quota binding invalid");
			const existing = (
				await client.query<{
					lease_id: string;
					account_id: string;
					max_bytes: string;
				}>(
					"SELECT lease_id,account_id,max_bytes FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2",
					[this.partition, sandboxId],
				)
			).rows[0];
			if (existing) {
				if (
					existing.lease_id !== leaseId ||
					existing.account_id !== accountId ||
					Number(existing.max_bytes) !== maxBytes
				)
					throw new Error("sandbox quota already bound");
				return;
			}
			await client.query(
				"INSERT INTO hobo_ci_sandbox_egress(partition_id,sandbox_id,lease_id,account_id,max_bytes) VALUES($1,$2,$3,$4,$5)",
				[this.partition, sandboxId, leaseId, accountId, maxBytes],
			);
		});
	}
	/** Reserve bytes before forwarding. Ambiguous writes are never refunded. */
	async reserveSandboxEgress(
		sandboxId: string,
		byteCount: number,
	): Promise<boolean> {
		if (!sandboxId || !Number.isSafeInteger(byteCount) || byteCount <= 0)
			throw new Error("invalid egress reservation");
		return this.tx(async (client) => {
			const row = (
				await client.query<{
					lease_id: string;
					account_id: string;
					max_bytes: string;
					used_bytes: string;
				}>(
					"SELECT lease_id,account_id,max_bytes,used_bytes FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2",
					[this.partition, sandboxId],
				)
			).rows[0];
			if (!row) return false;
			const lease = await this.readLease(client, row.lease_id);
			if (
				!lease ||
				lease.accountId !== row.account_id ||
				!ACTIVE_STATES.has(lease.state) ||
				lease.sandboxSessionId !== sandboxId ||
				lease.sandboxPricing?.proxyVmRequired === true
			)
				return false;
			const used = Number(row.used_bytes),
				limit = Number(row.max_bytes);
			if (
				!Number.isSafeInteger(used) ||
				!Number.isSafeInteger(limit) ||
				used < 0 ||
				limit < 0 ||
				byteCount > limit - used
			)
				return false;
			await client.query(
				"UPDATE hobo_ci_sandbox_egress SET used_bytes=used_bytes+$3 WHERE partition_id=$1 AND sandbox_id=$2",
				[this.partition, sandboxId, byteCount],
			);
			return true;
		});
	}
	/** Bind a private proxy credential to one active lease and its proxy VM. */
	configureSandboxProxy(
		accountId: string,
		leaseId: string,
		proxySessionId: string,
		tokenSha256: string,
		expectedRevision: number,
	): Promise<void> {
		if (!/^[a-f0-9]{64}$/.test(tokenSha256) || !proxySessionId)
			return Promise.reject(new Error("invalid proxy binding"));
		return this.tx(async (client) => {
			await this.checkRevision(client, expectedRevision);
			const lease = await this.readLease(client, leaseId);
			if (
				!lease ||
				lease.accountId !== accountId ||
				!ACTIVE_STATES.has(lease.state) ||
				!lease.sandboxPricing?.proxyVmRequired ||
				lease.proxySandboxSessionId !== proxySessionId ||
				!["created", "starting", "running"].includes(lease.proxySandboxStage)
			)
				throw new Error("sandbox proxy binding invalid");
			const existing = (
				await client.query<{
					account_id: string;
					proxy_session_id: string;
					token_sha256: string;
				}>(
					"SELECT account_id,proxy_session_id,token_sha256 FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND lease_id=$2",
					[this.partition, leaseId],
				)
			).rows[0];
			if (existing) {
				if (
					existing.account_id !== accountId ||
					existing.proxy_session_id !== proxySessionId ||
					!timingSafeEqual(
						Buffer.from(existing.token_sha256, "hex"),
						Buffer.from(tokenSha256, "hex"),
					)
				)
					throw new Error("sandbox proxy already bound");
				return;
			}
			await client.query(
				"INSERT INTO hobo_ci_sandbox_proxies(partition_id,lease_id,account_id,proxy_session_id,token_sha256) VALUES($1,$2,$3,$4,$5)",
				[this.partition, leaseId, accountId, proxySessionId, tokenSha256],
			);
		});
	}
	/** Resolve a scoped proxy token without disclosing whether the lease exists. */
	async authenticateSandboxProxy(
		tokenSha256: string,
	): Promise<
		{ accountId: string; leaseId: string; proxySessionId: string } | undefined
	> {
		if (!/^[a-f0-9]{64}$/.test(tokenSha256)) return undefined;
		await this.initialize();
		// Reject guessed tokens with an indexed read. They never acquire the
		// partition lock and cannot stall policy and allocation transactions.
		const preflight = (
			await this.pool.query<{ lease_id: string }>(
				"SELECT lease_id FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND token_sha256=$2",
				[this.partition, tokenSha256],
			)
		).rows[0];
		if (!preflight) return undefined;
		return this.tx(async (client) => {
			const row = (
				await client.query<{
					account_id: string;
					lease_id: string;
					proxy_session_id: string;
					token_sha256: string;
					attempted_calls: string;
				}>(
					"SELECT account_id,lease_id,proxy_session_id,token_sha256,attempted_calls FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND lease_id=$2",
					[this.partition, preflight.lease_id],
				)
			).rows[0];
			if (
				!row ||
				!/^[a-f0-9]{64}$/.test(row.token_sha256) ||
				!timingSafeEqual(
					Buffer.from(row.token_sha256, "hex"),
					Buffer.from(tokenSha256, "hex"),
				)
			)
				return undefined;
			const lease = await this.readLease(client, row.lease_id);
			if (
				!lease ||
				lease.accountId !== row.account_id ||
				!ACTIVE_STATES.has(lease.state) ||
				!lease.sandboxPricing?.proxyVmRequired ||
				lease.proxySandboxSessionId !== row.proxy_session_id ||
				lease.proxySandboxStage !== "running" ||
				!lease.sandboxSessionId ||
				!["created", "registering", "starting", "running"].includes(
					lease.sandboxStage,
				) ||
				lease.sandboxStoppedUsage ||
				lease.proxyStoppedUsage
			)
				return undefined;
			const count = Number(row.attempted_calls),
				max = lease.sandboxPricing.proxyControlMaxCalls;
			if (
				!Number.isSafeInteger(count) ||
				count < 0 ||
				count >= Number.MAX_SAFE_INTEGER ||
				!Number.isSafeInteger(max) ||
				max <= 0
			)
				throw new Error("invalid proxy call ledger");
			// Count every authenticated HTTP attempt, including malformed, denied and
			// replayed requests. A well-behaved proxy stops on the first denial.
			await client.query(
				"UPDATE hobo_ci_sandbox_proxies SET attempted_calls=attempted_calls+1 WHERE partition_id=$1 AND lease_id=$2",
				[this.partition, row.lease_id],
			);
			if (count >= max) return undefined;
			return {
				accountId: row.account_id,
				leaseId: row.lease_id,
				proxySessionId: row.proxy_session_id,
			};
		});
	}

	/** A unique authorization grants one forwarding operation; duplicates fail closed. */
	reserveSandboxProxyEgress(
		leaseId: string,
		proxySessionId: string,
		tokenSha256: string,
		sandboxId: string,
		byteCount: number,
		requestId: string,
	): Promise<boolean> {
		if (
			!/^[a-f0-9]{64}$/.test(tokenSha256) ||
			!/^[a-f0-9-]{36}$/.test(requestId) ||
			!sandboxId ||
			!proxySessionId ||
			!Number.isSafeInteger(byteCount) ||
			byteCount <= 0 ||
			byteCount > 4 * 1024 * 1024
		)
			return Promise.resolve(false);
		return this.tx(async (client) => {
			const lease = await this.readLease(client, leaseId);
			if (
				!lease ||
				!ACTIVE_STATES.has(lease.state) ||
				!lease.sandboxPricing?.proxyVmRequired ||
				lease.proxySandboxStage !== "running" ||
				lease.proxySandboxSessionId !== proxySessionId ||
				lease.sandboxSessionId !== sandboxId ||
				!["created", "registering", "starting", "running"].includes(
					lease.sandboxStage,
				) ||
				lease.sandboxStoppedUsage ||
				lease.proxyStoppedUsage
			)
				return false;
			const binding = (
				await client.query<{
					account_id: string;
					proxy_session_id: string;
					token_sha256: string;
				}>(
					"SELECT account_id,proxy_session_id,token_sha256 FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND lease_id=$2",
					[this.partition, leaseId],
				)
			).rows[0];
			if (
				!binding ||
				binding.account_id !== lease.accountId ||
				binding.proxy_session_id !== proxySessionId ||
				!/^[a-f0-9]{64}$/.test(binding.token_sha256) ||
				!timingSafeEqual(
					Buffer.from(binding.token_sha256, "hex"),
					Buffer.from(tokenSha256, "hex"),
				)
			)
				return false;
			const quota = (
				await client.query<{
					account_id: string;
					lease_id: string;
					max_bytes: string;
					used_bytes: string;
				}>(
					"SELECT account_id,lease_id,max_bytes,used_bytes FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2",
					[this.partition, sandboxId],
				)
			).rows[0];
			if (
				!quota ||
				quota.account_id !== lease.accountId ||
				quota.lease_id !== leaseId
			)
				return false;
			const limit = Number(quota.max_bytes),
				used = Number(quota.used_bytes),
				maxCalls = lease.sandboxPricing.proxyControlMaxCalls;
			if (
				!Number.isSafeInteger(used) ||
				!Number.isSafeInteger(limit) ||
				!Number.isSafeInteger(maxCalls) ||
				used < 0 ||
				limit < 0 ||
				maxCalls <= 0 ||
				limit !== lease.sandboxPricing.maxEgressBytes ||
				byteCount > limit - used
			)
				return false;
			const now = Date.now();
			const stats = (
				await client.query<{ total: string; recent: string }>(
					"SELECT count(*)::text AS total, count(*) FILTER (WHERE created_ms>$3)::text AS recent FROM hobo_ci_sandbox_proxy_requests WHERE partition_id=$1 AND lease_id=$2",
					[this.partition, leaseId, now - 60000],
				)
			).rows[0];
			if (
				!stats ||
				Number(stats.total) >= maxCalls ||
				Number(stats.recent) >= 600
			)
				return false;
			const inserted = await client.query(
				"INSERT INTO hobo_ci_sandbox_proxy_requests(partition_id,lease_id,request_id,created_ms,bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
				[this.partition, leaseId, requestId, now, byteCount],
			);
			if (!inserted.rowCount) return false;
			await client.query(
				"UPDATE hobo_ci_sandbox_egress SET used_bytes=used_bytes+$3 WHERE partition_id=$1 AND sandbox_id=$2",
				[this.partition, sandboxId, byteCount],
			);
			return true;
		});
	}
	/** Trusted accounting reads byte and call totals after the proxy has stopped. */
	sandboxProxyUsage(
		accountId: string,
		leaseId: string,
		proxySessionId: string,
		sandboxId: string,
	): Promise<{ bytes: number; calls: number } | undefined> {
		return this.tx(async (client) => {
			const lease = await this.readLease(client, leaseId);
			if (
				!lease ||
				lease.accountId !== accountId ||
				lease.proxySandboxSessionId !== proxySessionId ||
				lease.sandboxSessionId !== sandboxId ||
				lease.proxySandboxStage !== "stopped" ||
				!lease.proxyStoppedUsage
			)
				return undefined;
			const row = (
				await client.query<{ attempted_calls: string }>(
					"SELECT attempted_calls FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND lease_id=$2 AND account_id=$3 AND proxy_session_id=$4",
					[this.partition, leaseId, accountId, proxySessionId],
				)
			).rows[0];
			const preJit =
				lease.runnerId === 0 &&
				!lease.sandboxCommandId &&
				["created", "creating"].includes(lease.sandboxStopFromStage);
			if (
				!row &&
				((sandboxId && !preJit) ||
					(!sandboxId && lease.sandboxStage !== "pending"))
			)
				return undefined;
			let bytes = 0;
			if (sandboxId) {
				const quota = (
					await client.query<{ used_bytes: string }>(
						"SELECT used_bytes FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2 AND lease_id=$3 AND account_id=$4",
						[this.partition, sandboxId, leaseId, accountId],
					)
				).rows[0];
				if (!quota && !preJit) return undefined;
				bytes = quota ? Number(quota.used_bytes) : 0;
			} else if (lease.sandboxStage !== "pending") return undefined;
			const calls = row ? Number(row.attempted_calls) : 0;
			if (
				!Number.isSafeInteger(bytes) ||
				bytes < 0 ||
				!Number.isSafeInteger(calls) ||
				calls < 0
			)
				throw new Error("invalid proxy usage");
			return { bytes, calls };
		});
	}

	/** Read proxy bytes only for the exact authenticated account, lease and VM. */
	sandboxEgressUsage(
		accountId: string,
		leaseId: string,
		sandboxId: string,
	): Promise<number | undefined> {
		return this.tx(async (client) => {
			const lease = await this.readLease(client, leaseId);
			if (
				!lease ||
				lease.accountId !== accountId ||
				lease.sandboxSessionId !== sandboxId
			)
				return undefined;
			const row = (
				await client.query<{ used_bytes: string }>(
					"SELECT used_bytes FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2 AND lease_id=$3 AND account_id=$4",
					[this.partition, sandboxId, leaseId, accountId],
				)
			).rows[0];
			if (!row) return undefined;
			const used = Number(row.used_bytes);
			if (!Number.isSafeInteger(used) || used < 0)
				throw new Error("invalid recorded egress");
			return used;
		});
	}
	/** Settle verified native runner cost without assuming per-minute billing. */
	settleSandboxObserved(
		id: string,
		at: string,
		completedAt: string,
		observed: Pick<
			Lease,
			| "state"
			| "runnerId"
			| "actualJobId"
			| "sandboxSessionId"
			| "sandboxCommandId"
			| "sandboxStage"
		> &
			Partial<
				Pick<
					Lease,
					| "proxySandboxSessionId"
					| "proxySandboxCommandId"
					| "proxySandboxStage"
				>
			>,
		chargedMicros: number,
		unmet?: Job,
		usedAllowance?: SandboxAllowance,
	) {
		return this.tx(async (client) => {
			if (
				!Number.isSafeInteger(chargedMicros) ||
				chargedMicros < 0 ||
				!Number.isFinite(Date.parse(completedAt))
			)
				throw new Error("invalid sandbox settlement");
			const lease = await this.readLease(client, id);
			if (
				!lease ||
				!ACTIVE_STATES.has(lease.state) ||
				lease.state !== observed.state ||
				lease.runnerId !== observed.runnerId ||
				lease.actualJobId !== observed.actualJobId ||
				lease.sandboxSessionId !== observed.sandboxSessionId ||
				lease.sandboxCommandId !== observed.sandboxCommandId ||
				lease.sandboxStage !== observed.sandboxStage
			)
				return undefined;
			if (lease.provider !== "vercel" || !lease.sandboxPricing)
				throw new Error("sandbox pricing identity missing");
			// An unknown post-start assignment can be financially settled only
			// by the two-VM path, which revalidates both measured stop proofs,
			// proxy meters and runner deletion below.
			if (
				lease.runnerId &&
				!lease.actualJobId &&
				lease.sandboxStopFromStage !== "registering" &&
				!lease.sandboxPricing.proxyVmRequired
			)
				throw new Error(
					"unknown assignment requires measured proxy settlement",
				);
			if (
				!lease.sandboxPricing.proxyVmRequired &&
				(!lease.sandboxSessionId ||
					(!lease.sandboxCommandId &&
						(!(
							lease.sandboxStage === "creating" ||
							lease.sandboxStage === "created"
						) ||
							lease.runnerId !== 0)))
			)
				throw new Error("sandbox identity missing");
			if (lease.sandboxPricing.proxyVmRequired) {
				if (
					lease.priceMicrosPerMinute !== 0 ||
					lease.proxySandboxStage !== "stopped" ||
					!lease.proxySandboxSessionId ||
					observed.proxySandboxSessionId !== lease.proxySandboxSessionId ||
					observed.proxySandboxCommandId !== lease.proxySandboxCommandId ||
					observed.proxySandboxStage !== lease.proxySandboxStage
				)
					throw new Error("sandbox proxy stop fence invalid");
				const pricing = lease.sandboxPricing;
				const proxy = measuredUsage(
					lease.proxyStoppedUsage,
					lease.proxySandboxSessionId,
					pricing.proxyVmVcpus,
					pricing.proxyVmMemoryMb,
					at,
				);
				const guestPending =
					lease.sandboxStage === "pending" &&
					!lease.sandboxSessionId &&
					!lease.sandboxCommandId &&
					!lease.sandboxStoppedUsage &&
					lease.runnerId === 0;
				let guest: SandboxMeasuredUsage | undefined;
				if (!guestPending) {
					if (
						lease.sandboxStage !== "stopped" ||
						!lease.sandboxSessionId ||
						lease.sandboxSessionId === lease.proxySandboxSessionId
					)
						throw new Error("sandbox guest stop fence invalid");
					if (
						lease.runnerId === 0 &&
						!["created", "creating"].includes(lease.sandboxStopFromStage)
					)
						throw new Error("sandbox runner registration unresolved");
					if (lease.runnerId > 0 && !lease.runnerDeletionConfirmed)
						throw new Error("sandbox runner deletion unconfirmed");
					guest = measuredUsage(
						lease.sandboxStoppedUsage,
						lease.sandboxSessionId,
						pricing.vcpus,
						pricing.memoryMb,
						at,
					);
				}
				if (
					Date.parse(completedAt) <
						Math.max(
							Date.parse(proxy.stoppedAt),
							guest ? Date.parse(guest.stoppedAt) : 0,
						) ||
					Date.parse(completedAt) > Date.parse(at)
				)
					throw new Error("sandbox completion time mismatch");
				const proxyBinding = (
					await client.query<{
						account_id: string;
						proxy_session_id: string;
						attempted_calls: string;
					}>(
						"SELECT account_id,proxy_session_id,attempted_calls FROM hobo_ci_sandbox_proxies WHERE partition_id=$1 AND lease_id=$2",
						[this.partition, id],
					)
				).rows[0];
				if (
					proxyBinding &&
					(proxyBinding.account_id !== lease.accountId ||
						proxyBinding.proxy_session_id !== lease.proxySandboxSessionId)
				)
					throw new Error("sandbox proxy meter mismatch");
				const calls = proxyBinding ? Number(proxyBinding.attempted_calls) : 0;
				const preJit =
					lease.runnerId === 0 &&
					!lease.sandboxCommandId &&
					["created", "creating"].includes(lease.sandboxStopFromStage);
				if (
					!Number.isSafeInteger(calls) ||
					calls < 0 ||
					(!proxyBinding && guest && !preJit)
				)
					throw new Error("sandbox proxy meter unavailable");
				let bytes = 0;
				if (guest) {
					const quota = (
						await client.query<{
							used_bytes: string;
							account_id: string;
							lease_id: string;
						}>(
							"SELECT used_bytes,account_id,lease_id FROM hobo_ci_sandbox_egress WHERE partition_id=$1 AND sandbox_id=$2",
							[this.partition, lease.sandboxSessionId],
						)
					).rows[0];
					if (
						(!quota && !preJit) ||
						(quota &&
							(quota.account_id !== lease.accountId ||
								quota.lease_id !== lease.id))
					)
						throw new Error("sandbox egress meter unavailable");
					bytes = quota ? Number(quota.used_bytes) : 0;
				}
				if (!Number.isSafeInteger(bytes) || bytes < 0)
					throw new Error("invalid sandbox egress meter");
				const free =
					Date.parse(completedAt) <= Date.parse(lease.freeValidUntil)
						? lease.sandboxReservedAllowance
						: undefined;
				const proxyVm = {
					cpuVcpuMs: proxy.durationMs * proxy.vcpus,
					memoryMb: proxy.memoryMb,
					durationMs: proxy.durationMs,
					ingressBytes: proxy.ingressBytes,
					egressBytes: proxy.egressBytes,
				};
				const quote = guest
					? sandboxUsageQuote(
							pricing,
							{
								cpuVcpuMs: guest.durationMs * guest.vcpus,
								memoryMb: guest.memoryMb,
								durationMs: guest.durationMs,
								egressBytes: guest.egressBytes,
								proxyBytes: bytes,
								proxyControlCalls: calls,
								proxyVm,
								hostMicros: 0,
							},
							free,
						)
					: sandboxProxyOnlyUsageQuote(
							pricing,
							{
								proxyVm,
								proxyBytes: bytes,
								proxyControlCalls: calls,
								hostMicros: 0,
							},
							free,
						);
				if (
					chargedMicros !== quote.paidMicros ||
					!usedAllowance ||
					toJsonString(SandboxAllowanceSchema, usedAllowance) !==
						toJsonString(SandboxAllowanceSchema, quote.usedAllowance)
				)
					throw new Error("sandbox charge differs from verified usage");
			}
			if (lease.reservedFreeMinutes !== 0)
				throw new Error("sandbox free allocation accounting unavailable");
			const fields = [
				"cpuVcpuMs",
				"memoryMbMs",
				"egressBytes",
				"creations",
				"proxyBytes",
				"proxySessions",
				"proxyControlCalls",
			] as const;
			const reserved = lease.sandboxReservedAllowance;
			if (
				!usedAllowance &&
				reserved &&
				fields.some((field) => reserved[field] > 0)
			)
				throw new Error("sandbox usage allowance missing");
			const used = usedAllowance ?? create(SandboxAllowanceSchema);
			for (const field of fields) {
				if (
					!Number.isSafeInteger(used[field]) ||
					used[field] < 0 ||
					used[field] > (reserved?.[field] ?? 0)
				)
					throw new Error("invalid sandbox usage allowance");
			}
			if (
				fields.some((field) => used[field] > 0) &&
				(!Number.isFinite(Date.parse(lease.freeValidUntil)) ||
					Date.parse(completedAt) > Date.parse(lease.freeValidUntil))
			)
				throw new Error("sandbox free allowance expired");
			lease.sandboxUsedAllowance = clone(SandboxAllowanceSchema, used);
			lease.state = "completed";
			lease.billedMinutes = 0;
			lease.billedFreeMinutes = 0;
			lease.paidMicros = chargedMicros;
			lease.settledAt = at;
			lease.usageCompletedAt = completedAt;
			await this.append(client, lease, "ci.HostSettled", at);
			if (
				lease.runnerId &&
				!lease.actualJobId &&
				lease.sandboxStopFromStage !== "registering"
			)
				await this.event(
					client,
					"ci.AssignmentUnknown",
					at,
					toJsonString(LeaseSchema, lease),
					lease.accountId,
					lease.id,
				);
			if (chargedMicros > lease.reservedPaidMicros)
				await this.append(client, lease, "ci.BudgetOverrun", at);
			if (unmet) await this.queueInside(client, unmet, at);
			return lease;
		});
	}
	/** A fingerprint tombstone remains after acknowledgement for delivery deduplication. */
	hasWebhook(deliveryId: string): Promise<boolean> {
		if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId))
			return Promise.resolve(false);
		return this.tx(
			async (client) =>
				(
					await client.query(
						"SELECT 1 FROM hobo_ci_inbox WHERE partition_id=$1 AND delivery_id=$2",
						[this.partition, deliveryId],
					)
				).rowCount === 1,
		);
	}
	async acceptWebhook(input: WebhookInput): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, false);
	}
	/** Remember authenticated deliveries for installations without a current connection. */
	async acceptIgnoredWebhook(
		input: WebhookInput,
	): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, true);
	}
	private async acceptDelivery(
		input: WebhookInput,
		ignored: boolean,
	): Promise<{ duplicate: boolean }> {
		const at = Date.parse(input.receivedAt);
		if (
			!/^[A-Za-z0-9-]{1,128}$/.test(input.deliveryId) ||
			!["workflow_job", "workflow_run"].includes(input.event) ||
			!Number.isSafeInteger(input.installationId) ||
			input.installationId <= 0 ||
			!Number.isSafeInteger(input.repositoryId) ||
			input.repositoryId <= 0 ||
			input.rawBody.byteLength > MAX_WEBHOOK_BYTES ||
			!Number.isSafeInteger(at)
		)
			throw new Error("invalid webhook envelope");
		const fingerprint = createHash("sha256")
			.update(input.event)
			.update("\0")
			.update(String(input.installationId))
			.update("\0")
			.update(String(input.repositoryId))
			.update("\0")
			.update(input.rawBody)
			.digest("hex");
		// GitHub signs body bytes only, not delivery ID or event headers. Exact
		// signed-body replays have identical semantics and need no extra row.
		const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
		return this.tx(async (client) => {
			const existing = (
				await client.query<{ fingerprint: string }>(
					"SELECT fingerprint FROM hobo_ci_inbox WHERE partition_id=$1 AND delivery_id=$2",
					[this.partition, input.deliveryId],
				)
			).rows[0];
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new Error("conflicting webhook delivery id");
				return { duplicate: true };
			}
			const replay = await client.query(
				"SELECT 1 FROM hobo_ci_inbox WHERE partition_id=$1 AND installation_id=$2 AND body_hash=$3 AND received_ms>=$4 LIMIT 1",
				[
					this.partition,
					input.installationId,
					bodyHash,
					at - WEBHOOK_BODY_REPLAY_WINDOW_MS,
				],
			);
			if (replay.rowCount) return { duplicate: true };
			const counts = (
				await client.query<{
					recent: string;
					outstanding: string;
					bytes: string;
				}>(
					`SELECT
				COUNT(*) FILTER (WHERE received_ms > $3)::text AS recent,
				COUNT(*) FILTER (WHERE NOT completed)::text AS outstanding,
				COALESCE(SUM(octet_length(raw_body)) FILTER (WHERE NOT completed),0)::text AS bytes
				FROM hobo_ci_inbox WHERE partition_id=$1 AND installation_id=$2 AND (received_ms > $3 OR NOT completed)`,
					[this.partition, input.installationId, at - WEBHOOK_RATE_WINDOW_MS],
				)
			).rows[0];
			if (
				!counts ||
				Number(counts.recent) >= MAX_WEBHOOKS_PER_INSTALLATION_WINDOW ||
				Number(counts.outstanding) >=
					MAX_OUTSTANDING_WEBHOOKS_PER_INSTALLATION ||
				Number(counts.bytes) + (ignored ? 0 : input.rawBody.byteLength) >
					MAX_OUTSTANDING_WEBHOOK_BYTES_PER_INSTALLATION
			)
				throw new Error("webhook admission limit reached");
			await client.query(
				`INSERT INTO hobo_ci_inbox(partition_id,delivery_id,fingerprint,event,installation_id,repository_id,raw_body,received_at,body_hash,received_ms,completed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				[
					this.partition,
					input.deliveryId,
					fingerprint,
					input.event,
					input.installationId,
					input.repositoryId,
					ignored ? Buffer.alloc(0) : Buffer.from(input.rawBody),
					input.receivedAt,
					bodyHash,
					at,
					ignored,
				],
			);
			return { duplicate: false };
		});
	}

	async claimWebhook(
		now: string,
		leaseMs: number,
	): Promise<ClaimedWebhook | undefined> {
		const at = Date.parse(now);
		if (
			!Number.isFinite(at) ||
			!Number.isSafeInteger(leaseMs) ||
			leaseMs < 1000 ||
			leaseMs > 300000
		)
			throw new Error("invalid webhook claim");
		return this.tx(async (c) => {
			await c.query(
				"UPDATE hobo_ci_inbox SET quarantined=true,claim_token=NULL WHERE partition_id=$1 AND NOT completed AND NOT quarantined AND attempts>=8 AND claim_token IS NOT NULL AND claim_until<=$2",
				[this.partition, at],
			);
			const row = (
				await c.query<{
					delivery_id: string;
					event: string;
					installation_id: string;
					repository_id: string;
					raw_body: Buffer;
					received_at: string;
				}>(
					"SELECT delivery_id,event,installation_id,repository_id,raw_body,received_at FROM hobo_ci_inbox WHERE partition_id=$1 AND NOT completed AND NOT quarantined AND claim_until<=$2 ORDER BY seq LIMIT 1",
					[this.partition, at],
				)
			).rows[0];
			if (!row) return undefined;
			const token = randomUUID();
			await c.query(
				"UPDATE hobo_ci_inbox SET claim_token=$3,claim_until=$4,attempts=attempts+1 WHERE partition_id=$1 AND delivery_id=$2",
				[this.partition, row.delivery_id, token, at + leaseMs],
			);
			return {
				deliveryId: row.delivery_id,
				event: row.event,
				installationId: Number(row.installation_id),
				repositoryId: Number(row.repository_id),
				rawBody: Uint8Array.from(row.raw_body),
				receivedAt: row.received_at,
				token,
			};
		});
	}
	ackWebhook(deliveryId: string, token: string) {
		return this.tx(
			async (c) =>
				(
					await c.query(
						"UPDATE hobo_ci_inbox SET completed=true,raw_body=''::bytea,claim_token=NULL,claim_until=0 WHERE partition_id=$1 AND delivery_id=$2 AND claim_token=$3 AND NOT completed",
						[this.partition, deliveryId, token],
					)
				).rowCount === 1,
		);
	}
	releaseWebhook(deliveryId: string, token: string) {
		return this.tx(
			async (c) =>
				(
					await c.query(
						"UPDATE hobo_ci_inbox SET claim_token=NULL,claim_until=0 WHERE partition_id=$1 AND delivery_id=$2 AND claim_token=$3 AND NOT completed",
						[this.partition, deliveryId, token],
					)
				).rowCount === 1,
		);
	}
	async failWebhook(
		deliveryId: string,
		token: string,
		now: string,
	): Promise<"retry" | "quarantined" | "stale"> {
		const at = Date.parse(now);
		if (!Number.isFinite(at)) throw new Error("invalid webhook failure time");
		return this.tx(async (c) => {
			const row = (
				await c.query<{ attempts: number }>(
					"SELECT attempts FROM hobo_ci_inbox WHERE partition_id=$1 AND delivery_id=$2 AND claim_token=$3 AND NOT completed AND NOT quarantined",
					[this.partition, deliveryId, token],
				)
			).rows[0];
			if (!row) return "stale";
			if (row.attempts >= 8) {
				await c.query(
					"UPDATE hobo_ci_inbox SET quarantined=true,claim_token=NULL WHERE partition_id=$1 AND delivery_id=$2 AND claim_token=$3",
					[this.partition, deliveryId, token],
				);
				return "quarantined";
			}
			const delay = Math.min(300000, 1000 * 2 ** (row.attempts - 1));
			await c.query(
				"UPDATE hobo_ci_inbox SET claim_token=NULL,claim_until=$4 WHERE partition_id=$1 AND delivery_id=$2 AND claim_token=$3",
				[this.partition, deliveryId, token, at + delay],
			);
			return "retry";
		});
	}
	quarantinedWebhooks(accountId: string, expectedRevision: number) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			const connections =
				(await this.readConfiguration(c))?.configuration?.connections ?? [];
			const rows = (
				await c.query<{
					delivery_id: string;
					event: string;
					installation_id: string;
					repository_id: string;
					received_at: string;
					attempts: number;
				}>(
					"SELECT delivery_id,event,installation_id,repository_id,received_at,attempts FROM hobo_ci_inbox WHERE partition_id=$1 AND NOT completed AND quarantined ORDER BY seq",
					[this.partition],
				)
			).rows;
			return rows
				.filter((row) =>
					connections.some(
						(connection) =>
							connection.accountId === accountId &&
							connection.installationId === Number(row.installation_id) &&
							connection.repositoryId === Number(row.repository_id),
					),
				)
				.slice(0, 100)
				.map((row) => ({
					deliveryId: row.delivery_id,
					event: row.event,
					installationId: Number(row.installation_id),
					repositoryId: Number(row.repository_id),
					receivedAt: row.received_at,
					attempts: row.attempts,
				}));
		});
	}
	retryQuarantinedWebhook(
		accountId: string,
		expectedRevision: number,
		deliveryId: string,
	) {
		return this.tx(async (c) => {
			await this.checkRevision(c, expectedRevision);
			const row = (
				await c.query<{ installation_id: string; repository_id: string }>(
					"SELECT installation_id,repository_id FROM hobo_ci_inbox WHERE partition_id=$1 AND delivery_id=$2 AND NOT completed AND quarantined",
					[this.partition, deliveryId],
				)
			).rows[0];
			if (!row) return false;
			if (
				!(await this.readConfiguration(c))?.configuration?.connections.some(
					(connection) =>
						connection.accountId === accountId &&
						connection.installationId === Number(row.installation_id) &&
						connection.repositoryId === Number(row.repository_id),
				)
			)
				return false;
			return (
				(
					await c.query(
						"UPDATE hobo_ci_inbox SET quarantined=false,attempts=0,claim_until=0,claim_token=NULL WHERE partition_id=$1 AND delivery_id=$2 AND NOT completed AND quarantined",
						[this.partition, deliveryId],
					)
				).rowCount === 1
			);
		});
	}
}
