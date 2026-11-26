import {
	CapabilityDeniedError,
	type CapabilityDiagnostic,
	type CapabilityGrant,
	type CapabilityLinkTableEvent,
	evaluateCapabilityGrants,
	inferCapabilityUsage,
} from "@hobo/core";
import { expect, test } from "vitest";
import type { JsonValue } from "../json.js";

import type { CapabilityHandle, CapabilityLinkTable } from "./host-types.js";

export interface CapabilityHostFactoryOptions {
	grants?: readonly CapabilityGrant[];
	eventSink?: (event: CapabilityLinkTableEvent) => void;
}

export type CapabilityHostFactory = (
	options?: CapabilityHostFactoryOptions,
) => CapabilityLinkTable;

const sourceText = `
  import { api, kv } from "@hobo/bindles";

  const todos = kv("todos").allow("get");
  todos.get("todo-1");

  const http = api("api", { bind: { todos } });
  http.route("GET", "/todos", () => todos.get("todo-1"));
`;

const manifest = {
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
};

function registerKvProvider(table: CapabilityLinkTable): void {
	table.registerProvider({
		id: "local-kv",
		exports: {
			"wasi:keyvalue": {
				get: (...args: JsonValue[]) => {
					// SAFETY: assertion to `args[0] as { key: string }` is required at this boundary.
					const payload = args[0] as { key: string };
					return { value: `stored:${payload.key}` };
				},
				set: () => ({ ok: true }),
			},
		},
	});
}

export function capabilityEnforcementSuite(
	hostFactory: CapabilityHostFactory,
): void {
	test("declared link and inferred grant route the call", async () => {
		const evaluation = evaluateCapabilityGrants({ sourceText, manifest });
		const table = hostFactory({ grants: evaluation.grants });
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);
		table.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});
		const handle = table.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});
		await expect(
			table.callWithHandle(handle, "get", { key: "todo-1" }),
		).resolves.toEqual({
			value: "stored:todo-1",
		});
	});

	test("undeclared import is refused with capability.import-not-declared at link time", () => {
		const evaluation = evaluateCapabilityGrants({ sourceText, manifest });
		const table = hostFactory({ grants: evaluation.grants });
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);

		expect(() =>
			table.link({
				componentId: "api",
				importInterface: "wasi:blobstore",
				providerId: "local-kv",
				exportInterface: "wasi:blobstore",
			}),
		).toThrow(CapabilityDeniedError);
		expect(() =>
			table.link({
				componentId: "api",
				importInterface: "wasi:blobstore",
				providerId: "local-kv",
				exportInterface: "wasi:blobstore",
			}),
		).toThrow(
			expect.objectContaining({ code: "capability.import-not-declared" }),
		);

		table.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});
	});

	test("linked-but-ungranted handle issuance is refused", () => {
		const table = hostFactory();
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);
		table.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});

		expect(() =>
			table.issueHandle({
				componentId: "api",
				importInterface: "wasi:keyvalue",
			}),
		).toThrow(
			expect.objectContaining({ code: "capability.no-inferred-grant" }),
		);
	});

	test("granted-but-unlinked call is refused", async () => {
		const evaluation = evaluateCapabilityGrants({ sourceText, manifest });
		const table = hostFactory({ grants: evaluation.grants });
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);
		const handle = table.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});

		await expect(
			table.callWithHandle(handle, "get", { key: "todo-1" }),
		).rejects.toMatchObject({
			code: "capability.no-linked-route",
		});
	});

	test("operation outside grant is refused", async () => {
		const evaluation = evaluateCapabilityGrants({ sourceText, manifest });
		const table = hostFactory({ grants: evaluation.grants });
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);
		table.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});
		const handle = table.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});

		await expect(
			table.callWithHandle(handle, "set", { key: "todo-1", value: "mutate" }),
		).rejects.toMatchObject({ code: "capability.operation-not-granted" });
	});

	test("fabricated handle is refused with no link.Called emitted", async () => {
		const evaluation = evaluateCapabilityGrants({ sourceText, manifest });
		const events: CapabilityLinkTableEvent[] = [];
		const table = hostFactory({
			grants: evaluation.grants,
			eventSink: (event) => events.push(event),
		});
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		registerKvProvider(table);
		table.link({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			providerId: "local-kv",
			exportInterface: "wasi:keyvalue",
		});
		const real = table.issueHandle({
			componentId: "api",
			importInterface: "wasi:keyvalue",
		});
		const forged: CapabilityHandle = {
			componentId: real.componentId,
			importInterface: real.importInterface,
			token: real.token,
		};

		await expect(
			table.callWithHandle(forged, "get", { key: "secret" }),
		).rejects.toMatchObject({
			code: "capability.fabricated-handle",
		});
		expect(events.some((event) => event.type === "link.Called")).toBe(false);
	});

	test(".allow narrowing below usage fails can-deploy", () => {
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
		expect(
			result.diagnostics.some(
				(d: CapabilityDiagnostic) =>
					d.code === "capability.allow.narrow-below-usage",
			),
		).toBe(true);
	});

	test("dynamic call fails closed with capability.usage.cannot-prove-operation", () => {
		const usage = inferCapabilityUsage({
			sourceText: `
        import { kv } from "@hobo/bindles";
        const todos = kv("todos").allow("get");
        todos[method]("todo-1");
      `,
			fileName: "dynamic.ts",
		});

		expect(usage.ok).toBe(false);
		expect(
			usage.diagnostics.some(
				(d: CapabilityDiagnostic) =>
					d.code === "capability.usage.cannot-prove-operation",
			),
		).toBe(true);
	});
}
