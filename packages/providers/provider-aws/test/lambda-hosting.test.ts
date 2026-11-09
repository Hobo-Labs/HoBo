import {
	type HttpTransport,
	parseResolveRequest,
	type TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { AWS_LAMBDA_PRODUCT_ID, awsResolverRegistry } from "../src/index.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";

const region = "us-east-1";
const account = "123456789012";
const functionArn = `arn:aws:lambda:${region}:${account}:function:app`;
const owner = `sha256:${"b".repeat(64)}`;
const artifact = `sha256:${"c".repeat(64)}`;
const image = `${account}.dkr.ecr.${region}.amazonaws.com/app@sha256:${"a".repeat(64)}`;
const role = `arn:aws:iam::${account}:role/hosting`;
const desired = {
	image,
	executionRoleArn: role,
	memoryMb: 512,
	timeoutSeconds: 30,
	reservedConcurrency: 2,
	architecture: "arm64",
	ownershipRef: owner,
	artifactDigest: artifact,
};
function request(changes: JsonObject = {}, physicalId?: string) {
	const ref = {
		slot: "service",
		productId: AWS_LAMBDA_PRODUCT_ID,
		logicalId: "app",
	};
	return parseResolveRequest({
		ref: physicalId === undefined ? ref : { ...ref, physicalId },
		desired: { ...desired, ...changes },
		credentialRef: "secret://hosting/aws",
	});
}
function resolver() {
	const value = awsResolverRegistry({
		region,
		resolveCredential: async () => ({
			accessKeyId: "AKIAEXAMPLEKEYID12345",
			secretAccessKey: "secret-material-never-persisted",
		}),
		nowMs: Date.parse("2026-10-29T00:00:00Z"),
	}).get(AWS_LAMBDA_PRODUCT_ID);
	if (!value) throw new Error("missing Lambda hosting resolver");
	return value;
}
function record(overrides: JsonObject = {}): JsonObject {
	return {
		Configuration: {
			FunctionName: "app",
			FunctionArn: functionArn,
			PackageType: "Image",
			Role: role,
			MemorySize: 512,
			Timeout: 30,
			Architectures: ["arm64"],
			State: "Active",
			LastUpdateStatus: "Successful",
			RevisionId: "revision-1",
		},
		Code: { ImageUri: image, ResolvedImageUri: image },
		Concurrency: { ReservedConcurrentExecutions: 2 },
		Tags: { "hobo:owner": owner, "hobo:artifact": artifact },
		...overrides,
	};
}
function response(body: JsonObject, status = 200) {
	return { status, headers: {}, body: JSON.stringify(body) };
}
function api(
	options: {
		initial?: JsonObject;
		loseCreateAck?: boolean;
		retainAfterDelete?: boolean;
	} = {},
) {
	let stored = options.initial;
	let lost = false;
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		if (call.method === "GET")
			return stored === undefined ? response({}, 404) : response(stored);
		if (call.method === "POST") {
			stored = record({ Concurrency: {} });
			if (options.loseCreateAck && !lost) {
				lost = true;
				throw new Error("connection reset after commit");
			}
			return response({}, 201);
		}
		if (call.method === "DELETE") {
			if (!options.retainAfterDelete) stored = undefined;
			return { status: 204, headers: {}, body: "" };
		}
		const body = parseJsonObject(call.body ?? "{}");
		if (new URL(call.url).pathname.endsWith("/concurrency")) {
			stored = {
				...stored,
				Concurrency: {
					ReservedConcurrentExecutions: body.ReservedConcurrentExecutions ?? 0,
				},
			};
			return response({
				ReservedConcurrentExecutions: body.ReservedConcurrentExecutions ?? 0,
			});
		}
		stored = record({
			Code: {
				ImageUri: body.ImageUri ?? image,
				ResolvedImageUri: body.ImageUri ?? image,
			},
		});
		return response({});
	};
	return { transport, calls };
}
describe("Lambda container-image hosting resolver", () => {
	it("reports the independently observed image digest separately from deployment metadata", async () => {
		const observed = await resolver().read?.(
			request(),
			api({ initial: record() }).transport,
		);
		expect(observed?.outputs).toMatchObject({
			artifactDigest: `sha256:${"a".repeat(64)}`,
			artifactMarker: artifact,
		});
		const missing = await resolver().read?.(
			request(),
			api({ initial: record({ Code: { ImageUri: "repo/app:latest" } }) })
				.transport,
		);
		expect(missing?.outputs.artifactDigest).toBeUndefined();
		expect(missing?.outputs.ready).toBe(false);
	});
	it("creates one digest-pinned function with explicit capacity and ownership, then converges", async () => {
		const fake = api();
		const first = await resolver().reconcile(request(), fake.transport);
		const second = await resolver().reconcile(request(), fake.transport);
		expect(first).toMatchObject({
			action: "create",
			physicalId: functionArn,
			outputs: { ready: true, operationConfirmed: true },
		});
		expect(second.action).toBe("adopt");
		const creates = fake.calls.filter((call) => call.method === "POST");
		expect(creates).toHaveLength(1);
		expect(parseJsonObject(creates[0]?.body ?? "{}")).toMatchObject({
			FunctionName: "app",
			PackageType: "Image",
			Role: role,
			Code: { ImageUri: image },
			MemorySize: 512,
			Timeout: 30,
			Tags: { "hobo:owner": owner },
		});
	});
	it("recovers a lost create acknowledgement without another create", async () => {
		const fake = api({ loseCreateAck: true });
		await expect(
			resolver().reconcile(request(), fake.transport),
		).rejects.toThrow("connection reset");
		expect(
			(await resolver().reconcile(request(), fake.transport)).outputs.ready,
		).toBe(true);
		expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("requires immutable artifacts and explicit bounded capacity before network I/O", async () => {
		for (const changes of [
			{ image: `${image.split("@")[0]}:latest` },
			{ memoryMb: 0 },
			{ timeoutSeconds: 901 },
			{ executionRoleArn: "unknown-role" },
			{ architecture: "other" },
		]) {
			const fake = api();
			await expect(
				resolver().reconcile(request(changes), fake.transport),
			).rejects.toThrow();
			expect(fake.calls).toHaveLength(0);
		}
	});
	it("rejects a wrongly typed Lambda setting before resolving credentials", async () => {
		let credentialCalls = 0;
		const lambda = awsResolverRegistry({
			region,
			resolveCredential: async () => {
				credentialCalls += 1;
				return {
					accessKeyId: "AKIAEXAMPLEKEYID12345",
					secretAccessKey: "secret-material-never-persisted",
				};
			},
			nowMs: Date.parse("2026-10-29T00:00:00Z"),
		}).get(AWS_LAMBDA_PRODUCT_ID);
		if (!lambda) throw new Error("missing Lambda hosting resolver");
		const fake = api();
		await expect(
			lambda.reconcile(request({ memoryMb: "512" }), fake.transport),
		).rejects.toThrow(/desired.memoryMb must be an integer/);
		expect(credentialCalls).toBe(0);
		expect(fake.calls).toHaveLength(0);
	});
	it.each([
		["Code", { Code: "malformed" }],
		["Concurrency", { Concurrency: "malformed" }],
	])("refuses a malformed native %s object without writing", async (_field, changes) => {
		const fake = api({ initial: record(changes) });
		await expect(
			resolver().reconcile(request(), fake.transport),
		).rejects.toThrow(/not an object/);
		expect(fake.calls.map((call) => call.method)).toEqual(["GET"]);
	});
	it("rejects a foreign account or ownership before adopting or retiring", async () => {
		const fake = api({
			initial: record({ Tags: { "hobo:owner": "another-owner" } }),
		});
		await expect(resolver().delete(request(), fake.transport)).rejects.toThrow(
			/ownership/,
		);
		expect(fake.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
		await expect(
			resolver().read?.(
				request({}, functionArn.replace(account, "999999999999")),
				fake.transport,
			),
		).rejects.toThrow(/scope/);
	});
	it("does not call an active endpoint ready until provider initialization settles", async () => {
		const fake = api({
			initial: record({
				Configuration: {
					FunctionName: "app",
					FunctionArn: functionArn,
					PackageType: "Image",
					State: "Pending",
					LastUpdateStatus: "InProgress",
				},
			}),
		});
		expect(
			(await resolver().read?.(request(), fake.transport))?.outputs,
		).toMatchObject({ ready: false, operationConfirmed: false });
	});
	it("fences image updates with the observed provider revision", async () => {
		const fake = api({ initial: record() });
		const next = image.replace("a".repeat(64), "c".repeat(64));
		expect(
			(await resolver().reconcile(request({ image: next }), fake.transport))
				.outputs.ready,
		).toBe(true);
		const update = fake.calls.find((call) => call.method === "PUT");
		expect(new URL(update?.url ?? "https://invalid.example").pathname).toBe(
			"/2015-03-31/functions/app/code",
		);
		expect(parseJsonObject(update?.body ?? "{}")).toMatchObject({
			ImageUri: next,
			RevisionId: "revision-1",
		});
	});
	it("requires a new immutable target for combined code and capacity changes", async () => {
		const fake = api({ initial: record() });
		await expect(
			resolver().reconcile(
				request({
					image: image.replace("a".repeat(64), "c".repeat(64)),
					memoryMb: 1024,
				}),
				fake.transport,
			),
		).rejects.toThrow(/new immutable target/);
		expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	});
	it("confirms retirement with an independent absent read", async () => {
		const fake = api({ initial: record() });
		await resolver().delete(request(), fake.transport);
		expect(fake.calls.map((call) => call.method)).toEqual([
			"GET",
			"DELETE",
			"GET",
		]);
		await expect(
			resolver().delete(
				request(),
				api({ initial: record(), retainAfterDelete: true }).transport,
			),
		).rejects.toThrow(/retirement is not confirmed/);
	});
	it("does not rewrite an unchanged configuration when provider initialization failed", async () => {
		const initial = record();
		const configuration = parseJsonObject(
			JSON.stringify(initial.Configuration),
		);
		const fake = api({
			initial: record({
				Configuration: {
					...configuration,
					State: "Failed",
					LastUpdateStatus: "Failed",
				},
			}),
		});
		const result = await resolver().reconcile(request(), fake.transport);
		expect(result.outputs.ready).toBe(false);
		expect(fake.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
	});
	it("does not retire a reused function carrying another artifact", async () => {
		const fake = api({
			initial: record({
				Tags: {
					"hobo:owner": owner,
					"hobo:artifact": `sha256:${"d".repeat(64)}`,
				},
			}),
		});
		await expect(resolver().delete(request(), fake.transport)).rejects.toThrow(
			/artifact/,
		);
		expect(fake.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
	});
});
