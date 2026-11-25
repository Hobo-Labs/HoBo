import { create } from "@bufbuild/protobuf";
import type { MachineIdentity } from "@hobo/ci";
import {
	defineMachineAdvert,
	MACHINE_ADVERT_TTL_MS,
	type MachineAdvert,
	MachineAdvertSchema,
	type MachineAdvertVerdict,
	type MachineEvent,
	type MachineIsolation,
	type MachineRegistry,
	type MachineSharing,
	machineLabels,
	receiveMachineAdvert,
	type SignedMachineAdvert,
	setMachinePaused,
	signMachineAdvert,
} from "@hobo/ci";

// public-contract: a connected machine renews its advert this often.
export const MACHINE_ADVERT_EVERY_MS = 30_000;

export function machineRunsOnLabel(machineId: string): string {
	return `hobo-machine-${machineId}`;
}

export type MachineProfile = Readonly<{
	id: string;
	name: string;
	os: "linux" | "macos" | "windows";
	arch: "x64" | "arm64" | "arm";
	accountId: string;
	ownerId: string;
	ownerLogin: string;
	isolation: MachineIsolation;
}>;

export type MachineAdvertState = Readonly<{
	slots: number;
	busy: number;
	paused: boolean;
	sharing: MachineSharing;
	lastPickedAtMs: number;
	nowMs: number;
}>;

export function machineAdvert(
	profile: MachineProfile,
	state: MachineAdvertState,
): MachineAdvert {
	return defineMachineAdvert(
		create(MachineAdvertSchema, {
			id: profile.id,
			name: profile.name,
			runsOn: machineRunsOnLabel(profile.id),
			labels: [...machineLabels(profile.os, profile.arch)],
			os: profile.os,
			arch: profile.arch,
			slots: state.slots,
			busy: state.busy,
			paused: state.paused,
			sharing: state.sharing,
			ownerId: profile.ownerId,
			ownerLogin: profile.ownerLogin,
			repository: "",
			lastSeenMs: state.nowMs,
			signerKeyId: "unsigned",
			isolation: profile.isolation,
			lastPickedAtMs: state.lastPickedAtMs,
			accountId: profile.accountId,
		}),
	);
}

export function signedMachineAdvert(
	profile: MachineProfile,
	state: MachineAdvertState,
	identity: MachineIdentity,
): SignedMachineAdvert {
	return signMachineAdvert(machineAdvert(profile, state), identity);
}

export interface MachineAdvertSink {
	advertise(
		signed: SignedMachineAdvert,
		nowMs: number,
	): Promise<MachineAdvertVerdict>;
	setPaused(
		advert: MachineAdvert,
		paused: boolean,
		nowMs: number,
	): Promise<MachineEvent | undefined>;
	offline(advert: MachineAdvert, nowMs: number): Promise<MachineEvent>;
}

export function registryAdvertSink(
	registry: MachineRegistry,
	sender: Readonly<{ accountId: string; ownerId: string; ownerLogin: string }>,
): MachineAdvertSink {
	return {
		advertise: (signed, nowMs) =>
			receiveMachineAdvert(registry, signed, { ...sender, nowMs }),
		async setPaused(advert, paused, nowMs) {
			const change = await setMachinePaused(registry, {
				accountId: advert.accountId,
				id: advert.id,
				paused,
				by: sender.ownerLogin,
				nowMs,
			});
			return change.event;
		},
		async offline(advert, nowMs) {
			const kept = (await registry.list(advert.accountId)).find(
				(machine) => machine.id === advert.id,
			);
			if (kept && kept.signerKeyId === advert.signerKeyId)
				await registry.put(
					create(MachineAdvertSchema, {
						...kept,
						busy: 0,
						lastSeenMs: Math.min(
							kept.lastSeenMs,
							nowMs - MACHINE_ADVERT_TTL_MS - 1,
						),
					}),
				);
			return {
				type: "machine.disconnected",
				accountId: advert.accountId,
				machineId: advert.id,
				atMs: nowMs,
				by: sender.ownerLogin,
				signerKeyId: advert.signerKeyId,
				detail: `Machine ${advert.name} went offline; the next decision passes it over.`,
			};
		},
	};
}
