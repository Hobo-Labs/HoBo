import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RealComponentize } from "@hobo/componentize";
import { afterEach, describe, expect, it } from "vitest";

import { adaptRealComponentize } from "../src/build/componentize-adapter.js";
import { BuildError } from "../src/build/errors.js";
import {
	BUILD_MANIFEST_PATH,
	runBuild,
	writeBuildFixtureProject,
} from "../src/build/run-build.js";
import { runCodegen } from "../src/codegen/run-codegen.js";

const SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";
const FIXED_BYTES = Uint8Array.from([0xca, 0xfe, 0xf0, 0x0d]);
const FIXED_DIGEST = `sha256:${createHash("sha256").update(FIXED_BYTES).digest("hex")}`;

const unavailableReal: RealComponentize = {
	available: false,
	componentize: async () => {
		throw new Error("componentize.toolchain_unavailable");
	},
};

const fakeReal: RealComponentize = {
	available: true,
	componentize: async () => {
		const component = {
			path: "dist/hello-bindle.component.wasm",
			mediaType: "application/vnd.wasm.component.v1+wasm",
			digest: FIXED_DIGEST,
			bytes: FIXED_BYTES,
			witWorld: "hobo:examples/hello-bindle@0.1.0",
			metadata: '{"schema":"hobo.componentize.real/v1"}',
		};
		return {
			component,
			oci: {
				artifactType: component.mediaType,
				manifest: {
					schemaVersion: 2,
					mediaType: "application/vnd.oci.image.manifest.v1+json",
					artifactType: component.mediaType,
					config: {
						mediaType: "application/vnd.hobo.componentize.config.v1+json",
						digest: FIXED_DIGEST,
						size: component.metadata.length,
					},
					layers: [
						{
							mediaType: component.mediaType,
							digest: component.digest,
							size: FIXED_BYTES.byteLength,
						},
					],
					annotations: {
						"org.opencontainers.image.title": "hello-bindle",
						"org.opencontainers.image.source": "examples/hello-bindle",
						"dev.hobo.wit.world": component.witWorld,
					},
				},
			},
		};
	},
};

// Restore what the runner set, rather than clear it for later files in the worker.
const runnerComponentizeReal = process.env.HOBO_COMPONENTIZE_REAL;
afterEach(() => {
	if (runnerComponentizeReal === undefined)
		delete process.env.HOBO_COMPONENTIZE_REAL;
	else process.env.HOBO_COMPONENTIZE_REAL = runnerComponentizeReal;
});

describe("HOBO_COMPONENTIZE_REAL wiring in runBuild", () => {
	it("fails closed when the real lane is requested but unavailable", async () => {
		process.env.HOBO_COMPONENTIZE_REAL = "1";
		await withSeededProject(async (projectRoot) => {
			const failure = runBuild({
				json: true,
				projectRoot,
				targetRuntime: "wasm",
				sourceDateEpoch: SOURCE_DATE_EPOCH,
				realComponentizeFactory: async () => unavailableReal,
			});

			await expect(failure).rejects.toBeInstanceOf(BuildError);
			await expect(failure).rejects.toMatchObject({
				code: "HOBO_BUILD_COMPONENTIZE_TOOLCHAIN",
			});
			// Fail-closed: no manifest, no silent synthetic fallback.
			await expect(
				access(join(projectRoot, BUILD_MANIFEST_PATH)),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("uses the real lane artifacts when requested and available", async () => {
		process.env.HOBO_COMPONENTIZE_REAL = "1";
		await withSeededProject(async (projectRoot) => {
			const result = await runBuild({
				requireRealComponentize: false,
				json: true,
				projectRoot,
				targetRuntime: "wasm",
				sourceDateEpoch: SOURCE_DATE_EPOCH,
				realComponentizeFactory: async () => fakeReal,
			});

			const hello = result.artifacts.find(
				(artifact) => artifact.service === "hello-bindle",
			);
			expect(hello?.kind).toBe("wasm-component");
			expect(hello?.digest).toBe(FIXED_DIGEST);
			expect(hello?.witWorld).toBe("hobo:examples/hello-bindle@0.1.0");
		});
	});

	it("permits the contract floor only for explicitly selected library fixtures", async () => {
		await withSeededProject(async (projectRoot) => {
			const result = await runBuild({
				requireRealComponentize: false,
				json: true,
				projectRoot,
				targetRuntime: "wasm",
				sourceDateEpoch: SOURCE_DATE_EPOCH,
				realComponentizeFactory: async () => {
					throw new Error("factory must not be probed without the env flag");
				},
			});

			const hello = result.artifacts.find(
				(artifact) => artifact.service === "hello-bindle",
			);
			expect(hello?.kind).toBe("wasm-component");
			expect(hello?.digest).not.toBe(FIXED_DIGEST);
		});
	});
});

describe("adaptRealComponentize", () => {
	it("bridges the real lane onto the ComponentizeFn seam with OCI passthrough", async () => {
		const componentize = adaptRealComponentize(fakeReal);
		const output = await componentize({
			sourceRoot: "/unused",
			sourceDateEpoch: SOURCE_DATE_EPOCH,
		});

		expect(Buffer.isBuffer(output.component.bytes)).toBe(true);
		expect(output.component.digest).toBe(FIXED_DIGEST);
		expect(output.oci?.manifest.layers[0]?.digest).toBe(FIXED_DIGEST);
	});
});

async function withTempProject(
	callback: (projectRoot: string) => Promise<void>,
) {
	const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-real-"));
	try {
		return await callback(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

async function withSeededProject(
	callback: (projectRoot: string) => Promise<void>,
) {
	return withTempProject(async (projectRoot) => {
		await writeBuildFixtureProject(projectRoot);
		await runCodegen({ projectRoot, check: false });
		return callback(projectRoot);
	});
}
