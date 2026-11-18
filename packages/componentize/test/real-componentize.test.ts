import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	COMPONENT_MEDIA_TYPE,
	ComponentizeToolchainError,
	componentizeHelloBindle,
	createRealComponentize,
	REAL_COMPONENT_MIN_BYTES,
	type RealComponentizeImpl,
	validateRealWasmComponent,
} from "../src/index.js";
import { parseJsonObject } from "../src/json.js";

const SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";
const HELLO_BINDLE_ROOT = new URL("./fixtures/hello-bindle", import.meta.url);

const FIXED_BYTES = new Uint8Array(REAL_COMPONENT_MIN_BYTES + 1);
FIXED_BYTES.set([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
const FIXED_DIGEST = `sha256:${createHash("sha256").update(FIXED_BYTES).digest("hex")}`;

const tempRoots: string[] = [];

afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			await rm(root, { recursive: true, force: true });
		}
	}
});

async function writeSourceRoot(
	source = 'export function health() {\n\treturn "hello-bindle:ok";\n}\n',
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-real-componentize-test-"));
	tempRoots.push(root);
	const entry = join(root, "src/service.ts");
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(entry, source, "utf8");
	return root;
}

interface FixedImpl {
	impl: RealComponentizeImpl;
	calls: Array<Parameters<RealComponentizeImpl>>;
	sources: string[];
}

function fixedImpl(): FixedImpl {
	const calls: Array<Parameters<RealComponentizeImpl>> = [];
	const sources: string[] = [];
	const impl: RealComponentizeImpl = async (sourcePath, opts) => {
		calls.push([sourcePath, opts]);
		sources.push(await readFile(sourcePath, "utf8"));
		return { component: FIXED_BYTES };
	};
	return { impl, calls, sources };
}

describe("createRealComponentize (injected impl)", () => {
	it("produces the ComponentizeFn output shape with digest and OCI descriptor", async () => {
		const { impl, calls } = fixedImpl();
		const real = await createRealComponentize({ componentizeImpl: impl });
		expect(real.available).toBe(true);

		const sourceRoot = await writeSourceRoot();
		const result = await real.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});

		expect(result.component.path).toBe("dist/hello-bindle.component.wasm");
		expect(result.component.mediaType).toBe(COMPONENT_MEDIA_TYPE);
		expect(result.component.digest).toBe(FIXED_DIGEST);
		expect(result.component.bytes).toEqual(FIXED_BYTES);
		expect(result.component.witWorld).toBe("hobo:examples/hello-bindle@0.1.0");

		expect(result.oci.artifactType).toBe(COMPONENT_MEDIA_TYPE);
		expect(result.oci.manifest.layers[0]?.digest).toBe(result.component.digest);
		expect(result.oci.manifest.layers[0]?.size).toBe(FIXED_BYTES.byteLength);

		expect(calls).toHaveLength(1);
		const [sourcePath, opts] = calls[0] ?? [];
		expect(sourcePath).toMatch(/src[/\\]service\.js$/);
		expect(opts?.worldName).toBe("hello-bindle");
		expect(opts?.disableFeatures).toEqual([
			"random",
			"clocks",
			"stdio",
			"http",
		]);
		expect(opts?.env).toEqual({
			SOURCE_DATE_EPOCH: "1767225600",
			XDG_CACHE_HOME: expect.stringMatching(
				/hobo-real-componentize-.*[/\\]\.cache$/u,
			),
		});
	});

	it("returns identical metadata and descriptors when the emitted bytes match", async () => {
		const { impl } = fixedImpl();
		const real = await createRealComponentize({ componentizeImpl: impl });
		const sourceRoot = await writeSourceRoot();

		const first = await real.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		const second = await real.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});

		expect(second.component.digest).toBe(first.component.digest);
		expect(second.component.metadata).toBe(first.component.metadata);
		expect(second.oci).toEqual(first.oci);
	});

	it("records the WIT interface contents in the build metadata", async () => {
		const { impl } = fixedImpl();
		const sourceRoot = await writeSourceRoot();
		const firstWit =
			"package hobo:examples@0.1.0; world hello-bindle { export health: func() -> string; }";
		const secondWit =
			"package hobo:examples@0.1.0; world hello-bindle { export health: func() -> string; export version: func() -> string; }";
		const options = {
			worldName: "hello-bindle",
			witWorld: "hobo:examples/hello-bindle@0.1.0",
		};
		const firstBuilder = await createRealComponentize({
			componentizeImpl: impl,
			wit: { ...options, source: firstWit },
		});
		const secondBuilder = await createRealComponentize({
			componentizeImpl: impl,
			wit: { ...options, source: secondWit },
		});
		const first = await firstBuilder.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		const second = await secondBuilder.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		const firstMetadata = parseJsonObject(first.component.metadata);
		const secondMetadata = parseJsonObject(second.component.metadata);
		expect(firstMetadata.sourceDigest).toBe(secondMetadata.sourceDigest);
		expect(firstMetadata.witDigest).toBe(
			`sha256:${createHash("sha256").update(firstWit).digest("hex")}`,
		);
		expect(secondMetadata.witDigest).toBe(
			`sha256:${createHash("sha256").update(secondWit).digest("hex")}`,
		);
		expect(first.oci.manifest.config.digest).not.toBe(
			second.oci.manifest.config.digest,
		);
	});

	it("bundles TypeScript syntax and local imports", async () => {
		const { impl, sources } = fixedImpl();
		const real = await createRealComponentize({ componentizeImpl: impl });
		const sourceRoot = await writeSourceRoot(
			'import { status } from "./status.js";\nexport function health(): string { return status; }\n',
		);
		await writeFile(
			join(sourceRoot, "src/status.ts"),
			'export const status: string = "hello-bindle:ok";\n',
			"utf8",
		);

		await real.componentize({
			sourceRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});

		expect(sources[0]).toMatch(/var status\s*=\s*"hello-bindle:ok"/u);
		expect(sources[0]).not.toContain(": string");
		expect(sources[0]).not.toContain("./status.js");
	});

	it("uses the same bundled source and metadata in different directories", async () => {
		const { impl, sources } = fixedImpl();
		const firstRoot = await writeSourceRoot(
			'import { status } from "./status.js";\nexport function health(): string { return status; }\n',
		);
		const secondRoot = await writeSourceRoot(
			'import { status } from "./status.js";\nexport function health(): string { return status; }\n',
		);
		for (const root of [firstRoot, secondRoot]) {
			await writeFile(
				join(root, "src/status.ts"),
				'export const status: string = "hello-bindle:ok";\n',
				"utf8",
			);
		}
		const real = await createRealComponentize({ componentizeImpl: impl });
		const first = await real.componentize({
			sourceRoot: firstRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		const second = await real.componentize({
			sourceRoot: secondRoot,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		expect(sources[0]).toBe(sources[1]);
		expect(first.component.metadata).toBe(second.component.metadata);
	});

	it("fails closed on an invalid sourceDateEpoch", async () => {
		const { impl } = fixedImpl();
		const real = await createRealComponentize({ componentizeImpl: impl });
		const sourceRoot = await writeSourceRoot();

		await expect(
			real.componentize({ sourceRoot, sourceDateEpoch: "not-a-date" }),
		).rejects.toThrow(/componentize\.invalid_source_date_epoch/);
	});

	it("fails closed when the entry source is missing", async () => {
		const { impl } = fixedImpl();
		const real = await createRealComponentize({ componentizeImpl: impl });
		const root = await mkdtemp(join(tmpdir(), "hobo-real-componentize-empty-"));
		tempRoots.push(root);

		await expect(
			real.componentize({
				sourceRoot: root,
				sourceDateEpoch: SOURCE_DATE_EPOCH,
			}),
		).rejects.toThrow(/componentize\.real\.missing_entry/);
	});
});

describe("createRealComponentize (toolchain probe)", () => {
	it("reports unavailable and throws the typed error when the import fails", async () => {
		const real = await createRealComponentize({
			importModule: () => Promise.reject(new Error("MODULE_NOT_FOUND")),
		});

		expect(real.available).toBe(false);
		const failure = real.componentize({
			sourceRoot: "/nowhere",
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		await expect(failure).rejects.toBeInstanceOf(ComponentizeToolchainError);
		await expect(failure).rejects.toThrow(
			/componentize\.toolchain_unavailable/,
		);

		const error = await real
			.componentize({
				sourceRoot: "/nowhere",
				sourceDateEpoch: SOURCE_DATE_EPOCH,
			})
			.catch((caught: ComponentizeToolchainError) => caught);
		expect(error).toBeInstanceOf(ComponentizeToolchainError);
		if (error instanceof ComponentizeToolchainError) {
			expect(error.remediation).toMatch(/componentizeHelloBindle/);
			expect(error.remediation).toMatch(/synthetic contract-shaped floor/);
		}
	});

	it("reports unavailable when the module lacks a componentize export", async () => {
		const real = await createRealComponentize({
			importModule: () => Promise.resolve({}),
		});
		expect(real.available).toBe(false);
	});
});

describe("validateRealWasmComponent", () => {
	it("rejects non-wasm bytes", () => {
		expect(() => validateRealWasmComponent(Uint8Array.from([1, 2, 3]))).toThrow(
			/componentize\.real\.invalid_magic/,
		);
	});

	it("rejects the synthetic contract envelope (core-module layer)", async () => {
		const synthetic = await componentizeHelloBindle({
			sourceRoot: HELLO_BINDLE_ROOT,
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});
		expect(() => validateRealWasmComponent(synthetic.component.bytes)).toThrow(
			/componentize\.real\.not_a_component/,
		);
	});

	it("rejects component-layer bytes at or below the synthetic size floor", () => {
		const tiny = new Uint8Array(64);
		tiny.set([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
		expect(() => validateRealWasmComponent(tiny)).toThrow(
			/componentize\.real\.below_synthetic_floor/,
		);
	});

	it("accepts structurally component-shaped bytes above the floor", () => {
		const bytes = new Uint8Array(REAL_COMPONENT_MIN_BYTES + 1);
		bytes.set([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
		expect(validateRealWasmComponent(bytes)).toEqual({
			format: "wasm-component",
			layer: 1,
			byteLength: REAL_COMPONENT_MIN_BYTES + 1,
		});
	});
});
