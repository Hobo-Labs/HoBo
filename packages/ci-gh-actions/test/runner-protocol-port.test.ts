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
	InMemoryRunnerService,
	runnerServiceClientConformance,
	testJitConfig,
} from "../src/runner-protocol/port.js";

const fixtures = {
	message: (jobId: string) => testRelayJobMessage({ jobId }),
	answer: (jobId: string) =>
		create(RelayJobAnswerSchema, {
			jobId,
			planId: "plan-1",
			conclusion: "succeeded",
		}),
};

describe("runner service port", () => {
	it("the in-memory service keeps the protocol's rules", () =>
		runnerServiceClientConformance(() => {
			const client = new InMemoryRunnerService();
			return {
				client,
				queue: (message) => client.queue(message),
				jit: testJitConfig(),
			};
		}, fixtures));

	it("catches a service that gives one job to two sessions", async () => {
		const client = new InMemoryRunnerService();
		const twice = {
			client: {
				async open(jit: ReturnType<typeof testJitConfig>) {
					const session = await client.open(jit);
					return {
						...session,
						nextJob: async () => fixtures.message("job-1"),
					};
				},
			},
			queue: () => {},
			jit: testJitConfig(),
		};
		await expect(
			runnerServiceClientConformance(() => twice, fixtures),
		).rejects.toThrow("an empty queue gives no job");
	});

	it("carries a relay job from the queue through answerRelayJob to completion", async () => {
		const service = new InMemoryRunnerService();
		service.queue(testRelayJobMessage({ jobId: "job-7" }));
		const session = await service.open(testJitConfig("relay-iad-1"));
		const message = await session.nextJob(1_000);
		expect(message?.jobId).toBe("job-7");
		if (!message) return;
		const answer = await answerRelayJob(message, {
			order: new InMemoryRunnerOrderSource(),
			facts: new InMemoryRouteFactsSource(),
			journal: new InMemoryRouteJournal(),
			nowMs: 1_000,
			mode: "relay",
			node: "relay-iad-1",
			accountId: "acct-1",
			checks: undefined,
		});
		await session.complete(answer);
		await session.close();
		expect(service.completions).toHaveLength(1);
		expect(service.completions[0]?.session).toBe("relay-iad-1#1");
		expect(service.completions[0]?.answer.conclusion).toBe("succeeded");
		expect(
			service.completions[0]?.answer.outputs.find(
				(output) => output.name === "runner",
			)?.value,
		).toBe("ubuntu-24.04");
	});
});
