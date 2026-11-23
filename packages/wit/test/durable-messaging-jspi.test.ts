import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "wit", "deps");

describe("durable messaging JSPI compatibility ABI", () => {
	it("retains exactly the native message and receipt shapes with a distinct interface identity", async () => {
		const native = await readFile(
			join(root, "hobo-durable-messaging", "hobo-durable-messaging.wit"),
			"utf8",
		);
		const compat = await readFile(
			join(
				root,
				"hobo-durable-messaging-jspi",
				"hobo-durable-messaging-jspi.wit",
			),
			"utf8",
		);
		const expected = native
			.replace(
				"package hobo:durable-messaging@0.1.0;",
				"package hobo:durable-messaging-jspi@0.1.0;",
			)
			.replaceAll(": async func(", ": func(")
			.replace(
				"world durable-messaging-guest {",
				"world durable-messaging-jspi-guest {",
			)
			.replace(
				"world durable-messaging-provider {",
				"world durable-messaging-jspi-provider {",
			);
		expect(compat).toBe(expected);
		expect(native).toContain("ensure-topic: async func");
		expect(compat).toContain("ensure-topic: func");
	});
});
