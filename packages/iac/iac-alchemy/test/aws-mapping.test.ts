import { Api } from "@alchemy.run/aws/ApiGatewayV2";
import { UserPool } from "@alchemy.run/aws/Cognito";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { Key } from "@alchemy.run/aws/KMS";
import { Bucket } from "@alchemy.run/aws/S3";
import { Secret } from "@alchemy.run/aws/SecretsManager";
import { Topic } from "@alchemy.run/aws/SNS";
import { Queue } from "@alchemy.run/aws/SQS";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import { CATALOG_ROWS } from "../../../bindles/src/types.js";
import {
	ATOMIC_QUEUE_MAX_BYTES,
	ATOMIC_QUEUE_MAX_EVENTS,
} from "../../../runtime/src/atomic-queue-log.js";
import { awsBindleMappers, describeAwsPrimitiveSupport } from "../src/aws.js";
import {
	awsKmsCryptographyMappers,
	withAwsKmsCryptography,
} from "../src/aws-cryptography-mapper.js";
import {
	awsDynamoKv,
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
import {
	awsSnsNotificationMappers,
	withAwsSnsNotification,
} from "../src/aws-notification-mapper.js";
import {
	awsDynamoDurableQueue,
	awsDynamoDurableQueueMappers,
	withAwsDynamoDurableQueue,
} from "../src/aws-queue-mapper.js";
import { awsS3BindleMappers, withAwsS3 } from "../src/aws-s3-mapper.js";
import {
	awsVersionedSecret,
	awsVersionedSecretBindleMappers,
	withAwsVersionedSecret,
} from "../src/aws-secret-mapper.js";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";

const requirements = {
	assessRequirements: () => ({ status: "supported" as const }),
};

describe("AWS Alchemy infrastructure mappings", () => {
	it("requires an explicit bounded KMS choice to map symmetric operations", async () => {
		const definition = bindle("shop", (b) => ({
			key: b.crypto().allow("encrypt", "decrypt"),
		}));
		const selected = withAwsKmsCryptography(definition, { key: true });
		const mappers = awsKmsCryptographyMappers();
		expect(() => mapBindleToAlchemy(definition, mappers, requirements)).toThrow(
			"PRIMITIVE_UNSUPPORTED",
		);
		// SAFETY: resource declaration registers the Alchemy constructor without running an AWS provider.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.key?.Type).toBe(Key.Type);
		expect(mapped.primary.key?.Props).toEqual({
			keyUsage: "ENCRYPT_DECRYPT",
			keySpec: "SYMMETRIC_DEFAULT",
		});
		const support = describeAlchemyPrimitiveSupport(CATALOG_ROWS, mappers).find(
			(entry) => entry.kind === "crypto",
		);
		expect(support).toMatchObject({
			status: "partial",
			supportedOperations: ["encrypt", "decrypt"],
			unsupportedOperations: ["sign", "verify"],
		});
		for (const operation of ["sign", "verify"] as const) {
			const unsupported = bindle("shop", (b) => ({
				key: b.crypto().allow(operation),
			}));
			expect(() =>
				mapBindleToAlchemy(
					withAwsKmsCryptography(unsupported, { key: true }),
					mappers,
					requirements,
				),
			).toThrow("PRIMITIVE_UNSUPPORTED");
		}
		const dependent = bindle("shop", (b) => {
			const objects = b.bucket();
			return { objects, key: b.crypto().allow("encrypt").dependsOn(objects) };
		});
		expect(() =>
			mapBindleToAlchemy(
				withAwsKmsCryptography(dependent, { key: true }),
				mappers,
				requirements,
			),
		).toThrow("BINDLE_GRAPH_UNSUPPORTED");
	});
	it("requires an explicit bounded SNS choice to map notification sends", async () => {
		const definition = bindle("shop", (b) => ({
			alerts: b.notify().allow("send"),
		}));
		const selected = withAwsSnsNotification(definition, { alerts: true });
		const mappers = awsSnsNotificationMappers();
		expect(() => mapBindleToAlchemy(definition, mappers, requirements)).toThrow(
			"PRIMITIVE_UNSUPPORTED",
		);
		// SAFETY: resource declaration only registers constructors; no AWS provider runs at this point.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.alerts?.Type).toBe(Topic.Type);
		expect(mapped.primary.alerts?.FQN).toBe("alerts");
		const report = describeAlchemyPrimitiveSupport(CATALOG_ROWS, mappers);
		expect(report.find((entry) => entry.kind === "notify")).toMatchObject({
			supportedOperations: ["send"],
			status: "partial",
		});
		const dependent = bindle("shop", (b) => {
			const objects = b.bucket();
			return { objects, alerts: b.notify().allow("send").dependsOn(objects) };
		});
		expect(() =>
			mapBindleToAlchemy(
				withAwsSnsNotification(dependent, { alerts: true }),
				mappers,
				requirements,
			),
		).toThrow("BINDLE_GRAPH_UNSUPPORTED");
	});
	it("maps declared primitives to the actual Alchemy AWS resource types", async () => {
		const definition = bindle("shop", (b) => ({
			sessions: b.kv(),
			objects: b.bucket(),
			jobs: b.queue(),
			events: b.topic(),
			credentials: b.secret(),
			identity: b.auth(),
			key: b.crypto(),
			alerts: b.notify(),
			socket: b.websocket().with(sessionReplay({ enabled: false })),
		}));
		// SAFETY: resource declaration only registers constructors; no AWS provider runs at this point.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(definition, awsBindleMappers(), requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.sessions?.Type).toBe(Table.Type);
		expect(mapped.primary.objects?.Type).toBe(Bucket.Type);
		expect(mapped.primary.jobs?.Type).toBe(Queue.Type);
		expect(mapped.primary.events?.Type).toBe(Topic.Type);
		expect(mapped.primary.credentials?.Type).toBe(Secret.Type);
		expect(mapped.primary.identity?.Type).toBe(UserPool.Type);
		expect(mapped.primary.key?.Type).toBe(Key.Type);
		expect(mapped.primary.key?.Props).toEqual({
			keyUsage: "ENCRYPT_DECRYPT",
			keySpec: "SYMMETRIC_DEFAULT",
		});
		expect(mapped.primary.alerts?.Type).toBe(Topic.Type);
		expect(mapped.primary.socket?.Type).toBe(Api.Type);
		expect(mapped.primary.socket?.Props).toEqual({ protocolType: "WEBSOCKET" });
		expect(mapped.primary.credentials?.Props).toEqual({
			recoveryWindowInDays: 30,
		});
		expect(mapped.resources.map((resource) => resource.FQN).sort()).toEqual([
			"alerts",
			"credentials",
			"events",
			"identity",
			"jobs",
			"key",
			"objects",
			"sessions",
			"socket",
		]);
	});
	it("reports infrastructure-only support and rejects runtime claims", () => {
		const report = describeAwsPrimitiveSupport(CATALOG_ROWS);
		for (const kind of [
			"kv",
			"bucket",
			"queue",
			"topic",
			"secret",
			"auth",
			"crypto",
			"notify",
			"websocket",
		]) {
			const item = report.find((entry) => entry.kind === kind);
			expect(item?.status).toBe("partial");
			expect(item?.supportedOperations).toEqual([]);
			expect(item?.limitations.length).toBeGreaterThan(0);
		}
		const unsupported = bindle("shop", (b) => ({
			events: b.topic().allow("publish"),
		}));
		expect(() =>
			mapBindleToAlchemy(unsupported, awsBindleMappers(), requirements),
		).toThrow("PRIMITIVE_UNSUPPORTED");
		for (const operation of ["verify", "session"] as const) {
			const auth = bindle("shop", (b) => ({
				identity: b.auth().allow(operation),
			}));
			expect(() =>
				mapBindleToAlchemy(auth, awsBindleMappers(), requirements),
			).toThrow("PRIMITIVE_UNSUPPORTED");
		}
		for (const operation of ["encrypt", "decrypt", "sign", "verify"] as const) {
			const cryptography = bindle("shop", (b) => ({
				key: b.crypto().allow(operation),
			}));
			expect(() =>
				mapBindleToAlchemy(cryptography, awsBindleMappers(), requirements),
			).toThrow("PRIMITIVE_UNSUPPORTED");
		}
		const notify = bindle("shop", (b) => ({
			alerts: b.notify().allow("send"),
		}));
		expect(() =>
			mapBindleToAlchemy(notify, awsBindleMappers(), requirements),
		).toThrow("PRIMITIVE_UNSUPPORTED");
		for (const operation of [
			"accept",
			"connect",
			"send",
			"broadcast",
			"subscribe",
		] as const) {
			const socket = bindle("shop", (b) => ({
				socket: b.websocket().allow(operation),
			}));
			expect(() =>
				mapBindleToAlchemy(socket, awsBindleMappers(), requirements),
			).toThrow("PRIMITIVE_UNSUPPORTED");
		}
		const replay = bindle("shop", (b) => ({ socket: b.websocket() }));
		expect(() =>
			mapBindleToAlchemy(replay, awsBindleMappers(), requirements),
		).toThrow("session replay to be disabled");
		const application = bindle("shop", (b) => ({
			socket: b
				.websocket(() => "handler")
				.with(sessionReplay({ enabled: false })),
		}));
		expect(() =>
			mapBindleToAlchemy(application, awsBindleMappers(), requirements),
		).toThrow("ENTRYPOINT_UNSUPPORTED");
	});
	it("refuses declared dependencies that have no runtime binding", () => {
		const definition = bindle("shop", (b) => {
			const objects = b.bucket();
			return { objects, jobs: b.queue().dependsOn(objects) };
		});
		expect(() =>
			mapBindleToAlchemy(definition, awsBindleMappers(), requirements),
		).toThrow("BINDLE_GRAPH_UNSUPPORTED");
		const auth = bindle("shop", (b) => {
			const users = b.kv();
			return { users, identity: b.auth().dependsOn(users) };
		});
		expect(() =>
			mapBindleToAlchemy(auth, awsBindleMappers(), requirements),
		).toThrow("BINDLE_GRAPH_UNSUPPORTED");
	});
});

describe("explicit DynamoDB KV runtime choice", () => {
	it("keeps the Bindle neutral and maps permitted operations to a real table", async () => {
		const original = bindle("shop", (b) => ({
			sessions: b.kv().allow("get", "set", "delete"),
		}));
		const selected = withAwsDynamoKv(original, { sessions: true });
		expect(original.resources.sessions?.annotations).toEqual([]);
		expect(selected.resources.sessions?.annotations).toEqual([awsDynamoKv()]);
		const mappers = awsDynamoKvBindleMappers();
		const report = describeAlchemyPrimitiveSupport(
			[{ factory: "kv", allowVerbs: ["get", "set", "delete"] }],
			mappers,
		);
		expect(report[0]).toMatchObject({
			status: "partial",
			supportedOperations: ["get", "set", "delete"],
		});
		// SAFETY: mapping registers resource constructors only; no provider is invoked.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.sessions?.Type).toBe(Table.Type);
		expect(() => mapBindleToAlchemy(original, mappers, requirements)).toThrow(
			"DynamoDB KV requires",
		);
		expect(() => withAwsDynamoKv(original, { missing: true })).toThrow(
			"unknown resource",
		);
	});
});

describe("composable AWS target choices", () => {
	it("maps bounded S3 and DynamoDB operations while preserving the neutral Bindle", async () => {
		const original = bindle("shop", (b) => ({
			objects: b.bucket().allow("read", "write", "delete"),
			sessions: b.kv().allow("get", "set", "delete"),
		}));
		const selected = withAwsS3(withAwsDynamoKv(original, { sessions: true }), {
			objects: true,
		});
		expect(original.resources.objects?.annotations).toEqual([]);
		expect(original.resources.sessions?.annotations).toEqual([]);
		const mappers = awsS3BindleMappers(awsDynamoKvBindleMappers());
		const report = describeAlchemyPrimitiveSupport(
			[
				{ factory: "bucket", allowVerbs: ["read", "write", "delete"] },
				{ factory: "kv", allowVerbs: ["get", "set", "delete"] },
			],
			mappers,
		);
		expect(
			report.map((row) => [row.kind, row.status, row.unsupportedOperations]),
		).toEqual([
			["bucket", "partial", []],
			["kv", "partial", []],
		]);
		// SAFETY: this constructs Alchemy resources without running a provider.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.objects?.Type).toBe(Bucket.Type);
		expect(mapped.primary.sessions?.Type).toBe(Table.Type);
		expect(() => withAwsS3(original, { sessions: true })).toThrow(
			"unannotated bucket",
		);
		expect(() => withAwsS3(original, { missing: true })).toThrow(
			"unknown resource",
		);
	});
});

describe("explicit versioned AWS secret choice", () => {
	it("keeps the neutral declaration and maps bounded operations to the actual Alchemy secret", async () => {
		const original = bindle("shop", (b) => ({
			credentials: b.secret().allow("put", "access"),
		}));
		const selected = withAwsVersionedSecret(original, { credentials: true });
		expect(original.resources.credentials?.annotations).toEqual([]);
		expect(selected.resources.credentials?.annotations).toEqual([
			awsVersionedSecret(),
		]);
		const mappers = awsVersionedSecretBindleMappers(
			awsS3BindleMappers(awsDynamoKvBindleMappers()),
		);
		const report = describeAlchemyPrimitiveSupport(CATALOG_ROWS, mappers).find(
			(row) => row.kind === "secret",
		);
		expect(report).toMatchObject({
			status: "partial",
			supportedOperations: ["put", "access"],
		});
		// SAFETY: this registers Alchemy resource declarations without running a provider.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.credentials?.Type).toBe(Secret.Type);
		expect(() => mapBindleToAlchemy(original, mappers, requirements)).toThrow(
			"Secrets Manager requires",
		);
	});
});

describe("explicit DynamoDB durable queue choice", () => {
	it("maps a HoBo queue to an Alchemy table and reports its limits", async () => {
		const original = bindle("jobs-app", (b) => ({
			jobs: b.queue().allow("enqueue", "dequeue"),
		}));
		const selected = withAwsDynamoDurableQueue(original, { jobs: true });
		expect(original.resources.jobs?.annotations).toEqual([]);
		expect(selected.resources.jobs?.annotations).toEqual([
			awsDynamoDurableQueue(),
		]);
		expect(awsDynamoDurableQueue().config).toMatchObject({
			maxLogEvents: ATOMIC_QUEUE_MAX_EVENTS,
			maxLogBytes: ATOMIC_QUEUE_MAX_BYTES,
		});
		const mappers = awsDynamoDurableQueueMappers();
		const support = describeAlchemyPrimitiveSupport(
			[{ factory: "queue", allowVerbs: ["enqueue", "dequeue"] }],
			mappers,
		);
		expect(support[0]).toMatchObject({
			status: "partial",
			resourceTypes: [Table.Type],
			supportedOperations: ["enqueue", "dequeue"],
			bindsEntrypoint: false,
		});
		expect(support[0]?.limitations).toContain(
			"Supplied pricing must cover queue storage and requests; individual queue calls do not perform budget admission.",
		);
		// SAFETY: mapping registers resource constructors without running a provider.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "Jobs",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.jobs?.Type).toBe(Table.Type);
		expect(mapped.primary.jobs?.Props).toMatchObject({
			partitionKey: "pk",
			billingMode: "PAY_PER_REQUEST",
		});
		expect(() => mapBindleToAlchemy(original, mappers, requirements)).toThrow(
			"DynamoDB queue requires",
		);
		expect(() =>
			withAwsDynamoDurableQueue(original, { missing: true }),
		).toThrow("unknown resource");
	});
	it("composes the queue choice with independent KV and S3 choices", async () => {
		const original = bindle("app", (b) => ({
			jobs: b.queue().allow("enqueue", "dequeue"),
			sessions: b.kv().allow("get", "set"),
			objects: b.bucket().allow("read", "write"),
		}));
		const selected = withAwsDynamoDurableQueue(
			withAwsS3(withAwsDynamoKv(original, { sessions: true }), {
				objects: true,
			}),
			{ jobs: true },
		);
		const mappers = awsDynamoDurableQueueMappers(
			awsS3BindleMappers(awsDynamoKvBindleMappers()),
		);
		// SAFETY: mapping only registers constructors and does not call a cloud provider.
		const mapped = await Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, requirements).pipe(
				Effect.provideService(StackContext, {
					name: "App",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			) as Effect.Effect<import("../src/bindle.js").AlchemyBindleMapping>,
		);
		expect(mapped.primary.jobs?.Type).toBe(Table.Type);
		expect(mapped.primary.sessions?.Type).toBe(Table.Type);
		expect(mapped.primary.objects?.Type).toBe(Bucket.Type);
	});
	it("does not let modified object helpers hide a dependency", () => {
		const original = bindle("app", (b) => {
			const objects = b.bucket();
			return { objects, jobs: b.queue().dependsOn(objects) };
		});
		const selected = withAwsDynamoDurableQueue(original, { jobs: true });
		const declaration = selected.resources.jobs;
		const dependency = selected.resources.objects;
		const validate = awsDynamoDurableQueueMappers().queue.validate;
		if (
			declaration === undefined ||
			dependency === undefined ||
			validate === undefined
		)
			throw Error("fixture incomplete");
		const originalKeys = Object.keys;
		let error: unknown;
		try {
			Object.keys = () => [];
			try {
				validate({
					bindleName: selected.name,
					declaration,
					dependencyDeclarations: { objects: dependency },
					requirements: selected.requirements,
					entrypoint: undefined,
				});
			} catch (caught) {
				error = caught;
			}
		} finally {
			Object.keys = originalKeys;
		}
		expect(error).toMatchObject({ code: "BINDLE_GRAPH_UNSUPPORTED" });
	});

	it("refuses dependencies that have not been bound", () => {
		const original = bindle("jobs-app", (b) => {
			const objects = b.bucket();
			return { objects, jobs: b.queue().dependsOn(objects) };
		});
		const selected = withAwsDynamoDurableQueue(original, { jobs: true });
		expect(() =>
			mapBindleToAlchemy(
				selected,
				awsDynamoDurableQueueMappers(),
				requirements,
			),
		).toThrow("dependencies are not bound");
	});
});
