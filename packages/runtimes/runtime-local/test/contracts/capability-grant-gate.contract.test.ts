import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCapabilityGrants } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createCapabilityLinkTable } from "../../src/capability/link-table.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"contracts",
	"capability-grant-gate.pact.json",
);

const sourceText = `
  import { api, kv } from "@hobo/bindles";
  const todos = kv("todos").allow("get");
  todos.get("todo-1");
  const http = api("api", { bind: { todos } });
`;

describe("capability-grant-gate pact", () => {
	it("replays granted get and ungranted set interactions", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8"));
		expect(pact.consumer.name).toBe("RuntimeLocalLinkTable");
		expect(pact.provider.name).toBe("CapabilityProviderExport");

		const evaluation = evaluateCapabilityGrants({
			sourceText,
			manifest: {
				schema: "hobo.manifest/v1",
				resources: {
					todos: { type: "data.v1", port: "wasi:keyvalue", allow: ["get"] },
					api: {
						type: "component.v1",
						links: [{ import: "wasi:keyvalue", to: "todos" }],
					},
				},
			},
		});

		const table = createCapabilityLinkTable({ grants: evaluation.grants });
		table.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
		table.registerProvider({
			id: "local-kv",
			exports: {
				"wasi:keyvalue": {
					get: ({ key }: { key: string }) => ({ value: `stored:${key}` }),
					set: () => ({ ok: true }),
				},
			},
		});
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

		const granted = pact.interactions[0];
		expect(
			await table.callWithHandle(handle, "get", granted.request.body.payload),
		).toEqual(granted.response.body.result);

		const denied = pact.interactions[1];
		await expect(
			table.callWithHandle(
				handle,
				denied.request.body.operation,
				denied.request.body.payload,
			),
		).rejects.toMatchObject({ code: denied.response.body.code });
	});
});
