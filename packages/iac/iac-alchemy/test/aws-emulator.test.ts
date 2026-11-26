import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Api, ApiProvider } from "@alchemy.run/aws/ApiGatewayV2";
import { UserPool, UserPoolProvider } from "@alchemy.run/aws/Cognito";
import * as Credentials from "@alchemy.run/aws/Credentials";
import { Table, TableProvider } from "@alchemy.run/aws/DynamoDB";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Key, KeyProvider } from "@alchemy.run/aws/KMS";
import { Bucket, BucketProvider } from "@alchemy.run/aws/S3";
import { Secret, SecretProvider } from "@alchemy.run/aws/SecretsManager";
import { Topic, TopicProvider } from "@alchemy.run/aws/SNS";
import { Queue, QueueProvider } from "@alchemy.run/aws/SQS";
import * as KMS from "@distilled.cloud/aws/kms";
import * as AwsRetry from "@distilled.cloud/aws/Retry";
import * as SecretsManager from "@distilled.cloud/aws/secrets-manager";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SQS from "@distilled.cloud/aws/sqs";
import { NodeHttpClient } from "@effect/platform-node";
import { awsPlugin, getAwsStore } from "@emulators/aws";
import { createServer } from "@emulators/core";
import { createAtomicDurableQueue } from "@hobo/runtime/atomic-durable-queue";
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
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import type { BindleRuntimeContext } from "../../../bindles/src/types.js";
import { createDurableQueueWitHost } from "../../../runtime/src/durable-queue-host.js";
import { awsBindleMappers } from "../src/aws.js";
import { createAwsKmsCryptography } from "../src/aws-cryptography.js";
import {
	awsKmsCryptographyMappers,
	withAwsKmsCryptography,
} from "../src/aws-cryptography-mapper.js";
import {
	awsHttpBindings,
	createAwsBindleApplication,
} from "../src/aws-http-runtime.js";
import { startAwsHttpServer } from "../src/aws-http-server.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import { createAwsDynamoKvStore } from "../src/aws-kv.js";
import {
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
import { createAwsNotificationPublisher } from "../src/aws-notification.js";
import {
	awsSnsNotificationMappers,
	withAwsSnsNotification,
} from "../src/aws-notification-mapper.js";
import { createAwsQueueAtomicStore } from "../src/aws-queue-atomic-store.js";
import {
	awsDynamoDurableQueueMappers,
	withAwsDynamoDurableQueue,
} from "../src/aws-queue-mapper.js";
import { createAwsS3Store } from "../src/aws-s3.js";
import { awsS3BindleMappers, withAwsS3 } from "../src/aws-s3-mapper.js";
import {
	type AwsSecretStore,
	createAwsSecretStore,
} from "../src/aws-secret.js";
import {
	awsVersionedSecretBindleMappers,
	withAwsVersionedSecret,
} from "../src/aws-secret-mapper.js";
import { mapBindleToAlchemy } from "../src/bindle.js";

const credentials = {
	accessKeyId: Redacted.make("local"),
	secretAccessKey: Redacted.make("local"),
};

async function mappedResources(
	nativeKv = false,
	nativeS3 = false,
	readOnly = false,
	nativeNotify = false,
) {
	const definition = bindle("shop", (b) => ({
		objects: nativeS3
			? readOnly
				? b.bucket().allow("read")
				: b.bucket().allow("read", "write", "delete")
			: b.bucket(),
		sessions: nativeKv
			? readOnly
				? b.kv().allow("get")
				: b.kv().allow("get", "set", "delete")
			: b.kv(),
		jobs: b.queue(),
		events: b.topic(),
		alerts: nativeNotify ? b.notify().allow("send") : b.notify(),
	}));
	const kvSelected = nativeKv
		? withAwsDynamoKv(definition, { sessions: true })
		: definition;
	const storageSelected = nativeS3
		? withAwsS3(kvSelected, { objects: true })
		: kvSelected;
	const selected = nativeNotify
		? withAwsSnsNotification(storageSelected, { alerts: true })
		: storageSelected;
	const baseMappers = nativeKv
		? awsDynamoKvBindleMappers()
		: awsBindleMappers();
	const storageMappers = nativeS3
		? awsS3BindleMappers(baseMappers)
		: baseMappers;
	const mappers = nativeNotify
		? awsSnsNotificationMappers(storageMappers)
		: storageMappers;
	// SAFETY: resource declaration only registers constructors; no AWS provider runs at this point.
	const mapped = await Effect.runPromise(
		mapBindleToAlchemy(selected, mappers, {
			assessRequirements: () => ({ status: "supported" as const }),
		}).pipe(
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
	const alerts = mapped.primary.alerts;
	if (!alerts || alerts.Type !== Topic.Type)
		throw new Error("notification mapping missing");
	const table = mapped.primary.sessions;
	if (!table || table.Type !== Table.Type)
		throw new Error("key-value table mapping missing");
	return { bucket, queue, topic, alerts, table };
}

async function mappedDurableQueue() {
	const original = bindle("queue-app", (b) => ({
		jobs: b.queue().allow("enqueue", "dequeue"),
	}));
	const selected = withAwsDynamoDurableQueue(original, { jobs: true });
	// SAFETY: this registers Alchemy constructors and runs no cloud provider.
	const mapped = await Effect.runPromise(
		mapBindleToAlchemy(selected, awsDynamoDurableQueueMappers(), {
			assessRequirements: () => ({ status: "supported" }),
		}).pipe(
			Effect.provideService(StackContext, {
				name: "shop",
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			}),
		) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
	);
	const table = mapped.primary.jobs;
	if (!table || table.Type !== Table.Type)
		throw Error("queue table mapping missing");
	return { table };
}

async function mappedCrypto() {
	const definition = bindle("shop", (b) => ({
		key: b.crypto().allow("encrypt", "decrypt"),
	}));
	// SAFETY: the fixture supplies the Alchemy stack context for resource construction.
	const mapped = await Effect.runPromise(
		mapBindleToAlchemy(
			withAwsKmsCryptography(definition, { key: true }),
			awsKmsCryptographyMappers(),
			{
				assessRequirements: () => ({ status: "supported" }),
			},
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
	const key = mapped.primary.key;
	if (!key || key.Type !== Key.Type) throw Error("crypto key mapping missing");
	return { key };
}

function environment(
	endpoint: string,
	kind: "bucket" | "queue" | "topic" | "kv" | "secret" = "bucket",
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
							: kind === "secret"
								? "credentials"
								: "sessions",
			fqn:
				kind === "bucket"
					? "objects"
					: kind === "queue"
						? "jobs"
						: kind === "topic"
							? "events"
							: kind === "secret"
								? "credentials"
								: "sessions",
			instanceId: "12345678901234567890123456789012",
			type:
				kind === "bucket"
					? Bucket.Type
					: kind === "queue"
						? Queue.Type
						: kind === "topic"
							? Topic.Type
							: kind === "secret"
								? Secret.Type
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
		const { bucket } = await mappedResources(false, true);
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
				accountId: "000000000000",
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
	const moto = process.env.HOBO_ALCHEMY_KMS_EMULATOR ? it : it.skip;
	official(
		"provisions the mapped WebSocket API in the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw Error("AWS Emulator CA is required");
			const layer = Layer.mergeAll(
				environment(endpoint.origin),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca: await readFile(caPath), servername: "localhost" },
				}),
			);
			const definition = bindle("shop", (b) => ({
				socket: b.websocket().with(sessionReplay({ enabled: false })),
			}));
			// SAFETY: this only registers constructors in an isolated test stack.
			const mapped = await Effect.runPromise(
				mapBindleToAlchemy(definition, awsBindleMappers(), {
					assessRequirements: () => ({ status: "supported" }),
				}).pipe(
					Effect.provideService(StackContext, {
						name: "shop",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
			);
			const resource = mapped.primary.socket;
			if (!resource || resource.Type !== Api.Type)
				throw Error("WebSocket API mapping missing");
			// SAFETY: the resource type check and fixture provide the Alchemy lifecycle dependencies.
			const api = resource as Api;
			// SAFETY: this supplies all services used by the API provider.
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Provider.Provider<Api>(Api.Type);
					return yield* provider.reconcile({
						id: api.LogicalId,
						fqn: api.FQN,
						instanceId: randomUUID(),
						session: noopSession,
						bindings: [],
						news: api.Props,
						olds: undefined,
						output: undefined,
					});
				}).pipe(
					Effect.provide(ApiProvider()),
					Effect.provide(layer),
				) as Effect.Effect<Api["Attributes"], Provider.ProviderError, never>,
			);
			expect(result.apiId).toBeTruthy();
			expect(result.protocolType).toBe("WEBSOCKET");
		},
		30_000,
	);
	official(
		"provisions the mapped auth user pool in the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw Error("AWS Emulator CA is required");
			const layer = Layer.mergeAll(
				environment(endpoint.origin),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca: await readFile(caPath), servername: "localhost" },
				}),
			);
			const definition = bindle("shop", (b) => ({ identity: b.auth() }));
			// SAFETY: this only registers constructors in an isolated test stack.
			const mapped = await Effect.runPromise(
				mapBindleToAlchemy(definition, awsBindleMappers(), {
					assessRequirements: () => ({ status: "supported" }),
				}).pipe(
					Effect.provideService(StackContext, {
						name: "shop",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
			);
			const resource = mapped.primary.identity;
			if (!resource || resource.Type !== UserPool.Type)
				throw Error("user pool mapping missing");
			// SAFETY: the resource type check and fixture provide the Alchemy lifecycle dependencies.
			const pool = resource as UserPool;
			// SAFETY: this supplies all services used by the user pool provider.
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Provider.Provider<UserPool>(UserPool.Type);
					return yield* provider.reconcile({
						id: pool.LogicalId,
						fqn: pool.FQN,
						instanceId: randomUUID(),
						session: noopSession,
						bindings: [],
						news: pool.Props,
						olds: undefined,
						output: undefined,
					});
				}).pipe(
					Effect.provide(UserPoolProvider()),
					Effect.provide(layer),
				) as Effect.Effect<
					UserPool["Attributes"],
					Provider.ProviderError,
					never
				>,
			);
			expect(result.userPoolId).toBeTruthy();
		},
		30_000,
	);
	official(
		"reconciles the mapped Secrets Manager resource through the official AWS Emulator",
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
				environment(endpoint.origin, "secret"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca, servername: "localhost" },
				}),
			);
			const definition = bindle("shop", (b) => ({
				credentials: b.secret().allow("put", "access"),
			}));
			const selected = withAwsVersionedSecret(definition, {
				credentials: true,
			});
			// SAFETY: resource declaration only registers constructors; no AWS provider runs here.
			const mapped = await Effect.runPromise(
				mapBindleToAlchemy(selected, awsVersionedSecretBindleMappers(), {
					assessRequirements: () => ({ status: "supported" }),
				}).pipe(
					Effect.provideService(StackContext, {
						name: "shop",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
			);
			const secret = mapped.primary.credentials;
			if (!secret || secret.Type !== Secret.Type)
				throw new Error("secret mapping missing");
			// SAFETY: the fixture supplies the provider lifecycle's AWS, resource and stack services.
			const output = await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Provider.Provider<Secret>(Secret.Type);
					return yield* provider.reconcile({
						id: secret.LogicalId,
						fqn: secret.FQN,
						instanceId: "12345678901234567890123456789012",
						session: noopSession,
						bindings: [],
						news: secret.Props,
						olds: undefined,
						output: undefined,
					});
				}).pipe(
					Effect.provide(SecretProvider()),
					Effect.provide(layer),
				) as Effect.Effect<Secret["Attributes"], Provider.ProviderError, never>,
			);
			expect(output.secretArn).toContain(
				":secretsmanager:us-east-1:000000000000:secret:",
			);
			expect(output.versionId).toBeUndefined();
			try {
				let authorized = true;
				const store = createAwsSecretStore({
					grant: {
						secretArn: output.secretArn,
						resourceEpoch: `sha256:${"a".repeat(64)}`,
						grantEpoch: `sha256:${"b".repeat(64)}`,
						allow: ["put", "access"],
					},
					verify: () => authorized,
					layer,
				});
				let retained: AwsSecretStore | undefined;
				const application = bindle("shop", (b) => {
					const credentials = b.secret().allow("put", "access");
					return {
						credentials,
						web: b
							.web((context?: BindleRuntimeContext) => async () => {
								retained = awsHttpBindings(context).secret("credentials");
								const current = await retained.access();
								return Response.json({
									version: current.versionId,
									bytes: [...current.value],
								});
							})
							.with(sessionReplay({ enabled: false }))
							.dependsOn(credentials),
					};
				});
				const selectedApplication = withAwsVersionedSecret(application, {
					credentials: true,
				});
				const source = defineAwsHttpSource({
					bindle: selectedApplication,
					applicationName: "web",
					environment: { HOBO_RESOURCE_0: output.secretArn },
					resolveStores: () => ({ credentials: store }),
					verifyBinding: () => authorized,
				});
				const first = randomUUID();
				const second = randomUUID();
				expect(await store.put(new Uint8Array([1, 2]), first)).toBe(first);
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
				expect(await store.put(new Uint8Array([3, 4]), second)).toBe(second);
				expect(await store.access()).toEqual({
					versionId: second,
					value: new Uint8Array([3, 4]),
				});
				expect(await store.accessVersion(first)).toEqual(
					new Uint8Array([1, 2]),
				);
				expect(new Set(await store.listVersions())).toEqual(
					new Set([first, second]),
				);
				const response = await source.fetch(new Request("https://app.test/"));
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({
					version: second,
					bytes: [3, 4],
				});
				if (!retained) throw new Error("secret binding missing");
				await expect(retained.access()).rejects.toMatchObject({
					code: "AWS_SECRET_DENIED",
				});
				authorized = false;
				expect(
					(await source.fetch(new Request("https://app.test/"))).status,
				).toBe(503);
				await expect(store.access()).rejects.toMatchObject({
					code: "AWS_SECRET_DENIED",
				});
			} finally {
				// SAFETY: this deletes only the ephemeral secret created inside the local emulator.
				await Effect.runPromise(
					SecretsManager.deleteSecret({
						SecretId: output.secretArn,
						ForceDeleteWithoutRecovery: true,
						region: "us-east-1",
					}).pipe(Effect.provide(layer)) as Effect.Effect<unknown>,
				);
			}
		},
		30_000,
	);
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
			const { bucket } = await mappedResources(false, true);
			const first = await precreate(bucket, layer);
			const second = await precreate(bucket, layer);
			expect(first.bucketArn).toBe(`arn:aws:s3:::${first.bucketName}`);
			expect(second.bucketName).toBe(first.bucketName);
			let authorized = true;
			const store = createAwsS3Store({
				grant: {
					bucketName: first.bucketName,
					accountId: "000000000000",
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
	moto(
		"reconciles the mapped KMS key through Moto",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_KMS_EMULATOR ?? "");
			if (
				endpoint.protocol !== "http:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw new Error("KMS emulator endpoint must be HTTP loopback");
			const layer = Layer.mergeAll(
				environment(endpoint.origin),
				FetchHttpClient.layer,
			);
			const { key } = await mappedCrypto();
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const first = await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Provider.Provider<Key>(Key.Type);
					return yield* provider.reconcile({
						id: key.LogicalId,
						fqn: key.FQN,
						instanceId: "12345678901234567890123456789012",
						session: noopSession,
						bindings: [],
						news: key.Props,
						olds: undefined,
						output: undefined,
					});
				}).pipe(
					Effect.provide(KeyProvider()),
					AwsRetry.none,
					Effect.provide(layer),
				) as Effect.Effect<Key["Attributes"], Provider.ProviderError, never>,
			);
			expect(first.keyArn).toContain(":kms:us-east-1:123456789012:key/");
			expect(first.keyUsage).toBe("ENCRYPT_DECRYPT");
			expect(first.keySpec).toBe("SYMMETRIC_DEFAULT");
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const second = await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Provider.Provider<Key>(Key.Type);
					return yield* provider.reconcile({
						id: key.LogicalId,
						fqn: key.FQN,
						instanceId: "12345678901234567890123456789012",
						session: noopSession,
						bindings: [],
						news: key.Props,
						olds: key.Props,
						output: first,
					});
				}).pipe(
					Effect.provide(KeyProvider()),
					AwsRetry.none,
					Effect.provide(layer),
				) as Effect.Effect<Key["Attributes"], Provider.ProviderError, never>,
			);
			expect(second.keyId).toBe(first.keyId);
			const plaintext = new TextEncoder().encode("mapped key test");
			const cryptography = createAwsKmsCryptography({
				grant: {
					keyId: first.keyId,
					accountId: "123456789012",
					partition: "aws",
					region: "us-east-1",
					resourceEpoch: `sha256:${"a".repeat(64)}`,
					grantEpoch: `sha256:${"b".repeat(64)}`,
					allow: ["encrypt", "decrypt"],
				},
				verify: () => true,
				layer,
			});
			const encryptedByPort = await cryptography.encrypt({
				attemptId: "encrypt_attempt_123",
				data: plaintext,
			});
			expect(encryptedByPort.status).toBe("completed");
			if (encryptedByPort.status !== "completed")
				throw Error("encryption failed");
			expect(
				await cryptography.decrypt({
					attemptId: "decrypt_attempt_123",
					data: encryptedByPort.data,
				}),
			).toEqual({
				status: "completed",
				attemptId: "decrypt_attempt_123",
				data: plaintext,
			});
			const application = bindle("shop", (b) => {
				const key = b.crypto().allow("encrypt", "decrypt");
				return {
					key,
					web: b
						.web((context) => async () => {
							const scoped = awsHttpBindings(context).crypto("key");
							const encrypted = await scoped.encrypt({
								attemptId: "http_encrypt_1234",
								data: plaintext,
							});
							if (encrypted.status !== "completed")
								return new Response(null, { status: 500 });
							const decrypted = await scoped.decrypt({
								attemptId: "http_decrypt_1234",
								data: encrypted.data,
							});
							if (decrypted.status !== "completed")
								return new Response(null, { status: 500 });
							return Response.json({ data: Array.from(decrypted.data) });
						})
						.with(sessionReplay({ enabled: false }))
						.dependsOn(key),
				};
			});
			const source = defineAwsHttpSource({
				bindle: withAwsKmsCryptography(application, { key: true }),
				applicationName: "web",
				environment: { HOBO_RESOURCE_0: first.keyArn },
				resolveStores: () => ({ key: cryptography }),
				verifyBinding: (claim) =>
					claim.kind === "crypto" &&
					claim.resourceName === "key" &&
					claim.grant.keyId === first.keyId,
			});
			const appResponse = await source.fetch(new Request("https://app.test"));
			expect(appResponse.status).toBe(200);
			expect(await appResponse.json()).toEqual({ data: Array.from(plaintext) });
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const encrypted = await Effect.runPromise(
				KMS.encrypt({ KeyId: first.keyArn, Plaintext: plaintext }).pipe(
					AwsRetry.none,
					Effect.provide(layer),
				) as Effect.Effect<KMS.EncryptResponse, unknown, never>,
			);
			if (!encrypted.CiphertextBlob) throw Error("ciphertext missing");
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const decrypted = await Effect.runPromise(
				KMS.decrypt({
					KeyId: first.keyArn,
					CiphertextBlob: encrypted.CiphertextBlob,
				}).pipe(AwsRetry.none, Effect.provide(layer)) as Effect.Effect<
					KMS.DecryptResponse,
					unknown,
					never
				>,
			);
			const result = Redacted.isRedacted(decrypted.Plaintext)
				? Redacted.value(decrypted.Plaintext)
				: decrypted.Plaintext;
			expect(result).toEqual(plaintext);
		},
		30_000,
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
			const { topic, alerts } = await mappedResources(
				false,
				false,
				false,
				true,
			);
			const first = await reconcileTopic(topic, layer);
			const second = await reconcileTopic(topic, layer);
			const notification = await reconcileTopic(alerts, layer);
			expect(first.topicArn).toBe(
				`arn:aws:sns:us-east-1:000000000000:${first.topicName}`,
			);
			expect(second.topicArn).toBe(first.topicArn);
			expect(notification.topicArn).toBe(
				`arn:aws:sns:us-east-1:000000000000:${notification.topicName}`,
			);
			expect(notification.topicArn).not.toBe(first.topicArn);
			const queueName = `notification-${randomUUID()}`;
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const target = await Effect.runPromise(
				SQS.createQueue({
					QueueName: queueName,
					Attributes: {
						Policy: JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Principal: { Service: "sns.amazonaws.com" },
									Action: "sqs:SendMessage",
									Resource: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
									Condition: {
										ArnEquals: { "aws:SourceArn": notification.topicArn },
									},
								},
							],
						}),
					},
				}).pipe(Effect.provide(layer)) as Effect.Effect<
					{ QueueUrl?: string },
					unknown,
					never
				>,
			);
			if (!target.QueueUrl) throw Error("subscriber queue URL unavailable");
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const subscription = await Effect.runPromise(
				SNS.subscribe({
					TopicArn: notification.topicArn,
					Protocol: "sqs",
					Endpoint: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
				}).pipe(Effect.provide(layer)) as Effect.Effect<
					{ SubscriptionArn?: string },
					unknown,
					never
				>,
			);
			if (!subscription.SubscriptionArn)
				throw Error("subscriber ARN unavailable");
			const epoch = `sha256:${"a".repeat(64)}`;
			const publisher = createAwsNotificationPublisher({
				grant: {
					topicName: notification.topicName,
					accountId: "000000000000",
					partition: "aws",
					region: "us-east-1",
					resourceEpoch: epoch,
					grantEpoch: epoch,
				},
				verify: () => true,
				layer,
			});
			const body = `notification 🌎 ${randomUUID()}`;
			const definition = bindle("shop", (b) => {
				const alerts = b.notify().allow("send");
				return {
					alerts,
					web: b
						.web(
							(context) => async () =>
								Response.json(
									await awsHttpBindings(context)
										.notify("alerts")
										.send({ attemptId: "abcdefghijklmnop", body }),
								),
						)
						.with(sessionReplay({ enabled: false }))
						.dependsOn(alerts),
				};
			});
			const app = defineAwsHttpSource({
				bindle: withAwsSnsNotification(definition, { alerts: true }),
				applicationName: "web",
				environment: { HOBO_RESOURCE_0: notification.topicArn },
				resolveStores: () => ({ alerts: publisher }),
				verifyBinding: (claim) =>
					claim.kind === "notify" &&
					claim.grant.topicName === notification.topicName,
			});
			const sent = await (
				await app.fetch(new Request("https://app.test"))
			).json();
			expect(sent.status).toBe("accepted");
			// SAFETY: the test layer supplies the emulator transport and credentials.
			const received = await Effect.runPromise(
				SQS.receiveMessage({
					QueueUrl: target.QueueUrl,
					WaitTimeSeconds: 5,
					MaxNumberOfMessages: 10,
				}).pipe(Effect.provide(layer)) as Effect.Effect<
					{ Messages?: { Body?: string }[] },
					unknown,
					never
				>,
			);
			expect(
				received.Messages?.some(
					(message) =>
						message.Body && JSON.parse(message.Body).Message === body,
				),
			).toBe(true);
			// SAFETY: the test layer supplies the emulator transport and credentials.
			await Effect.runPromise(
				SNS.unsubscribe({ SubscriptionArn: subscription.SubscriptionArn }).pipe(
					Effect.provide(layer),
				) as Effect.Effect<unknown, unknown, never>,
			);
			// SAFETY: the test layer supplies the emulator transport and credentials.
			await Effect.runPromise(
				SQS.deleteQueue({ QueueUrl: target.QueueUrl }).pipe(
					Effect.provide(layer),
				) as Effect.Effect<unknown, unknown, never>,
			);
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
					accountId: "000000000000",
					partition: "aws",
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

			const atomicOptions = {
				grant: {
					tableName: result.tableName,
					accountId: "000000000000",
					partition: "aws",
					region: "us-east-1",
					resourceEpoch: `sha256:${"a".repeat(64)}`,
					grantEpoch: `sha256:${"b".repeat(64)}`,
					allow: ["get", "set"] as const,
				},
				verify: () => authorized,
				layer,
			};
			await store.delete("queue-state");
			const atomic = createAwsQueueAtomicStore(atomicOptions);
			expect(await atomic.load()).toEqual({ status: "missing" });
			expect(await atomic.compareAndSwap(0, new Uint8Array([1]))).toEqual({
				status: "committed",
			});
			expect(await atomic.compareAndSwap(0, new Uint8Array([9]))).toEqual({
				status: "unknown",
			});
			const reopened = createAwsQueueAtomicStore(atomicOptions);
			expect(await reopened.load()).toEqual({
				status: "available",
				revision: 1,
				bytes: new Uint8Array([1]),
			});
			const results = await Promise.all([
				atomic.compareAndSwap(1, new Uint8Array([2])),
				reopened.compareAndSwap(1, new Uint8Array([3])),
			]);
			expect(
				results.filter((value) => value.status === "committed"),
			).toHaveLength(1);
			expect(
				results.filter((value) => value.status === "unknown"),
			).toHaveLength(1);
			const final = await reopened.load();
			expect(final.status).toBe("available");
			if (final.status !== "available")
				throw new Error("atomic state unavailable");
			expect(final.revision).toBe(2);
			expect([2, 3]).toContain(final.bytes[0]);
			authorized = false;
			expect(await atomic.load()).toEqual({ status: "unavailable" });
			expect(await atomic.compareAndSwap(2, new Uint8Array([4]))).toEqual({
				status: "unknown",
			});
			authorized = true;
			await store.delete("queue-state");
			let clock = 1000;
			let loseResponse = true;
			const lossy = {
				load: atomic.load,
				async compareAndSwap(revision: number, bytes: Uint8Array) {
					const written = await atomic.compareAndSwap(revision, bytes);
					if (loseResponse && written.status === "committed") {
						loseResponse = false;
						return { status: "unknown" as const };
					}
					return written;
				},
			};
			const bounds = {
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
			};
			const hostOptions = {
				limits: bounds,
				maxInFlight: 2,
				timeoutMs: 5000,
				now: () => clock,
				authorize: () => true,
			};
			const firstQueue = createAtomicDurableQueue({
				store: lossy,
				limits: bounds,
				now: () => clock,
			});
			const firstHost = createDurableQueueWitHost(firstQueue, hostOptions);
			const operation = (n: number) => ({
				id: `v1.10000.abcdefghijklmn${String(n).padStart(2, "0")}`,
				expiresAtMs: 10000n,
			});
			const enqueue = {
				operation: operation(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([0, 255, 7]),
					attributes: [{ key: "kind", value: "job" }],
				},
			};
			expect(await firstHost.enqueue(enqueue)).toMatchObject({
				tag: "unknown",
			});
			const reopenedQueue = createAtomicDurableQueue({
				store: atomic,
				limits: bounds,
				now: () => clock,
			});
			const reopenedHost = createDurableQueueWitHost(
				reopenedQueue,
				hostOptions,
			);
			expect(await reopenedHost.enqueue(enqueue)).toEqual({
				tag: "committed",
				val: { messageId: "m1", idempotencyKey: "job" },
			});
			const delivery = await reopenedHost.dequeue({
				operation: operation(2),
				maxMessages: 1,
				visibilityTimeoutMs: 10n,
			});
			expect(delivery).toMatchObject({
				tag: "committed",
				val: [
					{ messageId: "m1", leaseId: "l1", body: new Uint8Array([0, 255, 7]) },
				],
			});
			clock = 1010;
			expect(
				await reopenedHost.dequeue({
					operation: operation(3),
					maxMessages: 1,
					visibilityTimeoutMs: 10n,
				}),
			).toMatchObject({
				tag: "committed",
				val: [{ messageId: "m1", leaseId: "l2" }],
			});
			expect(
				await reopenedHost.complete({
					operation: operation(4),
					messageId: "m1",
					leaseId: "l1",
				}),
			).toEqual({ tag: "rejected", val: "lease-lost" });
			expect(
				await reopenedHost.complete({
					operation: operation(5),
					messageId: "m1",
					leaseId: "l2",
				}),
			).toEqual({ tag: "committed", val: { messageId: "m1", leaseId: "l2" } });
		},
		30_000,
	);
	official(
		"maps and routes a durable queue through an Alchemy table in the official AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw Error("AWS Emulator CA is required");
			const layer = Layer.mergeAll(
				environment(endpoint.origin, "kv"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca: await readFile(caPath), servername: "localhost" },
				}),
			);
			const { table: mapped } = await mappedDurableQueue();
			const table = await reconcileTable(mapped, layer);
			expect(table.partitionKey).toBe("pk");
			const grant = {
				tableName: table.tableName,
				accountId: "000000000000",
				partition: "aws",
				region: "us-east-1",
				resourceEpoch: `sha256:${"a".repeat(64)}`,
				grantEpoch: `sha256:${"b".repeat(64)}`,
				allow: ["get", "set", "delete"] as const,
			};
			const options = { grant, verify: () => true, layer };
			await createAwsDynamoKvStore(options).delete("queue-state");
			const atomic = createAwsQueueAtomicStore(options);
			const bounds = {
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
			};
			let clock = 1000;
			const now = () => clock;
			let loseResponse = true;
			const lossy = {
				load: atomic.load,
				async compareAndSwap(revision: number, bytes: Uint8Array) {
					const result = await atomic.compareAndSwap(revision, bytes);
					if (loseResponse && result.status === "committed") {
						loseResponse = false;
						return { status: "unknown" as const };
					}
					return result;
				},
			};
			const hostOptions = {
				limits: bounds,
				maxInFlight: 2,
				timeoutMs: 5000,
				now,
				authorize: () => true,
			};
			const firstQueue = createAtomicDurableQueue({
				store: lossy,
				limits: bounds,
				now,
			});
			const first = createDurableQueueWitHost(firstQueue, hostOptions);
			const operation = (n: number) => ({
				id: `v1.10000.abcdefghijklmn${String(n).padStart(2, "0")}`,
				expiresAtMs: 10000n,
			});
			const request = {
				operation: operation(1),
				message: {
					idempotencyKey: "job",
					body: new Uint8Array([1, 2]),
					attributes: [],
				},
			};
			expect(await first.enqueue(request)).toMatchObject({ tag: "unknown" });
			loseResponse = true;
			expect(await firstQueue.compact()).toEqual({ status: "unknown" });
			const reopenedQueue = createAtomicDurableQueue({
				store: atomic,
				limits: bounds,
				now,
			});
			const reopened = createDurableQueueWitHost(reopenedQueue, hostOptions);
			expect(await reopened.enqueue(request)).toEqual({
				tag: "committed",
				val: { messageId: "m1", idempotencyKey: "job" },
			});
			expect(
				await reopened.dequeue({
					operation: operation(2),
					maxMessages: 1,
					visibilityTimeoutMs: 10n,
				}),
			).toMatchObject({
				tag: "committed",
				val: [{ messageId: "m1", leaseId: "l1", body: new Uint8Array([1, 2]) }],
			});
			clock = 1005;
			expect(await reopenedQueue.compact()).toEqual({
				status: "compacted",
				prunedReceipts: 0,
			});
			clock = 1010;
			expect(
				await reopened.dequeue({
					operation: operation(3),
					maxMessages: 1,
					visibilityTimeoutMs: 10n,
				}),
			).toMatchObject({
				tag: "committed",
				val: [{ messageId: "m1", leaseId: "l2" }],
			});
			expect(
				await reopened.complete({
					operation: operation(4),
					messageId: "m1",
					leaseId: "l1",
				}),
			).toEqual({ tag: "rejected", val: "lease-lost" });
			expect(
				await reopened.complete({
					operation: operation(5),
					messageId: "m1",
					leaseId: "l2",
				}),
			).toMatchObject({ tag: "committed" });

			let retained:
				| import("@hobo/runtime/atomic-durable-queue").DurableQueue
				| undefined;
			let authorized = true;
			const appDefinition = bindle("queue-app", (b) => {
				const jobs = b.queue().allow("enqueue");
				return {
					jobs,
					web: b
						.web((context) => async () => {
							retained = awsHttpBindings(context).queue("jobs");
							const result = await retained.enqueue({
								operation: {
									id: "v1.10000.abcdefghijklmn06",
									expiresAtMs: 10000,
								},
								message: {
									idempotencyKey: "app-job",
									body: new Uint8Array([3]),
									attributes: [],
								},
							});
							return Response.json(result);
						})
						.with(sessionReplay({ enabled: false }))
						.dependsOn(jobs),
				};
			});
			const selected = withAwsDynamoDurableQueue(appDefinition, { jobs: true });
			const environmentValues = { HOBO_RESOURCE_0: table.tableName };
			const source = defineAwsHttpSource({
				bindle: selected,
				applicationName: "web",
				environment: environmentValues,
				resolveStores: () => ({ jobs: reopenedQueue }),
				verifyBinding: (claim) =>
					authorized &&
					claim.kind === "queue" &&
					claim.grant.tableName === table.tableName,
			});
			const appResponse = await source.fetch(new Request("https://app.test"));
			expect(appResponse.status).toBe(200);
			expect(await appResponse.json()).toMatchObject({
				status: "committed",
				value: { idempotencyKey: "app-job" },
			});
			expect(retained).toBeDefined();
			expect(retained).not.toHaveProperty("confirmExhaustedExport");
			expect(retained).not.toHaveProperty("inspectExhausted");
			expect(retained).not.toHaveProperty("redriveExhausted");
			expect(retained).not.toHaveProperty("reclaimCompleted");
			expect(
				await retained?.enqueue({
					operation: { id: "v1.10000.abcdefghijklmn07", expiresAtMs: 10000 },
					message: {
						idempotencyKey: "late",
						body: new Uint8Array([4]),
						attributes: [],
					},
				}),
			).toMatchObject({ status: "unknown" });
			environmentValues.HOBO_RESOURCE_0 = "wrong-table";
			expect((await source.fetch(new Request("https://app.test"))).status).toBe(
				503,
			);
			environmentValues.HOBO_RESOURCE_0 = table.tableName;
			authorized = false;
			expect((await source.fetch(new Request("https://app.test"))).status).toBe(
				503,
			);
			clock = 10000;
			expect(await reopenedQueue.reclaimCompleted()).toMatchObject({
				status: "reclaimed",
				reclaimedMessages: 1,
			});
			const afterReclamation = createAtomicDurableQueue({
				store: atomic,
				limits: bounds,
				now,
			});
			expect(
				await afterReclamation.enqueue({
					operation: { id: "v1.20000.abcdefghijklmn08", expiresAtMs: 20000 },
					message: {
						idempotencyKey: "job",
						body: new Uint8Array([1, 2]),
						attributes: [],
					},
				}),
			).toMatchObject({ status: "committed", value: { messageId: "m3" } });
			const appDelivery = {
				operation: { id: "v1.20000.abcdefghijklmn09", expiresAtMs: 20000 },
				maxMessages: 1,
				visibilityTimeoutMs: 10,
			};
			expect(await afterReclamation.dequeue(appDelivery)).toMatchObject({
				status: "committed",
				value: [{ messageId: "m2", deliveryAttempt: 1 }],
			});
			clock = 10010;
			expect(
				await afterReclamation.dequeue({
					...appDelivery,
					operation: { id: "v1.20000.abcdefghijklmn10", expiresAtMs: 20000 },
				}),
			).toMatchObject({
				status: "committed",
				value: [{ messageId: "m2", deliveryAttempt: 2 }],
			});
			clock = 20000;
			const inspection = await afterReclamation.inspectExhausted();
			expect(inspection).toMatchObject({
				status: "available",
				messages: [{ messageId: "m2", body: new Uint8Array([3]) }],
			});
			if (inspection.status !== "available")
				throw Error("inspection unavailable");
			expect(
				await afterReclamation.inspectExhausted({
					afterMessageId: "m1",
					revision: inspection.revision,
					observedAtMs: inspection.observedAtMs,
				}),
			).toMatchObject({
				status: "available",
				messages: [{ messageId: "m2" }],
				nextPage: null,
			});
			const redrive = {
				operation: { id: "v1.30000.abcdefghijklmn11", expiresAtMs: 30000 },
				messageId: "m2",
			};
			expect(await afterReclamation.redriveExhausted(redrive)).toMatchObject({
				status: "committed",
				value: { messageId: "m2" },
			});
			const afterRedrive = createAtomicDurableQueue({
				store: atomic,
				limits: bounds,
				now,
			});
			expect(await afterRedrive.redriveExhausted(redrive)).toMatchObject({
				status: "committed",
				value: { messageId: "m2" },
			});
			expect(
				await afterRedrive.dequeue({
					...appDelivery,
					operation: { id: "v1.30000.abcdefghijklmn12", expiresAtMs: 30000 },
				}),
			).toMatchObject({
				status: "committed",
				value: [{ messageId: "m2", deliveryAttempt: 1 }],
			});
			clock = 20010;
			expect(
				await afterRedrive.dequeue({
					...appDelivery,
					operation: { id: "v1.30000.abcdefghijklmn13", expiresAtMs: 30000 },
				}),
			).toMatchObject({
				status: "committed",
				value: [{ messageId: "m2", deliveryAttempt: 2 }],
			});
			clock = 30000;
			const inspected = await afterRedrive.inspectExhausted();
			if (inspected.status !== "available" || !inspected.messages[0])
				throw Error("missing exhausted message");
			const sqsLayer = Layer.mergeAll(
				environment(endpoint.origin, "queue"),
				NodeHttpClient.layerUndiciOptions({
					connect: { ca: await readFile(caPath), servername: "localhost" },
				}),
			);
			const target = await precreateQueue(
				(await mappedResources()).queue,
				sqsLayer,
			);
			const exportedBody = `dead-letter:${randomUUID()}:${inspected.messages[0].messageId}`;
			// SAFETY: the test layer supplies the SQS credentials and emulator transport.
			const sent = await Effect.runPromise(
				SQS.sendMessage({
					QueueUrl: target.queueUrl,
					MessageBody: exportedBody,
				}).pipe(Effect.provide(sqsLayer)) as Effect.Effect<
					{ MessageId?: string },
					unknown,
					never
				>,
			);
			if (!sent.MessageId) throw Error("destination receipt unavailable");
			// SAFETY: the test layer supplies the SQS credentials and emulator transport.
			const received = await Effect.runPromise(
				SQS.receiveMessage({
					QueueUrl: target.queueUrl,
					MaxNumberOfMessages: 10,
				}).pipe(Effect.provide(sqsLayer)) as Effect.Effect<
					{ Messages?: { Body?: string }[] },
					unknown,
					never
				>,
			);
			expect(
				received.Messages?.some((message) => message.Body === exportedBody),
			).toBe(true);
			const confirmation = {
				operation: { id: "v1.40000.abcdefghijklmn14", expiresAtMs: 40000 },
				messageId: inspected.messages[0].messageId,
				expectedRevision: inspected.revision,
				exportReceipt: createHash("sha256")
					.update(sent.MessageId)
					.digest("hex")
					.slice(0, 32),
			};
			expect(
				await afterRedrive.confirmExhaustedExport(confirmation),
			).toMatchObject({ status: "committed", value: { messageId: "m2" } });
			expect(
				await afterRedrive.confirmExhaustedExport(confirmation),
			).toMatchObject({ status: "committed" });
			expect(await afterRedrive.inspectExhausted()).toMatchObject({
				status: "available",
				messages: [],
			});
		},
		30000,
	);

	official(
		"binds a HoBo HTTP handler to the mapped DynamoDB and S3 resources",
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
			const http = NodeHttpClient.layerUndiciOptions({
				connect: { ca, servername: "localhost" },
			});
			const bucketLayer = Layer.mergeAll(
				environment(endpoint.origin, "bucket"),
				http,
			);
			const tableLayer = Layer.mergeAll(
				environment(endpoint.origin, "kv"),
				http,
			);
			const mapped = await mappedResources(true, true, true);
			const bucket = await precreate(mapped.bucket, bucketLayer);
			const table = await reconcileTable(mapped.table, tableLayer);
			const epoch = `sha256:${"a".repeat(64)}`;
			const kvGrant = {
				tableName: table.tableName,
				accountId: "000000000000",
				partition: "aws",
				region: "us-east-1",
				resourceEpoch: epoch,
				grantEpoch: epoch,
			};
			const bucketGrant = {
				bucketName: bucket.bucketName,
				accountId: "000000000000",
				region: "us-east-1",
				resourceEpoch: epoch,
				grantEpoch: epoch,
			};
			const kvWriter = createAwsDynamoKvStore({
				grant: { ...kvGrant, allow: ["set"] },
				verify: () => true,
				layer: tableLayer,
			});
			const bucketWriter = createAwsS3Store({
				grant: { ...bucketGrant, allow: ["write"] },
				verify: () => true,
				layer: bucketLayer,
			});
			const body = new Uint8Array([4, 5]);
			const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
			await kvWriter.set({ key: "app-key", value: new Uint8Array([1, 2]) });
			await bucketWriter.write({
				name: "app-object",
				contentType: "application/octet-stream",
				digest,
				size: body.length,
				body,
			});
			const kv = createAwsDynamoKvStore({
				grant: { ...kvGrant, allow: ["get"] },
				verify: () => true,
				layer: tableLayer,
			});
			const objectStore = createAwsS3Store({
				grant: { ...bucketGrant, allow: ["read"] },
				verify: () => true,
				layer: bucketLayer,
			});
			const handler = (context?: BindleRuntimeContext) => async () => {
				const resources = awsHttpBindings(context);
				const value = await resources.kv("sessions").get("app-key");
				const object = await resources.bucket("objects").read("app-object");
				return Response.json({
					value: [...(value ?? [])],
					body: [...(object?.body ?? [])],
				});
			};
			const neutral = bindle("shop", (b) => {
				const sessions = b.kv().allow("get");
				const objects = b.bucket().allow("read");
				return {
					sessions,
					objects,
					web: b
						.web(handler)
						.with(sessionReplay({ enabled: false }))
						.dependsOn(sessions, objects),
				};
			});
			const selected = withAwsS3(withAwsDynamoKv(neutral, { sessions: true }), {
				objects: true,
			});
			let authorized = true;
			const app = createAwsBindleApplication({
				bindle: selected,
				applicationName: "web",
				stores: { sessions: kv, objects: objectStore },
				verifyBinding: () => authorized,
			});
			const response = await app.fetch(new Request("https://app.test/"));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ value: [1, 2], body: [4, 5] });
			const source = defineAwsHttpSource({
				bindle: selected,
				applicationName: "web",
				environment: {
					HOBO_RESOURCE_0: bucket.bucketName,
					HOBO_RESOURCE_1: table.tableName,
				},
				resolveStores: () => ({ sessions: kv, objects: objectStore }),
				verifyBinding: () => authorized,
			});
			const sourceResponse = await source.fetch(
				new Request("https://app.test/"),
			);
			expect(sourceResponse.status).toBe(200);
			expect(await sourceResponse.json()).toEqual({
				value: [1, 2],
				body: [4, 5],
			});
			const server = await startAwsHttpServer(source, "127.0.0.1:0");
			try {
				const httpResponse = await fetch(
					`http://127.0.0.1:${server.address.port}/`,
				);
				expect(httpResponse.status).toBe(200);
				expect(await httpResponse.json()).toEqual({
					value: [1, 2],
					body: [4, 5],
				});
			} finally {
				await server.close();
			}
			authorized = false;
			expect(
				(await source.fetch(new Request("https://app.test/"))).status,
			).toBe(503);
			expect((await app.fetch(new Request("https://app.test/"))).status).toBe(
				503,
			);
		},
		30_000,
	);
});
