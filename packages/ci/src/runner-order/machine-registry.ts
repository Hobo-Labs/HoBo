import { createPublicKey, verify } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type MachineAdvert,
	MachineAdvertSchema,
} from "../_generated/relay_job_pb.js";
import {
	MACHINE_PUBLIC_KEY,
	MACHINE_SIGNATURE,
	type MachineIdentity,
} from "./machine-identity.js";
import type { MachineCandidate, MachineSharing } from "./machines.js";
import type { MachineRegistry } from "./ports.js";
import {
	defineMachineAdvert,
	machineCandidate,
	type RelayEventType,
	RelayRecordRejection,
} from "./relay-job.js";

export const MACHINE_ADVERT_TTL_MS = 90_000;

// public-contract: the domain separator of a signed machine advert; a change to what is signed needs a new one.
export const MACHINE_ADVERT_SIGNING_CONTEXT = "hobo-ci-machine-advert/v1";

export type MachineRegistryRefusal =
	| "unknown_machine"
	| "other_account"
	| "other_key";

export class MachineRegistryError extends Error {
	override readonly name = "MachineRegistryError";
	constructor(
		readonly reason: MachineRegistryRefusal,
		message: string,
	) {
		super(message);
	}
}

export type SignedMachineAdvert = Readonly<{
	advert: MachineAdvert;
	signature: string;
}>;

export type MachineEventType = Extract<RelayEventType, `machine.${string}`>;

export type MachineEvent = Readonly<{
	type: MachineEventType;
	accountId: string;
	machineId: string;
	atMs: number;
	by: string;
	signerKeyId: string;
	detail: string;
}>;

export type MachineAdvertRefusal =
	| "malformed"
	| "invalid_signature"
	| "stale"
	| "wrong_account"
	| "wrong_owner"
	| "taken_over";

export type MachineAdvertVerdict =
	| Readonly<{
			kind: "accepted";
			advert: MachineAdvert;
			events: readonly MachineEvent[];
	  }>
	| Readonly<{
			kind: "refused";
			reason: MachineAdvertRefusal;
			message: string;
			events: readonly MachineEvent[];
	  }>;

export function machineAdvertSigningPayload(advert: MachineAdvert): string {
	return JSON.stringify([
		MACHINE_ADVERT_SIGNING_CONTEXT,
		advert.id,
		advert.name,
		advert.runsOn,
		[...advert.labels],
		advert.os,
		advert.arch,
		advert.slots,
		advert.busy,
		advert.paused,
		advert.sharing,
		advert.ownerId,
		advert.ownerLogin,
		advert.repository,
		advert.lastSeenMs,
		advert.signerKeyId,
		advert.isolation,
		advert.lastPickedAtMs,
		advert.accountId,
	]);
}

export function signMachineAdvert(
	advert: MachineAdvert,
	identity: MachineIdentity,
): SignedMachineAdvert {
	const keyed = defineMachineAdvert(
		create(MachineAdvertSchema, { ...advert, signerKeyId: identity.publicKey }),
	);
	return {
		advert: keyed,
		signature: identity.sign(machineAdvertSigningPayload(keyed)),
	};
}

export function verifyMachineAdvert(signed: SignedMachineAdvert): boolean {
	const publicKey = signed.advert.signerKeyId;
	if (
		!MACHINE_PUBLIC_KEY.test(publicKey) ||
		!MACHINE_SIGNATURE.test(signed.signature)
	)
		return false;
	try {
		return verify(
			null,
			Buffer.from(machineAdvertSigningPayload(signed.advert), "utf8"),
			createPublicKey({
				key: { kty: "OKP", crv: "Ed25519", x: publicKey },
				format: "jwk",
			}),
			Buffer.from(signed.signature, "base64url"),
		);
	} catch {
		return false;
	}
}

export function machineOnline(advert: MachineAdvert, nowMs: number): boolean {
	return nowMs - advert.lastSeenMs <= MACHINE_ADVERT_TTL_MS;
}

function refused(
	reason: MachineAdvertRefusal,
	message: string,
	events: readonly MachineEvent[] = [],
): MachineAdvertVerdict {
	return { kind: "refused", reason, message, events };
}

function takenOver(advert: MachineAdvert, nowMs: number): MachineAdvertVerdict {
	return refused(
		"taken_over",
		`Machine ${advert.name} (${advert.id}) is already connected under another key or account. Its owner must remove it (hobo ci machine remove ${advert.id}) before it can connect with a new one.`,
		[
			{
				type: "machine.taken_over",
				accountId: advert.accountId,
				machineId: advert.id,
				atMs: nowMs,
				by: advert.ownerLogin,
				signerKeyId: advert.signerKeyId,
				detail: `A new key tried to take over machine ${advert.name}; it was refused and the old key stays.`,
			},
		],
	);
}

export async function findMachine(
	registry: MachineRegistry,
	accountId: string,
	id: string,
): Promise<MachineAdvert | undefined> {
	return (await registry.list(accountId)).find((machine) => machine.id === id);
}

export async function receiveMachineAdvert(
	registry: MachineRegistry,
	signed: SignedMachineAdvert,
	context: Readonly<{
		accountId: string;
		ownerId: string;
		ownerLogin: string;
		nowMs: number;
	}>,
): Promise<MachineAdvertVerdict> {
	let advert: MachineAdvert;
	try {
		advert = defineMachineAdvert(create(MachineAdvertSchema, signed.advert));
	} catch (error) {
		if (error instanceof RelayRecordRejection)
			return refused(
				"malformed",
				`The machine advert is malformed: ${error.message}.`,
			);
		throw error;
	}
	if (!verifyMachineAdvert({ advert, signature: signed.signature }))
		return refused(
			"invalid_signature",
			`The advert for machine ${advert.id} is not signed by the key it names.`,
		);
	if (advert.accountId !== context.accountId)
		return refused(
			"wrong_account",
			`The advert for machine ${advert.id} names another account than the one that sent it.`,
		);
	if (
		advert.ownerId !== context.ownerId ||
		advert.ownerLogin !== context.ownerLogin
	)
		return refused(
			"wrong_owner",
			`The advert for machine ${advert.id} names another owner than ${context.ownerLogin}, who sent it.`,
		);
	if (Math.abs(context.nowMs - advert.lastSeenMs) > MACHINE_ADVERT_TTL_MS)
		return refused(
			"stale",
			`The advert for machine ${advert.id} is more than ${MACHINE_ADVERT_TTL_MS / 1000} s from this node's clock.`,
		);
	const kept = await findMachine(registry, advert.accountId, advert.id);
	if (kept && kept.signerKeyId !== advert.signerKeyId)
		return takenOver(advert, context.nowMs);
	if (kept && kept.ownerId !== advert.ownerId)
		return refused(
			"wrong_owner",
			`Machine ${advert.name} (${advert.id}) belongs to another owner. Its owner must remove it (hobo ci machine remove ${advert.id}) before another can connect it.`,
		);
	if (kept && advert.lastSeenMs < kept.lastSeenMs)
		return refused(
			"stale",
			`The advert for machine ${advert.id} is older than the one already kept.`,
		);
	const stored = defineMachineAdvert(
		create(MachineAdvertSchema, {
			...advert,
			lastSeenMs: Math.min(advert.lastSeenMs, context.nowMs),
			paused: kept?.paused ?? advert.paused,
			sharing: kept?.sharing ?? advert.sharing,
		}),
	);
	try {
		await registry.put(stored);
	} catch (error) {
		if (
			error instanceof MachineRegistryError &&
			(error.reason === "other_account" || error.reason === "other_key")
		)
			return takenOver(advert, context.nowMs);
		throw error;
	}
	const connected = !kept || !machineOnline(kept, context.nowMs);
	return {
		kind: "accepted",
		advert: stored,
		events: connected
			? [
					{
						type: "machine.connected",
						accountId: stored.accountId,
						machineId: stored.id,
						atMs: context.nowMs,
						by: stored.ownerLogin,
						signerKeyId: stored.signerKeyId,
						detail: `Machine ${stored.name} connected.`,
					},
				]
			: [],
	};
}

export type MachineChange = Readonly<{
	machine: MachineAdvert | undefined;
	event: MachineEvent | undefined;
}>;

function changeEvent(
	type: MachineEventType,
	machine: MachineAdvert,
	by: string,
	atMs: number,
	detail: string,
): MachineEvent {
	return {
		type,
		accountId: machine.accountId,
		machineId: machine.id,
		atMs,
		by,
		signerKeyId: machine.signerKeyId,
		detail,
	};
}

export async function setMachinePaused(
	registry: MachineRegistry,
	request: Readonly<{
		accountId: string;
		id: string;
		paused: boolean;
		by: string;
		nowMs: number;
	}>,
): Promise<MachineChange> {
	const machine = await findMachine(registry, request.accountId, request.id);
	if (!machine || machine.paused === request.paused)
		return { machine, event: undefined };
	await registry.setPaused(machine.id, request.paused, request.by);
	return {
		machine,
		event: changeEvent(
			request.paused ? "machine.paused" : "machine.resumed",
			machine,
			request.by,
			request.nowMs,
			request.paused
				? `Machine ${machine.name} was paused; its running jobs finish.`
				: `Machine ${machine.name} was resumed.`,
		),
	};
}

export async function setMachineSharing(
	registry: MachineRegistry,
	request: Readonly<{
		accountId: string;
		id: string;
		sharing: MachineSharing;
		by: string;
		nowMs: number;
	}>,
): Promise<MachineChange> {
	const machine = await findMachine(registry, request.accountId, request.id);
	if (!machine || machine.sharing === request.sharing)
		return { machine, event: undefined };
	await registry.setSharing(machine.id, request.sharing);
	return {
		machine,
		event: changeEvent(
			"machine.sharing_changed",
			machine,
			request.by,
			request.nowMs,
			`Machine ${machine.name} is now shared with ${request.sharing === "anyone" ? "anyone who may read the repository" : "its owner only"}.`,
		),
	};
}

export async function removeMachine(
	registry: MachineRegistry,
	request: Readonly<{
		accountId: string;
		id: string;
		by: string;
		nowMs: number;
	}>,
): Promise<MachineChange> {
	const machine = await findMachine(registry, request.accountId, request.id);
	if (!machine) return { machine, event: undefined };
	await registry.remove(machine.id);
	return {
		machine,
		event: changeEvent(
			"machine.removed",
			machine,
			request.by,
			request.nowMs,
			`Machine ${machine.name} was removed; it takes no more jobs.`,
		),
	};
}

export function machineCandidates(
	adverts: readonly MachineAdvert[],
	context: Readonly<{ nowMs: number; readers: ReadonlySet<string> }>,
): readonly MachineCandidate[] {
	return adverts.map((advert) =>
		machineCandidate(advert, {
			online: machineOnline(advert, context.nowMs),
			ownerCanRead: context.readers.has(advert.ownerId),
		}),
	);
}

export async function registryMachineCandidates(
	registry: MachineRegistry,
	context: Readonly<{
		accountId: string;
		nowMs: number;
		readers: ReadonlySet<string>;
	}>,
): Promise<readonly MachineCandidate[]> {
	return machineCandidates(await registry.list(context.accountId), context);
}
