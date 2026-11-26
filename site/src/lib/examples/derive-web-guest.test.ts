import { describe, expect, it } from "vitest";

import { loadExamplesCatalog } from "./catalog.js";
import { deriveWebGuestFromBindle } from "./derive-web-guest.js";

describe("deriveWebGuestFromBindle", () => {
	it("fails closed when Bindle has no web entrypoint", async () => {
		const { bindle } = await import("@hobo/bindles");
		const definition = bindle((b) => ({ kv: b.kv() }));
		expect(() => deriveWebGuestFromBindle(definition, "")).toThrow(/no web entrypoint/);
	});

	it("derives kv-backed try-runtime for todo-api without custom guest handlers", async () => {
		const catalog = await loadExamplesCatalog();
		const todos = catalog.find(({ id }) => id === "todo-api")!;
		expect(todos.handlersSource).toBe("");
		expect(todos.runtime.resources.todos).toEqual({ kind: "kv", initial: [] });
		expect(todos.runtime.routes.map(({ action }) => action)).toEqual([
			"health",
			"list",
			"create",
			"toggle",
		]);
		expect(todos.source).toContain("@trainable");
		expect(todos.source).toContain("b.web(Todos)");
	});
});
