/**
 * The container component builder.
 *
 * This is authoring surface: every method returns the handle so a caller can
 * chain, and the result is the record a deploy is planned from. The risk in a
 * builder like this is not that a method throws — it is that a method quietly
 * replaces something the caller already set. Volumes, args, bind mounts and
 * waits all accumulate, and each is written as "read the existing list, push,
 * write it back" precisely so a second call adds rather than overwrites. A
 * builder that clobbered would produce a container missing a volume nobody
 * noticed was dropped.
 *
 * The other property worth naming: **`withDnsRecord` refuses.** DNS is
 * Yard-level and outside the bind-reference contract, and a builder that
 * silently accepted a DNS record would record an intent nothing downstream
 * honours — a hostname the author believes exists and nothing ever creates.
 */
import { describe, expect, it } from "vitest";

import { addContainer } from "../src/wiring/add-container.js";
import { BindReferenceError } from "../src/wiring/bind-reference.js";

function container() {
	return addContainer("api", "ghcr.io/example/api:1");
}

describe("the handle a container starts as", () => {
	it("carries the image onto the manifest resource, not onto the handle", () => {
		// Pinned because it is the shape a reader would guess wrong: `image` and
		// `build` are constructor inputs that land on `manifest()`'s resource,
		// not fields on the handle itself. Reaching for `handle.image` gets
		// `undefined` rather than an error, so this is exactly the kind of thing
		// that surfaces as a blank field in a plan.
		// SAFETY: the handle contract intentionally keeps image off the public handle.
		expect("image" in container()).toBe(false);
		const resource = container().manifest();
		expect(resource.image).toBe("ghcr.io/example/api:1");
	});

	it("declares a build spec defaulting to wasm-on-oci", () => {
		// The default artifact is what makes `addContainer` usable with nothing
		// but a source. Omitting it would push the choice onto every caller, and
		// they would each pick differently.
		const resource = container().manifest();
		// SAFETY: the manifest builder owns this JSON build object shape.
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
		// `{ ...(options.env ?? {}) }`. Holding it would let a later mutation by
		// the caller change what an already-built handle reports.
		const env = { A: "1" };
		const handle = addContainer("api", "img", { env });
		env.A = "2";
		expect(handle.env.A).toBe("1");
	});

	it("refuses a bind target that is not a declared resource handle", () => {
		// A bind alias pointing at a plain object would produce a link to a
		// resource that does not exist, and the plan would fail at wiring time
		// rather than here where the author wrote it.
		for (const target of [{ name: "db" }, undefined, null, "db", 7]) {
			expect(() =>
				// SAFETY: invalid values are deliberately injected to test the boundary.
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
		// Every builder method returns the handle. One that returned void would
		// break a chain at the point it was inserted, and the failure would be a
		// type error far from the method that caused it.
		const handle = container();
		expect(handle.withEndpoint?.({ scheme: "http", port: 8080 })).toBe(handle);
	});

	it("defaults the endpoint name to http", () => {
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		expect(handle.endpoints.http).toBeDefined();
	});

	it("honours an explicit endpoint name", () => {
		// So a container can expose two endpoints without the second replacing
		// the first — which is exactly what would happen if the name were fixed.
		const handle = container();
		handle.withEndpoint?.({ name: "metrics", scheme: "http", port: 9090 });
		handle.withEndpoint?.({ name: "api", scheme: "http", port: 8080 });
		expect(Object.keys(handle.endpoints).sort()).toEqual(["api", "metrics"]);
	});

	it("defaults targetPort to the published port", () => {
		// The common case is that they are the same, and requiring both would
		// make the simple call verbose. Defaulting to zero or undefined would
		// produce a service routing to nothing.
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
		// The safe default: an endpoint is internal unless somebody said
		// otherwise. Defaulting to true would publish services to the internet
		// because their author forgot a flag.
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
		// Deliberate, and the opposite of the accumulating methods: an endpoint
		// is keyed by name, so redeclaring it is a correction rather than a
		// second endpoint. Two endpoints on one name could not both be routed.
		const handle = container();
		handle.withEndpoint?.({ scheme: "http", port: 8080 });
		handle.withEndpoint?.({ scheme: "http", port: 9090 });
		expect(handle.endpoints.http?.port).toBe(9090);
		expect(Object.keys(handle.endpoints)).toEqual(["http"]);
	});
});

describe("withHttpEndpoint", () => {
	it("declares an http endpoint from just a port", () => {
		// The convenience path, and the one most callers use. It has to produce
		// exactly what the long form would.
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
		// The conditional spreads exist so the long form's own defaults apply. If
		// `external: undefined` were forwarded, `?? false` would still catch it —
		// but `targetPort: undefined` forwarded past `?? port` would not, and the
		// endpoint would route to nothing.
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
		// A caller who passed `env` and then called `withEnvironment` means both.
		// Clobbering would drop configuration silently.
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
		// The property this whole file exists to pin. A container routinely
		// mounts several volumes, and a builder that kept only the last would
		// produce one that starts and cannot find its data.
		const handle = container();
		handle.withVolume?.("data", "/data");
		handle.withVolume?.("cache", "/cache");
		expect(handle.annotations.volumes).toHaveLength(2);
	});
});

describe("withBindMount", () => {
	it("records a mount defaulting to writable", () => {
		// `readOnly = false`. Defaulting to read-only would break the common
		// development case silently — the container starts and cannot write.
		const handle = container();
		expect(handle.withBindMount?.("./src", "/app/src")).toBe(handle);
		expect(handle.annotations.bindMounts).toEqual([
			{ source: "./src", target: "/app/src", readOnly: false },
		]);
	});

	it("honours an explicit read-only mount", () => {
		const handle = container();
		handle.withBindMount?.("./config", "/etc/app", true);
		// SAFETY: bind-mount annotations expose the tested readOnly field shape.
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
		// Order is meaningful to a command line. A set or a sort would produce a
		// container invoked with its flags rearranged.
		const handle = container();
		expect(handle.withArgs?.("--verbose", "--port", "8080")).toBe(handle);
		expect(handle.annotations.args).toEqual(["--verbose", "--port", "8080"]);
	});

	it("flattens a nested array argument", () => {
		// `args.flat()`. Callers build argument lists programmatically and pass
		// arrays; without the flatten a nested array would reach the command line
		// as a comma-joined string.
		const handle = container();
		// SAFETY: the invalid nested array is deliberately injected to test flattening.
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
		// Unlike volumes and args: a container has one health check, so a second
		// call is a correction. Accumulating would leave an orphaned first entry
		// that nothing reads.
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
		// The two values mean different things to a reclaimer — one is cleaned up
		// with the session, one is not. An unrecognised third value would be
		// recorded and then interpreted by whatever read it, most likely as
		// "not persistent", and the data would be gone.
		const handle = container();
		for (const lifetime of ["ephemeral", "forever", "", "SESSION"]) {
			// SAFETY: invalid values are deliberately injected to test rejection.
			expect(() => handle.withLifetime?.(lifetime as never)).toThrow(
				BindReferenceError,
			);
		}
		try {
			// SAFETY: invalid values are deliberately injected to test rejection.
			handle.withLifetime?.("ephemeral" as never);
			expect.unreachable("an unknown lifetime must be refused");
		} catch (error) {
			// SAFETY: this catch follows the BindReferenceError assertion above.
			expect((error as BindReferenceError).message).toContain(
				"session, persistent",
			);
		}
	});

	it("does not record a lifetime it refused", () => {
		// A refusal that had already written the value would leave the handle
		// carrying exactly the thing the check rejected.
		const handle = container();
		// SAFETY: invalid values are deliberately injected to test rejection.
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
		// A service becomes ready and keeps running; a job completes and stops.
		// Collapsing them would make a container wait forever for a service to
		// exit, or start before a migration finished.
		const handle = container();
		handle.waitFor?.("db");
		handle.waitForCompletion?.("migrate");
		expect(handle.annotations.waitFor).toEqual([{ to: "db", until: "ready" }]);
		expect(handle.annotations.waitForCompletion).toEqual([
			{ to: "migrate", until: "completed" },
		]);
	});

	it("accepts a handle as well as a name", () => {
		// Callers hold handles, not strings. Requiring the name would make every
		// dependency edge a place to typo a resource id.
		const handle = container();
		// SAFETY: a component handle is deliberately passed through the boundary.
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
		// A wait recorded against nothing is an edge the planner cannot resolve,
		// and it would surface as a container that never starts rather than as a
		// bad reference.
		const handle = container();
		for (const dependency of [undefined, null, 7, {}, { name: 7 }, []]) {
			// SAFETY: invalid values are deliberately injected to test rejection.
			expect(() => handle.waitFor?.(dependency as never)).toThrow(
				BindReferenceError,
			);
		}
	});

	it("refuses a name that is not a resource identifier", () => {
		// The identifier shape is what a planner joins on. A name with a slash or
		// a leading digit could not be addressed by whatever consumes the plan.
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
		// So a reader of a failed plan knows which container's `waitFor` was
		// wrong, not merely that one was.
		const handle = container();
		try {
			handle.waitForCompletion?.("bad name");
			expect.unreachable("a malformed dependency must be refused");
		} catch (error) {
			// SAFETY: this catch follows the BindReferenceError assertion above.
			expect((error as BindReferenceError).message).toMatch(
				/resources\.api\.waitForCompletion|waitForCompletion/u,
			);
		}
	});
});

describe("withDnsRecord", () => {
	it("refuses, because DNS is Yard-level", () => {
		// The deliberate refusal. A builder that accepted a DNS record would
		// record an intent nothing downstream honours — a hostname the author
		// believes exists and nothing ever creates.
		const handle = container();
		// SAFETY: invalid values are deliberately injected to test rejection.
		expect(() => handle.withDnsRecord?.({} as never)).toThrow(
			BindReferenceError,
		);
	});

	it("says where DNS does belong", () => {
		const handle = container();
		try {
			// SAFETY: invalid values are deliberately injected to test rejection.
			handle.withDnsRecord?.({} as never);
			expect.unreachable("DNS must be refused here");
		} catch (error) {
			// SAFETY: this catch follows the Error assertion above.
			expect((error as Error).message).toContain("Yard-level");
		}
	});
});

describe("chaining", () => {
	it("composes a whole container in one expression", () => {
		// The authoring shape this API exists for. Every method returning the
		// handle is what makes it possible, and a single method that did not
		// would break the chain wherever it was inserted.
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
		// Each `addContainer` builds its own handle. A shared annotations object
		// would let one container's volumes appear on another — and the manifest
		// would look plausible.
		const a = addContainer("a", "img");
		const b = addContainer("b", "img");
		a.withVolume?.("data", "/data");
		expect(b.annotations.volumes).toBeUndefined();
	});
});
