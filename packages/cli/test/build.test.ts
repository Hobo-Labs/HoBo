import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	BUILD_MANIFEST_PATH,
	createBuildCommand,
	createHoboCli,
	writeBuildFixtureProject,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

function createFixtureCli() {
	return createHoboCli({
		commands: { build: createBuildCommand({ requireRealComponentize: false }) },
	});
}

describe("hobo build", () => {
	it("emits wasm and OCI fallback artifacts with JSON digests", async () => {
		await withSeededBuildProject(async (projectRoot) => {
			const result = await createFixtureCli().run(["build", "--json"], {
				cwd: projectRoot,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");

			const envelope = JSON.parse(result.stdout);
			expect(envelope.ok).toBe(true);
			expect(envelope.verb).toBe("build");
			expect(envelope.data.manifest).toBe(BUILD_MANIFEST_PATH);
			expect(envelope.data.artifacts).toHaveLength(2);

			const artifacts = byService(envelope.data.artifacts);
			expect(artifacts.get("hello-bindle")?.kind).toBe("wasm-component");
			expect(artifacts.get("hello-bindle")?.digest).toMatch(
				/^sha256:[a-f0-9]{64}$/,
			);
			expect(artifacts.get("legacy-worker")?.kind).toBe("oci-container");
			expect(artifacts.get("legacy-worker")?.fallbackReason).toBe(
				"unsupported-language: python",
			);

			const manifest = JSON.parse(
				await readFile(join(projectRoot, BUILD_MANIFEST_PATH), "utf8"),
			);
			expect(manifest.artifacts).toEqual(envelope.data.artifacts);
		});
	});

	it("digests are stable on repeat and across clean checkouts", async () => {
		let cleanCheckoutArtifacts: JsonValue;

		await withSeededBuildProject(async (projectRoot) => {
			const first = JSON.parse(
				(
					await createFixtureCli().run(["build", "--json"], {
						cwd: projectRoot,
					})
				).stdout,
			);
			const second = JSON.parse(
				(
					await createFixtureCli().run(["build", "--json"], {
						cwd: projectRoot,
					})
				).stdout,
			);

			expect(second.data.artifacts).toEqual(first.data.artifacts);
			cleanCheckoutArtifacts = first.data.artifacts;
		});

		await withSeededBuildProject(async (projectRoot) => {
			const fresh = JSON.parse(
				(
					await createFixtureCli().run(["build", "--json"], {
						cwd: projectRoot,
					})
				).stdout,
			);
			expect(fresh.data.artifacts).toEqual(cleanCheckoutArtifacts);
		});
	});

	it("fails on stale _generated tree with regeneration hint before build output", async () => {
		await withSeededBuildProject(async (projectRoot) => {
			await writeFile(
				join(projectRoot, "src/_generated/hooks.d.ts"),
				"stale generated file\n",
			);

			const result = await createFixtureCli().run(["build", "--json"], {
				cwd: projectRoot,
			});
			const envelope = JSON.parse(result.stdout);

			expect(result.exitCode).toBe(1);
			expect(envelope.ok).toBe(false);
			expect(envelope.code).toBe("HOBO_BUILD_CODEGEN_DRIFT");
			expect(envelope.message).toMatch(/hobo codegen/);
			await expect(
				access(join(projectRoot, BUILD_MANIFEST_PATH)),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	it("still refuses a stale tree when the requested runtime is valid", async () => {
		await withSeededBuildProject(async (projectRoot) => {
			await writeFile(
				join(projectRoot, "src/_generated/hooks.d.ts"),
				"stale generated file\n",
			);

			const result = await createFixtureCli().run(
				["build", "--runtime", "wasm", "--json"],
				{ cwd: projectRoot },
			);

			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: false,
				code: "HOBO_BUILD_CODEGEN_DRIFT",
			});
			await expect(
				access(join(projectRoot, BUILD_MANIFEST_PATH)),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("refuses an empty service declaration before checking the generated tree", async () => {
		await withSeededBuildProject(async (projectRoot) => {
			await writeFile(
				join(projectRoot, "src/_generated/hooks.d.ts"),
				"stale generated file\n",
			);
			const bindlePath = join(projectRoot, "hobo.bindle.json");
			const bindle = JSON.parse(await readFile(bindlePath, "utf8"));
			await writeFile(bindlePath, JSON.stringify({ ...bindle, services: [] }));

			const result = await createFixtureCli().run(["build", "--json"], {
				cwd: projectRoot,
			});

			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: false,
				code: "HOBO_BUILD_NO_SERVICES",
			});
		});
	});

	it("names service and cause on componentize failure without writing a manifest", async () => {
		await withTempBuildProject(async (projectRoot) => {
			await writeBuildFixtureProject(projectRoot, {
				services: [
					{
						name: "aaa-legacy-worker",
						language: "python",
						runtime: "container",
						sourceRoot: "services/legacy-worker",
						entrypoint: "services/legacy-worker/src/app.py",
					},
					{
						name: "hello-bindle",
						language: "ts",
						runtime: "wasm",
						sourceRoot: "services/hello-bindle",
						entrypoint: "services/hello-bindle/src/service.ts",
					},
				],
				helloSource:
					'export const health = () => ({ body: "bad", nonce: Date.now() });\n',
			});
			await seedGeneratedTree(projectRoot);

			const result = await createFixtureCli().run(["build", "--json"], {
				cwd: projectRoot,
			});
			const envelope = JSON.parse(result.stdout);

			expect(result.exitCode).toBe(1);
			expect(envelope.code).toBe("HOBO_BUILD_COMPONENTIZE_FAILED");
			expect(envelope.data.detail?.service).toBe("hello-bindle");
			expect(String(envelope.data.detail?.cause)).toMatch(
				/nondeterministic_source/,
			);
			await expect(
				access(
					join(projectRoot, ".hobo/build/artifacts/aaa-legacy-worker.oci.json"),
				),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				access(join(projectRoot, BUILD_MANIFEST_PATH)),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	it("forces OCI fallback when HOBO_RUNTIME=container", async () => {
		const previous = process.env.HOBO_RUNTIME;
		process.env.HOBO_RUNTIME = "container";
		try {
			await withSeededBuildProject(async (projectRoot) => {
				const result = await createFixtureCli().run(["build", "--json"], {
					cwd: projectRoot,
				});
				expect(result.exitCode).toBe(0);
				const artifacts = byService(JSON.parse(result.stdout).data.artifacts);
				expect(artifacts.get("hello-bindle")?.kind).toBe("oci-container");
				expect(artifacts.get("hello-bindle")?.fallbackReason).toBe(
					"target-runtime: container",
				);
				expect(artifacts.get("legacy-worker")?.kind).toBe("oci-container");
			});
		} finally {
			if (previous === undefined) {
				delete process.env.HOBO_RUNTIME;
			} else {
				process.env.HOBO_RUNTIME = previous;
			}
		}
	});

	it("records declared-runtime fallback for wasm-capable services", async () => {
		await withTempBuildProject(async (projectRoot) => {
			await writeBuildFixtureProject(projectRoot, {
				services: [
					{
						name: "queue-worker",
						language: "ts",
						runtime: "container",
						sourceRoot: "services/queue-worker",
						entrypoint: "services/queue-worker/src/service.ts",
					},
				],
			});
			await seedGeneratedTree(projectRoot);

			const result = await createFixtureCli().run(["build", "--json"], {
				cwd: projectRoot,
			});
			const artifacts = byService(JSON.parse(result.stdout).data.artifacts);

			expect(result.exitCode).toBe(0);
			expect(artifacts.get("queue-worker")?.kind).toBe("oci-container");
			expect(artifacts.get("queue-worker")?.fallbackReason).toBe(
				"declared-runtime: container",
			);
		});
	});
});

async function withSeededBuildProject(
	callback: (projectRoot: string) => Promise<void>,
) {
	return withTempBuildProject(async (projectRoot) => {
		await writeBuildFixtureProject(projectRoot);
		await seedGeneratedTree(projectRoot);
		return callback(projectRoot);
	});
}

async function withTempBuildProject(
	callback: (projectRoot: string) => Promise<void>,
) {
	const projectRoot = await mkdtemp(join(tmpdir(), "hobo-build-cli-"));
	try {
		return await callback(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

async function seedGeneratedTree(projectRoot: string) {
	await runCodegen({ projectRoot, check: false });
}

function byService(artifacts: Array<{ service: string }>) {
	return new Map(artifacts.map((artifact) => [artifact.service, artifact]));
}
