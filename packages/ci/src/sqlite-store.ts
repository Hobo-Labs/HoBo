import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	BudgetAdmissionDeniedError,
	type BudgetSettlementEvidence,
} from "@hobo/broker";
import { z } from "zod";
import {
	type Account,
	type CiEvent,
	type CiEventPage,
	CiEventSchema,
	type Configuration,
	type ConfigurationState,
	type ControlRecord,
	type Job,
	JobSchema,
	type Lease,
	LeaseSchema,
	type Offer,
	type PipelineResult,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
} from "./_generated/ci_pb.js";
import type { EventCursor } from "./event-log.js";
import {
	ciBudgetIdentity,
	ciBudgetPolicy,
	effectiveCiAccount,
	parseCiPolicy,
} from "./policy.js";
import { ACTIVE_STATES, route } from "./routing.js";
import type { CiSharedBudgetHooks } from "./shared-budget.js";
import {
	ciLeasePolicyMeasurements,
	LeaseStore,
	pinCiQueueDeadline,
	type RateReattestation,
} from "./store.js";
import {
	type ClaimedWebhook,
	isWebhookDeliveryId,
	MAX_OUTSTANDING_WEBHOOK_BYTES_PER_INSTALLATION,
	MAX_OUTSTANDING_WEBHOOKS_PER_INSTALLATION,
	MAX_WEBHOOK_ATTEMPTS,
	MAX_WEBHOOKS_PER_INSTALLATION_WINDOW,
	parseWebhookEnvelope,
	WEBHOOK_BODY_REPLAY_WINDOW_MS,
	WEBHOOK_RATE_WINDOW_MS,
	type WebhookInput,
	webhookRetryDelayMs,
} from "./webhook-inbox.js";

/** Acknowledged tombstones only need to outlive the replay window and any queued/in-progress run. */
const INBOX_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INTENT_EVENT_TYPES = [
	"ci.DispatchRequested",
	"ci.RunnerClaimed",
	"ci.SandboxCreated",
] as const;
function isIsolatedCiOffer(offer: Offer | undefined): boolean {
	return (
		!!offer &&
		((offer.provider === "vercel" &&
			offer.backend === "sandbox" &&
			offer.freeMinutes === 0) ||
			((offer.provider === "kubernetes" ||
				offer.provider === "hobo-box-worker") &&
				offer.backend === "isolated-container" &&
				offer.freeMinutes === 0 &&
				offer.priceMicrosPerMinute === 0))
	);
}

const Body = z.object({ body: z.string() });
const RecordStatus = z.object({ status: z.string() });
const Count = z.number().int().nonnegative();
const InboxRow = z.object({
	delivery_id: z.string(),
	event: z.string(),
	installation_id: z.number().int(),
	repository_id: z.number().int(),
	received_at: z.string(),
});

function jobKey(job: Job): string {
	return `${job.repositoryId}:${job.id}:${job.runAttempt}`;
}

/**
 * Durable single-host CI store over node:sqlite (ADR-0135): the same
 * `HostedInboxStore` contract as `PostgresCiStore`, one file, one writer.
 * The lease journal tables are `LeaseStore`'s, so policy validation and job
 * observation semantics are shared rather than re-implemented. Vercel Sandbox
 * egress/proxy accounting stays Postgres-only. Shared-budget policies require
 * trusted hooks and fail closed without them. A SQLite budget authority must
 * use a separate database file because its synchronous transaction commits
 * independently while the lease journal holds its own writer lock.
 */
export class SqliteCiStore {
	private readonly db: DatabaseSync;
	private readonly leases: LeaseStore;
	constructor(
		path: string,
		private readonly options: { sharedBudget?: CiSharedBudgetHooks } = {},
	) {
		this.db = new DatabaseSync(path);
		this.leases = new LeaseStore(path, this.db, options);
		this.db.exec(`CREATE INDEX IF NOT EXISTS leases_job_key ON leases(job_key);
   CREATE INDEX IF NOT EXISTS leases_state ON leases(json_extract(body,'$.state'));
   CREATE INDEX IF NOT EXISTS leases_account ON leases(json_extract(body,'$.accountId'));
   CREATE INDEX IF NOT EXISTS events_lease_type ON events(json_extract(body,'$.leaseId'), json_extract(body,'$.type'));
   CREATE TABLE IF NOT EXISTS webhook_inbox (
     seq INTEGER PRIMARY KEY,
     delivery_id TEXT NOT NULL UNIQUE,
     fingerprint TEXT NOT NULL,
     event TEXT NOT NULL,
     installation_id INTEGER NOT NULL,
     repository_id INTEGER NOT NULL,
     raw_body BLOB NOT NULL,
     received_at TEXT NOT NULL,
     body_hash TEXT NOT NULL,
     received_ms INTEGER NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0,
     quarantined INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     claim_token TEXT,
     claim_until INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS webhook_inbox_replay ON webhook_inbox(installation_id, body_hash, received_ms);
   CREATE INDEX IF NOT EXISTS webhook_inbox_open ON webhook_inbox(completed, quarantined, claim_until);`);
	}
	close(): void {
		this.db.close();
	}
	private tx<T>(fn: () => T): Promise<T> {
		try {
			return Promise.resolve(this.leases.atomic(fn));
		} catch (error) {
			return Promise.reject(error);
		}
	}
	private read<T>(fn: () => T): Promise<T> {
		try {
			return Promise.resolve(fn());
		} catch (error) {
			return Promise.reject(error);
		}
	}
	private checkRevision(expected: number | undefined): void {
		if (
			expected !== undefined &&
			this.leases.configuration()?.revision !== expected
		)
			throw new Error("configuration revision conflict");
	}
	private leasesWhere(sql: string, ...params: string[]): Lease[] {
		return this.db
			.prepare(`SELECT body FROM leases WHERE ${sql} ORDER BY id`)
			.all(...params)
			.map((row) => fromJsonString(LeaseSchema, Body.parse(row).body));
	}
	private activeLeasesInside(): Lease[] {
		return this.leasesWhere(
			"json_extract(body,'$.state') IN (SELECT value FROM json_each(?))",
			JSON.stringify([...ACTIVE_STATES]),
		);
	}
	private exists(table: "terminal_jobs" | "assigned_jobs", key: string) {
		return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE job_key=?`).get(key);
	}
	private append(lease: Lease, type: string, at: string): void {
		const body = toJsonString(LeaseSchema, lease);
		this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
			toJsonString(
				CiEventSchema,
				create(CiEventSchema, {
					type,
					at,
					accountId: lease.accountId,
					leaseId: lease.id,
					detail: body,
				}),
			),
		);
		this.db
			.prepare(
				"INSERT INTO leases(id, job_key, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
			)
			.run(
				lease.id,
				lease.pipelineId
					? `pipeline:${lease.accountId}:${lease.pipelineId}`
					: `${lease.repositoryId}:${lease.jobId}:${lease.runAttempt}`,
				body,
			);
	}

	async ready(): Promise<boolean> {
		try {
			this.db.prepare("SELECT 1").get();
			return true;
		} catch {
			return false;
		}
	}
	configuration(): Promise<ConfigurationState | undefined> {
		return this.read(() => this.leases.configuration());
	}
	policySnapshot(): Promise<{
		state: ConfigurationState | undefined;
		policies: { accountId: string; bodyJson: string }[];
	}> {
		return this.read(() => {
			const state = this.leases.configuration();
			const policies = [];
			for (const account of state?.configuration?.accounts ?? []) {
				const record = this.leases.controlRecord(`ci-policy:${account.id}`);
				if (record)
					policies.push({ accountId: account.id, bodyJson: record.bodyJson });
			}
			return { state, policies };
		});
	}
	configure(
		config: Configuration,
		revision: number,
		at: string,
	): Promise<ConfigurationState> {
		return this.tx(() => this.leases.configure(config, revision, at));
	}
	reattestRate(
		input: RateReattestation,
		revision: number,
		at: string,
	): Promise<ConfigurationState> {
		return this.tx(() => this.leases.reattestRate(input, revision, at));
	}
	configureWithRecord(
		config: Configuration,
		revision: number,
		at: string,
		key: string,
		accountId: string,
		bodyJson: string,
	): Promise<ConfigurationState> {
		return this.tx(() =>
			this.leases.configureWithRecord(
				config,
				revision,
				at,
				key,
				accountId,
				bodyJson,
			),
		);
	}
	controlRecord(key: string): Promise<ControlRecord | undefined> {
		return this.read(() => this.leases.controlRecord(key));
	}
	putControlRecord(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
	): Promise<void> {
		return this.tx(() =>
			this.leases.putControlRecord(key, accountId, bodyJson, at),
		);
	}
	/**
	 * Write a record whose `status` never leaves `terminalStatus` once it is
	 * there: a late writer carrying an earlier status gets the stored record back.
	 */
	putControlRecordMonotonic(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
		terminalStatus: string,
	): Promise<ControlRecord | undefined> {
		return this.tx(() => {
			const incoming = RecordStatus.parse(JSON.parse(bodyJson));
			const old = this.leases.controlRecord(key);
			if (old && old.accountId !== accountId)
				throw new Error("control record belongs to another account");
			if (
				old &&
				RecordStatus.parse(JSON.parse(old.bodyJson)).status ===
					terminalStatus &&
				incoming.status !== terminalStatus
			)
				return old;
			this.leases.putControlRecord(key, accountId, bodyJson, at);
			return this.leases.controlRecord(key);
		});
	}
	all(): Promise<Lease[]> {
		return this.read(() => this.leases.all());
	}
	activeLeases(): Promise<Lease[]> {
		return this.read(() => this.activeLeasesInside());
	}
	accountLeases(accountId: string): Promise<Lease[]> {
		return this.read(() =>
			this.leasesWhere("json_extract(body,'$.accountId')=?", accountId),
		);
	}
	get(id: string): Promise<Lease | undefined> {
		return this.read(() => this.leases.get(id));
	}
	events(): Promise<CiEvent[]> {
		return this.read(() => this.leases.events());
	}
	/** An account's events after a log position, or its newest ones. */
	eventsSince(cursor: EventCursor): Promise<CiEventPage> {
		return this.read(() => this.leases.eventsSince(cursor));
	}
	/** Latest dispatch/claim intent for each lease, without scanning history. */
	latestLeaseIntents(ids: readonly string[]): Promise<CiEvent[]> {
		if (ids.length === 0) return Promise.resolve([]);
		return this.read(() =>
			this.db
				.prepare(
					`SELECT body FROM events WHERE seq IN (
					   SELECT MAX(seq) FROM events
					   WHERE json_extract(body,'$.leaseId') IN (SELECT value FROM json_each(?))
					     AND json_extract(body,'$.type') IN (SELECT value FROM json_each(?))
					   GROUP BY json_extract(body,'$.leaseId'), json_extract(body,'$.type'))
					 ORDER BY seq`,
				)
				.all(JSON.stringify(ids), JSON.stringify(INTENT_EVENT_TYPES))
				.map((row) => fromJsonString(CiEventSchema, Body.parse(row).body)),
		);
	}
	pendingJobs(): Promise<Job[]> {
		return this.read(() => this.leases.pendingJobs());
	}
	assignedJob(
		job: Job,
	): Promise<{ leaseId: string; version: string } | undefined> {
		return this.read(() => this.leases.assignedJob(job));
	}
	clearAssignedJob(
		job: Job,
		leaseId: string,
		version: string,
		at: string,
		expectedRevision: number,
	): Promise<boolean> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			return this.leases.clearAssignedJob(job, leaseId, version, at);
		});
	}
	queue(job: Job, at: string, expectedRevision?: number): Promise<void> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			this.leases.queue(job, at);
		});
	}
	observe(job: Job, at: string, expectedRevision?: number): Promise<void> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			this.leases.observe(job, at);
		});
	}
	/** Reconstruct the earliest queue receipt and pin its policy deadline across retries. */
	private queueHistory(job: Job, at: string, account: Account) {
		const prior = this.leases
			.events()
			.filter((event) => event.type === "ci.JobQueued")
			.map((event) => ({
				job: fromJsonString(JobSchema, event.detail),
				at: event.at,
			}))
			.filter(
				(entry) =>
					entry.job.repositoryId === job.repositoryId &&
					entry.job.id === job.id &&
					entry.job.runAttempt === job.runAttempt,
			);
		const leases = this.leases
			.all()
			.filter(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt,
			);
		const earliest = [
			at,
			...prior.map((entry) => entry.at),
			...leases.map((lease) => lease.createdAt),
		].reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
		return {
			demand: pinCiQueueDeadline(job, earliest, account, [
				...prior.map((entry) => entry.job.queueDeadlineAt),
				...leases.map((lease) => lease.queueDeadlineAt),
			]),
			durationMs: Math.max(0, Date.parse(at) - Date.parse(earliest)),
			leases,
		};
	}
	/** Reserve through the common financial authority before any isolated or bridge effect. */
	reserve(
		account: Account,
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<Lease | undefined> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			const config = this.leases.configuration()?.configuration;
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
			const desired = this.leases.controlRecord(`ci-policy:${current.id}`);
			const effective = desired
				? effectiveCiAccount(current, parseCiPolicy(desired.bodyJson))
				: current;
			if (ciBudgetPolicy(effective) && !this.options.sharedBudget)
				return undefined;
			const history = this.queueHistory(job, at, effective);
			if (
				history.demand.queueDeadlineAt &&
				Date.parse(history.demand.queueDeadlineAt) <= Date.parse(at)
			) {
				this.leases.expireQueued(history.demand, at);
				return undefined;
			}
			const key = jobKey(job);
			if (
				this.exists("terminal_jobs", key) ||
				this.exists("assigned_jobs", key)
			)
				return undefined;
			const leases = this.leases.all();
			const existing = history.leases.find(
				(lease) =>
					ACTIVE_STATES.has(lease.state) &&
					(lease.actualJobId === 0 || lease.actualJobId === job.id),
			);
			if (existing) {
				const offer = effective.offers.find(
					(entry) =>
						entry.id === existing.offerId &&
						entry.provider === existing.provider,
				);
				if (requiresIsolation && !isIsolatedCiOffer(offer)) {
					if (existing.state === "reserved") {
						existing.state = "cancelled";
						this.append(existing, "ci.LeaseCancelled", at);
						this.leases.queue(job, at);
					}
					return undefined;
				}
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				return existing;
			}
			const blocked = new Set<string>();
			while (blocked.size < effective.offers.length) {
				const selected = route(
					{
						...effective,
						offers: effective.offers.map((offer) => ({
							...offer,
							enabled:
								offer.enabled &&
								!blocked.has(offer.id) &&
								(requiresIsolation
									? isIsolatedCiOffer(offer)
									: !offer.backend || offer.backend === "gh-actions"),
						})),
					},
					leases,
					at,
					{
						phase: this.options.sharedBudget ? "plan" : "admit",
						attempt: job.runAttempt + history.leases.length,
						queueDurationMs: history.durationMs,
					},
				);
				if (!selected) return undefined;
				const id = randomUUID();
				const lease = create(LeaseSchema, {
					id,
					budgetAdmissionAttempt: history.leases.length + 1,
					accountId: effective.id,
					offerId: selected.offer.id,
					provider: selected.offer.provider,
					providerAccountId: selected.offer.providerAccountId,
					...ciBudgetIdentity(effective, at),
					queueDeadlineAt: history.demand.queueDeadlineAt,
					jobId: job.id,
					originalRunId: job.runId,
					runAttempt: job.runAttempt,
					repositoryId: job.repositoryId,
					repository: job.repository,
					installationId: job.installationId,
					jobName: job.name,
					memoryClass: job.memoryClass,
					memoryMb: job.memoryMb,
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
				if (lease.budgetId) {
					try {
						this.options.sharedBudget?.reserve(
							lease,
							ciLeasePolicyMeasurements(lease, leases, history.durationMs),
						);
					} catch (error) {
						if (error instanceof BudgetAdmissionDeniedError) {
							blocked.add(selected.offer.id);
							continue;
						}
						throw error;
					}
				}
				this.append(lease, "ci.LeaseReserved", at);
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				return lease;
			}
			return undefined;
		});
	}
	transition(
		id: string,
		expected: readonly string[],
		update: (lease: Lease) => void,
		type: string,
		at: string,
		expectedRevision?: number,
	): Promise<Lease | undefined> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			return this.leases.transition(id, expected, update, type, at);
		});
	}
	cancelAndRequeue(id: string, job: Job, at: string): Promise<void> {
		return this.tx(() => this.leases.cancelAndRequeue(id, job, at));
	}
	abortIsolatedAndRequeue(id: string, job: Job, at: string): Promise<void> {
		return this.tx(() => this.leases.abortIsolatedAndRequeue(id, job, at));
	}
	private settleInside(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt = at,
		result?: PipelineResult,
		evidence?: BudgetSettlementEvidence,
	): Lease | undefined {
		const lease = this.leases.get(id);
		if (lease && ACTIVE_STATES.has(lease.state) && lease.provider === "vercel")
			throw new Error("sandbox requires native cost settlement");
		return this.leases.settle(
			id,
			hostRunId,
			billedMinutes,
			at,
			unmet,
			completedAt,
			result,
			evidence,
		);
	}
	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt?: string,
		result?: PipelineResult,
		evidence?: BudgetSettlementEvidence,
	): Promise<Lease | undefined> {
		return this.tx(() =>
			this.settleInside(
				id,
				hostRunId,
				billedMinutes,
				at,
				unmet,
				completedAt,
				result,
				evidence,
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
	): Promise<Lease | undefined> {
		return this.tx(() => {
			const current = this.leases.get(id);
			if (
				!current ||
				current.state !== observed.state ||
				current.hostRunId !== observed.hostRunId ||
				current.runnerId !== observed.runnerId
			)
				return undefined;
			return this.settleInside(
				id,
				hostRunId,
				billedMinutes,
				at,
				unmet,
				completedAt,
			);
		});
	}

	/** Expire only untouched queued demand; claimed work retains its financial hold. */
	expireQueued(
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<boolean> {
		return this.tx(() => this.leases.expireQueued(job, at, expectedRevision));
	}
	/** Apply independently verified native finality to a previously retained hold. */
	reconcileSharedBudget(
		id: string,
		paidMicros: number,
		evidence: BudgetSettlementEvidence,
		at: string,
	): Promise<Lease> {
		return this.tx(() =>
			this.leases.reconcileSharedBudget(id, paidMicros, evidence, at),
		);
	}
	/** Release only a cancelled hold with trusted proof it was never claimed. */
	releaseUnusedSharedBudget(
		id: string,
		evidenceRef: string,
		at?: string,
	): Promise<void> {
		return this.tx(() =>
			this.leases.releaseUnusedSharedBudget(id, evidenceRef, at),
		);
	}

	/** A fingerprint tombstone remains after acknowledgement for delivery deduplication. */
	hasWebhook(deliveryId: string): Promise<boolean> {
		if (!isWebhookDeliveryId(deliveryId)) return Promise.resolve(false);
		return this.read(
			() =>
				!!this.db
					.prepare("SELECT 1 FROM webhook_inbox WHERE delivery_id=?")
					.get(deliveryId),
		);
	}
	acceptWebhook(input: WebhookInput): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, false);
	}
	/** Remember authenticated deliveries for installations without a current connection. */
	acceptIgnoredWebhook(input: WebhookInput): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, true);
	}
	private acceptDelivery(
		input: WebhookInput,
		ignored: boolean,
	): Promise<{ duplicate: boolean }> {
		let envelope: ReturnType<typeof parseWebhookEnvelope>;
		try {
			envelope = parseWebhookEnvelope(input);
		} catch (error) {
			return Promise.reject(error);
		}
		const { receivedMs: at, fingerprint, bodyHash } = envelope;
		return this.tx(() => {
			const existing = this.db
				.prepare("SELECT fingerprint FROM webhook_inbox WHERE delivery_id=?")
				.get(input.deliveryId);
			if (existing) {
				if (z.string().parse(existing.fingerprint) !== fingerprint)
					throw new Error("conflicting webhook delivery id");
				return { duplicate: true };
			}
			if (
				this.db
					.prepare(
						"SELECT 1 FROM webhook_inbox WHERE installation_id=? AND body_hash=? AND received_ms>=? LIMIT 1",
					)
					.get(
						input.installationId,
						bodyHash,
						at - WEBHOOK_BODY_REPLAY_WINDOW_MS,
					)
			)
				return { duplicate: true };
			const counts = z
				.object({ recent: Count, outstanding: Count, bytes: Count })
				.parse(
					this.db
						.prepare(
							`SELECT
							   COALESCE(SUM(received_ms > ?),0) AS recent,
							   COALESCE(SUM(completed=0),0) AS outstanding,
							   COALESCE(SUM(CASE WHEN completed=0 THEN length(raw_body) ELSE 0 END),0) AS bytes
							 FROM webhook_inbox WHERE installation_id=? AND (received_ms > ? OR completed=0)`,
						)
						.get(
							at - WEBHOOK_RATE_WINDOW_MS,
							input.installationId,
							at - WEBHOOK_RATE_WINDOW_MS,
						),
				);
			if (
				counts.recent >= MAX_WEBHOOKS_PER_INSTALLATION_WINDOW ||
				counts.outstanding >= MAX_OUTSTANDING_WEBHOOKS_PER_INSTALLATION ||
				counts.bytes + (ignored ? 0 : input.rawBody.byteLength) >
					MAX_OUTSTANDING_WEBHOOK_BYTES_PER_INSTALLATION
			)
				throw new Error("webhook admission limit reached");
			this.db
				.prepare(
					"DELETE FROM webhook_inbox WHERE completed=1 AND received_ms<?",
				)
				.run(at - INBOX_TOMBSTONE_RETENTION_MS);
			this.db
				.prepare(
					"INSERT INTO webhook_inbox(delivery_id,fingerprint,event,installation_id,repository_id,raw_body,received_at,body_hash,received_ms,completed) VALUES(?,?,?,?,?,?,?,?,?,?)",
				)
				.run(
					input.deliveryId,
					fingerprint,
					input.event,
					input.installationId,
					input.repositoryId,
					ignored ? new Uint8Array(0) : Uint8Array.from(input.rawBody),
					input.receivedAt,
					bodyHash,
					at,
					ignored ? 1 : 0,
				);
			return { duplicate: false };
		});
	}
	claimWebhook(
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
			return Promise.reject(new Error("invalid webhook claim"));
		return this.tx(() => {
			this.db
				.prepare(
					"UPDATE webhook_inbox SET quarantined=1,claim_token=NULL WHERE completed=0 AND quarantined=0 AND attempts>=? AND claim_token IS NOT NULL AND claim_until<=?",
				)
				.run(MAX_WEBHOOK_ATTEMPTS, at);
			const found = this.db
				.prepare(
					"SELECT delivery_id,event,installation_id,repository_id,raw_body,received_at FROM webhook_inbox WHERE completed=0 AND quarantined=0 AND claim_until<=? ORDER BY seq LIMIT 1",
				)
				.get(at);
			if (!found) return undefined;
			const row = InboxRow.extend({ raw_body: z.instanceof(Uint8Array) }).parse(
				found,
			);
			const token = randomUUID();
			this.db
				.prepare(
					"UPDATE webhook_inbox SET claim_token=?,claim_until=?,attempts=attempts+1 WHERE delivery_id=?",
				)
				.run(token, at + leaseMs, row.delivery_id);
			return {
				deliveryId: row.delivery_id,
				event: row.event,
				installationId: row.installation_id,
				repositoryId: row.repository_id,
				rawBody: Uint8Array.from(row.raw_body),
				receivedAt: row.received_at,
				token,
			};
		});
	}
	ackWebhook(deliveryId: string, token: string): Promise<boolean> {
		return this.tx(
			() =>
				this.db
					.prepare(
						"UPDATE webhook_inbox SET completed=1,raw_body=x'',claim_token=NULL,claim_until=0 WHERE delivery_id=? AND claim_token=? AND completed=0",
					)
					.run(deliveryId, token).changes === 1,
		);
	}
	releaseWebhook(deliveryId: string, token: string): Promise<boolean> {
		return this.tx(
			() =>
				this.db
					.prepare(
						"UPDATE webhook_inbox SET claim_token=NULL,claim_until=0 WHERE delivery_id=? AND claim_token=? AND completed=0",
					)
					.run(deliveryId, token).changes === 1,
		);
	}
	failWebhook(
		deliveryId: string,
		token: string,
		now: string,
	): Promise<"retry" | "quarantined" | "stale"> {
		const at = Date.parse(now);
		if (!Number.isFinite(at))
			return Promise.reject(new Error("invalid webhook failure time"));
		return this.tx(() => {
			const row = this.db
				.prepare(
					"SELECT attempts FROM webhook_inbox WHERE delivery_id=? AND claim_token=? AND completed=0 AND quarantined=0",
				)
				.get(deliveryId, token);
			if (!row) return "stale" as const;
			const attempts = Count.parse(row.attempts);
			if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
				this.db
					.prepare(
						"UPDATE webhook_inbox SET quarantined=1,claim_token=NULL WHERE delivery_id=? AND claim_token=?",
					)
					.run(deliveryId, token);
				return "quarantined" as const;
			}
			this.db
				.prepare(
					"UPDATE webhook_inbox SET claim_token=NULL,claim_until=? WHERE delivery_id=? AND claim_token=?",
				)
				.run(at + webhookRetryDelayMs(attempts), deliveryId, token);
			return "retry" as const;
		});
	}
	private boundTo(
		accountId: string,
		installationId: number,
		repositoryId: number,
	): boolean {
		return (
			this.leases
				.configuration()
				?.configuration?.connections.some(
					(connection) =>
						connection.accountId === accountId &&
						connection.installationId === installationId &&
						connection.repositoryId === repositoryId,
				) ?? false
		);
	}
	quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<
		{
			deliveryId: string;
			event: string;
			installationId: number;
			repositoryId: number;
			receivedAt: string;
			attempts: number;
		}[]
	> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			return this.db
				.prepare(
					"SELECT delivery_id,event,installation_id,repository_id,received_at,attempts FROM webhook_inbox WHERE completed=0 AND quarantined=1 ORDER BY seq",
				)
				.all()
				.map((found) => InboxRow.extend({ attempts: Count }).parse(found))
				.filter((row) =>
					this.boundTo(accountId, row.installation_id, row.repository_id),
				)
				.slice(0, 100)
				.map((row) => ({
					deliveryId: row.delivery_id,
					event: row.event,
					installationId: row.installation_id,
					repositoryId: row.repository_id,
					receivedAt: row.received_at,
					attempts: row.attempts,
				}));
		});
	}
	retryQuarantinedWebhook(
		accountId: string,
		expectedRevision: number,
		deliveryId: string,
	): Promise<boolean> {
		return this.tx(() => {
			this.checkRevision(expectedRevision);
			const found = this.db
				.prepare(
					"SELECT installation_id,repository_id FROM webhook_inbox WHERE delivery_id=? AND completed=0 AND quarantined=1",
				)
				.get(deliveryId);
			if (!found) return false;
			const row = z
				.object({ installation_id: z.number(), repository_id: z.number() })
				.parse(found);
			if (!this.boundTo(accountId, row.installation_id, row.repository_id))
				return false;
			return (
				this.db
					.prepare(
						"UPDATE webhook_inbox SET quarantined=0,attempts=0,claim_until=0,claim_token=NULL WHERE delivery_id=? AND completed=0 AND quarantined=1",
					)
					.run(deliveryId).changes === 1
			);
		});
	}
}
