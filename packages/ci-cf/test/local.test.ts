import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePipeline } from "@hobo/ci/execution";
import { expect, it } from "vitest";
import pipelineJson from "../examples/local/pipeline.json" with {
	type: "json",
};
import {
	localConfig,
	localParams,
	localWorkerName,
} from "../src/local-config.js";
import { assertLocalPreparation } from "../src/local-source.js";

const pipeline = parsePipeline(JSON.stringify(pipelineJson));
const sha = "1111111111111111111111111111111111111111";

it("keeps local configuration reviewable and has no remote bindings or credentials", async () => {
	const config = localConfig(pipeline, sha, "local-review");
	await expect(
		JSON.stringify(
			{ ...config, main: "<package>/examples/local/index.ts" },
			null,
			2,
		),
	).toMatchFileSnapshot("__snapshots__/local-config.json");
	expect(() => localConfig(pipeline, "HEAD", "local-review")).toThrow(
		"resolved Git commit",
	);
	expect(localParams(sha, "local-review")).toMatchObject({
		owner: "local",
		repo: "workspace",
		sha,
	});
});

it("rejects a stale dev session even when source SHA is unchanged", () => {
	const params = localParams(sha, "local-new");
	expect(() => assertLocalPreparation(params, sha, "local-new")).not.toThrow();
	expect(() => assertLocalPreparation(params, sha, "local-old")).toThrow(
		"stop dev and restart",
	);
	expect(() =>
		assertLocalPreparation(params, "2".repeat(40), "local-new"),
	).toThrow();
});

it("prepares a frozen Git revision without uncommitted or ignored host files", () => {
	const source = mkdtempSync(join(tmpdir(), "hobo-ci-cf-source-"));
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	let prepared: string | undefined;
	try {
		const env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([name]) => !name.startsWith("GIT_"),
				),
			),
			GIT_DIR: join(source, ".git"),
			GIT_WORK_TREE: source,
			GIT_INDEX_FILE: join(source, ".git/index"),
		};
		execFileSync("git", ["init", "-q", source], { env });
		writeFileSync(join(source, "tracked.txt"), "committed\n");
		execFileSync("git", ["-C", source, "add", "tracked.txt"], { env });
		execFileSync(
			"git",
			[
				"-C",
				source,
				"-c",
				"user.name=Local Test",
				"-c",
				"user.email=local@example.test",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"source",
			],
			{ env },
		);
		writeFileSync(join(source, "tracked.txt"), "uncommitted\n");
		writeFileSync(join(source, "untracked-secret"), "excluded\n");
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"scripts/local.ts",
				"prepare",
				"--source",
				source,
				"--work-root",
				join(source, "work"),
				"--pipeline",
				join(packageRoot, "examples/local/pipeline.json"),
			],
			{
				cwd: packageRoot,
				encoding: "utf8",
				// Reproduce a launcher called by a hook in a different repository.
				env: {
					...process.env,
					GIT_DIR: join(packageRoot, "../../.git"),
					GIT_WORK_TREE: resolve(packageRoot, "../.."),
					GIT_INDEX_FILE: join(packageRoot, "../../.git/index"),
				},
			},
		);
		prepared = output.split("\n")[0]?.split(" in ")[1];
		if (!prepared) throw new Error("prepare did not report its work directory");
		expect(
			execFileSync(
				"tar",
				["-xOzf", join(prepared, "source.tar.gz"), "source/tracked.txt"],
				{ encoding: "utf8" },
			),
		).toBe("committed\n");
		expect(
			execFileSync("tar", ["-tzf", join(prepared, "source.tar.gz")], {
				encoding: "utf8",
			}),
		).not.toContain("untracked-secret");
		expect(readFileSync(join(prepared, "Dockerfile"), "utf8")).toContain(
			"COPY source.tar.gz /opt/hobo-ci/source.tar.gz",
		);
		const config = JSON.parse(
			readFileSync(join(prepared, "wrangler.jsonc"), "utf8"),
		);
		expect(parsePipeline(config.vars.HOBO_PIPELINE_JSON)).toEqual(pipeline);
		expect(config.no_bundle).toBe(true);
		expect(config.main).toBe(join(prepared, "worker/index.js"));
		expect(readFileSync(config.main, "utf8").length).toBeGreaterThan(1000);
	} finally {
		rmSync(source, { recursive: true, force: true });
		if (prepared) rmSync(prepared, { recursive: true, force: true });
	}
}, 30000);

it("preserves case-sensitive preparation ownership in lowercase Worker names", () => {
	expect(localWorkerName("local-AbCdEf")).not.toBe(
		localWorkerName("local-abcdef"),
	);
});
