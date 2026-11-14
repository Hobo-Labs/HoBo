/** A bounded journal voter whose documents, assignments and seal share one CAS.
 * The hosting provider must separately establish identity, anti-rollback,
 * independent funding and a terminal receipt for every uncertain attempt. */
import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { AtomicObjectJournalStateSchema } from "./_generated/hobo/backend_fleet/atomic_journal/v1/atomic_object_journal_pb.js";
import {
	assignmentKey,
	type FleetAssignment,
	parseFleetAssignment,
} from "./assignment.js";
import type {
	ImmutableJournalMember,
	ImmutableJournalSeal,
	SealableImmutableJournalReplica,
} from "./immutable-journal.js";
import { isJournalString } from "./json.js";

/** Each operation is one separately funded provider request. `conflict` is a
 * conclusive native conditional-write refusal; an exception means the write
 * may still complete and its financial hold must remain in force. The native
 * version is opaque and must be the version read from the same object. */
export interface AtomicJournalObject {
	read(): Promise<Readonly<{ body: string; version: string }> | undefined>;
	create(body: string): Promise<"created" | "conflict">;
	replace(
		body: string,
		expectedVersion: string,
	): Promise<"written" | "conflict">;
}
export interface AtomicObjectJournalOptions {
	readonly member: ImmutableJournalMember;
	readonly members: readonly ImmutableJournalMember[];
	readonly fleetId: string;
	readonly anchorDigest: string;
	readonly initializationId: string;
	readonly maxEntries: number;
	readonly maxDocumentBytes: number;
	readonly maxObjectBytes: number;
	/** Only conclusive CAS conflicts are retried. */
	readonly maxConflicts?: number;
	readonly object: AtomicJournalObject;
}
export class AtomicObjectJournalError extends Error {
	constructor(readonly reason: string) {
		super(`atomic object journal ${reason}`);
		this.name = "AtomicObjectJournalError";
	}
}

const HASH = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const ROOT = "0".repeat(64);
// Keep room to irreversibly seal even when abandoned proposals fill the voter.
const SEAL_RESERVE_BYTES = 512;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const sameSeal = (
	a: ImmutableJournalSeal | undefined,
	b: ImmutableJournalSeal,
) =>
	!!a &&
	a.transitionId === b.transitionId &&
	a.epoch === b.epoch &&
	a.digest === b.digest;
const memberKeys = [
	"id",
	"provider",
	"accountId",
	"resourceId",
	"incarnation",
] as const;

/** A new incarnation must use a newly admitted object. Opening or trying to
 * initialize this format over a split-format object fails closed; migration
 * uses the ordinary independently funded majority-sealed journal rollover. */
export function createAtomicObjectJournalReplica(
	options: AtomicObjectJournalOptions,
): Readonly<{
	replica: SealableImmutableJournalReplica;
	initializeFresh(
		verifyFresh: (
			member: ImmutableJournalMember,
			initializationId: string,
		) => Promise<void>,
	): Promise<void>;
}> {
	const member = Object.freeze({ ...options.member });
	const members = Object.freeze(
		options.members.map((row) => Object.freeze({ ...row })),
	);
	const {
		fleetId,
		anchorDigest,
		initializationId,
		maxEntries,
		maxDocumentBytes,
		maxObjectBytes,
	} = options;
	const maxConflicts = options.maxConflicts ?? 8;
	const object = {
		read: options.object.read.bind(options.object),
		create: options.object.create.bind(options.object),
		replace: options.object.replace.bind(options.object),
	};
	const anchor = JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId,
		members,
	});
	const genesis = JSON.stringify({
		contract: "hobo.immutable-journal-command/v1",
		position: 0,
		previous: ROOT,
		operationId: "genesis",
		value: anchor,
	});
	const genesisDigest = hash(genesis);
	if (
		!isJournalString(fleetId) ||
		!NAME.test(fleetId) ||
		!isJournalString(initializationId) ||
		!NAME.test(initializationId) ||
		!isJournalString(anchorDigest) ||
		!HASH.test(anchorDigest) ||
		hash(anchor) !== anchorDigest ||
		members.length < 3 ||
		members.length > 31 ||
		members.length % 2 !== 1 ||
		new Set(members.map((row) => row.id)).size !== members.length ||
		new Set(
			members.map((row) =>
				JSON.stringify([row.provider, row.accountId, row.resourceId]),
			),
		).size !== members.length ||
		members.some((row) =>
			memberKeys.some(
				(key) => !isJournalString(row[key]) || !NAME.test(row[key]),
			),
		) ||
		!members.some((row) =>
			memberKeys.every((key) => row[key] === member[key]),
		) ||
		!Number.isSafeInteger(maxEntries) ||
		maxEntries < 1 ||
		maxEntries > 10_000 ||
		!Number.isSafeInteger(maxDocumentBytes) ||
		maxDocumentBytes < 1 ||
		maxDocumentBytes > 2_000_000 ||
		!Number.isSafeInteger(maxObjectBytes) ||
		maxObjectBytes < 1024 ||
		maxObjectBytes > 2_000_000 ||
		!Number.isSafeInteger(maxConflicts) ||
		maxConflicts < 0 ||
		maxConflicts > 32
	)
		throw new AtomicObjectJournalError("invalid-configuration");
	type State = Readonly<{
		entries: readonly FleetAssignment[];
		documents: ReadonlyMap<string, string>;
		seal?: ImmutableJournalSeal;
	}>;
	function encode(state: State): string {
		if (
			state.entries.some(
				(row) =>
					row.active !== undefined ||
					row.target !== undefined ||
					row.lossWindowMs !== undefined ||
					row.sealed,
			)
		)
			throw new AtomicObjectJournalError("invalid-log");
		const record = create(AtomicObjectJournalStateSchema, {
			contract: "hobo.atomic-object-journal/v1",
			fleetId,
			anchorDigest,
			member,
			initializationId,
			entries: state.entries.map((row) => ({
				epoch: row.epoch,
				sealed: row.sealed,
				reason: row.reason,
				decidedAtMs: row.decidedAtMs,
				decidedBy: row.decidedBy,
			})),
			documents: [...state.documents]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([digest, value]) => ({ digest, value })),
			...(state.seal ? { seal: state.seal } : undefined),
		});
		return toJsonString(AtomicObjectJournalStateSchema, record, {
			alwaysEmitImplicit: true,
		});
	}
	function decode(body: string): State {
		if (bytes(body) > maxObjectBytes)
			throw new AtomicObjectJournalError("object-too-large");
		try {
			const raw = fromJsonString(AtomicObjectJournalStateSchema, body);
			if (
				raw.contract !== "hobo.atomic-object-journal/v1" ||
				raw.fleetId !== fleetId ||
				raw.anchorDigest !== anchorDigest ||
				raw.initializationId !== initializationId ||
				!raw.member ||
				raw.entries.length > maxEntries + 1
			)
				throw new AtomicObjectJournalError("identity-unverified");
			const recordedMember = raw.member;
			if (memberKeys.some((key) => recordedMember[key] !== member[key]))
				throw new AtomicObjectJournalError("identity-unverified");
			const documents = new Map<string, string>();
			for (const doc of raw.documents) {
				if (
					!HASH.test(doc.digest) ||
					bytes(doc.value) > maxDocumentBytes ||
					hash(doc.value) !== doc.digest ||
					documents.has(doc.digest)
				)
					throw new AtomicObjectJournalError("invalid-document");
				documents.set(doc.digest, doc.value);
			}
			let previous = ROOT;
			const entries = raw.entries.map((row, index): FleetAssignment => {
				if (row.sealed !== false)
					throw new AtomicObjectJournalError("invalid-log");
				const value = parseFleetAssignment({
					epoch: row.epoch,
					active: undefined,
					sealed: false,
					target: undefined,
					reason: row.reason,
					lossWindowMs: undefined,
					decidedAtMs: row.decidedAtMs,
					decidedBy: row.decidedBy,
				});
				const link = /^j:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(value.reason);
				if (
					value.epoch !== index + 1 ||
					value.decidedAtMs !== 0 ||
					value.decidedBy !== "journal" ||
					!link?.[1] ||
					!link[2] ||
					link[1] !== previous ||
					(index === 0 && link[2] !== genesisDigest) ||
					!documents.has(link[2])
				)
					throw new AtomicObjectJournalError("invalid-log");
				previous = link[2];
				return value;
			});
			let seal: ImmutableJournalSeal | undefined;
			if (raw.seal !== undefined) {
				if (
					!NAME.test(raw.seal.transitionId) ||
					!Number.isSafeInteger(raw.seal.epoch) ||
					raw.seal.epoch < 1 ||
					!HASH.test(raw.seal.digest) ||
					raw.seal.epoch !== entries.length ||
					raw.seal.digest !== previous
				)
					throw new AtomicObjectJournalError("invalid-seal");
				seal = {
					transitionId: raw.seal.transitionId,
					epoch: raw.seal.epoch,
					digest: raw.seal.digest,
				};
			}
			const state: State = {
				entries,
				documents,
				...(seal ? { seal } : undefined),
			};
			if (encode(state) !== body)
				throw new AtomicObjectJournalError("invalid-object");
			return state;
		} catch (error) {
			if (error instanceof AtomicObjectJournalError) throw error;
			throw new AtomicObjectJournalError("invalid-object");
		}
	}
	async function read(): Promise<State & { version: string }> {
		let value: Awaited<ReturnType<AtomicJournalObject["read"]>>;
		try {
			value = await object.read();
		} catch {
			throw new AtomicObjectJournalError("read-unavailable");
		}
		if (!value) throw new AtomicObjectJournalError("identity-unverified");
		if (
			!value.version ||
			value.version.length > 512 ||
			/[\r\n]/u.test(value.version)
		)
			throw new AtomicObjectJournalError("invalid-version");
		return { ...decode(value.body), version: value.version };
	}
	async function replace(
		state: State,
		version: string,
	): Promise<"written" | "conflict" | "unknown"> {
		const body = encode(state);
		if (bytes(body) > maxObjectBytes - (state.seal ? 0 : SEAL_RESERVE_BYTES))
			throw new AtomicObjectJournalError("object-full");
		decode(body);
		try {
			const result = await object.replace(body, version);
			return result === "written" || result === "conflict" ? result : "unknown";
		} catch {
			return "unknown";
		}
	}
	const replica: SealableImmutableJournalReplica = {
		id: member.id,
		async read(limit) {
			if (
				limit !== undefined &&
				(!Number.isSafeInteger(limit) || limit < 1 || limit > maxEntries + 1)
			)
				throw new AtomicObjectJournalError("invalid-limit");
			const { entries } = await read();
			return entries.slice(-(limit ?? entries.length));
		},
		async readDocument(digest) {
			if (!HASH.test(digest))
				throw new AtomicObjectJournalError("invalid-digest");
			return (await read()).documents.get(digest);
		},
		async writeDocument(digest, value) {
			if (
				!HASH.test(digest) ||
				bytes(value) > maxDocumentBytes ||
				hash(value) !== digest
			)
				throw new AtomicObjectJournalError("invalid-document");
			for (let attempt = 0; attempt <= maxConflicts; attempt++) {
				const current = await read();
				const old = current.documents.get(digest);
				if (old !== undefined) {
					if (old !== value)
						throw new AtomicObjectJournalError("immutable-conflict");
					return;
				}
				if (current.seal)
					throw new AtomicObjectJournalError("generation-sealed");
				const documents = new Map(current.documents);
				documents.set(digest, value);
				const result = await replace(
					{ entries: current.entries, documents },
					current.version,
				);
				if (result === "written") return;
				if (result === "unknown") {
					const observed = await read();
					if (observed.documents.get(digest) === value) return;
					if (observed.seal)
						throw new AtomicObjectJournalError("generation-sealed");
					throw new AtomicObjectJournalError("write-outcome-unknown");
				}
			}
			throw new AtomicObjectJournalError("contention");
		},
		async accept(input) {
			const proposed = parseFleetAssignment(input);
			for (let attempt = 0; attempt <= maxConflicts; attempt++) {
				const current = await read();
				const old = current.entries[proposed.epoch - 1];
				if (old)
					return assignmentKey(old) === assignmentKey(proposed)
						? "duplicate"
						: "conflict";
				if (current.seal)
					throw new AtomicObjectJournalError("generation-sealed");
				if (proposed.epoch !== current.entries.length + 1) return "gap";
				const next = {
					entries: [...current.entries, proposed],
					documents: current.documents,
				};
				const result = await replace(next, current.version);
				if (result === "written") return "accepted";
				if (result === "unknown") {
					const observed = await read();
					const winner = observed.entries[proposed.epoch - 1];
					if (winner)
						return assignmentKey(winner) === assignmentKey(proposed)
							? "duplicate"
							: "conflict";
					if (observed.seal)
						throw new AtomicObjectJournalError("generation-sealed");
					throw new AtomicObjectJournalError("write-outcome-unknown");
				}
			}
			throw new AtomicObjectJournalError("contention");
		},
		async seal(input) {
			const wanted = Object.freeze({ ...input });
			if (
				!NAME.test(wanted.transitionId) ||
				!Number.isSafeInteger(wanted.epoch) ||
				wanted.epoch < 1 ||
				!HASH.test(wanted.digest)
			)
				throw new AtomicObjectJournalError("invalid-seal");
			for (let attempt = 0; attempt <= maxConflicts; attempt++) {
				const current = await read();
				if (current.seal)
					return sameSeal(current.seal, wanted) ? "duplicate" : "conflict";
				const head = current.entries.at(-1);
				if (
					head?.epoch !== wanted.epoch ||
					head.reason.split(":")[2] !== wanted.digest
				)
					return "conflict";
				const result = await replace(
					{
						entries: current.entries,
						documents: current.documents,
						seal: wanted,
					},
					current.version,
				);
				if (result === "written") return "sealed";
				if (result === "unknown") {
					const observed = await read();
					if (sameSeal(observed.seal, wanted)) return "duplicate";
					if (observed.seal || observed.entries.length !== wanted.epoch)
						return "conflict";
					throw new AtomicObjectJournalError("write-outcome-unknown");
				}
			}
			throw new AtomicObjectJournalError("contention");
		},
	};
	return Object.freeze({
		replica: Object.freeze(replica),
		async initializeFresh(verifyFresh) {
			try {
				await verifyFresh(member, initializationId);
			} catch {
				throw new AtomicObjectJournalError("freshness-unverified");
			}
			const initial = encode({ entries: [], documents: new Map() });
			if (bytes(initial) > maxObjectBytes - SEAL_RESERVE_BYTES)
				throw new AtomicObjectJournalError("object-full");
			let outcome: "created" | "conflict" | "unknown";
			try {
				outcome = await object.create(initial);
			} catch {
				outcome = "unknown";
			}
			if (outcome === "created") return;
			// Readback establishes this exact incarnation, including an already
			// advanced matching initialization after a lost create response.
			await read();
		},
	});
}
