import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	mergeGroupIdentity,
	mergeGroupMatches,
} from "../ci/github-merge-group.mts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const input = {
	branch: `gh-readonly-queue/main/pr-123-${base}`,
	baseBranch: "main",
	base,
	head,
};
const response = {
	data: {
		repository: {
			pullRequest: {
				state: "OPEN",
				baseRefName: "main",
				mergeQueueEntry: {
					state: "AWAITING_CHECKS",
					baseCommit: { oid: base },
					headCommit: { oid: head },
				},
			},
		},
	},
};

describe("merge-queue identity", () => {
	it("accepts the live queue's exact ref, commit, base, and open pull request", () => {
		const inputWithExtra = { ...input, env: { token: "test" } };
		const identity = mergeGroupIdentity(inputWithExtra);
		assert.ok(identity);
		assert.deepEqual(identity, { ...input, pr: 123 });
		assert.equal(identity.pr, 123);
		assert.equal(mergeGroupMatches(JSON.stringify(response), identity), true);
		const mergeable = structuredClone(response);
		mergeable.data.repository.pullRequest.mergeQueueEntry.state = "MERGEABLE";
		assert.equal(mergeGroupMatches(JSON.stringify(mergeable), identity), true);
	});

	it("refuses malformed refs, wrong bases, and inconsistent commit identities", () => {
		for (const change of [
			{ branch: `feature/pr-123-${base}` },
			{ branch: `gh-readonly-queue/other/pr-123-${base}` },
			{ branch: `gh-readonly-queue/main/pr-0-${base}` },
			{ branch: `gh-readonly-queue/main/pr-123-${head}` },
			{ branch: `${input.branch}-extra` },
			{ head: base },
			{ head: "bad" },
		])
			assert.equal(mergeGroupIdentity({ ...input, ...change }), undefined);
	});

	it("refuses stale, closed, incomplete, or erroneous queue responses", () => {
		const identity = mergeGroupIdentity(input);
		assert.ok(identity);
		const closed = structuredClone(response);
		closed.data.repository.pullRequest.state = "CLOSED";
		const retargeted = structuredClone(response);
		retargeted.data.repository.pullRequest.baseRefName = "other";
		const changedBase = structuredClone(response);
		changedBase.data.repository.pullRequest.mergeQueueEntry.baseCommit.oid =
			head;
		const changedHead = structuredClone(response);
		changedHead.data.repository.pullRequest.mergeQueueEntry.headCommit.oid =
			base;
		const waiting = structuredClone(response);
		waiting.data.repository.pullRequest.mergeQueueEntry.state = "QUEUED";
		for (const value of [
			"not json",
			"{}",
			JSON.stringify(closed),
			JSON.stringify(retargeted),
			JSON.stringify(changedBase),
			JSON.stringify(changedHead),
			JSON.stringify(waiting),
			JSON.stringify({
				...response,
				errors: [{ message: "partial response" }],
			}),
		])
			assert.equal(mergeGroupMatches(value, identity), false, value);
	});
});
