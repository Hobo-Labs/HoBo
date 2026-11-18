import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonString } from "../src/json.js";
import { createHttpDependencyObserver } from "../src/orchestrator/http-dependency-observer.js";
import type { DependencyObservationRequest } from "../src/orchestrator/orchestrator.js";

const dependency = {
	name: "db",
	port: "database",
	provider: "local",
	deps: [],
};
const dependent = {
	name: "api",
	port: "compute",
	provider: "local",
	deps: ["db"],
};
const request: DependencyObservationRequest = {
	deploymentId: "shop",
	dependent,
	dependency,
	snapshot: {
		deploymentId: "shop",
		resourceId: "db",
		state: "Provisioned",
		sequence: 1,
		outputs: {},
		deps: [],
	},
	condition: "ready",
};

describe("HTTP dependency observation", () => {
	let baseUrl = "";
	let ready = false;
	const server = createServer((req, res) => {
		if (req.url === "/slow") {
			setTimeout(() => res.writeHead(204).end(), 100);
			return;
		}
		res.writeHead(req.url === "/completed" || ready ? 204 : 503).end();
	});
	beforeAll(async () => {
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || isJsonString(address)) throw new Error("missing listener");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("observes readiness and completion using their configured endpoints", async () => {
		const observe = createHttpDependencyObserver({
			resolveUrl: ({ condition }) => `${baseUrl}/${condition}`,
		});
		expect(await observe(request)).toBe("pending");
		expect(await observe({ ...request, condition: "completed" })).toBe(
			"completed",
		);
		ready = true;
		expect(await observe(request)).toBe("ready");
	});

	it("leaves missing and timed-out observations pending", async () => {
		const missing = createHttpDependencyObserver({
			resolveUrl: () => undefined,
		});
		const slow = createHttpDependencyObserver({
			resolveUrl: () => `${baseUrl}/slow`,
			timeoutMs: 10,
		});
		expect(await missing(request)).toBe("pending");
		expect(await slow(request)).toBe("pending");
	});

	it("rejects invalid timeout settings", () => {
		expect(() =>
			createHttpDependencyObserver({
				resolveUrl: () => undefined,
				timeoutMs: 0,
			}),
		).toThrow(RangeError);
	});
});
