import { expect, it } from "vitest";
import {
	type DistributedJournalCommand,
	type DistributedJournalState,
	initialDistributedJournal,
	transitionDistributedJournal,
} from "../src/distributed-journal.js";

/** Exhaust the finite scenario universe, retaining only distinct reachable states. */
function commands(): DistributedJournalCommand[] {
	const result: DistributedJournalCommand[] = [];
	for (const nowMs of [1_000, 2_000, 31_000, 32_000]) {
		for (const [holderId, requestId] of [
			["a", "one"],
			["b", "two"],
			["a", "two"],
		] as const)
			result.push({ kind: "acquire", holderId, requestId, nowMs });
		for (const [holderId, requestId, fenceToken] of [
			["a", "one", 1],
			["b", "two", 2],
			["b", "two", 1],
		] as const) {
			result.push({ kind: "check", holderId, requestId, fenceToken, nowMs });
			result.push({ kind: "release", holderId, requestId, fenceToken, nowMs });
			for (const [expectedRevision, eventId, type] of [
				[0, "first", "Saved"],
				[0, "first", "Changed"],
				[1, "second", "Saved"],
			] as const)
				result.push({
					kind: "append",
					holderId,
					requestId,
					fenceToken,
					expectedRevision,
					eventId,
					event: { type },
					nowMs,
				});
		}
	}
	return result;
}

function requireInvariant(condition: boolean, label: string): void {
	if (!condition) throw new Error(`bounded journal invariant failed: ${label}`);
}

it("exhaustively preserves fencing and append invariants in bounded concurrent histories", () => {
	let frontier = new Map<string, DistributedJournalState>([
		[JSON.stringify(initialDistributedJournal()), initialDistributedJournal()],
	]);
	const seen = new Set(frontier.keys());
	let transitions = 0;
	for (let depth = 0; depth < 6; depth++) {
		const next = new Map<string, DistributedJournalState>();
		for (const state of frontier.values()) {
			for (const command of commands()) {
				const { state: after, result } = transitionDistributedJournal(
					state,
					command,
				);
				transitions++;
				requireInvariant(
					after.lastNowMs >= state.lastNowMs,
					"clock watermark is monotonic",
				);
				requireInvariant(
					after.epoch >= state.epoch && after.epoch <= state.epoch + 1,
					"fence epochs advance once",
				);
				requireInvariant(
					after.grants
						.slice(0, state.grants.length)
						.every((grant, index) => grant === state.grants[index]),
					"grant history is immutable",
				);
				requireInvariant(
					after.entries
						.slice(0, state.entries.length)
						.every((entry, index) => entry === state.entries[index]),
					"event history is immutable",
				);
				requireInvariant(
					new Set(after.grants.map((grant) => grant.requestId)).size ===
						after.grants.length,
					"grant identities are unique",
				);
				requireInvariant(
					new Set(after.entries.map((entry) => entry.eventId)).size ===
						after.entries.length,
					"event identities are unique",
				);
				requireInvariant(
					after.entries.length <= state.entries.length + 1,
					"a step commits at most one event",
				);
				if (command.nowMs < state.lastNowMs)
					requireInvariant(
						result.status === "denied" && result.code === "CLOCK_REGRESSION",
						"observed expiry cannot be reversed",
					);
				if (
					result.status === "valid" ||
					result.status === "released" ||
					result.status === "appended"
				) {
					requireInvariant(
						command.kind !== "acquire" &&
							state.current !== null &&
							command.holderId === state.current.holderId &&
							command.requestId === state.current.requestId &&
							command.fenceToken === state.current.fenceToken &&
							command.nowMs < state.current.expiresAtMs &&
							command.nowMs >= state.lastNowMs,
						"only the current live fence can act",
					);
				}
				if (result.status === "acquired") {
					requireInvariant(
						command.kind === "acquire" &&
							after.current?.fenceToken === result.fenceToken,
						"acquisition exposes the committed fence",
					);
					if (result.duplicate)
						requireInvariant(
							after.epoch === state.epoch &&
								after.current?.expiresAtMs === state.current?.expiresAtMs,
							"replay never extends a lease",
						);
					else
						requireInvariant(
							after.epoch === state.epoch + 1 &&
								(state.current === null ||
									command.nowMs >= state.current.expiresAtMs),
							"new fences do not overlap a live lease",
						);
				}
				if (result.status === "appended") {
					requireInvariant(
						command.kind === "append" &&
							result.revision === command.expectedRevision + 1,
						"append receipt names the committed revision",
					);
					requireInvariant(
						after.entries.length ===
							state.entries.length + (result.duplicate ? 0 : 1),
						"event replay cannot append twice",
					);
				}
				const key = JSON.stringify(after);
				if (!seen.has(key)) {
					seen.add(key);
					next.set(key, after);
				}
			}
		}
		frontier = next;
	}
	expect(seen.size).toBeGreaterThan(100);
	expect(transitions).toBeGreaterThan(10_000);
});
