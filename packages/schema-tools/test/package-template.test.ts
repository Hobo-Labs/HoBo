import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.js";
import { makeTempRepo, removeTempRepo } from "./support/temp-workspace.js";

test("cross-file ESM records use the package template in generation and drift checks", async () => {
	const root = await makeTempRepo();
	try {
		const models = join(root, "packages/hosting/data-models");
		await mkdir(models, { recursive: true });
		await writeFile(
			join(root, "packages/hosting/package.json"),
			JSON.stringify({ name: "@test/hosting", type: "module" }),
		);
		await writeFile(join(models, "buf.yaml"), "version: v2\n");
		await writeFile(
			join(models, "buf.gen.yaml"),
			"version: v2\nplugins:\n  - local: protoc-gen-es\n    out: .\n    opt:\n      - target=ts\n      - import_extension=js\n",
		);
		await writeFile(
			join(models, "budget.proto"),
			'syntax = "proto3"; package hosting.v1; message Budget { string id = 1; }\n',
		);
		await writeFile(
			join(models, "transition.proto"),
			'syntax = "proto3"; package hosting.v1; import "budget.proto"; message Transition { Budget budget = 1; }\n',
		);
		const generated = await runCli([], root);
		expect(generated.exitCode, generated.stderr).toBe(0);
		const text = await readFile(
			join(root, "packages/hosting/src/_generated/transition_pb.ts"),
			"utf8",
		);
		expect(text).toContain('from "./budget_pb.js"');
		const checked = await runCli(["--check"], root);
		expect(checked.exitCode, checked.stderr || checked.stdout).toBe(0);
	} finally {
		await removeTempRepo(root);
	}
}, 60_000);
