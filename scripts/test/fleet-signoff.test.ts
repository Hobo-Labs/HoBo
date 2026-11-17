import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	executeFleetVerification,
	planFleetVerification,
} from "../ci/fleet-signoff.mts";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import {
	type QueueView,
	routeSettings,
	type SeenJob,
	type SlipReading,
} from "../ci/route-runner.mts";

const now = Date.parse("2026-11-16T18:00:00Z");
const settings = { ...routeSettings(undefined), localRunner: true };
const noSlip: SlipReading = { ok: false, why: "no routing slip" };
const picked = (label: string): SeenJob => ({
	runId: 1,
	labels: [label],
	createdAtMs: now - 10_000,
	startedAtMs: now - 8_000,
});
const waiting = (label: string): SeenJob => ({
	runId: 2,
	labels: [label],
	createdAtMs: now - 500_000,
});
const queue = (jobs: readonly SeenJob[], undecidedAhead = 0): QueueView => ({
	jobs,
	undecidedAhead,
	probeUnderway: false,
});
const plan = (
	view: QueueView,
	options: {
		localSignoffEnabled?: boolean;
		githubUnavailable?: boolean;
		slip?: SlipReading;
	} = {},
) =>
	planFleetVerification({
		settings,
		localSignoffEnabled: options.localSignoffEnabled ?? true,
		githubUnavailable: options.githubUnavailable ?? false,
		readSlip: async () => options.slip ?? noSlip,
		readQueue: async () => view,
		nowMs: now,
	});

describe("local signoff in the fleet decision", () => {
	it("keeps the existing order when fleet, local, or GitHub capacity is available", async () => {
		const fleet = "hobo";
		const local = "hobo-local-host";
		const github = "ubuntu-24.04";
		for (const [jobs, tier] of [
			[[picked(fleet), picked(local), picked(github)], "fleet"],
			[[waiting(fleet), picked(local), picked(github)], "local"],
			[[waiting(fleet), waiting(local), picked(github)], "github"],
		] as const) {
			const choice = await plan(queue(jobs));
			assert.equal(choice.kind, "runner");
			if (choice.kind === "runner") assert.equal(choice.tier, tier);
		}
	});

	it("selects local signoff only when every enabled runner is observed unavailable and it was enabled", async () => {
		const down = queue([
			waiting("hobo"),
			waiting("hobo-local-host"),
			waiting("ubuntu-24.04"),
		]);
		assert.deepEqual(await plan(down), { kind: "local-signoff" });
		assert.deepEqual(await plan(down, { localSignoffEnabled: false }), {
			kind: "wait",
			reason: "no-capacity",
		});
	});

	it("accepts an explicit hosted outage observation without displacing observed runners", async () => {
		const down = [waiting("hobo"), waiting("hobo-local-host")];
		assert.deepEqual(await plan(queue(down), { githubUnavailable: true }), {
			kind: "local-signoff",
		});
		const hosted = await plan(queue([...down, picked("ubuntu-24.04")]), {
			githubUnavailable: true,
		});
		assert.deepEqual(hosted, {
			kind: "runner",
			tier: "github",
			runner: "ubuntu-24.04",
		});
		const fleet = await plan(queue([picked("hobo")]), {
			githubUnavailable: true,
		});
		assert.deepEqual(fleet, { kind: "runner", tier: "fleet", runner: "hobo" });
	});

	it("waits when capacity is unknown, a prior run holds the turn, or the queue cannot be read", async () => {
		assert.deepEqual(await plan(queue([])), {
			kind: "wait",
			reason: "availability-unknown",
		});
		assert.deepEqual(
			await plan(
				queue(
					[picked("hobo"), waiting("hobo-local-host"), waiting("ubuntu-24.04")],
					1,
				),
			),
			{
				kind: "wait",
				reason: "availability-unknown",
			},
		);
		assert.deepEqual(
			await planFleetVerification({
				settings,
				localSignoffEnabled: true,
				readSlip: async () => noSlip,
				readQueue: async () => {
					throw new Error("unavailable");
				},
				nowMs: now,
			}),
			{ kind: "wait", reason: "availability-unknown" },
		);
	});

	it("honours pins and routing slips before considering local signoff", async () => {
		const pinned = await planFleetVerification({
			settings: { ...settings, pin: "github" },
			localSignoffEnabled: true,
			readSlip: async () => {
				throw new Error("must not read slip");
			},
			readQueue: async () => {
				throw new Error("must not read queue");
			},
			nowMs: now,
		});
		assert.deepEqual(pinned, {
			kind: "runner",
			tier: "github",
			runner: "ubuntu-24.04",
		});
		const localSlip: SlipReading = {
			ok: true,
			decision: {
				tier: "local",
				runner: "hobo-local-host",
				reason: "available",
			},
		};
		assert.deepEqual(await plan(queue([]), { slip: localSlip }), {
			kind: "runner",
			tier: "local",
			runner: "hobo-local-host",
		});
		const githubSlip: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "no-capacity",
			},
		};
		assert.deepEqual(
			await plan(queue([waiting("ubuntu-24.04")]), { slip: githubSlip }),
			{ kind: "local-signoff" },
		);
	});

	it("checks a fleet slip against its exact label before keeping it", async () => {
		const open: SlipReading = {
			ok: true,
			decision: {
				tier: "fleet",
				runner: "hobo-trunk",
				reason: "fleet-open",
				slip: { kind: "used", reason: "fleet-open", from: "node@abc" },
			},
		};
		const otherTiersDown = [
			waiting("hobo-local-host"),
			waiting("ubuntu-24.04"),
		];
		assert.deepEqual(
			await plan(queue([picked("hobo-trunk"), ...otherTiersDown]), {
				slip: open,
			}),
			{ kind: "runner", tier: "fleet", runner: "hobo-trunk" },
		);
		assert.deepEqual(
			await plan(
				queue([picked("hobo"), waiting("hobo-trunk"), ...otherTiersDown]),
				{ slip: open },
			),
			{ kind: "local-signoff" },
		);
		assert.deepEqual(await plan(queue(otherTiersDown), { slip: open }), {
			kind: "wait",
			reason: "availability-unknown",
		});
	});

	it("keeps a busy fleet with timely pickups despite a young queue", async () => {
		const busy: SlipReading = {
			ok: true,
			decision: {
				tier: "fleet",
				runner: "hobo",
				reason: "fleet-busy",
				slip: { kind: "used", reason: "fleet-busy", from: "node@abc" },
			},
		};
		const young: SeenJob = {
			runId: 2,
			labels: ["hobo"],
			createdAtMs: now - 10_000,
		};
		const view = queue(
			[picked("hobo"), ...Array.from({ length: 5 }, () => young)],
			1,
		);
		assert.deepEqual(await plan(view, { slip: busy }), {
			kind: "runner",
			tier: "fleet",
			runner: "hobo",
		});
	});

	it("falls back to queue evidence after a slip read error, and waits if the queue also fails", async () => {
		const decide = (readQueue: () => Promise<QueueView>) =>
			planFleetVerification({
				settings,
				localSignoffEnabled: true,
				readSlip: async () => {
					throw new Error("connection lost");
				},
				readQueue,
				nowMs: now,
			});
		assert.deepEqual(await decide(async () => queue([picked("hobo")])), {
			kind: "runner",
			tier: "fleet",
			runner: "hobo",
		});
		assert.deepEqual(
			await decide(async () => {
				throw new Error("connection lost");
			}),
			{
				kind: "wait",
				reason: "availability-unknown",
			},
		);
	});

	it("runs and signs only the selected fallback, and never signs a failed run", async () => {
		const calls: string[] = [];
		const execute = (
			choice: Awaited<ReturnType<typeof plan>>,
			runStatus: number,
		) =>
			executeFleetVerification({
				choice,
				runLocal: async () => {
					calls.push("run");
					return runStatus;
				},
				signoffLocal: async () => {
					calls.push("signoff");
					return 0;
				},
			});
		assert.equal(
			await execute({ kind: "runner", tier: "fleet", runner: "hobo" }, 0),
			0,
		);
		assert.equal(
			await execute({ kind: "wait", reason: "availability-unknown" }, 0),
			1,
		);
		assert.deepEqual(calls, []);
		assert.equal(await execute({ kind: "local-signoff" }, 1), 1);
		assert.deepEqual(calls, ["run"]);
		calls.length = 0;
		assert.equal(await execute({ kind: "local-signoff" }, 0), 0);
		assert.deepEqual(calls, ["run", "signoff"]);
	});

	it("connects the fleet command to GitHub observations and starts local work only on fallback", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-fleet-command-"));
		try {
			const repo = join(root, "repo");
			const remote = join(root, "remote.git");
			const bin = join(root, "bin");
			const isolatedEnv = { ...process.env };
			for (const name of GIT_LOCATION_VARIABLES) delete isolatedEnv[name];
			mkdirSync(repo);
			mkdirSync(bin);
			const git = (cwd: string, args: string[]) =>
				execFileSync("git", args, {
					cwd,
					stdio: "pipe",
					env: {
						...isolatedEnv,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_NOSYSTEM: "1",
					},
				});
			git(root, ["init", "--bare", "--quiet", remote]);
			git(repo, ["init", "--quiet", "--initial-branch=main"]);
			git(repo, ["config", "user.name", "Test"]);
			git(repo, ["config", "user.email", "test@example.invalid"]);
			writeFileSync(join(repo, "tracked.txt"), "fixture\n");
			git(repo, ["add", "tracked.txt"]);
			git(repo, [
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			]);
			git(repo, ["remote", "add", "origin", remote]);
			git(repo, ["push", "--quiet", "origin", "main"]);
			const at = (seconds: number) =>
				new Date(Date.now() - seconds * 1000).toISOString();
			const runs = join(root, "runs.json");
			const jobs = join(root, "jobs.json");
			const calls = join(root, "calls");
			writeFileSync(
				runs,
				JSON.stringify({
					workflow_runs: [
						{ id: 123, status: "in_progress", created_at: at(500) },
					],
				}),
			);
			writeFileSync(
				join(bin, "gh"),
				`#!/bin/sh
printf '%s\\n' "$*" >> "$HOBO_FLEET_CALLS"
if [ "$1" = repo ]; then echo acme/app; exit 0; fi
if [ "$1" = signoff ] && [ "$2" = --help ]; then
  [ "\${HOBO_FLEET_MISSING_SIGNOFF:-0}" = 1 ] && exit 1
  echo --commit; exit 0
fi
if [ "$1" = signoff ] && [ "$2" = create ]; then exit 0; fi
case "$2" in
  */actions/runs\\?*) cat "$HOBO_FLEET_RUNS" ;;
  */actions/runs/*/jobs\\?*) cat "$HOBO_FLEET_JOBS" ;;
  *) exit 1 ;;
esac
`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "pnpm"),
				'#!/bin/sh\ncase "$*" in\n  --version) echo 10.0.0 ;;\n  "exec turbo --version") echo 2.0.0 ;;\n  *) exit 1 ;;\nesac\n',
				{ mode: 0o755 },
			);
			const command = (extra: NodeJS.ProcessEnv = {}) =>
				spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--no-warnings",
						fileURLToPath(new URL("../ci/local-attest.mts", import.meta.url)),
						"fleet",
						"--local-signoff",
					],
					{
						cwd: repo,
						encoding: "utf8",
						env: {
							...isolatedEnv,
							PATH: `${bin}:${isolatedEnv.PATH ?? ""}`,
							GIT_CONFIG_GLOBAL: "/dev/null",
							GIT_CONFIG_NOSYSTEM: "1",
							HOBO_CI_ATTESTOR_KEY: join(root, "keys", "attestor.pem"),
							HOBO_FLEET_CALLS: calls,
							HOBO_FLEET_RUNS: runs,
							HOBO_FLEET_JOBS: jobs,
							...extra,
						},
					},
				);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: [
						{
							run_id: 123,
							status: "completed",
							labels: ["hobo"],
							runner_name: "fixture",
							created_at: at(10),
							started_at: at(8),
						},
					],
				}),
			);
			const available = command();
			assert.equal(available.status, 0, available.stderr);
			assert.match(available.stdout, /fleet runner hobo/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: ["hobo", "ubuntu-24.04"].map((label) => ({
						run_id: 123,
						status: "queued",
						labels: [label],
						created_at: at(500),
					})),
				}),
			);
			writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
			const missing = command({ HOBO_FLEET_MISSING_SIGNOFF: "1" });
			assert.notEqual(missing.status, 0);
			assert.match(missing.stderr, /install or upgrade basecamp\/gh-signoff/u);
			const fallback = command();
			assert.notEqual(fallback.status, 0);
			assert.match(fallback.stdout, /running the local signoff fallback/u);
			assert.match(fallback.stderr, /working tree is not clean/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);

			// A committed local workflow runs end to end and reaches gh-signoff.
			rmSync(join(repo, "dirty.txt"));
			git(repo, ["switch", "--quiet", "-c", "feature"]);
			mkdirSync(join(repo, "scripts/ci"), { recursive: true });
			mkdirSync(join(repo, ".github/workflows"), { recursive: true });
			writeFileSync(join(repo, ".gitignore"), ".hobo/attestations-out/\n");
			const writeWorkflow = (run: string) => {
				const step = { name: "Fixture check", run };
				writeFileSync(
					join(repo, ".github/workflows/hobo-ci.yml"),
					JSON.stringify({ jobs: { "ci-guard": { steps: [step] } } }),
				);
				writeFileSync(
					join(repo, "scripts/ci/attested-jobs.json"),
					JSON.stringify({
						jobs: [
							{
								id: "ci-guard",
								workflow: ".github/workflows/hobo-ci.yml",
								workflowEnv: {},
								env: {},
								outputs: {},
								steps: [{ ...step, local: "run" }],
							},
						],
					}),
				);
			};
			writeWorkflow("echo fleet-fixture-ran");
			git(repo, ["add", ".gitignore", ".github", "scripts"]);
			git(repo, [
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"local check",
			]);
			git(repo, ["push", "--quiet", "origin", "HEAD:refs/heads/feature"]);
			const head = git(repo, ["rev-parse", "HEAD"]).toString().trim();
			const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).toString().trim();
			const success = command();
			assert.equal(success.status, 0, success.stderr);
			assert.match(
				readFileSync(
					join(repo, ".hobo/attestations-out", tree, "ci-guard.log"),
					"utf8",
				),
				/fleet-fixture-ran/u,
			);
			assert.ok(
				readFileSync(calls, "utf8").includes(
					`signoff create --commit ${head} hobo-ci/local/pull_request/ci-guard`,
				),
			);

			// A failed local step must never post a success for its new head.
			writeWorkflow("exit 1");
			git(repo, ["add", ".github", "scripts"]);
			git(repo, [
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"failing check",
			]);
			git(repo, ["push", "--quiet", "origin", "HEAD:refs/heads/feature"]);
			const failed = command();
			assert.notEqual(failed.status, 0);
			assert.match(failed.stderr, /Nothing was signed/u);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				1,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
