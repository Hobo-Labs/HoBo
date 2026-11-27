import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { createAwsQueueAtomicStore } from "../src/aws-queue-atomic-store.js";

const grant = {
	tableName: "queue-table",
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["get", "set"] as const,
};
function fixture(
	fetch: typeof globalThis.fetch,
	verify: () => boolean = () => true,
) {
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
		Layer.succeed(FetchHttpClient.Fetch, fetch),
	);
	return createAwsQueueAtomicStore({ grant, verify, layer });
}

describe("AWS queue atomic state", () => {
	it("uses a consistent read and copies returned state", async () => {
		let body = "";
		const store = fixture(async (_url, init) => {
			body = String(init?.body);
			return Response.json({
				Item: {
					pk: { S: "queue-state" },
					revision: { N: "2" },
					state: { B: "AQI=" },
				},
			});
		});
		expect(await store.load()).toEqual({
			status: "available",
			revision: 2,
			bytes: new Uint8Array([1, 2]),
		});
		expect(JSON.parse(body)).toMatchObject({
			ConsistentRead: true,
			Key: { pk: { S: "queue-state" } },
		});
	});
	it("uses the expected revision and snapshots bytes before dispatch", async () => {
		let body = "";
		const store = fixture(async (_url, init) => {
			body = String(init?.body);
			return Response.json({});
		});
		const bytes = new Uint8Array([1, 2]);
		const write = store.compareAndSwap(1, bytes);
		bytes[0] = 8;
		expect(await write).toEqual({ status: "committed" });
		expect(JSON.parse(body)).toMatchObject({
			ConditionExpression: "#revision = :revision",
			ExpressionAttributeValues: { ":revision": { N: "1" } },
			Item: { revision: { N: "2" }, state: { B: "AQI=" } },
		});
	});
	it("reports conflicts and service failures as unknown", async () => {
		const conflict = fixture(async () =>
			Response.json(
				{
					__type:
						"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException",
					message: "condition failed",
				},
				{ status: 400 },
			),
		);
		expect(await conflict.compareAndSwap(0, new Uint8Array([1]))).toEqual({
			status: "unknown",
		});
		const failed = fixture(async () =>
			Response.json(
				{
					__type: "com.amazonaws.dynamodb.v20120810#ValidationException",
					message: "invalid",
				},
				{ status: 400 },
			),
		);
		expect(await failed.load()).toEqual({ status: "unavailable" });
		expect(await failed.compareAndSwap(0, new Uint8Array([1]))).toEqual({
			status: "unknown",
		});
	});
	it("keeps a committed write unknown when its response is lost", async () => {
		let saved:
			| { pk: { S: string }; revision: { N: string }; state: { B: string } }
			| undefined;
		const store = fixture(async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (request.Item !== undefined) {
				saved = request.Item;
				return Response.json(
					{
						__type: "com.amazonaws.dynamodb.v20120810#ValidationException",
						message: "response lost",
					},
					{ status: 400 },
				);
			}
			return Response.json({ Item: saved });
		});
		expect(await store.compareAndSwap(0, new Uint8Array([7]))).toEqual({
			status: "unknown",
		});
		expect(await store.load()).toEqual({
			status: "available",
			revision: 1,
			bytes: new Uint8Array([7]),
		});
	});

	it("fails closed for malformed state, denied access, and invalid input", async () => {
		let calls = 0;
		const malformed = fixture(async () => {
			calls++;
			return Response.json({
				Item: {
					pk: { S: "queue-state" },
					revision: { N: "0" },
					state: { B: "AQ==" },
				},
			});
		});
		expect(await malformed.load()).toEqual({ status: "unavailable" });
		await expect(
			malformed.compareAndSwap(-1, new Uint8Array()),
		).rejects.toThrow();
		await expect(
			malformed.compareAndSwap(0, new Uint8Array(new SharedArrayBuffer(1))),
		).rejects.toThrow();
		expect(calls).toBe(1);
		const denied = fixture(
			async () => {
				calls++;
				return Response.json({});
			},
			() => false,
		);
		expect(await denied.load()).toEqual({ status: "unavailable" });
		expect(await denied.compareAndSwap(0, new Uint8Array())).toEqual({
			status: "unknown",
		});
		expect(calls).toBe(1);
	});
});
