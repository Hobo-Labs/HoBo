/**
 * A durable, majority-chosen command log over HoBo fleet assignments.
 *
 * This primitive does not itself implement DurableEventStore, execute effects,
 * perform provider admission, or fence an external side effect. A host must
 * independently pin its immutable fleet anchor, fund each provider call, and
 * quarantine a replica restored from an older backup before it can vote.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@hobo/core";
import {
	type AssignmentReplica,
	assignmentKey,
	completeAssignment,
	fleetMajority,
	parseAssignmentRegister,
	proposeAssignment,
	readAssignmentReplies,
	resolveAssignment,
} from "./assignment.js";
import { parseFleetBackendId } from "./backend.js";
import { isJournalObject, isJournalString, parseJournalJson } from "./json.js";

export type ImmutableJournalMember = Readonly<{
	id: string;
	provider: string;
	accountId: string;
	resourceId: string;
	incarnation: string;
}>;
export interface ImmutableJournalReplica extends AssignmentReplica {
	/** Immutable, provider-owned storage; missing or lost tables must throw. */
	readDocument(digest: string): Promise<string | undefined>;
	/** Create only. Existing identical bytes succeed; different bytes fail. */
	writeDocument(digest: string, value: string): Promise<void>;
}
/** An irreversible local write fence at an exact committed assignment head.
 * A majority of these fences can close a generation; this alone does not
 * authorize a new generation or external effects. */
export type ImmutableJournalSeal = Readonly<{
	transitionId: string;
	epoch: number;
	digest: string;
}>;
export interface SealableImmutableJournalReplica
	extends ImmutableJournalReplica {
	seal(
		input: ImmutableJournalSeal,
	): Promise<"sealed" | "duplicate" | "conflict">;
}
export type ImmutableJournalEntry = Readonly<{
	position: number;
	digest: string;
	operationId: string;
	value: string;
}>;
export interface ImmutableJournal {
	readonly quorum: number;
	readonly fleetId: string;
	readonly anchorDigest: string;
	readonly members: readonly ImmutableJournalMember[];
	bootstrap(
		verifyFresh: (member: ImmutableJournalMember) => Promise<void>,
	): Promise<void>;
	read(): Promise<readonly ImmutableJournalEntry[]>;
	recover(): Promise<readonly ImmutableJournalEntry[]>;
	recoverBootstrap(
		verifyMember: (member: ImmutableJournalMember) => Promise<void>,
		expectedFirst?: Readonly<{ operationId: string; value: string }>,
	): Promise<readonly ImmutableJournalEntry[]>;
	append(
		operationId: string,
		value: string,
		expectedPosition: number,
	): Promise<ImmutableJournalEntry>;
}
export class ImmutableJournalError extends Error {
	constructor(readonly reason: string) {
		super(`immutable journal ${reason}`);
		this.name = "ImmutableJournalError";
	}
}

const HASH = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const ROOT = "0".repeat(64);
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const reason = (previous: string, digest: string) => `j:${previous}:${digest}`;
function parseReason(value: string) {
	const match = /^j:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(value);
	if (!match?.[1] || !match[2])
		throw new ImmutableJournalError("invalid-entry");
	return { previous: match[1], digest: match[2] };
}
function command(
	position: number,
	previous: string,
	operationId: string,
	value: string,
): string {
	return JSON.stringify({
		contract: "hobo.immutable-journal-command/v1",
		position,
		previous,
		operationId,
		value,
	});
}

/**
 * Each member is one independently admitted provider resource. `anchorDigest`
 * must come from an independent durable authority rather than the replicas
 * being initialized. `authorize` must fund and authenticate every call; it
 * must not charge the same uninitialized journal for its own bootstrap.
 */
export interface ImmutableJournalOptions {
	readonly fleetId: string;
	readonly members: readonly ImmutableJournalMember[];
	readonly anchorDigest: string;
	readonly replicas: readonly ImmutableJournalReplica[];
	readonly maxEntryBytes: number;
	readonly maxEntries: number;
	readonly authorize: (
		action: "bootstrap" | "read" | "append" | "recover",
	) => Promise<void>;
}

export function createImmutableJournal(
	input: ImmutableJournalOptions,
): ImmutableJournal {
	const { fleetId, anchorDigest, maxEntryBytes, maxEntries, authorize } = input;
	const members = Object.freeze(
		input.members.map((entry) => Object.freeze({ ...entry })),
	);
	const replicas = Object.freeze(
		input.replicas.map((replica) =>
			Object.freeze({
				id: replica.id,
				read: replica.read.bind(replica),
				accept: replica.accept.bind(replica),
				readDocument: replica.readDocument.bind(replica),
				writeDocument: replica.writeDocument.bind(replica),
			}),
		),
	);
	if (
		!NAME.test(fleetId) ||
		members.length < 3 ||
		members.length > 31 ||
		members.length % 2 === 0 ||
		replicas.length !== members.length ||
		new Set(members.map((entry) => entry.id)).size !== members.length ||
		new Set(
			members.map(
				(entry) => `${entry.provider}\0${entry.accountId}\0${entry.resourceId}`,
			),
		).size !== members.length ||
		members.some(
			(entry) =>
				!NAME.test(entry.provider) ||
				!NAME.test(entry.accountId) ||
				!NAME.test(entry.resourceId) ||
				!NAME.test(entry.incarnation),
		) ||
		!Number.isSafeInteger(maxEntryBytes) ||
		maxEntryBytes < 1 ||
		maxEntryBytes > 1_048_576 ||
		!Number.isSafeInteger(maxEntries) ||
		maxEntries < 1 ||
		maxEntries > 10_000 ||
		!HASH.test(anchorDigest)
	)
		throw new ImmutableJournalError("invalid-configuration");
	for (const member of members) parseFleetBackendId(member.id);
	const byId = new Map(replicas.map((replica) => [replica.id, replica]));
	if (
		byId.size !== members.length ||
		members.some((member) => !byId.has(member.id))
	)
		throw new ImmutableJournalError("invalid-membership");
	const anchor = JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId,
		members,
	});
	if (hash(anchor) !== anchorDigest)
		throw new ImmutableJournalError("anchor-mismatch");
	const genesis = command(0, ROOT, "genesis", anchor);
	const genesisDigest = hash(genesis);
	const maxDocumentBytes = Math.max(
		Buffer.byteLength(genesis, "utf8"),
		maxEntryBytes * 6 + 4096,
	);
	const offered = new Map<string, string>([[genesisDigest, genesis]]);
	async function admitted(action: "bootstrap" | "read" | "append" | "recover") {
		try {
			await authorize(action);
		} catch {
			throw new ImmutableJournalError("authorization-unavailable");
		}
	}

	async function document(digest: string): Promise<string> {
		const pending = offered.get(digest);
		if (pending !== undefined && hash(pending) === digest) return pending;
		const replies = await Promise.allSettled(
			replicas.map((replica) => replica.readDocument(digest)),
		);
		for (const reply of replies) {
			if (
				reply.status === "fulfilled" &&
				isJournalString(reply.value) &&
				Buffer.byteLength(reply.value, "utf8") <= maxDocumentBytes &&
				hash(reply.value) === digest
			)
				return reply.value;
		}
		throw new ImmutableJournalError("document-unavailable");
	}
	const guarded: AssignmentReplica[] = members.map((member) => {
		const replica = byId.get(member.id);
		if (!replica) throw new ImmutableJournalError("invalid-membership");
		return {
			id: replica.id,
			read: (limit) => replica.read(limit),
			async accept(entry) {
				const link = parseReason(entry.reason);
				if (
					entry.active !== undefined ||
					entry.sealed ||
					entry.target !== undefined ||
					entry.lossWindowMs !== undefined ||
					entry.decidedBy !== "journal" ||
					entry.decidedAtMs !== 0
				)
					throw new ImmutableJournalError("invalid-entry");
				const rows = await replica.read(1);
				const head = rows.at(-1);
				if (head?.epoch === entry.epoch) {
					if (assignmentKey(head) !== assignmentKey(entry)) return "conflict";
				} else if (entry.epoch === 1) {
					if (head || link.previous !== ROOT || link.digest !== genesisDigest)
						return "gap";
				} else if (
					!head ||
					head.epoch !== entry.epoch - 1 ||
					parseReason(head.reason).digest !== link.previous
				) {
					return "gap";
				}
				const body = await document(link.digest);
				await replica.writeDocument(link.digest, body);
				if ((await replica.readDocument(link.digest)) !== body)
					throw new ImmutableJournalError("document-unconfirmed");
				return replica.accept(entry);
			},
		};
	});
	const register = parseAssignmentRegister(guarded);

	async function chosen(
		recover: boolean,
	): Promise<readonly ImmutableJournalEntry[]> {
		let replies = await readAssignmentReplies(register, maxEntries + 1);
		let resolution = resolveAssignment(
			members.map((entry) => entry.id),
			replies,
		);
		if (resolution.status === "undecided" && recover) {
			await completeAssignment(register);
			replies = await readAssignmentReplies(register, maxEntries + 1);
			resolution = resolveAssignment(
				members.map((entry) => entry.id),
				replies,
			);
		}
		if (resolution.status !== "current")
			throw new ImmutableJournalError(
				resolution.status === "empty"
					? "not-initialized"
					: "quorum-unavailable",
			);
		if (resolution.assignment.epoch > maxEntries + 1)
			throw new ImmutableJournalError("retention-limit");
		const holder = replies.find(
			(reply) =>
				"rows" in reply &&
				resolution.status === "current" &&
				resolution.holders.includes(reply.replica),
		);
		if (
			!holder ||
			!("rows" in holder) ||
			holder.rows.length !== resolution.assignment.epoch
		)
			throw new ImmutableJournalError("history-unavailable");
		let previous = ROOT;
		const entries: ImmutableJournalEntry[] = [];
		for (const [index, row] of holder.rows.entries()) {
			const link = parseReason(row.reason);
			if (
				row.epoch !== index + 1 ||
				link.previous !== previous ||
				(index === 0 && link.digest !== genesisDigest) ||
				row.active !== undefined ||
				row.sealed ||
				row.target !== undefined ||
				row.lossWindowMs !== undefined ||
				row.decidedBy !== "journal" ||
				row.decidedAtMs !== 0
			)
				throw new ImmutableJournalError("history-mismatch");
			const body = await document(link.digest);
			let value: JsonValue;
			try {
				value = parseJournalJson(body);
			} catch {
				throw new ImmutableJournalError("invalid-document");
			}
			if (
				!isJournalObject(value) ||
				!("contract" in value) ||
				value.contract !== "hobo.immutable-journal-command/v1" ||
				!("position" in value) ||
				value.position !== index ||
				!("previous" in value) ||
				value.previous !== previous ||
				!("operationId" in value) ||
				!isJournalString(value.operationId) ||
				!("value" in value) ||
				!isJournalString(value.value) ||
				command(index, previous, value.operationId, value.value) !== body ||
				(index === 0 &&
					(value.operationId !== "genesis" || value.value !== anchor))
			)
				throw new ImmutableJournalError("invalid-document");
			if (index > 0)
				entries.push(
					Object.freeze({
						position: index,
						digest: link.digest,
						operationId: value.operationId,
						value: value.value,
					}),
				);
			previous = link.digest;
		}
		return entries;
	}

	return Object.freeze({
		fleetId,
		anchorDigest,
		members,
		/** Only an independently verified fresh fleet can create or resume genesis. */
		async bootstrap(
			verifyFresh: (member: ImmutableJournalMember) => Promise<void>,
		): Promise<void> {
			await admitted("bootstrap");
			try {
				await Promise.all(members.map((member) => verifyFresh(member)));
			} catch {
				throw new ImmutableJournalError("freshness-unverified");
			}
			const replies = await readAssignmentReplies(register, 2);
			if (
				replies.length !== members.length ||
				replies.some(
					(reply) =>
						!("rows" in reply) ||
						reply.rows.length > 1 ||
						(reply.rows.length === 1 &&
							(reply.rows[0]?.epoch !== 1 ||
								reply.rows[0]?.reason !== reason(ROOT, genesisDigest))),
				)
			)
				throw new ImmutableJournalError("freshness-unverified");
			const resolved = resolveAssignment(
				members.map((entry) => entry.id),
				replies,
			);
			if (resolved.status === "empty")
				await proposeAssignment(register, {
					expectedEpoch: 0,
					value: {
						active: undefined,
						sealed: false,
						target: undefined,
						reason: reason(ROOT, genesisDigest),
						lossWindowMs: undefined,
					},
					decidedBy: "journal",
					nowMs: 0,
				});
			else if (resolved.status !== "current" && resolved.status !== "undecided")
				throw new ImmutableJournalError("quorum-unavailable");
			await completeAssignment(register);
			await chosen(false);
		},
		async read(): Promise<readonly ImmutableJournalEntry[]> {
			await admitted("read");
			// A read does not repair an interrupted writer; recovery needs a
			// separately funded append operation.
			return chosen(false);
		},
		/** Funded recovery finishes an already offered entry; it invents none. */
		async recover(): Promise<readonly ImmutableJournalEntry[]> {
			await admitted("recover");
			return chosen(true);
		},
		/** During bootstrap, all enrolled voters must first prove their own
		 * exact anchored prefix. An unavailable or foreign voter is not a
		 * successful initialization and cannot be skipped as a degraded member. */
		async recoverBootstrap(
			verifyMember: (member: ImmutableJournalMember) => Promise<void>,
			expectedFirst?: Readonly<{ operationId: string; value: string }>,
		): Promise<readonly ImmutableJournalEntry[]> {
			await admitted("bootstrap");
			try {
				if (
					expectedFirst &&
					(!NAME.test(expectedFirst.operationId) ||
						expectedFirst.operationId === "genesis" ||
						!isJournalString(expectedFirst.value) ||
						Buffer.byteLength(expectedFirst.value, "utf8") > maxEntryBytes)
				)
					throw new Error("invalid expected first command");
				await Promise.all(members.map((member) => verifyMember(member)));
				const replies = await readAssignmentReplies(register, maxEntries + 1);
				if (replies.length !== members.length) throw new Error("missing voter");
				for (const reply of replies) {
					if (!("rows" in reply) || reply.rows.length === 0)
						throw new Error("missing voter history");
					const replica = byId.get(reply.replica);
					if (
						!replica ||
						reply.rows.length > maxEntries + 1 ||
						(expectedFirst && reply.rows.length > 2)
					)
						throw new Error("invalid voter history");
					let previous = ROOT;
					for (const [index, row] of reply.rows.entries()) {
						const link = parseReason(row.reason);
						if (
							row.epoch !== index + 1 ||
							link.previous !== previous ||
							(index === 0 && link.digest !== genesisDigest) ||
							row.active !== undefined ||
							row.sealed ||
							row.target !== undefined ||
							row.lossWindowMs !== undefined ||
							row.decidedBy !== "journal" ||
							row.decidedAtMs !== 0
						)
							throw new Error("invalid voter prefix");
						const body = await replica.readDocument(link.digest);
						if (
							!body ||
							Buffer.byteLength(body, "utf8") > maxDocumentBytes ||
							hash(body) !== link.digest
						)
							throw new Error("invalid voter document");
						const value = parseJournalJson(body);
						if (
							!isJournalObject(value) ||
							!("contract" in value) ||
							value.contract !== "hobo.immutable-journal-command/v1" ||
							!("position" in value) ||
							value.position !== index ||
							!("previous" in value) ||
							value.previous !== previous ||
							!("operationId" in value) ||
							!isJournalString(value.operationId) ||
							!("value" in value) ||
							!isJournalString(value.value) ||
							command(index, previous, value.operationId, value.value) !==
								body ||
							(index === 0 &&
								(value.operationId !== "genesis" || value.value !== anchor))
						)
							throw new Error("invalid voter command");
						if (
							index === 1 &&
							expectedFirst &&
							(value.operationId !== expectedFirst.operationId ||
								value.value !== expectedFirst.value)
						)
							throw new Error("unexpected first command");
						previous = link.digest;
					}
				}
			} catch {
				throw new ImmutableJournalError("bootstrap-recovery-unverified");
			}
			return chosen(true);
		},
		async append(
			operationId: string,
			value: string,
			expectedPosition: number,
		): Promise<ImmutableJournalEntry> {
			if (
				!NAME.test(operationId) ||
				operationId === "genesis" ||
				!isJournalString(value) ||
				!Number.isSafeInteger(expectedPosition) ||
				expectedPosition < 0 ||
				Buffer.byteLength(value, "utf8") > maxEntryBytes
			)
				throw new ImmutableJournalError("invalid-command");
			await admitted("append");
			{
				const entries = await chosen(true);
				const replay = entries.find(
					(entry) => entry.operationId === operationId,
				);
				if (replay) {
					if (replay.value !== value)
						throw new ImmutableJournalError("operation-conflict");
					return replay;
				}
				if (entries.length !== expectedPosition)
					throw new ImmutableJournalError("head-conflict");
				if (entries.length >= maxEntries)
					throw new ImmutableJournalError("retention-limit");
				const previous = entries.at(-1)?.digest ?? genesisDigest;
				const body = command(entries.length + 1, previous, operationId, value);
				const digest = hash(body);
				offered.set(digest, body);
				try {
					await proposeAssignment(register, {
						expectedEpoch: entries.length + 1,
						value: {
							active: undefined,
							sealed: false,
							target: undefined,
							reason: reason(previous, digest),
							lossWindowMs: undefined,
						},
						decidedBy: "journal",
						nowMs: 0,
					});
					await completeAssignment(register);
					const next = await chosen(true);
					const accepted = next.find(
						(entry) => entry.operationId === operationId,
					);
					if (accepted) {
						if (accepted.value !== value)
							throw new ImmutableJournalError("operation-conflict");
						return accepted;
					}
					if (next.length !== expectedPosition)
						throw new ImmutableJournalError("head-conflict");
				} finally {
					offered.delete(digest);
				}
			}
			throw new ImmutableJournalError("outcome-unknown");
		},
		quorum: fleetMajority(members.length),
	});
}
