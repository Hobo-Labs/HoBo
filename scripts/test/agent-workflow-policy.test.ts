import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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

test("draft and agent guidance requires implementation instead of planning artifacts", () => {
	for (const harness of [".agents", ".claude"]) {
		for (const reference of ["SKILL.md", "LOGIC.md", "UI.md"]) {
			const prototype = readFileSync(
				resolve(harness, "skills/prototype", reference),
				"utf8",
			);
			assert.match(prototype, /AGENTS\.md/u);
			assert.doesNotMatch(
				prototype,
				/leave a `NOTES\.md`|placeholder so they/iu,
			);
		}
		const triage = readFileSync(
			resolve(harness, "skills/triage/SKILL.md"),
			"utf8",
		);
		assert.match(
			triage,
			/Only change tracker state or send comments when the user explicitly requests/u,
		);
		for (const retired of ["AGENT-BRIEF.md", "OUT-OF-SCOPE.md"]) {
			assert.equal(
				existsSync(resolve(harness, "skills/triage", retired)),
				false,
			);
		}
		const draft = readFileSync(
			resolve(harness, "skills/draft/SKILL.md"),
			"utf8",
		);
		assert.match(draft, /Complete the requested behavior/u);
		assert.doesNotMatch(draft, /scaffold from|waivers require an ADR/iu);
		for (const layer of [
			"technical-proofs",
			"exp-proofs",
			"epic-proofs",
			"projects",
		]) {
			const reference = readFileSync(
				resolve(harness, `skills/draft/references/${layer}/process.md`),
				"utf8",
			);
			assert.doesNotMatch(
				reference,
				/scaffold from|ADRs? (?:is|are) (?:required|mandatory)/iu,
			);
		}
		const architecture = readFileSync(
			resolve(harness, "skills/improve-codebase-architecture/SKILL.md"),
			"utf8",
		);
		assert.match(architecture, /implement the requested refactor/u);
		assert.equal(
			existsSync(
				resolve(harness, "skills/improve-codebase-architecture/HTML-REPORT.md"),
			),
			false,
		);
	}
	for (const name of ["implementer", "reviewer"]) {
		const agent = readFileSync(resolve(`.claude/agents/${name}.md`), "utf8");
		assert.match(agent, /AGENTS\.md/u);
		assert.doesNotMatch(
			agent,
			/\.sdlc\/report\.json|never edit shared files/iu,
		);
	}
	for (const entry of globSync("src/draft/_templates/**/*")) {
		if (!statSync(entry).isFile()) continue;
		assert.doesNotMatch(
			readFileSync(entry, "utf8"),
			/__SLUG__|replace with the real|assert\.ok\(true/iu,
			entry,
		);
	}
});
