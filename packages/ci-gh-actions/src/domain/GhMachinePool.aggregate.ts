import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	EpochMs,
	GhAccountId,
	GhActorId,
	GhAdvertKeyId,
	GhMachineId,
	GhMachineSharing,
	GhMachineSnapshot,
	GhRelayJobId,
	GhRunnerLabel,
	NonNegativeCount,
	PositiveSlots,
} from "./ids.js";

export class GhMachineNotFound extends Domain.Rejection("GhMachineNotFound", {
	machineId: GhMachineId,
}) {}

export class GhStaleAdvertKey extends Domain.Rejection("GhStaleAdvertKey", {
	machineId: GhMachineId,
	rejectedKeyId: GhAdvertKeyId,
	activeKeyId: GhAdvertKeyId,
}) {}

export class GhMachineSlotUnavailable extends Domain.Rejection(
	"GhMachineSlotUnavailable",
	{
		machineId: GhMachineId,
		reason: Schema.Literals([
			"not_found",
			"offline",
			"paused",
			"machine_full",
			"machine_not_shared",
		]),
	},
) {}

export class GhMachineConnected extends Domain.Event("GhMachineConnected", {
	machineId: GhMachineId,
	name: Schema.NonEmptyString,
	runsOnLabel: GhRunnerLabel,
	labels: Schema.Array(GhRunnerLabel),
	slots: PositiveSlots,
	sharing: GhMachineSharing,
	ownerId: GhActorId,
	advertKeyId: GhAdvertKeyId,
	isolatedContainer: Schema.Boolean,
	adopted: Schema.Boolean,
	connectedAtMs: EpochMs,
}) {}

export class GhMachineTakenOver extends Domain.Event("GhMachineTakenOver", {
	machineId: GhMachineId,
	previousKeyId: GhAdvertKeyId,
	newKeyId: GhAdvertKeyId,
	takenOverAtMs: EpochMs,
}) {}

export class GhMachinePaused extends Domain.Event("GhMachinePaused", {
	machineId: GhMachineId,
}) {}

export class GhMachineResumed extends Domain.Event("GhMachineResumed", {
	machineId: GhMachineId,
}) {}

export class GhMachineRemoved extends Domain.Event("GhMachineRemoved", {
	machineId: GhMachineId,
}) {}

export class GhMachineAdvertVerified extends Domain.Event(
	"GhMachineAdvertVerified",
	{
		machineId: GhMachineId,
		advertKeyId: GhAdvertKeyId,
		seenAtMs: EpochMs,
	},
) {}

export class GhMachineSlotAcquired extends Domain.Event(
	"GhMachineSlotAcquired",
	{
		machineId: GhMachineId,
		jobId: GhRelayJobId,
		runsOnLabel: GhRunnerLabel,
	},
) {}

export class GhMachineSlotReleased extends Domain.Event(
	"GhMachineSlotReleased",
	{
		machineId: GhMachineId,
		jobId: GhRelayJobId,
	},
) {}

export class ConnectGhMachine extends Domain.Command(
	"ConnectGhMachine",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
			name: Schema.NonEmptyString,
			runsOnLabel: GhRunnerLabel,
			labels: Schema.Array(GhRunnerLabel),
			slots: PositiveSlots,
			sharing: GhMachineSharing,
			ownerId: GhActorId,
			advertKeyId: GhAdvertKeyId,
			isolatedContainer: Schema.Boolean,
			adopted: Schema.Boolean,
			nowMs: EpochMs,
		},
		events: [GhMachineConnected, GhMachineTakenOver],
		rejects: [],
	},
	{
		description:
			"Connect or adopt a GitHub Actions machine, rotating advert keys and raising takeover events on key changes.",
	},
) {}

export class VerifyGhMachineAdvert extends Domain.Command(
	"VerifyGhMachineAdvert",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
			advertKeyId: GhAdvertKeyId,
			nowMs: EpochMs,
		},
		events: [GhMachineAdvertVerified],
		rejects: [GhMachineNotFound, GhStaleAdvertKey],
	},
	{
		description:
			"Verify that an incoming machine heartbeat uses the currently active signed advert key.",
	},
) {}

export class PauseGhMachine extends Domain.Command(
	"PauseGhMachine",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
		},
		events: [GhMachinePaused],
		rejects: [GhMachineNotFound],
	},
	{
		description:
			"Pause a connected machine so active jobs finish while no new jobs route to it.",
	},
) {}

export class ResumeGhMachine extends Domain.Command(
	"ResumeGhMachine",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
		},
		events: [GhMachineResumed],
		rejects: [GhMachineNotFound],
	},
	{
		description: "Resume a paused machine so eligible jobs route to it again.",
	},
) {}

export class RemoveGhMachine extends Domain.Command(
	"RemoveGhMachine",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
		},
		events: [GhMachineRemoved],
		rejects: [GhMachineNotFound],
	},
	{
		description:
			"Revoke and remove a machine immediately so subsequent decisions exclude it.",
	},
) {}

export class AcquireGhMachineSlot extends Domain.Command(
	"AcquireGhMachineSlot",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
			jobId: GhRelayJobId,
			actorId: GhActorId,
			ownerCanRead: Schema.Boolean,
		},
		events: [GhMachineSlotAcquired],
		rejects: [GhMachineSlotUnavailable],
		reply: {
			runsOnLabel: GhRunnerLabel,
		},
	},
	{
		description:
			"Acquire a concurrency slot on a connected machine enforcing sharing, pause state, and slot limits.",
	},
) {}

export class ReleaseGhMachineSlot extends Domain.Command(
	"ReleaseGhMachineSlot",
	{
		target: GhAccountId,
		input: {
			machineId: GhMachineId,
			jobId: GhRelayJobId,
		},
		events: [GhMachineSlotReleased],
		rejects: [],
	},
	{
		description: "Release a finished job slot on a connected machine.",
	},
) {}

const MachineRecord = Schema.Struct({
	machineId: GhMachineId,
	name: Schema.NonEmptyString,
	runsOnLabel: GhRunnerLabel,
	labels: Schema.Array(GhRunnerLabel),
	slots: PositiveSlots,
	activeJobIds: Schema.Array(GhRelayJobId),
	paused: Schema.Boolean,
	online: Schema.Boolean,
	sharing: GhMachineSharing,
	ownerId: GhActorId,
	advertKeyId: GhAdvertKeyId,
	isolatedContainer: Schema.Boolean,
	adopted: Schema.Boolean,
	lastSeenMs: EpochMs,
});
type MachineRecord = typeof MachineRecord.Type;

export const GhMachinePoolState = Schema.Struct({
	machines: Schema.Array(MachineRecord),
});
export type GhMachinePoolState = typeof GhMachinePoolState.Type;

export function toGhMachineSnapshots(
	state: GhMachinePoolState,
	ownerCanRead: boolean,
): readonly GhMachineSnapshot[] {
	return state.machines.map((machine) => ({
		machineId: machine.machineId,
		name: machine.name,
		runsOnLabel: machine.runsOnLabel,
		labels: machine.labels,
		slots: machine.slots,
		busy: NonNegativeCount.make(machine.activeJobIds.length),
		paused: machine.paused,
		online: machine.online,
		sharing: machine.sharing,
		ownerId: machine.ownerId,
		ownerCanRead,
		isolatedContainer: machine.isolatedContainer,
		adopted: machine.adopted,
	}));
}

export class GhMachinePool extends Domain.Aggregate("GhMachinePool", {
	id: GhAccountId,
	state: GhMachinePoolState,
	initial: {
		machines: [],
	},
	commands: [
		ConnectGhMachine,
		VerifyGhMachineAdvert,
		PauseGhMachine,
		ResumeGhMachine,
		RemoveGhMachine,
		AcquireGhMachineSlot,
		ReleaseGhMachineSlot,
	],
	decide: {
		ConnectGhMachine: (state, cmd) => {
			const existing = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			const events: Array<GhMachineConnected | GhMachineTakenOver> = [];
			if (existing !== undefined && existing.advertKeyId !== cmd.advertKeyId) {
				events.push(
					new GhMachineTakenOver({
						machineId: cmd.machineId,
						previousKeyId: existing.advertKeyId,
						newKeyId: cmd.advertKeyId,
						takenOverAtMs: cmd.nowMs,
					}),
				);
			}
			events.push(
				new GhMachineConnected({
					machineId: cmd.machineId,
					name: cmd.name,
					runsOnLabel: cmd.runsOnLabel,
					labels: cmd.labels,
					slots: cmd.slots,
					sharing: cmd.sharing,
					ownerId: cmd.ownerId,
					advertKeyId: cmd.advertKeyId,
					isolatedContainer: cmd.isolatedContainer,
					adopted: cmd.adopted,
					connectedAtMs: cmd.nowMs,
				}),
			);
			return events;
		},
		VerifyGhMachineAdvert: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined) {
				return new GhMachineNotFound({ machineId: cmd.machineId });
			}
			if (machine.advertKeyId !== cmd.advertKeyId) {
				return new GhStaleAdvertKey({
					machineId: cmd.machineId,
					rejectedKeyId: cmd.advertKeyId,
					activeKeyId: machine.advertKeyId,
				});
			}
			return [
				new GhMachineAdvertVerified({
					machineId: cmd.machineId,
					advertKeyId: cmd.advertKeyId,
					seenAtMs: cmd.nowMs,
				}),
			];
		},
		PauseGhMachine: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined) {
				return new GhMachineNotFound({ machineId: cmd.machineId });
			}
			return machine.paused
				? []
				: [new GhMachinePaused({ machineId: cmd.machineId })];
		},
		ResumeGhMachine: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined) {
				return new GhMachineNotFound({ machineId: cmd.machineId });
			}
			return machine.paused
				? [new GhMachineResumed({ machineId: cmd.machineId })]
				: [];
		},
		RemoveGhMachine: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined) {
				return new GhMachineNotFound({ machineId: cmd.machineId });
			}
			return [new GhMachineRemoved({ machineId: cmd.machineId })];
		},
		AcquireGhMachineSlot: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined) {
				return new GhMachineSlotUnavailable({
					machineId: cmd.machineId,
					reason: "not_found",
				});
			}
			if (machine.activeJobIds.includes(cmd.jobId)) {
				return [];
			}
			if (!machine.online) {
				return new GhMachineSlotUnavailable({
					machineId: cmd.machineId,
					reason: "offline",
				});
			}
			if (machine.paused) {
				return new GhMachineSlotUnavailable({
					machineId: cmd.machineId,
					reason: "paused",
				});
			}
			const allowed =
				machine.sharing === "anyone"
					? cmd.ownerCanRead
					: machine.ownerId === cmd.actorId && cmd.ownerCanRead;
			if (!allowed) {
				return new GhMachineSlotUnavailable({
					machineId: cmd.machineId,
					reason: "machine_not_shared",
				});
			}
			if (machine.activeJobIds.length >= machine.slots) {
				return new GhMachineSlotUnavailable({
					machineId: cmd.machineId,
					reason: "machine_full",
				});
			}
			return [
				new GhMachineSlotAcquired({
					machineId: machine.machineId,
					jobId: cmd.jobId,
					runsOnLabel: machine.runsOnLabel,
				}),
			];
		},
		ReleaseGhMachineSlot: (state, cmd) => {
			const machine = state.machines.find(
				(entry) => entry.machineId === cmd.machineId,
			);
			if (machine === undefined || !machine.activeJobIds.includes(cmd.jobId)) {
				return [];
			}
			return [
				new GhMachineSlotReleased({
					machineId: cmd.machineId,
					jobId: cmd.jobId,
				}),
			];
		},
	},
	evolve: {
		GhMachineConnected: (state, event) => {
			const existing = state.machines.find(
				(entry) => entry.machineId === event.machineId,
			);
			const next: MachineRecord = {
				machineId: event.machineId,
				name: event.name,
				runsOnLabel: event.runsOnLabel,
				labels: event.labels,
				slots: event.slots,
				activeJobIds: existing?.activeJobIds ?? [],
				paused: existing?.paused ?? false,
				online: true,
				sharing: event.sharing,
				ownerId: event.ownerId,
				advertKeyId: event.advertKeyId,
				isolatedContainer: event.isolatedContainer,
				adopted: event.adopted,
				lastSeenMs: event.connectedAtMs,
			};
			return {
				machines: existing
					? state.machines.map((entry) =>
							entry.machineId === event.machineId ? next : entry,
						)
					: [...state.machines, next],
			};
		},
		GhMachineTakenOver: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId
					? { ...entry, advertKeyId: event.newKeyId, lastSeenMs: event.takenOverAtMs }
					: entry,
			),
		}),
		GhMachinePaused: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId ? { ...entry, paused: true } : entry,
			),
		}),
		GhMachineResumed: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId
					? { ...entry, paused: false }
					: entry,
			),
		}),
		GhMachineRemoved: (state, event) => ({
			machines: state.machines.filter(
				(entry) => entry.machineId !== event.machineId,
			),
		}),
		GhMachineAdvertVerified: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId
					? { ...entry, online: true, lastSeenMs: event.seenAtMs }
					: entry,
			),
		}),
		GhMachineSlotAcquired: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId
					? { ...entry, activeJobIds: [...entry.activeJobIds, event.jobId] }
					: entry,
			),
		}),
		GhMachineSlotReleased: (state, event) => ({
			machines: state.machines.map((entry) =>
				entry.machineId === event.machineId
					? {
							...entry,
							activeJobIds: entry.activeJobIds.filter(
								(jobId) => jobId !== event.jobId,
							),
						}
					: entry,
			),
		}),
	},
	reply: {
		AcquireGhMachineSlot: (state, events) => {
			const acquired = events.find(
				(event): event is GhMachineSlotAcquired =>
					event._tag === "GhMachineSlotAcquired",
			);
			const fallback =
				state.machines[0]?.runsOnLabel ?? GhRunnerLabel.make("hobo-machine");
			return {
				runsOnLabel: acquired?.runsOnLabel ?? fallback,
			};
		},
	},
}) {}
