import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findSupersessions,
	listOpenPulls,
	type OpenPull,
	parsePullsPage,
	supersessionComment,
} from "../ci/pr-supersession.mts";

const parentOf = new Map([
	["b", "a"],
	["c", "b"],
	["d", "a"],
	["x", "m"],
]);

function contains(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return true;
	const parent = parentOf.get(descendant);
	return parent !== undefined && contains(ancestor, parent);
}

const inMain = (sha: string) => contains(sha, "x");

const pull = (number: number, headSha: string): OpenPull => ({
	number,
	headSha,
});

describe("findSupersessions", () => {
	it("closes every layer of a stack into its top", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(1, "a"), pull(2, "b"), pull(3, "c")],
				contains,
				inMain,
			),
			[
				{ number: 1, headSha: "a", carriedBy: 3 },
				{ number: 2, headSha: "b", carriedBy: 3 },
			],
		);
	});

	it("keeps two tips that only share a base open", () => {
		assert.deepEqual(
			findSupersessions([pull(3, "c"), pull(4, "d")], contains, inMain),
			[],
		);
	});

	it("names the oldest tip when two tips carry a layer", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(1, "a"), pull(3, "c"), pull(4, "d")],
				contains,
				inMain,
			),
			[{ number: 1, headSha: "a", carriedBy: 3 }],
		);
	});

	it("keeps the older of two pull requests at one head", () => {
		assert.deepEqual(
			findSupersessions([pull(7, "c"), pull(5, "c")], contains, inMain),
			[{ number: 7, headSha: "c", carriedBy: 5 }],
		);
	});

	it("closes a pull request main already carries", () => {
		assert.deepEqual(
			findSupersessions([pull(9, "m"), pull(3, "c")], contains, inMain),
			[{ number: 9, headSha: "m", carriedBy: "main" }],
		);
	});
});

describe("supersessionComment", () => {
	it("names the carrier and keeps the branch", () => {
		const text = supersessionComment({ number: 1, headSha: "a", carriedBy: 3 });
		assert.match(text, /#3's branch/);
		assert.match(text, /The branch is kept\./);
	});
});

describe("parsePullsPage", () => {
	it("keeps only well-formed same-repository entries", () => {
		assert.deepEqual(
			parsePullsPage(
				[
					{ number: 4, head: { sha: "d", repo: { full_name: "o/r" } } },
					{ number: "5", head: { sha: "e", repo: { full_name: "o/r" } } },
					{ number: 6, head: { repo: { full_name: "o/r" } } },
					null,
				],
				"o/r",
			),
			[{ number: 4, headSha: "d" }],
		);
	});
});

describe("listOpenPulls", () => {
	it("pages until empty and skips forks", async () => {
		const pages = [
			[
				{ number: 1, head: { sha: "a", repo: { full_name: "o/r" } } },
				{ number: 2, head: { sha: "b", repo: { full_name: "fork/r" } } },
			],
			[],
		];
		const seen: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			seen.push(String(input));
			return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
		};
		assert.deepEqual(await listOpenPulls(fetcher, "t", "o/r", "main"), [
			{ number: 1, headSha: "a" },
		]);
		assert.equal(seen.length, 2);
		assert.match(seen[0] ?? "", /state=open&base=main&per_page=100&page=1$/);
	});
});
