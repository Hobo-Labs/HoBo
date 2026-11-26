import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePipeline, parsePipeline } from "@hobo/ci";
import { expect, it } from "vitest";
import { createDaggerBackend } from "../src/backend.js";
import { createLocalDaggerConnection } from "./fixtures/local-engine.js";

it("executes real argv and binary files through the Dagger contract fixture", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "hobo-dagger-local-"));
	try {
		await mkdir(join(workspace, "sub"));
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "local-dagger",
				accountId: "a",
				timeoutSeconds: 30,
				steps: [
					{
						id: "write",
						cwd: "sub",
						argv: [
							process.execPath,
							"-e",
							"require('fs').writeFileSync('../artifact.bin',Buffer.from([0,1,255]));console.log(process.env.STEP)",
						],
						env: { STEP: "first" },
					},
					{
						id: "read",
						cwd: ".",
						argv: [
							process.execPath,
							"-e",
							"if(process.env.STEP)process.exit(9);console.log(require('fs').readFileSync('artifact.bin').length)",
						],
						env: {},
					},
				],
				artifactPaths: ["artifact.bin"],
			}),
		);
		const result = await executePipeline(
			createDaggerBackend({
				sourceDirectory: workspace,
				image: `fixture/image@sha256:${"a".repeat(64)}`,
				connect: async () => createLocalDaggerConnection(workspace),
			}),
			pipeline,
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps.map((step) => step.stdout)).toEqual(["first\n", "3\n"]);
		expect(result.artifacts[0]?.data).toEqual(Uint8Array.from([0, 1, 255]));
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

it("rejects a declared artifact symlink escaping the source workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-link-"));
	const workspace = join(root, "workspace");
	try {
		await mkdir(workspace);
		await writeFile(join(root, "outside.bin"), "outside");
		await symlink(join(root, "outside.bin"), join(workspace, "artifact.bin"));
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "symlink",
				accountId: "a",
				timeoutSeconds: 30,
				steps: [{ id: "noop", argv: ["true"], cwd: ".", env: {} }],
				artifactPaths: ["artifact.bin"],
			}),
		);
		const result = await executePipeline(
			createDaggerBackend({
				sourceDirectory: workspace,
				image: `fixture/image@sha256:${"a".repeat(64)}`,
				connect: async () => createLocalDaggerConnection(workspace),
			}),
			pipeline,
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects an oversized artifact before encoding bytes into SDK output", async () => {
	const outputs: string[] = [];
	const workspace = await mkdtemp(join(tmpdir(), "hobo-dagger-large-"));
	try {
		await writeFile(
			join(workspace, "artifact.bin"),
			new Uint8Array(1024 * 1024 + 1),
		);
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "large-file",
				accountId: "a",
				timeoutSeconds: 30,
				steps: [{ id: "noop", argv: ["true"], cwd: ".", env: {} }],
				artifactPaths: ["artifact.bin"],
			}),
		);
		const result = await executePipeline(
			createDaggerBackend({
				sourceDirectory: workspace,
				image: `fixture/image@sha256:${"a".repeat(64)}`,
				connect: async () =>
					createLocalDaggerConnection(workspace, (argv, output) => {
						if (argv[3] === "hobo-artifact") outputs.push(output.stdout);
					}),
			}),
			pipeline,
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
		expect(outputs).toEqual([""]);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
