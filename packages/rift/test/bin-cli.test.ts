import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE = "../src/bin/hobo-rift.js";

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

let roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-rift-cli-"));
	roots.push(root);
	return root;
}

async function run(argv: readonly string[]): Promise<RunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const savedArgv = process.argv;
	const savedExitCode = process.exitCode;

	process.argv = ["node", "hobo-rift", ...argv];
	process.exitCode = undefined;

	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout.push(String(chunk));
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);

	let exitCode = 0;
	try {
		vi.resetModules();
		await import(MODULE);
		exitCode = process.exitCode === undefined ? 0 : Number(process.exitCode);
	} catch (error) {
		if (!(error instanceof ExitSignal)) throw error;
		exitCode = error.code;
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
		process.argv = savedArgv;
		process.exitCode = savedExitCode;
	}

	return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

beforeEach(() => {
	roots = [];
});

afterEach(async () => {
	for (const root of roots) {
		await rm(root, { recursive: true, force: true });
	}
	roots = [];
	vi.restoreAllMocks();
});

describe("verb resolution", () => {
	it("finds the verb after a value-taking flag", async () => {
		const root = await makeRoot();
		const result = await run(["--root", root, "init"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("initialized");
	});

	it("finds the verb before the flags too", async () => {
		const root = await makeRoot();
		const result = await run(["init", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("initialized");
	});

	it("skips only the flags that actually take a value", async () => {
		const root = await makeRoot();
		const result = await run(["--json", "capability", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("defaults to help with exit 0 when no verb is present", async () => {
		const result = await run([]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("exits 2 for an unrecognised verb while still printing help", async () => {
		const result = await run(["frobnicate"]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("exits 0 for an explicit help request", async () => {
		const result = await run(["help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hobo-rift — virtual worktrees");
	});

	it("lists every verb in the help text", async () => {
		const result = await run(["help"]);
		for (const listed of [
			"capability",
			"init",
			"create",
			"list",
			"remove",
			"exec",
			"repair",
			"prune",
		]) {
			expect(result.stdout).toContain(listed);
		}
	});
});

describe("capability", () => {
	it("reports a tier and a reason in human form", async () => {
		const root = await makeRoot();
		const result = await run(["capability", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/\S+ · \S/u);
	});

	it("emits a parseable record under --json, including the contract", async () => {
		const root = await makeRoot();
		const result = await run(["capability", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			tier: string;
			reason: string;
			isolatesInPlaceWrites: boolean;
			contract: unknown;
		};
		expect(typeof parsed.tier).toBe("string");
		expect(typeof parsed.reason).toBe("string");
		expect(typeof parsed.isolatesInPlaceWrites).toBe("boolean");
		expect(parsed.contract).toBeDefined();
	});

	it("warns in the human line when in-place writes reach the source", async () => {
		const root = await makeRoot();
		const human = await run(["capability", "--root", root]);
		const json = JSON.parse(
			(await run(["capability", "--root", root, "--json"])).stdout,
		) as { isolatesInPlaceWrites: boolean };
		if (json.isolatesInPlaceWrites) {
			expect(human.stdout).not.toContain("WARNING");
		} else {
			expect(human.stdout).toContain(
				"WARNING: in-place writes reach the source",
			);
		}
	});
});

describe("init", () => {
	it("reports initialized the first time and already registered after", async () => {
		const root = await makeRoot();
		expect((await run(["init", "--root", root])).stdout).toContain(
			"initialized",
		);
		const second = await run(["init", "--root", root]);
		expect(second.stdout).toContain("already registered");
		expect(second.exitCode).toBe(0);
	});

	it("emits the result record under --json", async () => {
		const root = await makeRoot();
		const result = await run(["init", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			created: boolean;
			root: string;
		};
		expect(parsed.created).toBe(true);
		expect(parsed.root).toBe(root);
	});
});

describe("create", () => {
	it("prints exactly the workspace path on stdout", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["create", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(result.stdout.trim()).toContain("ws-a");
	});

	it("emits the whole workspace record under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"create",
			"--root",
			root,
			"--name",
			"ws-a",
			"--json",
		]);
		const parsed = JSON.parse(result.stdout) as {
			name: string;
			path: string;
			tier: string;
		};
		expect(parsed.name).toBe("ws-a");
		expect(parsed.path).toContain("ws-a");
	});

	it("generates a name when none is given", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["create", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/ws-\d+/u);
	});

	it("exits 1 with the reason on stderr when creation fails", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["create", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr.length).toBeGreaterThan(0);
	});
});

describe("list", () => {
	it("reports nothing for an empty root", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["list", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});

	it("prints one tab-separated line per workspace", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		await run(["create", "--root", root, "--name", "ws-b"]);
		const result = await run(["list", "--root", root]);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line.split("\t")).toHaveLength(3);
		}
	});

	it("carries the registry and the parked directories under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["list", "--root", root, "--json"]);
		const parsed = JSON.parse(result.stdout) as {
			workspaces: Array<{ name: string }>;
			debris: string[];
		};
		expect(parsed.workspaces.map((w) => w.name)).toEqual(["ws-a"]);
		expect(parsed.debris).toEqual([]);
	});
});

describe("prune", () => {
	it("says so when there is nothing parked", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["prune", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no parked directories");
	});

	it("emits the removed list under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["prune", "--root", root, "--json"]);
		expect(
			(JSON.parse(result.stdout) as { removed: string[] }).removed,
		).toEqual([]);
	});
});

describe("repair", () => {
	it("rebuilds the registry and reports the count", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["repair", "--root", root]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("registry now lists 1 workspace(s)");
	});

	it("emits the rebuilt registry under --json", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["repair", "--root", root, "--json"]);
		expect(
			(JSON.parse(result.stdout) as { workspaces: unknown[] }).workspaces,
		).toEqual([]);
	});
});

describe("remove", () => {
	it("exits 2 with a message when --name is missing", async () => {
		const result = await run(["remove", "--root", await makeRoot()]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("remove needs --name");
	});

	it("removes an existing workspace and exits 0", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["remove", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("removed ws-a");
		expect((await run(["list", "--root", root])).stdout.trim()).toBe("");
	});

	it("exits 1 for a workspace that was never there", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run(["remove", "--root", root, "--name", "ghost"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("no workspace named ghost");
	});

	it("reports removed:false under --json rather than an empty document", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"remove",
			"--root",
			root,
			"--name",
			"ghost",
			"--json",
		]);
		const parsed = JSON.parse(result.stdout) as {
			removed: boolean;
			name: string;
		};
		expect(parsed.removed).toBe(false);
		expect(parsed.name).toBe("ghost");
		expect(result.exitCode).toBe(1);
	});
});

describe("exec", () => {
	it("exits 2 when neither -- nor --shell was given", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["exec", "--root", root, "--name", "ws-a"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("exec needs --name");
	});

	it("exits 2 when --name is missing", async () => {
		const root = await makeRoot();
		const result = await run(["exec", "--root", root, "--", "true"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("exec needs --name");
	});

	it("exits 2 for an empty argv vector after --", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run(["exec", "--root", root, "--name", "ws-a", "--"]);
		expect(result.exitCode).toBe(2);
	});

	it("exits 1 rather than falling back to the source for an unknown workspace", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ghost",
			"--",
			"true",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no workspace named ghost");
	});

	it("quotes each element of the argv vector under --print-cmd", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"echo",
			"two words",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("two words");
		expect(result.stdout).toMatch(/'two words'|"two words"/u);
	});

	it("neutralises shell metacharacters in the vector", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"echo",
			"; rm -rf /",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/'; rm -rf \/'|"; rm -rf \/"/u);
	});

	it("passes a --shell snippet through unquoted", () => {
		return makeRoot().then(async (root) => {
			await run(["init", "--root", root]);
			await run(["create", "--root", root, "--name", "ws-a"]);
			const result = await run([
				"exec",
				"--root",
				root,
				"--name",
				"ws-a",
				"--print-cmd",
				"--shell",
				"echo a && echo b",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("echo a && echo b");
		});
	});

	it("treats a --name after -- as the inner command's argument", async () => {
		const root = await makeRoot();
		await run(["init", "--root", root]);
		await run(["create", "--root", root, "--name", "ws-a"]);
		const result = await run([
			"exec",
			"--root",
			root,
			"--name",
			"ws-a",
			"--print-cmd",
			"--",
			"some-tool",
			"--name",
			"inner",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("inner");
		expect(result.stdout).toContain("ws-a");
	});
});
