import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	BudgetAdmissionDeniedError,
	type BudgetReservation,
	type BudgetSettlementEvidence,
} from "@hobo/broker";
import type { BudgetPolicyEvaluationContext } from "@hobo/core";
import { z } from "zod";
import { allocationQuote } from "./accounting.js";
import {
	accountEventPage,
	type EventCursor,
	eventCursorBounds,
	jobAccountId,
} from "./event-log.js";
import type { PipelineUsageObservation } from "./execution.js";
import { shouldAbortIsolatedFleetLease } from "./fleet-overflow.js";
import {
	ACTIVE_STATES,
	type Account,
	type CiEventPage,
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
	type SequencedCiEvent,
	SequencedCiEventSchema,
} from "./index.js";
import { isIsolatedRetirementTransition } from "./isolated-retirement.js";
import {
	ciBudgetIdentity,
	ciBudgetPolicy,
	ciBudgetPolicyJson,
	ciQueueBudgetMs,
} from "./policy.js";
import {
	type CiSharedBudgetHooks,
	ciExecutionDigest,
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
} from "./shared-budget.js";

/** A conservative bootstrap increase is operator policy, not a new usage observation. */
function observedSandboxPricing(pricing: SandboxPricing | undefined): string {
	if (!pricing) return "";
	const observed = clone(SandboxPricingSchema, pricing);
	observed.bootstrapFixedMicros = 0;
	return toJsonString(SandboxPricingSchema, observed);
}

/** Fields that identify the original payer and approved reservation never follow mutable aliases. */
export function leaseFinancialIdentity(lease: Lease): string {
	return JSON.stringify([
		lease.id,
		lease.pipelineId,
		lease.pipelineDigest,
		lease.jobId,
		lease.originalRunId,
		lease.runAttempt,
		lease.repositoryId,
		lease.repository,
		lease.installationId,
		lease.runnerName,
		lease.externalOperationId,
		lease.budgetReleaseEvidenceRef,
		lease.usageProvenance,
		lease.usageEvidenceRef,
		lease.accountId,
		lease.offerId,
		lease.provider,
		lease.providerAccountId,
		lease.budgetTenantId,
		lease.budgetId,
		lease.budgetPeriodId,
		lease.budgetPolicyRevision,
		lease.budgetPolicyDigest,
		lease.budgetAdmissionAttempt,
		lease.reservedPaidMicros,
		lease.reservedFreeMinutes,
		lease.reservedMinutes,
		lease.priceMicrosPerMinute,
		lease.freeValidUntil,
		lease.queueDeadlineAt,
		lease.sandboxPricing
			? toJsonString(SandboxPricingSchema, lease.sandboxPricing)
			: "",
		lease.sandboxReservedAllowance
			? toJsonString(SandboxAllowanceSchema, lease.sandboxReservedAllowance)
			: "",
	]);
}

export function ciParentReleaseEvidenceRef(
	lease: Lease,
	receipt: BudgetReservation,
	evidenceRef: string,
): string {
	if (
		receipt.status !== "released" ||
		receipt.reservationId !== ciReservationId(lease) ||
		receipt.requestDigest !== ciRequestDigest(lease) ||
		receipt.financialPlanHash !== ciFinancialPlanHash(lease) ||
		receipt.executionDigest ||
		!Number.isSafeInteger(receipt.ledgerSeq) ||
		receipt.ledgerSeq <= 0 ||
		receipt.identity?.tenantId !== lease.budgetTenantId ||
		receipt.identity.budgetId !== lease.budgetId ||
		receipt.identity.periodId !== lease.budgetPeriodId ||
		receipt.identity.policyRevision !== lease.budgetPolicyRevision ||
		receipt.usageEvidenceRef !== evidenceRef ||
		receipt.sourceStoppedEvidenceRef !== evidenceRef
	)
		throw new Error("positive exact parent release receipt required");
	return `ci-parent-release:${receipt.reservationId}:${receipt.ledgerSeq}`;
}

export function assertCiParentSettlement(
	lease: Lease,
	receipt: BudgetReservation,
	evidence: BudgetSettlementEvidence,
): void {
	if (
		receipt.status !== "settled" ||
		receipt.reservationId !== ciReservationId(lease) ||
		receipt.requestDigest !== ciRequestDigest(lease) ||
		receipt.financialPlanHash !== ciFinancialPlanHash(lease) ||
		receipt.executionDigest !== ciExecutionDigest(lease) ||
		!Number.isSafeInteger(receipt.ledgerSeq) ||
		receipt.ledgerSeq <= 0 ||
		receipt.actualMicros !== lease.paidMicros ||
		receipt.identity?.tenantId !== lease.budgetTenantId ||
		receipt.identity.budgetId !== lease.budgetId ||
		receipt.identity.periodId !== lease.budgetPeriodId ||
		receipt.identity.policyRevision !== lease.budgetPolicyRevision ||
		receipt.usageEvidenceRef !== evidence.usageEvidenceRef ||
		receipt.sourceStoppedEvidenceRef !== evidence.sourceStoppedEvidenceRef
	)
		throw new Error("positive exact parent settlement receipt required");
}

function historicalBudgetIdentity(account: Account) {
	const common = ciBudgetPolicy(account);
	return common
		? {
				budgetTenantId: common.tenantId,
				budgetId: common.budgetId,
				budgetPeriodId: common.periodId,
				budgetPolicyRevision: String(common.revision),
				budgetPolicyDigest: ciBudgetPolicyJson(account.budgetPolicy),
			}
		: {
				budgetTenantId: "",
				budgetId: "",
				budgetPeriodId: "",
				budgetPolicyRevision: "",
				budgetPolicyDigest: "",
			};
}

export function pinCiQueueDeadline(
	job: Job,
	firstSeenAt: string,
	account?: Account,
	previousDeadlines: readonly string[] = [],
): Job {
	const pinned = clone(JobSchema, job);
	pinned.queueDeadlineAt = ciQueueDeadlineAt(firstSeenAt, account, [
		job.queueDeadlineAt,
		...previousDeadlines,
	]);
	return pinned;
}

function ciQueueDeadlineAt(
	firstSeenAt: string,
	account: Account | undefined,
	deadlines: readonly string[],
): string {
	const first = Date.parse(firstSeenAt);
	if (!Number.isFinite(first)) throw new Error("invalid queue receipt time");
	const candidates = deadlines.filter(Boolean).map((deadline) => {
		const value = Date.parse(deadline);
		if (!Number.isFinite(value)) throw new Error("invalid queue deadline");
		return value;
	});
	const bound = account && ciQueueBudgetMs(account);
	if (bound !== undefined) {
		if (!Number.isSafeInteger(first + bound))
			throw new Error("unsafe queue deadline");
		candidates.push(first + bound);
	}
	return candidates.length
		? new Date(Math.min(...candidates)).toISOString()
		: "";
}

/** Measured CI-local context; financial bounds are independently supplied by the parent hook. */
export function ciLeasePolicyMeasurements(
	lease: Lease,
	leases: readonly Lease[],
	queueDurationMs: number,
): BudgetPolicyEvaluationContext["measurements"] {
	const active = leases.filter(
		(entry) =>
			entry.id !== lease.id &&
			ACTIVE_STATES.has(entry.state) &&
			(lease.budgetId
				? entry.budgetTenantId === lease.budgetTenantId &&
					entry.budgetId === lease.budgetId &&
					entry.budgetPeriodId === lease.budgetPeriodId
				: entry.accountId === lease.accountId),
	);
	return [
		{ key: "work.concurrent", unit: "count", value: active.length + 1 },
		{
			key: "work.duration",
			unit: "ms",
			value:
				lease.reservedMinutes * 60000 +
				(lease.sandboxPricing?.proxyVmRequired
					? lease.sandboxPricing.proxyVmExtraMs
					: 0),
		},
		{ key: "ci.queue.duration", unit: "ms", value: queueDurationMs },
		{
			key: "ci.attempts",
			unit: "count",
			value: lease.pipelineId
				? lease.budgetAdmissionAttempt
				: lease.runAttempt + lease.budgetAdmissionAttempt - 1,
		},
	];
}

/** A trusted publisher confirms an existing conservative, zero-credit rate. */
export interface RateReattestation {
	accountId: string;
	offerId: string;
	checkedAt: string;
	validUntil: string;
	sourceUrl: string;
}

/** A journal row as the event it stores and its position. */
function sequenced(row: Record<string, SQLOutputValue>): SequencedCiEvent {
	return create(SequencedCiEventSchema, {
		seq: z.number().int().parse(row.seq),
		event: fromJsonString(CiEventSchema, z.string().parse(row.body)),
	});
}

/**
 * One account's events, through the index on the account each event names.
 * An event that names no account (a partition event, or a job event
 * journalled before its owner was recorded) has no key there and is in no
 * account's range.
 */
const ACCOUNT_EVENTS =
	"SELECT seq, body FROM events INDEXED BY events_account_seq WHERE json_extract(body,'$.accountId')=?";

/** Single-writer partition. Events and their materialized lease view commit together. */
export class LeaseStore {
	private readonly db: DatabaseSync;
	private transactionDepth = 0;
	private savepointSequence = 0;
	constructor(
		path: string,
		database?: DatabaseSync,
		private readonly options: { sharedBudget?: CiSharedBudgetHooks } = {},
	) {
		this.db = database ?? new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS events_account_seq ON events(json_extract(body,'$.accountId'), seq);
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
	/** Run `fn` in this partition's write transaction (nested calls become savepoints). */
	atomic<T>(fn: () => T): T {
		return this.transaction(fn);
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
		const row = this.db.prepare("SELECT body FROM leases WHERE id=?").get(id);
		return row
			? fromJsonString(LeaseSchema, z.string().parse(row.body))
			: undefined;
	}
	events() {
		return this.db
			.prepare("SELECT body FROM events ORDER BY seq")
			.all()
			.map((row) => fromJsonString(CiEventSchema, z.string().parse(row.body)));
	}
	/**
	 * An account's events after a journal position, oldest first; without a
	 * position, its newest ones. `seq` is the journal's own key, so a position
	 * handed back as `after` never skips or repeats an event.
	 *
	 * The statement names the account index it reads through, so the read
	 * touches the account's own events and nothing of any other account's,
	 * however long the journal is. Left to choose, SQLite could walk the whole
	 * journal, which stops this single-threaded store, and its host, for as
	 * long as the journal is long; without the index the read fails instead.
	 */
	eventsSince(cursor: EventCursor): CiEventPage {
		const { accountId, after, limit } = eventCursorBounds(cursor);
		// One more than the page holds, to say whether the account has more.
		const rows =
			after === undefined
				? this.db
						.prepare(`${ACCOUNT_EVENTS} ORDER BY seq DESC LIMIT ?`)
						.all(accountId, limit + 1)
						.reverse()
				: this.db
						.prepare(`${ACCOUNT_EVENTS} AND seq>? ORDER BY seq LIMIT ?`)
						.all(accountId, after, limit + 1);
		return accountEventPage(rows.map(sequenced), cursor);
	}
	/** The journal's newest position; zero while it is empty. */
	journalHead(): number {
		return z
			.number()
			.int()
			.parse(
				this.db.prepare("SELECT coalesce(max(seq),0) AS head FROM events").get()
					?.head,
			);
	}
	/** The account whose connection holds this job's repository right now. */
	private jobOwner(job: Job): string {
		return jobAccountId(
			this.configuration()?.configuration?.connections ?? [],
			job,
		);
	}
	configuration(): ConfigurationState | undefined {
		const row = this.db
			.prepare("SELECT body FROM configuration_state WHERE id=1")
			.get();
		return row
			? fromJsonString(ConfigurationStateSchema, z.string().parse(row.body))
			: undefined;
	}
	private validateFinancialHistory(
		configuration: Configuration,
		previous: ConfigurationState | undefined,
	): void {
		const history = this.events()
			.filter((event) => event.type === "ci.ConfigurationChanged")
			.map((event) => fromJsonString(ConfigurationStateSchema, event.detail));
		if (previous) history.push(previous);
		const leases = this.all();
		for (const account of configuration.accounts) {
			const identity = historicalBudgetIdentity(account);
			const budgetHistory = history.flatMap((state) =>
				(state.configuration?.accounts ?? [])
					.map((old) => historicalBudgetIdentity(old))
					.filter(
						(old) =>
							identity.budgetId !== "" &&
							old.budgetId === identity.budgetId &&
							old.budgetTenantId === identity.budgetTenantId,
					),
			);
			const latestBudget = budgetHistory.at(-1);
			for (const old of budgetHistory) {
				if (
					old.budgetPolicyRevision === identity.budgetPolicyRevision &&
					old.budgetPolicyDigest !== identity.budgetPolicyDigest
				)
					throw new Error(
						"budget policy revision already binds different content",
					);
				if (
					latestBudget &&
					old.budgetPeriodId === identity.budgetPeriodId &&
					latestBudget.budgetPeriodId !== identity.budgetPeriodId
				)
					throw new Error("retired budget period cannot reactivate");
				if (
					latestBudget &&
					old.budgetPolicyRevision === identity.budgetPolicyRevision &&
					latestBudget.budgetPolicyRevision !== identity.budgetPolicyRevision
				)
					throw new Error("retired budget policy revision cannot reactivate");
			}
			for (const state of history)
				for (const old of state.configuration?.accounts ?? []) {
					const oldIdentity = historicalBudgetIdentity(old);
					const sameBudget =
						identity.budgetId !== "" &&
						identity.budgetId === oldIdentity.budgetId &&
						identity.budgetTenantId === oldIdentity.budgetTenantId;
					const samePeriod = sameBudget
						? identity.budgetPeriodId === oldIdentity.budgetPeriodId
						: account.id === old.id &&
							identity.budgetId === oldIdentity.budgetId;
					if (
						account.id === old.id &&
						oldIdentity.budgetId &&
						(oldIdentity.budgetId !== identity.budgetId ||
							oldIdentity.budgetTenantId !== identity.budgetTenantId)
					)
						throw new Error(
							"durable common budget authority cannot be removed or rebound to reset history",
						);
					if (account.id === old.id || sameBudget) {
						if (samePeriod && account.spentMicros < old.spentMicros)
							throw new Error(
								"account spending watermark cannot decrease within a budget period",
							);
						if (
							!samePeriod &&
							leases.some(
								(lease) =>
									(ACTIVE_STATES.has(lease.state) ||
										(lease.budgetId &&
											((lease.state === "cancelled" &&
												!lease.budgetReleaseEvidenceRef) ||
												(lease.state === "completed" &&
													lease.usageProvenance !== "provider-final")))) &&
									(oldIdentity.budgetId
										? lease.budgetId === oldIdentity.budgetId &&
											lease.budgetTenantId === oldIdentity.budgetTenantId &&
											lease.budgetPeriodId === oldIdentity.budgetPeriodId
										: lease.accountId === old.id && !lease.budgetId),
							)
						)
							throw new Error(
								"budget period cannot reset while liabilities remain active",
							);
						if (
							old.usageObservedAt &&
							(!account.usageObservedAt ||
								Date.parse(account.usageObservedAt) <
									Date.parse(old.usageObservedAt))
						)
							throw new Error(
								"historical account usage watermark cannot move backwards",
							);
					}
					for (const offer of account.offers)
						for (const oldOffer of old.offers) {
							if (
								offer.provider !== oldOffer.provider ||
								offer.providerAccountId !== oldOffer.providerAccountId
							)
								continue;
							const sameNativePeriod =
								samePeriod || (!identity.budgetId && !oldIdentity.budgetId);
							const nativeLeases = leases.filter(
								(lease) =>
									lease.provider === offer.provider &&
									(lease.providerAccountId
										? lease.providerAccountId === offer.providerAccountId
										: lease.accountId === old.id &&
											lease.offerId === oldOffer.id),
							);
							if (
								sameNativePeriod &&
								(offer.spentMicros < oldOffer.spentMicros ||
									(account.id !== old.id &&
										account.spentMicros < old.spentMicros))
							)
								throw new Error(
									"provider spending watermark cannot decrease within a budget period",
								);
							if (
								Date.parse(offer.observedAt) < Date.parse(oldOffer.observedAt)
							)
								throw new Error(
									"historical provider usage watermark cannot move backwards",
								);
							const previousOffer = previous?.configuration?.accounts
								.find((entry) => entry.id === account.id)
								?.offers.find((entry) => entry.id === offer.id);
							if (
								account.id !== old.id ||
								offer.id !== oldOffer.id ||
								!previousOffer
							) {
								const lastUsage = nativeLeases.reduce(
									(latest, lease) =>
										Math.max(
											latest,
											Date.parse(
												lease.usageCompletedAt ||
													lease.settledAt ||
													lease.createdAt,
											),
										),
									Date.parse(oldOffer.observedAt),
								);
								if (
									Date.parse(offer.observedAt) <=
										Date.parse(oldOffer.observedAt) ||
									Date.parse(offer.observedAt) < lastUsage ||
									nativeLeases.some(
										(lease) =>
											!lease.providerAccountId &&
											ACTIVE_STATES.has(lease.state),
									)
								)
									throw new Error(
										"provider identity rename or revival requires a new native usage observation covering history",
									);
							}
						}
				}
		}
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
			this.validateFinancialHistory(parsed, previous);
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
			const configuration = this.configuration()?.configuration;
			const current = configuration
				? configuration.accounts.find((entry) => entry.id === account.id)
				: account;
			if (!current) return undefined;
			const desired = this.controlRecord(`ci-policy:${current.id}`);
			const effective = desired
				? effectiveCiAccount(current, parseCiPolicy(desired.bodyJson))
				: current;
			if (ciBudgetPolicy(effective) && !this.options.sharedBudget)
				return undefined;
			if (
				pipeline.accountId !== effective.id ||
				pipeline.timeoutSeconds > effective.maxRuntimeMinutes * 60
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
			const firstReceipt = [
				at,
				...previous.map((lease) => lease.createdAt),
			].reduce((first, value) =>
				Date.parse(value) < Date.parse(first) ? value : first,
			);
			const queueDurationMs = Math.max(
				0,
				Date.parse(at) - Date.parse(firstReceipt),
			);
			const queueDeadlineAt = ciQueueDeadlineAt(
				firstReceipt,
				effective,
				previous.map((lease) => lease.queueDeadlineAt),
			);
			if (queueDeadlineAt && Date.parse(queueDeadlineAt) <= Date.parse(at))
				return undefined;
			const blockedOfferIds = new Set<string>();
			while (blockedOfferIds.size < effective.offers.length) {
				const selected = route(
					{
						...effective,
						maxRuntimeMinutes: Math.ceil(pipeline.timeoutSeconds / 60),
						offers: effective.offers.map((offer) => ({
							...offer,
							enabled:
								offer.enabled &&
								!blockedOfferIds.has(offer.id) &&
								offerIds.includes(offer.id),
						})),
					},
					leases,
					at,
					{
						phase: this.options.sharedBudget ? "plan" : "admit",
						attempt: previous.length + 1,
						queueDurationMs,
					},
				);
				if (!selected) return undefined;
				const lease = create(LeaseSchema, {
					id: randomUUID(),
					accountId: account.id,
					pipelineId: pipeline.id,
					pipelineDigest: digest,
					budgetAdmissionAttempt: previous.length + 1,
					queueDeadlineAt,
					runAttempt: previous.length + 1,
					offerId: selected.offer.id,
					provider: selected.offer.provider,
					providerAccountId: selected.offer.providerAccountId,
					...ciBudgetIdentity(effective, at),
					state: "reserved",
					reservedMinutes: selected.minutes,
					reservedFreeMinutes: selected.freeMinutes,
					reservedPaidMicros: selected.paidMicros,
					priceMicrosPerMinute: selected.offer.priceMicrosPerMinute,
					freeValidUntil: selected.offer.validUntil,
					createdAt: at,
				});
				if (lease.budgetId)
					try {
						this.options.sharedBudget?.reserve(
							lease,
							ciLeasePolicyMeasurements(lease, leases, queueDurationMs),
						);
					} catch (error) {
						if (error instanceof BudgetAdmissionDeniedError) {
							blockedOfferIds.add(selected.offer.id);
							continue;
						}
						throw error;
					}
				this.append(lease, "ci.LeaseReserved", at);
				return lease;
			}
			return undefined;
		});
	}
	/** Re-admit the exact held offer against durable policy immediately before allocation. */
	authorizePipelineStart(
		id: string,
		account: Account,
		pipeline: Pipeline,
		at: string,
		phase: "before-open" | "native-mutation" = "before-open",
	): boolean {
		return this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !["reserved", "running"].includes(lease.state))
				return false;
			const configuration = this.configuration()?.configuration;
			const current = configuration
				? configuration.accounts.find((entry) => entry.id === account.id)
				: account;
			const desired = current && this.controlRecord(`ci-policy:${current.id}`);
			const effective =
				current &&
				(desired
					? effectiveCiAccount(current, parseCiPolicy(desired.bodyJson))
					: current);
			const identity = effective && ciBudgetIdentity(effective, at);
			const selected =
				effective &&
				(!lease.queueDeadlineAt ||
					(Number.isFinite(Date.parse(lease.queueDeadlineAt)) &&
						Date.parse(lease.queueDeadlineAt) > Date.parse(at))) &&
				pipeline.accountId === effective.id &&
				pipeline.timeoutSeconds <= effective.maxRuntimeMinutes * 60
					? route(
							{
								...effective,
								maxRuntimeMinutes: Math.ceil(pipeline.timeoutSeconds / 60),
								offers: effective.offers.map((offer) => ({
									...offer,
									enabled:
										offer.enabled &&
										offer.id === lease.offerId &&
										offer.provider === lease.provider &&
										offer.providerAccountId === lease.providerAccountId,
								})),
							},
							this.all().filter((entry) => entry.id !== lease.id),
							at,
							{
								phase: this.options.sharedBudget ? "plan" : "admit",
								attempt: lease.pipelineId
									? lease.budgetAdmissionAttempt || 1
									: lease.runAttempt + (lease.budgetAdmissionAttempt || 1) - 1,
								queueDurationMs: this.pipelineQueueDurationMs(lease, at),
							},
						)
					: undefined;
			if (
				selected &&
				identity &&
				identity.budgetTenantId === lease.budgetTenantId &&
				identity.budgetId === lease.budgetId &&
				identity.budgetPeriodId === lease.budgetPeriodId &&
				identity.budgetPolicyRevision === lease.budgetPolicyRevision &&
				identity.budgetPolicyDigest === lease.budgetPolicyDigest &&
				selected.paidMicros <= lease.reservedPaidMicros &&
				selected.freeMinutes >= lease.reservedFreeMinutes &&
				selected.offer.priceMicrosPerMinute === lease.priceMicrosPerMinute &&
				selected.offer.validUntil === lease.freeValidUntil
			) {
				if (lease.budgetId) {
					if (!this.options.sharedBudget) return false;
					this.options.sharedBudget.claim(
						lease,
						ciLeasePolicyMeasurements(
							lease,
							this.all(),
							this.pipelineQueueDurationMs(lease, at),
						),
					);
				}
				return true;
			}
			lease.state =
				phase === "native-mutation" || lease.externalOperationId
					? "uncertain"
					: "cancelled";
			if (lease.state === "uncertain" && lease.budgetId)
				this.options.sharedBudget?.uncertain(lease);
			this.append(lease, "ci.AdmissionRevoked", at);
			return false;
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
			if (ciBudgetPolicy(effective) && !this.options.sharedBudget)
				return undefined;
			const demand = this.pinnedQueuedJob(job, at, effective);
			if (
				demand.queueDeadlineAt &&
				Date.parse(demand.queueDeadlineAt) <= Date.parse(at)
			) {
				this.expireQueued(demand, at);
				return undefined;
			}
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
					ACTIVE_STATES.has(lease.state) &&
					(lease.actualJobId === 0 || lease.actualJobId === job.id),
			);
			if (existing) {
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				return existing;
			}
			const blockedOfferIds = new Set<string>();
			while (blockedOfferIds.size < effective.offers.length) {
				const selected = route(
					{
						...effective,
						offers: effective.offers.map((offer) => ({
							...offer,
							enabled:
								offer.enabled &&
								!blockedOfferIds.has(offer.id) &&
								(!offer.backend || offer.backend === "gh-actions"),
						})),
					},
					leases,
					at,
					{
						phase: this.options.sharedBudget ? "plan" : "admit",
						attempt:
							job.runAttempt +
							leases.filter(
								(lease) =>
									lease.repositoryId === job.repositoryId &&
									lease.jobId === job.id &&
									lease.runAttempt === job.runAttempt,
							).length,
						queueDurationMs: this.queueDurationMs(job, at),
					},
				);
				if (!selected) return undefined;
				const id = randomUUID();
				const lease = create(LeaseSchema, {
					id,
					budgetAdmissionAttempt:
						leases.filter(
							(entry) =>
								entry.repositoryId === job.repositoryId &&
								entry.jobId === job.id &&
								entry.runAttempt === job.runAttempt,
						).length + 1,
					accountId: account.id,
					offerId: selected.offer.id,
					provider: selected.offer.provider,
					providerAccountId: selected.offer.providerAccountId,
					...ciBudgetIdentity(effective, at),
					queueDeadlineAt: demand.queueDeadlineAt,
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
					reservedMinutes: selected.minutes,
					reservedFreeMinutes: selected.freeMinutes,
					reservedPaidMicros: selected.paidMicros,
					runnerName: `hobo-${id}`,
					createdAt: at,
				});
				if (lease.budgetId)
					try {
						this.options.sharedBudget?.reserve(
							lease,
							ciLeasePolicyMeasurements(
								lease,
								leases,
								this.queueDurationMs(job, at),
							),
						);
					} catch (error) {
						if (error instanceof BudgetAdmissionDeniedError) {
							blockedOfferIds.add(selected.offer.id);
							continue;
						}
						throw error;
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
	): Lease | undefined {
		return this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !expected.includes(lease.state)) return undefined;
			const before = clone(LeaseSchema, lease);
			const identity = leaseFinancialIdentity(lease);
			update(lease);
			if (lease.state === "dispatching" && !lease.dispatchingAt)
				lease.dispatchingAt = at;
			if (leaseFinancialIdentity(lease) !== identity)
				throw new Error("lease financial identity is immutable");
			const retirement = isIsolatedRetirementTransition(
				before,
				lease,
				type,
				at,
			);
			if (
				!retirement &&
				["dispatching", "claiming", "running"].includes(lease.state)
			) {
				if (!this.authorizeHeldEffect(lease, at))
					throw new Error("durable policy revoked lease execution");
				if (lease.budgetId) {
					if (!this.options.sharedBudget)
						throw new Error("shared CI budget authority unavailable");
					this.options.sharedBudget.claim(
						lease,
						ciLeasePolicyMeasurements(
							lease,
							this.all(),
							lease.pipelineId
								? this.pipelineQueueDurationMs(lease, at)
								: this.queueDurationMs(
										create(JobSchema, {
											id: lease.jobId,
											repositoryId: lease.repositoryId,
											runAttempt: lease.runAttempt,
										}),
										at,
									),
						),
					);
				}
			} else if (!retirement && lease.state === "uncertain" && lease.budgetId)
				this.options.sharedBudget?.uncertain(lease);
			this.append(lease, type, at);
			return lease;
		});
	}
	private authorizeHeldEffect(lease: Lease, at: string): boolean {
		if (
			lease.queueDeadlineAt &&
			Date.parse(lease.queueDeadlineAt) <= Date.parse(at)
		)
			return false;
		const config = this.configuration()?.configuration;
		if (!config) return !lease.budgetId;
		const account = config.accounts.find(
			(entry) => entry.id === lease.accountId,
		);
		if (!account) return false;
		if (
			!lease.pipelineId &&
			!config.connections.some(
				(entry) =>
					entry.accountId === lease.accountId &&
					entry.repositoryId === lease.repositoryId &&
					entry.installationId === lease.installationId &&
					entry.repository.toLowerCase() === lease.repository.toLowerCase(),
			)
		)
			return false;
		const desired = this.controlRecord(`ci-policy:${account.id}`);
		const effective = desired
			? effectiveCiAccount(account, parseCiPolicy(desired.bodyJson))
			: account;
		const identity = ciBudgetIdentity(effective, at);
		if (
			identity.budgetTenantId !== lease.budgetTenantId ||
			identity.budgetId !== lease.budgetId ||
			identity.budgetPeriodId !== lease.budgetPeriodId ||
			identity.budgetPolicyRevision !== lease.budgetPolicyRevision ||
			identity.budgetPolicyDigest !== lease.budgetPolicyDigest ||
			lease.reservedMinutes >
				effective.maxRuntimeMinutes + effective.startupMinutes ||
			lease.reservedMinutes < effective.startupMinutes
		)
			return false;
		const selected = route(
			{
				...effective,
				maxRuntimeMinutes: lease.reservedMinutes - effective.startupMinutes,
				offers: effective.offers.map((offer) => ({
					...offer,
					enabled:
						offer.enabled &&
						offer.id === lease.offerId &&
						offer.provider === lease.provider &&
						(lease.providerAccountId
							? offer.providerAccountId === lease.providerAccountId
							: !lease.budgetId),
				})),
			},
			this.all().filter((entry) => entry.id !== lease.id),
			at,
			{
				phase: this.options.sharedBudget ? "plan" : "admit",
				attempt: lease.pipelineId
					? lease.budgetAdmissionAttempt || 1
					: lease.runAttempt + (lease.budgetAdmissionAttempt || 1) - 1,
				queueDurationMs: lease.pipelineId
					? this.pipelineQueueDurationMs(lease, at)
					: this.queueDurationMs(
							create(JobSchema, {
								id: lease.jobId,
								repositoryId: lease.repositoryId,
								runAttempt: lease.runAttempt,
							}),
							at,
						),
			},
		);
		return (
			!!selected &&
			selected.paidMicros <= lease.reservedPaidMicros &&
			selected.freeMinutes >= lease.reservedFreeMinutes &&
			selected.offer.priceMicrosPerMinute === lease.priceMicrosPerMinute &&
			selected.offer.validUntil === lease.freeValidUntil
		);
	}
	queue(job: Job, at: string): void {
		this.transaction(() => this.queueInside(job, at));
	}
	private pinnedQueuedJob(job: Job, at: string, account?: Account): Job {
		const prior = this.events()
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
		const leases = this.all().filter(
			(lease) =>
				lease.repositoryId === job.repositoryId &&
				lease.jobId === job.id &&
				lease.runAttempt === job.runAttempt,
		);
		const first = [
			at,
			...prior.map((entry) => entry.at),
			...leases.map((lease) => lease.createdAt),
		].reduce((earliest, value) =>
			Date.parse(value) < Date.parse(earliest) ? value : earliest,
		);
		return pinCiQueueDeadline(job, first, account, [
			...prior.map((entry) => entry.job.queueDeadlineAt),
			...leases.map((lease) => lease.queueDeadlineAt),
		]);
	}
	private queueDurationMs(job: Job, at: string): number {
		const prior = this.events()
			.filter((event) => event.type === "ci.JobQueued")
			.filter((event) => {
				const queued = fromJsonString(JobSchema, event.detail);
				return (
					queued.repositoryId === job.repositoryId &&
					queued.id === job.id &&
					queued.runAttempt === job.runAttempt
				);
			})
			.map((event) => Date.parse(event.at));
		const leases = this.all()
			.filter(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt,
			)
			.map((lease) => Date.parse(lease.createdAt));
		return Math.max(
			0,
			Date.parse(at) - Math.min(Date.parse(at), ...prior, ...leases),
		);
	}
	private pipelineQueueDurationMs(lease: Lease, at: string): number {
		const receipts = this.all()
			.filter(
				(entry) =>
					entry.accountId === lease.accountId &&
					entry.pipelineId === lease.pipelineId,
			)
			.map((entry) => Date.parse(entry.createdAt));
		return Math.max(
			0,
			Date.parse(at) -
				Math.min(Date.parse(at), Date.parse(lease.createdAt), ...receipts),
		);
	}
	/** Expire only untouched demand. Once provider work may exist, keep its hold. */
	expireQueued(job: Job, at: string, expectedRevision?: number): boolean {
		return this.transaction(() => {
			if (
				expectedRevision !== undefined &&
				this.configuration()?.revision !== expectedRevision
			)
				throw new Error("configuration revision conflict");
			const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
			const row = this.db
				.prepare("SELECT body FROM pending_jobs WHERE job_key=?")
				.get(key);
			const pending = row
				? fromJsonString(JobSchema, z.string().parse(row.body))
				: job;
			if (
				!pending.queueDeadlineAt ||
				!Number.isFinite(Date.parse(pending.queueDeadlineAt)) ||
				!Number.isFinite(Date.parse(at)) ||
				Date.parse(pending.queueDeadlineAt) > Date.parse(at)
			)
				return false;
			const leases = this.all().filter(
				(lease) =>
					lease.repositoryId === job.repositoryId &&
					lease.jobId === job.id &&
					lease.runAttempt === job.runAttempt &&
					ACTIVE_STATES.has(lease.state),
			);
			if (leases.some((lease) => lease.state !== "reserved")) return false;
			for (const lease of leases) {
				lease.state = "cancelled";
				this.append(lease, "ci.LeaseExpired", at);
			}
			if (
				this.db.prepare("SELECT 1 FROM terminal_jobs WHERE job_key=?").get(key)
			)
				return true;
			this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
			this.db
				.prepare("INSERT OR IGNORE INTO terminal_jobs(job_key) VALUES(?)")
				.run(key);
			this.db.prepare("INSERT INTO events(body) VALUES(?)").run(
				toJsonString(
					CiEventSchema,
					create(CiEventSchema, {
						type: "ci.JobExpired",
						at,
						accountId: this.jobOwner(pending),
						detail: toJsonString(JobSchema, pending),
					}),
				),
			);
			return true;
		});
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
					ACTIVE_STATES.has(lease.state) &&
					(lease.actualJobId === 0 || lease.actualJobId === job.id),
			)
		)
			return;
		const config = this.configuration()?.configuration;
		const binding = config?.connections.find(
			(entry) =>
				entry.repositoryId === job.repositoryId &&
				entry.installationId === job.installationId &&
				entry.repository.toLowerCase() === job.repository.toLowerCase(),
		);
		const account = config?.accounts.find(
			(entry) => entry.id === binding?.accountId,
		);
		const desired = account && this.controlRecord(`ci-policy:${account.id}`);
		const effective =
			account &&
			(desired
				? effectiveCiAccount(account, parseCiPolicy(desired.bodyJson))
				: account);
		const pinned = this.pinnedQueuedJob(job, at, effective);
		if (
			pinned.queueDeadlineAt &&
			Date.parse(pinned.queueDeadlineAt) <= Date.parse(at)
		) {
			this.expireQueued(pinned, at);
			return;
		}
		const detail = toJsonString(JobSchema, pinned);
		this.db.prepare("INSERT INTO events(body) VALUES (?)").run(
			toJsonString(
				CiEventSchema,
				create(CiEventSchema, {
					type: "ci.JobQueued",
					at,
					accountId: this.jobOwner(pinned),
					detail,
				}),
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
							accountId: lease.accountId,
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
							accountId: this.jobOwner(job),
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
		evidence?: BudgetSettlementEvidence,
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
			lease.usageProvenance = evidence ? "provider-final" : "estimated";
			lease.usageEvidenceRef = evidence?.usageEvidenceRef ?? "";
			if (result) lease.result = result;
			if (lease.budgetId) {
				if (!this.options.sharedBudget)
					throw new Error("shared CI budget authority unavailable");
				if (evidence)
					assertCiParentSettlement(
						lease,
						this.options.sharedBudget.settle(lease, evidence),
						evidence,
					);
				else {
					lease.state = "uncertain";
					this.options.sharedBudget.uncertain(lease);
				}
			}
			this.append(
				lease,
				lease.state === "completed" ? "ci.HostSettled" : "ci.UsageEstimated",
				at,
			);
			if (lease.paidMicros > lease.reservedPaidMicros)
				this.append(lease, "ci.BudgetOverrun", at);
			if (unmet) this.queueInside(unmet, at);
			return lease;
		});
	}
	recordPipelineOperation(
		id: string,
		externalOperationId: string,
		at: string,
	): void {
		if (!/^[!-~]{1,500}$/u.test(externalOperationId))
			throw new Error("invalid native pipeline execution identity");
		this.transaction(() => {
			const lease = this.get(id);
			if (!lease?.pipelineId || !["running", "uncertain"].includes(lease.state))
				throw new Error("pipeline is not awaiting native execution identity");
			if (
				lease.externalOperationId &&
				lease.externalOperationId !== externalOperationId
			)
				throw new Error("native pipeline execution identity is immutable");
			if (lease.externalOperationId) return;
			lease.externalOperationId = externalOperationId;
			this.append(lease, "ci.NativeExecutionBound", at);
		});
	}
	recordPipelineResult(id: string, result: PipelineResult, at: string): void {
		this.transaction(() => {
			const lease = this.get(id);
			if (
				!lease?.pipelineId ||
				!ACTIVE_STATES.has(lease.state) ||
				result.id !== lease.pipelineId
			)
				throw new Error(
					"pipeline result does not match active durable execution",
				);
			lease.result = result;
			this.append(lease, "ci.PipelineResultObserved", at);
		});
	}
	/** Positive provider final usage, bound to the durable execution identity. */
	settlePipelineUsage(
		id: string,
		observation: PipelineUsageObservation,
		at: string,
		result?: PipelineResult,
	): Lease | undefined {
		return this.transaction(() => {
			const lease = this.get(id);
			if (
				!lease?.pipelineId ||
				(!ACTIVE_STATES.has(lease.state) &&
					!(
						lease.state === "completed" && lease.usageProvenance === "estimated"
					))
			)
				return undefined;
			if (
				!lease.externalOperationId ||
				observation.leaseId !== lease.id ||
				observation.pipelineId !== lease.pipelineId ||
				observation.pipelineDigest !== lease.pipelineDigest ||
				observation.provider !== lease.provider ||
				observation.providerAccountId !== lease.providerAccountId ||
				observation.externalOperationId !== lease.externalOperationId ||
				!observation.usageFinal ||
				!observation.stopped ||
				!observation.usageEvidenceRef ||
				!observation.sourceStoppedEvidenceRef ||
				!Number.isFinite(Date.parse(observation.completedAt)) ||
				Date.parse(observation.completedAt) < Date.parse(lease.createdAt) ||
				Date.parse(observation.completedAt) > Date.parse(at) ||
				![
					observation.billedMinutes,
					observation.billedFreeMinutes,
					observation.paidMicros,
				].every((value) => Number.isSafeInteger(value) && value >= 0) ||
				observation.billedFreeMinutes > observation.billedMinutes ||
				observation.billedFreeMinutes > lease.reservedFreeMinutes
			)
				throw new Error(
					"native pipeline usage proof does not match the durable execution",
				);
			lease.state = "completed";
			lease.billedMinutes = observation.billedMinutes;
			lease.billedFreeMinutes = observation.billedFreeMinutes;
			lease.paidMicros = observation.paidMicros;
			lease.settledAt = at;
			lease.usageCompletedAt = observation.completedAt;
			lease.usageProvenance = "provider-final";
			lease.usageEvidenceRef = observation.usageEvidenceRef;
			if (result) lease.result = result;
			if (lease.budgetId) {
				if (!this.options.sharedBudget)
					throw new Error("shared CI budget authority unavailable");
				assertCiParentSettlement(
					lease,
					this.options.sharedBudget.settle(lease, observation),
					observation,
				);
			}
			this.append(lease, "ci.HostSettled", at);
			if (lease.paidMicros > lease.reservedPaidMicros)
				this.append(lease, "ci.BudgetOverrun", at);
			return lease;
		});
	}
	/** Reconcile delayed native financial finality without creating any execution resource. */
	reconcileSharedBudget(
		id: string,
		paidMicros: number,
		evidence: BudgetSettlementEvidence,
		at: string,
	): Lease {
		return this.transaction(() => {
			const lease = this.get(id);
			if (
				!lease?.budgetId ||
				!this.options.sharedBudget ||
				!["reserved", "cancelled", "uncertain", "completed"].includes(
					lease.state,
				) ||
				!Number.isSafeInteger(paidMicros) ||
				paidMicros < 0
			)
				throw new Error(
					"shared CI usage is not awaiting financial reconciliation",
				);
			if (
				lease.state === "completed" &&
				lease.usageProvenance === "provider-final"
			) {
				if (
					lease.paidMicros !== paidMicros ||
					lease.usageEvidenceRef !== evidence.usageEvidenceRef
				)
					throw new Error("final CI financial usage is immutable");
				return lease;
			}
			lease.paidMicros = paidMicros;
			lease.usageProvenance = "provider-final";
			lease.usageEvidenceRef = evidence.usageEvidenceRef;
			lease.state = "completed";
			lease.settledAt = at;
			assertCiParentSettlement(
				lease,
				this.options.sharedBudget.settle(lease, evidence),
				evidence,
			);
			this.append(lease, "ci.HostSettled", at);
			if (paidMicros > lease.reservedPaidMicros)
				this.append(lease, "ci.BudgetOverrun", at);
			return lease;
		});
	}
	releaseUnusedSharedBudget(
		id: string,
		evidenceRef: string,
		at = new Date().toISOString(),
	): void {
		this.transaction(() => {
			const lease = this.get(id);
			if (
				!lease?.budgetId ||
				!this.options.sharedBudget ||
				lease.state !== "cancelled"
			)
				throw new Error("unused shared CI hold is not durably cancelled");
			const receipt = this.options.sharedBudget.releaseUnused(
				lease,
				evidenceRef,
			);
			lease.budgetReleaseEvidenceRef = ciParentReleaseEvidenceRef(
				lease,
				receipt,
				evidenceRef,
			);
			this.append(lease, "ci.ParentBudgetReleased", at);
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
	/** Drop box demand when GitHub assigned the job elsewhere; never re-queue. */
	withdrawQueuedJob(
		job: Job,
		at: string,
		expectedRevision?: number,
		exceptLeaseId?: string,
	): boolean {
		return this.transaction(() => {
			if (
				expectedRevision !== undefined &&
				this.configuration()?.revision !== expectedRevision
			)
				throw new Error("configuration revision conflict");
			const configuration = this.configuration()?.configuration;
			const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
			let changed = false;
			for (const lease of this.all()) {
				if (
					lease.repositoryId !== job.repositoryId ||
					lease.jobId !== job.id ||
					lease.runAttempt !== job.runAttempt ||
					!ACTIVE_STATES.has(lease.state)
				)
					continue;
				if (exceptLeaseId && lease.id === exceptLeaseId) continue;
				const offer = configuration?.accounts
					.find((account) => account.id === lease.accountId)
					?.offers.find((candidate) => candidate.id === lease.offerId);
				if (
					!shouldAbortIsolatedFleetLease(
						lease.provider,
						offer
							? { backend: offer.backend, runsOn: offer.runsOn }
							: undefined,
					)
				)
					continue;
				lease.state = "cancelled";
				this.append(lease, "ci.LeaseCancelled", at);
				changed = true;
			}
			if (
				this.db.prepare("SELECT 1 FROM pending_jobs WHERE job_key=?").get(key)
			) {
				this.db.prepare("DELETE FROM pending_jobs WHERE job_key=?").run(key);
				changed = true;
			}
			return changed;
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
		this.transaction(() => {
			const lease = this.get(id);
			if (!lease || !recoverable.has(lease.state)) return;
			const configuration = this.configuration()?.configuration;
			const offer = configuration?.accounts
				.find((account) => account.id === lease.accountId)
				?.offers.find((candidate) => candidate.id === lease.offerId);
			if (
				!shouldAbortIsolatedFleetLease(
					lease.provider,
					offer ? { backend: offer.backend, runsOn: offer.runsOn } : undefined,
				)
			)
				return;
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

				if (
					["ci.JobQueued", "ci.JobCompleted", "ci.JobExpired"].includes(
						event.type,
					)
				) {
					const job = fromJsonString(JobSchema, event.detail);
					const key = `${job.repositoryId}:${job.id}:${job.runAttempt}`;
					if (event.type !== "ci.JobQueued") {
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
