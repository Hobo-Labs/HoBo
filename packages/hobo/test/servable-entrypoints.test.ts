/**
 * Which Bindle resources are servable and which are public.
 *
 * `listServableEntrypoints` decides two things that are hard to undo. **What
 * gets served**: only HTTP App Kits with a resolvable fetch handler, because a
 * resource that is not one would be bound to a port and answer nothing.
 * **What is reachable from outside**: `web` is public by default and
 * `api`/`service` stay on the private mesh — an api accidentally marked
 * external is an unauthenticated endpoint on the internet, so the default is
 * closed and only an explicit `endpoint` annotation opens it.
 *
 * The ordering is not cosmetic: external first, then api, then the rest. The
 * first entrypoint is the one a caller binds to the primary URL, and putting a
 * private service there would make the deployment's front door unreachable.
 */
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

/** One resource of a test Bindle: its kind, what its entrypoint returns, its annotations. */
type ResourceSpec = {
	readonly kind: ResourceKind;
	readonly handler?: ReturnType<Entrypoint>;
	readonly annotations?: readonly Omit<ProviderAnnotation, "provider">[];
};

/** A Bindle whose resources map to the given kinds and handlers. */
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

/** The entrypoints for a definition, with no environment. */
function serve(
	def: BindleDefinition,
): ReturnType<typeof listServableEntrypoints> {
	return listServableEntrypoints(def, { env: {} });
}

describe("isExternalComponent", () => {
	it("makes only web public when nothing says otherwise", () => {
		// An api reachable from the internet without being asked for is an
		// unauthenticated endpoint. The default has to be the closed one.
		expect(isExternalComponent("web", [])).toBe(true);
		for (const kind of ["api", "service", "ui", "kv"]) {
			expect(isExternalComponent(kind, [])).toBe(false);
		}
	});

	it("lets an endpoint annotation open or close any kind", () => {
		// Exposure is a deliberate act in both directions: an internal-only web
		// surface is as legitimate as a public api, and both are stated the same
		// way.
		const open = [{ option: "endpoint", config: { external: true } }];
		const closed = [{ option: "endpoint", config: { external: false } }];
		expect(isExternalComponent("api", open)).toBe(true);
		expect(isExternalComponent("web", closed)).toBe(false);
	});

	it("ignores annotations that are not endpoint, or whose value is not boolean", () => {
		// `external: "true"` from a hand-written manifest is not a decision to
		// expose. Coercing it would turn a typo into an open port.
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
		// A kv or queue resource has no fetch handler. Binding one to a port
		// would produce a listener that answers nothing.
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
		// A declared-but-unimplemented resource is a normal state mid-build.
		// Failing here would make an incomplete Bindle unservable rather than
		// partially servable.
		const entries = serve(
			definition({
				site: { kind: "web", handler: ok },
				todo: { kind: "api" },
			}),
		);
		expect(entries.map((entry) => entry.name)).toEqual(["site"]);
	});

	it("skips a resource whose entrypoint does not resolve to a function", async () => {
		// An entrypoint returning a config object rather than a handler is a
		// programming mistake; serving it would call the object as a function on
		// the first request instead of at startup.
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
		// The first entrypoint becomes the primary URL. A private service there
		// would make the deployment's front door unreachable.
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
		// Rank is by exposure first, so an api the author deliberately opened
		// competes for the primary URL on equal terms.
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
		// The plan says which surfaces are being captured. A caller that got
		// only the handlers would have no way to report capture state.
		const result = listServableEntrypointsWithReplay(
			definition({ site: { kind: "web", handler: ok } }),
			{ env: {}, stationId: "station:test" },
		);
		expect(result.entrypoints).toHaveLength(1);
		expect(result.sessionReplay).toBeDefined();
		expect(result.sessionReplayStore).toBeDefined();
	});
});
