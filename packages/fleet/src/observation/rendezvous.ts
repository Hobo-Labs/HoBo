import { createHash } from "node:crypto";
import type { MemberId, WorkDigest } from "../ids.js";
import { reliabilityWeight } from "./reliability.js";

export type RankCandidate = Readonly<{
	memberId: MemberId;
	copies: number;
	reliability: number;
}>;

const TWO_48 = 2 ** 48;

function unit(digest: WorkDigest, memberId: MemberId): number {
	const hash = createHash("sha256").update(`${digest}\0${memberId}`).digest();
	return (hash.readUIntBE(0, 6) + 1) / (TWO_48 + 2);
}

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
			score:
				-(candidate.copies * reliabilityWeight(candidate.reliability)) /
				Math.log(unit(digest, candidate.memberId)),
		}))
		.sort((a, b) => b.score - a.score || a.memberId.localeCompare(b.memberId))
		.map((entry) => entry.memberId);
}

export function leader(ranked: readonly MemberId[], self: MemberId): MemberId {
	return ranked[0] ?? self;
}

export type ClaimTurnAnswer = Readonly<{ rank: number; waitMs: number }>;

export type ClaimTurnInput = Readonly<{
	self: MemberId;
	ranked: readonly MemberId[];
	queuedAtMs: number;
	nowMs: number;
	stepMs: number;
	maxRank: number;
}>;

export function turn(input: ClaimTurnInput): ClaimTurnAnswer {
	const position = input.ranked.indexOf(input.self);
	if (position < 0) return { rank: -1, waitMs: Number.POSITIVE_INFINITY };
	const rankAt = Math.min(position, Math.max(0, input.maxRank));
	if (rankAt === 0) return { rank: 0, waitMs: 0 };
	const queuedAtMs = Math.min(input.queuedAtMs, input.nowMs);
	const waitMs = queuedAtMs + rankAt * input.stepMs - input.nowMs;
	return { rank: rankAt, waitMs: Math.max(0, waitMs) };
}
