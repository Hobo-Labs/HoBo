/**
 * The internal mesh: how a private component is reachable without a listener.
 *
 * Components that are not `external` get no TCP port at all. Instead the host
 * installs a process-wide `fetch` interceptor that routes
 * `http://<bindle>.hobo.internal/<name>/...` straight to the component's
 * handler. That gives one addressing scheme for public and private components
 * alike, without ever opening a socket for something that should not be
 * reachable from outside.
 *
 * Two properties carry the weight.
 *
 * **Camp config reaches a guest over the mesh, not through the process.** A
 * private hop carries the bindle's env as `x-hobo-env-*` headers, because an
 * isolated-wasm sandbox cannot see the host's `process.env` — and baking config
 * into a `.wasm` artifact would make the artifact environment-specific, which is
 * the whole thing the Camp model avoids.
 *
 * **The interceptor must be exactly as narrow as its hostname.** It replaces the
 * global `fetch` for the entire process, so anything it fails to delegate is a
 * request that silently never leaves the machine. Every non-mesh URL — including
 * a string that is not a URL at all, and a mesh hostname belonging to a
 * *different* bindle — has to fall through to the previous fetch untouched.
 */
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
	// Nested process-wide overrides must unwind in reverse installation order.
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

/** Installs the mesh and guarantees the global fetch is restored. */
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

/** A handler that echoes back what it received. */
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
		// Per bindle, so two bindles served from one process cannot address each
		// other's components by accident.
		expect(internalMeshHost("shop")).toBe(`shop.${INTERNAL_MESH_HOST}`);
	});

	it("sanitizes a bindle name into a DNS label", () => {
		// Bindle names are authored freely; hostnames are not. An unsanitized
		// name would produce a URL that `new URL` rejects, and the mesh would
		// fall through to the real fetch — silently sending an internal request
		// to the internet.
		const host = internalMeshHost("My Shop/v2");
		expect(host.endsWith(`.${INTERNAL_MESH_HOST}`)).toBe(true);
		expect(host.split(".")[0]).toMatch(/^[a-z0-9-]+$/u);
	});

	it("falls back to the bare mesh host when a name sanitizes to nothing", () => {
		// A name of only separators would otherwise produce `.hobo.internal`,
		// which is not a valid hostname at all.
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
		// A URL parser may preserve the case a caller wrote. Comparing case
		// sensitively would let `HOBO.INTERNAL` escape to the real network.
		expect(isInternalMeshHostname("SHOP.HOBO.INTERNAL")).toBe(true);
	});

	it("does not treat a lookalike host as internal", () => {
		// `hobo.internal.evil.example` is somebody else's domain, and a substring
		// or prefix test would route a request meant for them into the mesh —
		// or, read the other way, would let their host masquerade as internal.
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
		// This key is what a guest reads its peer's address from. The shape is a
		// contract with every language binding, so it is pinned literally.
		expect(serviceDiscoveryKey("api")).toBe("services__api__http__0");
	});

	it("defaults the endpoint name and index", () => {
		expect(serviceDiscoveryKey("api")).toBe(
			serviceDiscoveryKey("api", "http", 0),
		);
	});

	it("distinguishes several endpoints and several instances", () => {
		// Without both segments a component with two endpoints, or two replicas,
		// would publish one key and the second would overwrite the first.
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
		// Header names are case-insensitive on the wire but not in every guest's
		// parser. Lowercasing here means a guest can look up a fixed string.
		const headers = applyHoboMeshEnvHeaders(new Headers(), {
			LOG_LEVEL: "debug",
		});
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}log_level`)).toBe("debug");
	});

	it("also carries the whole map as one JSON header", () => {
		// Two representations on purpose: a guest that wants one parse reads the
		// JSON, one that wants a single value reads its own header without
		// parsing anything.
		const headers = applyHoboMeshEnvHeaders(new Headers(), { A: "1", B: "2" });
		expect(JSON.parse(headers.get(HOBO_BINDLE_ENV_HEADER) ?? "{}")).toEqual({
			A: "1",
			B: "2",
		});
	});

	it("keeps the two representations in agreement", () => {
		// A guest reading one and a guest reading the other must not see
		// different config. The JSON keeps the original casing; the per-key
		// headers are lowercased, and that asymmetry is deliberate.
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
		// The mesh hop carries the original request's headers. Dropping them
		// would strip content types and trace context from every private call.
		const headers = applyHoboMeshEnvHeaders(
			new Headers({ "content-type": "application/json" }),
			{ A: "1" },
		);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("returns a new Headers rather than mutating the caller's", () => {
		// The original may be reused for a retry. Mutating it would accumulate
		// env headers on every attempt.
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
		// Environment values are strings on every platform. Leaving a number
		// here would produce a header value of `[object Object]` or a guest that
		// received a type it cannot represent.
		expect(
			collectBindleEnvInjections(
				definition([{ option: "env", config: { PORT: 8080, DEBUG: true } }]),
			),
		).toEqual({ PORT: "8080", DEBUG: "true" });
	});

	it("skips values that are not scalars", () => {
		// An object or array cannot become an environment value without a
		// serialization choice this layer has no business making.
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
		// A resource carries annotations for many options. Reading them all would
		// inject a provider's configuration into the guest's environment.
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
		// The component sees the path *it* serves, not the mesh's addressing
		// scheme. Forwarding `/api/orders` would make every guest strip its own
		// name, and one of them would forget.
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
		// Named in the body, because a private component that failed to start is
		// otherwise indistinguishable from one that was never declared.
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
		// The property the mesh exists to provide. An isolated-wasm sandbox
		// cannot read the host's process.env, and baking config into the .wasm
		// would make the artifact environment-specific.
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
		// The empty-map guard. An `x-hobo-bindle-env: {}` on every hop would be
		// noise a guest has to parse to learn nothing.
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
		// A GET carrying a body is rejected outright by the Request constructor,
		// so forwarding one unconditionally would break every private read.
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
		// Callers pass all three forms. Reading only `input.url` or only the
		// string would send the other two to the real network.
		const api = echo();
		mesh({ api: api.handler });
		await fetch(new Request(`http://shop.${INTERNAL_MESH_HOST}/api`));
		await fetch(new URL(`http://shop.${INTERNAL_MESH_HOST}/api`));
		expect(api.seen).toHaveLength(2);
	});

	it("delegates a non-mesh URL to the previous fetch", async () => {
		// The interceptor is process-wide, so anything it fails to delegate never
		// leaves the machine. This is the arm that keeps ordinary outbound
		// requests working while a host is serving.
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
		// The `catch` around `new URL`. A relative path or a garbage string must
		// fall through rather than throwing out of the interceptor, which would
		// break an unrelated caller with an error from code it never invoked.
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
		// Two bindles served from one process each install a mesh. Answering for
		// the other one's hostname would route a request to the wrong bindle's
		// component of the same name — which would look like it worked.
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
		// `hobo.internal` with no subdomain is the unscoped form, and a scoped
		// mesh has to keep serving it — otherwise a component addressing its peer
		// without naming the bindle would escape to the network.
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
		// The interceptor is global. A dispose that failed to restore would leave
		// every later request in the process routed through a dead mesh.
		const before = globalThis.fetch;
		const dispose = installInternalMesh(new Map());
		expect(globalThis.fetch).not.toBe(before);
		dispose();
		expect(globalThis.fetch).toBe(before);
	});

	it("nests, restoring one layer at a time", async () => {
		// Two hosts in one process install and dispose in stack order. A dispose
		// that restored the *original* rather than its own predecessor would tear
		// down the outer host's mesh with the inner one.
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
