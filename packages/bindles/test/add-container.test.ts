import { describe, expect, it } from "vitest";

import { addContainer } from "../src/wiring/add-container.js";
import { BindReferenceError } from "../src/wiring/bind-reference.js";

function container() {
	return addContainer("api", "ghcr.io/example/api:1");
}

describe("the handle a container starts as", () => {
	it("carries the image onto the manifest resource, not onto the handle", () => {
		expect("image" in container()).toBe(false);
		const resource = container().manifest();
		expect(resource.image).toBe("ghcr.io/example/api:1");
	});

	it("declares a build spec defaulting to wasm-on-oci", () => {
		const resource = container().manifest();
		expect(resource.build).toMatchObject({
			provider: "hobo:build",
			source: "ghcr.io/example/api:1",
			defaultArtifact: "wasm-on-oci",
		});
	});

	it("starts with no bindings and an empty environment", () => {
		const handle = container();
		expect(handle.bindings).toEqual({});
		expect(handle.env).toEqual({});
	});

	it("carries environment supplied at construction", () => {
		expect(
			addContainer("api", "img", { env: { LOG_LEVEL: "debug" } }).env,
		).toEqual({ LOG_LEVEL: "debug" });
	});

	it("copies the environment rather than holding the caller's object", () => {
		const env = { A: "1" };
		const handle = addContainer("api", "img", { env });
		env.A = "2";
		expect(handle.env.A).toBe("1");
	});

	it("refuses a bind target that is not a declared resource handle", () => {
		for (const target of [{ name: "db" }, undefined, null, "db", 7]) {
			expect(() =>
				addContainer("api", "img", { bind: { db: target } as never }),
			).toThrow(BindReferenceError);
		}
	});

	it("names itself", () => {
		expect(container().name).toBe("api");
	});
});

describe("withEndpoint", () => {
	it("returns the handle, so calls chain", () => {
		const handle = container();
		expect(handle.withEndpoint?.({ scheme: "http", port: 8080 })).toBe(handle);
	});

	it("defaults the endpoint name to http", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		expect(handle.endpoints.http).toBeDefined();
	});

	it("honours an explicit endpoint name", () => {
		const handle = container();
		handle.withEndpoint?.({ name: "metrics", scheme: "http", port: 9090 });
		handle.withEndpoint?.({ name: "api", scheme: "http", port: 8080 });
		expect(Object.keys(handle.endpoints).sort()).toEqual(["api", "metrics"]);
	});

	it("defaults targetPort to the published port", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		expect(handle.endpoints.http?.targetPort).toBe(8080);
	});

	it("honours a targetPort that differs from the published port", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 80, targetPort: 8080 });
		expect(handle.endpoints.http?.targetPort).toBe(8080);
	});

	it("defaults external to false", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		expect(handle.endpoints.http?.external).toBe(false);
	});

	it("honours an explicit external flag in both directions", () => {
		const handle = container();
		handle.withEndpoint?.({
			name: "a",
			scheme: "http",
			port: 1,
			external: true,
		});
		handle.withEndpoint?.({
			name: "b",
			scheme: "http",
			port: 2,
			external: false,
		});
		expect(handle.endpoints.a?.external).toBe(true);
		expect(handle.endpoints.b?.external).toBe(false);
	});

	it("defaults the protocol to tcp", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		expect(handle.endpoints.http?.protocol).toBe("tcp");
	});

	it("honours an explicit protocol", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "dns", port: 53, protocol: "udp" });
		expect(handle.endpoints.http?.protocol).toBe("udp");
	});

	it("replaces an endpoint declared twice under one name", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		handle.withEndpoint?.({ scheme: "http", port: 9090 });
		expect(handle.endpoints.http?.port).toBe(9090);
		expect(Object.keys(handle.endpoints)).toEqual(["http"]);
	});
});

describe("withHttpEndpoint", () => {
	it("declares an http endpoint from just a port", () => {
		const handle = container();
		handle.withHttpEndpoint?.(8080);
		expect(handle.endpoints.http).toEqual({
			scheme: "http",
			port: 8080,
			targetPort: 8080,
			external: false,
			protocol: "tcp",
		});
	});

	it("honours a name, targetPort, external flag, and protocol", () => {
		const handle = container();
		handle.withHttpEndpoint?.(80, {
			name: "public",
			targetPort: 8080,
			external: true,
			protocol: "tcp",
		});
		expect(handle.endpoints.public).toEqual({
			scheme: "http",
			port: 80,
			targetPort: 8080,
			external: true,
			protocol: "tcp",
		});
	});

	it("omits an unstated option rather than passing undefined through", () => {
		const handle = container();
		handle.withHttpEndpoint?.(8080, {});
		expect(handle.endpoints.http?.targetPort).toBe(8080);
		expect(handle.endpoints.http?.external).toBe(false);
	});

	it("returns the handle", () => {
		const handle = container();
		expect(handle.withHttpEndpoint?.(8080)).toBe(handle);
	});
});

describe("withEnvironment", () => {
	it("sets a variable and returns the handle", () => {
		const handle = container();
		expect(handle.withEnvironment?.("LOG_LEVEL", "debug")).toBe(handle);
		expect(handle.env.LOG_LEVEL).toBe("debug");
	});

	it("accumulates across calls", () => {
		const handle = container();
		handle.withEnvironment?.("A", "1");
		handle.withEnvironment?.("B", "2");
		expect(handle.env).toMatchObject({ A: "1", B: "2" });
	});

	it("overwrites a variable set twice, because a variable has one value", () => {
		const handle = container();
		handle.withEnvironment?.("A", "1");
		handle.withEnvironment?.("A", "2");
		expect(handle.env.A).toBe("2");
	});

	it("adds to environment supplied at construction rather than replacing it", () => {
		const handle = addContainer("api", "img", { env: { A: "1" } });
		handle.withEnvironment?.("B", "2");
		expect(handle.env).toMatchObject({ A: "1", B: "2" });
	});
});

describe("withVolume", () => {
	it("records a volume and its target", () => {
		const handle = container();
		expect(handle.withVolume?.("data", "/var/lib/data")).toBe(handle);
		expect(handle.annotations.volumes).toEqual([
			{ name: "data", target: "/var/lib/data" },
		]);
	});

	it("accumulates rather than replacing", () => {
		const handle = container();
		handle.withVolume?.("data", "/data");
		handle.withVolume?.("cache", "/cache");
		expect(handle.annotations.volumes).toHaveLength(2);
	});
});

describe("withBindMount", () => {
	it("records a mount defaulting to writable", () => {
		const handle = container();
		expect(handle.withBindMount?.("./src", "/app/src")).toBe(handle);
		expect(handle.annotations.bindMounts).toEqual([
			{ source: "./src", target: "/app/src", readOnly: false },
		]);
	});

	it("honours an explicit read-only mount", () => {
		const handle = container();
		handle.withBindMount?.("./config", "/etc/app", true);
		expect(
			(handle.annotations.bindMounts as { readOnly: boolean }[])[0]?.readOnly,
		).toBe(true);
	});

	it("accumulates rather than replacing", () => {
		const handle = container();
		handle.withBindMount?.("./a", "/a");
		handle.withBindMount?.("./b", "/b");
		expect(handle.annotations.bindMounts).toHaveLength(2);
	});
});

describe("withArgs", () => {
	it("records arguments in order", () => {
		const handle = container();
		expect(handle.withArgs?.("--verbose", "--port", "8080")).toBe(handle);
		expect(handle.annotations.args).toEqual(["--verbose", "--port", "8080"]);
	});

	it("flattens a nested array argument", () => {
		const handle = container();
		handle.withArgs?.(["--a", "--b"] as never, "--c");
		expect(handle.annotations.args).toEqual(["--a", "--b", "--c"]);
	});

	it("appends across calls rather than replacing", () => {
		const handle = container();
		handle.withArgs?.("--a");
		handle.withArgs?.("--b");
		expect(handle.annotations.args).toEqual(["--a", "--b"]);
	});

	it("accepts a call with no arguments at all", () => {
		const handle = container();
		handle.withArgs?.();
		expect(handle.annotations.args).toEqual([]);
	});
});

describe("withHttpHealthCheck", () => {
	it("records the path and returns the handle", () => {
		const handle = container();
		expect(handle.withHttpHealthCheck?.("/healthz")).toBe(handle);
		expect(handle.annotations.health).toEqual({
			type: "http",
			path: "/healthz",
		});
	});

	it("replaces a previously declared check, because there is one", () => {
		const handle = container();
		handle.withHttpHealthCheck?.("/a");
		handle.withHttpHealthCheck?.("/b");
		expect(handle.annotations.health).toEqual({ type: "http", path: "/b" });
	});
});

describe("withLifetime", () => {
	it("accepts session and persistent", () => {
		for (const lifetime of ["session", "persistent"] as const) {
			const handle = container();
			expect(handle.withLifetime?.(lifetime)).toBe(handle);
			expect(handle.annotations.lifetime).toBe(lifetime);
		}
	});

	it("refuses any other lifetime, naming the resource", () => {
		const handle = container();
		for (const lifetime of ["ephemeral", "forever", "", "SESSION"]) {
			expect(() => handle.withLifetime?.(lifetime as never)).toThrow(
				BindReferenceError,
			);
		}
		try {
			handle.withLifetime?.("ephemeral" as never);
			expect.unreachable("an unknown lifetime must be refused");
		} catch (error) {
			expect((error as BindReferenceError).message).toContain(
				"session, persistent",
			);
		}
	});

	it("does not record a lifetime it refused", () => {
		const handle = container();
		expect(() => handle.withLifetime?.("ephemeral" as never)).toThrow();
		expect(handle.annotations.lifetime).toBeUndefined();
	});
});

describe("waitFor and waitForCompletion", () => {
	it("records a wait on a named dependency", () => {
		const handle = container();
		expect(handle.waitFor?.("db")).toBe(handle);
		expect(handle.annotations.waitFor).toEqual([{ to: "db", until: "ready" }]);
	});

	it("distinguishes waiting for ready from waiting for completion", () => {
		const handle = container();
		handle.waitFor?.("db");
		handle.waitForCompletion?.("migrate");
		expect(handle.annotations.waitFor).toEqual([{ to: "db", until: "ready" }]);
		expect(handle.annotations.waitForCompletion).toEqual([
			{ to: "migrate", until: "completed" },
		]);
	});

	it("accepts a handle as well as a name", () => {
		const handle = container();
		handle.waitFor?.(addContainer("db", "postgres:16") as never);
		expect(handle.annotations.waitFor).toEqual([{ to: "db", until: "ready" }]);
	});

	it("accumulates several waits", () => {
		const handle = container();
		handle.waitFor?.("db");
		handle.waitFor?.("cache");
		expect(handle.annotations.waitFor).toHaveLength(2);
	});

	it("refuses a dependency that is neither a name nor a handle", () => {
		const handle = container();
		for (const dependency of [undefined, null, 7, {}, { name: 7 }, []]) {
			expect(() => handle.waitFor?.(dependency as never)).toThrow(
				BindReferenceError,
			);
		}
	});

	it("refuses a name that is not a resource identifier", () => {
		const handle = container();
		for (const dependency of ["", "9db", "my db", "db/1", "-db", "db.x"]) {
			expect(() => handle.waitFor?.(dependency)).toThrow(BindReferenceError);
		}
	});

	it("accepts the identifier shapes a resource can actually have", () => {
		const handle = container();
		for (const dependency of ["db", "Db", "db_1", "db-1", "a"]) {
			expect(() => handle.waitFor?.(dependency)).not.toThrow();
		}
	});

	it("names the owning resource and the method in the refusal", () => {
		const handle = container();
		try {
			handle.waitForCompletion?.("bad name");
			expect.unreachable("a malformed dependency must be refused");
		} catch (error) {
			expect((error as BindReferenceError).message).toMatch(
				/resources\.api\.waitForCompletion|waitForCompletion/u,
			);
		}
	});
});

describe("withDnsRecord", () => {
	it("refuses, because DNS is Yard-level", () => {
		const handle = container();
		expect(() => handle.withDnsRecord?.({} as never)).toThrow(
			BindReferenceError,
		);
	});

	it("says where DNS does belong", () => {
		const handle = container();
		try {
			handle.withDnsRecord?.({} as never);
			expect.unreachable("DNS must be refused here");
		} catch (error) {
			expect((error as Error).message).toContain("Yard-level");
		}
	});
});

describe("chaining", () => {
	it("composes a whole container in one expression", () => {
		const handle = addContainer("api", "ghcr.io/example/api:1")
			.withHttpEndpoint?.(8080, { external: true })
			?.withEnvironment?.("LOG_LEVEL", "debug")
			?.withVolume?.("data", "/data")
			?.withHttpHealthCheck?.("/healthz")
			?.withLifetime?.("persistent")
			?.waitFor?.("db");

		expect(handle?.endpoints.http?.external).toBe(true);
		expect(handle?.env.LOG_LEVEL).toBe("debug");
		expect(handle?.annotations.volumes).toHaveLength(1);
		expect(handle?.annotations.health).toMatchObject({ path: "/healthz" });
		expect(handle?.annotations.lifetime).toBe("persistent");
		expect(handle?.annotations.waitFor).toHaveLength(1);
	});

	it("keeps two containers' annotations separate", () => {
		const a = addContainer("a", "img");
		const b = addContainer("b", "img");
		a.withVolume?.("data", "/data");
		expect(b.annotations.volumes).toBeUndefined();
	});
});
