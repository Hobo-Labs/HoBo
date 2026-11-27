import { Table } from "@alchemy.run/aws/DynamoDB";
import { Bucket } from "@alchemy.run/aws/S3";
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
		expect(mapped.resources.map((resource) => resource.FQN).sort()).toEqual([
			"events",
			"jobs",
			"objects",
			"sessions",
		]);
	});
	it("reports infrastructure-only support and rejects runtime claims", () => {
		const report = describeAwsPrimitiveSupport(CATALOG_ROWS);
		for (const kind of ["kv", "bucket", "queue", "topic"]) {
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
