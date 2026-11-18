import { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { createTestHarness } from "../src/harness.js";
import {
	deployInProcess,
	InProcessStartupCleanupError,
} from "../src/lanes/in-process.js";

it("closes previously opened listeners when a later startup step fails", async () => {
	const failure = new Error("second entrypoint unavailable");
	let reads = 0;
	const bindle = {
		name: "partial-start",
		resources: {
			a: { kind: "api", dependsOn: [] },
			b: { kind: "api", dependsOn: [] },
		},
		edges: [],
		get entrypoint() {
			reads += 1;
			if (reads === 4) throw failure;
			return () => () => () => new Response("ok");
		},
	};
	const listening = vi.spyOn(Server.prototype, "listen");
	try {
		await expect(deployInProcess(bindle, "test")).rejects.toBe(failure);
		expect(listening.mock.instances).toHaveLength(1);
		expect(listening.mock.instances[0]?.listening).toBe(false);
	} finally {
		for (const server of listening.mock.instances) {
			if (server.listening)
				await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		listening.mockRestore();
	}
});

it("fences a failed startup until listener cleanup can be retried", async () => {
	const startupFailure = new Error("second entrypoint unavailable");
	const cleanupFailure = new Error("close failed");
	let reads = 0;
	const bindle = {
		name: "cleanup-retry",
		resources: {
			a: { kind: "api", dependsOn: [] },
			b: { kind: "api", dependsOn: [] },
		},
		edges: [],
		get entrypoint() {
			reads += 1;
			if (reads === 4) throw startupFailure;
			return () => () => () => new Response("ok");
		},
	};
	const listening = vi.spyOn(Server.prototype, "listen");
	const closing = vi
		.spyOn(Server.prototype, "close")
		.mockImplementationOnce(function (this: Server, callback) {
			queueMicrotask(() => callback?.(cleanupFailure));
			return this;
		});
	const harness = createTestHarness();
	try {
		const failure = await harness
			.deploy(bindle)()
			.catch((cause) => cause);
		expect(failure).toBeInstanceOf(InProcessStartupCleanupError);
		expect(failure.cause).toBe(startupFailure);
		expect(listening.mock.instances[0]?.listening).toBe(true);
		await expect(harness.deploy(bindle)()).rejects.toBe(failure);
		await harness.destroy(bindle)();
		expect(listening.mock.instances[0]?.listening).toBe(false);
		await harness.deploy(bindle)();
		await harness.destroy(bindle)();
	} finally {
		closing.mockRestore();
		for (const server of listening.mock.instances) {
			if (server.listening)
				await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		listening.mockRestore();
	}
});
