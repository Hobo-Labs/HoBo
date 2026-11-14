/**
 * A crash-resumable, bounded journal generation cutover. An independently
 * anchored control journal chooses one intent before voters are sealed.
 * The checkpoint retains exact prior commands: this is a bounded history
 * handoff, not an application-state snapshot or an unbounded compactor.
 */
import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	createImmutableJournal,
	type ImmutableJournal,
	type ImmutableJournalEntry,
	type ImmutableJournalMember,
	type ImmutableJournalOptions,
	type ImmutableJournalSeal,
	type SealableImmutableJournalReplica,
} from "./immutable-journal.js";
import {
	isJournalNumber,
	isJournalObject,
	isJournalString,
	parseJournalJson,
} from "./json.js";

const HASH = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const ROOT = "0".repeat(64);
const CHECKPOINT = "hobo:rollover:checkpoint:";
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
type JournalIdentity = Readonly<{
	fleetId: string;
	anchorDigest: string;
	members: readonly ImmutableJournalMember[];
}>;
type Checkpoint = Readonly<{
	contract: "hobo.journal-rollover-checkpoint/v1";
	source: JournalIdentity;
	head: ImmutableJournalSeal;
	history: readonly ImmutableJournalEntry[];
}>;
type Intent = Readonly<{
	contract: "hobo.journal-rollover-intent/v1";
	transitionId: string;
	source: JournalIdentity;
	destination: JournalIdentity;
	head: ImmutableJournalSeal;
	history: readonly ImmutableJournalEntry[];
}>;
export class JournalRolloverError extends Error {
	constructor(readonly reason: string) {
		super(`journal rollover ${reason}`);
		this.name = "JournalRolloverError";
	}
}
function identity(journal: ImmutableJournal): JournalIdentity {
	return {
		fleetId: journal.fleetId,
		anchorDigest: journal.anchorDigest,
		members: journal.members.map((entry) => ({ ...entry })),
	};
}
function anchor(source: JournalIdentity): string {
	return JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId: source.fleetId,
		members: source.members,
	});
}
function genesis(source: JournalIdentity): string {
	return hash(
		JSON.stringify({
			contract: "hobo.immutable-journal-command/v1",
			position: 0,
			previous: ROOT,
			operationId: "genesis",
			value: anchor(source),
		}),
	);
}
function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function parseIdentity(value: JsonValue | undefined): JournalIdentity {
	if (
		!isJournalObject(value) ||
		!exactKeys(value, ["fleetId", "anchorDigest", "members"]) ||
		!isJournalString(value.fleetId) ||
		!NAME.test(value.fleetId) ||
		!isJournalString(value.anchorDigest) ||
		!HASH.test(value.anchorDigest) ||
		!Array.isArray(value.members) ||
		value.members.length < 3 ||
		value.members.length > 31 ||
		value.members.length % 2 === 0
	)
		throw new JournalRolloverError("identity-invalid");
	const members = value.members.map((entry) => {
		if (
			!isJournalObject(entry) ||
			!exactKeys(entry, [
				"id",
				"provider",
				"accountId",
				"resourceId",
				"incarnation",
			]) ||
			Object.values(entry).some(
				(field) => !isJournalString(field) || !NAME.test(field),
			)
		)
			throw new JournalRolloverError("identity-invalid");
		return {
			...entry,
			id: String(entry.id),
			provider: String(entry.provider),
			accountId: String(entry.accountId),
			resourceId: String(entry.resourceId),
			incarnation: String(entry.incarnation),
		};
	});
	if (
		new Set(members.map((entry) => entry.id)).size !== members.length ||
		new Set(
			members.map((entry) =>
				JSON.stringify([entry.provider, entry.accountId, entry.resourceId]),
			),
		).size !== members.length
	)
		throw new JournalRolloverError("identity-invalid");
	const result = {
		fleetId: value.fleetId,
		anchorDigest: value.anchorDigest,
		members,
	};
	if (hash(anchor(result)) !== result.anchorDigest)
		throw new JournalRolloverError("identity-invalid");
	return result;
}
function parseHead(value: JsonValue | undefined): ImmutableJournalSeal {
	if (
		!isJournalObject(value) ||
		!exactKeys(value, ["transitionId", "epoch", "digest"]) ||
		!isJournalString(value.transitionId) ||
		!NAME.test(value.transitionId) ||
		!isJournalNumber(value.epoch) ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch < 1 ||
		!isJournalString(value.digest) ||
		!HASH.test(value.digest)
	)
		throw new JournalRolloverError("head-invalid");
	return {
		transitionId: value.transitionId,
		epoch: value.epoch,
		digest: value.digest,
	};
}
function parseHistory(
	value: JsonValue | undefined,
	source: JournalIdentity,
	head: ImmutableJournalSeal,
): ImmutableJournalEntry[] {
	if (
		!Array.isArray(value) ||
		value.length > 10_000 ||
		head.epoch !== value.length + 1
	)
		throw new JournalRolloverError("history-invalid");
	const ids = new Set<string>();
	let previous = genesis(source);
	const history = value.map((entry, index) => {
		if (
			!isJournalObject(entry) ||
			!exactKeys(entry, ["position", "digest", "operationId", "value"]) ||
			entry.position !== index + 1 ||
			!isJournalString(entry.digest) ||
			!HASH.test(entry.digest) ||
			!isJournalString(entry.operationId) ||
			!NAME.test(entry.operationId) ||
			entry.operationId === "genesis" ||
			!isJournalString(entry.value) ||
			ids.has(entry.operationId)
		)
			throw new JournalRolloverError("history-invalid");
		ids.add(entry.operationId);
		const encoded = JSON.stringify({
			contract: "hobo.immutable-journal-command/v1",
			position: index + 1,
			previous,
			operationId: entry.operationId,
			value: entry.value,
		});
		if (hash(encoded) !== entry.digest)
			throw new JournalRolloverError("history-invalid");
		previous = entry.digest;
		return {
			position: index + 1,
			digest: entry.digest,
			operationId: entry.operationId,
			value: entry.value,
		};
	});
	if (head.digest !== previous)
		throw new JournalRolloverError("history-invalid");
	return history;
}
function parseIntent(text: string): Intent {
	let value: JsonValue;
	try {
		value = parseJournalJson(text);
	} catch {
		throw new JournalRolloverError("intent-invalid");
	}
	if (
		!isJournalObject(value) ||
		!exactKeys(value, [
			"contract",
			"transitionId",
			"source",
			"destination",
			"head",
			"history",
		]) ||
		value.contract !== "hobo.journal-rollover-intent/v1" ||
		!isJournalString(value.transitionId) ||
		!NAME.test(value.transitionId)
	)
		throw new JournalRolloverError("intent-invalid");
	const source = parseIdentity(value.source),
		destination = parseIdentity(value.destination),
		head = parseHead(value.head);
	const history = parseHistory(value.history, source, head);
	if (head.transitionId !== value.transitionId)
		throw new JournalRolloverError("intent-invalid");
	const result: Intent = {
		contract: "hobo.journal-rollover-intent/v1",
		transitionId: value.transitionId,
		source,
		destination,
		head,
		history,
	};
	if (JSON.stringify(result) !== text)
		throw new JournalRolloverError("intent-invalid");
	return result;
}
function checkpoint(intent: Intent): string {
	return JSON.stringify({
		contract: "hobo.journal-rollover-checkpoint/v1",
		source: intent.source,
		head: intent.head,
		history: intent.history,
	} satisfies Checkpoint);
}
function flatten(
	entries: readonly ImmutableJournalEntry[],
	depth = 0,
): ImmutableJournalEntry[] {
	if (depth > 64) throw new JournalRolloverError("checkpoint-depth-exceeded");
	const first = entries[0];
	let prior: ImmutableJournalEntry[] = [];
	if (first?.operationId.startsWith(CHECKPOINT)) {
		let raw: JsonValue;
		try {
			raw = parseJournalJson(first.value);
		} catch {
			throw new JournalRolloverError("checkpoint-invalid");
		}
		if (
			!isJournalObject(raw) ||
			!exactKeys(raw, ["contract", "source", "head", "history"]) ||
			raw.contract !== "hobo.journal-rollover-checkpoint/v1"
		)
			throw new JournalRolloverError("checkpoint-invalid");
		const source = parseIdentity(raw.source),
			head = parseHead(raw.head),
			history = parseHistory(raw.history, source, head);
		if (
			first.operationId !== `${CHECKPOINT}${head.transitionId}` ||
			JSON.stringify({ contract: raw.contract, source, head, history }) !==
				first.value
		)
			throw new JournalRolloverError("checkpoint-invalid");
		prior = flatten(history, depth + 1);
	}
	const current = first?.operationId.startsWith(CHECKPOINT)
		? entries.slice(1)
		: entries;
	const combined = [...prior, ...current];
	if (
		new Set(combined.map((entry) => entry.operationId)).size !== combined.length
	)
		throw new JournalRolloverError("operation-history-conflict");
	return combined.map((entry, index) => ({ ...entry, position: index + 1 }));
}

/** All replicas are the same exact provider adapters used by the constructed old
 * journal. The separate control journal is the durable transition authority;
 * its independent genesis, provider identities, anti-rollback and funding must
 * already have been verified by the supervisor. */
export function createImmutableJournalRollover(options: {
	readonly old: Omit<ImmutableJournalOptions, "replicas"> & {
		readonly replicas: readonly SealableImmutableJournalReplica[];
	};
	readonly next: ImmutableJournalOptions;
	readonly control: ImmutableJournalOptions;
	readonly timeoutMs: number;
	/** Revalidates the independently approved transition and its funding on
	 * every phase, including the exact source, destination and control fleet. */
	readonly authorize: (
		action: "prepare" | "seal" | "activate" | "open",
		scope: Readonly<{
			source: JournalIdentity;
			destination: JournalIdentity;
			control: JournalIdentity;
			transitionId: string;
		}>,
	) => Promise<void>;
}) {
	if (
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 60_000 ||
		!(options.authorize instanceof Function)
	)
		throw new JournalRolloverError("configuration-invalid");
	const old = createImmutableJournal(options.old),
		next = createImmutableJournal(options.next),
		control = createImmutableJournal(options.control);
	const oldIdentity = identity(old),
		nextIdentity = identity(next);
	const location = (member: ImmutableJournalMember) =>
		JSON.stringify([member.provider, member.accountId, member.resourceId]);
	const controlled = new Set(control.members.map(location));
	if (
		old.anchorDigest === next.anchorDigest ||
		old.anchorDigest === control.anchorDigest ||
		next.anchorDigest === control.anchorDigest ||
		[...old.members, ...next.members].some((member) =>
			controlled.has(location(member)),
		)
	)
		throw new JournalRolloverError("control-not-independent");
	const replicas = options.old.replicas.map((replica) => ({
		id: replica.id,
		seal: replica.seal.bind(replica),
	}));
	if (
		replicas.length !== old.members.length ||
		replicas.some((replica, index) => replica.id !== old.members[index]?.id)
	)
		throw new JournalRolloverError("membership-invalid");
	const timeoutMs = options.timeoutMs,
		authorize = options.authorize.bind(options),
		controlLimit = options.control.maxEntryBytes,
		checkpointLimit = options.next.maxEntryBytes;
	// Coordinators agree on one destination per *source head*. If a minority
	// seal loses a race with a later majority write, that later head can have a
	// new intent: the old head can no longer acquire a seal quorum.
	const intentPrefix = `hobo:rollover:intent:${old.anchorDigest}:`;
	const activationId = `hobo:rollover:activate:${old.anchorDigest}`;
	const transitionId = `rollover-${hash(JSON.stringify([old.anchorDigest, next.anchorDigest]))}`;
	const checkpointId = `${CHECKPOINT}${transitionId}`;
	const authorizationScope = Object.freeze({
		source: structuredClone(oldIdentity),
		destination: structuredClone(nextIdentity),
		control: identity(control),
		transitionId,
	});
	async function permitted(action: "prepare" | "seal" | "activate" | "open") {
		try {
			await authorize(action, structuredClone(authorizationScope));
		} catch {
			throw new JournalRolloverError("authorization-unavailable");
		}
	}
	async function controlRows(recover: boolean) {
		return recover ? control.recover() : control.read();
	}
	function intentFrom(
		rows: readonly ImmutableJournalEntry[],
	): Intent | undefined {
		let previous: Intent | undefined;
		for (const row of rows) {
			if (!row.operationId.startsWith(intentPrefix)) continue;
			const intent = parseIntent(row.value);
			const expectedTransition = `rollover-${hash(JSON.stringify([intent.source.anchorDigest, intent.destination.anchorDigest]))}`;
			if (
				intent.transitionId !== expectedTransition ||
				JSON.stringify(intent.source) !== JSON.stringify(oldIdentity) ||
				row.operationId !== `${intentPrefix}${intent.head.digest}` ||
				(previous &&
					(intent.head.epoch <= previous.head.epoch ||
						!extendsHistory(intent.history, previous.history)))
			)
				throw new JournalRolloverError("transition-conflict");
			previous = intent;
		}
		return previous;
	}
	function extendsHistory(
		history: readonly ImmutableJournalEntry[],
		prior: readonly ImmutableJournalEntry[],
	): boolean {
		return (
			history.length >= prior.length &&
			prior.every(
				(entry, index) =>
					JSON.stringify(entry) === JSON.stringify(history[index]),
			)
		);
	}
	function ours(intent: Intent): boolean {
		return JSON.stringify(intent.destination) === JSON.stringify(nextIdentity);
	}
	function activationValue(intent: Intent) {
		return JSON.stringify({
			contract: "hobo.journal-rollover-activation/v1",
			transitionId: intent.transitionId,
			intentDigest: hash(JSON.stringify(intent)),
			destinationAnchorDigest: intent.destination.anchorDigest,
		});
	}
	function active(
		rows: readonly ImmutableJournalEntry[],
		intent: Intent,
	): boolean {
		const value = rows.find(
			(entry) => entry.operationId === activationId,
		)?.value;
		if (value === undefined) return false;
		if (value !== activationValue(intent))
			throw new JournalRolloverError("activation-conflict");
		return true;
	}
	async function chooseIntent(minimumEpoch = 0): Promise<Intent> {
		await permitted("prepare");
		for (let attempt = 0; attempt < 8; attempt++) {
			const rows = await controlRows(true);
			const existing = intentFrom(rows);
			if (existing && active(rows, existing)) {
				if (!ours(existing))
					throw new JournalRolloverError("transition-conflict");
				return existing;
			}
			if (existing && existing.head.epoch >= minimumEpoch && ours(existing))
				return existing;
			const history = await old.recover();
			if (existing && history.length + 1 <= existing.head.epoch)
				throw new JournalRolloverError(
					ours(existing) ? "source-head-not-advanced" : "transition-conflict",
				);
			if (existing && !extendsHistory(history, existing.history))
				throw new JournalRolloverError("source-history-conflict");
			const head: ImmutableJournalSeal = {
				transitionId,
				epoch: history.length + 1,
				digest: history.at(-1)?.digest ?? genesis(oldIdentity),
			};
			const intent: Intent = {
				contract: "hobo.journal-rollover-intent/v1",
				transitionId,
				source: oldIdentity,
				destination: nextIdentity,
				head,
				history,
			};
			const value = JSON.stringify(intent);
			parseIntent(value);
			if (
				Buffer.byteLength(value, "utf8") > controlLimit ||
				Buffer.byteLength(checkpoint(intent), "utf8") > checkpointLimit
			)
				throw new JournalRolloverError("checkpoint-too-large");
			const current = await next.read();
			if (current.length !== 0)
				throw new JournalRolloverError("destination-not-fresh");
			try {
				await control.append(
					`${intentPrefix}${head.digest}`,
					value,
					rows.length,
				);
				return intent;
			} catch (error) {
				const later = await controlRows(true);
				const winner = intentFrom(later);
				if (winner && winner.head.epoch >= head.epoch) {
					if (!ours(winner))
						throw new JournalRolloverError("transition-conflict");
					return winner;
				}
				if (!(error instanceof Error) || !/head-conflict/u.test(error.message))
					throw error;
			}
		}
		throw new JournalRolloverError("control-contention");
	}
	function timed<T>(task: Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new JournalRolloverError("voter-timeout")),
				timeoutMs,
			);
			task.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
	async function seal(intent: Intent) {
		await permitted("seal");
		const replies = await Promise.allSettled(
			replicas.map((replica) => timed(replica.seal(intent.head))),
		);
		const confirmed = replies.filter(
			(reply) =>
				reply.status === "fulfilled" &&
				(reply.value === "sealed" || reply.value === "duplicate"),
		).length;
		if (confirmed < old.quorum)
			throw new JournalRolloverError("seal-unconfirmed");
	}
	async function commitActivation(intent: Intent) {
		await permitted("activate");
		const value = checkpoint(intent);
		const before = await next.recover();
		if (
			before.length &&
			(before[0]?.operationId !== checkpointId ||
				before[0].value !== value ||
				before.length > 1)
		)
			throw new JournalRolloverError("destination-not-fresh");
		if (!before.length) await next.append(checkpointId, value, 0);
		for (let attempt = 0; attempt < 8; attempt++) {
			const rows = await controlRows(true);
			const found = intentFrom(rows);
			if (!found || JSON.stringify(found) !== JSON.stringify(intent))
				throw new JournalRolloverError("intent-changed");
			if (active(rows, intent)) return;
			const confirmed = await next.recover();
			if (
				confirmed.length !== 1 ||
				confirmed[0]?.operationId !== checkpointId ||
				confirmed[0].value !== value
			)
				throw new JournalRolloverError("destination-not-fresh");
			await permitted("activate");
			try {
				await control.append(
					activationId,
					activationValue(intent),
					rows.length,
				);
				return;
			} catch (error) {
				const later = await controlRows(true);
				const candidate = intentFrom(later);
				if (candidate && active(later, candidate)) return;
				if (!(error instanceof Error) || !/head-conflict/u.test(error.message))
					throw error;
			}
		}
		throw new JournalRolloverError("control-contention");
	}
	async function opened(
		recover: boolean,
	): Promise<{ intent: Intent; rows: readonly ImmutableJournalEntry[] }> {
		await permitted("open");
		const records = await controlRows(recover),
			intent = intentFrom(records);
		if (!intent || !active(records, intent))
			throw new JournalRolloverError("generation-not-active");
		if (!ours(intent)) throw new JournalRolloverError("transition-conflict");
		const rows = recover ? await next.recover() : await next.read();
		if (
			rows[0]?.operationId !== checkpointId ||
			rows[0]?.value !== checkpoint(intent)
		)
			throw new JournalRolloverError("checkpoint-mismatch");
		return { intent, rows };
	}
	const journal: ImmutableJournal = Object.freeze<ImmutableJournal>({
		fleetId: next.fleetId,
		anchorDigest: next.anchorDigest,
		members: next.members,
		quorum: next.quorum,
		async bootstrap() {
			throw new JournalRolloverError("already-bootstrapped");
		},
		async recoverBootstrap() {
			throw new JournalRolloverError("already-bootstrapped");
		},
		async read() {
			return flatten((await opened(false)).rows);
		},
		async recover() {
			return flatten((await opened(true)).rows);
		},
		async append(operationId, value, expectedPosition) {
			if (operationId.startsWith("hobo:rollover:"))
				throw new JournalRolloverError("reserved-operation-id");
			const current = await opened(true),
				visible = flatten(current.rows),
				prior = visible.find((entry) => entry.operationId === operationId);
			if (prior) {
				if (prior.value !== value)
					throw new JournalRolloverError("operation-conflict");
				return prior;
			}
			if (expectedPosition !== visible.length)
				throw new JournalRolloverError("head-conflict");
			const result = await next.append(operationId, value, current.rows.length);
			return { ...result, position: visible.length + 1 };
		},
	});
	return Object.freeze({
		old,
		journal,
		/** Re-entry resumes the chosen intent, or supersedes a minority seal
		 * only after independently reading a newer majority-chosen source head. */
		async cutover() {
			let minimumEpoch = 0;
			for (let attempt = 0; attempt < 8; attempt++) {
				const intent = await chooseIntent(minimumEpoch),
					rows = await controlRows(true);
				if (!active(rows, intent)) {
					try {
						await seal(intent);
					} catch (error) {
						if (
							!(error instanceof JournalRolloverError) ||
							error.reason !== "seal-unconfirmed"
						)
							throw error;
						let latest: readonly ImmutableJournalEntry[];
						try {
							latest = await old.recover();
						} catch {
							throw error;
						}
						if (
							latest.length + 1 <= intent.head.epoch ||
							!extendsHistory(latest, intent.history)
						)
							throw error;
						minimumEpoch = intent.head.epoch + 1;
						continue;
					}
					await commitActivation(intent);
				}
				await opened(true);
				return Object.freeze({
					transitionId,
					oldHead: intent.head,
					historyEntries: flatten(intent.history).length,
					journal,
				});
			}
			throw new JournalRolloverError("source-contention");
		},
		async open() {
			await opened(false);
			return journal;
		},
	});
}
