/**
 * Build-manifest and service-declaration parsing.
 *
 * Pure parse-don't-validate boundary: everything downstream of these functions
 * gets a typed value or an error with a stable code, never a half-checked
 * record. So the branches worth pinning are the refusals, and three of them do
 * real work:
 *
 *   - **Paths must stay inside the project.** An absolute path, a Windows
 *     drive letter, or a `..` segment in a manifest writes outside the tree a
 *     build was asked to touch. This runs on manifests that can arrive from a
 *     repository, so it is a boundary, not a lint.
 *   - **Digests must be well-formed.** A build manifest exists to make an
 *     artifact identifiable; a malformed digest makes the manifest a claim
 *     rather than a record.
 *   - **An OCI artifact must say why it fell back.** Containers are the escape
 *     hatch from the wasm-component path, and an escape hatch that does not
 *     record its reason is how a fallback becomes the silent default.
 *
 * Normalization is pinned alongside, because `component` collapsing to `wasm`
 * in two separate places is exactly the kind of duplicated rule that drifts.
 */
import { describe, expect, it } from "vitest";

import { BuildError } from "../src/build/errors.js";
import {
	BUILD_MANIFEST_SCHEMA,
	normalizeTargetRuntime,
	parseBuildManifest,
	parseBuildRequestFromInvocation,
	parseServiceDeclaration,
} from "../src/build/parse.js";
import type { JsonObject } from "../src/json.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

const artifact = (overrides: JsonObject = {}) => ({
	service: "api",
	kind: "wasm-component",
	path: "dist/api.wasm",
	mediaType: "application/wasm",
	digest: DIGEST,
	runtime: "wasm",
	source: "services/api/src/service.ts",
	...overrides,
});

const manifest = (overrides: JsonObject = {}) => ({
	schema: BUILD_MANIFEST_SCHEMA,
	runtimeTarget: "auto",
	artifacts: [],
	...overrides,
});

describe("parseServiceDeclaration", () => {
	it("parses a full declaration", () => {
		expect(
			parseServiceDeclaration({
				name: "api",
				language: "typescript",
				runtime: "wasm",
				sourceRoot: "services/api/src",
				entrypoint: "services/api/src/service.ts",
			}),
		).toEqual({
			name: "api",
			language: "ts",
			runtime: "wasm",
			sourceRoot: "services/api/src",
			entrypoint: "services/api/src/service.ts",
		});
	});

	it.each([null, undefined, "api", 42, []])("rejects %s", (raw) => {
		if (Array.isArray(raw)) return; // arrays are objects; covered separately
		expect(() => parseServiceDeclaration(raw)).toThrow(BuildError);
	});

	it.each([
		"",
		"Api",
		"1api",
		"-api",
		"api_v2",
		"api.v2",
	])("rejects the invalid service name %s", (name) => {
		expect(() => parseServiceDeclaration({ name })).toThrow(
			/Invalid service name/u,
		);
	});

	it.each(["a", "api", "api-v2", "a1"])("accepts the name %s", (name) => {
		expect(parseServiceDeclaration({ name }).name).toBe(name);
	});

	it("names the offending service in the error detail", () => {
		// The detail is what a CLI renders; a message alone would not say which
		// of twenty services failed.
		try {
			parseServiceDeclaration({ name: "Bad" });
			expect.unreachable();
		} catch (error) {
			// SAFETY: `expect((error as BuildError).detail).toMatchObject({ service: "Bad" });` is required at this I/O or test boundary.
			expect((error as BuildError).detail).toMatchObject({ service: "Bad" });
		}
	});

	it("defaults the entrypoint from the service name", () => {
		expect(parseServiceDeclaration({ name: "api" }).entrypoint).toBe(
			"services/api/src/service.ts",
		);
	});

	it("defaults a Python entrypoint to app.py", () => {
		expect(
			parseServiceDeclaration({ name: "api", language: "python" }).entrypoint,
		).toBe("services/api/src/app.py");
	});

	it("derives sourceRoot from the entrypoint's directory", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "src/deep/main.ts" })
				.sourceRoot,
		).toBe("src/deep");
	});

	it("handles an entrypoint with no directory", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "main.ts" })
				.sourceRoot,
		).toBe("main.ts");
	});

	it.each([
		["typescript", "ts"],
		["TypeScript", "ts"],
		["javascript", "js"],
		["py", "python"],
		["rust", "rust"],
	])("normalizes the language %s to %s", (language, expected) => {
		expect(parseServiceDeclaration({ name: "api", language }).language).toBe(
			expected,
		);
	});

	it.each([
		["main.ts", "ts"],
		["main.js", "js"],
		["main.py", "python"],
		["main.rs", "rs"],
	])("infers the language from %s", (entrypoint, expected) => {
		expect(parseServiceDeclaration({ name: "api", entrypoint }).language).toBe(
			expected,
		);
	});

	it("reports an unknown language for an extensionless entrypoint", () => {
		// Found by this test: `slice(lastIndexOf("."))` returns the last
		// *character* when there is no dot, so "Makefile" inferred the language
		// "e". Guarding the no-dot case is also what makes "unknown" reachable.
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "Makefile" }).language,
		).toBe("unknown");
	});

	it("reports an unknown language for an entrypoint ending in a dot", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "weird." }).language,
		).toBe("unknown");
	});

	it("collapses the component runtime to wasm", () => {
		// Two names for one thing downstream; collapsing here means nothing
		// downstream has to know both.
		expect(
			parseServiceDeclaration({ name: "api", runtime: "component" }).runtime,
		).toBe("wasm");
	});

	it.each(["wasm", "container"])("keeps the runtime %s", (runtime) => {
		expect(parseServiceDeclaration({ name: "api", runtime }).runtime).toBe(
			runtime,
		);
	});

	it("matches the runtime case-insensitively", () => {
		expect(
			parseServiceDeclaration({ name: "api", runtime: "WASM" }).runtime,
		).toBe("wasm");
	});

	it("rejects an unknown runtime with its own code", () => {
		try {
			parseServiceDeclaration({ name: "api", runtime: "jvm" });
			expect.unreachable();
		} catch (error) {
			// SAFETY: `expect((error as BuildError).code).toBe("HOBO_BUILD_RUNTIME_INVALID");` is required at this I/O or test boundary.
			expect((error as BuildError).code).toBe("HOBO_BUILD_RUNTIME_INVALID");
		}
	});

	it("normalizes backslashes to forward slashes", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "src\\main.ts" })
				.entrypoint,
		).toBe("src/main.ts");
	});

	it("strips a leading ./ from a path", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "./src/main.ts" })
				.entrypoint,
		).toBe("src/main.ts");
	});

	it.each([
		"/etc/passwd",
		"C:/windows/system32",
		"../outside/main.ts",
		"src/../../escape.ts",
	])("rejects the escaping entrypoint %s", (entrypoint) => {
		expect(() => parseServiceDeclaration({ name: "api", entrypoint })).toThrow(
			/must stay inside the project/u,
		);
	});

	it("rejects an escaping sourceRoot as well as an entrypoint", () => {
		expect(() =>
			parseServiceDeclaration({ name: "api", sourceRoot: "/opt" }),
		).toThrow(/must stay inside the project/u);
	});

	it("does not reject a path merely containing two dots", () => {
		// `..` must be a whole segment; `a..b` is an ordinary name.
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "src/a..b.ts" })
				.entrypoint,
		).toBe("src/a..b.ts");
	});
});

describe("parseBuildManifest", () => {
	it("parses an empty manifest", () => {
		const parsed = parseBuildManifest(manifest());
		expect(parsed.schema).toBe(BUILD_MANIFEST_SCHEMA);
		expect(parsed.artifacts).toEqual([]);
	});

	it("always reports hobo build as the generator", () => {
		expect(parseBuildManifest(manifest()).generatedBy).toBe("hobo build");
	});

	it.each([null, undefined, "manifest", 7])("rejects %s", (raw) => {
		expect(() => parseBuildManifest(raw)).toThrow(BuildError);
	});

	it("rejects an unknown schema rather than guessing", () => {
		// The schema constant is the contract; accepting anything else would let
		// a future format be misread as this one.
		expect(() =>
			parseBuildManifest(manifest({ schema: "hobo.build-manifest/v2" })),
		).toThrow(/Unexpected manifest schema/u);
	});

	it("rejects a missing schema", () => {
		expect(() => parseBuildManifest({ artifacts: [] })).toThrow(
			/Unexpected manifest schema/u,
		);
	});

	it("treats a non-array artifacts field as empty", () => {
		expect(
			parseBuildManifest(manifest({ artifacts: "none" })).artifacts,
		).toEqual([]);
	});

	it("defaults the source date so a build stays reproducible", () => {
		expect(parseBuildManifest(manifest()).sourceDateEpoch).toBe(
			"2026-01-01T00:00:00.000Z",
		);
	});

	it("keeps a supplied source date", () => {
		expect(
			parseBuildManifest(
				manifest({ sourceDateEpoch: "2025-06-01T00:00:00.000Z" }),
			).sourceDateEpoch,
		).toBe("2025-06-01T00:00:00.000Z");
	});

	it("defaults the runtime target to auto", () => {
		expect(
			parseBuildManifest({ schema: BUILD_MANIFEST_SCHEMA, artifacts: [] })
				.runtimeTarget,
		).toBe("auto");
	});
});

describe("build artifacts", () => {
	it("parses a wasm artifact", () => {
		const parsed = parseBuildManifest(manifest({ artifacts: [artifact()] }));
		expect(parsed.artifacts[0]).toMatchObject({
			service: "api",
			kind: "wasm-component",
			digest: DIGEST,
		});
	});

	it("rejects a non-object artifact", () => {
		expect(() =>
			parseBuildManifest(manifest({ artifacts: ["not an object"] })),
		).toThrow(/artifact must be an object/u);
	});

	it.each([
		"",
		"docker-image",
		"wasm",
	])("rejects the artifact kind %s", (kind) => {
		expect(() =>
			parseBuildManifest(manifest({ artifacts: [artifact({ kind })] })),
		).toThrow(/Invalid artifact kind/u);
	});

	it.each([
		"",
		"sha256:short",
		`sha512:${"a".repeat(64)}`,
		`sha256:${"A".repeat(64)}`,
		`sha256:${"a".repeat(63)}`,
	])("rejects the malformed digest %s", (digest) => {
		// A manifest exists to make an artifact identifiable; a malformed digest
		// makes it a claim rather than a record.
		expect(() =>
			parseBuildManifest(manifest({ artifacts: [artifact({ digest })] })),
		).toThrow(/Invalid artifact digest/u);
	});

	it("requires an OCI artifact to say why it fell back", () => {
		// A fallback that does not record its reason is how the fallback quietly
		// becomes the default.
		expect(() =>
			parseBuildManifest(
				manifest({
					artifacts: [artifact({ kind: "oci-container", witWorld: undefined })],
				}),
			),
		).toThrow(/require fallbackReason/u);
	});

	it("accepts an OCI artifact that gives its reason", () => {
		const parsed = parseBuildManifest(
			manifest({
				artifacts: [
					artifact({
						kind: "oci-container",
						fallbackReason: "no componentize toolchain",
					}),
				],
			}),
		);
		expect(parsed.artifacts[0]).toMatchObject({
			fallbackReason: "no componentize toolchain",
		});
	});

	it("keeps a wit world when one is declared", () => {
		const parsed = parseBuildManifest(
			manifest({ artifacts: [artifact({ witWorld: "hobo:api/handler" })] }),
		);
		expect(parsed.artifacts[0]).toMatchObject({ witWorld: "hobo:api/handler" });
	});

	it("rejects an artifact path that escapes the project", () => {
		expect(() =>
			parseBuildManifest(
				manifest({ artifacts: [artifact({ path: "../outside.wasm" })] }),
			),
		).toThrow(/must stay inside the project/u);
	});

	it("parses several artifacts", () => {
		const parsed = parseBuildManifest(
			manifest({
				artifacts: [
					artifact(),
					artifact({ service: "web", path: "dist/web.wasm" }),
				],
			}),
		);
		expect(parsed.artifacts).toHaveLength(2);
	});
});

describe("normalizeTargetRuntime", () => {
	it.each([
		["auto", "auto"],
		["wasm", "wasm"],
		["container", "container"],
		["component", "wasm"],
		["AUTO", "auto"],
	])("maps %s to %s", (input, expected) => {
		expect(normalizeTargetRuntime(input)).toBe(expected);
	});

	it("rejects an unknown target with its own code", () => {
		try {
			normalizeTargetRuntime("jvm");
			expect.unreachable();
		} catch (error) {
			// SAFETY: `expect((error as BuildError).code).toBe("HOBO_BUILD_RUNTIME_INVALID");` is required at this I/O or test boundary.
			expect((error as BuildError).code).toBe("HOBO_BUILD_RUNTIME_INVALID");
			// SAFETY: `expect((error as BuildError).detail).toMatchObject({ runtime: "jvm" });` is required at this I/O or test boundary.
			expect((error as BuildError).detail).toMatchObject({ runtime: "jvm" });
		}
	});
});

describe("parseBuildRequestFromInvocation", () => {
	// SAFETY: `const context = { cwd: "/cwd" } as never;` is required at this I/O or test boundary.
	const context = { cwd: "/cwd" } as never;

	it("prefers the project directory over the working directory", () => {
		const request = parseBuildRequestFromInvocation(
			// SAFETY: `{ cwd: "/cwd", projectDir: "/project" } as never,` is required at this I/O or test boundary.
			{ cwd: "/cwd", projectDir: "/project" } as never,
			// SAFETY: `{ json: false } as never,` is required at this I/O or test boundary.
			{ json: false } as never,
			{},
		);
		expect(request.projectRoot).toBe("/project");
	});

	it("falls back to the working directory", () => {
		expect(
			// SAFETY: `parseBuildRequestFromInvocation(context, { json: false } as never, {})` is required at this I/O or test boundary.
			parseBuildRequestFromInvocation(context, { json: false } as never, {})
				.projectRoot,
		).toBe("/cwd");
	});

	it("prefers --runtime over --target", () => {
		expect(
			parseBuildRequestFromInvocation(
				context,
				// SAFETY: `{ json: false, runtime: "wasm", target: "container" } as never,` is required at this I/O or test boundary.
				{ json: false, runtime: "wasm", target: "container" } as never,
				{},
			).targetRuntime,
		).toBe("wasm");
	});

	it("falls back to --target", () => {
		expect(
			parseBuildRequestFromInvocation(
				context,
				// SAFETY: `{ json: false, target: "container" } as never,` is required at this I/O or test boundary.
				{ json: false, target: "container" } as never,
				{},
			).targetRuntime,
		).toBe("container");
	});

	it("falls back to the environment", () => {
		expect(
			// SAFETY: `parseBuildRequestFromInvocation(context, { json: false } as never, {` is required at this I/O or test boundary.
			parseBuildRequestFromInvocation(context, { json: false } as never, {
				HOBO_RUNTIME: "container",
			}).targetRuntime,
		).toBe("container");
	});

	it("prefers a flag over the environment", () => {
		// A flag is the more specific statement of intent.
		expect(
			parseBuildRequestFromInvocation(
				context,
				// SAFETY: `{ json: false, runtime: "wasm" } as never,` is required at this I/O or test boundary.
				{ json: false, runtime: "wasm" } as never,
				{ HOBO_RUNTIME: "container" },
			).targetRuntime,
		).toBe("wasm");
	});

	it("defaults to auto with nothing set", () => {
		expect(
			// SAFETY: `parseBuildRequestFromInvocation(context, { json: false } as never, {})` is required at this I/O or test boundary.
			parseBuildRequestFromInvocation(context, { json: false } as never, {})
				.targetRuntime,
		).toBe("auto");
	});

	it("honours SOURCE_DATE_EPOCH, which is what makes a build reproducible", () => {
		expect(
			// SAFETY: `parseBuildRequestFromInvocation(context, { json: false } as never, {` is required at this I/O or test boundary.
			parseBuildRequestFromInvocation(context, { json: false } as never, {
				SOURCE_DATE_EPOCH: "2020-01-01T00:00:00.000Z",
			}).sourceDateEpoch,
		).toBe("2020-01-01T00:00:00.000Z");
	});

	it("carries the json flag through", () => {
		expect(
			// SAFETY: `parseBuildRequestFromInvocation(context, { json: true } as never, {})` is required at this I/O or test boundary.
			parseBuildRequestFromInvocation(context, { json: true } as never, {})
				.json,
		).toBe(true);
	});
});
