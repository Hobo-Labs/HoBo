import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	BASE_PROTECTION_QUERY,
	COMMENT_MUTATION,
	createGithubGraphql,
	createGithubQueue,
	DEFAULT_BRANCH_QUERY,
	ENQUEUE_MUTATION,
	githubDefaultBranch,
	SNAPSHOT_QUERY,
} from "../src/github-queue.js";
import pactJson from "./github-merge-queue.pact.json" with { type: "json" };

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.literal("POST"),
		path: z.literal("/graphql"),
		headers: z.record(z.string(), z.string()),
		body: z.object({
			operation: z.enum([
				"HoboAgentQueue",
				"HoboAgentEnqueue",
				"HoboAgentComment",
				"HoboAgentDefaultBranch",
				"HoboAgentBaseProtection",
			]),
			variables: z.record(z.string(), z.string()),
		}),
	}),
	response: z.object({ status: z.number().int(), body: z.json() }),
	expected: z
		.object({
			baseSha: z.string(),
			entries: z.array(z.record(z.string(), z.json())),
		})
		.optional(),
	expectedError: z.string().optional(),
	expectedProtected: z.boolean().optional(),
});
const pact = z
	.object({
		consumer: z.object({ name: z.literal("HoboCiAgent") }),
		provider: z.object({ name: z.literal("GithubGraphqlApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				repository: z.string(),
				baseRef: z.string(),
				label: z.string(),
				observedAt: z.string(),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(pactJson);
const fixtures = pact.metadata.consumerFixtures;
const QUERIES = {
	HoboAgentQueue: SNAPSHOT_QUERY,
	HoboAgentEnqueue: ENQUEUE_MUTATION,
	HoboAgentComment: COMMENT_MUTATION,
	HoboAgentDefaultBranch: DEFAULT_BRANCH_QUERY,
	HoboAgentBaseProtection: BASE_PROTECTION_QUERY,
};
const Sent = z.object({
	query: z.string(),
	variables: z.record(z.string(), z.string()),
});

/** A queue whose transport serves exactly the given interactions, in order. */
function queueServing(descriptions: readonly string[]) {
	const remaining = descriptions.map((description) => {
		const interaction = pact.interactions.find(
			(candidate) => candidate.description === description,
		);
		if (!interaction)
			throw new Error(`pact interaction missing: ${description}`);
		return interaction;
	});
	const served: string[] = [];
	const send: typeof fetch = async (input, init) => {
		const interaction = remaining.shift();
		if (!interaction) throw new Error("unexpected request");
		const { request, response } = interaction;
		expect(String(input)).toBe(`https://api.github.com${request.path}`);
		expect(init?.method).toBe(request.method);
		expect(init?.redirect).toBe("error");
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
			Object.fromEntries(new Headers(request.headers)),
		);
		const sent = Sent.parse(JSON.parse(String(init?.body)));
		expect(sent.query).toBe(QUERIES[request.body.operation]);
		expect(sent.query).toMatch(
			new RegExp(`^\\s*(query|mutation) ${request.body.operation}\\(`),
		);
		expect(sent.variables).toEqual(request.body.variables);
		served.push(interaction.description);
		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { "Content-Type": "application/json" },
		});
	};
	const graphql = createGithubGraphql({
		token: async () => "ghs_consumer_fixture_only",
		fetch: send,
	});
	const queue = createGithubQueue({
		repository: fixtures.repository,
		baseRef: fixtures.baseRef,
		label: fixtures.label,
		graphql,
		now: () => fixtures.observedAt,
	});
	return { queue, graphql, served, remaining };
}
const SNAPSHOT =
	"read the merge queue and the labelled pull requests waiting behind it";
const expected = (description: string) =>
	pact.interactions.find((candidate) => candidate.description === description)
		?.expected;

describe("GitHub merge queue consumer contract", () => {
	it("orders queued entries first, then labelled work by the time it was labelled", async () => {
		const { queue, remaining } = queueServing([SNAPSHOT]);
		const snapshot = await queue.snapshot();
		expect(snapshot).toMatchObject({
			repository: fixtures.repository,
			baseRef: fixtures.baseRef,
			baseSha: expected(SNAPSHOT)?.baseSha,
			observedAt: fixtures.observedAt,
		});
		// A draft is left out; a pull request already in the queue is not listed twice;
		// more than one hundred changed files reports no paths at all.
		expect(snapshot.entries).toMatchObject(expected(SNAPSHOT)?.entries ?? []);
		expect(snapshot.entries).toHaveLength(4);
		expect(remaining).toHaveLength(0);
	});

	it("reads the default branch a connected repository merges into", async () => {
		const { graphql, served } = queueServing([
			"read the default branch of a connected repository",
		]);
		expect(await githubDefaultBranch(graphql, fixtures.repository)).toBe(
			"main",
		);
		expect(served).toHaveLength(1);
	});

	it.each(
		pact.interactions.filter(
			(interaction) => interaction.expectedProtected !== undefined,
		),
	)("$description", async (interaction) => {
		const { queue, served } = queueServing([interaction.description]);
		expect(await queue.baseRequiresChecks()).toBe(
			interaction.expectedProtected,
		);
		expect(served).toHaveLength(1);
	});

	it("reads a branch that has no merge queue", async () => {
		const description =
			"a branch without a merge queue reports only labelled pull requests";
		const { queue } = queueServing([description]);
		expect((await queue.snapshot()).entries).toMatchObject(
			expected(description)?.entries ?? [],
		);
	});

	it("enqueues and comments by node id, only for pull requests it observed", async () => {
		const { queue, served } = queueServing([
			SNAPSHOT,
			"enqueue an observed pull request at exactly its observed head commit",
			"comment on an observed pull request",
		]);
		await expect(
			queue.enqueue({ number: 13, headSha: "3".repeat(40) }),
		).rejects.toThrow("not in the observed queue");
		await queue.snapshot();
		await queue.enqueue({ number: 13, headSha: "3".repeat(40) });
		await queue.comment(13, "**hobo-ci-agent** fixture comment");
		await expect(queue.comment(999, "x")).rejects.toThrow(
			"not in the observed queue",
		);
		expect(served).toHaveLength(3);
	});

	it.each([
		["a refused mutation is an error that carries no response text", "enqueue"],
		["an HTTP failure is an error that names only the status", "snapshot"],
	] as const)("%s", async (description, call) => {
		const interaction = pact.interactions.find(
			(candidate) => candidate.description === description,
		);
		const { queue } = queueServing(
			call === "enqueue" ? [SNAPSHOT, description] : [description],
		);
		if (call === "enqueue") await queue.snapshot();
		const failure = await (call === "enqueue"
			? queue.enqueue({ number: 13, headSha: "3".repeat(40) })
			: queue.snapshot()
		).then(
			() => undefined,
			(error: Error) => error.message,
		);
		expect(failure).toBe(interaction?.expectedError);
		expect(failure).not.toMatch(/SECRET-PROJECT|upstream text/);
	});
});
