import { describe, expect, it } from "vitest";
import {
	createBucketEmulator,
	createKeyValueEmulator,
	createTestHarness,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			cache: { kind: "kv" },
			otherCache: { kind: "kv" },
			files: { kind: "bucket" },
			otherFiles: { kind: "bucket" },
		},
		handlers: {},
	});
}

describe("WASI storage doubles", () => {
	it("isolates key-value stores and copies bytes both into and out of storage", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const kv = graph.kv("cache");
			const value = Buffer.from([1, 2]);
			kv.set({ key: "hello", value });
			value[0] = 9;
			const read = kv.get("hello");
			expect(read).toEqual(new Uint8Array([1, 2]));
			if (!read) throw new Error("expected a value");
			read[1] = 9;
			expect(kv.get("hello")).toEqual(new Uint8Array([1, 2]));
			expect(kv.exists("hello")).toBe(true);
			expect(graph.kv("otherCache").get("hello")).toBeUndefined();
			kv.delete("hello");
			kv.delete("hello");
			expect(kv.exists("hello")).toBe(false);
			expect(graph.resource("cache").fidelity).toBe("simulated");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("keeps bucket metadata and test-only body inspection isolated", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const bucket = graph.bucket("files");
			const metadata = {
				name: "report",
				contentType: "text/plain",
				digest: "test-digest",
				size: 2n,
			};
			const bytes = Buffer.from([3, 4]);
			bucket.put(metadata, bytes);
			metadata.contentType = "changed";
			bytes[0] = 9;
			const found = bucket.get("report");
			expect(found?.contentType).toBe("text/plain");
			if (!found) throw new Error("expected metadata");
			found.contentType = "changed-again";
			expect(bucket.get("report")?.contentType).toBe("text/plain");
			const body = graph.bucketInspector("files")?.readBody("report");
			expect(body).toEqual(new Uint8Array([3, 4]));
			if (!body) throw new Error("expected a body");
			body[1] = 9;
			expect(graph.bucketInspector("files")?.readBody("report")).toEqual(
				new Uint8Array([3, 4]),
			);
			expect(graph.bucket("otherFiles").get("report")).toBeUndefined();
			bucket.delete("report");
			expect(
				graph.bucketInspector("files")?.readBody("report"),
			).toBeUndefined();
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("allows replacements and starts fresh on redeploy", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				kv: () => ({
					...createKeyValueEmulator(),
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
				bucket: () => ({
					port: createBucketEmulator().port,
					fidelity: "mocked",
				}),
			},
		});
		const bindle = app();
		let graph = await harness.deploy(bindle)();
		graph.kv("cache").set({ key: "hello", value: new Uint8Array([1]) });
		expect(graph.bucketInspector("files")).toBeUndefined();
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		graph = await harness.deploy(bindle)();
		try {
			expect(graph.kv("cache").get("hello")).toBeUndefined();
		} finally {
			await harness.destroy(bindle)();
		}
		expect(closed).toBe(4);
	});
});
