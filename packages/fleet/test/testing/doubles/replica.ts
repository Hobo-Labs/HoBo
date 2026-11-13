/**
 * An in-memory assignment replica that keeps the register's rules (the
 * conformance suite's reference), and replicas broken in exactly one way each,
 * keyed by the replica assertion that must catch the break.
 */
import { type MemberName, parseMemberName } from "../../../src/ids.js";
import type {
	AssignmentAcceptOutcome,
	AssignmentEntry,
	AssignmentReplica,
} from "../../../src/ports.js";
import type { ReplicaMake } from "../../../src/testing/conformance/replica.js";

type Rules = Readonly<{
	id: (id: MemberName) => MemberName;
	read: (
		entries: readonly AssignmentEntry[],
		limit: number | undefined,
	) => readonly AssignmentEntry[];
	accept: (
		entries: readonly AssignmentEntry[],
		entry: AssignmentEntry,
	) => AssignmentAcceptOutcome;
	refresh: (entries: readonly AssignmentEntry[]) => boolean;
	seed: (entries: readonly AssignmentEntry[]) => "seeded" | "not-empty";
}>;

const same = (a: AssignmentEntry, b: AssignmentEntry) =>
	JSON.stringify(a) === JSON.stringify(b);

const RULES: Rules = {
	id: (id) => id,
	read: (entries, limit) =>
		limit === undefined ? entries : entries.slice(-limit),
	accept(entries, entry) {
		const held = entries.find((row) => row.epoch === entry.epoch);
		if (held !== undefined) return same(held, entry) ? "duplicate" : "conflict";
		const first = entries[0]?.epoch;
		if (first !== undefined && entry.epoch < first) return "conflict";
		const top = entries.at(-1)?.epoch ?? 0;
		return entry.epoch === top + 1 ? "accepted" : "gap";
	},
	refresh: (entries) => entries.length > 0,
	seed: (entries) => (entries.length === 0 ? "seeded" : "not-empty"),
};

function replicaWith(rules: Rules): ReplicaMake {
	return (id) => {
		let entries: AssignmentEntry[] = [];
		const replica: AssignmentReplica = {
			id: rules.id(id),
			async read(limit) {
				return rules.read(entries, limit).map((row) => ({ ...row }));
			},
			async accept(entry) {
				const outcome = rules.accept(entries, entry);
				if (outcome === "accepted")
					entries = [
						...entries.filter((row) => row.epoch !== entry.epoch),
						{ ...entry },
					].sort((a, b) => a.epoch - b.epoch);
				return outcome;
			},
			async refresh() {
				return rules.refresh(entries);
			},
			async seed(entry) {
				const outcome = rules.seed(entries);
				if (outcome === "seeded") entries = [{ ...entry }];
				return outcome;
			},
		};
		return replica;
	};
}

/** The reference replica: passes `runReplicaConformance`. */
export const memoryReplica: ReplicaMake = replicaWith(RULES);

const broken = (change: Partial<Rules>): ReplicaMake =>
	replicaWith({ ...RULES, ...change });

const PHANTOM: AssignmentEntry = {
	epoch: 0,
	active: undefined,
	sealed: false,
	target: undefined,
	reason: "phantom",
	lossWindowMs: undefined,
	decidedAtMs: 0,
	decidedBy: "phantom",
	members: undefined,
};

export const BROKEN_REPLICAS: ReadonlyMap<string, ReplicaMake> = new Map([
	[
		"the replica answers to the id it was made with",
		broken({ id: (id) => parseMemberName(`${id}-copy`) }),
	],
	[
		"a new replica reads an empty log",
		broken({
			read: (entries, limit) =>
				entries.length === 0 ? [{ ...PHANTOM }] : RULES.read(entries, limit),
		}),
	],
	[
		"an empty log takes epoch 1 only",
		broken({
			accept: (entries, entry) =>
				entries.length === 0 ? "accepted" : RULES.accept(entries, entry),
		}),
	],
	[
		"the next epoch is accepted and reads back exactly as accepted",
		broken({
			read: (entries, limit) =>
				RULES.read(entries, limit).map((row) => ({
					...row,
					members: undefined,
				})),
		}),
	],
	[
		"the identical entry again answers duplicate",
		broken({
			accept: (entries, entry) => {
				const outcome = RULES.accept(entries, entry);
				return outcome === "duplicate" ? "conflict" : outcome;
			},
		}),
	],
	[
		"a different entry for a held epoch answers conflict",
		broken({
			accept: (entries, entry) =>
				entries.some((row) => row.epoch === entry.epoch)
					? "duplicate"
					: RULES.accept(entries, entry),
		}),
	],
	[
		"an epoch past the next one answers gap",
		broken({
			accept: (entries, entry) => {
				const outcome = RULES.accept(entries, entry);
				return outcome === "gap" && entries.length > 0 ? "accepted" : outcome;
			},
		}),
	],
	[
		"read with a limit keeps only the highest epochs, ascending",
		broken({ read: (entries) => entries }),
	],
	[
		"refresh, where present, answers whether the log exists",
		broken({ refresh: () => true }),
	],
	[
		"seed, where present, starts only an empty log",
		broken({ seed: () => "seeded" }),
	],
]);
