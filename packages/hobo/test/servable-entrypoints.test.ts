import type {
	BindleDefinition,
	BindleResourceRecord,
	ProviderAnnotation,
	ResourceKind,
} from "@hobo/bindles";
import { describe, expect, it } from "vitest";

import {
	isExternalComponent,
	listServableEntrypoints,
	listServableEntrypointsWithReplay,
} from "../src/servable-entrypoints.js";

type Entrypoint = NonNullable<ReturnType<BindleDefinition["entrypoint"]>>;

type ResourceSpec = {
	readonly kind: ResourceKind;
	readonly handler?: ReturnType<Entrypoint>;
	readonly annotations?: readonly Omit<ProviderAnnotation, "provider">[];
};

function definition(
	resources: Readonly<Record<string, ResourceSpec>>,
): BindleDefinition {
	const records: Record<string, BindleResourceRecord> = {};
	for (const [name, spec] of Object.entries(resources)) {
		records[name] = {
			kind: spec.kind,
			name,
			stableId: `${spec.kind}:${name}`,
			declaredAllow: [],
			annotations: (spec.annotations ?? []).map((annotation) => ({
				provider: "test",
				...annotation,
			})),
			dependsOn: [],
		};
	}
	return {
		name: "app",
		resources: records,
		edges: [],
		requirements: { require: [], prefer: [], runtimes: [], labels: {} },
		entrypoint: (name: string) => {
			const handler = resources[name]?.handler;
			if (handler === undefined) return undefined;
			return () => handler;
		},
	};
}

const ok = () => new Response("hello");

function serve(
	def: BindleDefinition,
): ReturnType<typeof listServableEntrypoints> {
	return listServableEntrypoints(def, { env: {} });
}

describe("isExternalComponent", () => {
	it("makes only web public when nothing says otherwise", () => {
		expect(isExternalComponent("web", [])).toBe(true);
		for (const kind of ["api", "service", "ui", "kv"]) {
			expect(isExternalComponent(kind, [])).toBe(false);
		}
	});

	it("lets an endpoint annotation open or close any kind", () => {
		const open = [{ option: "endpoint", config: { external: true } }];
		const closed = [{ option: "endpoint", config: { external: false } }];
		expect(isExternalComponent("api", open)).toBe(true);
		expect(isExternalComponent("web", closed)).toBe(false);
	});

	it("ignores annotations that are not endpoint, or whose value is not boolean", () => {
		expect(
			isExternalComponent("api", [
				{ option: "env", config: { external: true } },
			]),
		).toBe(false);
		expect(
			isExternalComponent("api", [
				{ option: "endpoint", config: { external: "true" } },
			]),
		).toBe(false);
		expect(
			isExternalComponent("api", [{ option: "endpoint", config: {} }]),
		).toBe(false);
	});

	it("takes the first endpoint annotation that carries a boolean", () => {
		expect(
			isExternalComponent("api", [
				{ option: "endpoint", config: { external: true } },
				{ option: "endpoint", config: { external: false } },
			]),
		).toBe(true);
	});
});

describe("entrypoint collection", () => {
	it("collects the four HTTP App Kits and nothing else", () => {
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				api: { kind: "api", handler: ok },
				svc: { kind: "service", handler: ok },
				panel: { kind: "ui", handler: ok },
				cache: { kind: "kv", handler: ok },
				queue: { kind: "queue", handler: ok },
			}),
		);
		expect(entries.map((entry) => entry.name).sort()).toEqual([
			"api",
			"panel",
			"site",
			"svc",
		]);
	});

	it("skips a resource whose entrypoint is missing", async () => {
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				todo: { kind: "api" },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site"]);
	});

	it("skips a resource whose entrypoint does not resolve to a function", async () => {
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				broken: { kind: "api", handler: { notAFunction: true } },
				nullish: { kind: "api", handler: null },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site"]);
	});

	it("orders external first, then api, then the rest", () => {
		const entries = serve(
			definition({
				svc: { kind: "service", handler: ok },
				api: { kind: "api", handler: ok },
				site: { kind: "web", handler: ok },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site", "api", "svc"]);
		expect(entries[0]?.external).toBe(true);
	});

	it("promotes an explicitly-external api ahead of the default web", () => {
		const entries = serve(
			definition({
				api: {
					kind: "api",
					handler: ok,
					annotations: [{ option: "endpoint", config: { external: true } }],
				},
				site: {
					kind: "web",
					handler: ok,
					annotations: [{ option: "endpoint", config: { external: false } }],
				},
			}),
		);
		expect(entries[0]?.name).toBe("api");
		expect(entries[0]?.external).toBe(true);
	});

	it("returns the session replay plan and store alongside the entrypoints", () => {
		const result = listServableEntrypointsWithReplay(
			definition({ site: { kind: "web", handler: ok } }),
			{ env: {}, stationId: "station:test" },
		);
		expect(result.entrypoints).toHaveLength(1);
		expect(result.sessionReplay).toBeDefined();
		expect(result.sessionReplayStore).toBeDefined();
	});
});
