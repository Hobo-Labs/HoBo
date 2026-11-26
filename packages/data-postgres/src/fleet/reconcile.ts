import {
	decideFleet,
	type FleetBudgetCheck,
	type FleetDecision,
	type FleetFinancialModel,
	type FleetPolicy,
} from "@hobo/backend-routing";
import {
	type AssignmentEntry,
	type AssignmentProposalOutcome,
	type AssignmentRegister,
	type AssignmentValue,
	type FleetLogEvent,
	Health,
	type NamedObservation,
	type Observation,
	type OneActiveAction,
	type OneActiveTick,
	parseFleetId,
	parseMemberName,
} from "@hobo/fleet";
import {
	bootstrapAssignment,
	completeAssignment,
	createOneActiveFleet,
	proposeAssignment,
	readCurrentAssignment,
} from "@hobo/fleet/assignment";
import { sqlAssignmentRegister } from "./assignment.js";
import { ensureFleetControlTables } from "./control.js";
import type { FleetLayout } from "./layout.js";
import {
	memberNameIn,
	postgresFleetRegistry,
	postgresObservation,
	unknownObservation,
} from "./records.js";
import {
	type ReplicationLimits,
	type ReplicationRefusal,
	readWatermark,
	replicateSnapshot,
	standbyLagMs,
} from "./replication.js";
import { classifyFleetFailure, type PostgresBackend } from "./sql.js";
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
	readonly failure: Health | undefined;
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
	"membership",
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
	| { readonly kind: "decision"; readonly decision: FleetDecision }
	| { readonly kind: "transition"; readonly transition: FleetTransition }
	| { readonly kind: "tick"; readonly tick: OneActiveTick }
	| {
			readonly kind: "log";
			readonly event: FleetLogEvent;
			readonly fields: Readonly<Record<string, string | number | boolean>>;
	  }
	| {
			readonly kind: "unsettled";
			readonly status: "undecided" | "no-majority" | "empty";
			readonly silent: readonly string[];
	  };

/** Which side of a copy a backend is when its schema is prepared. */
export type FleetSchemaRole = "writer" | "standby";

export type FleetReconcileOptions = {
	/** In configured order. The first is the writer of an empty fleet. */
	readonly backends: readonly PostgresBackend[];
	/**
	 * Members that hold only the assignment register: never copied to, never
	 * a writer. A writer and one standby are two members, and losing either
	 * leaves no majority to decide a failover; a witness on a third failure
	 * domain makes the majority, for the cost of a few rows.
	 */
	readonly witnesses?: readonly PostgresBackend[];
	readonly layout: FleetLayout;
	readonly models: readonly FleetFinancialModel[];
	readonly policy: FleetPolicy;
	/** How long an application instance may trust an assignment it confirmed. */
	readonly leaseMs: number;
	/** Added to a lease when waiting for writers to stop after sealing. */
	readonly graceMs: number;
	/**
	 * Prepare the application's schema on a backend. Called for both sides of a
	 * copy, the standby first, and only when the copy found the standby's
	 * schema different from the writer's. `role` says which side the backend
	 * is under the assignment the tick resolved: a host may bring the writer
	 * forward the way its application does, and must prepare a standby without
	 * the application, which does not write there.
	 */
	readonly ensureSchema: (
		backend: PostgresBackend,
		role: FleetSchemaRole,
	) => Promise<void>;
	readonly checkBudget: FleetBudgetCheck;
	readonly meter: UsageMeter | undefined;
	readonly limits: Partial<ReplicationLimits> | undefined;
	/** Identifies this process in the entries it writes. */
	readonly decidedBy: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly log: (event: FleetEvent) => void;
	readonly fleet?: string;
	readonly membershipEpochs?: boolean;
};

export type FleetReconcileReport = {
	/** `settled`: the tick ran on a decided assignment. Otherwise it stopped. */
	readonly status: "settled" | "undecided" | "no-majority";
	/** The current assignment when the tick ended, if it is known. */
	readonly assignment: AssignmentEntry | undefined;
	readonly decision: FleetDecision | undefined;
	readonly tick: OneActiveTick | undefined;
	readonly observations: readonly NamedObservation[];
	readonly replications: readonly FleetReplicationResult[];
	readonly transitions: readonly FleetTransition[];
};

type Probe = {
	readonly health: Health;
	readonly latencyMs: number | undefined;
	readonly failingForMs: number;
};

async function probe(
	backend: PostgresBackend,
	now: () => number,
): Promise<Probe> {
	const started = now();
	try {
		await backend.executor.query("SELECT 1::text AS ok");
		return {
			health: Health.REACHABLE,
			latencyMs: now() - started,
			failingForMs: 0,
		};
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
	backend: PostgresBackend,
	options: FleetReconcileOptions,
): Promise<Probe> {
	const first = options.now();
	let last = await probe(backend, options.now);
	const interval = Math.max(
		1,
		Math.min(5000, Math.ceil(options.policy.failoverAfterMs / 4)),
	);
	while (
		last.health !== Health.REACHABLE &&
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
	return last.health === Health.REACHABLE
		? last
		: { ...last, failingForMs: options.now() - first };
}

function transition(
	step: FleetTransitionStep,
	value: AssignmentValue,
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

function actionOf(decision: FleetDecision): OneActiveAction {
	if (
		(decision.action === "switch" || decision.action === "failover") &&
		decision.target !== undefined
	)
		return {
			action: decision.action,
			target: parseMemberName(decision.target, "target"),
			lossWindowMs: decision.lossWindowMs,
			reasons: decision.reasons,
		};
	return {
		action: decision.action === "keep" ? "keep" : "hold",
		reasons: decision.reasons,
	};
}

const PROPOSAL_STATUSES = [
	"decided",
	"undecided",
	"stale",
	"unavailable",
	"refused",
] as const;

function proposalStatus(
	tick: OneActiveTick,
): AssignmentProposalOutcome["status"] {
	const reported = tick.reasons
		.find((reason) => reason.startsWith("proposal-"))
		?.slice("proposal-".length);
	return PROPOSAL_STATUSES.find((status) => status === reported) ?? "undecided";
}

/** Run one tick. See the module comment for the order of work. */
export async function reconcileFleet(
	options: FleetReconcileOptions,
): Promise<FleetReconcileReport> {
	const { backends, layout, now } = options;
	const fleetId = parseFleetId(options.fleet ?? "postgres");
	const replications: FleetReplicationResult[] = [];
	const transitions: FleetTransition[] = [];
	const byId = (id: string | undefined) =>
		backends.find((backend) => backend.id === id);
	const record = (entry: FleetTransition) => {
		transitions.push(entry);
		options.log({ kind: "transition", transition: entry });
	};
	const propose = async (
		register: AssignmentRegister,
		step: FleetTransitionStep,
		expectedEpoch: number,
		value: AssignmentValue,
	): Promise<AssignmentProposalOutcome> => {
		const outcome = await proposeAssignment(register, {
			expectedEpoch,
			value,
			decidedBy: options.decidedBy,
			nowMs: now(),
		});
		record(transition(step, value, outcome));
		return outcome;
	};
	const copy = async (
		assignment: AssignmentEntry,
		source: PostgresBackend,
		target: PostgresBackend,
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
				await options.ensureSchema(target, "standby");
				await options.ensureSchema(source, "writer");
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
		tick: OneActiveTick | undefined = undefined,
	): FleetReconcileReport => {
		options.log({ kind: "unsettled", status, silent });
		return {
			status,
			assignment: undefined,
			decision: undefined,
			tick,
			observations: [],
			replications,
			transitions,
		};
	};

	// 1. Settle the assignment.
	const members = [...backends, ...(options.witnesses ?? [])];
	await Promise.all(
		members.map(async (backend) => {
			try {
				await ensureFleetControlTables(backend, layout);
			} catch {
				// An unreachable backend is found by the probe below.
			}
		}),
	);
	const register = sqlAssignmentRegister(members, layout);
	let resolution = await completeAssignment(register);
	if (resolution.status === "empty") {
		const first = backends[0];
		if (first === undefined) return stop("no-majority", []);
		const active = parseMemberName(first.id, "backend");
		const value: AssignmentValue = {
			active,
			sealed: false,
			target: undefined,
			reason: "bootstrap",
			lossWindowMs: undefined,
		};
		const outcome = await bootstrapAssignment(register, active);
		record(transition("bootstrap", value, outcome));
		resolution = await readCurrentAssignment(register);
	}
	if (resolution.status !== "current")
		return stop(
			resolution.status === "no-majority" ? "no-majority" : "undecided",
			resolution.silent,
		);
	let assignment = resolution.assignment;

	const finishSwitch = async (
		sealed: AssignmentEntry,
	): Promise<AssignmentEntry | undefined> => {
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
		const failure =
			copied?.failure === undefined
				? undefined
				: (Health[copied.failure] ?? "unknown")
						.toLowerCase()
						.replaceAll("_", "-");
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
						reason: `switch-aborted:${copied?.refusal ?? failure ?? "backend-missing"}`,
						lossWindowMs: undefined,
					});
		return outcome.status === "decided" ? outcome.assignment : undefined;
	};

	const finishFailover = async (
		sealed: AssignmentEntry,
		lossWindowMs: number | undefined,
	): Promise<AssignmentEntry | undefined> => {
		const target = byId(sealed.target);
		if (target === undefined) return undefined;
		if ((await probe(target, now)).health !== Health.REACHABLE)
			return undefined;
		let loss = lossWindowMs;
		if (loss === undefined)
			try {
				const watermark = await readWatermark(target, layout);
				loss =
					watermark === undefined ? undefined : standbyLagMs(watermark, now());
			} catch {
				loss = undefined;
			}
		const outcome = await propose(register, "activate", sealed.epoch, {
			active: sealed.target,
			sealed: false,
			target: undefined,
			reason: "failover-complete",
			lossWindowMs: loss,
		});
		return outcome.status === "decided" ? outcome.assignment : undefined;
	};

	if (assignment.sealed) {
		if (assignment.active === undefined) {
			assignment = (await finishFailover(assignment, undefined)) ?? assignment;
		} else {
			const next = await finishSwitch(assignment);
			if (next === undefined) return stop("undecided", []);
			assignment = next;
		}
	}

	const writerAt = assignment;
	const period = billingPeriod(now());
	const copied = new Map<string, FleetReplicationResult>();
	const observeAll = async (): Promise<Map<string, Observation>> => {
		const writer = byId(writerAt.active);
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
		const healthy = (backend: PostgresBackend) =>
			probes.get(backend.id)?.health === Health.REACHABLE;
		if (writer !== undefined && healthy(writer) && !writerAt.sealed)
			for (const backend of backends) {
				if (backend === writer || !healthy(backend)) continue;
				copied.set(backend.id, await copy(writerAt, writer, backend));
			}
		const seen = await Promise.all(
			backends.map(async (backend): Promise<readonly [string, Observation]> => {
				const probed = probes.get(backend.id);
				const usage: { unit: string; used: number }[] = [];
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
				return [
					backend.id,
					postgresObservation({
						health: probed?.health ?? Health.UNKNOWN,
						probeLatencyMs: probed?.latencyMs,
						failingForMs: probed?.failingForMs ?? 0,
						ready:
							backend === writer ||
							(result === undefined
								? everCopied
								: result.refusal !== "schema-mismatch"),
						lagMs: backend === writer ? 0 : lagMs,
						usage,
					}),
				] as const;
			}),
		);
		return new Map(seen);
	};
	let observed: Promise<Map<string, Observation>> | undefined;
	let decision: FleetDecision | undefined;
	let sealedEpoch: number | undefined;
	const { fleet, registry } = postgresFleetRegistry(
		fleetId,
		register.replicas.map((replica) => replica.id),
		{
			failoverAfterMs: options.policy.failoverAfterMs,
			recoveryPointMs: options.policy.rpoMs,
			membershipEpochs: options.membershipEpochs ?? false,
		},
	);
	const loop = createOneActiveFleet({
		fleet,
		registry,
		register,
		async observe(member) {
			observed ??= observeAll();
			const name = memberNameIn(member, fleetId);
			return (await observed).get(name ?? "") ?? unknownObservation();
		},
		async chooseAction(input) {
			decision = decideFleet({
				assignment: input.assignment,
				observations: input.observations,
				models: options.models,
				policy: options.policy,
				period,
				checkBudget: options.checkBudget,
				nowMs: input.nowMs,
			});
			options.log({ kind: "decision", decision });
			return actionOf(decision);
		},
		async scheduleActivation(epoch) {
			sealedEpoch = epoch;
		},
		decidedBy: options.decidedBy,
		sealWaitMs: options.leaseMs + options.graceMs,
		viewTtlMs: 0,
		refusedTtlMs: 0,
		now,
		log: (event, fields) => options.log({ kind: "log", event, fields }),
	});
	const tick = await loop.tick();
	options.log({ kind: "tick", tick });
	if (tick.action === "no-majority" || tick.action === "undecided")
		return stop(tick.action, [], tick);
	observed ??= observeAll();
	const byName = await observed;
	const observations = backends.map(
		(backend): NamedObservation => ({
			name: parseMemberName(backend.id, "backend"),
			observation: byName.get(backend.id) ?? unknownObservation(),
		}),
	);

	if (tick.action === "membership")
		record({
			step: "membership",
			status: proposalStatus(tick),
			epoch: tick.epoch,
			active: tick.active,
			target: tick.target,
			reason: tick.reasons[0] ?? "membership",
		});
	if (
		(tick.action === "switch" || tick.action === "failover") &&
		tick.target !== undefined
	) {
		const failover = tick.action === "failover";
		record({
			step: failover ? "failover" : "seal",
			status: sealedEpoch === undefined ? "undecided" : "decided",
			epoch: sealedEpoch,
			active: tick.active,
			target: tick.target,
			reason: tick.reasons[0] ?? tick.action,
		});
		const sealed = await readCurrentAssignment(register);
		if (
			sealedEpoch !== undefined &&
			sealed.status === "current" &&
			sealed.assignment.sealed &&
			sealed.assignment.epoch === sealedEpoch
		) {
			if (failover)
				await finishFailover(
					sealed.assignment,
					tick.route?.action === "failover"
						? tick.route.lossWindowMs
						: undefined,
				);
			else await finishSwitch(sealed.assignment);
		}
	}
	await options.meter?.flush(
		backends.filter(
			(backend) =>
				observations.find((entry) => entry.name === backend.id)?.observation
					.health === Health.REACHABLE,
		),
		layout,
		now(),
	);
	const final = await readCurrentAssignment(register);
	return {
		status: "settled",
		assignment: final.status === "current" ? final.assignment : undefined,
		decision,
		tick,
		observations,
		replications,
		transitions,
	};
}
