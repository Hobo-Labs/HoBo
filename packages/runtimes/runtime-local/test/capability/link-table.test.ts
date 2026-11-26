import { CapabilityDeniedError, evaluateCapabilityGrants } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createCapabilityLinkTable } from "../../src/capability/link-table.js";

const sourceText = `
  import { api, kv } from "@hobo/bindles";

  const todos = kv("todos").allow("get");
  todos.get("todo-1");

  const http = api("api", { bind: { todos } });
  http.route("GET", "/todos", () => todos.get("todo-1"));
`;

describe("createCapabilityLinkTable", () => {
	it("requires both a link and an inferred grant before routing a capability call", async () => {
		const evaluation = evaluateCapabilityGrants({
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
		const runtime = createCapabilityLinkTable({ grants: evaluation.grants });
		runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		runtime.registerProvider({
			id: "local-kv",
			exports: {
				"wasi:keyvalue": {
					get: ({ key }: { key: string }) => ({ value: `stored:${key}` }),
					set: () => ({ ok: true }),
				},
			},
		});
		runtime.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});

		const handle = runtime.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});

		expect(
			await runtime.callWithHandle(handle, "get", { key: "todo-1" }),
		).toEqual({
			value: "stored:todo-1",
		});
		expect(runtime.events().some((event) => event.type === "link.Called")).toBe(
			true,
		);

		await expect(
			runtime.callWithHandle(handle, "set", { key: "todo-1", value: "mutate" }),
		).rejects.toMatchObject({
			code: "capability.operation-not-granted",
			operation: "set",
		});
		expect(
			runtime
				.events()
				.filter((event) => event.type === "capability.GrantDenied")
				.at(-1),
		).toMatchObject({ reason: "capability.operation-not-granted" });
	});

	it("refuses to issue a handle for a linked import without an inferred grant", () => {
		const runtime = createCapabilityLinkTable();
		runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		runtime.registerProvider({
			id: "local-kv",
			exports: {
				"wasi:keyvalue": {
					get: () => ({ value: "should-not-route" }),
				},
			},
		});
		runtime.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});

		expect(() =>
			runtime.issueHandle({
				componentId: "api",
				importInterface: "wasi:keyvalue",
			}),
		).toThrow(CapabilityDeniedError);
		expect(() =>
			runtime.issueHandle({
				componentId: "api",
				importInterface: "wasi:keyvalue",
			}),
		).toThrow(
			expect.objectContaining({ code: "capability.no-inferred-grant" }),
		);
	});

	it("rejects fabricated handles even when their visible fields match a real handle", async () => {
		const runtime = createCapabilityLinkTable({
			grants: [
				{
					componentId: "api",
					importInterface: "wasi:keyvalue",
					resource: "todos",
					operations: ["get"],
				},
			],
		});
		runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		runtime.registerProvider({
			id: "local-kv",
			exports: {
				"wasi:keyvalue": {
					get: () => ({ value: "secret" }),
				},
			},
		});
		runtime.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});
		const real = runtime.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});
		const forged = {
			componentId: real.componentId,
			importInterface: real.importInterface,
			token: real.token,
		};

		await expect(
			runtime.callWithHandle(forged, "get", { key: "secret" }),
		).rejects.toMatchObject({
			code: "capability.fabricated-handle",
		});
		expect(runtime.events().some((event) => event.type === "link.Called")).toBe(
			false,
		);
	});

	it("ambient provider reachability is not enough without link table entry", async () => {
		const runtime = createCapabilityLinkTable({
			grants: [
				{
					componentId: "api",
					importInterface: "wasi:keyvalue",
					resource: "todos",
					operations: ["get"],
				},
			],
		});
		runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		runtime.registerProvider({
			id: "local-kv",
			exports: {
				"wasi:keyvalue": {
					get: () => ({ value: "should-not-route" }),
				},
			},
		});
		const handle = runtime.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});

		await expect(
			runtime.callWithHandle(handle, "get", { key: "todo-1" }),
		).rejects.toMatchObject({
			code: "capability.no-linked-route",
		});
	});

	it("refuses undeclared imports at link time", () => {
		const runtime = createCapabilityLinkTable({
			grants: [
				{
					componentId: "api",
					importInterface: "wasi:keyvalue",
					resource: "todos",
					operations: ["get"],
				},
			],
		});
		runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		runtime.registerProvider({
			id: "local-kv",
			exports: { "wasi:keyvalue": { get: () => ({ value: "ok" }) } },
		});

		expect(() =>
			runtime.link({
				componentId: "api",
				importInterface: "wasi:blobstore",
				providerId: "local-kv",
				exportInterface: "wasi:blobstore",
			}),
		).toThrow(
			expect.objectContaining({ code: "capability.import-not-declared" }),
		);
	});
});
