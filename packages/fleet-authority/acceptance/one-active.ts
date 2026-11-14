/**
 * A one-active fleet in local mode (design §6.10; D39), for the behaviour
 * suite: the registry from `createLocalFleet`, one assignment-log replica per
 * member (`ephemeralAssignmentReplica` over an in-memory ephemeral state), the
 * register over them, and `createOneActiveFleet` ticking against observed
 * health. The choosing policy here is the plainest one: keep a healthy active
 * member, otherwise fail over to the first eligible member in configured
 * order. A reconfiguration (a new deploy naming more members) builds a new
 * loop over the same replicas.
 */
import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import {
	type AssignmentEntry,
	CoordinationMode,
	type EphemeralAssignmentReplica,
	FleetPolicySchema,
	Health,
	MemberKind,
	type MemberName,
	type OneActiveAction,
	type OneActiveTick,
	ObservationSchema,
	parseFleetId,
	parseMemberName,
} from "@hobo/fleet";
import {
	createOneActiveFleet,
	ephemeralAssignmentRegister,
	ephemeralAssignmentReplica,
	readCurrentAssignment,
} from "@hobo/fleet/assignment";
import { createLocalFleet } from "@hobo/fleet/membership";
import { createMemoryEphemeralState } from "./ephemeral-state.js";

const SEAL_WAIT_MS = 150_000;
const FLEET = parseFleetId("cache");

export type OneActiveWorld = Awaited<ReturnType<typeof createOneActiveWorld>>;

export async function createOneActiveWorld(
	input: Readonly<{ names: readonly string[]; membershipEpochs: boolean; spare?: readonly string[] }>,
) {
	let nowMs = Date.parse("2026-11-14T10:00:00.000Z");
	const now = () => nowMs;
	const health = new Map<string, Health>();
	const replicas = new Map<string, EphemeralAssignmentReplica>();
	const replicaOf = (name: string) => {
		const existing = replicas.get(name);
		if (existing !== undefined) return existing;
		const made = ephemeralAssignmentReplica(createMemoryEphemeralState(now), parseMemberName(name));
		replicas.set(name, made);
		return made;
	};
	const scheduled: [number, number][] = [];

	const loop = async (names: readonly string[]) => {
		for (const name of names) if (!health.has(name)) health.set(name, Health.REACHABLE);
		const local = await createLocalFleet({
			tenant: parseTenantId("local"),
			fleetId: FLEET,
			coordination: CoordinationMode.ONE_ACTIVE,
			policy: create(FleetPolicySchema, {
				allowedKinds: [MemberKind.BACKEND],
				failoverAfterMs: 60_000,
				membershipEpochs: input.membershipEpochs,
			}),
			owner: { kind: "user", id: "dev" },
			members: names.map((name) => ({
				kind: MemberKind.BACKEND,
				name: parseMemberName(name),
				displayName: name,
				credentialRef: `secret://cache/${name}`,
				endpointDigest: "",
			})),
			now,
			log: () => undefined,
		});
		const register = ephemeralAssignmentRegister(names.map(replicaOf));
		const fleet = createOneActiveFleet({
			fleet: local.fleet,
			registry: local.registry,
			register,
			async observe(member) {
				const name = member.memberships.find((m) => m.fleet === FLEET)?.name ?? "";
				const seen = health.get(name) ?? Health.UNKNOWN;
				return create(ObservationSchema, {
					memberId: member.memberId,
					health: seen,
					failingForMs: seen === Health.REACHABLE ? 0 : 120_000,
				});
			},
			async chooseAction(asked): Promise<OneActiveAction> {
				const active = asked.assignment.active;
				const eligible = asked.eligibility.filter((member) => member.eligible).map((member) => member.name);
				if (active !== undefined && eligible.includes(active)) return { action: "keep", reasons: ["active-healthy"] };
				const target: MemberName | undefined = eligible.find((name) => name !== active);
				if (target === undefined) return { action: "hold", reasons: ["no-eligible-member"] };
				return { action: "failover", target, lossWindowMs: undefined, reasons: [`active-unhealthy ${active ?? "none"}`] };
			},
			async scheduleActivation(epoch, afterMs) {
				scheduled.push([epoch, afterMs]);
			},
			decidedBy: "user:dev",
			sealWaitMs: SEAL_WAIT_MS,
			viewTtlMs: 0,
			refusedTtlMs: 0,
			now,
			log: () => undefined,
		});
		return { fleet, register };
	};

	let current = await loop(input.names);
	const ticks: OneActiveTick[] = [];

	return {
		ticks,
		scheduled,
		async tick(): Promise<OneActiveTick> {
			const tick = await current.fleet.tick();
			ticks.push(tick);
			return tick;
		},
		setHealth(name: string, value: Health) {
			health.set(name, value);
		},
		advance(ms: number) {
			nowMs += ms;
		},
		sealWaitMs: SEAL_WAIT_MS,
		async assignment(): Promise<AssignmentEntry> {
			const resolution = await readCurrentAssignment(current.register);
			if (resolution.status !== "current") throw new Error(`the register is ${resolution.status}`);
			return resolution.assignment;
		},
		/** A new deploy configures these members; the loop is rebuilt over the same replicas. */
		async reconfigure(names: readonly string[]) {
			current = await loop(names);
		},
	};
}
