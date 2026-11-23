import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
	new URL("../agent_completion_hook.py", import.meta.url),
);
const python = process.platform === "win32" ? "python" : "python3";

function observe(prompt: string, active: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-completion-test-"));
	const state = join(
		directory,
		`hobo-agent-completion-${process.getuid?.() ?? "user"}`,
	);
	const session = "test-session";
	const token = createHash("sha256").update(session).digest("hex");
	const env = { ...process.env, TMPDIR: directory };
	try {
		mkdirSync(state, { mode: 0o700 });
		const record = spawnSync(python, [hook, "record", state, token, "ready"], {
			encoding: "utf8",
			env,
		});
		assert.equal(record.status, 0, record.stderr);
		const observed = spawnSync(python, [hook, "prompt"], {
			encoding: "utf8",
			env,
			input: JSON.stringify({ session_id: session, prompt }),
		});
		assert.equal(observed.status, 0, observed.stderr);
		const ready = existsSync(join(state, `${token}.ready`));
		const stopped = spawnSync(python, [hook, "stop"], {
			encoding: "utf8",
			env,
			input: JSON.stringify({ session_id: session, stop_hook_active: active }),
		});
		assert.equal(stopped.status, 0, stopped.stderr);
		return { ready, output: stopped.stdout };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("completion hook explicit stops", () => {
	it("clears ready work for requests to stop the current activity", () => {
		for (const prompt of [
			"Stop babysitting these PRs.",
			"Please stop merging PRs.",
			"Stop watching this repository.",
			"Stop working on the current branch now.",
			"Pause monitoring these PRs until tomorrow.",
		]) {
			const result = observe(prompt, false);
			assert.equal(result.ready, false, prompt);
			assert.doesNotMatch(result.output, /"decision":\s*"block"/u, prompt);
		}
	});

	it("keeps ready work for negated, deferred, and quoted stop text", () => {
		for (const prompt of [
			"Do not stop merging PRs.",
			"Stop after the tests finish.",
			'The log says "stop merging PRs". Continue.',
		]) {
			const result = observe(prompt, true);
			assert.equal(result.ready, true, prompt);
			assert.match(result.output, /"decision":\s*"block"/u, prompt);
		}
	});

	it("clears the old task and reviews an explicit replacement", () => {
		const result = observe("Stop merging PRs and review the build.", false);
		assert.equal(result.ready, false);
		assert.match(result.output, /"decision":\s*"block"/u);
	});
});
