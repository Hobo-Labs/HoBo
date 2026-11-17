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
	type FleetOverflowMember,
	observeFleetVerification,
	planFleetVerification,
	readFleetOverflowPolicy,
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
		overflow?: readonly FleetOverflowMember[];
	} = {},
) =>
	planFleetVerification({
		settings,
		localSignoffEnabled: options.localSignoffEnabled ?? true,
		githubUnavailable: options.githubUnavailable ?? false,
		overflow: options.overflow ?? [],
		readSlip: async () => options.slip ?? noSlip,
		readQueue: async () => view,
		nowMs: now,
	});

describe("local signoff in the fleet decision", () => {
	it("preserves runner preference and fallback execution across all observed tier states", async () => {
		const states = ["available", "unavailable", "unknown"] as const;
		const tiers = [
			{ tier: "fleet", label: "hobo" },
			{ tier: "overflow", label: "hobo-arc" },
			{ tier: "local", label: "hobo-local-host" },
			{ tier: "github", label: "ubuntu-24.04" },
		] as const;
		let cases = 0;
		for (const fleet of states)
			for (const arc of states)
				for (const local of states)
					for (const github of states)
						for (const optedIn of [false, true]) {
							const observations = [fleet, arc, local, github];
							const jobs = observations.flatMap((state, index) => {
								const label = tiers[index]?.label;
								if (!label || state === "unknown") return [];
								return [state === "available" ? picked(label) : waiting(label)];
							});
							const choice = await plan(queue(jobs), {
								localSignoffEnabled: optedIn,
								overflow: [
									{ id: "ci:arc", runsOn: "hobo-arc", observable: true },
								],
							});
							const firstAvailable = tiers.find(
								(_, index) => observations[index] === "available",
							);
							if (firstAvailable) {
								assert.deepEqual(choice, {
									kind: "runner",
									tier: firstAvailable.tier,
									runner: firstAvailable.label,
								});
							} else if (observations.includes("unknown")) {
								assert.deepEqual(choice, {
									kind: "wait",
									reason: "availability-unknown",
								});
							} else if (optedIn) {
								assert.deepEqual(choice, { kind: "local-signoff" });
							} else {
								assert.deepEqual(choice, {
									kind: "wait",
									reason: "no-capacity",
								});
							}
							const calls: string[] = [];
							const status = await executeFleetVerification({
								choice,
								runLocal: async () => {
									calls.push("run");
									return 0;
								},
								signoffLocal: async () => {
									calls.push("signoff");
									return 0;
								},
							});
							assert.equal(status, choice.kind === "wait" ? 1 : 0);
							assert.deepEqual(
								calls,
								choice.kind === "local-signoff" ? ["run", "signoff"] : [],
							);
							cases += 1;
						}
		assert.equal(cases, 162);
	});

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

	it("considers enabled overflow labels before local signoff, even when a slip rejects the fleet", async () => {
		const overflow = [
			{ id: "ci:arc", runsOn: "hobo-arc", observable: true },
			{ id: "ci:depot", runsOn: "depot-ubuntu-24.04", observable: true },
		];
		const githubSlip: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "no capacity",
				slip: { kind: "used", reason: "no-capacity", from: "node@abc" },
			},
		};
		const options = { slip: githubSlip, overflow, githubUnavailable: true };
		assert.deepEqual(await plan(queue([picked("hobo-arc")]), options), {
			kind: "runner",
			tier: "overflow",
			runner: "hobo-arc",
		});
		assert.deepEqual(
			await plan(
				queue([waiting("hobo-arc"), picked("depot-ubuntu-24.04")]),
				options,
			),
			{ kind: "runner", tier: "overflow", runner: "depot-ubuntu-24.04" },
		);
		assert.deepEqual(await plan(queue([waiting("hobo-arc")]), options), {
			kind: "wait",
			reason: "availability-unknown",
		});
		assert.deepEqual(
			await plan(
				queue([
					waiting("hobo-arc"),
					waiting("depot-ubuntu-24.04"),
					waiting("hobo-local-host"),
				]),
				options,
			),
			{ kind: "local-signoff" },
		);
	});

	it("does not infer that an enabled opaque compute provider is down from a quiet queue", async () => {
		const down = queue([
			waiting("hobo"),
			waiting("hobo-local-host"),
			waiting("ubuntu-24.04"),
		]);
		assert.deepEqual(
			await plan(down, {
				githubUnavailable: true,
				overflow: [{ id: "ci:sandbox", runsOn: "sandbox", observable: false }],
			}),
			{ kind: "wait", reason: "availability-unknown" },
		);
	});

	it("reads enabled overflow inventory from every trusted policy environment", () => {
		const source = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), []);
		const arc = source.environments.ci.policy.providers.find(
			(entry: { id: string }) => entry.id === "hostinger-arc",
		);
		arc.enabled = true;
		source.integrations[0].enabled = true;
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), [
			{ id: "ci:hostinger-arc", runsOn: "hobo-arc", observable: true },
			{
				id: "integration:blacksmith:blacksmith-2vcpu-ubuntu-2404",
				runsOn: "blacksmith-2vcpu-ubuntu-2404",
				observable: true,
			},
		]);
		delete arc.enabled;
		source.integrations[0].enabled = false;
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), []);
		delete source.integrations[0].enabled;
		assert.deepEqual(readFleetOverflowPolicy(JSON.stringify(source)), [
			{
				id: "integration:blacksmith:blacksmith-2vcpu-ubuntu-2404",
				runsOn: "blacksmith-2vcpu-ubuntu-2404",
				observable: true,
			},
		]);
	});

	it("refuses opaque references, templates, and malformed or missing inventory", () => {
		const source = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		const arc = source.environments.ci.policy.providers[3];
		arc.enabled = true;
		source.definitions = { providers: { arc } };
		source.environments.ci.policy.providers[3] = {
			$ref: "#/definitions/providers/arc",
		};
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		source.environments.ci.policy.providers[3] = {
			$ref: "#/definitions/providers/missing",
		};
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		source.environments.ci.policy.providers[3] = arc;
		source.environments.ci.extends = "template";
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		delete source.environments.ci.extends;
		arc.enabled = "true";
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		arc.enabled = true;
		arc.scaleSet.maxRunners = "4";
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		arc.scaleSet.maxRunners = 4;
		for (const field of ["pool", "routing", "budget"]) {
			const previous = source.environments.ci.policy[field];
			source.environments.ci.policy[field] = [];
			assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
			source.environments.ci.policy[field] = previous;
		}
		source.environments.ci.policy.thresholds = {};
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		source.environments.ci.policy.thresholds = [];
		delete source.environments.ci.policy.providers;
		assert.equal(readFleetOverflowPolicy(JSON.stringify(source)), undefined);
		assert.equal(readFleetOverflowPolicy("{"), undefined);
		assert.equal(readFleetOverflowPolicy(undefined), undefined);
	});

	it("validates Kubernetes scale-set and engine inventory fields", () => {
		const source = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		const arc = source.environments.ci.policy.providers[3];
		arc.enabled = true;
		const scaleSet = arc.scaleSet;
		const read = () => readFleetOverflowPolicy(JSON.stringify(source));
		assert.deepEqual(read(), [
			{ id: "ci:hostinger-arc", runsOn: "hobo-arc", observable: true },
		]);
		for (const malformed of [
			{ ...scaleSet, garbage: true },
			{ ...scaleSet, name: 42 },
			{ ...scaleSet, namespace: "Invalid" },
			{ ...scaleSet, minRunners: null },
			{ ...scaleSet, minRunners: 1.5 },
		]) {
			arc.scaleSet = malformed;
			assert.equal(read(), undefined);
		}
		arc.scaleSet = { ...scaleSet };
		delete arc.scaleSet.minRunners;
		assert.equal(read()?.[0]?.observable, true);
		delete arc.scaleSet;
		for (const malformed of [
			{ name: 42 },
			{},
			{ name: "Invalid" },
			{ name: "engine", garbage: true },
		]) {
			arc.engine = malformed;
			assert.equal(read(), undefined);
		}
		arc.engine = { name: "dagger-engine" };
		assert.deepEqual(read(), [
			{ id: "ci:hostinger-arc", runsOn: "hobo-arc", observable: false },
		]);
	});

	it("keeps configured hosted providers behind an available local runner", async () => {
		const source = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		const hosted = source.environments.ci.policy.providers[2];
		hosted.enabled = true;
		hosted.runsOn = "ubuntu-22.04";
		const overflow = readFleetOverflowPolicy(JSON.stringify(source));
		assert.deepEqual(overflow, [
			{
				id: "ci:github-hosted",
				runsOn: "ubuntu-22.04",
				observable: true,
				backend: "github",
			},
		]);
		assert.ok(overflow);
		assert.deepEqual(
			await plan(
				queue([
					waiting("hobo"),
					picked("hobo-local-host"),
					picked("ubuntu-22.04"),
				]),
				{ overflow },
			),
			{ kind: "runner", tier: "local", runner: "hobo-local-host" },
		);
		hosted.runsOn = "ubuntu-24.04";
		const equalLabel = readFleetOverflowPolicy(JSON.stringify(source));
		assert.deepEqual(equalLabel, [
			{
				id: "ci:github-hosted",
				runsOn: "ubuntu-24.04",
				observable: true,
				backend: "github",
			},
		]);
	});

	it("keeps distinct providers even when their label matches a standard tier", async () => {
		const source = JSON.parse(
			readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
		);
		const arc = source.environments.ci.policy.providers[3];
		arc.enabled = true;
		arc.runsOn = "ubuntu-24.04";
		const overflow = readFleetOverflowPolicy(JSON.stringify(source));
		assert.ok(overflow);
		assert.deepEqual(overflow, [
			{ id: "ci:hostinger-arc", runsOn: "ubuntu-24.04", observable: true },
		]);
		assert.deepEqual(
			await plan(queue([waiting("hobo"), waiting("hobo-local-host")]), {
				overflow,
				githubUnavailable: true,
			}),
			{ kind: "wait", reason: "availability-unknown" },
		);
		assert.deepEqual(
			await plan(
				queue([
					waiting("hobo"),
					waiting("hobo-local-host"),
					picked("ubuntu-24.04"),
				]),
				{
					overflow,
					githubUnavailable: true,
				},
			),
			{ kind: "runner", tier: "overflow", runner: "ubuntu-24.04" },
		);
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
		assert.deepEqual(
			await plan(queue([picked("hobo-local-host")]), { slip: localSlip }),
			{
				kind: "runner",
				tier: "local",
				runner: "hobo-local-host",
			},
		);
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
			{ kind: "wait", reason: "availability-unknown" },
		);
		assert.deepEqual(
			await plan(queue([picked("hobo-local-host"), waiting("ubuntu-24.04")]), {
				slip: githubSlip,
			}),
			{ kind: "runner", tier: "local", runner: "hobo-local-host" },
		);
		assert.deepEqual(
			await plan(queue([waiting("hobo-local-host"), waiting("ubuntu-24.04")]), {
				slip: githubSlip,
			}),
			{ kind: "local-signoff" },
		);
	});

	it("ignores a slip whose runner contradicts its tier, including a claimed pin", async () => {
		const reasons: ("pinned" | "no-capacity")[] = ["pinned", "no-capacity"];
		for (const reason of reasons) {
			const slip: SlipReading = {
				ok: true,
				decision: {
					tier: "github",
					runner: "hobo",
					reason,
					slip: {
						kind: "used",
						reason,
						from: "node@abc",
					},
				},
			};
			assert.deepEqual(await plan(queue([picked("hobo")]), { slip }), {
				kind: "runner",
				tier: "fleet",
				runner: "hobo",
			});
		}
	});

	it("does not mistake a local routing slip for proof that the local runner is available", async () => {
		const localSlip: SlipReading = {
			ok: true,
			decision: {
				tier: "local",
				runner: "hobo-local-host",
				reason: "fleet refused",
				slip: { kind: "used", reason: "no-capacity", from: "node@abc" },
			},
		};
		assert.deepEqual(
			await plan(queue([waiting("ubuntu-24.04")]), { slip: localSlip }),
			{ kind: "wait", reason: "availability-unknown" },
		);
		assert.deepEqual(
			await plan(queue([waiting("hobo-local-host"), waiting("ubuntu-24.04")]), {
				slip: localSlip,
			}),
			{ kind: "local-signoff" },
		);
		assert.deepEqual(
			await plan(queue([waiting("hobo-local-host"), picked("ubuntu-24.04")]), {
				slip: localSlip,
			}),
			{ kind: "runner", tier: "github", runner: "ubuntu-24.04" },
		);
		assert.deepEqual(
			await planFleetVerification({
				settings,
				localSignoffEnabled: true,
				nowMs: now,
				readSlip: async () => ({
					ok: true,
					decision: {
						...localSlip.decision,
						slip: { kind: "used", reason: "pinned", from: "node@abc" },
					},
				}),
				readQueue: async () => {
					throw new Error("a pin must not read the queue");
				},
			}),
			{ kind: "runner", tier: "local", runner: "hobo-local-host" },
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

	it("connects the fleet command to GitHub observations and starts local work only on fallback", async () => {
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
			mkdirSync(join(repo, "scripts/ci"), { recursive: true });
			mkdirSync(join(repo, ".github/workflows"), { recursive: true });
			mkdirSync(join(repo, ".hobo"), { recursive: true });
			writeFileSync(join(repo, ".gitignore"), ".hobo/attestations-out/\n");
			writeFileSync(
				join(repo, ".hobo/ci.json"),
				readFileSync(new URL("../../.hobo/ci.json", import.meta.url), "utf8"),
			);
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
			writeWorkflow("git hobo-test-advance\necho fleet-fixture-ran");
			git(repo, [
				"add",
				"tracked.txt",
				".gitignore",
				".github",
				".hobo",
				"scripts",
			]);
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
if [ "$1" = repo ]; then
  case "$*" in
    *--jq*) echo acme/app ;;
    *) echo '{"nameWithOwner":"acme/app","url":"https://github.com/acme/app"}' ;;
  esac
  exit 0
fi
if [ "$1" = signoff ] && [ "$2" = --help ]; then
  [ "\${HOBO_FLEET_MISSING_SIGNOFF:-0}" = 1 ] && exit 1
  if [ -n "\${HOBO_FLEET_ADVANCE_AT_HELP:-}" ]; then
    git --git-dir="$HOBO_FLEET_REMOTE" update-ref refs/heads/main "$HOBO_FLEET_ADVANCE_AT_HELP"
  fi
  echo --commit; exit 0
fi
if [ "$1" = signoff ] && [ "$2" = create ]; then exit 0; fi
case "$2" in
  'repos/{owner}/{repo}/branches/main') git rev-parse refs/remotes/origin/main ;;
  */git/ref/hobo/routing-slip)
    [ -n "\${HOBO_FLEET_SLIP:-}" ] || exit 1
    echo '{"object":{"type":"commit","sha":"5555555555555555555555555555555555555555"}}' ;;
  */git/commits/*)
    [ -n "\${HOBO_FLEET_SLIP:-}" ] || exit 1
    cat "$HOBO_FLEET_SLIP" ;;
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
			writeFileSync(join(bin, "remote-path"), remote);
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh
tool_dir="\${0%/*}"
if [ "$1" = hobo-test-advance ]; then
  if [ -f "$tool_dir/advance-base" ]; then
    /usr/bin/git --git-dir="$(cat "$tool_dir/remote-path")" update-ref refs/heads/main "$(cat "$tool_dir/advance-base")"
    rm "$tool_dir/advance-base"
  fi
  exit 0
fi
exec /usr/bin/git "$@"
`,
				{ mode: 0o755 },
			);
			const commandEnv = {
				...isolatedEnv,
				PATH: `${bin}:${isolatedEnv.PATH ?? ""}`,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				HOBO_CI_ATTESTOR_KEY: join(root, "keys", "attestor.pem"),
				HOBO_FLEET_CALLS: calls,
				HOBO_FLEET_RUNS: runs,
				HOBO_FLEET_JOBS: jobs,
				HOBO_FLEET_REMOTE: remote,
			};
			const command = (
				extra: NodeJS.ProcessEnv = {},
				flags: string[] = [],
				policyCurrent = true,
			) =>
				spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--no-warnings",
						fileURLToPath(new URL("../ci/local-attest.mts", import.meta.url)),
						"fleet",
						"--local-signoff",
						...(policyCurrent ? ["--policy-current"] : []),
						...flags,
					],
					{
						cwd: repo,
						encoding: "utf8",
						env: { ...commandEnv, ...extra },
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
			assert.deepEqual(
				await observeFleetVerification({
					cwd: repo,
					env: commandEnv,
					localSignoffEnabled: true,
					policyCurrent: JSON.parse('"false"'),
				}),
				{ kind: "wait", reason: "availability-unknown" },
			);
			writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
			const unverified = command({}, [], false);
			assert.notEqual(unverified.status, 0);
			assert.match(unverified.stdout, /waiting \(availability-unknown\)/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			const missing = command({ HOBO_FLEET_MISSING_SIGNOFF: "1" });
			assert.notEqual(missing.status, 0);
			assert.match(missing.stderr, /install or upgrade basecamp\/gh-signoff/u);
			const fallback = command();
			assert.notEqual(fallback.status, 0);
			assert.match(fallback.stdout, /running the local signoff fallback/u);
			assert.match(fallback.stderr, /working tree is not clean/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);

			// A valid refusal slip and an asserted hosted outage cannot turn a
			// malformed queue response into evidence of runner unavailability.
			const slip = join(root, "slip.json");
			const rejected = {
				runner: "ubuntu-24.04",
				tier: "github",
				reason: "no-node",
			};
			writeFileSync(
				slip,
				JSON.stringify({
					sha: "5".repeat(40),
					message: JSON.stringify({
						version: 1,
						repository: "acme/app",
						issuedAt: at(60),
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						classes: { pr: rejected, fork: rejected, trunk: rejected },
						relay: { nodeId: "fixture", commit: "a".repeat(40) },
					}),
				}),
			);
			const downJobs = readFileSync(jobs, "utf8");
			writeFileSync(jobs, "{}");
			const malformed = command({ HOBO_FLEET_SLIP: slip }, [
				"--github-unavailable",
			]);
			assert.notEqual(malformed.status, 0);
			assert.match(malformed.stdout, /waiting \(availability-unknown\)/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			writeFileSync(jobs, downJobs);
			const validRuns = readFileSync(runs, "utf8");
			writeFileSync(runs, "{}");
			const malformedRuns = command({ HOBO_FLEET_SLIP: slip }, [
				"--github-unavailable",
			]);
			assert.notEqual(malformedRuns.status, 0);
			assert.match(malformedRuns.stdout, /waiting \(availability-unknown\)/u);
			writeFileSync(runs, validRuns);
			const validRefusal = command({ HOBO_FLEET_SLIP: slip }, [
				"--github-unavailable",
			]);
			assert.match(validRefusal.stdout, /running the local signoff fallback/u);
			assert.match(validRefusal.stderr, /working tree is not clean/u);

			// A committed local workflow runs end to end and reaches gh-signoff.
			rmSync(join(repo, "dirty.txt"));
			git(repo, ["switch", "--quiet", "-c", "feature"]);
			const baseA = git(repo, ["rev-parse", "refs/remotes/origin/main"])
				.toString()
				.trim();
			git(repo, [
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"--quiet",
				"-m",
				"future base",
			]);
			const baseB = git(repo, ["rev-parse", "HEAD"]).toString().trim();
			writeFileSync(join(repo, "feature.txt"), "feature\n");
			git(repo, ["add", "feature.txt"]);
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
			// Advance A→B after observation and before the run fetches its base.
			const baseChangedBeforeRun = command(
				{ HOBO_FLEET_ADVANCE_AT_HELP: baseB },
				["--fresh"],
			);
			assert.notEqual(baseChangedBeforeRun.status, 0);
			assert.match(
				baseChangedBeforeRun.stderr,
				/fleet-observed base changed/u,
				`${baseChangedBeforeRun.stdout}\n${baseChangedBeforeRun.stderr}`,
			);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			git(remote, ["update-ref", "refs/heads/main", baseA]);
			git(repo, ["update-ref", "refs/remotes/origin/main", baseA]);
			// Advance A→B while local checks run, before the final signoff.
			writeFileSync(join(bin, "advance-base"), baseB);
			const baseChangedBeforeSignoff = command({}, ["--fresh"]);
			assert.notEqual(baseChangedBeforeSignoff.status, 0);
			assert.match(
				baseChangedBeforeSignoff.stderr,
				/base|remote|changed|tip/iu,
			);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			git(remote, ["update-ref", "refs/heads/main", baseA]);
			git(repo, ["update-ref", "refs/remotes/origin/main", baseA]);
			const success = command({}, ["--fresh"]);
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

			// A changed PR job policy is rejected before posting a new status.
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
			assert.match(
				failed.stdout,
				/local job policy for ci-guard differs from the base/u,
			);
			assert.match(failed.stderr, /no local job has a trusted signoff policy/u);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				1,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
