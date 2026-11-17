import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	parsePactDocument,
	verifyPact,
} from "@hobo/contract-harness";
import {
	parseConsumerGroupId,
	parseIdempotencyKey,
	parseQueueName,
	parseTopicName,
} from "@hobo/core";
import { expect, it } from "vitest";
import { createTestHarness, isTestHarnessError } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

it("verifies the service emulator consumer pact against the running harness", async () => {
	expect(
		await checkPactInventory(
			fileURLToPath(new URL("../contracts", import.meta.url)),
		),
	).toEqual({ ok: true, problems: [] });
	const pact = parsePactDocument(
		JSON.parse(
			await readFile(
				new URL(
					"../contracts/pacts/service-emulators.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const harness = createTestHarness();
	const bindle = fakeBindle({
		resources: {
			jobs: { kind: "queue" },
			events: { kind: "topic" },
			credentials: { kind: "secret" },
		},
		handlers: {},
	});
	const graph = await harness.deploy(bindle)();
	try {
		/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the Pact request body is untrusted input parsed by this provider adapter. */
		const result = await verifyPact(pact, {
			name: "HoboServiceEmulators",
			async handle(request) {
				if (request.method === "GET" && request.path === "/queue/events") {
					try {
						graph.queue("events");
					} catch (error) {
						if (isTestHarnessError(error))
							return { status: 409, body: { code: error.code } };
						throw error;
					}
					return { status: 200 };
				}
				const body = request.body;
				if (
					request.method === "POST" &&
					request.path === "/secret/credentials" &&
					typeof body === "object" &&
					body !== null &&
					"name" in body &&
					typeof body.name === "string" &&
					"value" in body &&
					typeof body.value === "string"
				) {
					const secrets = graph.secret("credentials");
					const written = await secrets.put(body.name, body.value);
					const accessed = await secrets.accessVersion(
						body.name,
						written.versionId,
					);
					return {
						status: 200,
						body: {
							fidelity: graph.resource("credentials").fidelity,
							access: accessed.status,
							versioned:
								accessed.status === "ok" &&
								accessed.versionId === written.versionId,
							materialInOutputs: JSON.stringify(graph.outputs()).includes(
								body.value,
							),
						},
					};
				}
				if (
					request.method !== "POST" ||
					typeof body !== "object" ||
					body === null ||
					!("message" in body) ||
					typeof body.message !== "string"
				)
					return { status: 400 };
				if (
					request.path === "/queue/jobs" &&
					"key" in body &&
					typeof body.key === "string"
				) {
					const queue = graph.queue("jobs");
					const name = parseQueueName("jobs");
					const options = { idempotencyKey: parseIdempotencyKey(body.key) };
					await queue.enqueue(name, body.message, options);
					const retry = await queue.enqueue(name, body.message, options);
					return {
						status: 200,
						body: {
							fidelity: graph.resource("jobs").fidelity,
							deduped: retry.deduped,
							message: queue.dequeue(name)[0]?.body,
						},
					};
				}
				if (request.path === "/topic/events") {
					const topic = graph.topic("events");
					const name = parseTopicName("events");
					await topic.publish(name, body.message);
					const [message] = await topic.consume(
						name,
						parseConsumerGroupId("test"),
					);
					return {
						status: 200,
						body: {
							fidelity: graph.resource("events").fidelity,
							message: message?.body,
						},
					};
				}
				return { status: 404 };
			},
		});
		/* oxlint-enable anti-slop/no-runtime-typeof */
		expect(result.failures).toEqual([]);
		expect(result.ok).toBe(true);
	} finally {
		await harness.destroy(bindle)();
	}
});
