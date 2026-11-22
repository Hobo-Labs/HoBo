import { describe, expect, it } from "vitest";
import {
	type MemberId,
	parseMemberId,
	parseWorkDigest,
} from "../../src/ids.js";
import { leaderOf, rankMembers } from "../../src/observation/index.js";

const id = (n: number): MemberId =>
	parseMemberId(`dev_${n.toString(16).padStart(32, "0")}`);
const DIGEST = parseWorkDigest("d1".padStart(32, "0"));
const candidate = (memberId: MemberId) => ({
	memberId,
	copies: 1,
	reliability: 1,
});

describe("leaderOf", () => {
	it("is rank 0 of the live dispatchers, the same for every member that knows them", () => {
		const live = [id(2), id(3)].map(candidate);
		const ranked = rankMembers(DIGEST, live);
		expect(leaderOf(ranked, id(3))).toBe(ranked[0]);
		expect(leaderOf(ranked, id(2))).toBe(ranked[0]);
		expect(leaderOf(rankMembers(DIGEST, [...live].reverse()), id(3))).toBe(
			ranked[0],
		);
	});

	it("is never a member left out of the candidates (expired or refused), nor one with no copy", () => {
		const ranked = rankMembers(DIGEST, [
			{ memberId: id(1), copies: 0, reliability: 1 },
			candidate(id(3)),
		]);
		expect(leaderOf(ranked, id(3))).toBe(id(3));
	});

	it("a member that sees no live dispatcher leads itself", () => {
		expect(leaderOf([], id(7))).toBe(id(7));
	});

	it("when the leader stops being a candidate, the next one leads", () => {
		const all = [id(1), id(2), id(3)].map(candidate);
		const first = rankMembers(DIGEST, all);
		const rest = rankMembers(
			DIGEST,
			all.filter((entry) => entry.memberId !== first[0]),
		);
		expect(leaderOf(rest, id(1))).toBe(first[1]);
	});
});
