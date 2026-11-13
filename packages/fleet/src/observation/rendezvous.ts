/**
 * Coordinator-free ordering of the devices that could take one unit of work
 * (design §6.8 "Ranking"), moved from `packages/ci/src/mesh/rendezvous.ts`.
 *
 * For one work digest every device computes the same ordering of the
 * candidates it knows about: weighted rendezvous hashing, where a device that
 * could start twice as many copies of this work is first for twice as much
 * of it, and one that has been dropping the work it takes (its reliability,
 * measured by the authority) is first for less. The device ranked `r` waits
 * `r` steps from when the work was queued and claims only if it is still
 * unclaimed; a device that is down or full costs the work one step.
 *
 * What changed in the move: the hash input is `(WorkDigest, MemberId)`;
 * fitting moved to `fitWork`, so a candidate arrives with its copies; the
 * three trust levels are gone (only accepted observations become candidates).
 *
 * Pure: no clock, network or store.
 */
import { createHash } from "node:crypto";
import type { MemberId, WorkDigest } from "../ids.js";
import { reliabilityWeight } from "./reliability.js";

export type RankCandidate = Readonly<{
	memberId: MemberId;
	copies: number;
	reliability: number;
}>;

const TWO_48 = 2 ** 48;

/** A value strictly inside (0, 1), fixed for a digest and a member. */
function unit(digest: WorkDigest, memberId: MemberId): number {
	const hash = createHash("sha256").update(`${digest}\0${memberId}`).digest();
	return (hash.readUIntBE(0, 6) + 1) / (TWO_48 + 2);
}

/**
 * The candidates that could take the work, best first. Every caller given the
 * same candidates computes the same order; removing one moves only the work it
 * was first for. A candidate with no copy is left out; a repeated member
 * counts once, as first given.
 */
export function rank(
	digest: WorkDigest,
	candidates: readonly RankCandidate[],
): readonly MemberId[] {
	const seen = new Set<MemberId>();
	return candidates
		.filter((candidate) => {
			if (seen.has(candidate.memberId)) return false;
			seen.add(candidate.memberId);
			return Number.isFinite(candidate.copies) && candidate.copies > 0;
		})
		.map((candidate) => ({
			memberId: candidate.memberId,
			// Weighted rendezvous: the largest -w / ln(u) wins, so a member's
			// share of first places is its share of the total weight.
			score:
				-(candidate.copies * reliabilityWeight(candidate.reliability)) /
				Math.log(unit(digest, candidate.memberId)),
		}))
		.sort((a, b) => b.score - a.score || a.memberId.localeCompare(b.memberId))
		.map((entry) => entry.memberId);
}

/** `waitMs` 0 means claim now. */
export type ClaimTurnAnswer = Readonly<{ rank: number; waitMs: number }>;

export type ClaimTurnInput = Readonly<{
	self: MemberId;
	ranked: readonly MemberId[];
	queuedAtMs: number;
	nowMs: number;
	stepMs: number;
	maxRank: number;
}>;

/**
 * When `self` may claim: its rank (capped at `maxRank`, so in a large fleet
 * work is never left waiting by arithmetic) and how long until its turn; 0
 * means now. A member not in `ranked` has no turn: rank -1, wait infinite.
 * A queue time in the future is a skewed clock, not a head start.
 */
export function turn(input: ClaimTurnInput): ClaimTurnAnswer {
	const position = input.ranked.indexOf(input.self);
	if (position < 0) return { rank: -1, waitMs: Number.POSITIVE_INFINITY };
	const rankAt = Math.min(position, Math.max(0, input.maxRank));
	if (rankAt === 0) return { rank: 0, waitMs: 0 };
	const queuedAtMs = Math.min(input.queuedAtMs, input.nowMs);
	const waitMs = queuedAtMs + rankAt * input.stepMs - input.nowMs;
	return { rank: rankAt, waitMs: Math.max(0, waitMs) };
}
