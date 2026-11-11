/**
 * The hosted relay's store on a cache (ADR-0179, phase 4a).
 *
 * Everything here is short-lived state in an `EphemeralStatePort`: one lease
 * record per job attempt, one job record (taken marker, pending demand,
 * assignment fence and terminal tombstone), a small per-account in-flight
 * index, a pending-demand set, webhook dedupe markers, sandbox counters and a
 * per-account change ring. Configuration is read-only, supplied by the config
 * service. There is no partition lock: every write is a compare-and-set on
 * one key, and the expected-state checks of `PostgresCiStore` are kept on
 * each of them. Lease ids are deterministic (`lease-id.ts`), so a lost record
 * is found again by name (`rebuild.ts`).
 *
 * What the Postgres store kept as durable history is gone by design: no event
 * journal, no completed-lease ledger, no inbox. Budget exposure is what
 * providers report plus the holds of in-flight leases.
 */
import { randomUUID } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import {
	ACTIVE_STATES,
	type Account,
	AccountSchema,
	accountEventPage,
	allocationQuote,
	type CiEvent,
	type CiEventPage,
	CiEventSchema,
	type CiObserver,
	type ConfigurationState,
	type ControlRecord,
	ControlRecordSchema,
	ciBudgetIdentity,
	ciBudgetPolicy,
	type EventCursor,
	effectiveCiAccount,
	eventCursorBounds,
	isIsolatedRetirementTransition,
	isWebhookDeliveryId,
	type Job,
	JobSchema,
	jobAccountId,
	type Lease,
	type LeaseEventsQuery,
	LeaseSchema,
	leaseEventsBounds,
	MAX_WEBHOOKS_PER_INSTALLATION_WINDOW,
	type Offer,
	parseCiPolicy,
	parseWebhookEnvelope,
	type QuarantinedWebhook,
	route,
	type SandboxAllowance,
	SandboxAllowanceSchema,
	type SandboxMeasuredUsage,
	SandboxPricingSchema,
	type SequencedCiEvent,
	SequencedCiEventSchema,
	sandboxProxyOnlyUsageQuote,
	sandboxUsageQuote,
	shouldAbortIsolatedFleetLease,
	type WebhookInput,
} from "@hobo/ci";
import { leaseFinancialIdentity, pinCiQueueDeadline } from "@hobo/ci/store";
import {
	createEphemeralRing,
	type EphemeralKey,
	type EphemeralRing,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
} from "@hobo/core";
import {
	RelayCacheAssignmentSchema,
	RelayCacheDeliverySchema,
	type RelayCacheInflight,
	type RelayCacheInflightEntry,
	RelayCacheInflightEntrySchema,
	RelayCacheInflightSchema,
	RelayCacheIntentSchema,
	type RelayCacheJob,
	RelayCacheJobSchema,
	type RelayCacheLease,
	RelayCacheLeaseSchema,
	RelayCachePendingSchema,
	RelayCacheSandboxEgressSchema,
} from "../_generated/relay_cache_pb.js";
import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import {
	isDeterministicLeaseId,
	parseRelayJobKey,
	RELAY_MAX_GENERATION,
	relayJobKey,
	relayLeaseId,
} from "./lease-id.js";
import {
	deriveSandboxProxyToken,
	type ProxyTokenKey,
	sandboxProxyDigestMatches,
	verifySandboxProxyToken,
} from "./proxy-token.js";
import {
	decodeRecord,
	encodeRecord,
	RELAY_FEED_CAPACITY,
	RELAY_MAX_PENDING,
	RELAY_MAX_RECENT_TERMINAL,
	RELAY_PHANTOM_ENTRY_GRACE_MS,
	RELAY_PROXY_RATE_LIMIT,
	RELAY_PROXY_RATE_WINDOW_MS,
	RELAY_TTL,
	RELAY_WEBHOOK_RATE_WINDOW_MS,
	type RelayCacheKeys,
	relayCacheKeys,
	relayLeaseTtl,
	relaySandboxCounterTtl,
} from "./records.js";

/** Read-only configuration as the config service supplies it. */
export type RelayConfigSnapshot = Readonly<{
	state: ConfigurationState;
	/** Desired CI policy per account (`ci-policy:<accountId>` today). */
	policies: readonly Readonly<{ accountId: string; bodyJson: string }>[];
}>;

/** Where the store reads configuration. It never writes there. */
export interface RelayConfigSource {
	read(): Promise<RelayConfigSnapshot>;
}

/** A fixed snapshot: tests, and a host that refreshes by rebuilding the store. */
export function staticRelayConfig(
	snapshot: RelayConfigSnapshot,
): RelayConfigSource {
	return { read: async () => snapshot };
}

/**
 * Spend a provider reports for an account (phase 4b pulls it from Vercel's
 * and GitHub's usage APIs). Budget exposure is this plus in-flight holds.
 */
export type ProviderUsageObservation = Readonly<{
	observedAt: string;
	accountSpentMicros?: number;
	/** Spend per offer id. */
	offerSpentMicros?: Readonly<Record<string, number>>;
}>;
export interface ProviderUsagePort {
	observed(accountId: string): Promise<ProviderUsageObservation | undefined>;
}
/** Phase 4a stub: no pulled usage, so exposure is configured spend plus holds. */
export const NO_PROVIDER_USAGE: ProviderUsagePort = {
	observed: async () => undefined,
};

/** A verified webhook the relay accepted, handed to intake (Vercel Queue in phase 4b). */
export type RelayAcceptedDelivery = Readonly<WebhookInput>;
export interface RelayWebhookIntake {
	enqueue(delivery: RelayAcceptedDelivery): Promise<void>;
}

/** A write this store refuses because configuration lives in the config service. */
export class RelayConfigReadOnlyError extends Error {
	readonly code = "HOBO_CI_RELAY_CONFIG_READ_ONLY";
	constructor(what: string) {
		super(`${what}: configuration is read-only on the hosted relay`);
		this.name = "RelayConfigReadOnlyError";
	}
}

export type RelayCacheStoreOptions = Readonly<{
	state: EphemeralStatePort;
	config: RelayConfigSource;
	/** Key namespace: `hobo-ci:<environment>:`. */
	environment: string;
	intake?: RelayWebhookIntake;
	usage?: ProviderUsagePort;
	/** Key for derived sandbox proxy tokens; sandbox proxy paths refuse without it. */
	proxyTokenKey?: ProxyTokenKey;
	/** Called with a fixed event name and counts only; never values. */
	onDiagnostic?: (
		event: string,
		detail: Readonly<Record<string, number | string>>,
	) => void;
	/** Wall clock for sandbox proxy rate windows. */
	nowMs?: () => number;
}>;

const MAX_CAS_ATTEMPTS = 16;
const RETRY = Symbol("retry");
type Retry = typeof RETRY;
const TERMINAL = new Set(["completed", "cancelled"]);
const INTENT_KINDS = new Set([
	"ci.DispatchRequested",
	"ci.RunnerClaimed",
	"ci.SandboxCreated",
]);
const SANDBOX_FIELDS = [
	"cpuVcpuMs",
	"memoryMbMs",
	"egressBytes",
	"creations",
	"proxyBytes",
	"proxySessions",
	"proxyControlCalls",
] as const;

type Slot<T> = { version: EphemeralVersion; record: T };
type LeaseSlot = Slot<RelayCacheLease> & { lease: Lease };
/** An account's in-flight index as read: the stored slot, or a fresh empty record. */
type IndexRead = {
	slot?: Slot<RelayCacheInflight>;
	record: RelayCacheInflight;
};

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

/** Priced offers pause while the in-flight holds are unknown; free capacity keeps admitting. */
function isPricedOffer(offer: Offer): boolean {
	return offer.priceMicrosPerMinute > 0 || offer.backend === "sandbox";
}

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

function sameConnection(
	entry: { repositoryId: number; installationId: number; repository: string },
	job: { repositoryId: number; installationId: number; repository: string },
): boolean {
	return (
		entry.repositoryId === job.repositoryId &&
		entry.installationId === job.installationId &&
		entry.repository.toLowerCase() === job.repository.toLowerCase()
	);
}

function earliest(...values: (string | undefined)[]): string | undefined {
	let best: string | undefined;
	for (const value of values) {
		if (!value || !Number.isFinite(Date.parse(value))) continue;
		if (!best || Date.parse(value) < Date.parse(best)) best = value;
	}
	return best;
}

function counterValue(value: string | undefined): number {
	if (value === undefined) return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error("invalid cache counter");
	return parsed;
}

/** The relay's store on the cache. See the package README for every key and TTL. */
export class RelayCacheStore {
	private readonly state: EphemeralStatePort;
	private readonly keys: RelayCacheKeys;
	private readonly usage: ProviderUsagePort;
	private readonly rings = new Map<string, EphemeralRing>();
	private readonly nowMs: () => number;
	private casLosses = 0;

	constructor(private readonly options: RelayCacheStoreOptions) {
		this.state = options.state;
		this.keys = relayCacheKeys(options.environment);
		this.usage = options.usage ?? NO_PROVIDER_USAGE;
		this.nowMs = options.nowMs ?? Date.now;
	}

	/** Compare-and-set races this instance lost and retried (diagnostic). */
	casRetries(): number {
		return this.casLosses;
	}

	// -------------------------------------------------------------------------
	// Primitives
	// -------------------------------------------------------------------------

	private async retry<T>(
		what: string,
		attempt: () => Promise<T | Retry>,
	): Promise<T> {
		for (let n = 0; n < MAX_CAS_ATTEMPTS; n++) {
			const result = await attempt();
			if (result !== RETRY) return result;
			this.casLosses += 1;
		}
		throw new Error(`${what}: compare-and-set kept losing; retry later`);
	}

	/** Create (no version) or compare-and-set (version); the new version, or undefined when the race was lost. */
	private async write(
		key: EphemeralKey,
		version: EphemeralVersion | undefined,
		value: string,
		ttl: EphemeralTtlMs,
	): Promise<EphemeralVersion | undefined> {
		const result = version
			? await this.state.compareAndSet(key, version, value, ttl)
			: await this.state.putIfAbsent(key, value, ttl);
		return result.applied ? result.version : undefined;
	}

	private parseLease(
		entry: { value: string; version: EphemeralVersion } | undefined,
	): LeaseSlot | undefined {
		if (!entry) return undefined;
		const record = decodeRecord(RelayCacheLeaseSchema, entry.value);
		return {
			version: entry.version,
			record,
			lease: decodeRecord(LeaseSchema, record.leaseJson),
		};
	}

	private async readLease(id: string): Promise<LeaseSlot | undefined> {
		if (!id) return undefined;
		return this.parseLease(await this.state.get(this.keys.lease(id)));
	}

	private async readLeases(
		ids: readonly string[],
	): Promise<(LeaseSlot | undefined)[]> {
		if (ids.length === 0) return [];
		const found = await this.state.getMany(
			ids.map((id) => this.keys.lease(id)),
		);
		return found.map((entry) => this.parseLease(entry));
	}

	private leaseTtl(lease: Lease): EphemeralTtlMs {
		return TERMINAL.has(lease.state)
			? RELAY_TTL.terminal
			: relayLeaseTtl(lease);
	}

	/** Write a lease back under its version, keeping the latest intent of each kind. */
	private async writeLease(
		slot: LeaseSlot,
		lease: Lease,
		type: string,
		at: string,
	): Promise<EphemeralVersion | undefined> {
		const record = clone(RelayCacheLeaseSchema, slot.record);
		record.leaseJson = encodeRecord(LeaseSchema, lease);
		if (INTENT_KINDS.has(type)) {
			record.intents = [
				...record.intents.filter((intent) => intent.kind !== type),
				create(RelayCacheIntentSchema, { kind: type, at }),
			];
		}
		return this.write(
			this.keys.lease(lease.id),
			slot.version,
			encodeRecord(RelayCacheLeaseSchema, record),
			this.leaseTtl(lease),
		);
	}

	private async readJob(key: string): Promise<Slot<RelayCacheJob> | undefined> {
		const entry = await this.state.get(this.keys.job(key));
		return entry
			? {
					version: entry.version,
					record: decodeRecord(RelayCacheJobSchema, entry.value),
				}
			: undefined;
	}

	private jobTtl(record: RelayCacheJob, lease?: Lease): EphemeralTtlMs {
		if (record.state === "terminal") return RELAY_TTL.terminal;
		if (lease && !TERMINAL.has(lease.state)) return relayLeaseTtl(lease);
		return RELAY_TTL.jobPending;
	}

	private async writeJob(
		slot: Slot<RelayCacheJob> | undefined,
		record: RelayCacheJob,
		lease?: Lease,
	): Promise<EphemeralVersion | undefined> {
		return this.write(
			this.keys.job(record.jobKey),
			slot?.version,
			encodeRecord(RelayCacheJobSchema, record),
			this.jobTtl(record, lease),
		);
	}

	/** Every lease of a job attempt that still has a record, generation 0 first. */
	private async jobLeases(
		job: { repositoryId: number; jobId: number; runAttempt: number },
		upTo: number,
	): Promise<LeaseSlot[]> {
		const ids: string[] = [];
		for (let g = 0; g <= Math.min(upTo, RELAY_MAX_GENERATION); g++)
			ids.push(relayLeaseId(job, g));
		return (await this.readLeases(ids)).filter(
			(slot): slot is LeaseSlot => slot !== undefined,
		);
	}

	private ring(accountId: string): EphemeralRing {
		let ring = this.rings.get(accountId);
		if (!ring) {
			ring = createEphemeralRing(this.state, {
				name: this.keys.feedRing(accountId),
				capacity: RELAY_FEED_CAPACITY,
				ttlMs: RELAY_TTL.feed,
			});
			this.rings.set(accountId, ring);
		}
		return ring;
	}

	/** Append a change to the account's ring. Loss-tolerant: a failed append is reported, not thrown. */
	private async emit(
		type: string,
		at: string,
		detail: string,
		accountId: string,
		leaseId = "",
	): Promise<void> {
		if (!accountId) return;
		try {
			await this.ring(accountId).append(
				encodeRecord(
					CiEventSchema,
					create(CiEventSchema, { type, at, detail, accountId, leaseId }),
				),
			);
		} catch {
			this.options.onDiagnostic?.("hobo_ci_relay_feed_append_failed", { type });
		}
	}

	private emitLease(lease: Lease, type: string, at: string): Promise<void> {
		return this.emit(
			type,
			at,
			encodeRecord(LeaseSchema, lease),
			lease.accountId,
			lease.id,
		);
	}

	// -------------------------------------------------------------------------
	// Configuration (read-only)
	// -------------------------------------------------------------------------

	private snapshot(): Promise<RelayConfigSnapshot> {
		return this.options.config.read();
	}

	private async checkRevision(
		expected: number | undefined,
	): Promise<RelayConfigSnapshot> {
		const snapshot = await this.snapshot();
		if (expected !== undefined && snapshot.state.revision !== expected)
			throw new Error("configuration revision conflict");
		return snapshot;
	}

	private effective(snapshot: RelayConfigSnapshot, account: Account): Account {
		const desired = snapshot.policies.find(
			(entry) => entry.accountId === account.id,
		);
		return desired
			? effectiveCiAccount(account, parseCiPolicy(desired.bodyJson))
			: account;
	}

	private accountIds(snapshot: RelayConfigSnapshot): string[] {
		return (snapshot.state.configuration?.accounts ?? []).map(
			(account) => account.id,
		);
	}

	async ready(): Promise<boolean> {
		try {
			await this.state.get(this.keys.pending());
			return true;
		} catch {
			return false;
		}
	}

	async configuration(): Promise<ConfigurationState | undefined> {
		return (await this.snapshot()).state;
	}

	async policySnapshot(): Promise<{
		state: ConfigurationState | undefined;
		policies: { accountId: string; bodyJson: string }[];
	}> {
		const snapshot = await this.snapshot();
		return {
			state: snapshot.state,
			policies: snapshot.policies.map((entry) => ({ ...entry })),
		};
	}

	/** Policy records are served from config; every other control record is gone with the relay's control tables. */
	async controlRecord(key: string): Promise<ControlRecord | undefined> {
		const match = /^ci-policy:([A-Za-z0-9_-]{1,80})$/.exec(key);
		if (!match) return undefined;
		const snapshot = await this.snapshot();
		const policy = snapshot.policies.find(
			(entry) => entry.accountId === match[1],
		);
		return policy
			? create(ControlRecordSchema, {
					key,
					accountId: policy.accountId,
					bodyJson: policy.bodyJson,
					updatedAt: snapshot.state.updatedAt,
				})
			: undefined;
	}

	configure(): Promise<ConfigurationState> {
		return Promise.reject(new RelayConfigReadOnlyError("configure"));
	}
	configureWithRecord(): Promise<ConfigurationState> {
		return Promise.reject(new RelayConfigReadOnlyError("configureWithRecord"));
	}
	reattestRate(): Promise<ConfigurationState> {
		return Promise.reject(new RelayConfigReadOnlyError("reattestRate"));
	}
	putControlRecord(): Promise<void> {
		return Promise.reject(new RelayConfigReadOnlyError("putControlRecord"));
	}
	putControlRecordMonotonic(): Promise<ControlRecord | undefined> {
		return Promise.reject(
			new RelayConfigReadOnlyError("putControlRecordMonotonic"),
		);
	}

	// -------------------------------------------------------------------------
	// In-flight index and pending set
	// -------------------------------------------------------------------------

	private parseIndex(
		accountId: string,
		entry: { value: string; version: EphemeralVersion } | undefined,
	): IndexRead {
		if (!entry)
			return {
				record: create(RelayCacheInflightSchema, {
					accountId,
					holdsKnown: false,
				}),
			};
		const record = decodeRecord(RelayCacheInflightSchema, entry.value);
		return { slot: { version: entry.version, record }, record };
	}

	private async readIndexes(
		accountIds: readonly string[],
	): Promise<Map<string, IndexRead>> {
		const out = new Map<string, IndexRead>();
		if (accountIds.length === 0) return out;
		const found = await this.state.getMany(
			accountIds.map((id) => this.keys.inflight(id)),
		);
		for (const [index, id] of accountIds.entries())
			out.set(id, this.parseIndex(id, found[index]));
		return out;
	}

	private indexTtl(record: RelayCacheInflight): EphemeralTtlMs {
		const minutes = Math.max(
			0,
			...record.entries.map((entry) => entry.reservedMinutes),
		);
		return relayLeaseTtl({ reservedMinutes: minutes + 60 });
	}

	/** Read-modify-CAS the account's index; `change` returns false for no write. */
	private async mutateIndex(
		accountId: string,
		change: (record: RelayCacheInflight) => boolean,
	): Promise<RelayCacheInflight> {
		return this.retry("in-flight index", async () => {
			const { slot, record } = this.parseIndex(
				accountId,
				await this.state.get(this.keys.inflight(accountId)),
			);
			const next = clone(RelayCacheInflightSchema, record);
			if (!change(next)) return next;
			const written = await this.write(
				this.keys.inflight(accountId),
				slot?.version,
				encodeRecord(RelayCacheInflightSchema, next),
				this.indexTtl(next),
			);
			return written ? next : RETRY;
		});
	}

	/** Move ended or vanished leases out of the in-flight set. */
	private async retireFromIndex(
		accountId: string,
		leaseIds: readonly string[],
	): Promise<void> {
		if (leaseIds.length === 0) return;
		const gone = new Set(leaseIds);
		await this.mutateIndex(accountId, (record) => {
			const before = record.entries.length;
			record.entries = record.entries.filter(
				(entry) => !gone.has(entry.leaseId),
			);
			if (record.entries.length === before) return false;
			record.recentTerminal = [
				...record.recentTerminal.filter((id) => !gone.has(id)),
				...leaseIds,
			].slice(-RELAY_MAX_RECENT_TERMINAL);
			return true;
		});
	}

	private entryLease(accountId: string, entry: RelayCacheInflightEntry): Lease {
		const job = parseRelayJobKey(entry.jobKey);
		return create(LeaseSchema, {
			id: entry.leaseId,
			accountId,
			offerId: entry.offerId,
			provider: entry.provider,
			providerAccountId: entry.providerAccountId,
			reservedPaidMicros: entry.reservedPaidMicros,
			reservedFreeMinutes: entry.reservedFreeMinutes,
			reservedMinutes: entry.reservedMinutes,
			sandboxReservedAllowance: entry.sandboxReservedAllowanceJson
				? decodeRecord(
						SandboxAllowanceSchema,
						entry.sandboxReservedAllowanceJson,
					)
				: undefined,
			state: "reserved",
			repositoryId: job.repositoryId,
			jobId: job.jobId,
			runAttempt: job.runAttempt,
			createdAt: entry.createdAt,
		});
	}

	private indexEntry(lease: Lease): RelayCacheInflightEntry {
		return create(RelayCacheInflightEntrySchema, {
			leaseId: lease.id,
			jobKey: relayJobKey(lease),
			offerId: lease.offerId,
			provider: lease.provider,
			providerAccountId: lease.providerAccountId,
			reservedPaidMicros: lease.reservedPaidMicros,
			reservedFreeMinutes: lease.reservedFreeMinutes,
			reservedMinutes: lease.reservedMinutes,
			sandboxReservedAllowanceJson: lease.sandboxReservedAllowance
				? encodeRecord(SandboxAllowanceSchema, lease.sandboxReservedAllowance)
				: "",
			createdAt: lease.createdAt,
		});
	}

	/** Add (or keep) an index entry for a lease that exists; used by rebuild. */
	async holdInIndex(lease: Lease): Promise<void> {
		if (TERMINAL.has(lease.state)) return;
		await this.mutateIndex(lease.accountId, (record) => {
			if (record.entries.some((entry) => entry.leaseId === lease.id))
				return false;
			record.entries.push(this.indexEntry(lease));
			return true;
		});
	}

	/** A rebuild pass restored this account's holds: priced offers may admit again. */
	async markHoldsKnown(accountId: string, at: string): Promise<void> {
		await this.mutateIndex(accountId, (record) => {
			if (record.holdsKnown) return false;
			record.holdsKnown = true;
			record.rebuiltAt = at;
			return true;
		});
	}

	private async mutatePending(
		change: (keys: string[]) => string[] | undefined,
	): Promise<void> {
		await this.retry("pending set", async () => {
			const entry = await this.state.get(this.keys.pending());
			const current = entry
				? decodeRecord(RelayCachePendingSchema, entry.value).jobKeys
				: [];
			const next = change([...current]);
			if (!next) return undefined;
			if (next.length > RELAY_MAX_PENDING)
				throw new Error("pending demand set is full");
			if (next.length === 0 && entry)
				return (await this.state.delete(this.keys.pending(), entry.version))
					? undefined
					: RETRY;
			if (next.length === 0) return undefined;
			const written = await this.write(
				this.keys.pending(),
				entry?.version,
				encodeRecord(
					RelayCachePendingSchema,
					create(RelayCachePendingSchema, { jobKeys: next }),
				),
				RELAY_TTL.pending,
			);
			return written ? undefined : RETRY;
		});
	}

	private addPending(key: string): Promise<void> {
		return this.mutatePending((keys) =>
			keys.includes(key) ? undefined : [...keys, key],
		);
	}

	private removePending(key: string): Promise<void> {
		return this.mutatePending((keys) =>
			keys.includes(key) ? keys.filter((entry) => entry !== key) : undefined,
		);
	}

	// -------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------

	async get(id: string): Promise<Lease | undefined> {
		return (await this.readLease(id))?.lease;
	}

	/** In-flight leases of these accounts, pruning index entries whose lease ended or vanished. */
	private async inflight(
		accountIds: readonly string[],
		recent: boolean,
	): Promise<Lease[]> {
		const indexes = await this.readIndexes(accountIds);
		const ids: {
			accountId: string;
			id: string;
			createdAt: string;
			active: boolean;
		}[] = [];
		for (const [accountId, { record }] of indexes) {
			for (const entry of record.entries)
				ids.push({
					accountId,
					id: entry.leaseId,
					createdAt: entry.createdAt,
					active: true,
				});
			if (recent)
				for (const id of record.recentTerminal)
					ids.push({ accountId, id, createdAt: "", active: false });
		}
		const slots = await this.readLeases(ids.map((entry) => entry.id));
		const leases: Lease[] = [];
		const stale = new Map<string, string[]>();
		const seen = new Set<string>();
		ids.forEach((entry, index) => {
			const slot = slots[index];
			if (slot && !seen.has(slot.lease.id)) {
				seen.add(slot.lease.id);
				leases.push(slot.lease);
			}
			if (!entry.active) return;
			const ended = slot ? TERMINAL.has(slot.lease.state) : false;
			const phantom =
				!slot &&
				this.nowMs() - Date.parse(entry.createdAt) >
					RELAY_PHANTOM_ENTRY_GRACE_MS;
			if (ended || phantom)
				stale.set(entry.accountId, [
					...(stale.get(entry.accountId) ?? []),
					entry.id,
				]);
		});
		for (const [accountId, gone] of stale)
			await this.retireFromIndex(accountId, gone);
		return leases.sort((a, b) => a.id.localeCompare(b.id));
	}

	async activeLeases(): Promise<Lease[]> {
		return (
			await this.inflight(this.accountIds(await this.snapshot()), false)
		).filter((lease) => ACTIVE_STATES.has(lease.state));
	}

	async accountLeases(accountId: string): Promise<Lease[]> {
		return this.inflight([accountId], true);
	}

	/** In-flight leases and the recently ended ones each index remembers. Not a history. */
	async all(): Promise<Lease[]> {
		return this.inflight(this.accountIds(await this.snapshot()), true);
	}

	async pendingJobs(): Promise<Job[]> {
		const entry = await this.state.get(this.keys.pending());
		if (!entry) return [];
		const keys = decodeRecord(RelayCachePendingSchema, entry.value).jobKeys;
		if (keys.length === 0) return [];
		const records = await this.state.getMany(
			keys.map((key) => this.keys.job(key)),
		);
		const jobs: Job[] = [];
		const stale = new Set<string>();
		for (const [index, found] of records.entries()) {
			const record = found
				? decodeRecord(RelayCacheJobSchema, found.value)
				: undefined;
			if (record?.state === "pending" && record.pendingJobJson)
				jobs.push(decodeRecord(JobSchema, record.pendingJobJson));
			else stale.add(keys[index] ?? "");
		}
		// A key whose record left `pending` (or lapsed) is pruned here, once.
		if (stale.size > 0)
			await this.mutatePending((current) =>
				current.some((key) => stale.has(key))
					? current.filter((key) => !stale.has(key))
					: undefined,
			);
		return jobs;
	}

	/** Latest dispatch/claim/sandbox intent of each lease, from the lease records. */
	async latestLeaseIntents(ids: readonly string[]): Promise<CiEvent[]> {
		const slots = await this.readLeases(ids);
		const events: CiEvent[] = [];
		for (const slot of slots) {
			if (!slot) continue;
			for (const intent of slot.record.intents)
				events.push(
					create(CiEventSchema, {
						type: intent.kind,
						at: intent.at,
						accountId: slot.lease.accountId,
						leaseId: slot.lease.id,
					}),
				);
		}
		return events;
	}

	async assignedJob(
		job: Job,
	): Promise<{ leaseId: string; version: string } | undefined> {
		const assigned = (
			await this.readJob(relayJobKey({ ...job, jobId: job.id }))
		)?.record.assigned;
		return assigned
			? { leaseId: assigned.leaseId, version: assigned.version }
			: undefined;
	}

	// -------------------------------------------------------------------------
	// Demand
	// -------------------------------------------------------------------------

	private bindingAccount(
		snapshot: RelayConfigSnapshot,
		job: Job,
	): Account | undefined {
		const config = snapshot.state.configuration;
		const binding = config?.connections.find((entry) =>
			sameConnection(entry, job),
		);
		const account = config?.accounts.find(
			(entry) => entry.id === binding?.accountId,
		);
		return account && this.effective(snapshot, account);
	}

	private owner(snapshot: RelayConfigSnapshot, job: Job): string {
		return jobAccountId(snapshot.state.configuration?.connections ?? [], job);
	}

	/**
	 * Queue a job unless it is terminal, assigned, already pending or held by
	 * an active lease. `githubCreatedAt` (GitHub's `created_at`) pins the queue
	 * deadline from when GitHub queued the job, not when the relay saw it.
	 */
	private async queueInside(
		snapshot: RelayConfigSnapshot,
		job: Job,
		at: string,
		githubCreatedAt?: string,
	): Promise<void> {
		const key = relayJobKey({ ...job, jobId: job.id });
		const queued = await this.retry("queue job", async () => {
			const slot = await this.readJob(key);
			const record = slot?.record;
			if (
				record &&
				(record.state === "terminal" ||
					record.state === "pending" ||
					record.assigned)
			)
				return undefined;
			let held: Lease | undefined;
			if (record?.leaseId) {
				const lease = (await this.readLease(record.leaseId))?.lease;
				if (
					lease &&
					ACTIVE_STATES.has(lease.state) &&
					(lease.actualJobId === 0 || lease.actualJobId === job.id)
				)
					return undefined;
				held = lease;
			}
			const firstSeenAt =
				earliest(at, record?.firstSeenAt, githubCreatedAt) ?? at;
			const pinned = pinCiQueueDeadline(
				job,
				firstSeenAt,
				this.bindingAccount(snapshot, job),
				[record?.queueDeadlineAt ?? "", held?.queueDeadlineAt ?? ""],
			);
			const expired =
				!!pinned.queueDeadlineAt &&
				Date.parse(pinned.queueDeadlineAt) <= Date.parse(at);
			const next = create(RelayCacheJobSchema, {
				jobKey: key,
				state: expired ? "terminal" : "pending",
				generation: record?.generation ?? 0,
				leaseId: record?.leaseId ?? "",
				pendingJobJson: expired ? "" : encodeRecord(JobSchema, pinned),
				firstSeenAt,
				queueDeadlineAt: pinned.queueDeadlineAt,
				terminalReason: expired ? "expired" : "",
			});
			return (await this.writeJob(slot, next)) ? { pinned, expired } : RETRY;
		});
		if (!queued) return;
		const body = encodeRecord(JobSchema, queued.pinned);
		if (queued.expired) {
			await this.emit(
				"ci.JobExpired",
				at,
				body,
				this.owner(snapshot, queued.pinned),
			);
			return;
		}
		await this.addPending(key);
		await this.emit(
			"ci.JobQueued",
			at,
			body,
			this.owner(snapshot, queued.pinned),
		);
	}

	async queue(
		job: Job,
		at: string,
		expectedRevision?: number,
		githubCreatedAt?: string,
	): Promise<void> {
		const snapshot = await this.checkRevision(expectedRevision);
		await this.queueInside(snapshot, job, at, githubCreatedAt);
	}

	/** Leave the pending state for `next` unless already done; returns whether the record changed. */
	private async settleJobRecord(
		key: string,
		change: (record: RelayCacheJob | undefined) => RelayCacheJob | undefined,
	): Promise<RelayCacheJob | undefined> {
		return this.retry("job record", async () => {
			const slot = await this.readJob(key);
			const next = change(
				slot ? clone(RelayCacheJobSchema, slot.record) : undefined,
			);
			if (!next) return undefined;
			return (await this.writeJob(slot, next)) ? next : RETRY;
		});
	}

	async expireQueued(
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<boolean> {
		const snapshot = await this.checkRevision(expectedRevision);
		const key = relayJobKey({ ...job, jobId: job.id });
		const slot = await this.readJob(key);
		const pending =
			slot?.record.state === "pending" && slot.record.pendingJobJson
				? decodeRecord(JobSchema, slot.record.pendingJobJson)
				: job;
		if (
			!pending.queueDeadlineAt ||
			!Number.isFinite(Date.parse(pending.queueDeadlineAt)) ||
			!Number.isFinite(Date.parse(at)) ||
			Date.parse(pending.queueDeadlineAt) > Date.parse(at)
		)
			return false;
		const leases = (
			await this.jobLeases(
				{ ...job, jobId: job.id },
				slot?.record.generation ?? 0,
			)
		).filter((entry) => ACTIVE_STATES.has(entry.lease.state));
		if (leases.some((entry) => entry.lease.state !== "reserved")) return false;
		for (const entry of leases)
			await this.transition(
				entry.lease.id,
				["reserved"],
				(lease) => {
					lease.state = "cancelled";
				},
				"ci.LeaseExpired",
				at,
			);
		let wasPending = false;
		const changed = await this.settleJobRecord(key, (record) => {
			wasPending = record?.state === "pending";
			if (record?.state === "terminal") return undefined;
			const next =
				record ?? create(RelayCacheJobSchema, { jobKey: key, firstSeenAt: at });
			next.state = "terminal";
			next.pendingJobJson = "";
			next.terminalReason = "expired";
			return next;
		});
		if (wasPending) await this.removePending(key);
		if (changed)
			await this.emit(
				"ci.JobExpired",
				at,
				encodeRecord(JobSchema, pending),
				this.owner(snapshot, pending),
			);
		return true;
	}

	// -------------------------------------------------------------------------
	// Admission
	// -------------------------------------------------------------------------

	private async applyUsage(account: Account): Promise<Account> {
		const observed = await this.usage.observed(account.id);
		if (!observed) return account;
		const next = clone(AccountSchema, account);
		if (observed.accountSpentMicros !== undefined) {
			next.spentMicros = observed.accountSpentMicros;
			next.usageObservedAt = observed.observedAt;
		}
		for (const offer of next.offers) {
			const spent = observed.offerSpentMicros?.[offer.id];
			if (spent !== undefined) offer.spentMicros = spent;
		}
		return next;
	}

	/** Every account's in-flight holds as leases routing can count; the reserving account's index too. */
	private async routingView(snapshot: RelayConfigSnapshot, accountId: string) {
		const ids = [...new Set([...this.accountIds(snapshot), accountId])];
		const indexes = await this.readIndexes(ids);
		const leases: Lease[] = [];
		for (const [id, { record }] of indexes)
			for (const entry of record.entries)
				leases.push(this.entryLease(id, entry));
		const own = indexes.get(accountId) ?? {
			record: create(RelayCacheInflightSchema, {
				accountId,
				holdsKnown: false,
			}),
		};
		return { leases, own };
	}

	async reserve(
		account: Account,
		job: Job,
		at: string,
		expectedRevision?: number,
		githubCreatedAt?: string,
	): Promise<Lease | undefined> {
		const snapshot = await this.checkRevision(expectedRevision);
		const config = snapshot.state.configuration;
		const binding = config?.connections.find((entry) =>
			sameConnection(entry, job),
		);
		if (!binding || binding.accountId !== account.id)
			throw new Error("connection revoked");
		const requiresIsolation = job.isolatedRequired || binding.isolatedOnly;
		const current = config?.accounts.find(
			(entry) => entry.id === binding.accountId,
		);
		if (!current) throw new Error("account revoked");
		const effective = await this.applyUsage(this.effective(snapshot, current));
		// Broker budget-policy accounts need a durable shared ledger the hosted relay does not have.
		if (ciBudgetPolicy(effective)) return undefined;
		const identity = {
			repositoryId: job.repositoryId,
			jobId: job.id,
			runAttempt: job.runAttempt,
		};
		const key = relayJobKey(identity);

		for (let round = 0; round < MAX_CAS_ATTEMPTS; round++) {
			const slot = await this.readJob(key);
			const record = slot?.record;
			const firstSeenAt =
				earliest(at, record?.firstSeenAt, githubCreatedAt) ?? at;
			const demand = pinCiQueueDeadline(job, firstSeenAt, effective, [
				record?.queueDeadlineAt ?? "",
			]);
			if (
				demand.queueDeadlineAt &&
				Date.parse(demand.queueDeadlineAt) <= Date.parse(at)
			)
				return undefined;
			if (record?.state === "terminal" || record?.assigned) return undefined;
			const prior = record?.leaseId
				? await this.readLease(record.leaseId)
				: undefined;
			if (
				prior &&
				ACTIVE_STATES.has(prior.lease.state) &&
				(prior.lease.actualJobId === 0 || prior.lease.actualJobId === job.id)
			) {
				const existing = prior.lease;
				const existingOffer = effective.offers.find(
					(offer) =>
						offer.id === existing.offerId &&
						offer.provider === existing.provider,
				);
				if (requiresIsolation && !isIsolatedCiOffer(existingOffer)) {
					if (existing.state === "reserved") {
						await this.transition(
							existing.id,
							["reserved"],
							(lease) => {
								lease.state = "cancelled";
							},
							"ci.LeaseCancelled",
							at,
						);
						await this.queueInside(snapshot, job, at, githubCreatedAt);
					}
					return undefined;
				}
				if (record?.state === "pending") await this.takeJob(key, existing, at);
				return existing;
			}
			const generation = record?.leaseId
				? (record.generation ?? 0) + 1
				: (record?.generation ?? 0);
			if (generation > RELAY_MAX_GENERATION) return undefined;
			const id = relayLeaseId(identity, generation);

			const admitted = await this.admit(snapshot, effective, job, {
				id,
				generation,
				requiresIsolation,
				at,
				queueDurationMs: Math.max(0, Date.parse(at) - Date.parse(firstSeenAt)),
				queueDeadlineAt: demand.queueDeadlineAt,
			});
			if (!admitted) return undefined;

			// One lease record per id: concurrent reservers derive the same id, so only one creates it.
			const created = await this.write(
				this.keys.lease(id),
				undefined,
				encodeRecord(
					RelayCacheLeaseSchema,
					create(RelayCacheLeaseSchema, {
						leaseJson: encodeRecord(LeaseSchema, admitted),
						jobKey: key,
						generation,
					}),
				),
				relayLeaseTtl(admitted),
			);
			const lease = created ? admitted : (await this.readLease(id))?.lease;
			if (!lease || !ACTIVE_STATES.has(lease.state)) {
				// This generation's id is spent (its record outlived a lost job
				// record): drop the hold just added and move the job past it.
				this.casLosses += 1;
				await this.retireFromIndex(effective.id, [id]);
				if (lease)
					await this.settleJobRecord(key, (current) => {
						if (current && current.generation > generation) return undefined;
						if (current?.leaseId === id) return undefined;
						const next =
							current ??
							create(RelayCacheJobSchema, { jobKey: key, firstSeenAt });
						next.leaseId = id;
						next.generation = generation;
						if (next.state !== "pending") next.state = "idle";
						return next;
					});
				continue;
			}
			const taken = await this.takeJob(
				key,
				lease,
				at,
				firstSeenAt,
				generation,
				slot,
			);
			if (taken === "lost") {
				// The job went terminal or was assigned while this lease was being made.
				await this.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "cancelled";
					},
					"ci.LeaseCancelled",
					at,
				);
				return undefined;
			}
			if (created) await this.emitLease(lease, "ci.LeaseReserved", at);
			return lease;
		}
		throw new Error("reserve: compare-and-set kept losing; retry later");
	}

	/** Point the job record at the lease and drop it from pending. */
	private async takeJob(
		key: string,
		lease: Lease,
		at: string,
		firstSeenAt?: string,
		generation?: number,
		read?: Slot<RelayCacheJob>,
	): Promise<"taken" | "lost"> {
		let wasPending = false;
		let first = read;
		const outcome = await this.retry("take job", async () => {
			const slot = first ?? (await this.readJob(key));
			first = undefined;
			const record = slot?.record;
			wasPending = record?.state === "pending";
			if (
				record?.state === "terminal" ||
				(record?.assigned && record.assigned.leaseId !== lease.id)
			)
				return "lost" as const;
			if (record?.state === "taken" && record.leaseId === lease.id)
				return "taken" as const;
			const next = create(RelayCacheJobSchema, {
				jobKey: key,
				state: "taken",
				generation: generation ?? record?.generation ?? 0,
				leaseId: lease.id,
				firstSeenAt:
					earliest(record?.firstSeenAt, firstSeenAt, lease.createdAt, at) ?? at,
				queueDeadlineAt: lease.queueDeadlineAt || record?.queueDeadlineAt || "",
				assigned: record?.assigned,
			});
			return (await this.writeJob(slot, next, lease))
				? ("taken" as const)
				: RETRY;
		});
		if (wasPending) await this.removePending(key);
		return outcome;
	}

	/** Route against every in-flight hold and add this lease to its account's index by CAS. */
	private async admit(
		snapshot: RelayConfigSnapshot,
		effective: Account,
		job: Job,
		input: {
			id: string;
			generation: number;
			requiresIsolation: boolean;
			at: string;
			queueDurationMs: number;
			queueDeadlineAt: string;
		},
	): Promise<Lease | undefined> {
		return this.retry("admission", async () => {
			const { leases, own } = await this.routingView(snapshot, effective.id);
			const existing = own.record.entries.find(
				(entry) => entry.leaseId === input.id,
			);
			const others = leases.filter((lease) => lease.id !== input.id);
			const selected = route(
				{
					...effective,
					offers: effective.offers.map((offer) => ({
						...offer,
						enabled:
							offer.enabled &&
							(own.record.holdsKnown || !isPricedOffer(offer)) &&
							(input.requiresIsolation
								? isIsolatedCiOffer(offer)
								: !offer.backend || offer.backend === "gh-actions"),
					})),
				},
				others,
				input.at,
				{
					phase: "admit",
					attempt: job.runAttempt + input.generation,
					queueDurationMs: input.queueDurationMs,
				},
			);
			if (!selected) return undefined;
			const lease = create(LeaseSchema, {
				id: input.id,
				budgetAdmissionAttempt: input.generation + 1,
				accountId: effective.id,
				offerId: selected.offer.id,
				provider: selected.offer.provider,
				providerAccountId: selected.offer.providerAccountId,
				...ciBudgetIdentity(effective, input.at),
				queueDeadlineAt: input.queueDeadlineAt,
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
				runnerName: `hobo-${input.id}`,
				createdAt: input.at,
			});
			if (existing) return lease;
			const next = clone(RelayCacheInflightSchema, own.record);
			next.entries.push(this.indexEntry(lease));
			const written = await this.write(
				this.keys.inflight(effective.id),
				own.slot?.version,
				encodeRecord(RelayCacheInflightSchema, next),
				this.indexTtl(next),
			);
			return written ? lease : RETRY;
		});
	}

	// -------------------------------------------------------------------------
	// Transitions
	// -------------------------------------------------------------------------

	async transition(
		id: string,
		expected: readonly string[],
		update: (lease: Lease) => void,
		type: string,
		at: string,
		expectedRevision?: number,
	): Promise<Lease | undefined> {
		const snapshot = await this.checkRevision(expectedRevision);
		const result = await this.retry("transition", async () => {
			const slot = await this.readLease(id);
			if (!slot || !expected.includes(slot.lease.state)) return undefined;
			const before = clone(LeaseSchema, slot.lease);
			const lease = clone(LeaseSchema, slot.lease);
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
				if (!(await this.authorizeHeldEffect(snapshot, lease, at)))
					throw new Error("durable policy revoked lease execution");
				if (lease.budgetId)
					throw new Error("shared CI budget authority unavailable");
			}
			return (await this.writeLease(slot, lease, type, at))
				? { lease, before }
				: RETRY;
		});
		if (!result) return undefined;
		const { lease, before } = result;
		if (TERMINAL.has(lease.state) && !TERMINAL.has(before.state))
			await this.retireFromIndex(lease.accountId, [lease.id]);
		await this.emitLease(lease, type, at);
		return lease;
	}

	private async authorizeHeldEffect(
		snapshot: RelayConfigSnapshot,
		lease: Lease,
		at: string,
	): Promise<boolean> {
		if (
			lease.queueDeadlineAt &&
			Date.parse(lease.queueDeadlineAt) <= Date.parse(at)
		)
			return false;
		const config = snapshot.state.configuration;
		const account = config?.accounts.find(
			(entry) => entry.id === lease.accountId,
		);
		if (!account) return false;
		if (
			!lease.pipelineId &&
			!config?.connections.some(
				(entry) =>
					entry.accountId === lease.accountId && sameConnection(entry, lease),
			)
		)
			return false;
		const effective = await this.applyUsage(this.effective(snapshot, account));
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
		const { leases } = await this.routingView(snapshot, lease.accountId);
		// Queue time is a budget-policy measurement only; such accounts are refused here.
		const job = ciBudgetPolicy(effective)
			? await this.readJob(relayJobKey(lease))
			: undefined;
		const firstSeenAt =
			earliest(job?.record.firstSeenAt, lease.createdAt) ?? at;
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
			leases.filter((entry) => entry.id !== lease.id),
			at,
			{
				phase: "admit",
				attempt: lease.pipelineId
					? lease.budgetAdmissionAttempt || 1
					: lease.runAttempt + (lease.budgetAdmissionAttempt || 1) - 1,
				queueDurationMs: Math.max(0, Date.parse(at) - Date.parse(firstSeenAt)),
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

	private cancel(id: string, expected: readonly string[], at: string) {
		return this.transition(
			id,
			expected,
			(lease) => {
				lease.state = "cancelled";
			},
			"ci.LeaseCancelled",
			at,
		);
	}

	async cancelAndRequeue(id: string, job: Job, at: string): Promise<void> {
		const cancelled = await this.cancel(id, ["reserved"], at);
		if (!cancelled) return;
		await this.queueInside(await this.snapshot(), job, at);
	}

	async withdrawQueuedJob(
		job: Job,
		at: string,
		expectedRevision?: number,
		exceptLeaseId?: string,
	): Promise<boolean> {
		const snapshot = await this.checkRevision(expectedRevision);
		const configuration = snapshot.state.configuration;
		const identity = {
			repositoryId: job.repositoryId,
			jobId: job.id,
			runAttempt: job.runAttempt,
		};
		const key = relayJobKey(identity);
		const slot = await this.readJob(key);
		let changed = false;
		for (const { lease } of await this.jobLeases(
			identity,
			slot?.record.generation ?? 0,
		)) {
			if (!ACTIVE_STATES.has(lease.state)) continue;
			if (exceptLeaseId && lease.id === exceptLeaseId) continue;
			const offer = configuration?.accounts
				.find((account) => account.id === lease.accountId)
				?.offers.find((candidate) => candidate.id === lease.offerId);
			if (
				!shouldAbortIsolatedFleetLease(
					lease.provider,
					offer ? { backend: offer.backend, runsOn: offer.runsOn } : undefined,
				)
			)
				continue;
			if (await this.cancel(lease.id, [lease.state], at)) changed = true;
		}
		const withdrawn = await this.settleJobRecord(key, (record) => {
			if (record?.state !== "pending") return undefined;
			record.state = "idle";
			record.pendingJobJson = "";
			return record;
		});
		if (withdrawn) await this.removePending(key);
		return changed || !!withdrawn;
	}

	async abortIsolatedAndRequeue(
		id: string,
		job: Job,
		at: string,
	): Promise<void> {
		const lease = await this.get(id);
		const recoverable = [
			"reserved",
			"dispatching",
			"claiming",
			"dispatched",
			"running",
			"uncertain",
		];
		if (!lease || !recoverable.includes(lease.state)) return;
		const snapshot = await this.snapshot();
		const offer = snapshot.state.configuration?.accounts
			.find((account) => account.id === lease.accountId)
			?.offers.find((candidate) => candidate.id === lease.offerId);
		if (
			!shouldAbortIsolatedFleetLease(
				lease.provider,
				offer ? { backend: offer.backend, runsOn: offer.runsOn } : undefined,
			)
		)
			return;
		const cancelled = await this.cancel(id, recoverable, at);
		if (!cancelled) return;
		await this.queueInside(snapshot, job, at);
	}

	// -------------------------------------------------------------------------
	// Observation of GitHub job state
	// -------------------------------------------------------------------------

	async observe(
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<void> {
		const snapshot = await this.checkRevision(expectedRevision);
		const identity = {
			repositoryId: job.repositoryId,
			jobId: job.id,
			runAttempt: job.runAttempt,
		};
		const key = relayJobKey(identity);
		// The job record as last written here: tells which follow-up writes are needed.
		let known: RelayCacheJob | undefined;
		let wasPending = false;
		if (job.action === "completed") {
			const changed = await this.settleJobRecord(key, (record) => {
				wasPending = record?.state === "pending";
				known = record;
				if (
					record?.state === "terminal" &&
					!record.assigned &&
					!record.pendingJobJson
				)
					return undefined;
				known = create(RelayCacheJobSchema, {
					jobKey: key,
					state: "terminal",
					generation: record?.generation ?? 0,
					leaseId: record?.leaseId ?? "",
					firstSeenAt: record?.firstSeenAt || at,
					queueDeadlineAt: record?.queueDeadlineAt ?? "",
					terminalReason: "completed",
				});
				return known;
			});
			if (wasPending) await this.removePending(key);
			if (changed)
				await this.emit(
					"ci.JobCompleted",
					at,
					encodeRecord(JobSchema, job),
					this.owner(snapshot, job),
				);
		}
		if (!job.runnerName) return;
		const leaseId = leaseIdFromBoxRunnerName(job.runnerName);
		if (!leaseId) return;
		const settledSandbox = (lease: Lease) =>
			lease.state === "completed" &&
			lease.provider === "vercel" &&
			lease.sandboxStage === "stopped" &&
			lease.runnerDeletionConfirmed &&
			!!lease.settledAt;
		const observed = await this.retry("observe", async () => {
			const slot = await this.readLease(leaseId);
			const lease = slot?.lease;
			if (
				!slot ||
				!lease ||
				!sameConnection(lease, job) ||
				lease.runnerName !== job.runnerName ||
				!(ACTIVE_STATES.has(lease.state) || settledSandbox(lease))
			)
				return undefined;
			if (lease.actualJobId && lease.actualJobId !== job.id)
				throw new Error("runner job assignment conflict");
			const next = clone(LeaseSchema, lease);
			next.actualJobId = job.id;
			const type = settledSandbox(lease)
				? "ci.LateJobObserved"
				: "ci.JobObserved";
			return (await this.writeLease(slot, next, type, at))
				? { lease: next, type }
				: RETRY;
		});
		if (!observed) return;
		const { lease } = observed;
		await this.emitLease(lease, observed.type, at);
		if (settledSandbox(lease) && job.action !== "completed") return;
		if (job.action !== "in_progress" && job.action !== "completed") return;
		if (job.action === "in_progress") {
			const assigned = await this.retry("assign job", async () => {
				const slot = await this.readJob(key);
				const record = slot?.record;
				// Terminal observations win over delayed in-progress deliveries.
				if (record?.state === "terminal") return "terminal" as const;
				if (record?.assigned && record.assigned.leaseId !== lease.id)
					throw new Error("job assigned to another runner");
				wasPending = record?.state === "pending";
				const version = randomUUID();
				known = create(RelayCacheJobSchema, {
					jobKey: key,
					state: wasPending ? "idle" : record?.state || "idle",
					generation: record?.generation ?? 0,
					leaseId: record?.leaseId ?? "",
					firstSeenAt: record?.firstSeenAt || at,
					queueDeadlineAt: record?.queueDeadlineAt ?? "",
					assigned: create(RelayCacheAssignmentSchema, {
						leaseId: lease.id,
						version,
					}),
				});
				return (await this.writeJob(slot, known, lease)) ? version : RETRY;
			});
			if (assigned === "terminal") return;
			if (wasPending) await this.removePending(key);
			await this.emit(
				"ci.JobAssigned",
				at,
				JSON.stringify({
					job: JSON.parse(encodeRecord(JobSchema, job)),
					version: assigned,
				}),
				lease.accountId,
				lease.id,
			);
		}
		// Other generations' reservations for this job lose to the runner GitHub chose.
		const generation = known?.generation ?? 0;
		if (generation === 0 && (!known?.leaseId || known.leaseId === lease.id))
			return;
		for (const duplicate of await this.jobLeases(identity, generation))
			if (
				duplicate.lease.id !== lease.id &&
				duplicate.lease.accountId === lease.accountId &&
				duplicate.lease.state === "reserved"
			)
				await this.cancel(duplicate.lease.id, ["reserved"], at);
	}

	/** Clear only after fresh GitHub queued proof and a terminal owner, with an exact token fence. */
	async clearAssignedJob(
		job: Job,
		leaseId: string,
		version: string,
		at: string,
		expectedRevision: number,
	): Promise<boolean> {
		await this.checkRevision(expectedRevision);
		const lease = await this.get(leaseId);
		if (!lease || ACTIVE_STATES.has(lease.state)) return false;
		const key = relayJobKey({ ...job, jobId: job.id });
		const cleared = await this.settleJobRecord(key, (record) => {
			if (
				record?.assigned?.leaseId !== leaseId ||
				record.assigned.version !== version
			)
				return undefined;
			record.assigned = undefined;
			if (record.state === "taken" && record.leaseId === leaseId)
				record.state = "idle";
			return record;
		});
		if (cleared)
			await this.emit(
				"ci.JobAssignmentCleared",
				at,
				encodeRecord(JobSchema, job),
				lease.accountId,
				leaseId,
			);
		return !!cleared;
	}

	// -------------------------------------------------------------------------
	// Settlement
	// -------------------------------------------------------------------------

	private async settleInside(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet: Job | undefined,
		completedAt: string,
		observed?: Pick<Lease, "state" | "hostRunId" | "runnerId">,
	): Promise<Lease | undefined> {
		const settled = await this.retry("settle", async () => {
			const slot = await this.readLease(id);
			const current = slot?.lease;
			if (!slot || !current || !ACTIVE_STATES.has(current.state))
				return undefined;
			if (
				observed &&
				(current.state !== observed.state ||
					current.hostRunId !== observed.hostRunId ||
					current.runnerId !== observed.runnerId)
			)
				return undefined;
			if (current.provider === "vercel")
				throw new Error("sandbox requires native cost settlement");
			if (current.hostRunId !== 0 && current.hostRunId !== hostRunId)
				throw new Error("host run mismatch");
			if (
				!Number.isFinite(billedMinutes) ||
				billedMinutes < 0 ||
				billedMinutes > Number.MAX_SAFE_INTEGER
			)
				throw new Error("invalid settlement");
			if (current.budgetId)
				throw new Error("shared CI budget authority unavailable");
			const lease = clone(LeaseSchema, current);
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
			lease.usageProvenance = "estimated";
			lease.usageEvidenceRef = "";
			return (await this.writeLease(slot, lease, "ci.HostSettled", at))
				? lease
				: RETRY;
		});
		if (!settled) return undefined;
		await this.retireFromIndex(settled.accountId, [settled.id]);
		await this.emitLease(settled, "ci.HostSettled", at);
		if (settled.paidMicros > settled.reservedPaidMicros)
			await this.emitLease(settled, "ci.BudgetOverrun", at);
		if (unmet) await this.queueInside(await this.snapshot(), unmet, at);
		return settled;
	}

	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt = at,
	): Promise<Lease | undefined> {
		return this.settleInside(
			id,
			hostRunId,
			billedMinutes,
			at,
			unmet,
			completedAt,
		);
	}

	settleObserved(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet: Job | undefined,
		completedAt: string,
		observed: { state: string; hostRunId: number; runnerId: number },
	): Promise<Lease | undefined> {
		return this.settleInside(
			id,
			hostRunId,
			billedMinutes,
			at,
			unmet,
			completedAt,
			observed,
		);
	}

	// -------------------------------------------------------------------------
	// Sandbox egress and proxy caps
	// -------------------------------------------------------------------------

	private tokenKey(): ProxyTokenKey {
		if (!this.options.proxyTokenKey)
			throw new Error("sandbox proxy token key not configured");
		return this.options.proxyTokenKey;
	}

	/** The proxy session token for a lease, derived; the controller hands it to the proxy VM. */
	sandboxProxyToken(leaseId: string): string {
		return deriveSandboxProxyToken(this.tokenKey(), leaseId);
	}

	/** Bind a quota to the verified lease and sandbox. The caller is the trusted control plane. */
	async configureSandboxEgress(
		accountId: string,
		leaseId: string,
		sandboxId: string,
		maxBytes: number,
		expectedRevision: number,
	): Promise<void> {
		if (!sandboxId || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
			throw new Error("invalid sandbox egress limit");
		await this.checkRevision(expectedRevision);
		const lease = await this.get(leaseId);
		if (
			!lease ||
			lease.accountId !== accountId ||
			!ACTIVE_STATES.has(lease.state) ||
			lease.sandboxSessionId !== sandboxId ||
			!lease.sandboxPricing ||
			lease.sandboxPricing.maxEgressBytes !== maxBytes
		)
			throw new Error("sandbox quota binding invalid");
		const ttl = relaySandboxCounterTtl(lease);
		const binding = encodeRecord(
			RelayCacheSandboxEgressSchema,
			create(RelayCacheSandboxEgressSchema, { leaseId, accountId, maxBytes }),
		);
		const created = await this.state.putIfAbsent(
			this.keys.sandboxEgress(sandboxId),
			binding,
			ttl,
		);
		if (!created.applied) {
			const existing = await this.readEgressBinding(sandboxId);
			if (
				!existing ||
				existing.leaseId !== leaseId ||
				existing.accountId !== accountId ||
				existing.maxBytes !== maxBytes
			)
				throw new Error("sandbox quota already bound");
			return;
		}
		await this.state.increment(
			this.keys.sandboxEgressUsed(sandboxId),
			0,
			ttl,
			"on-create",
		);
	}

	private async readEgressBinding(sandboxId: string) {
		const entry = await this.state.get(this.keys.sandboxEgress(sandboxId));
		return entry
			? decodeRecord(RelayCacheSandboxEgressSchema, entry.value)
			: undefined;
	}

	/** Add bytes under the cap; an add that would cross it is taken back and refused. */
	private async addEgress(
		sandboxId: string,
		bytes: number,
		limit: number,
		ttl: EphemeralTtlMs,
	): Promise<boolean> {
		const key = this.keys.sandboxEgressUsed(sandboxId);
		const used = await this.state.increment(key, bytes, ttl, "on-create");
		if (used <= limit) return true;
		await this.state.increment(key, -bytes, ttl, "on-create");
		return false;
	}

	/** Reserve bytes before forwarding (guest-only sandboxes without a proxy VM). */
	async reserveSandboxEgress(
		sandboxId: string,
		byteCount: number,
	): Promise<boolean> {
		if (!sandboxId || !Number.isSafeInteger(byteCount) || byteCount <= 0)
			throw new Error("invalid egress reservation");
		const binding = await this.readEgressBinding(sandboxId);
		if (!binding) return false;
		const lease = await this.get(binding.leaseId);
		if (
			!lease ||
			lease.accountId !== binding.accountId ||
			!ACTIVE_STATES.has(lease.state) ||
			lease.sandboxSessionId !== sandboxId ||
			lease.sandboxPricing?.proxyVmRequired === true ||
			!Number.isSafeInteger(binding.maxBytes) ||
			binding.maxBytes < 0
		)
			return false;
		return this.addEgress(
			sandboxId,
			byteCount,
			binding.maxBytes,
			relaySandboxCounterTtl(lease),
		);
	}

	/**
	 * Accept only the lease's derived token (as its SHA-256 digest, as the
	 * controller passes it). Nothing is stored: the token can be re-derived.
	 */
	async configureSandboxProxy(
		accountId: string,
		leaseId: string,
		proxySessionId: string,
		tokenSha256: string,
		expectedRevision: number,
	): Promise<void> {
		if (!/^[a-f0-9]{64}$/.test(tokenSha256) || !proxySessionId)
			throw new Error("invalid proxy binding");
		await this.checkRevision(expectedRevision);
		const lease = await this.get(leaseId);
		if (
			!lease ||
			lease.accountId !== accountId ||
			!ACTIVE_STATES.has(lease.state) ||
			!lease.sandboxPricing?.proxyVmRequired ||
			lease.proxySandboxSessionId !== proxySessionId ||
			!["created", "starting", "running"].includes(lease.proxySandboxStage)
		)
			throw new Error("sandbox proxy binding invalid");
		if (!sandboxProxyDigestMatches(this.tokenKey(), leaseId, tokenSha256))
			throw new Error("sandbox proxy token is not the lease's derived token");
		// The call meter exists from binding on, so settlement can tell "bound, no calls" from "never bound".
		await this.state.increment(
			this.keys.proxyCalls(leaseId),
			0,
			relaySandboxCounterTtl(lease),
			"on-create",
		);
	}

	private proxyLive(
		lease: Lease | undefined,
		proxySessionId?: string,
	): lease is Lease {
		return (
			!!lease &&
			ACTIVE_STATES.has(lease.state) &&
			!!lease.sandboxPricing?.proxyVmRequired &&
			(proxySessionId === undefined ||
				lease.proxySandboxSessionId === proxySessionId) &&
			lease.proxySandboxStage === "running" &&
			!!lease.sandboxSessionId &&
			["created", "registering", "starting", "running"].includes(
				lease.sandboxStage,
			) &&
			!lease.sandboxStoppedUsage &&
			!lease.proxyStoppedUsage
		);
	}

	/**
	 * Authenticate the proxy by its raw token. A token names its lease and is
	 * checked against the derived one; every authenticated attempt counts
	 * against the lease's control-call cap. A bare SHA-256 digest cannot be
	 * resolved without a table and is refused.
	 */
	async authenticateSandboxProxy(
		credential: string,
	): Promise<
		{ accountId: string; leaseId: string; proxySessionId: string } | undefined
	> {
		if (!this.options.proxyTokenKey) return undefined;
		const leaseId = verifySandboxProxyToken(
			this.options.proxyTokenKey,
			credential,
		);
		if (!leaseId || !isDeterministicLeaseId(leaseId)) return undefined;
		const lease = await this.get(leaseId);
		if (!this.proxyLive(lease)) return undefined;
		const max = lease.sandboxPricing?.proxyControlMaxCalls ?? 0;
		if (!Number.isSafeInteger(max) || max <= 0)
			throw new Error("invalid proxy call ledger");
		const calls = await this.state.increment(
			this.keys.proxyCalls(leaseId),
			1,
			relaySandboxCounterTtl(lease),
			"on-create",
		);
		if (calls - 1 >= max) return undefined;
		return {
			accountId: lease.accountId,
			leaseId,
			proxySessionId: lease.proxySandboxSessionId,
		};
	}

	/** A unique authorization grants one forwarding operation; duplicates fail closed. */
	async reserveSandboxProxyEgress(
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
			byteCount > 4 * 1024 * 1024 ||
			!this.options.proxyTokenKey
		)
			return false;
		const lease = await this.get(leaseId);
		if (
			!this.proxyLive(lease, proxySessionId) ||
			lease.sandboxSessionId !== sandboxId
		)
			return false;
		if (
			!sandboxProxyDigestMatches(
				this.options.proxyTokenKey,
				leaseId,
				tokenSha256,
			)
		)
			return false;
		const binding = await this.readEgressBinding(sandboxId);
		const maxCalls = lease.sandboxPricing?.proxyControlMaxCalls ?? 0;
		if (
			!binding ||
			binding.accountId !== lease.accountId ||
			binding.leaseId !== leaseId ||
			!Number.isSafeInteger(binding.maxBytes) ||
			binding.maxBytes < 0 ||
			binding.maxBytes !== lease.sandboxPricing?.maxEgressBytes ||
			!Number.isSafeInteger(maxCalls) ||
			maxCalls <= 0
		)
			return false;
		const ttl = relaySandboxCounterTtl(lease);
		const fresh = await this.state.putIfAbsent(
			this.keys.proxyRequest(leaseId, requestId),
			"1",
			ttl,
		);
		if (!fresh.applied) return false;
		const window =
			Math.floor(this.nowMs() / RELAY_PROXY_RATE_WINDOW_MS) *
			RELAY_PROXY_RATE_WINDOW_MS;
		const recent = await this.state.increment(
			this.keys.proxyRate(leaseId, window),
			1,
			RELAY_TTL.proxyRate,
			"on-create",
		);
		if (recent > RELAY_PROXY_RATE_LIMIT) return false;
		const total = await this.state.increment(
			this.keys.proxyRequests(leaseId),
			1,
			ttl,
			"on-create",
		);
		if (total > maxCalls) return false;
		return this.addEgress(sandboxId, byteCount, binding.maxBytes, ttl);
	}

	private async meters(leaseId: string, sandboxId: string) {
		const [calls, binding, used] = await this.state.getMany([
			this.keys.proxyCalls(leaseId),
			this.keys.sandboxEgress(sandboxId || "none"),
			this.keys.sandboxEgressUsed(sandboxId || "none"),
		]);
		return {
			calls: calls ? counterValue(calls.value) : undefined,
			binding: binding
				? decodeRecord(RelayCacheSandboxEgressSchema, binding.value)
				: undefined,
			used: used ? counterValue(used.value) : undefined,
		};
	}

	/** Trusted accounting reads byte and call totals after the proxy has stopped. */
	async sandboxProxyUsage(
		accountId: string,
		leaseId: string,
		proxySessionId: string,
		sandboxId: string,
	): Promise<{ bytes: number; calls: number } | undefined> {
		const lease = await this.get(leaseId);
		if (
			!lease ||
			lease.accountId !== accountId ||
			lease.proxySandboxSessionId !== proxySessionId ||
			lease.sandboxSessionId !== sandboxId ||
			lease.proxySandboxStage !== "stopped" ||
			!lease.proxyStoppedUsage
		)
			return undefined;
		const meters = await this.meters(leaseId, sandboxId);
		const preJit =
			lease.runnerId === 0 &&
			!lease.sandboxCommandId &&
			["created", "creating"].includes(lease.sandboxStopFromStage);
		if (
			meters.calls === undefined &&
			((sandboxId && !preJit) ||
				(!sandboxId && lease.sandboxStage !== "pending"))
		)
			return undefined;
		let bytes = 0;
		if (sandboxId) {
			const bound =
				meters.binding?.leaseId === leaseId &&
				meters.binding.accountId === accountId;
			if (!bound && !preJit) return undefined;
			bytes = bound ? (meters.used ?? 0) : 0;
		} else if (lease.sandboxStage !== "pending") return undefined;
		return { bytes, calls: meters.calls ?? 0 };
	}

	/** Read proxy bytes only for the exact authenticated account, lease and VM. */
	async sandboxEgressUsage(
		accountId: string,
		leaseId: string,
		sandboxId: string,
	): Promise<number | undefined> {
		const lease = await this.get(leaseId);
		if (
			!lease ||
			lease.accountId !== accountId ||
			lease.sandboxSessionId !== sandboxId
		)
			return undefined;
		const meters = await this.meters(leaseId, sandboxId);
		if (
			meters.binding?.leaseId !== leaseId ||
			meters.binding.accountId !== accountId
		)
			return undefined;
		return meters.used ?? 0;
	}

	/** Settle verified native runner cost without assuming per-minute billing. */
	async settleSandboxObserved(
		id: string,
		at: string,
		completedAt: string,
		observed: {
			state: string;
			runnerId: number;
			actualJobId: number;
			sandboxSessionId: string;
			sandboxCommandId: string;
			sandboxStage: string;
			proxySandboxSessionId?: string;
			proxySandboxCommandId?: string;
			proxySandboxStage?: string;
		},
		chargedMicros: number,
		unmet?: Job,
		usedAllowance?: SandboxAllowance,
	): Promise<Lease | undefined> {
		if (
			!Number.isSafeInteger(chargedMicros) ||
			chargedMicros < 0 ||
			!Number.isFinite(Date.parse(completedAt))
		)
			throw new Error("invalid sandbox settlement");
		const settled = await this.retry("sandbox settlement", async () => {
			const slot = await this.readLease(id);
			const current = slot?.lease;
			if (
				!slot ||
				!current ||
				!ACTIVE_STATES.has(current.state) ||
				current.state !== observed.state ||
				current.runnerId !== observed.runnerId ||
				current.actualJobId !== observed.actualJobId ||
				current.sandboxSessionId !== observed.sandboxSessionId ||
				current.sandboxCommandId !== observed.sandboxCommandId ||
				current.sandboxStage !== observed.sandboxStage
			)
				return undefined;
			const lease = clone(LeaseSchema, current);
			await this.checkSandboxSettlement(
				lease,
				at,
				completedAt,
				observed,
				chargedMicros,
				usedAllowance,
			);
			const used = usedAllowance ?? create(SandboxAllowanceSchema);
			lease.sandboxUsedAllowance = clone(SandboxAllowanceSchema, used);
			lease.state = "completed";
			lease.billedMinutes = 0;
			lease.billedFreeMinutes = 0;
			lease.paidMicros = chargedMicros;
			lease.settledAt = at;
			lease.usageCompletedAt = completedAt;
			lease.usageProvenance = "estimated";
			if (lease.budgetId)
				throw new Error("shared CI budget authority unavailable");
			return (await this.writeLease(slot, lease, "ci.HostSettled", at))
				? lease
				: RETRY;
		});
		if (!settled) return undefined;
		await this.retireFromIndex(settled.accountId, [settled.id]);
		await this.emitLease(settled, "ci.HostSettled", at);
		if (
			settled.runnerId &&
			!settled.actualJobId &&
			settled.sandboxStopFromStage !== "registering"
		)
			await this.emitLease(settled, "ci.AssignmentUnknown", at);
		if (chargedMicros > settled.reservedPaidMicros)
			await this.emitLease(settled, "ci.BudgetOverrun", at);
		if (unmet) await this.queueInside(await this.snapshot(), unmet, at);
		return settled;
	}

	/** The Postgres store's sandbox settlement fences, with meters read from the cache counters. */
	private async checkSandboxSettlement(
		lease: Lease,
		at: string,
		completedAt: string,
		observed: {
			proxySandboxSessionId?: string;
			proxySandboxCommandId?: string;
			proxySandboxStage?: string;
		},
		chargedMicros: number,
		usedAllowance: SandboxAllowance | undefined,
	): Promise<void> {
		if (lease.provider !== "vercel" || !lease.sandboxPricing)
			throw new Error("sandbox pricing identity missing");
		if (
			lease.runnerId &&
			!lease.actualJobId &&
			lease.sandboxStopFromStage !== "registering" &&
			!lease.sandboxPricing.proxyVmRequired
		)
			throw new Error("unknown assignment requires measured proxy settlement");
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
			const meters = await this.meters(
				lease.id,
				guest ? lease.sandboxSessionId : "",
			);
			const preJit =
				lease.runnerId === 0 &&
				!lease.sandboxCommandId &&
				["created", "creating"].includes(lease.sandboxStopFromStage);
			if (meters.calls === undefined && guest && !preJit)
				throw new Error("sandbox proxy meter unavailable");
			const calls = meters.calls ?? 0;
			let bytes = 0;
			if (guest) {
				if (
					(!meters.binding && !preJit) ||
					(meters.binding &&
						(meters.binding.accountId !== lease.accountId ||
							meters.binding.leaseId !== lease.id))
				)
					throw new Error("sandbox egress meter unavailable");
				bytes = meters.binding ? (meters.used ?? 0) : 0;
			}
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
				encodeRecord(SandboxAllowanceSchema, usedAllowance) !==
					encodeRecord(SandboxAllowanceSchema, quote.usedAllowance)
			)
				throw new Error("sandbox charge differs from verified usage");
		}
		if (lease.reservedFreeMinutes !== 0)
			throw new Error("sandbox free allocation accounting unavailable");
		const reserved = lease.sandboxReservedAllowance;
		if (
			!usedAllowance &&
			reserved &&
			SANDBOX_FIELDS.some((field) => reserved[field] > 0)
		)
			throw new Error("sandbox usage allowance missing");
		const used = usedAllowance ?? create(SandboxAllowanceSchema);
		for (const field of SANDBOX_FIELDS)
			if (
				!Number.isSafeInteger(used[field]) ||
				used[field] < 0 ||
				used[field] > (reserved?.[field] ?? 0)
			)
				throw new Error("invalid sandbox usage allowance");
		if (
			SANDBOX_FIELDS.some((field) => used[field] > 0) &&
			(!Number.isFinite(Date.parse(lease.freeValidUntil)) ||
				Date.parse(completedAt) > Date.parse(lease.freeValidUntil))
		)
			throw new Error("sandbox free allowance expired");
	}

	// -------------------------------------------------------------------------
	// Webhook intake (dedupe only; the queue is the inbox)
	// -------------------------------------------------------------------------

	async hasWebhook(deliveryId: string): Promise<boolean> {
		if (!isWebhookDeliveryId(deliveryId)) return false;
		return (await this.state.get(this.keys.delivery(deliveryId))) !== undefined;
	}

	acceptWebhook(input: WebhookInput): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, false);
	}

	/** Remember authenticated deliveries for installations without a current connection. */
	acceptIgnoredWebhook(input: WebhookInput): Promise<{ duplicate: boolean }> {
		return this.acceptDelivery(input, true);
	}

	private async acceptDelivery(
		input: WebhookInput,
		ignored: boolean,
	): Promise<{ duplicate: boolean }> {
		const { fingerprint, bodyHash, receivedMs } = parseWebhookEnvelope(input);
		if (!ignored && !this.options.intake)
			throw new Error("webhook intake not configured");
		const deliveryKey = this.keys.delivery(input.deliveryId);
		const marker = await this.state.putIfAbsent(
			deliveryKey,
			encodeRecord(
				RelayCacheDeliverySchema,
				create(RelayCacheDeliverySchema, {
					fingerprint,
					receivedAt: input.receivedAt,
					ignored,
				}),
			),
			RELAY_TTL.delivery,
		);
		if (!marker.applied) {
			const existing = await this.state.get(deliveryKey);
			if (
				existing &&
				decodeRecord(RelayCacheDeliverySchema, existing.value).fingerprint !==
					fingerprint
			)
				throw new Error("conflicting webhook delivery id");
			return { duplicate: true };
		}
		const undo = async () => {
			await this.state.delete(deliveryKey, marker.version);
		};
		// GitHub signs body bytes only: the same signed body under a new id is a replay.
		const bodyKey = this.keys.deliveryBody(input.installationId, bodyHash);
		const body = await this.state.putIfAbsent(
			bodyKey,
			input.deliveryId,
			RELAY_TTL.delivery,
		);
		if (!body.applied) return { duplicate: true };
		const window =
			Math.floor(receivedMs / RELAY_WEBHOOK_RATE_WINDOW_MS) *
			RELAY_WEBHOOK_RATE_WINDOW_MS;
		const recent = await this.state.increment(
			this.keys.webhookRate(input.installationId, window),
			1,
			RELAY_TTL.webhookRate,
			"on-create",
		);
		if (recent > MAX_WEBHOOKS_PER_INSTALLATION_WINDOW) {
			await undo();
			await this.state.delete(bodyKey, body.version);
			throw new Error("webhook admission limit reached");
		}
		if (!ignored) {
			try {
				await this.options.intake?.enqueue({
					...input,
					rawBody: Uint8Array.from(input.rawBody),
				});
			} catch (error) {
				// Let GitHub's redelivery admit it again.
				await undo();
				await this.state.delete(bodyKey, body.version);
				throw error;
			}
		}
		return { duplicate: false };
	}

	/** Intake is pushed by the queue (phase 4b); there is no inbox to claim from. */
	async claimWebhook(): Promise<undefined> {
		return undefined;
	}
	async ackWebhook(): Promise<boolean> {
		return false;
	}
	async failWebhook(): Promise<"stale"> {
		return "stale";
	}
	/** No quarantine list: a delivery that cannot be admitted is logged and dropped. */
	async quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<QuarantinedWebhook[]> {
		void accountId;
		await this.checkRevision(expectedRevision);
		return [];
	}
	async retryQuarantinedWebhook(): Promise<boolean> {
		return false;
	}

	// -------------------------------------------------------------------------
	// MCP change feed
	// -------------------------------------------------------------------------

	private sequenced(
		entries: readonly { seq: number; value: string }[],
	): SequencedCiEvent[] {
		return entries.map((entry) =>
			create(SequencedCiEventSchema, {
				seq: entry.seq,
				event: decodeRecord(CiEventSchema, entry.value),
			}),
		);
	}

	/**
	 * An account's changes after a cursor, or its newest. A cursor the ring no
	 * longer covers (entries evicted, or the ring lost and restarted) answers
	 * the newest changes with `truncated: true`: the caller re-reads the
	 * in-flight list instead of trusting it saw everything.
	 */
	async eventsSince(cursor: EventCursor): Promise<CiEventPage> {
		const { accountId, after, limit } = eventCursorBounds(cursor);
		const ring = this.ring(accountId);
		if (after !== undefined) {
			const read = await ring.read(after, limit + 1);
			const oldest = Math.max(1, read.head - RELAY_FEED_CAPACITY + 1);
			if (!read.reset && after + 1 >= oldest)
				return accountEventPage(this.sequenced(read.entries), cursor);
		}
		const head = (await ring.read(0, 1)).head;
		const newest = await ring.read(Math.max(0, head - limit - 1), limit + 1);
		const page = accountEventPage(this.sequenced(newest.entries), {
			accountId,
			limit,
		});
		if (after !== undefined) page.truncated = true;
		return page;
	}

	/** The newest changes of one lease still in its account's ring. */
	async leaseEvents(query: LeaseEventsQuery): Promise<SequencedCiEvent[]> {
		const { accountId, leaseId, limit } = leaseEventsBounds(query);
		const read = await this.ring(accountId).read(0);
		return this.sequenced(read.entries)
			.filter(
				(entry) =>
					entry.event?.leaseId === leaseId &&
					entry.event.accountId === accountId,
			)
			.slice(-limit);
	}

	/**
	 * Rings are per account, so there is no relay-wide head. Zero makes a new
	 * subscriber's first read report the ring's present changes once.
	 */
	async journalHead(): Promise<number> {
		return 0;
	}

	/** Every configured account's recent changes, oldest first (the account API's lease view). */
	async events(): Promise<CiEvent[]> {
		const events: { at: string; seq: number; event: CiEvent }[] = [];
		for (const accountId of this.accountIds(await this.snapshot())) {
			const read = await this.ring(accountId).read(0);
			for (const entry of this.sequenced(read.entries))
				if (entry.event)
					events.push({
						at: entry.event.at,
						seq: entry.seq,
						event: entry.event,
					});
		}
		return events
			.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
			.map((entry) => entry.event);
	}

	observer(): CiObserver {
		return {
			configuration: () => this.configuration(),
			get: (id) => this.get(id),
			accountLeases: (accountId) => this.accountLeases(accountId),
			pendingJobs: () => this.pendingJobs(),
			journalHead: () => this.journalHead(),
			eventsSince: (cursor) => this.eventsSince(cursor),
			leaseEvents: (query) => this.leaseEvents(query),
			quarantinedWebhooks: (accountId, expectedRevision) =>
				this.quarantinedWebhooks(accountId, expectedRevision),
		};
	}

	// -------------------------------------------------------------------------
	// Rebuild hooks (see rebuild.ts)
	// -------------------------------------------------------------------------

	/** Raw reads the rebuild pass needs; not part of the relay's port. */
	rebuildAccess() {
		return {
			readJob: (key: string) => this.readJob(key),
			readLeases: (ids: readonly string[]) => this.readLeases(ids),
			snapshot: () => this.snapshot(),
			/** Create a reconstructed lease record; false when one already exists. */
			createLease: async (
				lease: Lease,
				generation: number,
				rebuiltFrom: string,
			) => {
				const created = await this.write(
					this.keys.lease(lease.id),
					undefined,
					encodeRecord(
						RelayCacheLeaseSchema,
						create(RelayCacheLeaseSchema, {
							leaseJson: encodeRecord(LeaseSchema, lease),
							jobKey: relayJobKey(lease),
							generation,
							rebuiltFrom,
						}),
					),
					relayLeaseTtl(lease),
				);
				if (!created) return false;
				await this.holdInIndex(lease);
				await this.emitLease(lease, "ci.LeaseRebuilt", lease.createdAt);
				return true;
			},
			/** Point the job record at a lease (or mark it terminal) after a rebuild. */
			restoreJob: (
				key: string,
				change: (
					record: RelayCacheJob | undefined,
				) => RelayCacheJob | undefined,
			) => this.settleJobRecord(key, change),
			queue: (job: Job, at: string, githubCreatedAt?: string) =>
				this.snapshot().then((snapshot) =>
					this.queueInside(snapshot, job, at, githubCreatedAt),
				),
			cancel: (id: string, expected: readonly string[], at: string) =>
				this.cancel(id, expected, at),
		};
	}
}
