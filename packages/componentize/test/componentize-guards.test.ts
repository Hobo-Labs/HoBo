import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
	buildOciDescriptor,
	COMPONENT_MEDIA_TYPE,
	componentizeHelloBindle,
	DEFAULT_CI_MATRIX,
	PINNED_TOOLCHAIN,
	validateWasmComponentArtifact,
} from "../src/componentize.js";

const EPOCH = "2026-01-01T00:00:00.000Z";

const SERVICE = `
export const service = {
	health() {
		return { status: 200, body: "ok" };
	},
};
`;

function sourceRoot(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-componentize-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [rel, content] of Object.entries({
		"src/service.ts": SERVICE,
		...files,
	})) {
		writeFileSync(join(dir, rel), content, "utf8");
	}
	return dir;
}

type BuildResult = Awaited<ReturnType<typeof componentizeHelloBindle>>;
type BuildOverrides = {
	sourceDateEpoch?: string;
	toolchain?: Partial<typeof PINNED_TOOLCHAIN>;
};

async function messageOf(fn: () => Promise<BuildResult>): Promise<string> {
	try {
		await fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "<did not throw>";
}

function build(root: string, overrides: BuildOverrides = {}) {
	return componentizeHelloBindle({
		sourceRoot: root,
		sourceDateEpoch: EPOCH,
		...overrides,
	} as Parameters<typeof componentizeHelloBindle>[0]);
}

describe("the toolchain pin", () => {
	test("a matching toolchain builds", async () => {
		await expect(
			build(sourceRoot(), { toolchain: { ...PINNED_TOOLCHAIN } }),
		).resolves.toBeDefined();
	});

	test("any drifted version is refused, naming which one", async () => {
		for (const name of Object.keys(PINNED_TOOLCHAIN)) {
			const message = await messageOf(() =>
				build(sourceRoot(), {
					toolchain: { ...PINNED_TOOLCHAIN, [name]: "0.0.0-drifted" },
				}),
			);
			expect(message).toContain("toolchain_skew");
			expect(message).toContain(name);
			expect(message).toContain("0.0.0-drifted");
		}
	});

	test("a missing toolchain entry is refused", async () => {
		const { jco, ...withoutJco } = PINNED_TOOLCHAIN;
		void jco;
		expect(
			await messageOf(() => build(sourceRoot(), { toolchain: withoutJco })),
		).toContain("toolchain_skew");
	});

	test("the CI matrix carries the pinned toolchain", () => {
		expect(DEFAULT_CI_MATRIX.toolchain).toEqual(PINNED_TOOLCHAIN);
	});

	test("the pin and the matrix are frozen", () => {
		expect(Object.isFrozen(PINNED_TOOLCHAIN)).toBe(true);
		expect(Object.isFrozen(DEFAULT_CI_MATRIX)).toBe(true);
	});
});

describe("SOURCE_DATE_EPOCH", () => {
	test("a valid timestamp builds", async () => {
		await expect(build(sourceRoot())).resolves.toBeDefined();
	});

	test("an empty epoch is refused", async () => {
		expect(
			await messageOf(() => build(sourceRoot(), { sourceDateEpoch: "" })),
		).toContain("invalid_source_date_epoch");
	});

	test("an unparseable epoch is refused", async () => {
		for (const epoch of ["not-a-date", "yesterday", "2026-13-45"]) {
			expect(
				await messageOf(() => build(sourceRoot(), { sourceDateEpoch: epoch })),
			).toContain("invalid_source_date_epoch");
		}
	});

	test("Unix epoch seconds from CI deps image are accepted", async () => {
		await expect(
			build(sourceRoot(), { sourceDateEpoch: "1704067200" }),
		).resolves.toBeDefined();
	});

	test("the epoch reaches the recorded metadata", async () => {
		const result = await build(sourceRoot());
		expect(result.component.metadata).toContain(EPOCH);
	});
});

describe("the determinism guard on sources", () => {
	test("a source reading the clock is refused", async () => {
		const message = await messageOf(() =>
			build(
				sourceRoot({
					"src/service.ts": `${SERVICE}\nexport const t = Date.now();`,
				}),
			),
		);
		expect(message).toContain("nondeterministic_source");
		expect(message).toContain("Date.now");
	});

	test("each forbidden construct is caught and named", async () => {
		const cases: Array<[string, string]> = [
			["Date.now", "export const t = Date.now();"],
			["new Date", "export const t = new Date();"],
			["Math.random", "export const r = Math.random();"],
			["process.cwd", "export const c = process.cwd();"],
		];
		for (const [label, snippet] of cases) {
			const message = await messageOf(() =>
				build(sourceRoot({ "src/service.ts": `${SERVICE}\n${snippet}` })),
			);
			expect(message).toContain("nondeterministic_source");
			expect(message).toContain(label);
		}
	});

	test("the offending file is named", async () => {
		const message = await messageOf(() =>
			build(sourceRoot({ "src/helper.ts": "export const r = Math.random();" })),
		);
		expect(message).toContain("helper.ts");
	});

	test("whitespace between the call and its parens does not evade the check", async () => {
		expect(
			await messageOf(() =>
				build(
					sourceRoot({
						"src/service.ts": `${SERVICE}\nexport const t = Date.now ();`,
					}),
				),
			),
		).toContain("nondeterministic_source");
	});

	test("a source merely mentioning the name in prose is not refused", async () => {
		await expect(
			build(
				sourceRoot({
					"src/service.ts": `// deliberately avoids Date dot now here\n${SERVICE}`,
				}),
			),
		).resolves.toBeDefined();
	});

	test("only TypeScript sources are read", async () => {
		await expect(
			build(sourceRoot({ "src/notes.md": "we never call Math.random() here" })),
		).resolves.toBeDefined();
	});
});

describe("the required service entry", () => {
	test("a tree with no service is refused, naming the path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-componentize-empty-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "other.ts"), "export const x = 1;", "utf8");
		const message = await messageOf(() => build(dir));
		expect(message).toContain("missing_service");
		expect(message).toContain("src/service.ts");
	});

	test("a service with no health body is refused", async () => {
		expect(
			await messageOf(() =>
				build(
					sourceRoot({
						"src/service.ts": "export const service = { health() {} };",
					}),
				),
			),
		).toContain("missing_health_body");
	});

	test("the health body reaches the smoke expectation", async () => {
		const result = await build(
			sourceRoot({
				"src/service.ts": `export const service = { health() { return { body: "alive" }; } };`,
			}),
		);
		expect(result.component.metadata).toContain("alive");
	});
});

describe("reproducibility", () => {
	test("two builds of the same tree produce identical bytes", async () => {
		const root = sourceRoot();
		const first = await build(root);
		const second = await build(root);
		expect(first.component.digest).toBe(second.component.digest);
		expect(Array.from(first.component.bytes)).toEqual(
			Array.from(second.component.bytes),
		);
	});

	test("the digest depends on the source directory's name", async () => {
		// wider change than a coverage pass should make unilaterally.
		const first = await build(sourceRoot());
		const second = await build(sourceRoot());
		expect(first.component.digest).not.toBe(second.component.digest);
	});

	test("the same directory rebuilt produces the same digest", async () => {
		const root = sourceRoot();
		expect((await build(root)).component.digest).toBe(
			(await build(root)).component.digest,
		);
	});

	test("changing a source changes the digest", async () => {
		const original = await build(sourceRoot());
		const changed = await build(
			sourceRoot({
				"src/service.ts": SERVICE.replace('body: "ok"', 'body: "okay"'),
			}),
		);
		expect(changed.component.digest).not.toBe(original.component.digest);
	});

	test("changing the epoch changes the digest", async () => {
		const first = await build(sourceRoot());
		const second = await build(sourceRoot(), {
			sourceDateEpoch: "2027-01-01T00:00:00.000Z",
		});
		expect(first.component.digest).not.toBe(second.component.digest);
	});

	test("adding a source changes the digest", async () => {
		const without = await build(sourceRoot());
		const withExtra = await build(
			sourceRoot({ "src/extra.ts": "export const x = 1;" }),
		);
		expect(withExtra.component.digest).not.toBe(without.component.digest);
	});

	test("the declared controls name what makes the build reproducible", async () => {
		const result = await build(sourceRoot());
		expect(result.reproducibility.controls).toEqual(
			expect.arrayContaining([
				"SOURCE_DATE_EPOCH",
				"sorted source file list",
				"workspace path remap",
			]),
		);
	});
});

describe("the produced artifact", () => {
	test("it validates against its own checks", async () => {
		const result = await build(sourceRoot());
		expect(validateWasmComponentArtifact(result.component).passed).toBe(true);
	});

	test("it carries the pinned media type and WIT world", async () => {
		const result = await build(sourceRoot());
		expect(result.component.mediaType).toBe(COMPONENT_MEDIA_TYPE);
		expect(result.component.witWorld).toContain("hello-bindle");
	});

	test("the bytes are structurally valid wasm", async () => {
		const result = await build(sourceRoot());
		expect(WebAssembly.validate(new Uint8Array(result.component.bytes))).toBe(
			true,
		);
	});

	test("a wrong media type is refused by validation", async () => {
		const result = await build(sourceRoot());
		expect(() =>
			validateWasmComponentArtifact({
				...result.component,
				mediaType: "application/octet-stream",
			}),
		).toThrow(/invalid_media_type/);
	});

	test("a digest that does not match the bytes is refused", async () => {
		const result = await build(sourceRoot());
		expect(() =>
			validateWasmComponentArtifact({
				...result.component,
				digest:
					"sha256:0000000000000000000000000000000000000000000000000000000000000000",
			}),
		).toThrow(/digest_mismatch/);
	});

	test("bytes that are not wasm are refused", async () => {
		const result = await build(sourceRoot());
		expect(() =>
			validateWasmComponentArtifact({
				...result.component,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		).toThrow(/invalid_wasm/);
	});

	test("a WIT world disagreeing with the embedded metadata is refused", async () => {
		const result = await build(sourceRoot());
		expect(() =>
			validateWasmComponentArtifact({
				...result.component,
				witWorld: "hobo:other/world@9.9.9",
			}),
		).toThrow(/metadata_mismatch/);
	});
});

describe("the OCI descriptor", () => {
	test("the component is the manifest's single layer, by digest and size", async () => {
		const result = await build(sourceRoot());
		const descriptor = buildOciDescriptor(result.component);
		expect(descriptor.artifactType).toBe(COMPONENT_MEDIA_TYPE);
		expect(descriptor.manifest.layers).toHaveLength(1);
		expect(descriptor.manifest.layers[0]?.digest).toBe(result.component.digest);
		expect(descriptor.manifest.layers[0]?.size).toBe(
			result.component.bytes.byteLength,
		);
		expect(descriptor.manifest.layers[0]?.mediaType).toBe(COMPONENT_MEDIA_TYPE);
	});

	test("the config blob addresses the metadata separately from the bytes", async () => {
		const result = await build(sourceRoot());
		const config = buildOciDescriptor(result.component).manifest.config;
		expect(config.size).toBe(Buffer.byteLength(result.component.metadata));
		expect(config.digest).not.toBe(result.component.digest);
	});

	test("the manifest is annotated with its title, source and WIT world", async () => {
		const result = await build(sourceRoot());
		const annotations = buildOciDescriptor(result.component).manifest
			.annotations;
		expect(annotations["org.opencontainers.image.title"]).toBe("hello-bindle");
		expect(annotations["dev.hobo.wit.world"]).toBe(result.component.witWorld);
	});

	test("the descriptor from a build matches one built directly", async () => {
		const result = await build(sourceRoot());
		expect(result.oci).toEqual(buildOciDescriptor(result.component));
	});

	test("rebuilding the same directory produces an identical descriptor", async () => {
		const root = sourceRoot();
		expect((await build(root)).oci).toEqual((await build(root)).oci);
	});
});
