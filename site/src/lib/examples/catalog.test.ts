import { describe, expect, it } from "vitest";

import { loadExamplesCatalog } from "./catalog.js";
import { parseExamplesCatalog } from "./catalog-contract.js";

describe("Examples catalog", () => {
	it("loads the four try-site examples from their repository folders", async () => {
		const catalog = await loadExamplesCatalog();

		expect(catalog.map((example) => example.id)).toEqual([
			"hello-world",
			"opensaas",
			"swaghaus",
			"todo-api",
		]);
		expect(catalog[0]).toMatchObject({
			entry: "app.ts",
			sourcePath: "examples/try-site/apps/hello-world/app.ts",
			ui: "hello",
		});
		expect(catalog[0]?.source).toContain("bindle(");
		expect(catalog[0]?.source).toContain("b.web()");
		expect(catalog[0]?.source).not.toContain("@trainable");
		expect(catalog[0]?.source).toContain("export const runtime");
		expect(catalog[0]?.source).not.toContain("handlers.txt");
		expect(catalog[0]?.handlersSource).toContain("greet");
		expect(catalog[0]?.handlersSource).toContain("Hello World!");
		expect(catalog[0]?.runtime).toMatchObject({
			schemaVersion: "hobo.try-runtime/v1",
			resources: {},
		});
		expect(catalog[0]?.runtime.routes).toEqual([
			{ method: "GET", path: "/health", action: "health" },
			{ method: "POST", path: "/api/greet", action: "greet" },
		]);
		const todos = catalog.find(({ id }) => id === "todo-api");
		expect(todos?.source).toContain("@trainable");
		expect(todos?.source).toContain("b.web(Todos)");
		expect(todos?.source).not.toContain("export const runtime");
		expect(todos?.handlersSource).toBe("");
		expect(todos?.runtime.resources).toEqual({
			todos: { kind: "kv", initial: [] },
		});
		expect(todos?.runtime.routes).toEqual([
			{ method: "GET", path: "/health", action: "health" },
			{ method: "GET", path: "/api/todos", action: "list", resource: "todos" },
			{ method: "POST", path: "/api/todos", action: "create", resource: "todos" },
			{
				method: "PATCH",
				path: "/api/todos/:id",
				action: "toggle",
				resource: "todos",
			},
		]);
		const saas = catalog.find(({ id }) => id === "opensaas");
		expect(saas?.source).toContain("b.container");
		expect(saas?.source).toContain("waspApp(");
		expect(saas?.source).toContain("examples/wasp-opensaas/app");
		expect(saas?.source).not.toContain("hobo/opensaas-");
		expect(saas?.source).not.toContain("sourceUrl");
		expect(saas?.source).toContain("b.web(");
		expect(saas?.deployKind).toBe("local-bridge");
		expect(saas?.bindleContainers).toEqual([
			{ name: "db", image: "postgres:16-alpine" },
		]);
		expect(saas?.bindleWebApp).toEqual({
			framework: "wasp",
			root: "examples/wasp-opensaas/app",
		});
		expect(saas?.handlersSource).toBe("");
		expect(saas?.source).not.toContain("// === Executed:");
		const swag = catalog.find(({ id }) => id === "swaghaus");
		expect(swag?.source).toContain("convexApp(");
		expect(swag?.source).toContain("examples/convex-swaghaus");
		expect(swag?.source).toContain("b.external");
		expect(swag?.source).toContain("b.container");
		expect(swag?.source).not.toContain("hobo/convex-");
		expect(swag?.deployKind).toBe("local-bridge");
		expect(swag?.bindleWebApp).toEqual({
			framework: "convex",
			root: "examples/convex-swaghaus",
		});
		expect(swag?.bindleContainers).toEqual([
			{ name: "backend", image: "ghcr.io/get-convex/convex-backend:latest" },
		]);
		expect(swag?.handlersSource).toBe("");
	});

	it("fails closed when the browser catalog has a malformed nested contract", async () => {
		const catalog = JSON.parse(JSON.stringify(await loadExamplesCatalog()));
		expect(parseExamplesCatalog(catalog)).toHaveLength(4);
		catalog[0].runtime.routes[0].action = "execute-arbitrary-code";

		expect(() => parseExamplesCatalog(catalog)).toThrow(/action is invalid/);
	});

	it("keeps policy layers sparse and provider selection on individual Yards", async () => {
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world");
		const todos = catalog.find(({ id }) => id === "todo-api");
		const saas = catalog.find(({ id }) => id === "opensaas");
		const swag = catalog.find(({ id }) => id === "swaghaus");

		expect(hello?.appPolicy).toEqual({});
		expect(hello?.topology.allowedYardIds).toBeNull();
		expect(hello?.deploymentPolicy).toEqual({});
		expect(todos?.appPolicy).toEqual({});
		expect(todos?.topology.allowedYardIds).toBeNull();
		expect(saas?.ui).toBe("saas");
		expect(saas?.topology.allowedYardIds).toEqual([
			"yard:webernetes",
			"yard:lakebed",
			"yard:cloudflare",
			"yard:vercel",
		]);
		expect(swag?.ui).toBe("saas");
		expect(swag?.appPolicy).toMatchObject({ preferLocal: false, maxReplicas: 1 });
		expect(swag?.topology.allowedYardIds).toEqual([
			"yard:cloudflare",
			"yard:vercel",
			"yard:netlify",
			"yard:webernetes",
			"yard:lakebed",
		]);
		expect(
			new Set(hello?.topology.yards.map(({ providerId }) => providerId)).size,
		).toBe(hello?.topology.yards.length);
	});
});
