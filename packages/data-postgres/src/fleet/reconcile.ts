import {
	type AssignmentProposalOutcome,
	type AssignmentRegister,
	billingPeriod,
	bootstrapAssignment,
	completeAssignment,
	decideFleet,
	type FleetAssignment,
	type FleetAssignmentValue,
	type FleetBackendHealth,
	type FleetBudgetCheck,
	type FleetDecision,
	type FleetFailureClass,
	type FleetFinancialModel,
	type FleetObservation,
	type FleetPolicy,
	type FleetUsageMeasurement,
	proposeAssignment,
	readCurrentAssignment,
} from "@hobo/backend-fleet";
import { sqlAssignmentRegister } from "./assignment.js";
import { ensureFleetControlTables } from "./control.js";
import type { FleetLayout } from "./layout.js";
import {
	type ReplicationLimits,
	type ReplicationRefusal,
	readWatermark,
	replicateSnapshot,
	standbyLagMs,
} from "./replication.js";
import { classifyFleetFailure, type FleetBackend } from "./sql.js";
import { measureStorageBytes, readUsage } from "./usage.js";

export type FleetReplicationResult = {
	readonly source: string;
	readonly target: string;
	readonly epoch: number;
	readonly status: "replicated" | "refused" | "failed";
	readonly refusal: ReplicationRefusal | undefined;
	readonly failure: FleetFailureClass | undefined;
	readonly rows: number | undefined;
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
	readonly status: AssignmentProposalOutcome["status"];
	readonly epoch: number | undefined;
	readonly active: string | undefined;
	readonly target: string | undefined;
	readonly reason: string;
};

export type FleetEvent =
	| {
			readonly kind: "replication";
			readonly replication: FleetReplicationResult;
	  }
	| { readonly kind: "decision"; readonly decision: FleetDecision }
	| { readonly kind: "transition"; readonly transition: FleetTransition }
	| {
			readonly kind: "unsettled";
			readonly status: "undecided" | "no-majority" | "empty";
			readonly silent: readonly string[];
	  };

export type FleetSchemaRole = "writer" | "standby";

export type FleetReconcileOptions = {
	readonly backends: readonly FleetBackend[];
	readonly layout: FleetLayout;
	readonly models: readonly FleetFinancialModel[];
	readonly policy: FleetPolicy;
	readonly leaseMs: number;
	readonly graceMs: number;
	readonly ensureSchema: (
		backend: FleetBackend,
		role: FleetSchemaRole,
	) => Promise<void>;
	readonly checkBudget: FleetBudgetCheck;
	readonly limits: Partial<ReplicationLimits> | undefined;
	readonly decidedBy: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly log: (event: FleetEvent) => void;
};

export type FleetReconcileReport = {
	readonly status: "settled" | "undecided" | "no-majority";
	readonly assignment: FleetAssignment | undefined;
	readonly decision: FleetDecision | undefined;
	readonly observations: readonly FleetObservation[];
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
		assignment: FleetAssignment,
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

	await Promise.all(
		backends.map(async (backend) => {
			try {
				await ensureFleetControlTables(backend, layout);
			} catch {}
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

	const finishSwitch = async (
		sealed: FleetAssignment,
	): Promise<FleetAssignment | undefined> => {
		await options.sleep(options.leaseMs + options.graceMs);
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

	const copied = new Map<string, FleetReplicationResult>();
	if (writer !== undefined && healthy(writer))
		for (const backend of backends) {
			if (backend === writer || !healthy(backend)) continue;
			copied.set(backend.id, await copy(assignment, writer, backend));
		}

	const observedAtMs = now();
	const period = billingPeriod(observedAtMs);
	const observations = await Promise.all(
		backends.map(async (backend): Promise<FleetObservation> => {
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
							counters.find((entry) => entry.unit === "operations")?.used ?? 0,
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

	const decision = decideFleet({
		assignment,
		observations,
		models: options.models,
		policy: options.policy,
		period,
		checkBudget: options.checkBudget,
		nowMs: observedAtMs,
	});
	options.log({ kind: "decision", decision });

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
