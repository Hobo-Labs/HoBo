import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { RelayJobAnswerSchema } from "../src/_generated/relay_job_pb.js";
import {
	type AnswerRelayJobDeps,
	answerRelayJob,
	NO_ROUTE_FACTS,
	type RelayChecks,
	type RouteFacts,
	workflowGitRef,
} from "../src/runner-order/index.js";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testRelayJobMessage,
} from "../src/runner-order/testing.js";

const NOW = 1_763_337_600_000;

function setup(
	orderJson: string | undefined,
	facts: RouteFacts = NO_ROUTE_FACTS,
	checks: RelayChecks | undefined = undefined,
) {
	const order = new InMemoryRunnerOrderSource(
		new Map(orderJson === undefined ? [] : [["octo/app", orderJson]]),
	);
	const factsSource = new InMemoryRouteFactsSource(() => facts);
	const journal = new InMemoryRouteJournal();
	const deps: AnswerRelayJobDeps = {
		order,
		facts: factsSource,
		journal,
		nowMs: NOW,
		mode: "relay",
		node: "relay-iad-1",
		accountId: "acct-1",
		checks,
	};
	return { order, factsSource, journal, deps };
}

function outputs(answer: {
	outputs: readonly { name: string; value: string }[];
}): ReadonlyMap<string, string> {
	return new Map(answer.outputs.map((entry) => [entry.name, entry.value]));
}

const BUSY_MACHINE = {
	id: "m-1",
	name: "studio",
	runsOn: "hobo-machine-m-1",
	labels: ["self-hosted", "Linux", "X64"],
	online: true,
	paused: false,
	slots: 1,
	busy: 1,
	sharing: "only_me" as const,
	ownerId: "42",
	ownerCanRead: true,
	lastPickedAtMs: 0,
	repository: undefined,
};

describe("answerRelayJob", () => {
	it("routes a job and succeeds with the runner as an output", async () => {
		const { deps, journal, order } = setup(
			'{"steps":[{"key":"machine"},{"key":"github"}]}',
		);
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
				workflowRef: "octo/app/.github/workflows/ci.yml@refs/heads/main",
			}),
			deps,
		);
		expect(answer.conclusion).toBe("succeeded");
		expect(answer.jobId).toBe("job-1");
		expect(answer.planId).toBe("plan-1");
		expect(answer.annotations).toEqual([]);
		expect(Object.fromEntries(outputs(answer))).toEqual({
			runner: "ubuntu-24.04",
			step: "github",
			outcome: "routed",
			reason: "Routed to ubuntu-24.04 (github).",
		});
		expect(order.asked).toEqual([
			{ repository: "octo/app", ref: "refs/heads/main" },
		]);
		expect(journal.events.map((event) => event.type)).toEqual([
			"runner.route.Requested",
			"runner.route.Decided",
		]);
		const decided = journal.events[1];
		expect(decided).toMatchObject({
			accountId: "acct-1",
			atMs: NOW,
			mode: "relay",
			node: "relay-iad-1",
			jobId: "job-1",
		});
		expect(decided?.decision?.skipped.map((skip) => skip.reason)).toEqual([
			"no_machine",
		]);
	});

	it("succeeds with a waiting decision and queues on the busy step's label", async () => {
		const { deps } = setup('{"steps":[{"key":"machine"}]}', {
			...NO_ROUTE_FACTS,
			machines: [BUSY_MACHINE],
		});
		const answer = await answerRelayJob(
			testRelayJobMessage({ inputs: [["machine", "self-hosted"]] }),
			deps,
		);
		expect(answer.conclusion).toBe("succeeded");
		expect(outputs(answer).get("outcome")).toBe("waiting");
		expect(outputs(answer).get("runner")).toBe("hobo-machine-m-1");
		expect(answer.annotations.map((note) => note.level)).toEqual(["notice"]);
	});

	it("fails with the reason as an error annotation when nothing can take the job", async () => {
		const { deps, journal } = setup('{"steps":[{"key":"machine"}]}');
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [["machine", "self-hosted"]],
				private: false,
			}),
			deps,
		);
		expect(answer.conclusion).toBe("failed");
		const reason = outputs(answer).get("reason") ?? "";
		expect(reason).toMatch(
			/^No runner available\. machine: the repository is public/u,
		);
		expect(outputs(answer).get("outcome")).toBe("none");
		expect(outputs(answer).get("runner")).toBe("");
		expect(answer.annotations).toEqual([
			expect.objectContaining({ level: "error", message: reason }),
		]);
		expect(journal.events.at(-1)?.decision?.outcome).toBe("none");
	});

	it("refuses a broken order with the parser's sentence and gathers no facts", async () => {
		const { deps, journal, factsSource } = setup(
			'{"steps":[{"key":"github","spendLimitUsd":5}]}',
		);
		const answer = await answerRelayJob(testRelayJobMessage(), deps);
		expect(answer.conclusion).toBe("failed");
		const sentence =
			"invalid runner order: a spend limit belongs to a hosted provider step, not github";
		expect(answer.annotations[0]?.message).toBe(sentence);
		expect(outputs(answer).get("reason")).toBe(sentence);
		expect(outputs(answer).get("outcome")).toBe("none");
		expect(factsSource.asked).toEqual([]);
		expect(journal.events.at(-1)?.decision).toMatchObject({
			outcome: "none",
			reason: sentence,
		});
	});

	it("walks the default order when the repository wrote none", async () => {
		const { deps } = setup(undefined);
		const answer = await answerRelayJob(testRelayJobMessage(), deps);
		expect(outputs(answer).get("step")).toBe("github");
	});

	it("puts the runner type named by `first` at the top", async () => {
		const { deps } = setup('{"steps":[{"key":"github"},{"key":"depot"}]}');
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["github", "ubuntu-24.04"],
					["depot", "depot-ubuntu-24.04"],
					["first", "depot"],
				],
			}),
			deps,
		);
		expect(outputs(answer).get("runner")).toBe("depot-ubuntu-24.04");
	});

	it("gives `auto` the size the job asked for", async () => {
		const { deps } = setup('{"steps":[{"key":"blacksmith"}]}');
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["blacksmith", "auto"],
					["size", "4"],
				],
			}),
			deps,
		);
		expect(outputs(answer).get("runner")).toBe("blacksmith-4vcpu-ubuntu-2404");
	});

	it("fails a job whose size or first input cannot be read", async () => {
		const { deps } = setup(undefined);
		const badSize = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["github", "auto"],
					["size", "3"],
				],
			}),
			deps,
		);
		expect(badSize.conclusion).toBe("failed");
		expect(badSize.annotations[0]?.message).toBe(
			'the relay input size is 2, 4, 8, 16 or 32 vCPUs, not "3"',
		);
		const badFirst = await answerRelayJob(
			testRelayJobMessage({ inputs: [["first", "cloud"]] }),
			deps,
		);
		expect(badFirst.annotations[0]?.message).toMatch(
			/^the relay input first names a runner type/u,
		);
	});

	it("lets a check handler answer a job made only of check steps", async () => {
		const checks: RelayChecks = async (message) =>
			message.steps.length > 0
				? create(RelayJobAnswerSchema, {
						jobId: message.jobId,
						planId: message.planId,
						conclusion: "succeeded",
					})
				: undefined;
		const { deps, journal, order } = setup(undefined, NO_ROUTE_FACTS, checks);
		const checked = await answerRelayJob(
			testRelayJobMessage({ uses: ["Hobo-Labs/hobo/checks/pr-title@v1"] }),
			deps,
		);
		expect(checked.conclusion).toBe("succeeded");
		expect(checked.outputs).toEqual([]);
		expect(journal.events).toEqual([]);
		expect(order.asked).toEqual([]);
		const routed = await answerRelayJob(testRelayJobMessage(), deps);
		expect(outputs(routed).get("outcome")).toBe("routed");
	});

	it("fails a message it cannot read, and still completes it", async () => {
		const { deps, journal } = setup(undefined);
		const answer = await answerRelayJob(
			testRelayJobMessage({ repository: "not a repository" }),
			deps,
		);
		expect(answer.conclusion).toBe("failed");
		expect(answer.annotations[0]?.message).toBe(
			"The relay job could not be read: repository is owner/name",
		);
		expect(journal.events).toEqual([]);
	});

	it("journals a redelivered job once", async () => {
		const { deps, journal } = setup(undefined);
		await answerRelayJob(testRelayJobMessage(), deps);
		await answerRelayJob(testRelayJobMessage(), deps);
		expect(journal.events).toHaveLength(2);
	});

	it("leaves the caller's message as it was", async () => {
		const { deps } = setup(undefined);
		const message = testRelayJobMessage();
		await answerRelayJob(message, deps);
		expect(Object.isFrozen(message)).toBe(false);
	});
});

describe("workflowGitRef", () => {
	it("takes the ref after the last @", () => {
		expect(
			workflowGitRef("octo/app/.github/workflows/ci.yml@refs/pull/7/merge"),
		).toBe("refs/pull/7/merge");
		expect(workflowGitRef("")).toBeUndefined();
		expect(workflowGitRef("octo/app/.github/workflows/ci.yml")).toBeUndefined();
	});
});
