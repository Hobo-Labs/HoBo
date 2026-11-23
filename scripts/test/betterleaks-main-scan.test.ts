import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	betterleaksArgs,
	deferredByRangeOnly,
	FULL_WAIT_SECONDS,
	gitFetchBlobArgs,
	planMainBetterleaksScan,
	pollScanWait,
	prefetchRangeBlobs,
	RANGE_WAIT_SECONDS,
	rangeScanArgs,
	runPullRequestRangeScan,
	writeExitFile,
	ZERO_SHA,
} from "../ci/betterleaks-main-scan.mts";

const banner = "\n + ○\n   ▾\n betterleaks 1.10.1\n\n";
const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);
const mainGate = workflow.slice(
	workflow.indexOf("\n  main-gate:"),
	workflow.indexOf("\n  main_workspace_tests:"),
);
const mainGateFinish = workflow.slice(
	workflow.indexOf("\n  main_gate_finish:"),
	workflow.indexOf("\n  artifact-trust:"),
);
const mainGatePlan = workflow.slice(
	workflow.indexOf("\n  main-gate-plan:"),
	workflow.indexOf("\n  main-gate:"),
);
const pullRequestSecretScan =
	workflow
		.slice(workflow.indexOf("\n  secret-scan:"))
		.split(/\n {2}[a-z0-9_-]+:\n/u)[1] ?? "";

describe("planMainBetterleaksScan", () => {
	it("bounds a main push to the landed range without fetching every blob", () => {
		const plan = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: "aaa",
			sha: "bbb",
			commitExists: () => true,
		});
		assert.deepEqual(plan, {
			mode: "range",
			logOpts: "aaa..bbb",
			fetchBlobs: false,
			timeoutSeconds: 90,
			waitSeconds: RANGE_WAIT_SECONDS,
		});
		assert.ok(betterleaksArgs(plan).includes("--log-opts"));
		assert.ok(betterleaksArgs(plan).includes("aaa..bbb"));
	});

	it("keeps a regular full-history path that backfills blobs first", () => {
		for (const eventName of ["schedule", "workflow_dispatch"]) {
			const plan = planMainBetterleaksScan({
				eventName,
				pushBefore: undefined,
				sha: "bbb",
				commitExists: () => false,
			});
			assert.equal(plan.mode, "full", eventName);
			assert.equal(plan.fetchBlobs, true, eventName);
			assert.ok(!betterleaksArgs(plan).includes("--log-opts"), eventName);
		}
		assert.deepEqual(gitFetchBlobArgs(), ["fetch", "--refetch", "--no-filter"]);
	});

	it("keeps schedule and workflow_dispatch on the full-history path when a baseline exists", () => {
		const baseline = "a".repeat(40);
		const head = "b".repeat(40);
		for (const eventName of ["schedule", "workflow_dispatch"]) {
			const plan = planMainBetterleaksScan({
				eventName,
				pushBefore: undefined,
				sha: head,
				baselineSha: baseline,
				commitExists: (rev) => rev === baseline || rev === head,
				isAncestor: () => true,
			});
			assert.deepEqual(
				plan,
				{
					mode: "full",
					logOpts: null,
					fetchBlobs: true,
					timeoutSeconds: 600,
					waitSeconds: FULL_WAIT_SECONDS,
				},
				eventName,
			);
			assert.ok(!betterleaksArgs(plan).includes("--log-opts"), eventName);
		}
	});

	it("bounds a push without a usable before to the recorded baseline", () => {
		const baseline = "a".repeat(40);
		const head = "b".repeat(40);
		const plan = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: ZERO_SHA,
			sha: head,
			baselineSha: baseline,
			commitExists: (rev) => rev === baseline || rev === head,
			isAncestor: () => true,
		});
		assert.deepEqual(plan, {
			mode: "range",
			logOpts: `${baseline}..${head}`,
			fetchBlobs: false,
			timeoutSeconds: 90,
			waitSeconds: RANGE_WAIT_SECONDS,
		});
	});

	it("starts from the last green main commit when pushes in between were dropped", () => {
		const plan = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: "ccc",
			sha: "ddd",
			lastGreenSha: "aaa",
			commitExists: () => true,
			isAncestor: (ancestor, commit) => ancestor === "aaa" && commit === "ccc",
		});
		assert.equal(plan.logOpts, "aaa..ddd");
		assert.equal(plan.fetchBlobs, false);
	});

	it("keeps the push range when the last green commit is not behind it", () => {
		const plan = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: "ccc",
			sha: "ddd",
			lastGreenSha: "zzz",
			commitExists: () => true,
			isAncestor: () => false,
		});
		assert.equal(plan.logOpts, "ccc..ddd");
	});

	it("treats a forced push (zero before) as full history", () => {
		const plan = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: ZERO_SHA,
			sha: "bbb",
			commitExists: () => true,
		});
		assert.equal(plan.mode, "full");
		assert.equal(plan.fetchBlobs, true);
	});
});

describe("range scan blob prefetch", () => {
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "betterleaks-promisor-"));
		const remote = join(root, "remote.git");
		const source = join(root, "source");
		const clone = join(root, "clone");
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("GIT_")) delete env[key];
		}
		const globalConfig = join(root, "gitconfig");
		writeFileSync(globalConfig, "");
		env.GIT_CONFIG_GLOBAL = globalConfig;
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_TERMINAL_PROMPT = "0";
		mkdirSync(source);
		const git = (cwd: string, ...args: string[]): string =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				env,
			}).trim();
		git(root, "init", "--bare", "--initial-branch=main", remote);
		git(remote, "config", "uploadpack.allowFilter", "true");
		git(source, "init", "--initial-branch=main");
		git(source, "config", "user.name", "Test");
		git(source, "config", "user.email", "test@example.invalid");
		git(source, "config", "commit.gpgsign", "false");
		writeFileSync(join(source, ":deleted\nfile"), "old scan content\n");
		git(source, "add", ".");
		git(source, "commit", "-m", "initial");
		const before = git(source, "rev-parse", "HEAD");
		const oldBlob = git(source, "rev-parse", "HEAD::deleted\nfile");
		rmSync(join(source, ":deleted\nfile"));
		writeFileSync(join(source, "transient"), "intermediate scan content\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "replace");
		const transientBlob = git(source, "rev-parse", "HEAD:transient");
		rmSync(join(source, "transient"));
		writeFileSync(join(source, "retained"), "current scan content\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "replace again");
		const head = git(source, "rev-parse", "HEAD");
		git(source, "push", pathToFileURL(remote).href, "main");
		git(root, "clone", "--filter=blob:none", pathToFileURL(remote).href, clone);
		return {
			root,
			clone,
			remote,
			range: `${before}..${head}`,
			oldBlob,
			transientBlob,
			env,
		};
	}

	it("fetches deleted and intermediate blobs from a real partial clone", () => {
		const f = fixture();
		try {
			const gitNoFetch = (...args: string[]): string =>
				execFileSync("git", args, {
					cwd: f.clone,
					encoding: "utf8",
					env: { ...f.env, GIT_NO_LAZY_FETCH: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				});
			assert.throws(() => gitNoFetch("cat-file", "-e", f.oldBlob));
			assert.throws(() => gitNoFetch("cat-file", "-e", f.transientBlob));
			assert.ok(prefetchRangeBlobs(f.range, 30_000, f.clone, f.env) >= 3);
			gitNoFetch("cat-file", "-e", f.oldBlob);
			gitNoFetch("cat-file", "-e", f.transientBlob);
			const patch = gitNoFetch("log", "-p", "--no-ext-diff", f.range);
			assert.match(patch, /old scan content/u);
			assert.match(patch, /intermediate scan content/u);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("fails closed if a required blob cannot be fetched", () => {
		const f = fixture();
		try {
			renameSync(f.remote, `${f.remote}.offline`);
			assert.throws(
				() => prefetchRangeBlobs(f.range, 30_000, f.clone, f.env),
				/could not fetch every blob/u,
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("scans a reused blob:none workspace whose scanner never lazily fetches", async () => {
		const f = fixture();
		try {
			const scanned: string[] = [];
			const status = await runPullRequestRangeScan(f.range, {
				prefetch: (logOpts, timeoutMs) =>
					prefetchRangeBlobs(logOpts, timeoutMs, f.clone, f.env),
				scan: async (args) => {
					const logOpts = args[args.indexOf("--log-opts") + 1] ?? "";
					scanned.push(
						execFileSync("git", ["log", "-p", "--no-ext-diff", logOpts], {
							cwd: f.clone,
							encoding: "utf8",
							env: { ...f.env, GIT_NO_LAZY_FETCH: "1" },
							stdio: ["ignore", "pipe", "pipe"],
						}),
					);
					return 0;
				},
				log: () => {},
				now: Date.now,
			});
			assert.equal(status, 0);
			assert.match(scanned.join(""), /old scan content/u);
			assert.match(scanned.join(""), /intermediate scan content/u);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("fails the pull request scan instead of scanning a range it could not complete", async () => {
		const lines: string[] = [];
		let scans = 0;
		const status = await runPullRequestRangeScan("a..b", {
			prefetch: () => {
				throw new Error("could not fetch every blob in secret scan range");
			},
			scan: async () => {
				scans += 1;
				return 0;
			},
			log: (line) => lines.push(line),
			now: Date.now,
		});
		assert.equal(status, 1);
		assert.equal(scans, 0);
		assert.match(lines.join("\n"), /::error::secret scan of a\.\.b failed/u);
	});

	it("passes the scanner's own exit status and the explicit range through", async () => {
		const range = `${"a".repeat(40)}..${"b".repeat(40)}`;
		const seen: Array<readonly string[]> = [];
		const status = await runPullRequestRangeScan(range, {
			prefetch: () => 2,
			scan: async (args) => {
				seen.push(args);
				return 1;
			},
			log: () => {},
			now: Date.now,
		});
		assert.equal(status, 1);
		assert.deepEqual(seen, [rangeScanArgs(range)]);
		assert.deepEqual(rangeScanArgs(range).slice(-2), ["--log-opts", range]);
	});

	it("rejects anything other than an explicit commit range", () => {
		assert.throws(
			() => prefetchRangeBlobs("--all", 1_000),
			/invalid secret scan commit range/u,
		);
	});
});

describe("pollScanWait hang pattern from job 127207503432", () => {
	it("fails immediately when the scanner dies after writing only a banner", () => {
		const dir = mkdtempSync(join(tmpdir(), "betterleaks-hang-"));
		writeFileSync(join(dir, "log"), banner);
		writeFileSync(join(dir, "pid"), "4242\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 5,
				budgetSeconds: 300,
				pidAlive: () => false,
			}),
			"died-without-exit",
		);
	});

	it("times out the 300s wait budget when no exit file is written", () => {
		const dir = mkdtempSync(join(tmpdir(), "betterleaks-budget-"));
		writeFileSync(join(dir, "log"), banner);
		writeFileSync(join(dir, "pid"), "4242\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 300,
				budgetSeconds: 300,
				pidAlive: () => true,
			}),
			"timeout",
		);
	});

	it("returns ok when the exit file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "betterleaks-ok-"));
		writeFileSync(join(dir, "log"), "no leaks found\n");
		writeFileSync(join(dir, "exit"), "0\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 12,
				budgetSeconds: 90,
				pidAlive: () => false,
			}),
			"ok",
		);
	});

	it("always writes the exit file the wait step reads", () => {
		const dir = mkdtempSync(join(tmpdir(), "betterleaks-exit-"));
		writeExitFile(dir, 1);
		assert.equal(readFileSync(join(dir, "exit"), "utf8"), "1\n");
	});
});

describe("range-only early start", () => {
	it("defers only a scan that would refetch blobs", () => {
		const exists = () => true;
		const range = planMainBetterleaksScan({
			eventName: "push",
			pushBefore: "a".repeat(40),
			sha: "b".repeat(40),
			commitExists: exists,
		});
		const full = planMainBetterleaksScan({
			eventName: "workflow_dispatch",
			pushBefore: undefined,
			sha: "b".repeat(40),
			commitExists: exists,
		});
		assert.equal(range.mode, "range");
		assert.equal(full.mode, "full");
		assert.equal(deferredByRangeOnly(range, true), false);
		assert.equal(deferredByRangeOnly(full, true), true);
		assert.equal(deferredByRangeOnly(full, false), false);
	});
});

describe("main-gate wiring", () => {
	it("starts the range scan beside the plan and leaves a full scan to the last step", () => {
		const preflight = mainGatePlan.indexOf(
			"$/.github/actions/ci-runner-preflight",
		);
		const start = mainGatePlan.indexOf("name: Start secret scan");
		const plan = mainGatePlan.indexOf("name: Plan workspace shards");
		const scan = mainGatePlan.indexOf("name: Secret scan (full history)");
		assert.ok(preflight > -1 && start > preflight && plan > start, "order");
		const early = mainGatePlan.slice(
			start,
			mainGatePlan.indexOf("\n      - ", start + 1),
		);
		assert.match(
			early,
			/betterleaks-main-scan\.mts --background --range-only --dir "\$dir"/u,
		);
		// Detached, so the next steps run while it scans.
		assert.match(early, /^\s+nohup node /mu);
		assert.match(early, /2>&1 &\n/u);
		const last = mainGatePlan.slice(scan);
		assert.match(last, /if \[ -f "\$dir\/deferred" \]/u);
	});
	it("runs betterleaks through betterleaks-main-scan in the plan job, not inside S0 or finish", () => {
		// The merge queue does not scan, and Main full gate is skipped when the
		// merge queue passed the tree, so the scan lives in the job every main
		// run has: Main workspace plan (finding 154).
		for (const block of [mainGate, mainGateFinish]) {
			assert.equal(
				block.includes("scripts/ci/betterleaks-main-scan.mts"),
				false,
			);
			assert.equal(block.includes("betterleaks git"), false);
		}
		assert.ok(
			mainGatePlan.includes(
				"scripts/ci/betterleaks-main-scan.mts --background",
			),
		);
		assert.ok(
			mainGatePlan.includes(
				'scripts/ci/betterleaks-main-scan.mts --wait --dir "$dir"',
			),
		);
		assert.equal(
			/nohup bash -c '\s*betterleaks git --config \.betterleaks\.toml --redact --exit-code 1 >/u.test(
				mainGatePlan,
			),
			false,
		);
		assert.ok(FULL_WAIT_SECONDS <= 720);
		assert.ok(RANGE_WAIT_SECONDS <= 105);
		// The job outlasts the longest scan it waits for.
		const timeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(mainGatePlan)?.[1],
		);
		assert.ok(timeout * 60 > FULL_WAIT_SECONDS + 300, String(timeout));
	});

	it("scans a full-history checkout, after preflight, as the last and unconditional step", () => {
		const checkout = mainGatePlan.indexOf("          fetch-depth: 0");
		const preflight = mainGatePlan.indexOf(
			"$/.github/actions/ci-runner-preflight",
		);
		const plan = mainGatePlan.indexOf("name: Plan workspace shards");
		const scan = mainGatePlan.indexOf("name: Secret scan (full history)");
		assert.ok(checkout > -1);
		assert.ok(preflight > checkout);
		assert.ok(plan > preflight);
		assert.ok(scan > plan);
		// A reused merge-queue result skips the plan's work, never the scan.
		const step = mainGatePlan.slice(scan);
		assert.equal(/^\s+if:/mu.test(step), false, step);
		assert.equal(step.includes("continue-on-error"), false, step);
		// Last: nothing else touches the clone while a full scan backfills blobs.
		assert.equal(step.includes("\n      - "), false, step);
		assert.ok(
			step.indexOf("--background") < step.indexOf("--wait"),
			"the scan starts before it is waited for",
		);
	});
});

describe("pull request secret scan wiring", () => {
	it("prefetches the PR range before betterleaks so a reused partial clone cannot scan zero bytes", () => {
		assert.match(
			pullRequestSecretScan,
			/scripts\/ci\/betterleaks-main-scan\.mts\s+--range "\$\{\{ github\.event\.pull_request\.base\.sha \}\}\.\.\$\{\{ github\.sha \}\}"/u,
		);
		assert.equal(pullRequestSecretScan.includes("betterleaks git"), false);
	});
});
