import { create } from "@bufbuild/protobuf";
import {
	Health,
	type MemberRecord,
	MemberState,
	type Observation,
	ObservationSchema,
} from "../_generated/fleet_pb.js";
import { type MemberName, parseFleetId } from "../ids.js";
import { eligibleForActive } from "../observation/index.js";
import type {
	AssignmentEntry,
	AssignmentResolution,
	NamedObservation,
	OneActiveAction,
	OneActiveDeps,
	OneActiveTick,
	Outcome,
} from "../ports.js";
import {
	bootstrapAssignment,
	completeAssignment,
	proposeAssignment,
	proposeMembership,
	readAssignmentReplies,
	readCurrentAssignment,
	resolveAssignment,
} from "./register.js";
import { rejoinAssignmentReplicas } from "./replica.js";

const FAILING_FOREVER_MS = 4_294_967_295;

type View = Readonly<
	| { ok: true; name: MemberName }
	| {
			ok: false;
			reason: AssignmentResolution["status"] | "sealed" | "no-active-member";
	  }
>;

function viewOf(resolution: AssignmentResolution): View {
	if (resolution.status !== "current")
		return { ok: false, reason: resolution.status };
	const entry = resolution.assignment;
	if (entry.sealed) return { ok: false, reason: "sealed" };
	if (entry.active === undefined)
		return { ok: false, reason: "no-active-member" };
	return { ok: true, name: entry.active };
}

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

function healthToken(health: Health): string {
	return (Health[health] ?? "UNKNOWN").toLowerCase().replaceAll("_", "-");
}

export function createOneActiveFleet(deps: OneActiveDeps): Readonly<{
	active(): Promise<Outcome<MemberName>>;
	tick(): Promise<OneActiveTick>;
	activate(epoch: number): Promise<void>;
}> {
	const { register, now, log, decidedBy, sealWaitMs } = deps;
	const fleetId = parseFleetId(deps.fleet.fleetId, "fleet_id");
	const policy = deps.fleet.policy;
	const members = register.replicas.map((replica) => replica.id);
	const single = members.length === 1 ? members[0] : undefined;

	let cached: Readonly<{ view: View; readStartedAt: number }> | undefined;
	let pending: Promise<View> | undefined;

	async function resolveView(): Promise<View> {
		if (cached !== undefined) {
			const limit = cached.view.ok ? deps.viewTtlMs : deps.refusedTtlMs;
			if (now() - cached.readStartedAt < limit) return cached.view;
		}
		pending ??= (async () => {
			const startedAt = now();
			let resolution = await readCurrentAssignment(register);
			if (resolution.status === "empty" && members[0] !== undefined) {
				await bootstrapAssignment(register, members[0]);
				resolution = await readCurrentAssignment(register);
			} else if (resolution.status === "undecided")
				resolution = await completeAssignment(register);
			const view = viewOf(resolution);
			cached = { view, readStartedAt: startedAt };
			return view;
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	}

	async function active(): Promise<Outcome<MemberName>> {
		if (single !== undefined) return { ok: true, value: single };
		const view = await resolveView();
		if (view.ok) return { ok: true, value: view.name };
		return {
			ok: false,
			error: {
				code:
					view.reason === "no-majority" || view.reason === "undecided"
						? view.reason
						: "unavailable",
				message: `one-active fleet ${fleetId} has no active member (${view.reason}); retry later`,
				detail: { reason: view.reason },
			},
		};
	}

	function report(tick: OneActiveTick): OneActiveTick {
		log("hobo_fleet_assignment_tick", {
			fleet: fleetId,
			action: tick.action,
			epoch: tick.epoch,
			active: tick.active ?? "",
			target: tick.target ?? "",
			reasons: tick.reasons.join(","),
		});
		return tick;
	}

	async function schedule(epoch: number, afterMs: number): Promise<void> {
		try {
			await deps.scheduleActivation(epoch, afterMs);
		} catch {
			log("hobo_fleet_assignment_tick", {
				fleet: fleetId,
				action: "activation-unscheduled",
				epoch,
			});
		}
	}

	async function seal(
		current: AssignmentEntry,
		target: MemberName,
		reason: string,
		keepActive: boolean,
	): Promise<AssignmentEntry | undefined> {
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

	async function recordsByName(): Promise<Map<MemberName, MemberRecord>> {
		const byName = new Map<MemberName, MemberRecord>();
		for (const record of await deps.registry.membersOf(fleetId)) {
			const name = record.memberships.find(
				(membership) => membership.fleet === fleetId,
			)?.name;
			const member = members.find((each) => each === name);
			if (member !== undefined) byName.set(member, record);
		}
		return byName;
	}

	async function changeMembership(
		current: AssignmentEntry,
		records: ReadonlyMap<MemberName, MemberRecord>,
	): Promise<OneActiveTick | undefined> {
		const base = { expectedEpoch: current.epoch, decidedBy, nowMs: now() };
		let change: Parameters<typeof proposeMembership>[1] | undefined;
		let reason: string | undefined;
		if (current.members === undefined) {
			change = { ...base, pin: members };
			reason = "pin-members";
		} else {
			const decided = current.members;
			const candidates = members.filter(
				(name) => records.get(name)?.state === MemberState.ACTIVE,
			);
			const admit = candidates.find((name) => !decided.includes(name));
			const remove = decided.find(
				(name) =>
					!candidates.includes(name) &&
					name !== current.active &&
					name !== current.target,
			);
			if (admit !== undefined) {
				change = { ...base, add: admit };
				reason = `admit:${admit}`;
			} else if (remove !== undefined && decided.length > 1) {
				change = { ...base, remove };
				reason = `remove:${remove}`;
			}
		}
		if (change === undefined || reason === undefined) return undefined;
		const outcome = await proposeMembership(register, change);
		cached = undefined;
		return report({
			action: "membership",
			epoch:
				outcome.status === "decided" ? outcome.assignment.epoch : current.epoch,
			active: current.active,
			target: current.target,
			reasons: [reason, `proposal-${outcome.status}`],
		});
	}

	async function observeAll(
		records: ReadonlyMap<MemberName, MemberRecord>,
	): Promise<NamedObservation[]> {
		return Promise.all(
			members.map(async (name): Promise<NamedObservation> => {
				const record = records.get(name);
				const unknown = () =>
					create(ObservationSchema, {
						memberId: record?.memberId ?? "",
						health: Health.UNKNOWN,
					});
				let observation: Observation;
				try {
					observation =
						record === undefined ? unknown() : await deps.observe(record);
				} catch {
					observation = unknown();
				}
				return { name, observation };
			}),
		);
	}

	async function choose(
		assignment: AssignmentEntry,
		observations: readonly NamedObservation[],
		mode: "failover" | "switch",
	): Promise<OneActiveAction> {
		return deps.chooseAction({
			assignment,
			members,
			observations,
			eligibility: eligibleForActive(observations, {
				mode,
				recoveryPointMs: policy?.recoveryPointMs,
			}),
			nowMs: now(),
		});
	}

	async function sealedTick(
		current: AssignmentEntry,
		observations: readonly NamedObservation[],
		at: number,
	): Promise<OneActiveTick> {
		const target = current.target;
		const waited = at - current.decidedAtMs;
		if (waited > 2 * sealWaitMs)
			log("hobo_fleet_assignment_sealed_too_long", {
				fleet: fleetId,
				epoch: current.epoch,
				target: target ?? "",
				sealedForMs: waited,
			});
		if (target === undefined)
			return report({
				action: "undecided",
				epoch: current.epoch,
				active: current.active,
				target,
				reasons: ["sealed-without-target"],
			});
		const targetHealth =
			observations.find((entry) => entry.name === target)?.observation.health ??
			Health.UNKNOWN;
		if (targetHealth !== Health.REACHABLE) {
			const seen = healthToken(targetHealth);
			const route = await choose(
				{ ...current, active: target, sealed: false, target: undefined },
				observations.map((entry) =>
					entry.name === target
						? {
								name: entry.name,
								observation: {
									...entry.observation,
									failingForMs: FAILING_FOREVER_MS,
								},
							}
						: entry,
				),
				"failover",
			);
			if (route.action === "failover") {
				const resealed = await seal(
					current,
					route.target,
					`failover:${seen}`,
					false,
				);
				return report({
					action: "reseal",
					epoch: resealed?.epoch ?? current.epoch,
					active: undefined,
					target: route.target,
					reasons: [`target-${seen}`],
					route,
				});
			}
			return report({
				action: "sealed-waiting",
				epoch: current.epoch,
				active: current.active,
				target,
				reasons: [`target-${seen}`, ...route.reasons],
				route,
			});
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
				outcome.status === "decided" ? outcome.assignment.epoch : current.epoch,
			active: outcome.status === "decided" ? target : current.active,
			target,
			reasons: [`proposal-${outcome.status}`],
		});
	}

	async function tick(): Promise<OneActiveTick> {
		if (single !== undefined)
			return {
				action: "single",
				epoch: 0,
				active: single,
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
			register.replicas.map((replica) =>
				replica.refresh === undefined
					? false
					: replica.refresh().catch(() => false),
			),
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
				reasons: [resolution.status],
			});
		if (resolution.status === "empty") {
			const [first] = members;
			if (first !== undefined) await bootstrapAssignment(register, first);
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
		const records = await recordsByName();
		if (policy?.membershipEpochs === true && !current.sealed) {
			const changed = await changeMembership(current, records);
			if (changed !== undefined) return changed;
		}
		const observations = await observeAll(records);
		if (current.sealed) return sealedTick(current, observations, at);

		const activeHealth =
			observations.find((entry) => entry.name === current.active)?.observation
				.health ?? Health.UNKNOWN;
		const failing = activeHealth !== Health.REACHABLE;
		const route = await choose(
			current,
			observations,
			failing ? "failover" : "switch",
		);
		if (route.action === "switch" || route.action === "failover") {
			const failover = route.action === "failover";
			const sealed = await seal(
				current,
				route.target,
				failover
					? `failover:${healthToken(activeHealth)}`
					: `switch:${reasonToken(route.reasons[0] ?? "budget")}`,
				!failover,
			);
			return report({
				action: route.action,
				epoch: sealed?.epoch ?? current.epoch,
				active: sealed ? sealed.active : current.active,
				target: route.target,
				reasons: sealed
					? route.reasons
					: [...route.reasons, "seal-not-decided"],
				route,
			});
		}
		return report({
			action: route.action,
			epoch: current.epoch,
			active: current.active,
			target: undefined,
			reasons: route.reasons,
			route,
		});
	}

	async function activate(epoch: number): Promise<void> {
		if (single !== undefined) return;
		const resolution = await readCurrentAssignment(register);
		if (
			resolution.status === "current" &&
			resolution.assignment.sealed &&
			resolution.assignment.epoch === epoch
		)
			await tick();
	}

	return Object.freeze({ active, tick, activate });
}
