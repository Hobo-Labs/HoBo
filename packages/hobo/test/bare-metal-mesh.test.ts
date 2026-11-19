import type { BindleDefinition, ProviderAnnotation } from "@hobo/bindles";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyHoboMeshEnvHeaders,
	collectBindleEnvInjections,
	HOBO_BINDLE_ENV_HEADER,
	HOBO_ENV_HEADER_PREFIX,
	INTERNAL_MESH_HOST,
	installInternalMesh,
	internalMeshBase,
	internalMeshHost,
	isInternalMeshHostname,
	serviceDiscoveryKey,
} from "../src/bare-metal-host.js";

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

function mesh(
	handlers: Record<string, (request: Request) => Promise<Response>>,
	options: Parameters<typeof installInternalMesh>[1] = {},
) {
	const dispose = installInternalMesh(
		new Map(Object.entries(handlers)),
		options,
	);
	disposers.push(dispose);
	return dispose;
}

function echo() {
	const seen: Array<{ url: string; method: string; headers: Headers }> = [];
	const handler = async (request: Request) => {
		seen.push({
			url: request.url,
			method: request.method,
			headers: new Headers(request.headers),
		});
		return new Response("ok", { status: 200 });
	};
	return { handler, seen };
}

describe("mesh hostnames", () => {
	it("derives a per-bindle subdomain", () => {
		expect(internalMeshHost("shop")).toBe(`shop.${INTERNAL_MESH_HOST}`);
	});

	it("sanitizes a bindle name into a DNS label", () => {
		const host = internalMeshHost("My Shop/v2");
		expect(host.endsWith(`.${INTERNAL_MESH_HOST}`)).toBe(true);
		expect(host.split(".")[0]).toMatch(/^[a-z0-9-]+$/u);
	});

	it("falls back to the bare mesh host when a name sanitizes to nothing", () => {
		for (const name of ["", "///", "---"]) {
			expect(internalMeshHost(name)).toBe(INTERNAL_MESH_HOST);
		}
	});

	it("recognises the bare mesh host and any subdomain of it", () => {
		expect(isInternalMeshHostname(INTERNAL_MESH_HOST)).toBe(true);
		expect(isInternalMeshHostname(`shop.${INTERNAL_MESH_HOST}`)).toBe(true);
		expect(isInternalMeshHostname(`a.b.${INTERNAL_MESH_HOST}`)).toBe(true);
	});

	it("is case-insensitive, because hostnames are", () => {
		expect(isInternalMeshHostname("SHOP.HOBO.INTERNAL")).toBe(true);
	});

	it("does not treat a lookalike host as internal", () => {
		for (const host of [
			"hobo.internal.evil.example",
			"nothobo.internal",
			"hobointernal",
			"example.com",
		]) {
			expect(isInternalMeshHostname(host)).toBe(false);
		}
	});

	it("builds a component base URL under the bindle's host", () => {
		expect(internalMeshBase("shop", "api")).toBe(
			`http://shop.${INTERNAL_MESH_HOST}/api`,
		);
	});

	it("sanitizes the resource name in a base URL too", () => {
		expect(internalMeshBase("shop", "My API")).toMatch(
			/^http:\/\/shop\.hobo\.internal\/[a-z0-9-]+$/u,
		);
	});
});

describe("serviceDiscoveryKey", () => {
	it("builds the conventional key from a resource name", () => {
		expect(serviceDiscoveryKey("api")).toBe("services__api__http__0");
	});

	it("defaults the endpoint name and index", () => {
		expect(serviceDiscoveryKey("api")).toBe(
			serviceDiscoveryKey("api", "http", 0),
		);
	});

	it("distinguishes several endpoints and several instances", () => {
		expect(serviceDiscoveryKey("api", "metrics")).toBe(
			"services__api__metrics__0",
		);
		expect(serviceDiscoveryKey("api", "http", 1)).toBe(
			"services__api__http__1",
		);
	});
});

describe("applyHoboMeshEnvHeaders", () => {
	it("adds one header per key, lowercased", () => {
		const headers = applyHoboMeshEnvHeaders(new Headers(), {
			LOG_LEVEL: "debug",
		});
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}log_level`)).toBe("debug");
	});

	it("also carries the whole map as one JSON header", () => {
		const headers = applyHoboMeshEnvHeaders(new Headers(), { A: "1", B: "2" });
		expect(JSON.parse(headers.get(HOBO_BINDLE_ENV_HEADER) ?? "{}")).toEqual({
			A: "1",
			B: "2",
		});
	});

	it("keeps the two representations in agreement", () => {
		const env = { LOG_LEVEL: "debug", REGION: "eu" };
		const headers = applyHoboMeshEnvHeaders(new Headers(), env);
		const parsed = JSON.parse(headers.get(HOBO_BINDLE_ENV_HEADER) ?? "{}");
		for (const [key, value] of Object.entries(parsed)) {
			expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}${key.toLowerCase()}`)).toBe(
				value,
			);
		}
	});

	it("preserves headers the caller already set", () => {
		const headers = applyHoboMeshEnvHeaders(
			new Headers({ "content-type": "application/json" }),
			{ A: "1" },
		);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("returns a new Headers rather than mutating the caller's", () => {
		const original = new Headers();
		const next = applyHoboMeshEnvHeaders(original, { A: "1" });
		expect(next).not.toBe(original);
		expect(original.get(`${HOBO_ENV_HEADER_PREFIX}a`)).toBeNull();
	});

	it("emits an empty JSON map for empty env", () => {
		expect(
			applyHoboMeshEnvHeaders(new Headers(), {}).get(HOBO_BINDLE_ENV_HEADER),
		).toBe("{}");
	});
});

describe("collectBindleEnvInjections", () => {
	function definition(
		annotations: Array<Pick<ProviderAnnotation, "option" | "config">>,
	) {
		return {
			name: "fixture",
			resources: {
				api: {
					kind: "api",
					name: "api",
					stableId: "api:api",
					declaredAllow: [],
					dependsOn: [],
					annotations: annotations.map((annotation) => ({
						provider: "fixture",
						...annotation,
					})),
				},
			},
			edges: [],
			requirements: { require: [], prefer: [], runtimes: [], labels: {} },
			entrypoint: () => undefined,
		} satisfies BindleDefinition;
	}

	it("collects string values from env annotations", () => {
		expect(
			collectBindleEnvInjections(
				definition([{ option: "env", config: { LOG_LEVEL: "debug" } }]),
			),
		).toEqual({ LOG_LEVEL: "debug" });
	});

	it("stringifies numbers and booleans", () => {
		expect(
			collectBindleEnvInjections(
				definition([{ option: "env", config: { PORT: 8080, DEBUG: true } }]),
			),
		).toEqual({ PORT: "8080", DEBUG: "true" });
	});

	it("skips values that are not scalars", () => {
		expect(
			collectBindleEnvInjections(
				definition([
					{
						option: "env",
						config: { OK: "1", NESTED: {}, LIST: [1], NIL: null },
					},
				]),
			),
		).toEqual({ OK: "1" });
	});

	it("ignores annotations that are not env", () => {
		expect(
			collectBindleEnvInjections(
				definition([
					{ option: "module", config: { path: "./api.wasm" } },
					{ option: "env", config: { A: "1" } },
				]),
			),
		).toEqual({ A: "1" });
	});

	it("merges across resources, with later resources winning", () => {
		const merged = collectBindleEnvInjections({
			...definition([]),
			resources: {
				a: definition([{ option: "env", config: { A: "1", SHARED: "a" } }])
					.resources.api,
				b: definition([{ option: "env", config: { B: "2", SHARED: "b" } }])
					.resources.api,
			},
		});
		expect(merged).toMatchObject({ A: "1", B: "2" });
		expect(merged.SHARED).toBe("b");
	});

	it("returns an empty map for a bindle with no env at all", () => {
		expect(
			collectBindleEnvInjections({ ...definition([]), resources: {} }),
		).toEqual({});
	});
});

describe("installInternalMesh", () => {
	it("routes a mesh URL to the named component's handler", async () => {
		const api = echo();
		mesh({ api: api.handler });
		const response = await fetch(
			`http://shop.${INTERNAL_MESH_HOST}/api/orders`,
		);
		expect(response.status).toBe(200);
		expect(api.seen).toHaveLength(1);
	});

	it("strips the component segment from the path it forwards", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api/orders/1`);
		expect(new URL(api.seen[0]?.url ?? "").pathname).toBe("/orders/1");
	});

	it("carries the query string through", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api/orders?limit=10`);
		expect(new URL(api.seen[0]?.url ?? "").search).toBe("?limit=10");
	});

	it("answers 404 for a component nobody registered", async () => {
		mesh({ api: echo().handler });
		const response = await fetch(`http://shop.${INTERNAL_MESH_HOST}/ghost`);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("unknown component ghost");
	});

	it("answers 404 for a mesh URL naming no component at all", async () => {
		mesh({ api: echo().handler });
		const response = await fetch(`http://shop.${INTERNAL_MESH_HOST}/`);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("missing component name");
	});

	it("injects bindle env onto the private hop", async () => {
		const api = echo();
		mesh({ api: api.handler }, { bindleEnv: { LOG_LEVEL: "debug" } });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api`);
		expect(api.seen[0]?.headers.get(`${HOBO_ENV_HEADER_PREFIX}log_level`)).toBe(
			"debug",
		);
		expect(api.seen[0]?.headers.get(HOBO_BINDLE_ENV_HEADER)).toBe(
			'{"LOG_LEVEL":"debug"}',
		);
	});

	it("adds no env headers when the bindle declares none", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api`);
		expect(api.seen[0]?.headers.get(HOBO_BINDLE_ENV_HEADER)).toBeNull();
	});

	it("preserves the caller's own headers alongside the injected ones", async () => {
		const api = echo();
		mesh({ api: api.handler }, { bindleEnv: { A: "1" } });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api`, {
			headers: { "x-trace-id": "t-1" },
		});
		expect(api.seen[0]?.headers.get("x-trace-id")).toBe("t-1");
		expect(api.seen[0]?.headers.get(`${HOBO_ENV_HEADER_PREFIX}a`)).toBe("1");
	});

	it("forwards the method", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api`, { method: "DELETE" });
		expect(api.seen[0]?.method).toBe("DELETE");
	});

	it("forwards a body on a mutation and omits it on a read", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://shop.${INTERNAL_MESH_HOST}/api`, {
			method: "POST",
			body: "hello",
		});
		expect(api.seen[0]?.method).toBe("POST");
		await expect(
			fetch(`http://shop.${INTERNAL_MESH_HOST}/api`),
		).resolves.toBeDefined();
	});

	it("accepts a Request object as well as a URL string", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(new Request(`http://shop.${INTERNAL_MESH_HOST}/api`));
		await fetch(new URL(`http://shop.${INTERNAL_MESH_HOST}/api`));
		expect(api.seen).toHaveLength(2);
	});

	it("delegates a non-mesh URL to the previous fetch", async () => {
		let delegated = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			delegated += 1;
			return new Response("external");
		};
		disposers.push(() => {
			globalThis.fetch = previous;
		});
		try {
			mesh({ api: echo().handler });
			await fetch("https://example.com/thing");
			expect(delegated).toBe(1);
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("delegates an input that is not a URL at all", async () => {
		let delegated = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			delegated += 1;
			return new Response("external");
		};
		disposers.push(() => {
			globalThis.fetch = previous;
		});
		try {
			mesh({ api: echo().handler });
			await fetch("not a url");
			expect(delegated).toBe(1);
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("delegates a mesh hostname belonging to a different bindle", async () => {
		let delegated = 0;
		const previous = globalThis.fetch;
		globalThis.fetch = async () => {
			delegated += 1;
			return new Response("other bindle");
		};
		disposers.push(() => {
			globalThis.fetch = previous;
		});
		try {
			mesh({ api: echo().handler }, { bindleName: "shop" });
			await fetch(`http://other.${INTERNAL_MESH_HOST}/api`);
			expect(delegated).toBe(1);
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("still answers on the bare mesh host when scoped to a bindle", async () => {
		const api = echo();
		mesh({ api: api.handler }, { bindleName: "shop" });
		await fetch(`http://${INTERNAL_MESH_HOST}/api`);
		expect(api.seen).toHaveLength(1);
	});

	it("answers for any mesh hostname when scoped to no bindle", async () => {
		const api = echo();
		mesh({ api: api.handler });
		await fetch(`http://anything.${INTERNAL_MESH_HOST}/api`);
		expect(api.seen).toHaveLength(1);
	});

	it("restores the previous fetch on dispose", async () => {
		const before = globalThis.fetch;
		const dispose = installInternalMesh(new Map());
		expect(globalThis.fetch).not.toBe(before);
		dispose();
		expect(globalThis.fetch).toBe(before);
	});

	it("nests, restoring one layer at a time", async () => {
		const outer = echo();
		const inner = echo();
		const disposeOuter = installInternalMesh(new Map([["api", outer.handler]]));
		const disposeInner = installInternalMesh(new Map([["api", inner.handler]]));
		await fetch(`http://a.${INTERNAL_MESH_HOST}/api`);
		expect(inner.seen).toHaveLength(1);
		disposeInner();
		await fetch(`http://a.${INTERNAL_MESH_HOST}/api`);
		expect(outer.seen).toHaveLength(1);
		disposeOuter();
	});
});
