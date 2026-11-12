/**
 * The relay's cache fleet (ADR-0179 phase 4c): every bound cache backend is a
 * member, exactly one is active, and every port call goes to it.
 *
 * - **Which one is active** is read from the fleet's assignment register
 *   (`@hobo/backend-routing`), whose log is kept on every member in one key
 *   (`hobo-ci:<env>:fleet:assignment`) and decided by majority. A resolution
 *   is cached in memory for `assignmentTtlMs` (a minute), measured from when
 *   the read *started*. With a single member there is no register: it is
 *   active, and nothing is read.
 * - **Fail closed.** No majority, an undecided epoch that completion cannot
 *   settle, or a sealed fleet: every call is refused with a retryable
 *   `CacheFleetUnavailableError`. A queue message that hits it is redelivered;
 *   the relay never guesses a backend.
 * - **A move seals first.** The repair tick that decides a move writes a
 *   sealed entry (nobody writes), waits `sealWaitMs` (2.5 minutes, longer
 *   than twice the assignment cache, so every instance has dropped its old
 *   answer and any call it had in flight has ended), then activates the
 *   target. No two instances write to different backends. The wait is a
 *   delayed repair message, not a sleep in the function; the 15-minute tick is
 *   the backstop. The new backend starts cold, and the relay rebuilds leases
 *   by name as after any cache loss.
 * - **Budget routing.** Each tick reads what every member has spent this
 *   month (counters kept on the member itself, in the units it bills), turns
 *   the month's workload into every member's units with the bindings' cost
 *   tables, and asks `routeFleetByBudget` what to do. The decision is logged
 *   as one structured line: names, ids and numbers, never a value.
 */
import {
	type AssignmentResolution,
	billingPeriod,
	bootstrapAssignment,
	completeAssignment,
	type EphemeralAssignmentReplica,
	ephemeralAssignmentRegister,
	ephemeralAssignmentReplica,
	type FleetAssignment,
	type FleetBackendHealth,
	type FleetFailureClass,
	type FleetRoute,
	type FleetRoutingObservation,
	type FleetUsageMeasurement,
	type FleetUsageUnit,
	proposeAssignment,
	readAssignmentReplies,
	readCurrentAssignment,
	rejoinAssignmentReplicas,
	resolveAssignment,
	routeFleetByBudget,
} from "@hobo/backend-routing";
import {
	EPHEMERAL_STATE_COMMAND_COST,
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralKey,
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import type {
	CacheBackendId,
	CacheUsage,
	OpenedCacheBackend,
} from "./cache-backend.js";
import type { CacheOffers } from "./cache-offers.js";

/** A structured log line: an event name, then names, ids and numbers. */
export type CacheFleetLogLine = Readonly<
	{ event: string } & Record<
		string,
		| string
		| number
		| boolean
		| readonly string[]
		| Readonly<Record<string, number>>
	>
>;

/** The fleet cannot say which backend is active right now. Retry later. */
export class CacheFleetUnavailableError extends Error {
	readonly retryable = true;
	readonly reason: string;
	constructor(reason: string) {
		super(`cache fleet unavailable (${reason}); retry later`);
		this.name = "CacheFleetUnavailableError";
		this.reason = reason;
	}
}

export const DEFAULT_ASSIGNMENT_TTL_MS = 60_000;
export const DEFAULT_SEAL_WAIT_MS = 150_000;
const UNAVAILABLE_RETRY_MS = 5_000;
const USAGE_TTL = parseEphemeralTtlMs(EPHEMERAL_STATE_MAX_TTL_MS);
const PROBE_ATTEMPTS = 3;
const PROBE_INTERVAL_MS = 5_000;

type PortOperation =
	| "get"
	| "getMany"
	| "putIfAbsent"
	| "compareAndSet"
	| "delete"
	| "increment"
	| "expire";

/** Port calls this instance routed, by operation, plus keys asked by `getMany`. */
type PortTally = Record<PortOperation, number> & { getManyKeys: number };

type CostTables = Readonly<{
	libsql: Readonly<
		Record<
			string,
			Readonly<{ rowsReadMax: number; rowsWrittenMax: number; perKey?: true }>
		>
	>;
	blob: Readonly<
		Record<
			string,
			Readonly<{ simple: number; advanced: number; perKey?: true }>
		>
	>;
}>;

/**
 * What a tally of port calls costs in one unit, by the bindings' own tables:
 * one command per call on a Redis-protocol store, rows from
 * `LIBSQL_EPHEMERAL_COST`, Blob operations (the uncontended path) from
 * `VERCEL_BLOB_EPHEMERAL_COST`.
 */
export function tallyCost(
	tally: PortTally,
	unit: FleetUsageUnit,
	tables: CostTables,
): number {
	let total = 0;
	for (const operation of [
		"get",
		"getMany",
		"putIfAbsent",
		"compareAndSet",
		"delete",
		"increment",
		"expire",
	] as const) {
		const calls = tally[operation];
		if (calls === 0) continue;
		const keys = operation === "getMany" ? tally.getManyKeys : calls;
		const libsql = tables.libsql[operation];
		const blob = tables.blob[operation];
		switch (unit) {
			case "commands":
				total += calls * EPHEMERAL_STATE_COMMAND_COST[operation];
				break;
			case "rows-read":
				total += (libsql?.perKey ? keys : calls) * (libsql?.rowsReadMax ?? 1);
				break;
			case "rows-written":
				total += calls * (libsql?.rowsWrittenMax ?? 1);
				break;
			case "simple-operations":
				total += (blob?.perKey ? keys : calls) * (blob?.simple ?? 1);
				break;
			case "advanced-operations":
				total += calls * (blob?.advanced ?? 1);
				break;
			default:
				total += calls;
		}
	}
	return total;
}

async function loadCostTables(): Promise<CostTables> {
	const [turso, blob] = await Promise.all([
		import("@hobo/provider-turso"),
		import("@hobo/provider-vercel-blob"),
	]);
	return {
		libsql: turso.LIBSQL_EPHEMERAL_COST,
		blob: blob.VERCEL_BLOB_EPHEMERAL_COST,
	};
}

/** Which class of failure a cache call ended in. Only the class leaves. */
export function classifyCacheFailure(
	error: Error | undefined,
): FleetFailureClass {
	if (error === undefined) return "unknown";
	const text = `${"code" in error ? String(error.code) : ""} ${error.message}`;
	if (
		/quota|limit (?:has been )?(?:reached|exceeded)|max (?:daily|monthly) request|exceeded/iu.test(
			text,
		)
	)
		return "quota-exhausted";
	if (/unauthori[sz]ed|forbidden|WRONGPASS|NOAUTH|\b40[13]\b|auth/iu.test(text))
		return "auth";
	return "unreachable";
}

/** What one tick did, for the caller and its tests. */
export type CacheFleetTick = Readonly<{
	action:
		| "single"
		| "bootstrap"
		| "activate"
		| "sealed-waiting"
		| "reseal"
		| FleetRoute["action"]
		| "no-majority"
		| "undecided";
	epoch: number;
	active: string | undefined;
	target: string | undefined;
	reasons: readonly string[];
}>;

export type CacheFleetOptions = Readonly<{
	backends: readonly OpenedCacheBackend[];
	/** Cache namespace: production, preview and local never share keys. */
	environment: string;
	offers: CacheOffers;
	now?: () => number;
	log?: (line: CacheFleetLogLine) => void;
	/** Deliver a repair tick in `delaySeconds` (the activation of a sealed move). */
	scheduleActivation?: (delaySeconds: number, epoch: number) => Promise<void>;
	assignmentTtlMs?: number;
	sealWaitMs?: number;
	/** Who proposes entries; a short token, never a person. */
	decidedBy?: string;
	/** Usage is written to the members at most this often, outside a tick. */
	flushIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}>;

export type CacheFleet = Readonly<{
	/** The port the relay uses: every call goes to the active backend. */
	state: EphemeralStatePort;
	members: readonly CacheBackendId[];
	/** The active backend as last resolved, without a read. */
	activeId(): string | undefined;
	/** The repair tick: usage, register upkeep, the budget decision. */
	tick(): Promise<CacheFleetTick>;
	/** Write usage now (a tick does) or when the interval has passed. */
	flushUsage(force?: boolean): Promise<void>;
	close(): Promise<void>;
}>;

type View =
	| { readonly kind: "active"; readonly id: string; readonly epoch: number }
	| { readonly kind: "refused"; readonly reason: string };

function viewOf(resolution: AssignmentResolution): View {
	switch (resolution.status) {
		case "current": {
			const entry = resolution.assignment;
			if (entry.sealed) return { kind: "refused", reason: "sealed" };
			if (entry.active === undefined)
				return { kind: "refused", reason: "no-active-backend" };
			return { kind: "active", id: entry.active, epoch: entry.epoch };
		}
		case "no-majority":
			return { kind: "refused", reason: "no-majority" };
		case "undecided":
			return { kind: "refused", reason: "undecided" };
		case "empty":
			return { kind: "refused", reason: "empty" };
	}
}

/** A reason token an assignment entry can carry: lower-case, no punctuation. */
function reasonToken(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9:._ -]+/gu, "")
			.trim()
			.replace(/\s+/gu, "-")
			.slice(0, 120) || "decided"
	);
}

export function createCacheFleet(options: CacheFleetOptions): CacheFleet {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => undefined);
	const ttlMs = options.assignmentTtlMs ?? DEFAULT_ASSIGNMENT_TTL_MS;
	const sealWaitMs = options.sealWaitMs ?? DEFAULT_SEAL_WAIT_MS;
	if (sealWaitMs <= 2 * ttlMs)
		throw new Error(
			"the seal must outlast twice the assignment cache, or two instances could write to different backends",
		);
	const flushIntervalMs = options.flushIntervalMs ?? 60_000;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const decidedBy = options.decidedBy ?? "hobo-ci-relay";
	const backends = options.backends;
	if (backends.length === 0) throw new Error("a cache fleet needs a member");
	const members = backends.map((backend) => backend.binding.id);
	const byId = new Map<string, OpenedCacheBackend>(
		backends.map((backend) => [backend.binding.id, backend]),
	);
	const single = backends.length === 1 ? backends[0] : undefined;
	const logKey = `hobo-ci:${options.environment}:fleet:assignment`;
	const replicas: EphemeralAssignmentReplica[] = backends.map((backend) =>
		ephemeralAssignmentReplica(backend.state, backend.binding.id, {
			key: logKey,
		}),
	);
	const register = ephemeralAssignmentRegister(replicas, {
		classify: classifyCacheFailure,
	});

	// --- which backend is active ---------------------------------------------
	let cached: { view: View; readStartedAt: number } | undefined;
	let pending: Promise<View> | undefined;
	const failingSince = new Map<string, number>();

	async function resolveView(): Promise<View> {
		if (cached) {
			const age = now() - cached.readStartedAt;
			const limit =
				cached.view.kind === "active" ? ttlMs : UNAVAILABLE_RETRY_MS;
			if (age < limit) return cached.view;
		}
		pending ??= (async () => {
			const startedAt = now();
			let resolution = await readCurrentAssignment(register);
			if (resolution.status === "empty") {
				// The first entry is the same bytes from every instance.
				await bootstrapAssignment(register, members[0] ?? "memory");
				resolution = await readCurrentAssignment(register);
			} else if (resolution.status === "undecided") {
				resolution = await completeAssignment(register);
			}
			const view = viewOf(resolution);
			cached = { view, readStartedAt: startedAt };
			return view;
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	}

	async function active(): Promise<OpenedCacheBackend> {
		if (single) return single;
		const view = await resolveView();
		if (view.kind === "refused")
			throw new CacheFleetUnavailableError(view.reason);
		const backend = byId.get(view.id);
		if (!backend) throw new CacheFleetUnavailableError("unknown-backend");
		return backend;
	}

	// --- the routed port --------------------------------------------------------
	const tally: PortTally = {
		get: 0,
		getMany: 0,
		getManyKeys: 0,
		putIfAbsent: 0,
		compareAndSet: 0,
		delete: 0,
		increment: 0,
		expire: 0,
	};
	async function routed<T>(
		operation: PortOperation,
		call: (port: EphemeralStatePort) => Promise<T>,
	): Promise<T> {
		const backend = await active();
		tally[operation] += 1;
		try {
			const result = await call(backend.state);
			failingSince.delete(backend.binding.id);
			return result;
		} catch (error) {
			if (!failingSince.has(backend.binding.id))
				failingSince.set(backend.binding.id, now());
			throw error;
		}
	}
	const state: EphemeralStatePort = {
		get: (key) => routed("get", (port) => port.get(key)),
		getMany: (keys) => {
			tally.getManyKeys += keys.length;
			return routed("getMany", (port) => port.getMany(keys));
		},
		putIfAbsent: (key, value, ttl) =>
			routed("putIfAbsent", (port) => port.putIfAbsent(key, value, ttl)),
		compareAndSet: (key, expected, value, ttl) =>
			routed("compareAndSet", (port) =>
				port.compareAndSet(key, expected, value, ttl),
			),
		delete: (key, expected) =>
			routed("delete", (port) => port.delete(key, expected)),
		increment: (key, by, ttl, mode) =>
			routed("increment", (port) => port.increment(key, by, ttl, mode)),
		expire: (key, ttl) => routed("expire", (port) => port.expire(key, ttl)),
	};

	// --- usage, per member, in the units it bills ----------------------------
	const flushed = new Map<string, Partial<Record<FleetUsageUnit, number>>>();
	let lastFlushAt = Number.NEGATIVE_INFINITY;
	let flushing: Promise<void> | undefined;
	const usageKey = (id: string, unit: FleetUsageUnit, month: string) =>
		parseEphemeralKey(
			`hobo-ci:${options.environment}:fleet:usage:${id}:${unit}:${month}`,
		);

	async function flushMember(backend: OpenedCacheBackend, at: number) {
		const period = billingPeriod(at);
		const usage: CacheUsage = backend.usage();
		const done = flushed.get(backend.binding.id) ?? {};
		const used: Record<string, number> = {};
		const projected: Record<string, number> = {};
		const allowance: Record<string, number> = {};
		const offer = options.offers.offers.get(backend.binding.id);
		const elapsed =
			(at - period.startsAtMs) / (period.endsAtMs - period.startsAtMs);
		for (const unit of backend.units) {
			const delta = (usage[unit] ?? 0) - (done[unit] ?? 0);
			if (delta <= 0) continue;
			try {
				const total = await backend.state.increment(
					usageKey(backend.binding.id, unit, period.id),
					delta,
					USAGE_TTL,
					"on-create",
				);
				done[unit] = (done[unit] ?? 0) + delta;
				used[unit] = total;
				projected[unit] = elapsed > 0 ? Math.round(total / elapsed) : total;
				const included = offer?.model.allowances.find(
					(entry) => entry.unit === unit,
				)?.included;
				if (included !== undefined) allowance[unit] = included;
			} catch {
				// Kept for the next flush: nothing dropped, nothing counted twice.
			}
		}
		flushed.set(backend.binding.id, done);
		if (Object.keys(used).length === 0) return;
		log({
			event: "hobo_ci_cache_usage",
			backend: backend.binding.id,
			kind: backend.binding.kind,
			month: period.id,
			used,
			projected,
			allowance,
			overBudget: Object.entries(projected).some(
				([unit, value]) =>
					allowance[unit] !== undefined && value > (allowance[unit] ?? 0),
			),
		});
	}

	async function flushUsage(force = false): Promise<void> {
		const at = now();
		if (!force && at - lastFlushAt < flushIntervalMs) return;
		lastFlushAt = at;
		flushing ??= Promise.all(
			backends.map((backend) => flushMember(backend, at)),
		)
			.then(() => undefined)
			.finally(() => {
				flushing = undefined;
			});
		return flushing;
	}

	async function spent(
		backend: OpenedCacheBackend,
		at: number,
	): Promise<FleetUsageMeasurement[] | undefined> {
		const period = billingPeriod(at).id;
		const keys: EphemeralKey[] = backend.units.map((unit) =>
			usageKey(backend.binding.id, unit, period),
		);
		try {
			const entries = await backend.state.getMany(keys);
			return backend.units.map((unit, index) => {
				const value = Number(entries[index]?.value ?? 0);
				return {
					unit,
					used: Number.isSafeInteger(value) && value > 0 ? value : 0,
				};
			});
		} catch {
			return undefined;
		}
	}

	/** The month's workload in every unit, from each member's spend and the call mix. */
	async function workload(
		spends: ReadonlyMap<string, readonly FleetUsageMeasurement[]>,
	): Promise<FleetUsageMeasurement[]> {
		const tables = await loadCostTables();
		const units: FleetUsageUnit[] = [
			"commands",
			"rows-read",
			"rows-written",
			"simple-operations",
			"advanced-operations",
		];
		const totals = new Map<FleetUsageUnit, number>(units.map((u) => [u, 0]));
		for (const backend of backends) {
			const native = backend.units[0];
			const measured = spends
				.get(backend.binding.id)
				?.find((entry) => entry.unit === native)?.used;
			if (native === undefined || !measured) continue;
			const base = tallyCost(tally, native, tables);
			for (const unit of units) {
				// With no calls seen yet, assume one unit per unit: conservative.
				const ratio = base > 0 ? tallyCost(tally, unit, tables) / base : 1;
				totals.set(unit, (totals.get(unit) ?? 0) + measured * ratio);
			}
		}
		return units.map((unit) => ({
			unit,
			used: Math.round(totals.get(unit) ?? 0),
		}));
	}

	// --- the tick ------------------------------------------------------------
	async function probe(
		replica: EphemeralAssignmentReplica,
	): Promise<FleetBackendHealth> {
		let health: FleetBackendHealth = "unknown";
		for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
			if (attempt > 0) await sleep(PROBE_INTERVAL_MS);
			try {
				await replica.read(1);
				failingSince.delete(replica.id);
				return "reachable";
			} catch (error) {
				health = classifyCacheFailure(
					error instanceof Error ? error : undefined,
				);
				if (!failingSince.has(replica.id)) failingSince.set(replica.id, now());
			}
		}
		return health;
	}

	function report(tick: CacheFleetTick, route?: FleetRoute): CacheFleetTick {
		const percent: Record<string, number> = {};
		const cost: Record<string, number> = {};
		for (const candidate of route?.candidates ?? []) {
			if (candidate.projectedFraction !== undefined)
				percent[candidate.backend] = Math.round(
					Math.min(candidate.projectedFraction, 100) * 100,
				);
			if (candidate.projectedCostMicros !== undefined)
				cost[candidate.backend] = candidate.projectedCostMicros;
		}
		log({
			event: "hobo_ci_cache_fleet_decision",
			action: tick.action,
			epoch: tick.epoch,
			active: tick.active ?? "",
			target: tick.target ?? "",
			reasons: [...tick.reasons],
			members: [...members],
			eligible: (route?.candidates ?? [])
				.filter((candidate) => candidate.eligible)
				.map((candidate) => candidate.backend),
			projectedPercent: percent,
			projectedCostMicros: cost,
		});
		return tick;
	}

	async function schedule(epoch: number, waitMs: number) {
		try {
			await options.scheduleActivation?.(
				Math.max(1, Math.ceil(waitMs / 1000)),
				epoch,
			);
		} catch {
			log({ event: "hobo_ci_cache_fleet_activation_unscheduled", epoch });
		}
	}

	async function seal(
		current: FleetAssignment,
		target: string,
		reason: string,
		keepActive: boolean,
	): Promise<FleetAssignment | undefined> {
		const outcome = await proposeAssignment(register, {
			expectedEpoch: current.epoch,
			value: {
				active: keepActive ? current.active : undefined,
				sealed: true,
				target,
				reason,
				lossWindowMs: undefined,
			},
			decidedBy,
			nowMs: now(),
		});
		cached = undefined;
		if (outcome.status !== "decided") return undefined;
		await schedule(outcome.assignment.epoch, sealWaitMs);
		return outcome.assignment;
	}

	async function tick(): Promise<CacheFleetTick> {
		await flushUsage(true);
		if (single)
			return {
				action: "single",
				epoch: 0,
				active: single.binding.id,
				target: undefined,
				reasons: ["one-member"],
			};
		const at = now();
		const replies = await readAssignmentReplies(register);
		let resolution = resolveAssignment(members, replies);
		if (
			resolution.status === "undecided" ||
			(resolution.status === "current" && resolution.behind.length > 0)
		)
			resolution = await completeAssignment(register);
		await rejoinAssignmentReplicas(register, replies).catch(() => []);
		await Promise.all(
			replicas.map((replica) => replica.refresh().catch(() => false)),
		);
		if (
			resolution.status === "no-majority" ||
			resolution.status === "undecided"
		)
			return report({
				action: resolution.status,
				epoch: 0,
				active: undefined,
				target: undefined,
				reasons: [`${resolution.status}`],
			});
		if (resolution.status === "empty") {
			const first = members[0] ?? "memory";
			await bootstrapAssignment(register, first);
			cached = undefined;
			return report({
				action: "bootstrap",
				epoch: 1,
				active: first,
				target: undefined,
				reasons: ["empty-register"],
			});
		}
		const current = resolution.assignment;

		// Health and spend of every member.
		const observations: FleetRoutingObservation[] = [];
		const spends = new Map<string, readonly FleetUsageMeasurement[]>();
		for (const replica of replicas) {
			const reply = replies.find((entry) => entry.replica === replica.id);
			let health: FleetBackendHealth =
				reply && "rows" in reply ? "reachable" : (reply?.failure ?? "unknown");
			// The member that matters most gets more than one chance.
			if (
				health !== "reachable" &&
				(replica.id === current.active || replica.id === current.target)
			)
				health = await probe(replica);
			const backend = byId.get(replica.id);
			const usage =
				health === "reachable" && backend
					? await spent(backend, at)
					: undefined;
			if (usage) spends.set(replica.id, usage);
			const since = failingSince.get(replica.id);
			observations.push({
				backend: replica.id,
				health,
				failingForMs:
					health === "reachable" ? 0 : Math.max(0, now() - (since ?? now())),
				usage: usage ?? [],
			});
		}

		if (current.sealed) {
			const target = current.target;
			const waited = at - current.decidedAtMs;
			const targetSeen = observations.find((entry) => entry.backend === target);
			if (target === undefined)
				return report({
					action: "undecided",
					epoch: current.epoch,
					active: current.active,
					target,
					reasons: ["sealed-without-target"],
				});
			if (targetSeen?.health !== "reachable") {
				// The target went away while sealed: choose again, as a failover from it.
				const route = routeFleetByBudget({
					assignment: {
						...current,
						active: target,
						sealed: false,
						target: undefined,
					},
					members,
					observations: observations.map((entry) =>
						entry.backend === target
							? { ...entry, failingForMs: Number.MAX_SAFE_INTEGER }
							: entry,
					),
					workload: await workload(spends),
					offers: [...options.offers.offers.values()],
					marks: options.offers.marks,
					period: billingPeriod(at),
					nowMs: at,
				});
				if (route.action === "failover" && route.target !== undefined) {
					const resealed = await seal(
						current,
						route.target,
						`failover:${targetSeen?.health ?? "unknown"}`,
						false,
					);
					return report(
						{
							action: "reseal",
							epoch: resealed?.epoch ?? current.epoch,
							active: undefined,
							target: route.target,
							reasons: [`target-${targetSeen?.health ?? "unknown"}`],
						},
						route,
					);
				}
				return report(
					{
						action: "sealed-waiting",
						epoch: current.epoch,
						active: current.active,
						target,
						reasons: [
							`target-${targetSeen?.health ?? "unknown"}`,
							...route.reasons,
						],
					},
					route,
				);
			}
			if (waited < sealWaitMs) {
				await schedule(current.epoch, sealWaitMs - waited);
				return report({
					action: "sealed-waiting",
					epoch: current.epoch,
					active: current.active,
					target,
					reasons: ["seal-wait-not-over"],
				});
			}
			const outcome = await proposeAssignment(register, {
				expectedEpoch: current.epoch,
				value: {
					active: target,
					sealed: false,
					target: undefined,
					reason: "activate",
					lossWindowMs: undefined,
				},
				decidedBy,
				nowMs: now(),
			});
			cached = undefined;
			return report({
				action: "activate",
				epoch:
					outcome.status === "decided"
						? outcome.assignment.epoch
						: current.epoch,
				active: outcome.status === "decided" ? target : current.active,
				target,
				reasons: [`proposal-${outcome.status}`],
			});
		}

		const route = routeFleetByBudget({
			assignment: current,
			members,
			observations,
			workload: await workload(spends),
			offers: [...options.offers.offers.values()],
			marks: options.offers.marks,
			period: billingPeriod(at),
			nowMs: at,
		});
		if (
			(route.action === "switch" || route.action === "failover") &&
			route.target !== undefined
		) {
			const failover = route.action === "failover";
			const activeHealth =
				observations.find((entry) => entry.backend === current.active)
					?.health ?? "unknown";
			const sealed = await seal(
				current,
				route.target,
				failover
					? `failover:${activeHealth}`
					: `switch:${reasonToken(route.reasons[0] ?? "budget")}`,
				!failover,
			);
			return report(
				{
					action: route.action,
					epoch: sealed?.epoch ?? current.epoch,
					active: sealed ? sealed.active : current.active,
					target: route.target,
					reasons: sealed
						? route.reasons
						: [...route.reasons, "seal-not-decided"],
				},
				route,
			);
		}
		return report(
			{
				action: route.action,
				epoch: current.epoch,
				active: current.active,
				target: undefined,
				reasons: route.reasons,
			},
			route,
		);
	}

	return Object.freeze({
		state,
		members,
		activeId: () =>
			single
				? single.binding.id
				: cached?.view.kind === "active"
					? cached.view.id
					: undefined,
		tick,
		flushUsage,
		async close() {
			await Promise.all(
				backends.map((backend) => backend.close().catch(() => undefined)),
			);
		},
	});
}
