import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("agent setup preserves existing harness instructions and checked-in skills", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-agent-setup-"));
	try {
		const scripts = join(directory, "scripts");
		const binaries = join(directory, "bin");
		mkdirSync(scripts);
		mkdirSync(binaries);
		copyFileSync(
			resolve("scripts/setup-agent-tools.sh"),
			join(scripts, "setup-agent-tools.sh"),
		);
		for (const name of [".github", ".windsurf", ".clinerules", ".opencode"])
			mkdirSync(join(directory, name));
		const instructions = join(directory, ".github", "copilot-instructions.md");
		writeFileSync(instructions, "preserve repository policy\n");
		for (const name of [".windsurf", ".clinerules", ".opencode"])
			writeFileSync(join(directory, name, "sentinel"), "keep\n");
		const log = join(directory, "npx.log");
		for (const name of [
			"tgrep",
			"rtk",
			"serena",
			"headroom",
			"gh",
			"pnpm",
			"mkdir",
			"npx",
		]) {
			const file = join(binaries, name);
			writeFileSync(
				file,
				name === "npx"
					? '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_AGENT_INSTALL_LOG"\n'
					: "#!/bin/sh\nexit 0\n",
			);
			chmodSync(file, 0o755);
		}
		const result = spawnSync(
			"bash",
			[
				join(scripts, "setup-agent-tools.sh"),
				"--agent",
				"codex",
				"--no-gbrain",
				"--no-skillopt",
			],
			{
				cwd: directory,
				env: {
					...process.env,
					PATH: `${binaries}:/usr/bin:/bin`,
					TASK_AGENT_INSTALL_LOG: log,
				},
				encoding: "utf8",
				timeout: 15000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(instructions, "utf8"),
			"preserve repository policy\n",
		);
		for (const name of [".windsurf", ".clinerules", ".opencode"])
			assert.ok(existsSync(join(directory, name, "sentinel")));
		const calls = readFileSync(log, "utf8");
		assert.match(calls, /DietrichGebert\/ponytail/u);
		assert.doesNotMatch(calls, /mattpocock\/skills/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
