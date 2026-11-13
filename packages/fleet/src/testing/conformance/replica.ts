/**
 * `runReplicaConformance` (design §7.3, O15): what every one-active
 * `AssignmentReplica` must do, as today's register expects of a replica
 * (`backend-fleet/src/assignment.ts:148-163`).
 *
 * - One entry per epoch: the identical entry again answers `duplicate`, a
 *   different one `conflict`.
 * - Only `top + 1` is taken; any other epoch answers `gap`, and an empty log
 *   takes epoch 1 only.
 * - `read` answers ascending epochs, `limit` keeping the highest; an entry
 *   reads back exactly as accepted, membership included.
 * - `refresh` and `seed`, on replicas that have them: `refresh` answers
 *   whether the log exists, `seed` starts only an empty log.
 *
 * `make(id)` returns a replica over a fresh, empty log each time it is called.
 */
import { type MemberName, parseMemberName } from "../../ids.js";
import type { AssignmentEntry, AssignmentReplica } from "../../ports.js";
import { type ConformanceAssertion, ensure } from "./assertion.js";

export type ReplicaMake = (id: MemberName) => AssignmentReplica;

const REPLICA = parseMemberName("conformance-replica");
const LAPTOP = parseMemberName("laptop");
const SERVER = parseMemberName("server");

/** An entry at `epoch`, active on the laptop with both members, unless `active` says otherwise. */
const entry = (
	epoch: number,
	active: MemberName = LAPTOP,
): AssignmentEntry => ({
	epoch,
	active,
	sealed: false,
	target: undefined,
	reason: `conformance-${epoch}`,
	lossWindowMs: undefined,
	decidedAtMs: 1_800_000_000_000 + epoch,
	decidedBy: "conformance",
	members: [LAPTOP, SERVER],
});

const describeEntry = (value: AssignmentEntry): string =>
	JSON.stringify({
		epoch: value.epoch,
		active: value.active ?? null,
		sealed: value.sealed,
		target: value.target ?? null,
		reason: value.reason,
		lossWindowMs: value.lossWindowMs ?? null,
		decidedAtMs: value.decidedAtMs,
		decidedBy: value.decidedBy,
		members: value.members ?? null,
	});

const epochs = (entries: readonly AssignmentEntry[]) =>
	entries.map((value) => value.epoch).join(",");

async function acceptAll(
	replica: AssignmentReplica,
	entries: readonly AssignmentEntry[],
): Promise<void> {
	for (const value of entries) {
		const outcome = await replica.accept(value);
		ensure(
			outcome === "accepted",
			`epoch ${value.epoch} answered ${outcome}, want accepted`,
		);
	}
}

/** The replica assertions, in the order they are registered. */
export const REPLICA_ASSERTIONS: readonly ConformanceAssertion<ReplicaMake>[] =
	[
		{
			name: "the replica answers to the id it was made with",
			async check(make) {
				const replica = make(REPLICA);
				ensure(
					replica.id === REPLICA,
					`a replica made as ${REPLICA} answers to ${replica.id}`,
				);
			},
		},
		{
			name: "a new replica reads an empty log",
			async check(make) {
				const read = await make(REPLICA).read();
				ensure(read.length === 0, `a new replica read epochs ${epochs(read)}`);
			},
		},
		{
			name: "an empty log takes epoch 1 only",
			async check(make) {
				const replica = make(REPLICA);
				const early = await replica.accept(entry(2));
				ensure(early === "gap", `epoch 2 on an empty log answered ${early}`);
				const first = await replica.accept(entry(1));
				ensure(
					first === "accepted",
					`epoch 1 on an empty log answered ${first}`,
				);
			},
		},
		{
			name: "the next epoch is accepted and reads back exactly as accepted",
			async check(make) {
				const replica = make(REPLICA);
				const written = [
					entry(1),
					{
						...entry(2, SERVER),
						sealed: true,
						target: LAPTOP,
						lossWindowMs: 250,
					},
				];
				await acceptAll(replica, written);
				const read = await replica.read();
				ensure(
					read.map(describeEntry).join("\n") ===
						written.map(describeEntry).join("\n"),
					`the log read back as ${read.map(describeEntry).join(" ")}`,
				);
			},
		},
		{
			name: "the identical entry again answers duplicate",
			async check(make) {
				const replica = make(REPLICA);
				await acceptAll(replica, [entry(1)]);
				const again = await replica.accept(entry(1));
				ensure(again === "duplicate", `the same entry again answered ${again}`);
			},
		},
		{
			name: "a different entry for a held epoch answers conflict",
			async check(make) {
				const replica = make(REPLICA);
				await acceptAll(replica, [entry(1)]);
				const other = await replica.accept(entry(1, SERVER));
				ensure(
					other === "conflict",
					`another entry for epoch 1 answered ${other}`,
				);
			},
		},
		{
			name: "an epoch past the next one answers gap",
			async check(make) {
				const replica = make(REPLICA);
				await acceptAll(replica, [entry(1)]);
				const skipped = await replica.accept(entry(3));
				ensure(skipped === "gap", `epoch 3 after 1 answered ${skipped}`);
				const read = await replica.read();
				ensure(
					epochs(read) === "1",
					`after a gap the log holds epochs ${epochs(read)}`,
				);
			},
		},
		{
			name: "read with a limit keeps only the highest epochs, ascending",
			async check(make) {
				const replica = make(REPLICA);
				await acceptAll(replica, [entry(1), entry(2), entry(3)]);
				const all = await replica.read();
				ensure(epochs(all) === "1,2,3", `read answered ${epochs(all)}`);
				const top = await replica.read(2);
				ensure(epochs(top) === "2,3", `read(2) answered ${epochs(top)}`);
			},
		},
		{
			name: "refresh, where present, answers whether the log exists",
			async check(make) {
				const replica = make(REPLICA);
				if (replica.refresh === undefined) return;
				const absent = await replica.refresh();
				ensure(!absent, "refresh of an absent log answered true");
				await acceptAll(replica, [entry(1)]);
				const present = await replica.refresh();
				ensure(present, "refresh of a present log answered false");
			},
		},
		{
			name: "seed, where present, starts only an empty log",
			async check(make) {
				const replica = make(REPLICA);
				if (replica.seed === undefined) return;
				const seeded = await replica.seed(entry(5));
				ensure(seeded === "seeded", `seed of an empty log answered ${seeded}`);
				const read = await replica.read();
				ensure(epochs(read) === "5", `a seeded log reads ${epochs(read)}`);
				const again = await replica.seed(entry(7));
				ensure(
					again === "not-empty",
					`seed of a non-empty log answered ${again}`,
				);
				const next = await replica.accept(entry(6));
				ensure(next === "accepted", `epoch 6 after a seed answered ${next}`);
			},
		},
	];
