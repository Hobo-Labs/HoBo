import { Table } from "@alchemy.run/aws/DynamoDB";
import { Bucket } from "@alchemy.run/aws/S3";
import { Secret } from "@alchemy.run/aws/SecretsManager";
import { Topic } from "@alchemy.run/aws/SNS";
import { Queue } from "@alchemy.run/aws/SQS";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { CATALOG_ROWS } from "../../../bindles/src/types.js";
import { awsBindleMappers, describeAwsPrimitiveSupport } from "../src/aws.js";
import {
	awsDynamoKv,
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
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
	it("maps declared primitives to the actual Alchemy AWS resource types", async () => {
		const definition = bindle("shop", (b) => ({
			sessions: b.kv(),
			objects: b.bucket(),
			jobs: b.queue(),
			events: b.topic(),
			credentials: b.secret(),
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
		expect(mapped.primary.credentials?.Props).toEqual({
			recoveryWindowInDays: 30,
		});
		expect(mapped.resources.map((resource) => resource.FQN).sort()).toEqual([
			"credentials",
			"events",
			"jobs",
			"objects",
			"sessions",
		]);
	});
	it("reports infrastructure-only support and rejects runtime claims", () => {
		const report = describeAwsPrimitiveSupport(CATALOG_ROWS);
		for (const kind of ["kv", "bucket", "queue", "topic", "secret"]) {
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
	});
	it("refuses declared dependencies that have no runtime binding", () => {
		const definition = bindle("shop", (b) => {
			const objects = b.bucket();
			return { objects, jobs: b.queue().dependsOn(objects) };
		});
		expect(() =>
			mapBindleToAlchemy(definition, awsBindleMappers(), requirements),
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
