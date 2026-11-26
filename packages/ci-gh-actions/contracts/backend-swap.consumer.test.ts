import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePipeline, type PipelineBackend, parsePipeline } from "@hobo/ci";
import { createCloudflareBackend } from "@hobo/ci-cf";
import { createDaggerBackend } from "@hobo/ci-dagger";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { NativeContext } from "../../ci-cf/test/fixtures/native-context.js";
import { createLocalDaggerConnection } from "../../ci-dagger/test/fixtures/local-engine.js";
import { createActionsBackend } from "../src/actions-backend.js";

const Case = z.object({
	name: z.string(),
	steps: z.array(z.json()),
	artifactPaths: z.array(z.string()),
	expectedStatus: z.enum(["succeeded", "failed"]),
	expectedExitCodes: z.array(z.number()),
	expectedStdout: z.array(z.string()),
	expectedStderr: z.array(z.string()),
	expectedArtifact: z.string(),
});
const cases = z
	.array(Case)
	.parse(
		JSON.parse(
			await readFile(
				new URL("./cases/portable-pipelines.json", import.meta.url),
				"utf8",
			),
		),
	);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function bound(kind: PipelineBackend["kind"]) {
	const workspace = await mkdtemp(join(tmpdir(), "hobo-ci-swap-"));
	directories.push(workspace);
	await writeFile(join(workspace, "seed.txt"), "source seed\n");
	await writeFile(join(workspace, "tracked-delete.txt"), "delete me\n");
	let backend: PipelineBackend;
	if (kind === "gh-actions") backend = createActionsBackend({ workspace });
	else if (kind === "dagger")
		backend = createDaggerBackend({
			sourceDirectory: workspace,
			image: `example.test/toolchain@sha256:${"a".repeat(64)}`,
			connect: async () => createLocalDaggerConnection(workspace),
		});
	else {
		const native = new NativeContext(workspace);
		function overlay(
			runner: typeof native.context.runner,
		): typeof native.context.runner {
			return async (request) => {
				// The pinned SDK overlays tracked checkout files before every chained runner.
				await writeFile(join(workspace, "seed.txt"), "source seed\n");
				await writeFile(join(workspace, "tracked-delete.txt"), "delete me\n");
				const result = await runner(request);
				return { ...result, runner: overlay(result.runner) };
			};
		}
		backend = createCloudflareBackend({
			context: { runner: overlay(native.context.runner) },
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
	}
	return { workspace, backend };
}

describe.each([
	"gh-actions",
	"dagger",
	"cf",
] as const)("same portable pipeline through %s", (kind) => {
	for (const row of cases)
		it(row.name, async () => {
			const { workspace, backend } = await bound(kind);
			const pipeline = parsePipeline(
				JSON.stringify({
					id: row.name,
					accountId: "tenant",
					steps: row.steps,
					artifactPaths: row.artifactPaths,
					timeoutSeconds: 10,
				}),
			);
			const result = await executePipeline(backend, pipeline);
			expect(result.backend).toBe(kind);
			expect(result.status).toBe(row.expectedStatus);
			expect(result.steps.map((step) => step.exitCode)).toEqual(
				row.expectedExitCodes,
			);
			expect(result.steps.map((step) => step.stdout)).toEqual(
				row.expectedStdout,
			);
			expect(result.steps.map((step) => step.stderr)).toEqual(
				row.expectedStderr,
			);
			if (row.artifactPaths.length) {
				expect(result.artifacts).toHaveLength(1);
				expect(new TextDecoder().decode(result.artifacts[0]?.data)).toBe(
					row.expectedArtifact,
				);
				expect(result.artifacts[0]?.sha256).toBe(
					createHash("sha256").update(row.expectedArtifact).digest("hex"),
				);
			}
			await expect(readFile(join(workspace, "forbidden"))).rejects.toThrow();
		});
	it("acknowledges cancellation before the bound process can produce later side effects", async () => {
		const { workspace, backend } = await bound(kind);
		const controller = new AbortController();
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "cancel",
				accountId: "tenant",
				steps: [
					{
						id: "wait",
						argv: ["sh", "-c", "sleep 1; printf leaked > forbidden"],
						cwd: ".",
						env: {},
					},
				],
				timeoutSeconds: 10,
			}),
		);
		const timer = setTimeout(() => controller.abort(), 80);
		try {
			const result = await executePipeline(backend, pipeline, {
				signal: controller.signal,
			});
			expect(result.status).toBe("cancelled");
			await new Promise<void>((resolve) => setTimeout(resolve, 1100));
			await expect(readFile(join(workspace, "forbidden"))).rejects.toThrow();
		} finally {
			clearTimeout(timer);
		}
	});
});
