import { createHash } from "node:crypto";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import {
	AWS_S3_MAX_OBJECT_BYTES,
	type AwsS3Grant,
	createAwsS3Store,
	inspectAwsS3Store,
} from "../src/aws-s3.js";

const defineTest = Object.defineProperty;
const grant: AwsS3Grant = {
	bucketName: "mapped-bucket",
	accountId: "000000000000",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["read", "write", "delete"],
};
function fixture(
	fetch: typeof globalThis.fetch,
	verify: Parameters<typeof createAwsS3Store>[0]["verify"] = () => true,
	selected: AwsS3Grant = grant,
) {
	let calls = 0;
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
		Layer.succeed(FetchHttpClient.Fetch, (url, init) => {
			calls++;
			return fetch(url, init);
		}),
	);
	return {
		store: createAwsS3Store({ grant: selected, verify, layer }),
		calls: () => calls,
	};
}
const body = new Uint8Array([1, 2, 3]);
const object = {
	name: "tenant-a/object",
	contentType: "application/octet-stream",
	digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
	size: body.length,
	body,
};

describe("S3 bounded object runtime", () => {
	it("captures exact permissions even if includes changes during construction", async () => {
		const original = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"includes",
		);
		let call: Promise<void>;
		let calls: () => number;
		try {
			Object.defineProperty(Array.prototype, "includes", {
				value: () => true,
				configurable: true,
			});
			const f = fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow: ["read"] },
			);
			calls = f.calls;
			call = f.store.delete("key");
		} finally {
			if (original)
				Object.defineProperty(Array.prototype, "includes", original);
		}
		await expect(call).rejects.toMatchObject({ code: "AWS_S3_DENIED" });
		expect(calls()).toBe(0);
	});
	it("does not report a write before transport completion when Promise.race is replaced", async () => {
		let release: ((response: Response) => void) | undefined;
		const transport = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const f = fixture(() => transport);
		const original = Promise.race;
		let write: Promise<void>;
		try {
			// SAFETY: restore the intrinsic immediately after starting this request.
			Promise.race = () => Promise.resolve({});
			write = f.store.write(object);
		} finally {
			Promise.race = original;
		}
		await vi.waitFor(() => expect(f.calls()).toBe(1), { timeout: 5000 });
		let completed = false;
		void write.then(() => {
			completed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(completed).toBe(false);
		release?.(new Response(null, { status: 200 }));
		await write;
		expect(completed).toBe(true);
	});
	it("does not broaden a grant when Array.includes is replaced", async () => {
		const f = fixture(
			async () => new Response(),
			() => true,
			{ ...grant, allow: ["read"] },
		);
		const descriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"includes",
		);
		let call: Promise<void>;
		try {
			Object.defineProperty(Array.prototype, "includes", {
				value: () => true,
				configurable: true,
			});
			call = f.store.delete("key");
		} finally {
			if (descriptor)
				Object.defineProperty(Array.prototype, "includes", descriptor);
		}
		await expect(call).rejects.toMatchObject({ code: "AWS_S3_DENIED" });
		expect(f.calls()).toBe(0);
	});
	it("returns objects without assimilating a hostile inherited then", async () => {
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "then");
		let intercepted = 0;
		let checks = 0;
		const restore = () => {
			if (original) defineTest(Object.prototype, "then", original);
			else Reflect.deleteProperty(Object.prototype, "then");
		};
		const f = fixture(
			async () =>
				new Response(body, {
					status: 200,
					headers: {
						"content-length": String(body.length),
						"content-type": object.contentType,
						"x-amz-meta-hobo-digest": object.digest,
					},
				}),
			() => {
				if (++checks === 3) {
					defineTest(Object.prototype, "then", {
						value: () => {
							intercepted++;
						},
						configurable: true,
					});
					queueMicrotask(restore);
				}
				return true;
			},
		);
		try {
			expect(await f.store.read(object.name)).toEqual(object);
		} finally {
			restore();
		}
		expect(intercepted).toBe(0);
	});
	it("does not invoke accessors in grant permissions", () => {
		let invoked = false;
		const allow: AwsS3Grant["allow"] = Object.defineProperty(["read"], "0", {
			enumerable: true,
			get() {
				invoked = true;
				return "read";
			},
		});
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow },
			),
		).toThrow("AWS_S3_GRANT_INVALID");
		expect(invoked).toBe(false);
	});
	it("retains immutable store identity and rejects lookalikes", () => {
		const f = fixture(async () => new Response());
		const captured = inspectAwsS3Store(f.store);
		expect(captured).toEqual(grant);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.isFrozen(captured?.allow)).toBe(true);
		expect(inspectAwsS3Store({ ...f.store })).toBeUndefined();
	});

	it("rejects invalid grants, keys and object metadata without a request", async () => {
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow: ["read", "read"] },
			),
		).toThrow("AWS_S3_GRANT_INVALID");
		const f = fixture(async () => new Response());
		for (const key of ["", "\ud800", "x".repeat(1025)])
			await expect(f.store.read(key)).rejects.toMatchObject({
				code: "AWS_S3_KEY_INVALID",
			});
		await expect(
			f.store.write({ ...object, digest: `sha256:${"0".repeat(64)}` }),
		).rejects.toMatchObject({ code: "AWS_S3_OBJECT_INVALID" });
		const oversized = new Uint8Array(AWS_S3_MAX_OBJECT_BYTES + 1);
		Object.defineProperty(oversized, "byteLength", { value: 1 });
		await expect(
			f.store.write({ ...object, body: oversized }),
		).rejects.toMatchObject({ code: "AWS_S3_OBJECT_INVALID" });
		expect(f.calls()).toBe(0);
	});
	it("sends the expected AWS account on every object request", async () => {
		const owners: (string | null)[] = [];
		const f = fixture(async (_url, init) => {
			owners.push(
				new Headers(init?.headers).get("x-amz-expected-bucket-owner"),
			);
			return init?.method === "GET"
				? new Response("<Error><Code>NoSuchKey</Code></Error>", {
						status: 404,
						headers: { "content-type": "application/xml" },
					})
				: new Response(null, { status: 200 });
		});
		expect(await f.store.read(object.name)).toBeUndefined();
		await f.store.write(object);
		await f.store.delete(object.name);
		expect(owners).toEqual([grant.accountId, grant.accountId, grant.accountId]);
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, accountId: "bad" },
			),
		).toThrow("AWS_S3_GRANT_INVALID");
	});

	it("enforces operation and key scope and reports revoked writes as uncertain", async () => {
		let allowed = true;
		const f = fixture(
			async () => {
				allowed = false;
				return new Response(null, { status: 200 });
			},
			(_grant, _op, key) => allowed && key.startsWith("tenant-a/"),
		);
		await expect(f.store.read("tenant-b/object")).rejects.toMatchObject({
			code: "AWS_S3_DENIED",
		});
		expect(f.calls()).toBe(0);
		await expect(f.store.write(object)).rejects.toMatchObject({
			code: "AWS_S3_MUTATION_OUTCOME_UNKNOWN",
		});
		expect(f.calls()).toBe(1);
		const readOnly = fixture(
			async () => new Response(),
			() => true,
			{ ...grant, allow: ["read"] },
		);
		await expect(readOnly.store.delete(object.name)).rejects.toMatchObject({
			code: "AWS_S3_DENIED",
		});
		expect(readOnly.calls()).toBe(0);
	});
	it("rechecks authorization after transport and before returning", async () => {
		for (const op of ["read", "write", "delete"] as const) {
			let checks = 0;
			const f = fixture(
				async () =>
					op === "read"
						? new Response("<Error><Code>NoSuchKey</Code></Error>", {
								status: 404,
								headers: { "content-type": "application/xml" },
							})
						: new Response(null, { status: 200 }),
				() => ++checks < 3,
			);
			const call =
				op === "read"
					? f.store.read(object.name)
					: op === "write"
						? f.store.write(object)
						: f.store.delete(object.name);
			await expect(call).rejects.toMatchObject({
				code:
					op === "read"
						? "AWS_S3_READ_UNAVAILABLE"
						: "AWS_S3_MUTATION_OUTCOME_UNKNOWN",
			});
			expect(checks).toBe(3);
		}
	});
	it("rejects corrupted or unsupported object data", async () => {
		const response = () =>
			new Response(new Uint8Array([9, 9, 9]), {
				status: 200,
				headers: {
					"content-length": "3",
					"content-type": object.contentType,
					"x-amz-meta-hobo-digest": object.digest,
				},
			});
		await expect(
			fixture(async () => response()).store.read(object.name),
		).rejects.toMatchObject({ code: "AWS_S3_READ_UNAVAILABLE" });
		const missingMetadata = fixture(
			async () =>
				new Response(new Uint8Array([1]), {
					status: 200,
					headers: {
						"content-length": "1",
						"content-type": object.contentType,
					},
				}),
		);
		await expect(missingMetadata.store.read(object.name)).rejects.toMatchObject(
			{ code: "AWS_S3_READ_UNAVAILABLE" },
		);
	});
	it("cancels a response stream when its metadata cannot be represented", async () => {
		let cancelled = 0;
		const f = fixture(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1]));
						},
						cancel() {
							cancelled++;
						},
					}),
					{
						status: 200,
						headers: {
							"content-length": "1",
							"content-type": object.contentType,
						},
					},
				),
		);
		await expect(f.store.read(object.name)).rejects.toMatchObject({
			code: "AWS_S3_READ_UNAVAILABLE",
		});
		expect(cancelled).toBe(1);
	});
});
