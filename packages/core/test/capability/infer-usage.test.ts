import { describe, expect, it } from "vitest";

import { inferCapabilityUsage } from "../../src/capability/infer-usage.js";

describe("inferCapabilityUsage", () => {
	it("maps bindles factories to WIT ports", () => {
		const usage = inferCapabilityUsage({
			sourceText: `
        import { kv, api } from "@hobo/bindles";
        const todos = kv("todos");
        todos.get("a");
        const http = api("api");
      `,
		});

		expect(usage.ok).toBe(true);
		expect(usage.resources).toContainEqual(
			expect.objectContaining({
				resource: "todos",
				factory: "kv",
				port: "wasi:keyvalue",
				operations: ["get"],
			}),
		);
	});

	it("infers the asynchronous durable messaging port for a topic", () => {
		const usage = inferCapabilityUsage({
			sourceText: `
        import { topic } from "@hobo/bindles";
        const orders = topic("orders");
        orders.publish("created");
      `,
		});
		expect(usage.resources).toContainEqual(
			expect.objectContaining({
				resource: "orders",
				factory: "topic",
				port: "hobo:durable-messaging",
				operations: ["publish"],
			}),
		);
	});
});
