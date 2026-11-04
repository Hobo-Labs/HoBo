import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { killProcessGroup, trackChild } from "./subprocess-cleanup.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgRoot, "bin", "hobo-code.mjs");

describe("hobo-code bin launcher", () => {
	it("bin/hobo-code.mjs exists and is the package bin entry", () => {
		expect(existsSync(launcher)).toBe(true);
	});

	it("stale rebuild compiles @hobo/code only and does not fan out @hobo/core", () => {
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const pkg = JSON.parse(
			readFileSync(join(pkgRoot, "package.json"), "utf8"),
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
		) as { scripts?: Record<string, string> };
		const prebuild = pkg.scripts?.prebuild ?? "";
		expect(prebuild).not.toMatch(/@hobo\/core/);
		expect(prebuild).not.toMatch(/@hobo\/stations/);
		expect(prebuild).not.toMatch(/@hobo\/patterns/);
		expect(pkg.scripts?.build).toMatch(/tsc/);
		const launcherSrc = readFileSync(launcher, "utf8");
		expect(launcherSrc).toMatch(/tsc/);
		expect(launcherSrc).toMatch(/running src\/ via tsx/);
		expect(launcherSrc).toMatch(
			/stationsDistIsStale|@hobo\/stations dist is stale/,
		);
		expect(launcherSrc).not.toMatch(/--filter\s+@hobo\/core/);
		expect(launcherSrc).not.toMatch(/pnpm", \["run", "build"\]/);
		expect(launcherSrc).not.toMatch(/pnpm", \["--filter"/);
	});

	it("tsc failure does not block the CLI — falls back to src via tsx", () => {
		const fakeTsc = join(
			mkdtempSync(join(tmpdir(), "hobo-code-tsc-")),
			"fail-tsc.mjs",
		);
		writeFileSync(
			fakeTsc,
			"process.stderr.write('fake tsc boom\\n'); process.exit(1);\n",
		);
		const r = spawnSync(process.execPath, [launcher, "agents", "--help"], {
			cwd: pkgRoot,
			encoding: "utf8",
			env: {
				...process.env,
				HOBO_CODE_FORCE_STALE_REBUILD: "1",
				HOBO_CODE_TSC: fakeTsc,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/tsc failed — running src\/ via tsx/);
		expect(r.stdout).toMatch(/hobo-code agents/);
		expect(r.stdout).toMatch(/agents init/i);
	}, 120_000);

	// The three stderr assertions below *are* the "tsc-only" claim, and they
	// prove it by name: the launcher announces what it compiles, so a
	// regression that rebuilt `@hobo/core` would say so. There used to be a
	// fourth, `elapsedMs < 60_000`, standing in for the same property by proxy
	// — and it is the only one that can fail for a reason that has nothing to
	// do with the launcher. Under a fully-forced 902-task `turbo run test` this
	// spawn took 74s and the test failed at 74264 < 60000 while every
	// behavioural assertion passed. A duration is not evidence about a build
	// graph when the graph is already saying what it built.
	it("forced stale rebuild is tsc-only and does not rebuild @hobo/core", () => {
		const r = spawnSync(process.execPath, [launcher, "help"], {
			cwd: pkgRoot,
			encoding: "utf8",
			env: {
				...process.env,
				HOBO_CODE_FORCE_STALE_REBUILD: "1",
			},
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/tsc @hobo\/code only/);
		expect(r.stderr).not.toMatch(/@hobo\/core/);
		expect(r.stderr).not.toMatch(/@hobo\/stations@/);
		expect(r.stdout).toMatch(/hobo-code/);
	}, 180_000);

	it("runs help via launcher with current dist (skip rebuild)", () => {
		const r = spawnSync(process.execPath, [launcher, "help"], {
			cwd: pkgRoot,
			encoding: "utf8",
			env: { ...process.env, HOBO_CODE_SKIP_STALE_REBUILD: "1" },
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/hobo-code/);
		expect(r.stdout).toMatch(/Start here:|plain by default/i);
	});

	it("plain status via launcher is English hierarchy not only glyph box", () => {
		const r = spawnSync(process.execPath, [launcher, "status"], {
			cwd: pkgRoot,
			encoding: "utf8",
			env: { ...process.env, HOBO_CODE_SKIP_STALE_REBUILD: "1" },
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/session status|Agents:/i);
		expect(r.stdout).not.toMatch(/┌─+┐/);
	});

	it("forwards a PID-only termination signal to a live dev child", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-code-launcher-signal-"));
		const hoboHome = join(root, "home");
		const projectDir = join(root, "app");
		const hoboBin = join(root, "hobo");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "src", "bindle.ts"), "export default {};\n");
		writeFileSync(
			hoboBin,
			`#!/usr/bin/env node
import { createServer } from "node:http";
const portAt = process.argv.indexOf("--port");
const port = portAt >= 0 ? Number(process.argv[portAt + 1]) : 4173;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<h1>Bindle app</h1>");
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stderr.write(\`hobo dev: listening on http://127.0.0.1:\${address.port}/ (Ctrl-C to stop)\\n\`);
});
const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
`,
		);
		chmodSync(hoboBin, 0o755);
		const child = spawn(
			process.execPath,
			[
				launcher,
				"dev",
				"--cwd",
				projectDir,
				"--port",
				"0",
				"--debug-port",
				"0",
			],
			{
				cwd: pkgRoot,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					HOBO_CODE_SKIP_STALE_REBUILD: "1",
					HOBO_HOME: hoboHome,
					HOBO_CODE_HOBO_BIN: hoboBin,
				},
			},
		);
		trackChild(child);
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("dev launcher did not become ready")),
					60_000,
				);
				child.once("error", reject);
				child.stdout?.on("data", (chunk) => {
					if (!String(chunk).includes("bindle")) return;
					clearTimeout(timeout);
					resolve();
				});
			});
			if (child.pid === undefined)
				throw new Error("launcher has no process id");
			process.kill(child.pid, "SIGTERM");
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			const [status] = (await once(child, "exit")) as [
				number | null,
				string | null,
			];
			expect(status).toBe(143);
		} finally {
			if (child.pid !== undefined) killProcessGroup(child.pid);
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
