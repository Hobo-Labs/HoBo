import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { RelayJobAnswerSchema } from "@hobo/ci";
import { testRelayJobMessage } from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createRelayAnswerer,
	type QueuedRelayJob,
	type RelayAnswerer,
} from "../src/relay-answer/index.js";
import {
	InMemoryRunnerService,
	testJitConfig,
} from "../src/runner-protocol/port.js";

type Interaction = {
	description: string;
	providerStates: { name: string }[];
	request: {
		method: string;
		path: string;
		query?: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	response: { status: number; body?: unknown };
};

type Pact = {
	metadata: { webhookSecret?: string };
	interactions: Interaction[];
};

function readPact(name: string): Pact {
	return JSON.parse(
		readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
	);
}

const rest = readPact("relay-answer.pact.json");
const webhooks = readPact("relay-answer-webhook.pact.json");

const ON =
	"octo/app turns relay mode on, and its relay job 70001 of run 5001 is queued for a pull request into main";
const ORG =
	"the repository octo/app refuses one-job runners, and the organization octo takes them";
const EXISTS = "a runner named hobo-relay-5001-70001-1 already exists";
const GONE = "job 70001 is no longer on GitHub";
const FAILING = "GitHub cannot answer for job 70001 just now";
const LEFT =
	"run 5001 has completed, and its relay runner 31 was left behind offline";

const NOW_MS = Date.parse("2026-11-17T09:00:05Z");
const CONNECTIONS = [{ installationId: 1, repository: "octo/app" }];
const QUEUED: QueuedRelayJob = {
	installationId: 1,
	repository: "octo/app",
	jobId: 70001,
	runId: 5001,
	runAttempt: 1,
	name: "title",
	labels: ["hobo-relay"],
	queuedAtMs: Date.parse("2026-11-17T09:00:00Z"),
};

function pactGithub(
	states: readonly string[],
	used: Set<string>,
): GithubTransport {
	return {
		async request(_installationId, path, method = "GET", body) {
			const [pathname, query] = path.split("?");
			for (const state of states) {
				const entry = rest.interactions.find(
					(each) =>
						each.providerStates[0]?.name === state &&
						each.request.method === method &&
						each.request.path === pathname &&
						each.request.query === query,
				);
				if (!entry) continue;
				expect(body === undefined ? undefined : JSON.parse(body)).toEqual(
					entry.request.body,
				);
				used.add(entry.description);
				return entry.response.body === undefined
					? new Response(null, { status: entry.response.status })
					: Response.json(entry.response.body, {
							status: entry.response.status,
						});
			}
			throw new Error(`unmatched ${method} ${path} in ${states.join(" / ")}`);
		},
	};
}

function offering(): InMemoryRunnerService {
	const service = new InMemoryRunnerService();
	service.queue(
		testRelayJobMessage({
			jobId: "runner-service-job-1",
			repository: "octo/app",
			runId: 5001,
			runAttempt: 1,
			job: "title",
			event: "pull_request",
			inputs: [],
			uses: ["hobo-labs/hobo/checks/pr-title@v1"],
			workflowRef: "octo/app/.github/workflows/ci.yml@refs/pull/7/merge",
		}),
	);
	return service;
}

function answerer(
	github: GithubTransport,
	runnerService: InMemoryRunnerService,
): RelayAnswerer {
	return createRelayAnswerer({
		relayJobs: { answer: true, label: "hobo-relay" },
		github,
		runnerService,
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => "acct-pact",
		node: "pact-node",
		checks: async (message) =>
			create(RelayJobAnswerSchema, {
				jobId: message.jobId,
				planId: message.planId,
				conclusion: "succeeded",
			}),
		webhookSecret: webhooks.metadata.webhookSecret,
		nowMs: () => NOW_MS,
	});
}

describe("relay mode's GitHub REST pact", () => {
	it("executes every interaction through the answerer", async () => {
		const used = new Set<string>();

		const service = offering();
		const rescued = await answerer(pactGithub([ON], used), service).rescue(
			CONNECTIONS,
		);
		expect(rescued).toMatchObject({ queued: 1, failedReads: 0 });
		expect(rescued.outcomes[0]?.kind).toBe("answered");
		const [completion] = service.completions;
		expect(completion?.answer.conclusion).toBe("succeeded");
		expect(completion?.answer.outputs).toEqual([]);

		const org = await answerer(pactGithub([ORG, ON], used), offering()).answer(
			QUEUED,
		);
		expect(org.kind).toBe("answered");

		for (const [state, reason] of [
			[EXISTS, "runner-exists"],
			[GONE, "not-queued"],
			[FAILING, "read-failed"],
		] as const)
			expect(
				await answerer(pactGithub([state, ON], used), offering()).answer(
					QUEUED,
				),
			).toMatchObject({ kind: "skipped", reason });

		const swept = await answerer(
			pactGithub([LEFT], used),
			new InMemoryRunnerService(),
		).sweep(CONNECTIONS);
		expect(swept).toEqual({
			deleted: ["hobo-relay-5001-70001-1"],
			failedReads: 0,
		});

		expect([...used].sort()).toEqual(
			rest.interactions.map((each) => each.description).sort(),
		);
	});
});

describe("relay mode's workflow_job webhook pact", () => {
	it("answers every delivery as the pact says", async () => {
		const used = new Set<string>();
		for (const entry of webhooks.interactions) {
			const node = answerer(pactGithub([ON], new Set()), offering());
			const response = await node.webhook(
				new Request(`https://relay.invalid${entry.request.path}`, {
					method: entry.request.method,
					headers: entry.request.headers,
					body: JSON.stringify(entry.request.body),
				}),
			);
			expect(response.status, entry.description).toBe(entry.response.status);
			expect(await response.json(), entry.description).toEqual(
				entry.response.body,
			);
			used.add(entry.description);
		}
		expect(used.size).toBe(webhooks.interactions.length);
	});
});
