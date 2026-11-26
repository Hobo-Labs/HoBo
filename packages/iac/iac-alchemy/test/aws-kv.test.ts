import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import {
	AWS_KV_MAX_IN_FLIGHT,
	AWS_KV_MAX_VALUE_BYTES,
	type AwsKvGrant,
	createAwsDynamoKvStore,
	inspectAwsDynamoKvStore,
} from "../src/aws-kv.js";

const defineTest = Object.defineProperty;
const grant: AwsKvGrant = {
	tableName: "mapped-table",
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["get", "set", "delete"],
};
function fixture(
	fetch: typeof globalThis.fetch,
	verify: Parameters<typeof createAwsDynamoKvStore>[0]["verify"] = () => true,
	selected: AwsKvGrant = grant,
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
		store: createAwsDynamoKvStore({ grant: selected, verify, layer }),
		calls: () => calls,
	};
}

describe("DynamoDB KV runtime", () => {
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
				{ ...grant, allow: ["get"] },
			);
			calls = f.calls;
			call = f.store.delete("key");
		} finally {
			if (original)
				Object.defineProperty(Array.prototype, "includes", original);
		}
		await expect(call).rejects.toMatchObject({ code: "AWS_KV_DENIED" });
		expect(calls()).toBe(0);
	});
	it("does not broaden a grant when Array.includes is replaced", async () => {
		const f = fixture(
			async () => new Response(),
			() => true,
			{ ...grant, allow: ["get"] },
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
			call = f.store.set({ key: "key", value: new Uint8Array([1]) });
		} finally {
			if (descriptor)
				Object.defineProperty(Array.prototype, "includes", descriptor);
		}
		await expect(call).rejects.toMatchObject({ code: "AWS_KV_DENIED" });
		expect(f.calls()).toBe(0);
	});
	it("returns bytes without assimilating a hostile inherited then", async () => {
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "then");
		let intercepted = 0;
		let checks = 0;
		const restore = () => {
			if (original) defineTest(Object.prototype, "then", original);
			else Reflect.deleteProperty(Object.prototype, "then");
		};
		const f = fixture(
			async () =>
				Response.json({ Item: { pk: { S: "key" }, value: { B: "AQI=" } } }),
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
			expect(await f.store.get("key")).toEqual(new Uint8Array([1, 2]));
		} finally {
			restore();
		}
		expect(intercepted).toBe(0);
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
			write = f.store.set({ key: "key", value: new Uint8Array([1]) });
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
		release?.(new Response("{}", { status: 200 }));
		await write;
		expect(completed).toBe(true);
	});
	it("rejects accessor grants and invalid names despite changed regular expression methods", () => {
		let invoked = false;
		const allow: AwsKvGrant["allow"] = Object.defineProperty(["get"], "0", {
			enumerable: true,
			get() {
				invoked = true;
				return "get";
			},
		});
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow },
			),
		).toThrow("AWS_KV_GRANT_INVALID");
		expect(invoked).toBe(false);
		const original = RegExp.prototype.exec;
		let failure: unknown;
		try {
			RegExp.prototype.exec = () => original.call(/valid/u, "valid");
			try {
				fixture(
					async () => new Response(),
					() => true,
					{ ...grant, tableName: "!" },
				);
			} catch (error) {
				failure = error;
			}
		} finally {
			RegExp.prototype.exec = original;
		}
		expect(failure).toMatchObject({ code: "AWS_KV_GRANT_INVALID" });
	});
	it("retains immutable store identity and rejects lookalikes", () => {
		const f = fixture(async () => new Response());
		const captured = inspectAwsDynamoKvStore(f.store);
		expect(captured).toEqual(grant);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.isFrozen(captured?.allow)).toBe(true);
		expect(inspectAwsDynamoKvStore({ ...f.store })).toBeUndefined();
		const descriptor = Object.getOwnPropertyDescriptor(
			WeakMap.prototype,
			"get",
		);
		let forged: AwsKvGrant | undefined;
		let real: AwsKvGrant | undefined;
		try {
			Object.defineProperty(WeakMap.prototype, "get", {
				value: () => grant,
				configurable: true,
			});
			forged = inspectAwsDynamoKvStore({ ...f.store });
			real = inspectAwsDynamoKvStore(f.store);
		} finally {
			if (descriptor)
				Object.defineProperty(WeakMap.prototype, "get", descriptor);
		}
		expect(forged).toBeUndefined();
		expect(real).toEqual(grant);
	});

	it("rejects invalid grants and values without making a request", async () => {
		const transport = vi.fn(async () => new Response("{}"));
		expect(() =>
			fixture(transport, () => true, { ...grant, allow: ["get", "get"] }),
		).toThrow("AWS_KV_GRANT_INVALID");
		const f = fixture(transport);
		for (const key of ["", "\ud800", "x".repeat(2049)])
			await expect(f.store.get(key)).rejects.toMatchObject({
				code: "AWS_KV_KEY_INVALID",
			});
		await expect(
			f.store.set({
				key: "ok",
				value: new Uint8Array(AWS_KV_MAX_VALUE_BYTES + 1),
			}),
		).rejects.toMatchObject({ code: "AWS_KV_VALUE_INVALID" });
		const value = new Uint8Array(AWS_KV_MAX_VALUE_BYTES + 1);
		Object.defineProperty(value, "byteLength", { value: 1 });
		await expect(f.store.set({ key: "ok", value })).rejects.toMatchObject({
			code: "AWS_KV_VALUE_INVALID",
		});
		expect(f.calls()).toBe(0);
	});
	it("addresses every operation to the exact partition, account, region and table ARN", async () => {
		const tables: unknown[] = [];
		const f = fixture(async (url, init) => {
			const data: { TableName?: unknown } = await new Request(url, init).json();
			tables.push(data.TableName);
			return new Response("{}", { status: 200 });
		});
		expect(await f.store.get("key")).toBeUndefined();
		await f.store.set({ key: "key", value: new Uint8Array([7]) });
		await f.store.delete("key");
		expect(tables).toEqual(
			Array(3).fill(
				"arn:aws:dynamodb:us-east-1:000000000000:table/mapped-table",
			),
		);
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, accountId: "bad" },
			),
		).toThrow("AWS_KV_GRANT_INVALID");
	});

	it("enforces explicit operations and reports mutations whose authorization changes as unknown", async () => {
		let authorized = true;
		const f = fixture(
			async () => {
				authorized = false;
				return new Response("{}", { status: 200 });
			},
			() => authorized,
		);
		await expect(
			f.store.set({ key: "key", value: new Uint8Array([7]) }),
		).rejects.toMatchObject({ code: "AWS_KV_MUTATION_OUTCOME_UNKNOWN" });
		expect(f.calls()).toBe(1);
		await expect(f.store.get("key")).rejects.toMatchObject({
			code: "AWS_KV_DENIED",
		});
		expect(f.calls()).toBe(1);
		const readonly = fixture(
			async () => new Response("{}"),
			() => true,
			{ ...grant, allow: ["get"] },
		);
		await expect(readonly.store.delete("key")).rejects.toMatchObject({
			code: "AWS_KV_DENIED",
		});
		expect(readonly.calls()).toBe(0);
		const scoped = fixture(
			async () => new Response("{}"),
			(_grant, _operation, key) => key.startsWith("tenant-a:"),
		);
		await expect(scoped.store.get("tenant-b:key")).rejects.toMatchObject({
			code: "AWS_KV_DENIED",
		});
		expect(scoped.calls()).toBe(0);
		expect(await scoped.store.get("tenant-a:key")).toBeUndefined();
	});
	it("denies an accidentally asynchronous verifier without an unhandled rejection", async () => {
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: simulate a JavaScript host violating the synchronous verifier contract.
		const badVerify = (() =>
			Promise.reject(new Error("host failure"))) as unknown as Parameters<
			typeof createAwsDynamoKvStore
		>[0]["verify"];
		const f = fixture(async () => new Response("{}"), badVerify);
		await expect(f.store.get("key")).rejects.toMatchObject({
			code: "AWS_KV_DENIED",
		});
		expect(f.calls()).toBe(0);
	});

	it("revalidates after the transport result and before returning to the caller", async () => {
		for (const operation of ["get", "set", "delete"] as const) {
			let checks = 0;
			const f = fixture(
				async () => new Response("{}"),
				() => ++checks < 3,
			);
			const call =
				operation === "get"
					? f.store.get("key")
					: operation === "set"
						? f.store.set({ key: "key", value: new Uint8Array([1]) })
						: f.store.delete("key");
			await expect(call).rejects.toMatchObject({
				code:
					operation === "get"
						? "AWS_KV_READ_UNAVAILABLE"
						: "AWS_KV_MUTATION_OUTCOME_UNKNOWN",
			});
			expect(checks).toBe(3);
		}
	});

	it("does not disclose existence after authorization changes between awaits", async () => {
		let allowed = true;
		let checks = 0;
		const f = fixture(
			async () => new Response("{}"),
			() => {
				checks++;
				if (checks === 3)
					queueMicrotask(() => {
						allowed = false;
					});
				return allowed;
			},
		);
		await expect(f.store.exists("key")).rejects.toMatchObject({
			code: "AWS_KV_READ_UNAVAILABLE",
		});
	});

	it("rejects malformed stored items and treats failed writes as uncertain", async () => {
		const malformed = fixture(async () =>
			Response.json({ Item: { pk: { S: "key" } } }),
		);
		await expect(malformed.store.get("key")).rejects.toMatchObject({
			code: "AWS_KV_READ_UNAVAILABLE",
		});
		const failed = fixture(async () =>
			Response.json(
				{
					__type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
					message: "missing",
				},
				{ status: 400 },
			),
		);
		await expect(
			failed.store.set({ key: "key", value: new Uint8Array([1]) }),
		).rejects.toMatchObject({ code: "AWS_KV_MUTATION_OUTCOME_UNKNOWN" });
	});

	it("keeps timed-out calls charged against capacity until their requests settle", {
		timeout: 30_000,
	}, async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blocked = true;
		const f = fixture(async () => {
			if (blocked) await gate;
			return new Response("{}", { status: 200 });
		});
		const calls = [
			f.store
				.set({ key: "key", value: new Uint8Array([1]) })
				.catch((error) => error),
			...Array.from({ length: AWS_KV_MAX_IN_FLIGHT - 1 }, () =>
				f.store.get("key").catch((error) => error),
			),
		];
		await vi.waitFor(() => expect(f.calls()).toBe(AWS_KV_MAX_IN_FLIGHT), {
			timeout: 5000,
		});
		const outcomes = await Promise.all(calls);
		expect(outcomes[0].code).toBe("AWS_KV_MUTATION_OUTCOME_UNKNOWN");
		expect(
			outcomes
				.slice(1)
				.every((error) => error.code === "AWS_KV_READ_UNAVAILABLE"),
		).toBe(true);
		await expect(f.store.get("key")).rejects.toMatchObject({
			code: "AWS_KV_CAPACITY",
		});
		blocked = false;
		release?.();
		await vi.waitFor(
			async () => expect(await f.store.get("key")).toBeUndefined(),
			{ timeout: 5000 },
		);
	});
});
