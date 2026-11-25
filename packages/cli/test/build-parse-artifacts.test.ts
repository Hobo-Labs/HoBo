import { describe, expect, it } from "vitest";

import { BuildError } from "../src/build/errors.js";
import {
	BUILD_MANIFEST_SCHEMA,
	normalizeTargetRuntime,
	parseBuildManifest,
	parseServiceDeclaration,
} from "../src/build/parse.js";

function parseBuildArtifact(raw: unknown) {
	const parsed = parseBuildManifest({
		schema: BUILD_MANIFEST_SCHEMA,
		artifacts: [raw],
	});
	const artifact = parsed.artifacts[0];
	if (!artifact) throw new Error("expected one artifact");
	return artifact;
}

const DIGEST = `sha256:${"a".repeat(64)}`;

const ARTIFACT = {
	service: "api",
	kind: "wasm-component",
	path: "dist/api.wasm",
	mediaType: "application/wasm",
	digest: DIGEST,
	runtime: "wasmtime",
	source: "src/api.ts",
};

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(BuildError);
		return (error as BuildError).code;
	}
	throw new Error("expected the parser to refuse this input");
}

describe("parseServiceDeclaration", () => {
	it("accepts a minimal declaration and derives its paths", () => {
		const parsed = parseServiceDeclaration({ name: "api" });
		expect(parsed.name).toBe("api");
		expect(parsed.entrypoint.length).toBeGreaterThan(0);
		expect(parsed.sourceRoot.length).toBeGreaterThan(0);
	});

	it("honours an explicit entrypoint and source root", () => {
		const parsed = parseServiceDeclaration({
			name: "api",
			entrypoint: "src/api/main.ts",
			sourceRoot: "src/api",
		});
		expect(parsed.entrypoint).toBe("src/api/main.ts");
		expect(parsed.sourceRoot).toBe("src/api");
	});

	it("derives the source root from the entrypoint's directory", () => {
		expect(
			parseServiceDeclaration({ name: "api", entrypoint: "src/api/main.ts" })
				.sourceRoot,
		).toBe("src/api");
	});

	it("refuses a declaration that is not an object", () => {
		for (const raw of [undefined, null, "api", 7, true]) {
			expect(codeOf(() => parseServiceDeclaration(raw))).toBe(
				"HOBO_BUILD_SERVICE_INVALID",
			);
		}
	});

	it("refuses a name that is not a lowercase identifier", () => {
		for (const name of ["API", "my api", "my_api", "9api", "-api", "", "a/b"]) {
			expect(codeOf(() => parseServiceDeclaration({ name }))).toBe(
				"HOBO_BUILD_SERVICE_INVALID",
			);
		}
	});

	it("accepts the name shapes a service can legitimately have", () => {
		for (const name of ["api", "a", "my-api", "api2", "a-b-c"]) {
			expect(() => parseServiceDeclaration({ name })).not.toThrow();
		}
	});

	it("names the offending service in the refusal detail", () => {
		try {
			parseServiceDeclaration({ name: "BAD" });
			expect.unreachable("an invalid name must be refused");
		} catch (error) {
			expect((error as BuildError).detail).toMatchObject({ service: "BAD" });
			expect((error as Error).message).toContain("BAD");
		}
	});

	it("refuses a missing name rather than defaulting one", () => {
		expect(codeOf(() => parseServiceDeclaration({}))).toBe(
			"HOBO_BUILD_SERVICE_INVALID",
		);
	});
});

describe("parseBuildArtifact", () => {
	it("accepts a well-formed wasm component", () => {
		const parsed = parseBuildArtifact(ARTIFACT);
		expect(parsed.service).toBe("api");
		expect(parsed.kind).toBe("wasm-component");
		expect(parsed.digest).toBe(DIGEST);
	});

	it("refuses an artifact that is not an object", () => {
		for (const raw of [undefined, null, "artifact", 7]) {
			expect(codeOf(() => parseBuildArtifact(raw))).toBe(
				"HOBO_BUILD_SOURCE_PARSE",
			);
		}
	});

	it("accepts only the two artifact kinds that exist", () => {
		for (const kind of [
			"",
			"wasm",
			"container",
			"oci",
			"docker",
			"WASM-COMPONENT",
		]) {
			expect(codeOf(() => parseBuildArtifact({ ...ARTIFACT, kind }))).toBe(
				"HOBO_BUILD_SOURCE_PARSE",
			);
		}
	});

	it("names the kind it rejected", () => {
		expect(() => parseBuildArtifact({ ...ARTIFACT, kind: "docker" })).toThrow(
			/"docker"/u,
		);
	});

	it("requires a full sha256 digest", () => {
		for (const digest of [
			"",
			"abc",
			"a".repeat(64),
			`sha256:${"a".repeat(63)}`,
			`sha256:${"a".repeat(65)}`,
			`sha1:${"a".repeat(40)}`,
			`sha256:${"A".repeat(64)}`,
			`SHA256:${"a".repeat(64)}`,
		]) {
			expect(codeOf(() => parseBuildArtifact({ ...ARTIFACT, digest }))).toBe(
				"HOBO_BUILD_SOURCE_PARSE",
			);
		}
	});

	it("accepts a lowercase hex digest of exactly the right length", () => {
		expect(
			parseBuildArtifact({
				...ARTIFACT,
				digest: `sha256:${"0123456789abcdef".repeat(4)}`,
			}).digest,
		).toBe(`sha256:${"0123456789abcdef".repeat(4)}`);
	});

	it("refuses an absolute or traversing artifact path", () => {
		for (const path of [
			"/etc/passwd",
			"../outside.wasm",
			"dist/../../x.wasm",
		]) {
			expect(() => parseBuildArtifact({ ...ARTIFACT, path })).toThrow(
				BuildError,
			);
		}
	});

	it("requires an OCI fallback to say why it fell back", () => {
		expect(
			codeOf(() =>
				parseBuildArtifact({
					...ARTIFACT,
					kind: "oci-container",
					mediaType: "application/vnd.oci.image.manifest.v1+json",
				}),
			),
		).toBe("HOBO_BUILD_SOURCE_PARSE");
	});

	it("accepts an OCI fallback that states its reason", () => {
		const parsed = parseBuildArtifact({
			...ARTIFACT,
			kind: "oci-container",
			fallbackReason: "componentize-js unavailable",
		});
		expect(parsed.kind).toBe("oci-container");
	});

	it("treats an empty fallback reason as no reason", () => {
		expect(
			codeOf(() =>
				parseBuildArtifact({
					...ARTIFACT,
					kind: "oci-container",
					fallbackReason: "",
				}),
			),
		).toBe("HOBO_BUILD_SOURCE_PARSE");
	});

	it("does not require a reason from a wasm component", () => {
		expect(() => parseBuildArtifact(ARTIFACT)).not.toThrow();
	});

	it("omits the WIT world when the artifact does not name one", () => {
		expect(Object.hasOwn(parseBuildArtifact(ARTIFACT), "witWorld")).toBe(false);
	});

	it("carries a stated WIT world through", () => {
		expect(
			parseBuildArtifact({ ...ARTIFACT, witWorld: "hobo:sdk/sdk" }).witWorld,
		).toBe("hobo:sdk/sdk");
	});

	it("normalizes the source and path fields", () => {
		const parsed = parseBuildArtifact({
			...ARTIFACT,
			path: "./dist/api.wasm",
			source: "./src/api.ts",
		});
		expect(parsed.path).toBe("dist/api.wasm");
		expect(parsed.source).toBe("src/api.ts");
	});

	it("defaults the descriptive fields rather than dropping them", () => {
		const sparse = parseBuildArtifact({
			kind: "wasm-component",
			digest: DIGEST,
			path: "dist/api.wasm",
		});
		expect(sparse.service).toBe("");
		expect(sparse.mediaType).toBe("");
		expect(sparse.runtime).toBe("");
		expect(sparse.source).toBe("");
	});

	it("carries the service, media type, and runtime it was given", () => {
		const parsed = parseBuildArtifact(ARTIFACT);
		expect(parsed.service).toBe("api");
		expect(parsed.mediaType).toBe("application/wasm");
		expect(parsed.runtime).toBe("wasmtime");
	});
});

describe("normalizeTargetRuntime", () => {
	it("accepts the runtime names a user can write", () => {
		expect(normalizeTargetRuntime("auto")).toBe("auto");
		expect(normalizeTargetRuntime("wasm")).toBe("wasm");
		expect(normalizeTargetRuntime("container")).toBe("container");
	});

	it("folds component onto wasm", () => {
		expect(normalizeTargetRuntime("component")).toBe("wasm");
	});

	it("is case-insensitive", () => {
		for (const runtime of ["AUTO", "Wasm", "COMPONENT", "Container"]) {
			expect(() => normalizeTargetRuntime(runtime)).not.toThrow();
		}
		expect(normalizeTargetRuntime("COMPONENT")).toBe("wasm");
	});

	it("refuses a runtime nothing supports", () => {
		for (const runtime of ["", "docker", "native", "wasm32", "auto "]) {
			expect(codeOf(() => normalizeTargetRuntime(runtime))).toBe(
				"HOBO_BUILD_RUNTIME_INVALID",
			);
		}
	});

	it("echoes the rejected runtime in the message and detail", () => {
		try {
			normalizeTargetRuntime("Docker");
			expect.unreachable("an unknown runtime must be refused");
		} catch (error) {
			expect((error as Error).message).toContain("Docker");
			expect((error as BuildError).detail).toMatchObject({ runtime: "Docker" });
		}
	});
});
