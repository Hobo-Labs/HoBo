import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandModule, CommandRunInput } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import type { runCiRelayDeploy } from "../src/ci-relay-deploy.js";
import {
	createCiRelayPlanCommand,
	createCiRelayUpCommand,
	gitHead,
	relayCommitPlatformDrift,
	relayCommitSnapshot,
	relayPlatformDrift,
	relayProjectDirFor,
} from "../src/ci-up-relay.js";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

const packages = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CI_PROJECT = path.join(packages, "hobo-ci");
const RELAY = path.join(packages, "ci-vercel");

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

const never: CommandModule = {
	implemented: true,
	run: async () => {
		throw new Error("the fallback must not run for the relay project");
	},
};

function input(
	projectDir = CI_PROJECT,
): CommandRunInput & { progress: string[] } {
	const progress: string[] = [];
	// SAFETY: the relay plan and up read only the project, the cwd flag and emitProgress.
	const run = {
		verb: "up",
		args: [],
		flags: { cwd: projectDir },
		context: { cwd: projectDir, projectDir },
		emitProgress: (message: string) => progress.push(message),
	} as CommandRunInput;
	return Object.assign(run, { progress });
}

describe("hobo ci up through the relay's Yards", () => {
	it("finds the relay project for the bundled CI project", () => {
		expect(relayProjectDirFor(CI_PROJECT)).toBe(RELAY);
		expect(relayProjectDirFor(RELAY)).toBe(RELAY);
	});

	it("plans every relay resource on the relay's Yards, whatever this machine has registered", async () => {
		const runtime = createDefaultYardRuntime({ env: {} });
		// SAFETY: the default runtime's store is the runtime-local one.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cli = createComposedHoboCli({ yardRuntime: runtime });
		const plan = envelope(
			(await cli.run(["ci", "plan", "--json"], { cwd: CI_PROJECT, env: {} }))
				.stdout,
		);
		expect(plan.ok, JSON.stringify(plan.data?.remediations)).toBe(true);
		const providers = new Map<string, string>(
			plan.data.resources.map((r: { name: string; provider: string }) => [
				r.name,
				r.provider,
			]),
		);
		expect(providers.get("relay")).toBe("yard:hobo-ci-relay");
		expect(providers.get("hobo-ci-repair")).toBe("yard:hobo-ci-relay");
		expect(providers.get("hobo-ci-intake")).toBe("yard:hobo-ci-relay");
		expect(providers.get("config")).toBe("yard:hobo-ci-relay-config");
	});

	it("up refuses without a Vercel connection, and points at hobo cd up", async () => {
		const up = createCiRelayUpCommand(createTrustedVault(), never, {
			deploy: async () => {
				throw new Error("nothing is deployed without a token");
			},
		});
		const result = await up.run(input());
		expect(result.code).toBe("HOBO_CI_UP_VERCEL_NOT_CONNECTED");
		expect(result.remediation?.join(" ")).toMatch(/hobo cd up/);
	});

	it("up delivers the current branch to the relay's preview with the vault's token", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		let delivered: Parameters<typeof runCiRelayDeploy>[0] | undefined;
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			snapshot: async () => ({ dir: RELAY, close: async () => {} }),
			platformDrift: async () => [],
			deploy: async (request) => {
				delivered = request;
				return {
					ok: true,
					status: "deployed",
					code: "HOBO_OK",
					message: "ok",
					data: {},
				};
			},
		});
		const result = await up.run(input());
		expect(result.ok).toBe(true);
		expect(delivered?.cwd).toBe(RELAY);
		expect(delivered?.values).toEqual({
			ref: "feature/x",
			sha: "a".repeat(40),
			target: "preview",
			team: undefined,
		});
		expect(delivered?.credentials?.reveal("VERCEL_TOKEN")).toBe(
			"from-the-store",
		);
	});

	it("deploys to the Vercel team saved alongside the token", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		vault.put("VERCEL_TEAM_ID", "team_saved");
		let delivered: Parameters<typeof runCiRelayDeploy>[0] | undefined;
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			snapshot: async () => ({ dir: RELAY, close: async () => {} }),
			platformDrift: async () => [],
			deploy: async (request) => {
				delivered = request;
				return {
					ok: true,
					status: "deployed",
					code: "HOBO_OK",
					message: "ok",
					data: {},
				};
			},
		});
		await up.run(input());
		expect(delivered?.values.team).toBe("team_saved");
	});

	it("checks the deployed commit even if the working tree was edited to hide drift", async () => {
		const repo = mkdtempSync(join(RELAY, ".hobo-source-test-"));
		const project = join(repo, "packages", "relay");
		try {
			const git = (...args: string[]) => {
				const env: NodeJS.ProcessEnv = {
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				};
				if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
				return execFileSync("git", args, {
					cwd: repo,
					encoding: "utf8",
					env,
				}).trim();
			};
			git("init", "-q");
			mkdirSync(project, { recursive: true });
			mkdirSync(join(project, "src"));
			mkdirSync(join(project, "deploy"));
			writeFileSync(join(project, "deploy", "yard.ts"), "committed yard");
			writeFileSync(join(project, "deploy", "check.sh"), "#!/bin/sh\n");
			chmodSync(join(project, "deploy", "check.sh"), 0o755);
			writeFileSync(
				join(project, "src", "bindle.ts"),
				`import { bindle, cadence } from "@hobo/bindles";
export default bindle("relay", (b) => {
  const jobs = b.queue();
  const tick = b.schedule().dependsOn(jobs).with(cadence("*/5 * * * *"));
  return { jobs, tick };
});\n`,
			);
			const config = {
				functions: {
					"api/queue.ts": {
						experimentalTriggers: [{ type: "queue/v2beta", topic: "jobs" }],
					},
				},
				schedules: { tick: { schedule: "0 0 * * *", topic: "jobs" } },
			};
			writeFileSync(join(project, "vercel.json"), JSON.stringify(config));
			git("add", "packages/relay");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"commit",
				"-qm",
				"fixture",
			);
			const sha = git("rev-parse", "HEAD");
			config.schedules.tick.schedule = "*/5 * * * *";
			writeFileSync(join(project, "vercel.json"), JSON.stringify(config));
			writeFileSync(join(project, "deploy", "yard.ts"), "modified yard");
			expect(await relayPlatformDrift(project)).toEqual([]);
			expect(await relayCommitPlatformDrift(project, sha)).toEqual([
				'vercel.json schedules.tick must be { "schedule": "*/5 * * * *", "topic": "jobs" }',
			]);
			const snapshot = await relayCommitSnapshot(project, sha);
			try {
				expect(
					readFileSync(join(snapshot.dir, "deploy", "yard.ts"), "utf8"),
				).toBe("committed yard");
				if (process.platform !== "win32")
					expect(
						statSync(join(snapshot.dir, "deploy", "check.sh")).mode & 0o100,
					).toBe(0o100);
			} finally {
				await snapshot.close();
			}
			git("add", "packages/relay/vercel.json");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"commit",
				"-qm",
				"fix config",
			);
			const fixed = git("rev-parse", "HEAD");
			config.schedules.tick.schedule = "0 0 * * *";
			writeFileSync(join(project, "vercel.json"), JSON.stringify(config));
			expect(await relayCommitPlatformDrift(project, fixed)).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("uses the checked snapshot for delivery and closes it afterwards", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		const source = join(tmpdir(), "commit-source");
		let closed = false;
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			snapshot: async () => ({
				dir: source,
				close: async () => {
					closed = true;
				},
			}),
			platformDrift: async (dir) => {
				expect(dir).toBe(source);
				return [];
			},
			deploy: async (request) => {
				expect(request.cwd).toBe(source);
				return {
					ok: true,
					status: "deployed",
					code: "HOBO_OK",
					message: "ok",
					data: {},
				};
			},
		});
		expect((await up.run(input())).ok).toBe(true);
		expect(closed).toBe(true);
	});

	it("does not report a successful delivery as failed if snapshot cleanup fails", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			snapshot: async () => ({
				dir: RELAY,
				close: async () => {
					throw new Error("cleanup failed");
				},
			}),
			platformDrift: async () => [],
			deploy: async () => ({
				ok: true,
				status: "deployed",
				code: "HOBO_OK",
				message: "ok",
				data: {},
			}),
		});
		expect((await up.run(input())).ok).toBe(true);
	});

	it("does not deploy when the committed schedule has drifted", async () => {
		const vault = createTrustedVault();
		vault.put("VERCEL_TOKEN", "from-the-store");
		const up = createCiRelayUpCommand(vault, never, {
			head: async () => ({ ref: "feature/x", sha: "a".repeat(40) }),
			snapshot: async () => ({ dir: RELAY, close: async () => {} }),
			platformDrift: async () => ["the committed schedule has drifted"],
			deploy: async () => {
				throw new Error("must not deploy");
			},
		});
		expect((await up.run(input())).code).toBe("HOBO_CI_UP_PLATFORM_DRIFT");
	});

	it("reads GITHUB_HEAD_REF when the checkout is detached", async () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-git-head-"));
		const work = join(repo, "cd-vercel");
		const deployRef = "feature/git-deploy";
		const prev = process.env.GITHUB_HEAD_REF;
		try {
			mkdirSync(work, { recursive: true });
			execFileSync("git", ["init", "-b", "main"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "cd-test@hobo.local"], {
				cwd: repo,
			});
			execFileSync("git", ["config", "user.name", "HoBo CD test"], {
				cwd: repo,
			});
			writeFileSync(join(repo, "marker"), "x");
			execFileSync("git", ["add", "marker"], { cwd: repo });
			execFileSync("git", ["commit", "-m", "marker"], { cwd: repo });
			const sha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repo,
				encoding: "utf8",
			}).trim();
			execFileSync("git", ["checkout", "--detach"], { cwd: repo });
			process.env.GITHUB_HEAD_REF = deployRef;
			const head = await gitHead(work);
			expect(head).toEqual({ ref: deployRef, sha });
		} finally {
			if (prev === undefined) delete process.env.GITHUB_HEAD_REF;
			else process.env.GITHUB_HEAD_REF = prev;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("plan falls back for a project with no relay Yard", async () => {
		let fellBack = false;
		const plan = createCiRelayPlanCommand(
			createDefaultYardRuntime({ env: {} }),
			{
				implemented: true,
				run: async () => {
					fellBack = true;
					return {
						ok: true,
						status: "ok",
						code: "HOBO_OK",
						message: "",
						data: {},
					};
				},
			},
		);
		// A directory with no relay project in or beside it.
		await plan.run(input(mkdtempSync(join(tmpdir(), "hobo-no-relay-"))));
		expect(fellBack).toBe(true);
	});
});
