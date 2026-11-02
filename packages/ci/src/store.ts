import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import { z } from "zod";
import { allocationQuote } from "./accounting.js";
import {
	ACTIVE_STATES,
	type Account,
	CiEventSchema,
	type Configuration,
	ConfigurationSchema,
	type ConfigurationState,
	ConfigurationStateSchema,
	type ControlRecord,
	ControlRecordSchema,
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	LeaseSchema,
	type Pipeline,
	type PipelineResult,
	parseCiPolicy,
	parseConfiguration,
	route,
	SandboxAllowanceSchema,
	type SandboxPricing,
	SandboxPricingSchema,
} from "./index.js";

/** A conservative bootstrap increase is operator policy, not a new usage observation. */
function observedSandboxPricing(pricing: SandboxPricing | undefined): string {
	if (!pricing) return "";
	const observed = clone(SandboxPricingSchema, pricing);
	observed.bootstrapFixedMicros = 0;
	return toJsonString(SandboxPricingSchema, observed);
}

/** A trusted publisher confirms an existing conservative, zero-credit rate. */
export interface RateReattestation {
	accountId: string;
	offerId: string;
	checkedAt: string;
	validUntil: string;
	sourceUrl: string;
}

/** Single-writer partition. Events and their materialized lease view commit together. */
export class LeaseStore {
	private readonly db: DatabaseSync;
	private transactionDepth = 0;
	private savepointSequence = 0;
	constructor(path: string, database?: DatabaseSync) {
		this.db = database ?? new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, job_key TEXT NOT NULL, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS terminal_jobs (job_key TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS assigned_jobs (job_key TEXT PRIMARY KEY, lease_id TEXT NOT NULL, version TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS pending_jobs (job_key TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS configuration_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS control_records (key TEXT PRIMARY KEY, body TEXT NOT NULL);`);
		const assignmentColumns = this.db
			.prepare("PRAGMA table_info(assigned_jobs)")
			.all();
		if (!assignmentColumns.some((column) => column.name === "version"))
			this.db.exec(
				"ALTER TABLE assigned_jobs ADD COLUMN version TEXT NOT NULL DEFAULT ''",
			);
		for (const row of this.db
			.prepare("SELECT job_key FROM assigned_jobs WHERE version='' ")
			.all())
			this.db
				.prepare("UPDATE assigned_jobs SET version=? WHERE job_key=?")
				.run(randomUUID(), z.string().parse(row.job_key));
	}
	close(): void {
		this.db.close();
	}
	private transaction<T>(fn: () => T): T {
		const nested = this.transactionDepth > 0;
		const savepoint = `hobo_ci_${++this.savepointSequence}`;
		this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
		this.transactionDepth++;
		try {
			const result = fn();
			this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
			return result;
		} catch (error) {
			if (nested) {
				this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
				this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
			} else this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.transactionDepth--;
		}
	}
	all(): Lease[] {
		return this.db
			.prepare("SELECT body FROM leases ORDER BY id")
			.all()
			.map((row) => fromJsonString(LeaseSchema, z.string().parse(row.body)));
	}
	get(id: string): Lease | undefined {
		return this.all().find((lease) => lease.id === id);
	}
	events() {
		return this.db
			.prepare("SELECT body FROM events ORDER BY seq")
			.all()
			.map((row) => fromJsonString(CiEventSchema, z.string().parse(row.body)));
	}
	configuration(): ConfigurationState | undefined {
		const row = this.db
			.prepare("SELECT body FROM configuration_state WHERE id=1")
			.get();
		return row
			? fromJsonString(ConfigurationStateSchema, z.string().parse(row.body))
			: undefined;
	}
	/** Compare-and-swap platform policy, with its audit event in the lease partition. */
	configure(
		configuration: Configuration,
		expectedRevision: number,
		at: string,
	): ConfigurationState {
		return this.transaction(() => {
			const previous = this.configuration();
			if ((previous?.revision ?? 0) !== expectedRevision)
				throw new Error("configuration revision conflict");
			if (
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 0 ||
				expectedRevision >= 4294967295
			)
				throw new Error("invalid configuration revision");
			const parsed = parseConfiguration(
				toJsonString(ConfigurationSchema, configuration),
			);
			for (const old of previous?.configuration?.accounts ?? []) {
				const next = parsed.accounts.find((account) => account.id === old.id);
				for (const [key, cycle] of Object.entries(old.routingSignalCycles)) {
					const nextCycle = next?.routingSignalCycles[key] ?? 0;
					if (nextCycle < cycle)
						throw new Error("routing signal watermark cannot move backwards");
					if (
						nextCycle === cycle &&
						next?.routingSignalCrossed[key] !== old.routingSignalCrossed[key]
					)
						throw new Error("routing signal state requires a newer cycle");
				}
			}
			for (const account of parsed.accounts) {
				if (
					account.usageObservedAt &&
					Date.parse(account.usageObservedAt) > Date.parse(at)
				)
					throw new Error("future account usage snapshot");
				const old = previous?.configuration?.accounts.find(
					(entry) => entry.id === account.id,
				);
				if (
					old?.usageObservedAt &&
					(!account.usageObservedAt ||
						Date.parse(account.usageObservedAt) <
							Date.parse(old.usageObservedAt))
				)
					throw new Error("account usage snapshot cannot move backwards");
				if (
					old?.usageObservedAt &&
					account.usageObservedAt === old.usageObservedAt &&
					account.spentMicros !== old.spentMicros
				)
					throw new Error("account usage facts require a newer observation");
				for (const offer of account.offers) {
					const oldOffer = old?.offers.find((entry) => entry.id === offer.id);
					if (Date.parse(offer.observedAt) > Date.parse(at))
						throw new Error("future provider usage snapshot");
					if (
						oldOffer &&
						offer.observedAt === oldOffer.observedAt &&
						(offer.freeMinutes !== oldOffer.freeMinutes ||
							offer.priceMicrosPerMinute !== oldOffer.priceMicrosPerMinute ||
							offer.spentMicros !== oldOffer.spentMicros ||
							offer.validUntil !== oldOffer.validUntil ||
							offer.sourceUrl !== oldOffer.sourceUrl ||
							observedSandboxPricing(oldOffer.sandboxPricing) !==
								observedSandboxPricing(offer.sandboxPricing) ||
							(oldOffer.sandboxPricing &&
								offer.sandboxPricing &&
								offer.sandboxPricing.bootstrapFixedMicros <
									oldOffer.sandboxPricing.bootstrapFixedMicros) ||
							(oldOffer.sandboxAllowance
								? toJsonString(
										SandboxAllowanceSchema,
										oldOffer.sandboxAllowance,
									)
								: "") !==
								(offer.sandboxAllowance
									? toJsonString(SandboxAllowanceSchema, offer.sandboxAllowance)
									: ""))
					)
						throw new Error("provider usage facts require a newer observation");
					if (
						oldOffer &&
						Date.parse(offer.observedAt) < Date.parse(oldOffer.observedAt)
					)
						throw new Error("provider usage snapshot cannot move backwards");
				}
			}
			for (const lease of this.all().filter((entry) =>
				ACTIVE_STATES.has(entry.state),
			)) {
				const oldAccount = previous?.configuration?.accounts.find(
					(entry) => entry.id === lease.accountId,
				);
				const nextAccount = parsed.accounts.find(
					(entry) => entry.id === lease.accountId,
				);
				const oldOffer = oldAccount?.offers.find(
					(entry) => entry.id === lease.offerId,
				);
				const nextOffer = nextAccount?.offers.find(
					(entry) => entry.id === lease.offerId,
				);
				if (
					!nextAccount ||
					!nextOffer ||
					nextOffer.provider !== lease.provider ||
					(oldOffer &&
						(oldOffer.providerAccountId !== nextOffer.providerAccountId ||
							oldOffer.runsOn !== nextOffer.runsOn ||
							oldOffer.backend !== nextOffer.backend))
				)
					throw new Error("active lease prevents provider identity change");
				if (!lease.pipelineId) {
					const old = previous?.configuration?.connections.find(
						(entry) => entry.repositoryId === lease.repositoryId,
					);
					const next = parsed.connections.find(
						(entry) => entry.repositoryId === lease.repositoryId,
					);
					if (
						!next ||
						next.accountId !== lease.accountId ||
						next.repository !== lease.repository ||
						next.installationId !== lease.installationId ||
						(old &&
							(old.isolatedOnly !== next.isolatedOnly ||
								old.acceptAllMatchingRepositoryJobs !==
									next.acceptAllMatchingRepositoryJobs ||
								old.bridgeWorkflow !== next.bridgeWorkflow ||
								old.bridgeSha !== next.bridgeSha ||
								old.bridgeRef !== next.bridgeRef ||
								old.runnerGroupId !== next.runnerGroupId ||
								old.dispatcherActorId !== next.dispatcherActorId ||
								old.publicRepositoryAcknowledged !==
									next.publicRepositoryAcknowledged ||
								(!old.allowAllPullRequests && next.allowAllPullRequests) ||
								next.allowedEvents.some(
									(event) => !old.allowedEvents.includes(event),
								) ||
								next.allowedRefs.some((ref) => !old.allowedRefs.includes(ref))))
					)
						throw new Error("active lease prevents repository binding change");
				}
			}
			const state = create(ConfigurationStateSchema, {
				revision: expectedRevision + 1,
				configuration: parsed,
				updatedAt: at,
			});
			const detail = toJsonString(ConfigurationStateSchema, state);
			this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, {
						type: "ci.ConfigurationChanged",
						at,
						detail,
					}),
				),
			);
			this.db
				.prepare(
					"INSERT INTO configuration_state(id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
				)
				.run(detail);
			return state;
		});
	}
	/** Commit account settings and desired intent in one revision-fenced transaction. */
	configureWithRecord(
		configuration: Configuration,
		expectedRevision: number,
		at: string,
		key: string,
		accountId: string,
		bodyJson: string,
	): ConfigurationState {
		return this.transaction(() => {
			const state = this.configure(configuration, expectedRevision, at);
			this.putControlRecord(key, accountId, bodyJson, at);
			return state;
		});
	}
	/** Renew only rate evidence; never advance the financial usage watermark. */
	reattestRate(
		input: RateReattestation,
		expectedRevision: number,
		at: string,
	): ConfigurationState {
		return this.transaction(() => {
			const previous = this.configuration();
			if ((previous?.revision ?? 0) !== expectedRevision)
				throw new Error("configuration revision conflict");
			if (
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 1 ||
				expectedRevision >= 4294967295 ||
				!previous?.configuration
			)
				throw new Error("invalid configuration revision");
			const now = Date.parse(at);
			const checked = Date.parse(input.checkedAt);
			const until = Date.parse(input.validUntil);
			if (
				!Number.isFinite(now) ||
				!Number.isFinite(checked) ||
				!Number.isFinite(until) ||
				checked > now ||
				checked < now - 5 * 60_000 ||
				until <= now ||
				until > checked + 24 * 60 * 60_000
			)
				throw new Error("invalid rate attestation time");
			const config = clone(ConfigurationSchema, previous.configuration);
			const account = config.accounts.find(
				(entry) => entry.id === input.accountId,
			);
			const offer = account?.offers.find((entry) => entry.id === input.offerId);
			if (
				offer?.provider !== "vercel" ||
				offer.backend !== "sandbox" ||
				!offer.sandboxPricing ||
				offer.freeMinutes !== 0 ||
				offer.sandboxAllowance !== undefined ||
				!offer.sourceUrl ||
				offer.sourceUrl !== input.sourceUrl ||
				until <= Date.parse(offer.validUntil)
			)
				throw new Error("invalid rate attestation offer");
			const oldValidUntil = offer.validUntil;
			offer.validUntil = input.validUntil;
			const parsed = parseConfiguration(
				toJsonString(ConfigurationSchema, config),
			);
			const state = create(ConfigurationStateSchema, {
				revision: expectedRevision + 1,
				configuration: parsed,
				updatedAt: at,
			});
			const detail = toJsonString(ConfigurationStateSchema, state);
			this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, {
						type: "ci.ConfigurationChanged",
						at,
						detail,
					}),
				),
			);
			this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, {
						type: "ci.RateReattested",
						at,
						accountId: input.accountId,
						detail: JSON.stringify({
							offerId: input.offerId,
							sourceUrl: input.sourceUrl,
							checkedAt: input.checkedAt,
							oldValidUntil,
							validUntil: input.validUntil,
						}),
					}),
				),
			);
			this.db
				.prepare(
					"INSERT INTO configuration_state(id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
				)
				.run(detail);
			return state;
		});
	}
	controlRecord(key: string): ControlRecord | undefined {
		const row = this.db
			.prepare("SELECT body FROM control_records WHERE key=?")
			.get(key);
		return row
			? fromJsonString(ControlRecordSchema, z.string().parse(row.body))
			: undefined;
	}
	putControlRecord(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
	): void {
		if (
			!/^[A-Za-z0-9:_-]{1,200}$/.test(key) ||
			!/^[A-Za-z0-9_-]{1,80}$/.test(accountId) ||
			Buffer.byteLength(bodyJson) > 1024 * 1024
		)
			throw new Error("invalid control record");
		z.record(z.string(), z.json()).parse(JSON.parse(bodyJson));
		this.transaction(() => {
			const old = this.controlRecord(key);
			if (old && old.accountId !== accountId)
				throw new Error("control record belongs to another account");
			const detail = toJsonString(
				ControlRecordSchema,
				create(ControlRecordSchema, {
					key,
					accountId,
					bodyJson,
					updatedAt: at,
				}),
			);
			this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, {
						type: "ci.ControlRecordUpdated",
						at,
						accountId,
						detail,
					}),
				),
			);
			this.db
				.prepare(
					"INSERT INTO control_records(key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
				)
				.run(key, detail);
		});
	}
	private leaseKey(lease: Lease): string {
		return lease.pipelineId
			? `pipeline:${lease.accountId}:${lease.pipelineId}`
			: `${lease.repositoryId}:${lease.jobId}:${lease.runAttempt}`;
	}
	reservePipeline(
		account: Account,
		pipeline: Pipeline,
		digest: string,
		offerIds: readonly string[],
		at: string,
	): Lease | undefined {
		return this.transaction(() => {
			if (
				pipeline.accountId !== account.id ||
				pipeline.timeoutSeconds > account.maxRuntimeMinutes * 60
			)
				throw new Error("pipeline scope or timeout exceeds account policy");
			const leases = this.all();
			const previous = leases.filter(
				(lease) =>
					lease.accountId === account.id && lease.pipelineId === pipeline.id,
			);
			if (previous.some((lease) => lease.pipelineDigest !== digest))
				throw new Error("pipeline id already used for different input");
			const existing = previous.find(
				(lease) =>
					ACTIVE_STATES.has(lease.state) || lease.state === "completed",
			);
			if (existing) return existing;
			const selected = route(
				{
					...account,
					maxRuntimeMinutes: Math.ceil(pipeline.timeoutSeconds / 60),
					offers: account.offers.filter((offer) => offerIds.includes(offer.id)),
				},
				leases,
				at,
			);
			if (!selected) return undefined;
			const lease = create(LeaseSchema, {
				id: randomUUID(),
				accountId: account.id,
				pipelineId: pipeline.id,
				pipelineDigest: digest,
				offerId: selected.offer.id,
				provider: selected.offer.provider,
				state: "reserved",
				reservedMinutes: selected.minutes,
				reservedFreeMinutes: selected.freeMinutes,
				reservedPaidMicros: selected.paidMicros,
				priceMicrosPerMinute: selected.offer.priceMicrosPerMinute,
				freeValidUntil: selected.offer.validUntil,
				createdAt: at,
			});
			this.append(lease, "ci.LeaseReserved", at);
			return lease;
		});
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
			.run(lease.id, this.leaseKey(lease), body);
	}
	reserve(account: Account, job: Job, at: string): Lease | undefined {
		// This local adapter only launches trusted GitHub workflow bridges.
		if (job.isolatedRequired) return undefined;
		return this.transaction(() => {
			const configuration = this.configuration()?.configuration;
			const binding = configuration?.connections.find(
				(entry) => entry.repositoryId === job.repositoryId,
			);
			if (
				configuration &&
				(!binding ||
					binding.installationId !== job.installationId ||
					binding.repository.toLowerCase() !== job.repository.toLowerCase() ||
					binding.accountId !== account.id)
			)
				return undefined;
			if (binding?.isolatedOnly) return undefined;
			const current = configuration
				? configuration.accounts.find((entry) => entry.id === account.id)
				: account;
			if (!current || (binding && binding.accountId !== current.id))
				return undefined;
			const desired = this.controlRecord(`ci-policy:${current.id}`);
			const effective = desired
				? effectiveCiAccount(current, parseCiPolicy(desired.bodyJson))
				: current;
			const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
			if (
				this.db
					.prepare("SELECT 1 FROM terminal_jobs WHERE job_key=?")
					.get(key) ||
				this.db.prepare("SELECT 1 FROM assigned_jobs WHERE job_key=?").get(key)
			)
				return undefined;
			const leases = this.all();
			const existing = leases.find(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt &&
					ACTIVE_STATES.has(lease.state),
			);
			if (existing) {
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				return existing;
			}
			const selected = route(
				{
					...effective,
					offers: effective.offers.filter(
						(offer) => !offer.backend || offer.backend === "gh-actions",
					),
				},
				leases,
				at,
			);
			if (!selected) return undefined;
			const id = randomUUID();
			const lease = create(LeaseSchema, {
				id,
				accountId: account.id,
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
				reservedMinutes: selected.minutes,
				reservedFreeMinutes: selected.freeMinutes,
				reservedPaidMicros: selected.paidMicros,
				runnerName: `hobo-${id}`,
				createdAt: at,
			});
			this.append(lease, "ci.LeaseReserved", at);
			this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
			return lease;
		});
	}
	transition(
		id: string,
		expected: readonly string[],
		update: (lease: Lease) => void,
		type: string,
		at: string,
	): Lease | undefined {
		return this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !expected.includes(lease.state)) return undefined;
			update(lease);
			this.append(lease, type, at);
			return lease;
		});
	}
	queue(job: Job, at: string): void {
		this.transaction(() => this.queueInside(job, at));
	}
	private queueInside(job: Job, at: string): void {
		const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
		if (
			this.db.prepare("SELECT 1 FROM terminal_jobs WHERE job_key=?").get(key) ||
			this.db.prepare("SELECT 1 FROM assigned_jobs WHERE job_key=?").get(key) ||
			this.db.prepare("SELECT 1 FROM pending_jobs WHERE job_key=?").get(key) ||
			this.all().some(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt &&
					ACTIVE_STATES.has(lease.state),
			)
		)
			return;
		const detail = toJsonString(JobSchema, job);
		this.db
			.prepare("INSERT INTO events(body) VALUES (?)")
			.run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, { type: "ci.JobQueued", at, detail }),
				),
			);
		this.db
			.prepare("INSERT INTO pending_jobs(job_key,body) VALUES (?,?)")
			.run(key, detail);
	}
	pendingJobs(): Job[] {
		return this.db
			.prepare("SELECT body FROM pending_jobs ORDER BY rowid")
			.all()
			.map((row) => fromJsonString(JobSchema, z.string().parse(row.body)));
	}
	assignedJob(job: Job): { leaseId: string; version: string } | undefined {
		const row = this.db
			.prepare("SELECT lease_id,version FROM assigned_jobs WHERE job_key=?")
			.get(`${job.repositoryId}:${job.id}:${job.runAttempt}`);
		return row
			? {
					leaseId: z.string().parse(row.lease_id),
					version: z.string().parse(row.version),
				}
			: undefined;
	}
	/** Call only after GitHub verifies this exact job is queued and its owner is terminal. */
	clearAssignedJob(
		job: Job,
		leaseId: string,
		version: string,
		at: string,
	): boolean {
		return this.transaction(() => {
			const lease = this.get(leaseId);
			if (!lease || ACTIVE_STATES.has(lease.state)) return false;
			const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
			const changed =
				this.db
					.prepare(
						"DELETE FROM assigned_jobs WHERE job_key=? AND lease_id=? AND version=?",
					)
					.run(key, leaseId, version).changes === 1;
			if (changed)
				this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
					toJsonString(
						CiEventSchema,
						create(CiEventSchema, {
							type: "ci.JobAssignmentCleared",
							at,
							leaseId,
							detail: toJsonString(JobSchema, job),
						}),
					),
				);
			return changed;
		});
	}

	observe(job: Job, at: string): void {
		this.transaction(() => {
			if (job.action === "completed") {
				const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
				this.db
					.prepare("INSERT OR IGNORE INTO terminal_jobs(job_key) VALUES (?)")
					.run(key);
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				this.db.prepare("DELETE FROM assigned_jobs WHERE job_key=?").run(key);
				this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
					toJsonString(
						CiEventSchema,
						create(CiEventSchema, {
							type: "ci.JobCompleted",
							at,
							detail: toJsonString(JobSchema, job),
						}),
					),
				);
			}
			if (job.runnerName) {
				const lease = this.all().find(
					(candidate) =>
						candidate.repositoryId === job.repositoryId &&
						candidate.installationId === job.installationId &&
						candidate.repository.toLowerCase() ===
							job.repository.toLowerCase() &&
						candidate.runnerName === job.runnerName,
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
					this.append(
						lease,
						settledSandbox ? "ci.LateJobObserved" : "ci.JobObserved",
						at,
					);
					if (settledSandbox && job.action !== "completed") return;
					if (
						job.action === "in_progress" &&
						this.db
							.prepare("SELECT 1 FROM terminal_jobs WHERE job_key=?")
							.get(`${job.repositoryId}:${job.id}:${job.runAttempt}`)
					)
						return;
					// GitHub can assign a different queued job to this label. Release
					// only duplicate reservations that have not launched a host yet.
					if (job.action === "in_progress" || job.action === "completed") {
						if (job.action === "in_progress") {
							const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
							const prior = this.db
								.prepare("SELECT lease_id FROM assigned_jobs WHERE job_key=?")
								.get(key);
							if (prior && prior.lease_id !== lease.id)
								throw new Error("job assigned to another runner");
							const version = randomUUID();
							this.db
								.prepare(
									"INSERT INTO assigned_jobs(job_key,lease_id,version) VALUES(?,?,?) ON CONFLICT(job_key) DO UPDATE SET version=excluded.version",
								)
								.run(key, lease.id, version);
							this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
								toJsonString(
									CiEventSchema,
									create(CiEventSchema, {
										type: "ci.JobAssigned",
										at,
										accountId: lease.accountId,
										leaseId: lease.id,
										detail: JSON.stringify({
											job: JSON.parse(toJsonString(JobSchema, job)),
											version,
										}),
									}),
								),
							);
						}
						for (const duplicate of this.all()) {
							if (
								duplicate.id !== lease.id &&
								duplicate.accountId === lease.accountId &&
								duplicate.repositoryId === job.repositoryId &&
								duplicate.jobId === job.id &&
								duplicate.runAttempt === job.runAttempt &&
								duplicate.state === "reserved"
							) {
								duplicate.state = "cancelled";
								this.append(duplicate, "ci.LeaseCancelled", at);
							}
						}
						this.db
							.prepare("DELETE FROM pending_jobs WHERE job_key=?")
							.run(`${job.repositoryId}:${job.id}:${job.runAttempt}`);
					}
				}
			}
			// Original-job completion NEVER releases a host reservation.
		});
	}
	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt = at,
		result?: PipelineResult,
	): Lease | undefined {
		return this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !ACTIVE_STATES.has(lease.state)) return undefined;
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
			this.append(lease, "ci.HostSettled", at);
			if (unmet) this.queueInside(unmet, at);
			return lease;
		});
	}
	cancelAndRequeue(id: string, job: Job, at: string): void {
		this.transaction(() => {
			const lease = this.get(id);
			if (lease?.state !== "reserved") return;
			lease.state = "cancelled";
			this.append(lease, "ci.LeaseCancelled", at);
			this.queueInside(job, at);
		});
	}
	abortIsolatedAndRequeue(id: string, job: Job, at: string): void {
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
		this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !recoverable.has(lease.state)) return;
			if (!isolatedProviders.has(lease.provider)) return;
			lease.state = "cancelled";
			this.append(lease, "ci.LeaseCancelled", at);
			this.queueInside(job, at);
		});
	}
	recover(at: string): void {
		for (const lease of this.all()) {
			if (lease.pipelineId && lease.state === "reserved") {
				// No backend call can precede PipelineStarted. Release untouched
				// reservations so a restarted coordinator can re-admit current policy.
				this.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "cancelled";
					},
					"ci.LeaseCancelled",
					at,
				);
				continue;
			}
			this.transition(
				lease.id,
				lease.pipelineId
					? ["dispatching", "claiming", "running"]
					: ["dispatching", "claiming"],
				(entry) => {
					entry.state = "uncertain";
				},
				"ci.LeaseUncertain",
				at,
			);
		}
	}
	/** Rebuild query state from the append-only event log; terminal tombstones are separate intake state. */
	rebuild(): void {
		this.transaction(() => {
			this.db.exec(
				"DELETE FROM leases; DELETE FROM pending_jobs; DELETE FROM terminal_jobs; DELETE FROM assigned_jobs; DELETE FROM configuration_state; DELETE FROM control_records;",
			);
			for (const event of this.events()) {
				if (event.type === "ci.RateReattested") continue;
				if (event.type === "ci.ConfigurationChanged") {
					fromJsonString(ConfigurationStateSchema, event.detail);
					this.db
						.prepare(
							"INSERT INTO configuration_state(id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
						)
						.run(event.detail);
					continue;
				}
				if (event.type === "ci.ControlRecordUpdated") {
					const record = fromJsonString(ControlRecordSchema, event.detail);
					this.db
						.prepare(
							"INSERT INTO control_records(key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
						)
						.run(record.key, event.detail);
					continue;
				}
				if (
					["ci.JobAssigned", "ci.JobAssignmentCleared"].includes(event.type)
				) {
					const wrapped = z
						.object({ job: z.json(), version: z.string() })
						.safeParse(JSON.parse(event.detail));
					const job = fromJsonString(
						JobSchema,
						wrapped.success ? JSON.stringify(wrapped.data.job) : event.detail,
					);
					const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
					if (event.type === "ci.JobAssigned")
						this.db
							.prepare(
								"INSERT INTO assigned_jobs(job_key,lease_id,version) VALUES (?,?,?) ON CONFLICT(job_key) DO UPDATE SET lease_id=excluded.lease_id,version=excluded.version",
							)
							.run(
								key,
								event.leaseId,
								wrapped.success ? wrapped.data.version : randomUUID(),
							);
					else
						this.db
							.prepare(
								"DELETE FROM assigned_jobs WHERE job_key=? AND lease_id=?",
							)
							.run(key, event.leaseId);
					continue;
				}

				if (["ci.JobQueued", "ci.JobCompleted"].includes(event.type)) {
					const job = fromJsonString(JobSchema, event.detail);
					const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
					if (event.type === "ci.JobCompleted") {
						this.db
							.prepare("DELETE FROM assigned_jobs WHERE job_key=?")
							.run(key);
						this.db
							.prepare(
								"INSERT OR IGNORE INTO terminal_jobs(job_key) VALUES (?)",
							)
							.run(key);
						this.db
							.prepare("DELETE FROM pending_jobs WHERE job_key=?")
							.run(key);
					} else if (
						!this.db
							.prepare("SELECT 1 FROM terminal_jobs WHERE job_key=?")
							.get(key)
					) {
						this.db
							.prepare(
								"INSERT OR IGNORE INTO pending_jobs(job_key,body) VALUES (?,?)",
							)
							.run(key, event.detail);
					}
					continue;
				}
				const lease = fromJsonString(LeaseSchema, event.detail);
				if (event.type !== "ci.LateJobObserved")
					this.db
						.prepare("DELETE FROM pending_jobs WHERE job_key=?")
						.run(this.leaseKey(lease));
				this.db
					.prepare(
						"INSERT INTO leases(id,job_key,body) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
					)
					.run(lease.id, this.leaseKey(lease), event.detail);
			}
		});
	}
}
