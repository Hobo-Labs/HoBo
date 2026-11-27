import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { createAtomicDurableQueue } from "@hobo/runtime/atomic-durable-queue";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import { createAwsBindleApplication } from "../src/aws-http-runtime.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import { createAwsDynamoKvStore } from "../src/aws-kv.js";
import { withAwsDynamoKv } from "../src/aws-kv-mapper.js";
import { createAwsQueueAtomicStore } from "../src/aws-queue-atomic-store.js";
import { withAwsDynamoDurableQueue } from "../src/aws-queue-mapper.js";

it("binds only the selected branded queue and its exact provisioned table", async () => {
	const definition = bindle("jobs-app", (b) => {
		const jobs = b.queue().allow("enqueue");
		return {
			jobs,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(jobs),
		};
	});
	const selected = withAwsDynamoDurableQueue(definition, { jobs: true });
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
	);
	const store = createAwsQueueAtomicStore({
		grant: {
			tableName: "jobs",
			accountId: "000000000000",
			partition: "aws",
			region: "us-east-1",
			resourceEpoch: `sha256:${"a".repeat(64)}`,
			grantEpoch: `sha256:${"b".repeat(64)}`,
			allow: ["get", "set"],
		},
		verify: () => true,
		layer,
	});
	const queue = createAtomicDurableQueue({
		store,
		now: () => 1,
		limits: {
			nameBytes: 32,
			payloadBytes: 64,
			attributeCount: 2,
			attributeBytes: 32,
			batchSize: 2,
			delayMs: 1000,
			leaseMs: 100,
			operationWindowMs: 10000,
			deliveryAttempts: 2,
			retainedMessages: 4,
			retainedReceipts: 20,
		},
	});
	const request = () => new Request("https://app.test");
	const make = (
		physicalName: string,
		value: typeof queue,
		verifyBinding: () => boolean = () => true,
	) =>
		defineAwsHttpSource({
			bindle: selected,
			applicationName: "web",
			environment: { HOBO_RESOURCE_0: physicalName },
			resolveStores: () => ({ jobs: value }),
			verifyBinding,
		});
	expect((await make("jobs", queue).fetch(request())).status).toBe(200);
	expect((await make("other", queue).fetch(request())).status).toBe(503);
	expect((await make("jobs", { ...queue }).fetch(request())).status).toBe(503);
	expect(
		(await make("jobs", new Proxy(queue, {})).fetch(request())).status,
	).toBe(503);
	expect((await make("jobs", queue, () => false).fetch(request())).status).toBe(
		503,
	);
});

it("rejects a queue and a key-value dependency that share one physical table", () => {
	const definition = bindle("jobs-app", (b) => {
		const jobs = b.queue().allow("enqueue");
		const sessions = b.kv().allow("get");
		return {
			jobs,
			sessions,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(jobs, sessions),
		};
	});
	const selected = withAwsDynamoKv(
		withAwsDynamoDurableQueue(definition, { jobs: true }),
		{ sessions: true },
	);
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
	);
	const grant = {
		tableName: "same-table",
		accountId: "000000000000",
		partition: "aws",
		region: "us-east-1",
		resourceEpoch: `sha256:${"a".repeat(64)}`,
		grantEpoch: `sha256:${"b".repeat(64)}`,
	};
	const store = createAwsQueueAtomicStore({
		grant: { ...grant, allow: ["get", "set"] },
		verify: () => true,
		layer,
	});
	const queue = createAtomicDurableQueue({
		store,
		now: () => 1,
		limits: {
			nameBytes: 32,
			payloadBytes: 64,
			attributeCount: 2,
			attributeBytes: 32,
			batchSize: 2,
			delayMs: 1000,
			leaseMs: 100,
			operationWindowMs: 10000,
			deliveryAttempts: 2,
			retainedMessages: 4,
			retainedReceipts: 20,
		},
	});
	const sessions = createAwsDynamoKvStore({
		grant: { ...grant, allow: ["get"] },
		verify: () => true,
		layer,
	});
	expect(() =>
		createAwsBindleApplication({
			bindle: selected,
			applicationName: "web",
			stores: { jobs: queue, sessions },
			verifyBinding: () => true,
		}),
	).toThrow("identities must be unique");
});
