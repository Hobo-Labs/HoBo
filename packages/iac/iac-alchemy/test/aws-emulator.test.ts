import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as Credentials from "@alchemy.run/aws/Credentials";
import { Table, TableProvider } from "@alchemy.run/aws/DynamoDB";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Bucket, BucketProvider } from "@alchemy.run/aws/S3";
import { Topic, TopicProvider } from "@alchemy.run/aws/SNS";
import { Queue, QueueProvider } from "@alchemy.run/aws/SQS";
import { NodeHttpClient } from "@effect/platform-node";
import { awsPlugin, getAwsStore } from "@emulators/aws";
import { createServer } from "@emulators/core";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { ResourceContext } from "alchemy/ResourceContext";
import { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { awsBindleMappers } from "../src/aws.js";
import { createAwsDynamoKvStore } from "../src/aws-kv.js";
import {
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
import { createAwsS3Store } from "../src/aws-s3.js";
import { mapBindleToAlchemy } from "../src/bindle.js";

const credentials = {
	accessKeyId: Redacted.make("local"),
	secretAccessKey: Redacted.make("local"),
};

async function mappedResources(nativeKv = false) {
	const definition = bindle("shop", (b) => ({
		objects: b.bucket(),
		sessions: nativeKv ? b.kv().allow("get", "set", "delete") : b.kv(),
		jobs: b.queue(),
		events: b.topic(),
	}));
	const selected = nativeKv
		? withAwsDynamoKv(definition, { sessions: true })
		: definition;
	// SAFETY: resource declaration only registers constructors; no AWS provider runs at this point.
	const mapped = await Effect.runPromise(
		mapBindleToAlchemy(
			selected,
			nativeKv ? awsDynamoKvBindleMappers() : awsBindleMappers(),
			{ assessRequirements: () => ({ status: "supported" as const }) },
		).pipe(
			Effect.provideService(StackContext, {
				name: "shop",
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			}),
		) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
	);
	const bucket = mapped.primary.objects;
	if (!bucket || bucket.Type !== Bucket.Type)
		throw new Error("bucket mapping missing");
	const queue = mapped.primary.jobs;
	if (!queue || queue.Type !== Queue.Type)
		throw new Error("queue mapping missing");
	const topic = mapped.primary.events;
	if (!topic || topic.Type !== Topic.Type)
		throw new Error("topic mapping missing");
	const table = mapped.primary.sessions;
	if (!table || table.Type !== Table.Type)
		throw new Error("key-value table mapping missing");
	return { bucket, queue, topic, table };
}

function environment(
	endpoint: string,
	kind: "bucket" | "queue" | "topic" | "kv" = "bucket",
) {
	return Layer.mergeAll(
		Endpoint.of(endpoint),
		Credentials.fromCredentials(credentials, "us-east-1"),
		Layer.succeed(
			AWSEnvironment,
			Effect.succeed({
				accountId: "000000000000",
				region: "us-east-1",
				credentials: Effect.succeed({
					...credentials,
					region: "us-east-1",
					sessionToken: undefined,
				}),
			}),
		),
		Layer.succeed(Stack, {
			name: "shop",
			stage: "test",
			resources: {},
			bindings: {},
			actions: {},
		}),
		Layer.succeed(Stage, "test"),
		Layer.succeed(ResourceContext, {
			logicalId:
				kind === "bucket"
					? "objects"
					: kind === "queue"
						? "jobs"
						: kind === "topic"
							? "events"
							: "sessions",
			fqn:
				kind === "bucket"
					? "objects"
					: kind === "queue"
						? "jobs"
						: kind === "topic"
							? "events"
							: "sessions",
			instanceId: "12345678901234567890123456789012",
			type:
				kind === "bucket"
					? Bucket.Type
					: kind === "queue"
						? Queue.Type
						: kind === "topic"
							? Topic.Type
							: Table.Type,
		}),
	);
}

async function precreate(
	bucket: Awaited<ReturnType<typeof mappedResources>>["bucket"],
	layer: Layer.Layer<never, never, never>,
) {
	// SAFETY: the fixture supplies all services used by the selected provider lifecycle operation.
	return Effect.runPromise(
		Effect.gen(function* () {
			const provider = yield* Provider.Provider<Bucket>(Bucket.Type);
			if (!provider.precreate)
				throw new Error("bucket provider has no precreate");
			return yield* provider.precreate({
				id: bucket.LogicalId,
				fqn: bucket.FQN,
				instanceId: "12345678901234567890123456789012",
				session: noopSession,
				bindings: [],
				news: bucket.Props,
			});
		}).pipe(
			Effect.provide(BucketProvider()),
			Effect.provide(layer),
		) as Effect.Effect<Bucket["Attributes"], Provider.ProviderError, never>,
	);
}

async function precreateQueue(
	queue: Awaited<ReturnType<typeof mappedResources>>["queue"],
	layer: Layer.Layer<never, never, never>,
) {
	// SAFETY: the fixture supplies all services used by the selected provider lifecycle operation.
	return Effect.runPromise(
		Effect.gen(function* () {
			const provider = yield* Provider.Provider<Queue>(Queue.Type);
			if (!provider.precreate)
				throw new Error("queue provider has no precreate");
			return yield* provider.precreate({
				id: queue.LogicalId,
				fqn: queue.FQN,
				instanceId: "12345678901234567890123456789012",
				session: noopSession,
				bindings: [],
				news: queue.Props,
			});
		}).pipe(
			Effect.provide(QueueProvider()),
			Effect.provide(layer),
		) as Effect.Effect<Queue["Attributes"], Provider.ProviderError, never>,
	);
}

async function reconcileTopic(
	topic: Awaited<ReturnType<typeof mappedResources>>["topic"],
	layer: Layer.Layer<never, never, never>,
) {
	// SAFETY: the fixture supplies all services used by the selected provider lifecycle operation.
	return Effect.runPromise(
		Effect.gen(function* () {
			const provider = yield* Provider.Provider<Topic>(Topic.Type);
			return yield* provider.reconcile({
				id: topic.LogicalId,
				fqn: topic.FQN,
				instanceId: "12345678901234567890123456789012",
				session: noopSession,
				bindings: [],
				news: topic.Props,
				olds: undefined,
				output: undefined,
			});
		}).pipe(
			Effect.provide(TopicProvider()),
			Effect.provide(layer),
		) as Effect.Effect<Topic["Attributes"], Provider.ProviderError, never>,
	);
}

async function reconcileTable(
	table: Awaited<ReturnType<typeof mappedResources>>["table"],
	layer: Layer.Layer<never, never, never>,
) {
	// SAFETY: the fixture supplies all services used by the selected provider lifecycle operation.
	return Effect.runPromise(
		Effect.gen(function* () {
			const provider = yield* Provider.Provider<Table>(Table.Type);
			return yield* provider.reconcile({
				id: table.LogicalId,
				fqn: table.FQN,
				instanceId: "12345678901234567890123456789012",
				session: noopSession,
				bindings: [],
				news: table.Props,
				olds: undefined,
				output: undefined,
			});
		}).pipe(
			Effect.provide(TableProvider()),
			Effect.provide(layer),
		) as Effect.Effect<Table["Attributes"], Provider.ProviderError, never>,
	);
}

describe("mapped Alchemy AWS resources in emulators", () => {
	it("precreates the mapped S3 bucket through Vercel Labs AWS emulator", async () => {
		const { app, store } = createServer(awsPlugin, {
			baseUrl: "http://localhost:4566",
		});
		const layer = Layer.mergeAll(
			environment("http://localhost:4566"),
			FetchHttpClient.layer,
			Layer.succeed(FetchHttpClient.Fetch, (url, init) =>
				app.fetch(new Request(url, init)),
			),
		);
		const { bucket } = await mappedResources();
		const first = await precreate(bucket, layer);
		const second = await precreate(bucket, layer);
		expect(second.bucketName).toBe(first.bucketName);
		expect(
			getAwsStore(store)
				.s3Buckets.all()
				.map((entry) => entry.bucket_name),
		).toEqual([first.bucketName]);
		const objectStore = createAwsS3Store({
			grant: {
				bucketName: first.bucketName,
				region: "us-east-1",
				resourceEpoch: `sha256:${"a".repeat(64)}`,
				grantEpoch: `sha256:${"b".repeat(64)}`,
				allow: ["read", "write", "delete"],
			},
			verify: () => true,
			layer,
		});
		const body = new Uint8Array([0, 255, 7]);
		const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
		const object = {
			name: "object",
			contentType: "application/octet-stream",
			digest,
			size: body.length,
			body,
		};
		await objectStore.write(object);
		expect(await objectStore.read(object.name)).toEqual(object);
		await objectStore.delete(object.name);
		expect(await objectStore.read(object.name)).toBeUndefined();
	});

	it("reports the unsupported queue tag check after the emulator creates the queue", async () => {
		const { app, store } = createServer(awsPlugin, {
			baseUrl: "http://localhost:4566",
		});
		const layer = Layer.mergeAll(
			environment("http://localhost:4566/sqs", "queue"),
			FetchHttpClient.layer,
			Layer.succeed(FetchHttpClient.Fetch, (url, init) =>
				app.fetch(new Request(url, init)),
			),
		);
		const { queue } = await mappedResources();
		await expect(precreateQueue(queue, layer)).rejects.toMatchObject({
			_tag: "UnknownAwsError",
			operation: "ListQueueTags",
		});
		expect(
			getAwsStore(store)
				.sqsQueues.all()
				.map((entry) => entry.queue_name),
		).toEqual(["shop-jobs-test-ci2fm6eqci2fm6eq"]);
	});

	const official = process.env.HOBO_ALCHEMY_AWS_EMULATOR === "1" ? it : it.skip;
	official(
		"precreates the mapped S3 bucket through the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			) {
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			}
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const layer = Layer.mergeAll(
				environment(endpoint.origin),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
			);
			const { bucket } = await mappedResources();
			const first = await precreate(bucket, layer);
			const second = await precreate(bucket, layer);
			expect(first.bucketArn).toBe(`arn:aws:s3:::${first.bucketName}`);
			expect(second.bucketName).toBe(first.bucketName);
			let authorized = true;
			const store = createAwsS3Store({
				grant: {
					bucketName: first.bucketName,
					region: "us-east-1",
					resourceEpoch: `sha256:${"a".repeat(64)}`,
					grantEpoch: `sha256:${"b".repeat(64)}`,
					allow: ["read", "write", "delete"],
				},
				verify: (_grant, _operation, key) =>
					authorized && key.startsWith("tenant-a/"),
				layer,
			});
			const body = new Uint8Array([0, 255, 7]);
			const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
			const object = {
				name: "tenant-a/object",
				contentType: "application/octet-stream",
				digest,
				size: body.length,
				body,
			};
			expect(await store.read(object.name)).toBeUndefined();
			await store.write(object);
			expect(await store.read(object.name)).toEqual(object);
			const emptyBody = new Uint8Array();
			const emptyObject = {
				...object,
				name: "tenant-a/empty",
				size: 0,
				body: emptyBody,
				digest: `sha256:${createHash("sha256").update(emptyBody).digest("hex")}`,
			};
			await store.write(emptyObject);
			expect(await store.read(emptyObject.name)).toEqual(emptyObject);
			await store.delete(emptyObject.name);
			await expect(store.read("tenant-b/object")).rejects.toMatchObject({
				code: "AWS_S3_DENIED",
			});
			authorized = false;
			await expect(store.delete(object.name)).rejects.toMatchObject({
				code: "AWS_S3_DENIED",
			});
			authorized = true;
			await store.delete(object.name);
			expect(await store.read(object.name)).toBeUndefined();
		},
	);
	official(
		"precreates the mapped SQS queue through the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			) {
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			}
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const layer = Layer.mergeAll(
				environment(endpoint.origin, "queue"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
			);
			const { queue } = await mappedResources();
			const first = await precreateQueue(queue, layer);
			const second = await precreateQueue(queue, layer);
			expect(first.queueArn).toBe(
				`arn:aws:sqs:us-east-1:000000000000:${first.queueName}`,
			);
			expect(second.queueName).toBe(first.queueName);
		},
	);
	official(
		"reconciles the mapped SNS topic through the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			) {
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			}
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const layer = Layer.mergeAll(
				environment(endpoint.origin, "topic"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
			);
			const { topic } = await mappedResources();
			const first = await reconcileTopic(topic, layer);
			const second = await reconcileTopic(topic, layer);
			expect(first.topicArn).toBe(
				`arn:aws:sns:us-east-1:000000000000:${first.topicName}`,
			);
			expect(second.topicArn).toBe(first.topicArn);
		},
	);
	official(
		"reconciles the mapped DynamoDB table through the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const layer = Layer.mergeAll(
				environment(endpoint.origin, "kv"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
			);
			const { table } = await mappedResources(true);
			const result = await reconcileTable(table, layer);
			expect(result.tableArn).toBe(
				`arn:aws:dynamodb:us-east-1:000000000000:table/${result.tableName}`,
			);
			expect(result.partitionKey).toBe("pk");
			expect(result.billingMode).toBe("PAY_PER_REQUEST");
			let authorized = true;
			const store = createAwsDynamoKvStore({
				grant: {
					tableName: result.tableName,
					region: "us-east-1",
					resourceEpoch: `sha256:${"a".repeat(64)}`,
					grantEpoch: `sha256:${"b".repeat(64)}`,
					allow: ["get", "set", "delete"],
				},
				verify: () => authorized,
				layer,
			});
			expect(await store.get("user:1")).toBeUndefined();
			await store.set({ key: "user:1", value: new Uint8Array([0, 255, 7]) });
			expect(await store.exists("user:1")).toBe(true);
			expect(await store.get("user:1")).toEqual(new Uint8Array([0, 255, 7]));
			authorized = false;
			await expect(store.delete("user:1")).rejects.toMatchObject({
				code: "AWS_KV_DENIED",
			});
			authorized = true;
			expect(await store.exists("user:1")).toBe(true);
			await store.delete("user:1");
			expect(await store.exists("user:1")).toBe(false);
		},
		30_000,
	);
});
