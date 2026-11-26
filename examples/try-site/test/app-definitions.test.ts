import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { describe, expect, it } from "vitest";

import type { BindleDefinition } from "@hobo/bindles";
import hello, { runtime } from "../apps/hello-world/app.js";
import helloMeta from "../apps/hello-world/meta.json" with { type: "json" };
import opensaas from "../apps/opensaas/app.js";
import opensaasMeta from "../apps/opensaas/meta.json" with { type: "json" };
import swaghaus from "../apps/swaghaus/app.js";
import swaghausMeta from "../apps/swaghaus/meta.json" with { type: "json" };
import todosMeta from "../apps/todo-api/meta.json" with { type: "json" };

function isObject<T>(value: T): value is T & object {
	return Object(value) === value;
}

function isFunction<T>(value: T): boolean {
	return Object.prototype.toString.call(value) === "[object Function]";
}

function isBindleDefinition<T>(value: T): value is T & BindleDefinition {
	if (!isObject(value)) return false;
	return (
		"name" in value &&
		Object.prototype.toString.call(value.name) === "[object String]" &&
		"resources" in value &&
		isObject(value.resources) &&
		"requirements" in value &&
		isObject(value.requirements) &&
		"entrypoint" in value &&
		isFunction(value.entrypoint)
	);
}

interface BindleModule {
	readonly default: BindleDefinition;
}

function parseBindleModule<T>(value: T): BindleModule {
	if (!isObject(value) || !("default" in value)) {
		throw new TypeError("app module has no default export");
	}
	if (!isObject(value.default) || !isBindleDefinition(value.default)) {
		throw new TypeError("app default export is not a Bindle definition");
	}
	return { default: value.default };
}

interface TodoApi {
	list(): { items: unknown[] };
	create(text: string): { text: string };
	toggle(id: string): { id: string };
}

type TodoEntrypoint = ReturnType<
	NonNullable<ReturnType<BindleDefinition["entrypoint"]>>
>;

function isTodoApi(value: TodoEntrypoint): value is TodoApi & TodoEntrypoint {
	if (!isObject(value)) return false;
	return (
		"list" in value &&
		isFunction(value.list) &&
		"create" in value &&
		isFunction(value.create) &&
		"toggle" in value &&
		isFunction(value.toggle)
	);
}

function parseTodoApi(value: TodoEntrypoint): TodoApi {
	if (!isTodoApi(value)) {
		throw new TypeError("todo web entrypoint did not return the Todos component");
	}
	return value;
}

describe("try-site app definitions", () => {
	it("binds hello-world as minimal b.web() with runtime + handlers", async () => {
		const root = fileURLToPath(new URL("../apps/hello-world", import.meta.url));
		const appSource = await readFile(path.join(root, "app.ts"), "utf8");
		const handlers = await readFile(path.join(root, "handlers.txt"), "utf8");
		expect(appSource).toContain("b.web()");
		expect(appSource).not.toContain("@trainable");
		expect(appSource).toContain("export const runtime");
		expect(handlers).toContain("Hello World!");
		expect(helloMeta.entry).toBe("app.ts");
		expect(hello.resources.web?.kind).toBe("web");
		expect(hello.requirements.require).toEqual(["http"]);
		expect(hello.requirements.runtimes).toEqual(["wasm"]);
		expect(runtime.routes.map(({ action }) => action)).toEqual(["health", "greet"]);
	});

	it("binds todo-api trainable Todos to b.web with kv", async () => {
		const root = fileURLToPath(new URL("../apps/todo-api", import.meta.url));
		const appSource = await readFile(path.join(root, "app.ts"), "utf8");
		const { default: todos } = parseBindleModule(
			await tsImport(path.join(root, "app.ts"), import.meta.url),
		);
		expect(appSource).toContain("@trainable");
		expect(appSource).toContain("b.web(Todos)");
		expect(appSource).not.toContain("export const runtime");
		expect(todosMeta.entry).toBe("app.ts");
		expect(todos.resources.web?.kind).toBe("web");
		expect(todos.resources.todos?.kind).toBe("kv");
		expect(todos.requirements.require).toEqual(expect.arrayContaining(["http", "kv"]));
		expect(todos.requirements.runtimes).toContain("wasm");
		const makeWeb = todos.entrypoint("web");
		expect(Object.prototype.toString.call(makeWeb)).toBe("[object Function]");
		if (makeWeb === undefined) {
			throw new Error("todo bindle has no web entrypoint");
		}
		const instance = parseTodoApi(makeWeb());
		expect(instance.list()).toEqual({ items: [] });
		expect(instance.create("ship it").text).toBe("ship it");
		expect(instance.toggle("1").id).toBe("1");
	});

	it("packages OpenSaaS as waspApp(root) + Postgres OCI (not HoBo image tags)", async () => {
		const { bindleContainerImages } = await import(
			"../apps/opensaas/bindle-containers.js"
		);
		const {
			discoverWaspEnv,
			isWaspWebAppAnnotation,
			waspRootFromAnnotations,
		} = await import("@hobo/wasp");
		expect(opensaasMeta.deployKind).toBe("local-bridge");
		expect(opensaas.requirements.require).toEqual(["container", "http"]);
		expect(opensaas.requirements.runtimes).toEqual(["oci"]);
		const opensaasWeb = opensaas.resources.web;
		if (opensaasWeb === undefined) {
			throw new Error("OpenSaaS bindle has no web resource");
		}
		expect(opensaas.resources.db?.kind).toBe("container");
		expect(opensaasWeb.kind).toBe("web");
		expect(opensaas.resources.server).toBeUndefined();
		expect(opensaas.resources.client).toBeUndefined();
		expect(opensaasWeb.annotations.some(isWaspWebAppAnnotation)).toBe(true);
		expect(waspRootFromAnnotations(opensaasWeb.annotations)).toBe(
			"examples/wasp-opensaas/app",
		);
		const images = Object.fromEntries(
			bindleContainerImages(opensaas).map((entry) => [entry.name, entry.image]),
		);
		expect(images).toEqual({ db: "postgres:16-alpine" });
		expect(JSON.stringify(images)).not.toMatch(/hobo\/opensaas-/u);
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const discovered = await discoverWaspEnv(
			repoRoot,
			"examples/wasp-opensaas/app",
		);
		expect(discovered.generalEnv).toContain("DATABASE_URL");
		expect(discovered.serverExampleKeys.length).toBeGreaterThan(5);
	});

	it("packages Swaghaus as convexApp(root) + Convex OCI container + WorkOS (no HoBo image tags)", async () => {
		const {
			convexRootFromAnnotations,
			discoverConvexEnv,
			isConvexWebAppAnnotation,
		} = await import("@hobo/convex");
		expect(swaghausMeta.deployKind).toBe("local-bridge");
		expect(swaghausMeta.ui).toBe("saas");
		const swaghausWeb = swaghaus.resources.web;
		if (swaghausWeb === undefined) {
			throw new Error("Swaghaus bindle has no web resource");
		}
		expect(swaghaus.resources.backend?.kind).toBe("container");
		expect(swaghaus.resources.auth?.kind).toBe("external");
		expect(swaghausWeb.kind).toBe("web");
		expect(swaghausWeb.annotations.some(isConvexWebAppAnnotation)).toBe(true);
		expect(convexRootFromAnnotations(swaghausWeb.annotations)).toBe(
			"examples/convex-swaghaus",
		);
		expect(JSON.stringify(swaghaus)).toContain(
			"ghcr.io/get-convex/convex-backend",
		);
		expect(JSON.stringify(swaghaus)).not.toMatch(/hobo\/convex-/u);
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const discovered = await discoverConvexEnv(
			repoRoot,
			"examples/convex-swaghaus",
		);
		expect(discovered.hasConvexDir).toBe(true);
		expect(discovered.generalEnv).toEqual(
			expect.arrayContaining([
				"VITE_CONVEX_URL",
				"VITE_WORKOS_CLIENT_ID",
				"CONVEX_DEPLOY_KEY",
			]),
		);
	});
});
