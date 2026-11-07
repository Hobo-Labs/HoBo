import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { isolateTurboEnv } from "./isolated-turbo-env.js";

isolateTurboEnv();
const require = createRequire(import.meta.url);
const cli = fileURLToPath(new URL("../src/turbo-ci-cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(tagged: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), "hobo-turbo-cli-"));
	roots.push(cwd);
	await mkdir(join(cwd, "packages/web"), { recursive: true });
	await mkdir(join(cwd, "node_modules"));
	await symlink(
		dirname(dirname(require.resolve("turbo/bin/turbo"))),
		join(cwd, "node_modules/turbo"),
		"dir",
	);
	await writeFile(
		join(cwd, "package.json"),
		JSON.stringify({
			name: "fixture",
			private: true,
			packageManager: "pnpm@10.33.4",
		}),
	);
	await writeFile(
		join(cwd, "pnpm-workspace.yaml"),
		"packages:\n  - packages/*\n",
	);
	await writeFile(
		join(cwd, "turbo.json"),
		JSON.stringify({ tasks: { test: { tags: tagged ? ["ci"] : [] } } }),
	);
	await writeFile(
		join(cwd, "packages/web/package.json"),
		JSON.stringify({
			name: "web",
			scripts: {
				test: "node -e \"process.on('SIGINT',()=>{});require('node:fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},100)\"",
			},
		}),
	);
	return cwd;
}

function start(cwd: string, args: string[]) {
	const child = spawn(
		process.execPath,
		["--import", require.resolve("tsx"), cli, "--cwd", cwd, ...args],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const stdout: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.resume();
	const closed = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => done({ code, signal }));
	});
	return {
		child,
		closed,
		stdout: () => Buffer.concat(stdout).toString("utf8"),
	};
}

function killFixture(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		expect(error).toMatchObject({ code: "ESRCH" });
	}
}

it("prints explicit empty arrays in a successful empty dry run", async () => {
	const cwd = await fixture(false);
	const command = start(cwd, ["--dry-run"]);
	expect(await command.closed).toEqual({ code: 0, signal: null });
	expect(JSON.parse(command.stdout())).toEqual({ taskIds: [], runArgs: [] });
	expect(existsSync(join(cwd, "packages/web/pid.txt"))).toBe(false);
});

it("keeps handling repeated interrupts until Turbo has stopped its tasks", async () => {
	const cwd = await fixture(true);
	const command = start(cwd, []);
	const pidFile = join(cwd, "packages/web/pid.txt");
	let taskPid: number | undefined;
	try {
		const deadline = Date.now() + 10_000;
		while (!existsSync(pidFile) && Date.now() < deadline)
			await new Promise((done) => setTimeout(done, 25));
		const runningPid = Number(await readFile(pidFile, "utf8"));
		taskPid = runningPid;
		command.child.kill("SIGINT");
		await new Promise((done) => setTimeout(done, 50));
		command.child.kill("SIGINT");
		expect(await command.closed).toEqual({ code: 1, signal: null });
		// A container's PID 1 may retain an already-killed orphan as a zombie.
		const status = spawnSync("ps", ["-p", String(runningPid), "-o", "stat="], {
			encoding: "utf8",
		});
		expect(status.error).toBeUndefined();
		expect(status.stdout.trim()).toMatch(/^(?:Z\S*)?$/);
	} finally {
		command.child.kill("SIGKILL");
		if (taskPid) killFixture(taskPid);
		await command.closed;
	}
}, 20_000);
