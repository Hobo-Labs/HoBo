/**
 * What a connected machine says about itself, and where it says it (ADR-0183).
 *
 * A machine renews a signed advert every `MACHINE_ADVERT_EVERY_MS`, well inside
 * the registry's `MACHINE_ADVERT_TTL_MS`. The advert is signed with the
 * machine's own Ed25519 key, the one `hobo ci machine connect` keeps beside
 * its id; the registry pins that key on first connect.
 *
 * The sink is where adverts go. A local node keeps them in its own registry
 * (`registryAdvertSink`), checked by `receiveMachineAdvert` exactly as a relay
 * checks one that arrives over the network.
 */
import { create } from "@bufbuild/protobuf";
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
import type { MeshIdentity } from "@hobo/ci/mesh";

// public-contract: a connected machine renews its advert this often.
export const MACHINE_ADVERT_EVERY_MS = 30_000;

/** The `runs-on` label that lands a job on this machine and no other. */
export function machineRunsOnLabel(machineId: string): string {
	return `hobo-machine-${machineId}`;
}

/** Who and what the machine is: fixed for the life of one connect. */
export type MachineProfile = Readonly<{
	id: string;
	name: string;
	os: "linux" | "macos" | "windows";
	arch: "x64" | "arm64" | "arm";
	accountId: string;
	/** The GitHub user who connected it. */
	ownerId: string;
	ownerLogin: string;
	isolation: MachineIsolation;
}>;

/** What changes between adverts. */
export type MachineAdvertState = Readonly<{
	slots: number;
	busy: number;
	paused: boolean;
	sharing: MachineSharing;
	lastPickedAtMs: number;
	nowMs: number;
}>;

/** The machine's advert, unsigned. */
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

/** The advert signed under the machine's key. */
export function signedMachineAdvert(
	profile: MachineProfile,
	state: MachineAdvertState,
	identity: MeshIdentity,
): SignedMachineAdvert {
	return signMachineAdvert(machineAdvert(profile, state), identity);
}

/** Where a machine's adverts and the owner's pause go. */
export interface MachineAdvertSink {
	/** Send a renewal; the verdict says what was kept (the owner's pause and sharing win). */
	advertise(
		signed: SignedMachineAdvert,
		nowMs: number,
	): Promise<MachineAdvertVerdict>;
	/** Pause or resume the machine, as `hobo ci machine pause` does. */
	setPaused(
		advert: MachineAdvert,
		paused: boolean,
		nowMs: number,
	): Promise<MachineEvent | undefined>;
	/** Take the machine offline at once, so the next decision passes it over. */
	offline(advert: MachineAdvert, nowMs: number): Promise<MachineEvent>;
}

/**
 * A sink over a registry this process may write: the local node's own. The
 * sender is the GitHub user the CLI signed in as.
 */
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
			// The advert is dated past the registry's horizon, so `machineOnline`
			// is false from now on; the key, pause and sharing stay pinned.
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
