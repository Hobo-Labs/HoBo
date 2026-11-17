/**
 * The machine registry's rules: what a connected machine's advert must prove
 * before it is kept, when a machine counts as online, and what the owner's
 * pause, share and remove do (ADR-0183).
 *
 * An advert is signed with the machine's mesh identity key (`./mesh/trust.ts`
 * holds the key pair; the same Ed25519 keys sign mesh adverts). The advert's
 * `signerKeyId` is that key's public half, so a reader needs nothing else to
 * check it. The first key a machine id arrives with is pinned: an advert for
 * a known machine id under any other key is refused and recorded as
 * `machine.taken_over`, and stays refused until the owner removes the machine.
 * Removing it is the only way to move a machine id to a new key.
 *
 * Pause and sharing are the owner's settings and the registry keeps them. A
 * machine's own advert sets them only when the machine is new, so a renewal
 * never undoes `hobo ci machine pause`. A machine whose advert has not been
 * renewed for `MACHINE_ADVERT_TTL_MS` is offline, and the walk passes it over.
 *
 * Everything here takes the clock as an argument. The registry is the port in
 * `./ports.ts`; the in-memory fake and the SQLite store both implement it.
 */
import { createPublicKey, verify } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type MachineAdvert,
	MachineAdvertSchema,
} from "../_generated/relay_job_pb.js";
import type { MeshIdentity } from "../mesh/trust.js";
import type { MachineCandidate, MachineSharing } from "./machines.js";
import type { MachineRegistry } from "./ports.js";
import {
	defineMachineAdvert,
	machineCandidate,
	type RelayEventType,
	RelayRecordRejection,
} from "./relay-job.js";

// public-contract: an advert older than this is offline; a machine renews well inside it.
export const MACHINE_ADVERT_TTL_MS = 90_000;

// public-contract: the domain separator of a signed machine advert; a change to what is signed needs a new one.
export const MACHINE_ADVERT_SIGNING_CONTEXT = "hobo-ci-machine-advert/v1";

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

/** An advert as a machine sends it: the record and its Ed25519 signature, base64url. */
export type SignedMachineAdvert = Readonly<{
	advert: MachineAdvert;
	signature: string;
}>;

/** The machine events the registry rules give rise to. */
export type MachineEventType = Extract<RelayEventType, `machine.${string}`>;

/** One thing that happened to a machine, for the event sink (a CloudEvent at the edge). */
export type MachineEvent = Readonly<{
	type: MachineEventType;
	accountId: string;
	machineId: string;
	atMs: number;
	/** The login that asked, or the machine's owner for what the machine itself sent. */
	by: string;
	/** The key the event is about: the advert's key, or for a takeover the key that was refused. */
	signerKeyId: string;
	/** One plain sentence. */
	detail: string;
}>;

/** Why an advert was not kept. */
export type MachineAdvertRefusal =
	/** It does not parse as a machine advert. */
	| "malformed"
	/** The signature does not verify under the advert's key. */
	| "invalid_signature"
	/** It is too far from the reader's clock, or older than the one kept. */
	| "stale"
	/** It names another account than the one that sent it. */
	| "wrong_account"
	/** The machine id is known under another key. */
	| "taken_over";

export type MachineAdvertVerdict =
	| Readonly<{
			kind: "accepted";
			/** The advert as kept: the owner's pause and sharing win over the machine's. */
			advert: MachineAdvert;
			events: readonly MachineEvent[];
	  }>
	| Readonly<{
			kind: "refused";
			reason: MachineAdvertRefusal;
			message: string;
			events: readonly MachineEvent[];
	  }>;

/**
 * The exact text a machine signs: a JSON array of every advert field in field
 * order, led by the context string. `signerKeyId` is inside, so the advert
 * cannot be claimed by another key.
 */
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

/** The advert under the identity's key, signed. `signerKeyId` becomes the key's public half. */
export function signMachineAdvert(
	advert: MachineAdvert,
	identity: MeshIdentity,
): SignedMachineAdvert {
	const keyed = defineMachineAdvert(
		create(MachineAdvertSchema, { ...advert, signerKeyId: identity.publicKey }),
	);
	return {
		advert: keyed,
		signature: identity.sign(machineAdvertSigningPayload(keyed)),
	};
}

/** Whether the signature holds for what the advert now says, under the advert's own key. */
export function verifyMachineAdvert(signed: SignedMachineAdvert): boolean {
	const publicKey = signed.advert.signerKeyId;
	if (!PUBLIC_KEY.test(publicKey) || !SIGNATURE.test(signed.signature))
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

/** Whether the advert was renewed recently enough at `nowMs` to take jobs. */
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

/** The machine with this id in the account, if the registry holds one. */
export async function findMachine(
	registry: MachineRegistry,
	accountId: string,
	id: string,
): Promise<MachineAdvert | undefined> {
	return (await registry.list(accountId)).find((machine) => machine.id === id);
}

/**
 * Check an advert that arrived from a machine and keep it, or refuse it.
 *
 * `accountId` is the account the sender authenticated as. The advert must
 * name it, verify under its own key, sit within `MACHINE_ADVERT_TTL_MS` of
 * `nowMs` (either side, for clock skew) and be no older than the advert kept.
 * A known machine id under another key is refused and gives
 * `machine.taken_over`. A new machine, or one that was offline, gives
 * `machine.connected`.
 */
export async function receiveMachineAdvert(
	registry: MachineRegistry,
	signed: SignedMachineAdvert,
	context: Readonly<{ accountId: string; nowMs: number }>,
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
	if (Math.abs(context.nowMs - advert.lastSeenMs) > MACHINE_ADVERT_TTL_MS)
		return refused(
			"stale",
			`The advert for machine ${advert.id} is more than ${MACHINE_ADVERT_TTL_MS / 1000} s from this node's clock.`,
		);
	const kept = await findMachine(registry, advert.accountId, advert.id);
	if (kept && kept.signerKeyId !== advert.signerKeyId)
		return refused(
			"taken_over",
			`Machine ${advert.name} (${advert.id}) is already connected under another key. Its owner must remove it (hobo ci machine remove ${advert.id}) before it can connect with a new one.`,
			[
				{
					type: "machine.taken_over",
					accountId: advert.accountId,
					machineId: advert.id,
					atMs: context.nowMs,
					by: advert.ownerLogin,
					signerKeyId: advert.signerKeyId,
					detail: `A new key tried to take over machine ${advert.name}; it was refused and the old key stays.`,
				},
			],
		);
	if (kept && advert.lastSeenMs < kept.lastSeenMs)
		return refused(
			"stale",
			`The advert for machine ${advert.id} is older than the one already kept.`,
		);
	const stored = kept
		? defineMachineAdvert(
				create(MachineAdvertSchema, {
					...advert,
					paused: kept.paused,
					sharing: kept.sharing,
				}),
			)
		: advert;
	await registry.put(stored);
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

/** A change the owner asked for, and the machine it applied to. */
export type MachineChange = Readonly<{
	/** The machine before the change; undefined when the account has no such machine. */
	machine: MachineAdvert | undefined;
	/** The event to send; undefined when nothing changed. */
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

/**
 * Pause or resume a machine of the account. A paused machine takes no new job;
 * the jobs it is running finish. Asking for the state it is already in changes
 * nothing, so the call is safe to repeat.
 */
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

/** Share a machine of the account with only its owner or with anyone who may read the repository. */
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

/**
 * Remove a machine of the account at once: the next decision cannot see it,
 * and its key is forgotten, so a new key may connect under its id.
 */
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

/**
 * The machines the walk may consider for one job: every advert, online when
 * renewed within `MACHINE_ADVERT_TTL_MS` of `nowMs`. `readers` holds the
 * GitHub user ids of the owners who can read the job's repository; an owner
 * left out cannot.
 */
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

/** `machineCandidates` over what the registry holds for the account now. */
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
