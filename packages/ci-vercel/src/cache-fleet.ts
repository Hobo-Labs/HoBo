/**
 * The relay's cache fleet (ADR-0179 phase 4c; HoBo Fleet design §8.4): every
 * bound cache backend is a member, exactly one is active, and every port call
 * goes to it.
 *
 * - **A local-mode fleet.** `createLocalFleet` (`@hobo/fleet/membership`)
 *   declares one `BACKEND` member per bound cache, in configured order, under
 *   the owner's `AUTO_OWNER` approval, in a `ONE_ACTIVE` fleet whose policy
 *   carries `failover_after_ms` from the marks and `membership_epochs` from
 *   `HOBO_CI_CACHE_OFFERS_JSON` (false until the last cutover step). Nothing
 *   else is needed: no authority, no bus, no network.
 * - **Which one is active** is read by `createOneActiveFleet`
 *   (`@hobo/fleet/assignment`) from the fleet's assignment register, whose
 *   log is kept on every member in one key (`hobo-ci:<env>:fleet:assignment`)
 *   and decided by majority. A resolution is cached in memory for
 *   `assignmentTtlMs` (a minute), measured from when the read *started*. With
 *   a single member there is no register: it is active, and nothing is read.
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
 *   tables, and asks `routeFleetByBudget` what to do: it is the loop's
 *   `chooseAction`. The tick is reported as a `OneActiveTick`, and the
 *   decision is logged as one structured line: names, ids and numbers, never
 *   a value.
 */
import { create } from "@bufbuild/protobuf";
import {
	billingPeriod,
	type FleetRoute,
	type FleetUsageMeasurement,
	type FleetUsageUnit,
	parseFleetUsageUnit,
	routeFleetByBudget,
} from "@hobo/backend-routing";
import {
	EPHEMERAL_STATE_COMMAND_COST,
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralKey,
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	parseTenantId,
} from "@hobo/core";
import {
	ApprovalMode,
	type AssignmentEntry,
	CoordinationMode,
	type EphemeralAssignmentReplica,
	type FleetLog,
	FleetPolicySchema,
	type FleetRecord,
	Health,
	MemberKind,
	type MemberRecord,
	type NamedObservation,
	type Observation,
	ObservationSchema,
	type OneActiveAction,
	type OneActiveDeps,
	type OneActiveTick,
	parseFleetId,
	parseMemberName,
	type RegistryView,
	UsageMeasurementSchema,
} from "@hobo/fleet";
import {
	createOneActiveFleet,
	ephemeralAssignmentRegister,
	ephemeralAssignmentReplica,
} from "@hobo/fleet/assignment";
import { createLocalFleet } from "@hobo/fleet/membership";
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
export function classifyCacheFailure(error: Error | undefined): Health {
	if (error === undefined) return Health.UNKNOWN;
	const text = `${"code" in error ? String(error.code) : ""} ${error.message}`;
	if (
		/quota|limit (?:has been )?(?:reached|exceeded)|max (?:daily|monthly) request|exceeded/iu.test(
			text,
		)
	)
		return Health.QUOTA_EXHAUSTED;
	if (/unauthori[sz]ed|forbidden|WRONGPASS|NOAUTH|\b40[13]\b|auth/iu.test(text))
		return Health.AUTH;
	return Health.UNREACHABLE;
}

export type CacheFleetOptions = Readonly<{
	backends: readonly OpenedCacheBackend[];
	/** Cache namespace: production, preview and local never share keys. */
	environment: string;
	/** Offers, marks and `membershipEpochs` (the fleet policy's `membership_epochs`). */
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

/** The local-mode fleet the cache backends are members of (`createLocalFleet`). */
export type CacheLocalFleet = Readonly<{
	registry: RegistryView;
	fleet: FleetRecord;
	members: readonly MemberRecord[];
}>;

export type CacheFleet = Readonly<{
	/** The port the relay uses: every call goes to the active backend. */
	state: EphemeralStatePort;
	members: readonly CacheBackendId[];
	/** The active backend as last resolved, without a read. */
	activeId(): string | undefined;
	/** The repair tick: usage, register upkeep, the budget decision. */
	tick(): Promise<OneActiveTick>;
	/** Write usage now (a tick does) or when the interval has passed. */
	flushUsage(force?: boolean): Promise<void>;
	/** The fleet and member records, declared once per instance on first use. */
	localFleet(): Promise<CacheLocalFleet>;
	close(): Promise<void>;
}>;

/** The tenant and fleet of the relay's cache fleet: one per process, never shared. */
const CACHE_TENANT = "relay"; // public-contract: the local-mode tenant named in the cache fleet's records
const CACHE_FLEET_ID = "cache"; // public-contract: the local-mode fleet id named in the cache fleet's records

/**
 * The routing input's per-member health strings. `routeFleetByBudget` reads
 * `NamedObservation`s once L21 has merged and the flat fields before; the
 * observations it is given carry both, so either reads the same values.
 */
type RoutingHealth =
	| "reachable"
	| "unreachable"
	| "quota-exhausted"
	| "auth"
	| "unknown";
// domain-view: the flat per-member fields today's routeFleetByBudget reads, beside the NamedObservation the frozen one reads (§7.3).
type RoutedObservation = NamedObservation &
	Readonly<{
		backend: string;
		health: RoutingHealth;
		failingForMs: number;
		usage: readonly FleetUsageMeasurement[];
	}>;

/** `QUOTA_EXHAUSTED` → `quota-exhausted`: the failure-class strings of the log lines. */
function healthToken(health: Health): RoutingHealth {
	switch (health) {
		case Health.REACHABLE:
			return "reachable";
		case Health.UNREACHABLE:
			return "unreachable";
		case Health.QUOTA_EXHAUSTED:
			return "quota-exhausted";
		case Health.AUTH:
			return "auth";
		default:
			return "unknown";
	}
}

/** Today's reason for an unavailable fleet, from the loop's refusal. */
function refusalReason(reason: string | undefined): string {
	if (reason === "no-active-member") return "no-active-backend";
	return reason ?? "unavailable";
}

type OneActiveFleet = ReturnType<typeof createOneActiveFleet>;
type ChooseInput = Parameters<OneActiveDeps["chooseAction"]>[0];

/** Actions after which the last answer may no longer hold. */
const MOVED: ReadonlySet<OneActiveTick["action"]> = new Set([
	"bootstrap",
	"activate",
	"reseal",
	"switch",
	"failover",
	"membership",
]);

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
	const byName = new Map<string, OpenedCacheBackend>(
		backends.map((backend) => [backend.binding.id, backend]),
	);
	const single = backends.length === 1 ? backends[0] : undefined;
	const logKey = `hobo-ci:${options.environment}:fleet:assignment`;
	const failingSince = new Map<string, number>();

	// --- the register, noting what this tick's reads saw ----------------------
	/** Each replica's last read in this tick: reachable, or its failure class. */
	const seen = new Map<string, Health>();
	/** The newest entry a read in this tick returned: whose health matters most. */
	let newest: AssignmentEntry | undefined;
	const replicas: EphemeralAssignmentReplica[] = backends.map((backend) => {
		const replica = ephemeralAssignmentReplica(
			backend.state,
			parseMemberName(backend.binding.id),
			{ key: logKey },
		);
		return Object.freeze({
			...replica,
			async read(limit?: number): Promise<readonly AssignmentEntry[]> {
				try {
					const rows = await replica.read(limit);
					seen.set(replica.id, Health.REACHABLE);
					const last = rows.at(-1);
					if (last !== undefined && last.epoch > (newest?.epoch ?? 0))
						newest = last;
					return rows;
				} catch (error) {
					seen.set(
						replica.id,
						classifyCacheFailure(error instanceof Error ? error : undefined),
					);
					throw error;
				}
			},
		});
	});
	const register = ephemeralAssignmentRegister(replicas, {
		classify: classifyCacheFailure,
	});

	// --- the local-mode fleet --------------------------------------------------
	const fleetLog: FleetLog = (event, fields) => log({ event, ...fields });
	let declared: Promise<CacheLocalFleet> | undefined;
	function localFleet(): Promise<CacheLocalFleet> {
		declared ??= createLocalFleet({
			tenant: parseTenantId(CACHE_TENANT),
			fleetId: parseFleetId(CACHE_FLEET_ID),
			coordination: CoordinationMode.ONE_ACTIVE,
			policy: create(FleetPolicySchema, {
				approval: ApprovalMode.AUTO_OWNER,
				allowedKinds: [MemberKind.BACKEND],
				failoverAfterMs: options.offers.marks.failoverAfterMs,
				membershipEpochs: options.offers.membershipEpochs,
			}),
			owner: { kind: "service", id: "hosted-relay" },
			members: backends.map((backend) => ({
				kind: MemberKind.BACKEND,
				name: parseMemberName(backend.binding.id),
				displayName: backend.binding.kind,
				credentialRef: backend.binding.names
					.map((name) => `env://${name}`)
					.join(","),
				endpointDigest: "",
			})),
			now,
			log: fleetLog,
		}).catch((error: Error) => {
			declared = undefined;
			throw error;
		});
		return declared;
	}

	// --- usage, per member, in the units it bills ----------------------------
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

	// --- observing a member (the loop's `observe`) -------------------------------
	async function probe(name: string): Promise<Health> {
		const replica = replicas.find((each) => each.id === name);
		let health: Health = Health.UNKNOWN;
		if (replica === undefined) return health;
		for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
			if (attempt > 0) await sleep(PROBE_INTERVAL_MS);
			try {
				await replica.read(1);
				failingSince.delete(name);
				return Health.REACHABLE;
			} catch (error) {
				health = classifyCacheFailure(
					error instanceof Error ? error : undefined,
				);
				if (!failingSince.has(name)) failingSince.set(name, now());
			}
		}
		return health;
	}

	/** A member's health from this tick's register reads, and its spend when reachable. */
	async function observe(record: MemberRecord): Promise<Observation> {
		const name =
			record.memberships.find(
				(membership) => membership.fleet === CACHE_FLEET_ID,
			)?.name ?? "";
		let health = seen.get(name) ?? Health.UNKNOWN;
		// The member that matters most gets more than one chance.
		if (
			health !== Health.REACHABLE &&
			(name === newest?.active || name === newest?.target)
		)
			health = await probe(name);
		const backend = byName.get(name);
		const usage =
			health === Health.REACHABLE && backend !== undefined
				? await spent(backend, now())
				: undefined;
		const since = failingSince.get(name);
		return create(ObservationSchema, {
			memberId: record.memberId,
			observerId: record.memberId,
			fleets: [CACHE_FLEET_ID],
			health,
			failingForMs:
				health === Health.REACHABLE ? 0 : Math.max(0, now() - (since ?? now())),
			usage: (usage ?? []).map((entry) =>
				create(UsageMeasurementSchema, entry),
			),
		});
	}

	// --- choosing (the loop's `chooseAction`): routeFleetByBudget --------------
	let lastRoute: FleetRoute | undefined;
	async function chooseAction(input: ChooseInput): Promise<OneActiveAction> {
		const spends = new Map<string, readonly FleetUsageMeasurement[]>();
		const observations: RoutedObservation[] = input.observations.map(
			(entry) => {
				const usage = entry.observation.usage.map(
					(measurement): FleetUsageMeasurement => ({
						unit: parseFleetUsageUnit(measurement.unit),
						used: measurement.used,
					}),
				);
				if (usage.length > 0) spends.set(entry.name, usage);
				return {
					name: entry.name,
					observation: entry.observation,
					backend: entry.name,
					health: healthToken(entry.observation.health),
					failingForMs: entry.observation.failingForMs,
					usage,
				};
			},
		);
		const route = routeFleetByBudget({
			assignment: input.assignment,
			members: input.members,
			observations,
			workload: await workload(spends),
			offers: [...options.offers.offers.values()],
			marks: options.offers.marks,
			period: billingPeriod(input.nowMs),
			nowMs: input.nowMs,
		});
		lastRoute = route;
		const target = input.members.find((name) => name === route.target);
		if (
			(route.action === "switch" || route.action === "failover") &&
			target !== undefined
		)
			return {
				action: route.action,
				target,
				lossWindowMs: undefined,
				reasons: route.reasons,
			};
		return {
			action: route.action === "hold" ? "hold" : "keep",
			reasons: route.reasons,
		};
	}

	// --- the one-active loop ------------------------------------------------------
	let loop: Promise<OneActiveFleet> | undefined;
	function oneActive(): Promise<OneActiveFleet> {
		loop ??= localFleet().then(({ registry, fleet }) =>
			createOneActiveFleet({
				fleet,
				registry,
				register,
				observe,
				chooseAction,
				async scheduleActivation(epoch, afterMs) {
					await options.scheduleActivation?.(
						Math.max(1, Math.ceil(afterMs / 1000)),
						epoch,
					);
				},
				decidedBy,
				sealWaitMs,
				viewTtlMs: ttlMs,
				refusedTtlMs: UNAVAILABLE_RETRY_MS,
				now,
				log: fleetLog,
			}),
		);
		return loop;
	}

	// --- which backend is active ---------------------------------------------
	let lastActive: string | undefined;
	async function active(): Promise<OpenedCacheBackend> {
		if (single) return single;
		const answer = await (await oneActive()).active();
		if (!answer.ok) {
			lastActive = undefined;
			const reason = answer.error.detail?.reason;
			throw new CacheFleetUnavailableError(
				refusalReason(reason === undefined ? undefined : String(reason)),
			);
		}
		const backend = byName.get(answer.value);
		if (!backend) throw new CacheFleetUnavailableError("unknown-backend");
		lastActive = answer.value;
		return backend;
	}

	// --- the routed port --------------------------------------------------------
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

	// --- the tick ------------------------------------------------------------
	/** The relay's decision line: names, ids and numbers, never a value. */
	function report(tick: OneActiveTick, route: FleetRoute | undefined): void {
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
	}

	async function tick(): Promise<OneActiveTick> {
		await flushUsage(true);
		const fleet = await oneActive();
		seen.clear();
		newest = undefined;
		lastRoute = undefined;
		const result = await fleet.tick();
		if (result.action === "single") return result;
		if (MOVED.has(result.action)) lastActive = undefined;
		report(result, result.route === undefined ? undefined : lastRoute);
		return result;
	}

	return Object.freeze({
		state,
		members,
		activeId: () => (single ? single.binding.id : lastActive),
		tick,
		flushUsage,
		localFleet,
		async close() {
			await Promise.all(
				backends.map((backend) => backend.close().catch(() => undefined)),
			);
		},
	});
}
