/**
 * Parsing service declarations and build artifacts.
 *
 * A build artifact record is what a later deploy resolves and ships, so the
 * fields here are the ones that decide *which bytes run in production*. The
 * digest is the load-bearing one: it is how a deploy verifies it got the
 * artifact the build produced rather than something else with the same path. A
 * malformed digest accepted here would be compared against and never match, or —
 * worse, if the comparison were lenient anywhere downstream — would let an
 * unverified artifact through.
 *
 * The other rule worth naming is that an **OCI fallback must say why it fell
 * back**. A wasm component is the intended output; an OCI container means
 * componentization did not happen. Recording that without a reason would leave a
 * deployment that silently is not what the project asked for, and nothing in the
 * artifact to say so.
 */
import { describe, expect, it } from "vitest";

import { BuildError } from "../src/build/errors.js";
import {
	BUILD_MANIFEST_SCHEMA,
	normalizeTargetRuntime,
	parseBuildManifest,
	parseServiceDeclaration,
} from "../src/build/parse.js";

/**
 * Artifacts are parsed as part of a manifest rather than on their own, so every
 * artifact assertion goes through `parseBuildManifest` with a single-artifact
 * manifest. That is also how the code is really reached in production.
 */
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
		// Only the name is required; the entrypoint and source root are derived.
		// Requiring all three would make the common case verbose for no gain.
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
		// So a service with a nested entrypoint gets a source root that actually
		// contains it. Defaulting to the project root would hand the whole tree
		// to the componentizer.
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
		// Service names become directory names, artifact filenames, and manifest
		// keys. An uppercase or space-bearing name would work on one filesystem
		// and break on another — the worst kind of portability bug, since it
		// passes locally.
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
		// A bindle with a dozen services needs to say which one is malformed.
		try {
			parseServiceDeclaration({ name: "BAD" });
			expect.unreachable("an invalid name must be refused");
		} catch (error) {
			expect((error as BuildError).detail).toMatchObject({ service: "BAD" });
			expect((error as Error).message).toContain("BAD");
		}
	});

	it("refuses a missing name rather than defaulting one", () => {
		// `String(record.name ?? "")` produces an empty string, which the pattern
		// rejects. A default like "service" would build something the author
		// never declared.
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
		// The kind decides which runtime path a deploy takes. An unrecognised one
		// would be carried into a manifest and fail at the point something tried
		// to run it.
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
		// The verification anchor. A truncated or differently-prefixed digest
		// would be compared against and never match — or, if any comparison
		// downstream were lenient, would let through an artifact nobody checked.
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
		// The artifact path is joined against a project root and read. An
		// absolute path ignores the root; a traversing one walks out of it.
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
		// The honesty rule. A wasm component is the intended output; an OCI
		// container means componentization did not happen, and an artifact that
		// recorded the substitution without the reason would deploy something
		// other than what the project asked for with nothing saying so.
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
		// `!fallbackReason` — an empty string explains nothing, and accepting it
		// would satisfy the rule while defeating its purpose.
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
		// The intended path needs no explanation; demanding one would make every
		// successful build carry a field about a fallback that did not happen.
		expect(() => parseBuildArtifact(ARTIFACT)).not.toThrow();
	});

	it("omits the WIT world when the artifact does not name one", () => {
		// Conditional spread. A `witWorld: undefined` key would read to a
		// consumer as a component that declares an empty world rather than one
		// that declares none.
		expect(Object.hasOwn(parseBuildArtifact(ARTIFACT), "witWorld")).toBe(false);
	});

	it("carries a stated WIT world through", () => {
		// The world is the component's contract. Dropping it would leave a
		// deploy unable to check that a host can serve what the component needs.
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
		// `String(record.x ?? "")` on service, mediaType, runtime and source. An
		// artifact missing one of these is still resolvable — the digest and path
		// are what a deploy needs — so the parser fills a blank rather than
		// refusing. Pinned because the blanks are deliberate: an `undefined`
		// would vanish from the serialized manifest, and a consumer checking
		// `"runtime" in artifact` would get a different answer than one checking
		// `artifact.runtime === ""`.
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
		// Two words for one target. A component *is* the wasm output, and
		// carrying both spellings downstream would make every comparison check
		// two strings — and one place would forget.
		expect(normalizeTargetRuntime("component")).toBe("wasm");
	});

	it("is case-insensitive", () => {
		// `--runtime WASM` from a shell with an uppercase variable is the same
		// request. Rejecting it would be a distinction with no meaning.
		for (const runtime of ["AUTO", "Wasm", "COMPONENT", "Container"]) {
			expect(() => normalizeTargetRuntime(runtime)).not.toThrow();
		}
		expect(normalizeTargetRuntime("COMPONENT")).toBe("wasm");
	});

	it("refuses a runtime nothing supports", () => {
		// The target decides which build path runs. An unrecognised one carried
		// through would fail deep inside a builder rather than at the flag that
		// named it.
		for (const runtime of ["", "docker", "native", "wasm32", "auto "]) {
			expect(codeOf(() => normalizeTargetRuntime(runtime))).toBe(
				"HOBO_BUILD_RUNTIME_INVALID",
			);
		}
	});

	it("echoes the rejected runtime in the message and detail", () => {
		// Echoed in its original case, so the user sees what they typed rather
		// than the lowercased form the check compared.
		try {
			normalizeTargetRuntime("Docker");
			expect.unreachable("an unknown runtime must be refused");
		} catch (error) {
			expect((error as Error).message).toContain("Docker");
			expect((error as BuildError).detail).toMatchObject({ runtime: "Docker" });
		}
	});
});
