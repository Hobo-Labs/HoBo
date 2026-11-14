/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: this is the serialization boundary for untrusted journal commands; the envelope and packed values are parsed and each operation is validated before it reaches the SQLite journal. */
/**
 * Replay HoBo's transactional SQLite journal from a majority-chosen immutable
 * command log. This adapter intentionally does not provide distributed leases
 * or external-effect execution: those require independently enforced voter
 * deadlines and a downstream fence, not merely a local time check.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	type ImmutableJournal,
	type ImmutableJournalEntry,
	ImmutableJournalError,
	type ImmutableJournalMember,
} from "@hobo/backend-fleet";
import {
	type AppendResult,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	EventStoreError,
	type JsonValue,
	type PositionedEvent,
	parseEventPosition,
	type SnapshotRecord,
	type StreamFilter,
	type Subscription,
} from "@hobo/core";
import { SqliteJournal } from "./journal.js";
import { createMemoryNodeSqliteDriver } from "./node-driver.js";

type Packed = null | boolean | number | string | readonly Packed[];
type Operation =
	| "commit"
	| "snapshot"
	| "actor-claim"
	| "actor-release"
	| "subscription-claim"
	| "subscription-release"
	| "checkpoint";
type Command = Readonly<{
	contract: "hobo.quorum-eventstore-command/v2";
	kind: Operation;
	policyDigest: string;
	timeMs: number;
	arguments: Packed;
}>;
type Materialized = {
	readonly journal: SqliteJournal;
	readonly setTime: (timeMs: number) => void;
	readonly close: () => void;
	lastTimeMs: number;
	lastEventPosition: bigint;
	readonly policyDigest: string;
	readonly protectedPrefixes: readonly string[];
	readonly actors: Map<string, QuorumActorClaim & { active: boolean }>;
	readonly subscriptions: Map<
		string,
		QuorumSubscriptionClaim & { active: boolean }
	>;
	readonly checkpoints: Map<string, QuorumClaimCheckpoint>;
};

/** These claims never expire. Reassignment requires independently verified
 * source-stopped evidence, and every protected append checks the exact token. */
export type QuorumActorClaim = Readonly<{
	key: string;
	holderId: string;
	claimId: string;
	fenceToken: bigint;
}>;
export type QuorumSubscriptionClaim = Readonly<{
	subscriptionId: string;
	partitionId: string;
	holderId: string;
	claimId: string;
	fenceToken: bigint;
}>;
export type QuorumClaimCheckpoint = Readonly<{
	subscriptionId: string;
	partitionId: string;
	position: bigint;
	fenceToken: bigint;
	updatedAt: string;
}>;
export interface QuorumNonExpiringClaims {
	claimActor(input: {
		key: string;
		holderId: string;
		requestId: string;
	}): Promise<QuorumActorClaim>;
	verifyActor(claim: QuorumActorClaim): Promise<void>;
	releaseActor(
		input: QuorumActorClaim & { requestId: string; evidence: string },
	): Promise<void>;
	claimSubscription(input: {
		subscriptionId: string;
		partitionId: string;
		holderId: string;
		requestId: string;
	}): Promise<QuorumSubscriptionClaim>;
	releaseSubscription(
		input: QuorumSubscriptionClaim & { requestId: string; evidence: string },
	): Promise<void>;
	commitCheckpoint(
		input: QuorumSubscriptionClaim & { requestId: string; position: bigint },
	): Promise<QuorumClaimCheckpoint>;
	loadCheckpoint(input: {
		subscriptionId: string;
		partitionId: string;
	}): Promise<QuorumClaimCheckpoint | undefined>;
}

/** A majority journal with explicitly bounded replay and a host-supplied clock.
 * Provider identity, monotonic storage, budget and independent clock/effect
 * fencing must be established by the host before this can serve deployment. */
export interface QuorumEventStore extends DurableEventStore {
	/** Explicitly funded recovery of a pending majority decision. */
	recover(): Promise<void>;
	close(): Promise<void>;
	readonly nonExpiringClaims?: QuorumNonExpiringClaims;
}
/** Construction provenance only; provider enrollment and health are separate. */
export type QuorumEventStoreIdentity = Readonly<{
	fleetId: string;
	anchorDigest: string;
	quorum: number;
	members: readonly ImmutableJournalMember[];
	hasNonExpiringClaims: boolean;
	hasOperationalRecovery: boolean;
}>;

const quorumEventStores = new WeakMap<
	object,
	Readonly<{
		journal: ImmutableJournal;
		identity: QuorumEventStoreIdentity;
	}>
>();

export function assertQuorumEventStore(
	value: unknown,
): asserts value is QuorumEventStore {
	if (!value || typeof value !== "object" || !quorumEventStores.has(value))
		throw new TypeError("not a HoBo quorum event store");
}

/** Returns immutable construction metadata, not proof of provider readiness. */
export function quorumEventStoreIdentity(
	value: unknown,
): QuorumEventStoreIdentity {
	assertQuorumEventStore(value);
	const entry = quorumEventStores.get(value);
	if (!entry) throw new TypeError("not a HoBo quorum event store");
	return entry.identity;
}

/** Verifies the exact attached journal without exposing its write authority. */
export function assertQuorumEventStoreJournal(
	value: unknown,
	journal: ImmutableJournal,
): void {
	assertQuorumEventStore(value);
	if (quorumEventStores.get(value)?.journal !== journal)
		throw new TypeError("quorum store is attached to a different journal");
}

export interface QuorumEventStoreOptions {
	readonly journal: ImmutableJournal;
	readonly nowMs: () => number;
	readonly maxReplayEntries: number;
	readonly maxReplayBytes: number;
	readonly pollIntervalMs?: number;
	/** Optional execution-only authority. Read-only hosts must omit this.
	 * It must verify the current actor and a pre-funded allowance without using
	 * this same journal (which could recurse). Each voter must also enforce its
	 * own scoped, funded provider I/O. */
	readonly operationalRecovery?: Readonly<{
		authorize(
			input: Readonly<{ fleetId: string; anchorDigest: string }>,
		): Promise<void>;
	}>;
	readonly claims?: Readonly<{
		/** Stable, independently approved identity for the release verifier. */
		contractId: string;
		protectedStreamPrefixes: readonly string[];
		/** Must establish an irreversible source fence or termination, not a
		 * transient health observation. It is rechecked before journal append. */
		verifyRelease(input: {
			kind: "actor" | "subscription";
			key: string;
			holderId: string;
			claimId: string;
			fenceToken: bigint;
			evidence: string;
		}): Promise<void>;
	}>;
}

function pack(value: unknown, seen = new Set<object>()): Packed {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return ["bigint", value.toString()];
	if (!value || typeof value !== "object" || seen.has(value))
		throw new TypeError("value is not serializable");
	seen.add(value);
	try {
		if (Array.isArray(value))
			return ["array", ...value.map((entry) => pack(entry, seen))];
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null)
			throw new TypeError("value is not a plain object");
		const entries: Packed[] = [];
		for (const [key, entry] of Object.entries(value).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			if (entry !== undefined) entries.push([key, pack(entry, seen)]);
		}
		return ["object", ...entries];
	} finally {
		seen.delete(value);
	}
}
function unpack(value: Packed): unknown {
	if (!Array.isArray(value)) return value;
	if (
		value[0] === "bigint" &&
		value.length === 2 &&
		typeof value[1] === "string" &&
		/^-?(0|[1-9]\d*)(?![\s\S])/u.test(value[1])
	)
		return BigInt(value[1]);
	if (value[0] === "array") return value.slice(1).map(unpack);
	if (value[0] === "object") {
		const output: Record<string, unknown> = Object.create(null);
		for (const entry of value.slice(1)) {
			if (
				!Array.isArray(entry) ||
				entry.length !== 2 ||
				typeof entry[0] !== "string" ||
				Object.hasOwn(output, entry[0]) ||
				entry[1] === undefined
			)
				throw new Error("invalid quorum event command");
			output[entry[0]] = unpack(entry[1]);
		}
		return output;
	}
	throw new Error("invalid quorum event command");
}
function parseCommand(text: string): Command {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("invalid quorum event command");
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("contract" in value) ||
		value.contract !== "hobo.quorum-eventstore-command/v2" ||
		!("kind" in value) ||
		typeof value.kind !== "string" ||
		![
			"commit",
			"snapshot",
			"actor-claim",
			"actor-release",
			"subscription-claim",
			"subscription-release",
			"checkpoint",
		].includes(value.kind) ||
		!("policyDigest" in value) ||
		typeof value.policyDigest !== "string" ||
		!/^[a-f0-9]{64}(?![\s\S])/u.test(value.policyDigest) ||
		!("timeMs" in value) ||
		typeof value.timeMs !== "number" ||
		!Number.isSafeInteger(value.timeMs) ||
		value.timeMs < 0 ||
		value.timeMs > 8_640_000_000_000_000 ||
		!("arguments" in value) ||
		!Array.isArray(value.arguments)
	)
		throw new Error("invalid quorum event command");
	// SAFETY: the envelope was narrowed above. unpack performs the recursive validation.
	return value as Command;
}
async function apply(state: Materialized, command: Command): Promise<unknown> {
	if (command.policyDigest !== state.policyDigest)
		throw new Error("quorum claim policy changed");
	if (command.timeMs < state.lastTimeMs)
		throw new Error("quorum journal time moved backwards");
	state.setTime(command.timeMs);
	state.lastTimeMs = command.timeMs;
	const args = unpack(command.arguments);
	if (!args || typeof args !== "object" || Array.isArray(args))
		throw new Error("invalid quorum event arguments");
	// SAFETY: unpack produces plain objects and the guard excludes null and arrays.
	const fields = args as Record<string, unknown>;
	const text = (name: string) => {
		const value = fields[name];
		if (
			typeof value !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}(?![\s\S])/u.test(value)
		)
			throw new Error("invalid quorum claim identity");
		return value;
	};
	const epoch = () => {
		const value = fields.fenceToken;
		if (
			typeof value !== "bigint" ||
			value < 1n ||
			value > 9_223_372_036_854_775_807n
		)
			throw new Error("invalid quorum claim fence");
		return value;
	};
	const protectedStream = (key: string) =>
		state.protectedPrefixes.some((prefix) => key.startsWith(prefix));
	if (command.kind === "commit") {
		// SAFETY: SqliteJournal.commit parses and validates the complete request.
		const request = args as DurableCommitRequest;
		if (protectedStream(request.streamId)) {
			const claim = state.actors.get(request.streamId);
			if (!claim?.active || request.append?.fenceToken !== claim.fenceToken)
				throw new Error("protected stream requires its current quorum claim");
		}
		// SAFETY: the underlying SqliteJournal validates every commit field.
		const result = await state.journal.commit(request);
		if (
			result.lastPosition !== undefined &&
			result.lastPosition > state.lastEventPosition
		)
			state.lastEventPosition = result.lastPosition;
		return result;
	}
	if (command.kind === "actor-claim") {
		const key = text("key"),
			holderId = text("holderId"),
			claimId = text("claimId");
		if (!protectedStream(key))
			throw new Error("actor claim outside protected policy");
		const old = state.actors.get(key);
		if (old?.active) {
			if (old.holderId === holderId && old.claimId === claimId)
				return { key, holderId, claimId, fenceToken: old.fenceToken };
			throw new Error("actor claim already held");
		}
		const previous = old?.fenceToken ?? 0n,
			head = state.journal.getStreamHead(key)?.ownerEpoch ?? 0n;
		const fenceToken = (previous > head ? previous : head) + 1n;
		if (fenceToken > 9_223_372_036_854_775_807n)
			throw new Error("actor claim fence exhausted");
		const claim = { key, holderId, claimId, fenceToken, active: true };
		state.actors.set(key, claim);
		return { key, holderId, claimId, fenceToken };
	}
	if (command.kind === "actor-release") {
		const key = text("key"),
			holderId = text("holderId"),
			claimId = text("claimId"),
			fenceToken = epoch();
		const evidenceDigest = fields.evidenceDigest;
		const claim = state.actors.get(key);
		if (
			!claim?.active ||
			claim.holderId !== holderId ||
			claim.claimId !== claimId ||
			claim.fenceToken !== fenceToken ||
			typeof evidenceDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(evidenceDigest)
		)
			throw new Error("actor claim release differs from current owner");
		claim.active = false;
		return undefined;
	}
	if (
		command.kind === "subscription-claim" ||
		command.kind === "subscription-release" ||
		command.kind === "checkpoint"
	) {
		const subscriptionId = text("subscriptionId"),
			partitionId = text("partitionId"),
			key = JSON.stringify([subscriptionId, partitionId]);
		const holderId = text("holderId"),
			claimId = text("claimId");
		const current = state.subscriptions.get(key);
		if (command.kind === "subscription-claim") {
			if (current?.active) {
				if (current.holderId === holderId && current.claimId === claimId)
					return {
						subscriptionId,
						partitionId,
						holderId,
						claimId,
						fenceToken: current.fenceToken,
					};
				throw new Error("subscription claim already held");
			}
			const fenceToken = (current?.fenceToken ?? 0n) + 1n;
			if (fenceToken > 9_223_372_036_854_775_807n)
				throw new Error("subscription claim fence exhausted");
			state.subscriptions.set(key, {
				subscriptionId,
				partitionId,
				holderId,
				claimId,
				fenceToken,
				active: true,
			});
			return { subscriptionId, partitionId, holderId, claimId, fenceToken };
		}
		const fenceToken = epoch();
		if (
			!current?.active ||
			current.holderId !== holderId ||
			current.claimId !== claimId ||
			current.fenceToken !== fenceToken
		)
			throw new Error("subscription claim is stale");
		if (command.kind === "subscription-release") {
			const evidenceDigest = fields.evidenceDigest;
			if (
				typeof evidenceDigest !== "string" ||
				!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(evidenceDigest)
			)
				throw new Error("subscription release evidence missing");
			current.active = false;
			return undefined;
		}
		const value = fields.position;
		if (typeof value !== "bigint" || value < 0n)
			throw new Error("invalid checkpoint position");
		const prior = state.checkpoints.get(key);
		if (prior && value < prior.position)
			throw new Error("checkpoint cannot move backwards");
		if (value > state.lastEventPosition)
			throw new Error("checkpoint is ahead of the journal");
		const checkpoint = {
			subscriptionId,
			partitionId,
			position: value,
			fenceToken,
			updatedAt: new Date(command.timeMs).toISOString(),
		};
		state.checkpoints.set(key, checkpoint);
		return checkpoint;
	}
	if (command.kind !== "snapshot")
		throw new Error("invalid quorum event operation");
	if (
		!("streamId" in args) ||
		typeof args.streamId !== "string" ||
		!("seq" in args) ||
		typeof args.seq !== "number" ||
		!("state" in args)
	)
		throw new Error("invalid quorum snapshot arguments");
	if (protectedStream(args.streamId))
		throw new Error("protected snapshot needs a fenced claim");
	return state.journal.snapshot(args.streamId, args.state, args.seq);
}
function createMaterialized(
	policyDigest: string,
	protectedPrefixes: readonly string[],
): Materialized {
	let timeMs = 0;
	const driver = createMemoryNodeSqliteDriver();
	const journal = new SqliteJournal(driver, {
		clock: { now: () => new Date(timeMs).toISOString() },
		now: new Date(0).toISOString(),
	});
	return {
		journal,
		setTime(value) {
			timeMs = value;
		},
		close: () => driver.close(),
		lastTimeMs: 0,
		lastEventPosition: 0n,
		policyDigest,
		protectedPrefixes,
		actors: new Map(),
		subscriptions: new Map(),
		checkpoints: new Map(),
	};
}

export function createQuorumEventStore(
	options: QuorumEventStoreOptions,
): QuorumEventStore {
	const protectedPrefixes = [
		...(options.claims?.protectedStreamPrefixes ?? []),
	].sort();
	if (
		!Number.isSafeInteger(options.maxReplayEntries) ||
		options.maxReplayEntries < 1 ||
		options.maxReplayEntries > 10_000 ||
		!Number.isSafeInteger(options.maxReplayBytes) ||
		options.maxReplayBytes < 1024 ||
		options.maxReplayBytes > 256 * 1024 * 1024 ||
		(options.pollIntervalMs !== undefined &&
			(!Number.isSafeInteger(options.pollIntervalMs) ||
				options.pollIntervalMs < 100 ||
				options.pollIntervalMs > 60_000)) ||
		(options.operationalRecovery !== undefined &&
			!(options.operationalRecovery.authorize instanceof Function)) ||
		new Set(protectedPrefixes).size !== protectedPrefixes.length ||
		protectedPrefixes.some(
			(prefix) =>
				!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?![\s\S])/u.test(prefix),
		) ||
		(options.claims !== undefined &&
			(protectedPrefixes.length === 0 ||
				!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}(?![\s\S])/u.test(
					options.claims.contractId,
				) ||
				!(options.claims.verifyRelease instanceof Function)))
	)
		throw new TypeError("invalid quorum event store limits");
	const policyDigest = createHash("sha256")
		.update(
			JSON.stringify({
				contract: "hobo.quorum-eventstore-policy/v1",
				protectedPrefixes,
				verifierContractId: options.claims?.contractId ?? null,
			}),
		)
		.digest("hex");
	const verifyRelease = options.claims?.verifyRelease.bind(options.claims);
	const authorizeRecovery = options.operationalRecovery?.authorize.bind(
		options.operationalRecovery,
	);
	const recoveryScope = Object.freeze({
		fleetId: options.journal.fleetId,
		anchorDigest: options.journal.anchorDigest,
	});
	let closed = false;
	const subscriptions = new Set<{
		stopped: boolean;
		filter: StreamFilter;
		handler: (event: EventEnvelope) => void | Promise<void>;
		position: bigint;
	}>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let draining = false;
	function alive() {
		if (closed)
			throw new EventStoreError(
				"PERSISTENCE_UNAVAILABLE",
				"quorum event store is closed",
			);
	}
	function safeTime() {
		const now = options.nowMs();
		if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
			throw new EventStoreError(
				"PERSISTENCE_UNAVAILABLE",
				"quorum clock is invalid",
			);
		return now;
	}
	async function replay(
		entries: readonly ImmutableJournalEntry[],
		captureId?: string,
	): Promise<{ state: Materialized; captured: unknown }> {
		if (
			entries.length > options.maxReplayEntries ||
			entries.reduce(
				(total, entry) => total + Buffer.byteLength(entry.value, "utf8"),
				0,
			) > options.maxReplayBytes
		)
			throw new EventStoreError(
				"PERSISTENCE_UNAVAILABLE",
				"quorum journal replay limit reached",
			);
		const state = createMaterialized(policyDigest, protectedPrefixes);
		let captured: unknown;
		try {
			for (const entry of entries) {
				const command = parseCommand(entry.value);
				const result = await apply(state, command);
				if (entry.operationId === captureId) captured = result;
			}
			return { state, captured };
		} catch {
			state.close();
			throw new EventStoreError(
				"INTEGRITY_FAILURE",
				"quorum journal replay failed",
			);
		}
	}
	async function mutate(
		kind: Operation,
		args: unknown,
		requestId?: string,
		beforeAppend?: () => Promise<void>,
	): Promise<unknown> {
		alive();
		if (
			requestId !== undefined &&
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?![\s\S])/u.test(requestId)
		)
			throw new TypeError("invalid quorum operation id");
		const id =
			requestId === undefined
				? `eventstore:${randomUUID()}`
				: `eventstore:${createHash("sha256")
						.update(JSON.stringify([kind, requestId]))
						.digest("hex")}`;
		const timeMs = safeTime();
		const command: Command = {
			contract: "hobo.quorum-eventstore-command/v2",
			kind,
			policyDigest,
			timeMs,
			arguments: pack(args),
		};
		const value = JSON.stringify(command);
		for (let attempt = 0; attempt < 5; attempt++) {
			const entries = await options.journal.recover();
			const existing = entries.find((entry) => entry.operationId === id);
			if (existing) {
				const recorded = parseCommand(existing.value);
				if (
					recorded.kind !== command.kind ||
					recorded.policyDigest !== policyDigest ||
					JSON.stringify(recorded.arguments) !==
						JSON.stringify(command.arguments)
				)
					throw new EventStoreError(
						"INTEGRITY_FAILURE",
						"quorum operation identity changed",
					);
			}
			const { state, captured } = await replay(entries, id);
			try {
				if (existing) {
					// An old successful claim cannot be returned as current after release.
					if (kind === "actor-claim") {
						// SAFETY: replay captured the validated actor-claim result for this exact operation.
						const result = captured as QuorumActorClaim;
						const current = state.actors.get(result.key);
						if (
							!current?.active ||
							current.claimId !== result.claimId ||
							current.fenceToken !== result.fenceToken
						)
							throw new Error("actor claim is stale");
					}
					if (kind === "subscription-claim") {
						// SAFETY: replay captured the validated subscription-claim result for this exact operation.
						const result = captured as QuorumSubscriptionClaim;
						const current = state.subscriptions.get(
							JSON.stringify([result.subscriptionId, result.partitionId]),
						);
						if (
							!current?.active ||
							current.claimId !== result.claimId ||
							current.fenceToken !== result.fenceToken
						)
							throw new Error("subscription claim is stale");
					}
					return captured;
				}
				if (
					entries.length >= options.maxReplayEntries ||
					entries.reduce(
						(total, entry) => total + Buffer.byteLength(entry.value, "utf8"),
						Buffer.byteLength(value, "utf8"),
					) > options.maxReplayBytes
				)
					throw new EventStoreError(
						"PERSISTENCE_UNAVAILABLE",
						"quorum journal replay limit reached",
					);
				const result = await apply(state, command);
				try {
					await beforeAppend?.();
					alive();
					await options.journal.append(id, value, entries.length);
					return result;
				} catch (error) {
					if (
						!(error instanceof ImmutableJournalError) ||
						error.reason !== "head-conflict"
					)
						throw error;
				}
			} finally {
				state.close();
			}
		}
		throw new EventStoreError(
			"PERSISTENCE_UNAVAILABLE",
			"quorum journal contention",
		);
	}
	async function snapshotState() {
		alive();
		let entries: readonly ImmutableJournalEntry[];
		try {
			entries = await options.journal.read();
		} catch (error) {
			// Never turn an integrity, identity, or authorization failure into a
			// repair. A read-only host has no authority to repair any voter.
			if (
				!(error instanceof ImmutableJournalError) ||
				error.reason !== "quorum-unavailable" ||
				!authorizeRecovery
			)
				throw error;
			await authorizeRecovery(recoveryScope);
			alive();
			entries = await options.journal.recover();
			await authorizeRecovery(recoveryScope);
			alive();
		}
		return (await replay(entries)).state;
	}
	async function drain() {
		if (closed || !subscriptions.size || draining) return;
		draining = true;
		try {
			const state = await snapshotState();
			try {
				for (const sub of subscriptions) {
					let after = sub.position;
					for (;;) {
						const page: PositionedEvent[] = [];
						for await (const item of state.journal.readAll({
							after: parseEventPosition(after),
						}))
							page.push(item);
						for (const item of page) {
							after = item.position;
							if (
								!sub.stopped &&
								(!sub.filter.streamId ||
									sub.filter.streamId === item.event.streamId) &&
								(!sub.filter.type || sub.filter.type === item.event.type)
							)
								await sub.handler(structuredClone(item.event));
							sub.position = after;
						}
						if (page.length < 1000) break;
					}
				}
			} finally {
				state.close();
			}
		} catch {
			/* live notifications are hints; catch-up reads are authoritative */
		} finally {
			draining = false;
		}
		if (!closed && subscriptions.size)
			timer = setTimeout(() => {
				void drain();
			}, options.pollIntervalMs ?? 5000);
	}
	const nonExpiringClaims: QuorumNonExpiringClaims | undefined = verifyRelease
		? Object.freeze<QuorumNonExpiringClaims>({
				async claimActor(input) {
					// SAFETY: the actor-claim operation returns a validated QuorumActorClaim.
					return (await mutate(
						"actor-claim",
						{
							key: input.key,
							holderId: input.holderId,
							claimId: input.requestId,
						},
						input.requestId,
					)) as QuorumActorClaim;
				},
				async verifyActor(claim) {
					const { key, holderId, claimId, fenceToken } = claim;
					const state = await snapshotState();
					try {
						const current = state.actors.get(key);
						if (
							!current?.active ||
							current.holderId !== holderId ||
							current.claimId !== claimId ||
							current.fenceToken !== fenceToken
						)
							throw new Error("actor claim is stale");
					} finally {
						state.close();
					}
				},
				async releaseActor(input) {
					const { key, holderId, claimId, fenceToken, evidence, requestId } =
						input;
					if (
						typeof evidence !== "string" ||
						evidence.length === 0 ||
						Buffer.byteLength(evidence, "utf8") > 16_384
					)
						throw new TypeError("invalid claim release evidence");
					const proof = Object.freeze({
						kind: "actor" as const,
						key,
						holderId,
						claimId,
						fenceToken,
						evidence,
					});
					await verifyRelease(proof);
					await mutate(
						"actor-release",
						{
							key: proof.key,
							holderId: proof.holderId,
							claimId: proof.claimId,
							fenceToken: proof.fenceToken,
							evidenceDigest: `sha256:${createHash("sha256").update(proof.evidence).digest("hex")}`,
						},
						requestId,
						() => verifyRelease(proof),
					);
				},
				async claimSubscription(input) {
					// SAFETY: the subscription-claim operation returns a validated QuorumSubscriptionClaim.
					return (await mutate(
						"subscription-claim",
						{
							subscriptionId: input.subscriptionId,
							partitionId: input.partitionId,
							holderId: input.holderId,
							claimId: input.requestId,
						},
						input.requestId,
					)) as QuorumSubscriptionClaim;
				},
				async releaseSubscription(input) {
					const {
						subscriptionId,
						partitionId,
						holderId,
						claimId,
						fenceToken,
						evidence,
						requestId,
					} = input;
					if (
						typeof evidence !== "string" ||
						evidence.length === 0 ||
						Buffer.byteLength(evidence, "utf8") > 16_384
					)
						throw new TypeError("invalid claim release evidence");
					const proof = Object.freeze({
						kind: "subscription" as const,
						key: JSON.stringify([subscriptionId, partitionId]),
						holderId,
						claimId,
						fenceToken,
						evidence,
					});
					await verifyRelease(proof);
					await mutate(
						"subscription-release",
						{
							subscriptionId,
							partitionId,
							holderId: proof.holderId,
							claimId: proof.claimId,
							fenceToken: proof.fenceToken,
							evidenceDigest: `sha256:${createHash("sha256").update(proof.evidence).digest("hex")}`,
						},
						requestId,
						() => verifyRelease(proof),
					);
				},
				async commitCheckpoint(input) {
					// SAFETY: the checkpoint operation returns a validated QuorumClaimCheckpoint.
					return (await mutate(
						"checkpoint",
						{
							subscriptionId: input.subscriptionId,
							partitionId: input.partitionId,
							holderId: input.holderId,
							claimId: input.claimId,
							fenceToken: input.fenceToken,
							position: input.position,
						},
						input.requestId,
					)) as QuorumClaimCheckpoint;
				},
				async loadCheckpoint(input) {
					const state = await snapshotState();
					try {
						const value = state.checkpoints.get(
							JSON.stringify([input.subscriptionId, input.partitionId]),
						);
						return value ? { ...value } : undefined;
					} finally {
						state.close();
					}
				},
			})
		: undefined;
	const store: QuorumEventStore = {
		async append(streamId, events, append): Promise<AppendResult> {
			const result = await store.commit({ streamId, events, append });
			const reply: AppendResult = {
				streamId: result.streamId,
				appended: result.appended,
				deduped: result.deduped,
			};
			if (result.firstPosition !== undefined)
				reply.firstPosition = result.firstPosition;
			if (result.lastPosition !== undefined)
				reply.lastPosition = result.lastPosition;
			return reply;
		},
		async commit(request): Promise<DurableCommitResult> {
			// SAFETY: apply dispatches commit commands to SqliteJournal.commit.
			return (await mutate("commit", request)) as DurableCommitResult;
		},
		async *read(streamId, fromSeq): AsyncIterable<EventEnvelope> {
			const state = await snapshotState();
			try {
				yield* state.journal.read(streamId, fromSeq);
			} finally {
				state.close();
			}
		},
		async *readAll(input): AsyncIterable<PositionedEvent> {
			const state = await snapshotState();
			try {
				yield* state.journal.readAll(input);
			} finally {
				state.close();
			}
		},
		subscribe(filter, handler): Subscription {
			alive();
			if (!(handler instanceof Function))
				throw new TypeError("handler must be a function");
			// Live delivery begins with catch-up, avoiding a missed wake during startup.
			const sub = {
				stopped: false,
				filter: { ...filter },
				handler,
				position: 0n,
			};
			subscriptions.add(sub);
			if (!timer)
				timer = setTimeout(() => {
					timer = undefined;
					void drain();
				}, 0);
			return {
				unsubscribe() {
					sub.stopped = true;
					subscriptions.delete(sub);
				},
			};
		},
		async snapshot(
			streamId: string,
			state: JsonValue,
			seq: number,
		): Promise<SnapshotRecord> {
			// SAFETY: apply dispatches snapshot commands to SqliteJournal.snapshot.
			return (await mutate("snapshot", {
				streamId,
				state,
				seq,
			})) as SnapshotRecord;
		},
		async loadSnapshot<S>(
			streamId: string,
		): Promise<SnapshotRecord<S> | undefined> {
			const state = await snapshotState();
			try {
				return await state.journal.loadSnapshot<S>(streamId);
			} finally {
				state.close();
			}
		},
		async recover() {
			alive();
			if (!authorizeRecovery)
				throw new EventStoreError(
					"PERSISTENCE_UNAVAILABLE",
					"quorum recovery authority is unavailable",
				);
			await authorizeRecovery(recoveryScope);
			alive();
			await options.journal.recover();
			await authorizeRecovery(recoveryScope);
			alive();
		},
		async close() {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			subscriptions.clear();
		},
	};
	if (nonExpiringClaims) Object.assign(store, { nonExpiringClaims });
	const registered = Object.freeze(store);
	const members = Object.freeze(
		options.journal.members.map((member) =>
			Object.freeze({
				id: member.id,
				provider: member.provider,
				accountId: member.accountId,
				resourceId: member.resourceId,
				incarnation: member.incarnation,
			}),
		),
	);
	const identity = Object.freeze({
		fleetId: options.journal.fleetId,
		anchorDigest: options.journal.anchorDigest,
		quorum: options.journal.quorum,
		members,
		hasNonExpiringClaims: nonExpiringClaims !== undefined,
		hasOperationalRecovery: authorizeRecovery !== undefined,
	});
	quorumEventStores.set(registered, { journal: options.journal, identity });
	return registered;
}
