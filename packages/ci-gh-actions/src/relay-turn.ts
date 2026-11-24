import { type MemberId, parseMemberId } from "@hobo/fleet";
import { claimTurn, rankMembers } from "@hobo/fleet/observation";
import { workDigest } from "@hobo/fleet/work";
import type { RelayTurn } from "./relay-answer/answerer.js";

// public-contract: the work kind a relay job's turn is ranked under.
export const RELAY_TURN_KIND = "relay-job";

export type RelayTurnPeer = Readonly<{
	memberId: string;
	freeSlots: number;
	healthy: boolean;
	labels: readonly string[];
	reliability?: number | undefined;
}>;

export type RelayTurnClaims = Readonly<{
	claim(jobId: number, memberId: string): Promise<"claimed" | "held">;
}>;

export type RelayTurnOptions = Readonly<{
	self: string;
	peers(): Promise<readonly RelayTurnPeer[]>;
	claims: RelayTurnClaims;
	stepMs: number;
	maxRank?: number | undefined;
	nowMs: () => number;
}>;

export function createRelayTurn(options: RelayTurnOptions): RelayTurn {
	const self = parseMemberId(options.self);
	return {
		async shouldStart(job) {
			const digest = workDigest(RELAY_TURN_KIND, String(job.jobId));
			const candidates: {
				memberId: MemberId;
				copies: number;
				reliability: number;
			}[] = [];
			for (const peer of await options.peers()) {
				if (!peer.healthy || peer.freeSlots <= 0) continue;
				if (!peer.labels.some((label) => sameLabel(label, job.label))) continue;
				candidates.push({
					memberId: parseMemberId(peer.memberId),
					copies: peer.freeSlots,
					reliability: peer.reliability ?? 1,
				});
			}
			const ranked = rankMembers(digest, candidates);
			const turn = claimTurn({
				digest,
				self,
				ranked,
				queuedAtMs: job.queuedAtMs,
				nowMs: options.nowMs(),
				stepMs: options.stepMs,
				maxRank: options.maxRank ?? 4,
			});
			if (turn.rank < 0) return { start: false, reason: "not-eligible" };
			if (turn.waitMs > 0) return { start: false, reason: "waiting-turn" };
			try {
				return (await options.claims.claim(job.jobId, self)) === "held"
					? { start: false, reason: "claimed-elsewhere" }
					: { start: true, reason: "claimed" };
			} catch {
				return { start: true, reason: "claims-unreachable" };
			}
		},
	};
}

function sameLabel(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}
