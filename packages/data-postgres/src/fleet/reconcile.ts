/**
 * One tick of the fleet: look, copy, decide, act.
 *
 * `reconcileFleet` is the only thing that changes who the writer is. A host
 * calls it on a schedule. Every tick does the same six things in order:
 *
 * 1. Settle the assignment: complete an interrupted entry, repair short logs,
 *    write the first entry of an empty fleet, finish or undo a move that an
 *    earlier tick sealed.
 * 2. Probe every backend. A failing writer is probed again until it has been
 *    failing for the failover threshold, so one tick can tell a blip from an
 *    outage without remembering anything between ticks.
 * 3. Copy the writer to every reachable standby.
 * 4. Measure: standby lag from each watermark, usage from each counter.
 * 5. Ask the policy.
 * 6. Carry out a switch or a failover through the assignment register.
 *
 * It reads no clock and opens no connection of its own: `now`, `sleep` and the
 * executors are the host's. It is safe to run two at once. Every change is a
 * compare-and-set on the assignment epoch, so the second one loses and stops.
 */
import {
	type AssignmentProposalOutcome,
	type AssignmentRegister,
	bootstrapAssignment,
	completeAssignment,
	type FleetAssignmentValue,
	type PostgresFleetAssignment,
	proposeAssignment,
	readCurrentAssignment,
	sqlAssignmentRegister,
} from "./assignment.js";
import { ensureFleetControlTables } from "./control.js";
import type { FleetLayout } from "./layout.js";
import {
	decideFleet,
	type FleetBackendHealth,
	type FleetBudgetCheck,
	type FleetPolicy,
	type FleetUsageMeasurement,
	type PostgresFleetDecision,
	type PostgresFleetFinancialModel,
	type PostgresFleetObservation,
} from "./policy.js";
import {
	type ReplicationLimits,
	type ReplicationRefusal,
	readWatermark,
	replicateSnapshot,
	standbyLagMs,
} from "./replication.js";
import {
	classifyFleetFailure,
	type FleetBackend,
	type FleetFailureClass,
} from "./sql.js";
import {
	billingPeriod,
	measureStorageBytes,
	readUsage,
	type UsageMeter,
} from "./usage.js";

export type FleetReplicationResult = {
	readonly source: string;
	readonly target: string;
	readonly epoch: number;
	readonly status: "replicated" | "refused" | "failed";
	readonly refusal: ReplicationRefusal | undefined;
	readonly failure: FleetFailureClass | undefined;
	readonly rows: number | undefined;
	/** Row text rewritten; 0 when nothing had changed. */
	readonly bytes: number | undefined;
	readonly durationMs: number;
};

export const FLEET_TRANSITION_STEPS = [
	"bootstrap",
	"seal",
	"activate",
	"unseal",
	"failover",
] as const;

export type FleetTransitionStep = (typeof FLEET_TRANSITION_STEPS)[number];

export type FleetTransition = {
	readonly step: FleetTransitionStep;
	/** `decided` is the only status that changed the assignment. */
	readonly status: AssignmentProposalOutcome["status"];
	readonly epoch: number | undefined;
	readonly active: string | undefined;
	readonly target: string | undefined;
	readonly reason: string;
};

/** What a tick reports as it goes. Ids, numbers and fixed tokens only. */
export type FleetEvent =
	| {
			readonly kind: "replication";
			readonly replication: FleetReplicationResult;
	  }
	| { readonly kind: "decision"; readonly decision: PostgresFleetDecision }
	| { readonly kind: "transition"; readonly transition: FleetTransition }
	| {
			readonly kind: "unsettled";
			readonly status: "undecided" | "no-majority" | "empty";
			readonly silent: readonly string[];
	  };

export type FleetReconcileOptions = {
	/** In configured order. The first is the writer of an empty fleet. */
	readonly backends: readonly FleetBackend[];
	readonly layout: FleetLayout;
	readonly models: readonly PostgresFleetFinancialModel[];
	readonly policy: FleetPolicy;
	/** How long an application instance may trust an assignment it confirmed. */
	readonly leaseMs: number;
	/** Added to a lease when waiting for writers to stop after sealing. */
	readonly graceMs: number;
	/**
	 * Create the application's tables on a backend. Called for both sides, and
	 * only when a copy found the standby's schema different from the writer's.
	 */
	readonly ensureSchema: (backend: FleetBackend) => Promise<void>;
	readonly checkBudget: FleetBudgetCheck;
	readonly meter: UsageMeter | undefined;
	readonly limits: Partial<ReplicationLimits> | undefined;
	/** Identifies this process in the entries it writes. */
	readonly decidedBy: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly log: (event: FleetEvent) => void;
};

export type FleetReconcileReport = {
	/** `settled`: the tick ran on a decided assignment. Otherwise it stopped. */
	readonly status: "settled" | "undecided" | "no-majority";
	/** The current assignment when the tick ended, if it is known. */
	readonly assignment: PostgresFleetAssignment | undefined;
	readonly decision: PostgresFleetDecision | undefined;
	readonly observations: readonly PostgresFleetObservation[];
	readonly replications: readonly FleetReplicationResult[];
	readonly transitions: readonly FleetTransition[];
};

type Probe = {
	readonly health: FleetBackendHealth;
	readonly latencyMs: number | undefined;
	readonly failingForMs: number;
};

async function probe(backend: FleetBackend, now: () => number): Promise<Probe> {
	const started = now();
	try {
		await backend.executor.query("SELECT 1::text AS ok");
		return { health: "reachable", latencyMs: now() - started, failingForMs: 0 };
	} catch (error) {
		return {
			health: classifyFleetFailure(error instanceof Error ? error : undefined),
			latencyMs: undefined,
			failingForMs: 0,
		};
	}
}

/**
 * Probe the writer; while it fails, keep probing until it has failed for the
 * whole threshold. One success ends the wait and counts as healthy.
 */
async function probeWriter(
	backend: FleetBackend,
	options: FleetReconcileOptions,
): Promise<Probe> {
	const first = options.now();
	let last = await probe(backend, options.now);
	const interval = Math.max(
		1,
		Math.min(5000, Math.ceil(options.policy.failoverAfterMs / 4)),
	);
	while (
		last.health !== "reachable" &&
		options.now() - first < options.policy.failoverAfterMs
	) {
		await options.sleep(
			Math.min(
				interval,
				options.policy.failoverAfterMs - (options.now() - first),
			),
		);
		last = await probe(backend, options.now);
	}
	return last.health === "reachable"
		? last
		: { ...last, failingForMs: options.now() - first };
}

function transition(
	step: FleetTransitionStep,
	value: FleetAssignmentValue,
	outcome: AssignmentProposalOutcome,
): FleetTransition {
	return {
		step,
		status: outcome.status,
		epoch:
			outcome.status === "decided" || outcome.status === "undecided"
				? outcome.assignment.epoch
				: undefined,
		active: value.active,
		target: value.target,
		reason: value.reason,
	};
}

/** Run one tick. See the module comment for the order of work. */
export async function reconcileFleet(
	options: FleetReconcileOptions,
): Promise<FleetReconcileReport> {
	const { backends, layout, now } = options;
	const replications: FleetReplicationResult[] = [];
	const transitions: FleetTransition[] = [];
	const byId = (id: string | undefined) =>
		backends.find((backend) => backend.id === id);
	const propose = async (
		register: AssignmentRegister,
		step: FleetTransitionStep,
		expectedEpoch: number,
		value: FleetAssignmentValue,
	): Promise<AssignmentProposalOutcome> => {
		const outcome = await proposeAssignment(register, {
			expectedEpoch,
			value,
			decidedBy: options.decidedBy,
			nowMs: now(),
		});
		const record = transition(step, value, outcome);
		transitions.push(record);
		options.log({ kind: "transition", transition: record });
		return outcome;
	};
	const copy = async (
		assignment: PostgresFleetAssignment,
		source: FleetBackend,
		target: FleetBackend,
	): Promise<FleetReplicationResult> => {
		const started = now();
		const base = {
			source: source.id,
			target: target.id,
			epoch: assignment.epoch,
		};
		let result: FleetReplicationResult;
		try {
			let outcome = await replicateSnapshot({
				source,
				target,
				layout,
				assignment,
				limits: options.limits,
			});
			if (
				outcome.status === "refused" &&
				outcome.refusal === "schema-mismatch"
			) {
				// Either side may be the one that lacks a table: a writer creates
				// some of its tables only when it first needs them.
				await options.ensureSchema(target);
				await options.ensureSchema(source);
				outcome = await replicateSnapshot({
					source,
					target,
					layout,
					assignment,
					limits: options.limits,
				});
			}
			result =
				outcome.status === "replicated"
					? {
							...base,
							status: "replicated",
							refusal: undefined,
							failure: undefined,
							rows: outcome.watermark.rowCount,
							bytes: outcome.watermark.byteCount,
							durationMs: now() - started,
						}
					: {
							...base,
							status: "refused",
							refusal: outcome.refusal,
							failure: undefined,
							rows: undefined,
							bytes: undefined,
							durationMs: now() - started,
						};
		} catch (error) {
			result = {
				...base,
				status: "failed",
				refusal: undefined,
				failure: classifyFleetFailure(
					error instanceof Error ? error : undefined,
				),
				rows: undefined,
				bytes: undefined,
				durationMs: now() - started,
			};
		}
		replications.push(result);
		options.log({ kind: "replication", replication: result });
		return result;
	};
	const stop = (
		status: "undecided" | "no-majority",
		silent: readonly string[],
	): FleetReconcileReport => {
		options.log({ kind: "unsettled", status, silent });
		return {
			status,
			assignment: undefined,
			decision: undefined,
			observations: [],
			replications,
			transitions,
		};
	};

	// 1. Settle the assignment.
	await Promise.all(
		backends.map(async (backend) => {
			try {
				await ensureFleetControlTables(backend, layout);
			} catch {
				// An unreachable backend is found by the probe below.
			}
		}),
	);
	const register = sqlAssignmentRegister(backends, layout);
	let resolution = await completeAssignment(register);
	if (resolution.status === "empty") {
		const first = backends[0];
		if (first === undefined) return stop("no-majority", []);
		const value = {
			active: first.id,
			sealed: false,
			target: undefined,
			reason: "bootstrap",
			lossWindowMs: undefined,
		};
		const outcome = await bootstrapAssignment(register, first.id);
		const record = transition("bootstrap", value, outcome);
		transitions.push(record);
		options.log({ kind: "transition", transition: record });
		resolution = await readCurrentAssignment(register);
	}
	if (resolution.status !== "current")
		return stop(
			resolution.status === "no-majority" ? "no-majority" : "undecided",
			resolution.silent,
		);
	let assignment = resolution.assignment;

	/**
	 * Finish a sealed move: wait until no instance can still hold a lease from
	 * before the seal, copy once more, and hand over.
	 *
	 * If the copy cannot succeed (the target is unreachable, its schema differs,
	 * the database is oversized) the fleet is unsealed on the old writer. If the
	 * copy was only beaten by another reconciler doing the same thing, nothing
	 * is undone: that reconciler finishes, or the next tick does.
	 */
	const finishSwitch = async (
		sealed: PostgresFleetAssignment,
	): Promise<PostgresFleetAssignment | undefined> => {
		await options.sleep(options.leaseMs + options.graceMs);
		// The target takes a copy only when its own log holds the sealed entry;
		// it may have missed it while another copy held its lock.
		await completeAssignment(register);
		const source = byId(sealed.active);
		const target = byId(sealed.target);
		let copied =
			source !== undefined && target !== undefined
				? await copy(sealed, source, target)
				: undefined;
		for (
			let attempt = 0;
			attempt < 5 &&
			copied?.refusal === "busy" &&
			source !== undefined &&
			target !== undefined;
			attempt += 1
		) {
			await options.sleep(2000);
			copied = await copy(sealed, source, target);
		}
		// Still busy, or the target is already the writer: another reconciler
		// is finishing or has finished this switch. Leave it alone.
		if (copied?.refusal === "busy" || copied?.refusal === "target-is-writer")
			return undefined;
		const outcome =
			copied?.status === "replicated"
				? await propose(register, "activate", sealed.epoch, {
						active: sealed.target,
						sealed: false,
						target: undefined,
						reason: "switch-complete",
						lossWindowMs: undefined,
					})
				: await propose(register, "unseal", sealed.epoch, {
						active: sealed.active,
						sealed: false,
						target: undefined,
						reason: `switch-aborted:${copied?.refusal ?? copied?.failure ?? "backend-missing"}`,
						lossWindowMs: undefined,
					});
		return outcome.status === "decided" ? outcome.assignment : undefined;
	};

	if (assignment.sealed) {
		const next = await finishSwitch(assignment);
		if (next === undefined) return stop("undecided", []);
		assignment = next;
	}

	// 2. Probe.
	const writer = byId(assignment.active);
	const probes = new Map<string, Probe>(
		await Promise.all(
			backends.map(
				async (backend) =>
					[
						backend.id,
						backend === writer
							? await probeWriter(backend, options)
							: await probe(backend, now),
					] as const,
			),
		),
	);
	const healthy = (backend: FleetBackend) =>
		probes.get(backend.id)?.health === "reachable";

	// 3. Copy the writer to every reachable standby.
	const copied = new Map<string, FleetReplicationResult>();
	if (writer !== undefined && healthy(writer))
		for (const backend of backends) {
			if (backend === writer || !healthy(backend)) continue;
			copied.set(backend.id, await copy(assignment, writer, backend));
		}

	// 4. Measure.
	const period = billingPeriod(now());
	const observations = await Promise.all(
		backends.map(async (backend): Promise<PostgresFleetObservation> => {
			const seen = probes.get(backend.id);
			const usage: FleetUsageMeasurement[] = [];
			let lagMs: number | undefined;
			let everCopied = false;
			if (healthy(backend))
				try {
					const counters = await readUsage(backend, layout, period.id);
					usage.push({
						unit: "operations",
						used:
							(counters.find((entry) => entry.unit === "operations")?.used ??
								0) + (options.meter?.pending(backend.id) ?? 0),
					});
					usage.push({
						unit: "storage-bytes",
						used: await measureStorageBytes(backend),
					});
					if (backend !== writer) {
						const watermark = await readWatermark(backend, layout);
						everCopied = watermark !== undefined;
						lagMs =
							watermark === undefined
								? undefined
								: standbyLagMs(watermark, now());
					}
				} catch {
					usage.length = 0;
				}
			const result = copied.get(backend.id);
			return {
				backend: backend.id,
				health: seen?.health ?? "unknown",
				probeLatencyMs: seen?.latencyMs,
				failingForMs: seen?.failingForMs ?? 0,
				// With the writer down there is nothing to compare with; a standby
				// that was copied before had the writer's schema then.
				schemaCurrent:
					backend === writer ||
					(result === undefined
						? everCopied
						: result.refusal !== "schema-mismatch"),
				standbyLagMs: backend === writer ? 0 : lagMs,
				usage,
			};
		}),
	);

	// 5. Decide.
	const decision = decideFleet({
		assignment,
		observations,
		models: options.models,
		policy: options.policy,
		period,
		checkBudget: options.checkBudget,
		nowMs: now(),
	});
	options.log({ kind: "decision", decision });

	// 6. Act.
	if (decision.action === "switch" && decision.target !== undefined) {
		const outcome = await propose(register, "seal", assignment.epoch, {
			active: assignment.active,
			sealed: true,
			target: decision.target,
			reason: `switch:${decision.reasons[0] ?? "policy"}`.slice(0, 200),
			lossWindowMs: undefined,
		});
		if (outcome.status === "decided")
			assignment = (await finishSwitch(outcome.assignment)) ?? assignment;
	}
	if (decision.action === "failover" && decision.target !== undefined) {
		const outcome = await propose(register, "failover", assignment.epoch, {
			active: decision.target,
			sealed: false,
			target: undefined,
			reason: `failover:${decision.reasons[0] ?? "policy"}`.slice(0, 200),
			lossWindowMs: decision.lossWindowMs,
		});
		if (outcome.status === "decided") assignment = outcome.assignment;
	}
	await options.meter?.flush(backends.filter(healthy), layout, now());
	const final = await readCurrentAssignment(register);
	return {
		status: "settled",
		assignment: final.status === "current" ? final.assignment : undefined,
		decision,
		observations,
		replications,
		transitions,
	};
}
