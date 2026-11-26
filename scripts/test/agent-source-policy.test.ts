import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as z from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = join(root, "scripts/agent-source-policy.mts");
const scratch: string[] = [];
const env = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};

afterEach(() => {
	for (const directory of scratch.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-agent-policy-"));
	scratch.push(directory);
	for (const args of [
		["init", "--quiet"],
		[
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--quiet",
			"-m",
			"fixture",
		],
	]) {
		const result = spawnSync("git", args, {
			cwd: directory,
			env,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
	}
	return directory;
}

function runHook(cwd: string) {
	return spawnSync(process.execPath, ["--experimental-strip-types", hook], {
		cwd,
		env,
		encoding: "utf8",
	});
}

describe("agent source policy hook", () => {
	it("accepts a clean edit and reports comments and design artifacts", () => {
		const repository = fixture();
		writeFileSync(
			join(repository, "schema.cue"),
			'endpoint: "https://example.test"\n',
		);
		assert.equal(runHook(repository).status, 0);
		writeFileSync(
			join(repository, "schema.cue"),
			'endpoint: "https://example.test" // explanation\n',
		);
		let result = runHook(repository);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /schema\.cue:1/u);
		writeFileSync(
			join(repository, "schema.cue"),
			'endpoint: "https://example.test"\n',
		);
		mkdirSync(join(repository, ".impeccable"));
		writeFileSync(join(repository, ".impeccable/design.json"), "{}\n");
		result = runHook(repository);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /\.impeccable\/design\.json/u);
	});

	it("fails closed outside a repository", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-agent-policy-no-repo-"));
		scratch.push(directory);
		const result = runHook(directory);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /could not locate the repository/u);
	});

	it("is configured for each repository agent harness", () => {
		const schema = z.object({ hooks: z.record(z.string(), z.unknown()) });
		for (const [file, event] of [
			[".claude/settings.json", "PostToolUse"],
			[".codex/hooks.json", "PostToolUse"],
			[".cursor/hooks.json", "afterFileEdit"],
			[".github/hooks/source-policy.json", "postToolUse"],
		] as const) {
			const config = schema.parse(
				JSON.parse(readFileSync(join(root, file), "utf8")),
			);
			assert.match(
				JSON.stringify(config.hooks[event]),
				/scripts\/agent-source-policy\.mts/u,
			);
		}
		const gemini = schema.parse(
			JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8")),
		);
		const afterTool = z
			.array(
				z
					.object({
						matcher: z.string(),
						hooks: z.array(
							z
								.object({
									command: z.string(),
									timeout: z.number(),
								})
								.loose(),
						),
					})
					.loose(),
			)
			.parse(gemini.hooks.AfterTool);
		const sourceHook = afterTool
			.flatMap((group) =>
				group.hooks.map((hook) => ({ matcher: group.matcher, hook })),
			)
			.find((entry) =>
				entry.hook.command.includes("scripts/agent-source-policy.mts"),
			);
		assert.ok(sourceHook, "Gemini AfterTool must run the source policy");
		assert.equal(sourceHook.matcher, "write_file|replace");
		assert.equal(
			sourceHook.hook.command,
			`node --experimental-strip-types "$(git rev-parse --show-toplevel)/scripts/agent-source-policy.mts" >/dev/null && printf '{}'`,
		);
		assert.equal(sourceHook.hook.timeout, 60_000);
	});

	it("keeps the anti-slop installer consistent with the common comment policy", () => {
		const rule = "anti-slop/require-safety-comment-for-type-assertion";
		const config = readFileSync(join(root, "oxlint.config.ts"), "utf8");
		assert.doesNotMatch(
			config,
			/"anti-slop\/require-safety-comment-for-type-assertion"\s*:\s*"error"/u,
		);
		for (const harness of [".agents", ".claude"]) {
			const skill = readFileSync(
				join(root, harness, "skills/install-anti-slop/SKILL.md"),
				"utf8",
			);
			const sample = skill.match(/```json\s*([\s\S]*?)\s*```/u);
			const recommendedRules = sample?.[1];
			assert.ok(recommendedRules, `${harness} must show the recommended rules`);
			const rules = z
				.record(z.string(), z.string())
				.parse(JSON.parse(recommendedRules));
			assert.equal(rules[rule], undefined);
			assert.equal(rules["anti-slop/no-widen-then-assert"], "error");
		}
	});
});
