import { describe, expect, it } from "vitest";
import {
	CapabilityParseError,
	evaluateCapabilityGrants,
	inferCapabilityUsage,
	parseCapabilityGrant,
} from "../../src/capability/index.js";
import type { JsonObject } from "../../src/json.js";

const sourceText = `
  import { api, kv } from "@hobo/bindles";

  const todos = kv("todos").allow("get");
  todos.get("todo-1");

  const http = api("api", { bind: { todos } });
  http.route("GET", "/todos", () => todos.get("todo-1"));
`;

describe("evaluateCapabilityGrants", () => {
	it("infers the used-set and records it as manifest grants", () => {
		const result = evaluateCapabilityGrants({
			sourceText,
			manifest: {
				schema: "hobo.manifest/v1",
				resources: {
					todos: {
						type: "data.v1",
						port: "wasi:keyvalue",
						allow: ["get"],
					},
					api: {
						type: "component.v1",
						links: [{ import: "wasi:keyvalue", to: "todos" }],
					},
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(result.manifest as { resources: JsonObject }).resources.todos,
		).toEqual(
			expect.objectContaining({
				usage: {
					inferred: ["get"],
					source: "static-analysis",
				},
			}),
		);
		expect(result.grants).toEqual([
			{
				componentId: "api",
				importInterface: "wasi:keyvalue",
				resource: "todos",
				operations: ["get"],
			},
		]);
	});

	it("fails can-deploy when .allow narrows below observed usage", () => {
		const result = evaluateCapabilityGrants({
			sourceText: `
      import { kv } from "@hobo/bindles";
      const todos = kv("todos").allow("get");
      todos.set("todo-1", { title: "ship" });
    `,
			manifest: {
				schema: "hobo.manifest/v1",
				resources: {
					todos: {
						type: "data.v1",
						port: "wasi:keyvalue",
						allow: ["get"],
					},
				},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.diagnostics).toEqual([
			{
				code: "capability.allow.narrow-below-usage",
				severity: "error",
				resource: "todos",
				allowedOperations: ["get"],
				observedOperations: ["set"],
				message:
					"Resource todos observes capability operations outside declared .allow().",
				fileName: "bindle.ts",
				line: 0,
			},
		]);
	});
});

describe("inferCapabilityUsage", () => {
	it("fails closed when static analysis cannot prove a dynamic capability call", () => {
		const usage = inferCapabilityUsage({
			sourceText: `
      import { kv } from "@hobo/bindles";
      const todos = kv("todos").allow("get");
      todos[method]("todo-1");
    `,
			fileName: "dynamic.ts",
		});

		expect(usage.ok).toBe(false);
		expect(usage.diagnostics).toEqual([
			{
				code: "capability.usage.cannot-prove-operation",
				severity: "error",
				resource: "todos",
				operationPrefix: "(root)",
				fileName: "dynamic.ts",
				line: 4,
				message:
					"Static analysis cannot prove capability operation for todos; capability grants must fail closed.",
			},
		]);
	});
});

describe("parseCapabilityGrant", () => {
	it("accepts valid grants and rejects invalid operations", () => {
		const grant = parseCapabilityGrant({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			resource: "todos",
			operations: ["get"],
		});
		expect(grant.operations).toEqual(["get"]);

		expect(() =>
			parseCapabilityGrant({
				componentId: "",
				importInterface: "wasi:keyvalue",
				resource: "todos",
				operations: ["get"],
			}),
		).toThrow(CapabilityParseError);

		expect(() =>
			parseCapabilityGrant({
				componentId: "api",
				importInterface: "wasi:keyvalue",
				resource: "todos",
				operations: [],
			}),
		).toThrow(CapabilityParseError);
	});
});
