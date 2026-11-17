import { create } from "@bufbuild/protobuf";
import { answerRelayJob, RelayJobAnswerSchema } from "@hobo/ci";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testRelayJobMessage,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	GithubRunnerServiceClient,
	RelayModeOffError,
	RunnerProtocolError,
	type RunnerProtocolEvent,
} from "../src/runner-protocol/client.js";
import {
	FAKE_RUN_SERVICE_URL,
	FakeGithubRunnerService,
} from "../src/runner-protocol/fake-service.js";
import { parseJitConfig } from "../src/runner-protocol/jit-config.js";
import { runnerServiceClientConformance } from "../src/runner-protocol/port.js";

const ON = { answer: true, label: "hobo-relay" } as const;

function setup(
	options: Readonly<{
		nowMs?: () => number;
		fetch?: typeof fetch;
		callTimeoutMs?: number;
		relayJobs?: Readonly<{ answer: boolean; label: string }>;
	}> = {},
) {
	const nowMs = options.nowMs ?? Date.now;
	const service = new FakeGithubRunnerService({ nowMs });
	const events: RunnerProtocolEvent[] = [];
	const client = new GithubRunnerServiceClient({
		relayJobs: options.relayJobs ?? ON,
		fetch: options.fetch ?? service.fetch,
		callTimeoutMs: options.callTimeoutMs ?? 2_000,
		onEvent: (event) => events.push(event),
		nowMs,
	});
	const jit = parseJitConfig(service.jitConfig("hobo-relay-1"), {
		runnerName: "hobo-relay-1",
	});
	return { service, client, jit, events };
}

const answer = (jobId: string) =>
	create(RelayJobAnswerSchema, {
		jobId,
		planId: "plan-1",
		conclusion: "succeeded",
		outputs: [{ name: "runner", value: "ubuntu-24.04" }],
	});

describe("GithubRunnerServiceClient", () => {
	it("keeps the runner service port's rules against the fake service", () =>
		runnerServiceClientConformance(
			() => {
				const { service, client, jit } = setup();
				return { client, jit, queue: (message) => void service.queue(message) };
			},
			{
				message: (jobId) => testRelayJobMessage({ jobId }),
				answer,
			},
		));

	it("takes a relay job, answers it with the one engine, and completes it with outputs", async () => {
		const { service, client, jit } = setup();
		service.queue(
			testRelayJobMessage({
				jobId: "a6d7f1c2-0000-4000-8000-000000000001",
				planId: "b6d7f1c2-0000-4000-8000-000000000002",
				repository: "octo/app",
				workflowRef: "octo/app/.github/workflows/ci.yml@refs/heads/main",
				inputs: [
					["github", "ubuntu-24.04"],
					["size", ""],
				],
			}),
		);
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		expect(message).toMatchObject({
			jobId: "a6d7f1c2-0000-4000-8000-000000000001",
			planId: "b6d7f1c2-0000-4000-8000-000000000002",
			repository: "octo/app",
			runId: 9001,
			runAttempt: 1,
			job: "route",
			event: "push",
			actorId: "42",
			triggeringActorId: "42",
			private: true,
			fork: false,
			workflowRef: "octo/app/.github/workflows/ci.yml@refs/heads/main",
		});
		expect(message?.inputs.map((input) => [input.name, input.value])).toEqual([
			["github", "ubuntu-24.04"],
			["size", ""],
		]);
		if (!message) throw new Error("no job");
		const relayAnswer = await answerRelayJob(message, {
			order: new InMemoryRunnerOrderSource(),
			facts: new InMemoryRouteFactsSource(),
			journal: new InMemoryRouteJournal(),
			nowMs: 1_700_000_000_000,
			mode: "relay",
			node: "relay-test",
			accountId: "acct-1",
			checks: undefined,
		});
		await session.complete(relayAnswer);
		await session.close();
		expect(service.completions).toHaveLength(1);
		const completion = service.completions[0];
		expect(completion?.conclusion).toBe("succeeded");
		expect(completion?.outputs.get("runner")).toBe("ubuntu-24.04");
		expect(completion?.outputs.get("outcome")).toBe("routed");
		expect(service.requests.map((request) => request.call)).toEqual([
			"token",
			"session",
			"message",
			"acknowledge",
			"acquirejob",
			"completejob",
			"close",
		]);
	});

	it("fails a relay job whose order is broken, with the reason as a failure annotation", async () => {
		const { service, client, jit } = setup();
		service.queue(testRelayJobMessage({ jobId: "job-broken" }));
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		if (!message) throw new Error("no job");
		const order = new InMemoryRunnerOrderSource(
			new Map([["octo/app", '{"steps": "not a list"}']]),
		);
		const problem = (await order.order("octo/app", undefined)).problem;
		expect(problem).not.toBe("");
		await session.complete(
			await answerRelayJob(message, {
				order,
				facts: new InMemoryRouteFactsSource(),
				journal: new InMemoryRouteJournal(),
				nowMs: 1,
				mode: "relay",
				node: "relay-test",
				accountId: "acct-1",
				checks: undefined,
			}),
		);
		expect(service.completions[0]?.conclusion).toBe("failed");
		expect(service.completions[0]?.annotations).toEqual([
			{ level: "failure", message: problem },
		]);
		await session.close();
	});

	it("reads the fork, visibility and steps of a job", async () => {
		const { service, client, jit } = setup();
		service.queue(
			testRelayJobMessage({
				jobId: "job-fork",
				event: "pull_request",
				private: false,
				fork: true,
				inputs: [],
				uses: ["hobo-labs/hobo/checks/pr-title@v1"],
			}),
		);
		const session = await client.open(jit);
		const message = await session.nextJob(1_000);
		expect(message?.private).toBe(false);
		expect(message?.fork).toBe(true);
		expect(message?.steps.map((step) => step.uses)).toEqual([
			"hobo-labs/hobo/checks/pr-title@v1",
		]);
		await session.close();
	});

	it("opens nothing while relay mode is off", async () => {
		const { service, client, jit } = setup({
			relayJobs: { answer: false, label: "hobo-relay" },
		});
		await expect(client.open(jit)).rejects.toBeInstanceOf(RelayModeOffError);
		expect(service.requests).toEqual([]);
	});

	it("refuses a configuration that does not use the broker flow", async () => {
		const { client, jit } = setup();
		const v1 = { ...jit, runner: { ...jit.runner, useV2Flow: false } };
		await expect(client.open(v1)).rejects.toThrow(/broker flow/u);
	});

	it("signs in again when the service says the token expired", async () => {
		let now = 1_700_000_000_000;
		const { service, client, jit, events } = setup({ nowMs: () => now });
		const session = await client.open(jit);
		service.expireTokens();
		service.queue(testRelayJobMessage({ jobId: "job-after-expiry" }));
		expect((await session.nextJob(1_000))?.jobId).toBe("job-after-expiry");
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(2);
		now += 2 * 60 * 60 * 1000;
		await session.complete(answer("job-after-expiry"));
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(3);
		await session.close();
	});

	it("gives up when the runner can no longer sign in", async () => {
		const { service, client, jit } = setup();
		service.failNext("token", 400);
		await expect(client.open(jit)).rejects.toThrow(
			/refused the runner's sign-in \(400\)/u,
		);
	});

	it("ignores a message type it does not know and keeps waiting for a job", async () => {
		const { service, client, jit, events } = setup();
		service.queueMessage("BrokerSomethingNew", "{}");
		service.queue(testRelayJobMessage({ jobId: "job-after-unknown" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-after-unknown");
		expect(events).toContainEqual({
			kind: "message-ignored",
			messageType: "BrokerSomethingNew",
		});
		await session.close();
	});

	it("drops its token when the broker asks for a refresh", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.forceTokenRefresh();
		service.queue(testRelayJobMessage({ jobId: "job-after-refresh" }));
		expect((await session.nextJob(5_000))?.jobId).toBe("job-after-refresh");
		expect(
			events.filter((event) => event.kind === "token-issued"),
		).toHaveLength(2);
		await session.close();
	});

	it("completes a job that is not a relay job as failed and never hands it out", async () => {
		const { service, client, jit, events } = setup();
		service.queue(
			testRelayJobMessage({
				jobId: "job-build",
				inputs: [],
				uses: ["actions/checkout@v4"],
			}),
		);
		service.queue(testRelayJobMessage({ jobId: "job-relay" }));
		const session = await client.open(jit);
		expect((await session.nextJob(5_000))?.jobId).toBe("job-relay");
		expect(service.completions[0]).toMatchObject({
			jobId: "job-build",
			conclusion: "failed",
		});
		expect(service.completions[0]?.annotations[0]?.message).toMatch(
			/not a relay job/u,
		);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "job-refused", jobId: "job-build" }),
		);
		await expect(session.complete(answer("job-build"))).rejects.toThrow(
			/not taken/u,
		);
		await session.close();
	});

	it("retries a server error once", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.queue(testRelayJobMessage({ jobId: "job-retry" }));
		service.failNext("acquirejob", 503);
		expect((await session.nextJob(1_000))?.jobId).toBe("job-retry");
		expect(events).toContainEqual({
			kind: "retried",
			call: "acquirejob",
			status: 503,
		});
		service.failNext("completejob", 502);
		service.failNext("completejob", 500);
		await expect(session.complete(answer("job-retry"))).rejects.toMatchObject({
			status: 500,
		});
		await session.close();
	});

	it("skips an offer another runner acquired first", async () => {
		const { service, client, jit, events } = setup();
		const session = await client.open(jit);
		service.queue(testRelayJobMessage({ jobId: "job-taken" }));
		service.failNext("acquirejob", 409);
		service.queue(testRelayJobMessage({ jobId: "job-next" }));
		expect((await session.nextJob(5_000))?.jobId).toBe("job-next");
		expect(events).toContainEqual({
			kind: "job-lost",
			requestId: "1",
			status: 409,
		});
		await session.close();
	});

	it("puts a deadline on every call", async () => {
		const { service, jit } = setup();
		const hanging: typeof fetch = async (input, init) => {
			const url = new Request(input).url;
			if (url.startsWith(FAKE_RUN_SERVICE_URL) || url.endsWith("/session"))
				return service.fetch(input, init);
			if (!url.includes("/message")) return service.fetch(input, init);
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		};
		const client = new GithubRunnerServiceClient({
			relayJobs: ON,
			fetch: hanging,
			callTimeoutMs: 50,
		});
		const session = await client.open(jit);
		const started = Date.now();
		expect(await session.nextJob(0)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_500);
		await session.close();
		const slowComplete = new GithubRunnerServiceClient({
			relayJobs: ON,
			callTimeoutMs: 50,
			fetch: async (input, init) =>
				new Request(input).url.includes("completejob")
					? new Promise((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () =>
								reject(init.signal?.reason),
							);
						})
					: service.fetch(input, init),
		});
		service.queue(testRelayJobMessage({ jobId: "job-slow" }));
		const second = await slowComplete.open(jit);
		expect((await second.nextJob(1_000))?.jobId).toBe("job-slow");
		const failure = await second
			.complete(answer("job-slow"))
			.catch((error) => error);
		expect(failure).toBeInstanceOf(RunnerProtocolError);
		expect(failure).toMatchObject({ timedOut: true });
		await second.close();
	});

	it("sends nothing outside GitHub's hosts and never follows a redirect", async () => {
		const { service, jit } = setup();
		const seen: string[] = [];
		const client = new GithubRunnerServiceClient({
			relayJobs: ON,
			fetch: async (input, init) => {
				seen.push(new Request(input).url);
				expect(init?.redirect).toBe("error");
				return service.fetch(input, init);
			},
		});
		const session = await client.open(jit);
		service.queue(testRelayJobMessage({ jobId: "job-hosts" }));
		await session.nextJob(1_000);
		await session.close();
		expect(seen.length).toBeGreaterThan(0);
		for (const url of seen)
			expect(new URL(url).hostname).toMatch(
				/\.actions\.githubusercontent\.com$/u,
			);
	});
});
