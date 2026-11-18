import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
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
	FLEET_CLOCK_SKEW_MS,
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
		providerUnavailable?: readonly string[];
		runnerUnavailable?: readonly string[];
	} = {},
) =>
	planFleetVerification({
		settings,
		localSignoffEnabled: options.localSignoffEnabled ?? true,
		githubUnavailable: options.githubUnavailable ?? false,
		overflow: options.overflow ?? [],
		providerUnavailable: options.providerUnavailable ?? [],
		runnerUnavailable: options.runnerUnavailable ?? [],
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

	it("quarantines future queues and impossible pickups before deciding availability", async () => {
		const future = now + FLEET_CLOCK_SKEW_MS + 60_000;
		const futureQueued = ["hobo", "hobo-local-host", "ubuntu-24.04"].flatMap(
			(label) =>
				Array.from(
					{ length: 4 },
					(_, index): SeenJob => ({
						runId: index + 1,
						labels: [label],
						createdAtMs: future,
					}),
				),
		);
		const assertions = {
			githubUnavailable: true,
			runnerUnavailable: ["fleet", "local"],
		};
		assert.deepEqual(await plan(queue(futureQueued), assertions), {
			kind: "wait",
			reason: "availability-unknown",
		});
		for (const invalid of [
			{ ...picked("hobo"), createdAtMs: future, startedAtMs: future + 1_000 },
			{ ...picked("hobo"), createdAtMs: now - 1_000, startedAtMs: now - 2_000 },
			{ ...picked("hobo"), createdAtMs: Number.NaN },
			{ ...picked("hobo"), startedAtMs: Number.POSITIVE_INFINITY },
		]) {
			assert.deepEqual(await plan(queue([invalid]), assertions), {
				kind: "wait",
				reason: "availability-unknown",
			});
			assert.deepEqual(
				await plan(queue([invalid, picked("ubuntu-24.04")]), assertions),
				{
					kind: "runner",
					tier: "github",
					runner: "ubuntu-24.04",
				},
			);
		}
	});

	it("accepts a small forward clock skew and leaves pins authoritative", async () => {
		const withinSkew = {
			...picked("hobo"),
			createdAtMs: now + 2_000,
			startedAtMs: now + FLEET_CLOCK_SKEW_MS,
		};
		assert.deepEqual(await plan(queue([withinSkew])), {
			kind: "runner",
			tier: "fleet",
			runner: "hobo",
		});
		const pinned: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "pinned",
				slip: { kind: "used", reason: "pinned", from: "node@abc" },
			},
		};
		assert.deepEqual(
			await plan(
				queue([{ ...withinSkew, startedAtMs: now + FLEET_CLOCK_SKEW_MS + 1 }]),
				{ slip: pinned },
			),
			{ kind: "runner", tier: "github", runner: "ubuntu-24.04" },
		);
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

	it("includes opaque labels in the queue lookup", async () => {
		let observedLabels: readonly string[] = [];
		const choice = await planFleetVerification({
			settings,
			localSignoffEnabled: true,
			overflow: [{ id: "ci:sandbox", runsOn: "sandbox", observable: false }],
			providerUnavailable: ["ci:sandbox"],
			readSlip: async () => noSlip,
			readQueue: async (_fleet, _busy, labels) => {
				observedLabels = labels;
				return queue([
					waiting("hobo"),
					waiting("hobo-local-host"),
					waiting("ubuntu-24.04"),
					picked("sandbox"),
				]);
			},
			nowMs: now,
		});
		assert.deepEqual(observedLabels, ["sandbox"]);
		assert.deepEqual(choice, { kind: "wait", reason: "availability-unknown" });
	});

	it("does not declare multi-label pickups down, or infer refusal from multi-label queues", async () => {
		const multi = (label: string): SeenJob => ({
			...picked(label),
			labels: ["self-hosted", label],
		});
		const runners = ["fleet", "local"];
		for (const label of ["hobo", "hobo-local-host", "ubuntu-24.04"]) {
			assert.deepEqual(
				await plan(queue([multi(label)]), {
					githubUnavailable: true,
					runnerUnavailable: runners,
				}),
				{ kind: "wait", reason: "availability-unknown" },
			);
		}
		for (const observable of [true, false]) {
			const overflow = [{ id: "ci:extra", runsOn: "sandbox", observable }];
			assert.deepEqual(
				await plan(queue([multi("sandbox")]), {
					githubUnavailable: true,
					runnerUnavailable: runners,
					overflow,
					providerUnavailable: ["ci:extra"],
				}),
				{ kind: "wait", reason: "availability-unknown" },
			);
		}
		const pending: SeenJob = {
			runId: 1,
			labels: ["self-hosted", "hobo"],
			createdAtMs: now - 500_000,
		};
		assert.deepEqual(await plan(queue([pending])), {
			kind: "wait",
			reason: "availability-unknown",
		});
		assert.deepEqual(
			await plan(queue([pending]), {
				githubUnavailable: true,
				runnerUnavailable: runners,
			}),
			{ kind: "local-signoff" },
		);
		const stale: SeenJob = {
			...multi("hobo"),
			createdAtMs: now - 1_002_000,
			startedAtMs: now - 1_000_000,
		};
		const slow: SeenJob = {
			...multi("hobo"),
			createdAtMs: now - 500_000,
			startedAtMs: now - 8_000,
		};
		for (const job of [stale, slow])
			assert.deepEqual(
				await plan(queue([job]), {
					githubUnavailable: true,
					runnerUnavailable: runners,
				}),
				{ kind: "local-signoff" },
			);
	});

	it("requires a separate outage assertion for every provider and still prefers healthy runners", async () => {
		const overflow = [
			{ id: "ci:sandbox", runsOn: "sandbox", observable: false },
			{ id: "ci:worker", runsOn: "worker", observable: false },
		];
		const down = [
			waiting("hobo"),
			waiting("hobo-local-host"),
			waiting("ubuntu-24.04"),
		];
		assert.deepEqual(
			await plan(queue(down), {
				overflow,
				providerUnavailable: ["ci:sandbox"],
			}),
			{ kind: "wait", reason: "availability-unknown" },
		);
		const assertions = ["ci:sandbox", "ci:worker"];
		assert.deepEqual(
			await plan(queue(down), { overflow, providerUnavailable: assertions }),
			{ kind: "local-signoff" },
		);
		assert.deepEqual(
			await plan(queue([picked("hobo")]), {
				overflow,
				providerUnavailable: assertions,
			}),
			{ kind: "runner", tier: "fleet", runner: "hobo" },
		);
		assert.deepEqual(
			await plan(queue([waiting("hobo"), picked("hobo-local-host")]), {
				overflow,
				providerUnavailable: assertions,
			}),
			{ kind: "runner", tier: "local", runner: "hobo-local-host" },
		);
		const arc = { id: "ci:arc", runsOn: "hobo-arc", observable: true };
		assert.deepEqual(
			await plan(queue([waiting("hobo"), picked("hobo-arc")]), {
				overflow: [...overflow, arc],
				providerUnavailable: assertions,
			}),
			{ kind: "runner", tier: "overflow", runner: "hobo-arc" },
		);
		const pinned: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "pinned",
				slip: { kind: "used", reason: "pinned", from: "node@abc" },
			},
		};
		assert.deepEqual(
			await plan(queue(down), {
				overflow,
				providerUnavailable: assertions,
				slip: pinned,
			}),
			{ kind: "runner", tier: "github", runner: "ubuntu-24.04" },
		);
		const observable = [{ id: "ci:arc", runsOn: "hobo-arc", observable: true }];
		assert.deepEqual(
			await plan(queue(down), {
				overflow: observable,
				providerUnavailable: ["ci:arc"],
			}),
			{ kind: "local-signoff" },
		);
		assert.deepEqual(
			await plan(queue([...down, picked("hobo-arc")]), {
				overflow: observable,
				providerUnavailable: ["ci:arc"],
			}),
			{ kind: "runner", tier: "overflow", runner: "hobo-arc" },
		);
		assert.deepEqual(
			await plan(queue([...down, picked("sandbox")]), {
				overflow,
				providerUnavailable: assertions,
			}),
			{ kind: "wait", reason: "availability-unknown" },
		);
	});

	it("uses independently observed fleet and local outages only without healthy pickups", async () => {
		const both = ["fleet", "local"];
		assert.deepEqual(await plan(queue([]), { githubUnavailable: true }), {
			kind: "wait",
			reason: "availability-unknown",
		});
		assert.deepEqual(
			await plan(queue([]), {
				githubUnavailable: true,
				runnerUnavailable: ["fleet"],
			}),
			{
				kind: "wait",
				reason: "availability-unknown",
			},
		);
		assert.deepEqual(
			await plan(queue([]), {
				githubUnavailable: true,
				runnerUnavailable: both,
			}),
			{
				kind: "local-signoff",
			},
		);
		assert.deepEqual(
			await plan(queue([picked("hobo")]), {
				githubUnavailable: true,
				runnerUnavailable: both,
			}),
			{
				kind: "runner",
				tier: "fleet",
				runner: "hobo",
			},
		);
		assert.deepEqual(
			await plan(queue([picked("hobo-local-host")]), {
				githubUnavailable: true,
				runnerUnavailable: both,
			}),
			{
				kind: "runner",
				tier: "local",
				runner: "hobo-local-host",
			},
		);
		assert.deepEqual(
			await plan(queue([picked("hobo")], 1), {
				githubUnavailable: true,
				runnerUnavailable: both,
			}),
			{
				kind: "wait",
				reason: "availability-unknown",
			},
		);
		const pinned: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "pinned",
				slip: { kind: "used", reason: "pinned", from: "node@abc" },
			},
		};
		assert.deepEqual(
			await plan(queue([]), {
				githubUnavailable: true,
				runnerUnavailable: both,
				slip: pinned,
			}),
			{
				kind: "runner",
				tier: "github",
				runner: "ubuntu-24.04",
			},
		);
	});

	it("prefers fresh healthy fleet evidence over an older fallback slip", async () => {
		const slip: SlipReading = {
			ok: true,
			decision: {
				tier: "github",
				runner: "ubuntu-24.04",
				reason: "no-node",
				slip: { kind: "used", reason: "no-node", from: "node@abc" },
			},
		};
		assert.deepEqual(
			await plan(queue([picked("hobo")]), {
				slip,
				githubUnavailable: true,
				runnerUnavailable: ["fleet"],
			}),
			{
				kind: "runner",
				tier: "fleet",
				runner: "hobo",
			},
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
			const policyFile = join(repo, ".hobo/ci.json");
			const originalPolicy = readFileSync(policyFile, "utf8");
			const makePolicyBranch = (name: string, policy: string) => {
				git(repo, ["switch", "--quiet", "-c", name]);
				writeFileSync(policyFile, policy);
				git(repo, ["add", ".hobo/ci.json"]);
				git(repo, [
					"-c",
					"commit.gpgsign=false",
					"commit",
					"--quiet",
					"-m",
					name,
				]);
				git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${name}`]);
				git(repo, ["update-ref", `refs/remotes/origin/${name}`, "HEAD"]);
				git(repo, ["switch", "--quiet", "main"]);
			};
			const opaquePolicy = JSON.parse(originalPolicy);
			opaquePolicy.environments.ci.policy.providers[0].enabled = true;
			opaquePolicy.environments.production.policy.providers[0].enabled = true;
			opaquePolicy.environments.ci.policy.providers[3].enabled = true;
			makePolicyBranch("opaque-policy", JSON.stringify(opaquePolicy));
			const inventoryPolicy = JSON.parse(originalPolicy);
			inventoryPolicy.environments.ci.policy.providers[3].enabled = true;
			inventoryPolicy.integrations[0].enabled = true;
			inventoryPolicy.runnerRouting.externalPools = [
				{ labels: ["pool.ubuntu-1"], runnerNamePrefix: "pool-", maxRunners: 1 },
			];
			makePolicyBranch("inventory-policy", JSON.stringify(inventoryPolicy));
			const localPolicy = JSON.parse(originalPolicy);
			localPolicy.runnerRouting.localRunner = true;
			makePolicyBranch("local-policy", JSON.stringify(localPolicy));
			const localProviderPolicy = JSON.parse(originalPolicy);
			localProviderPolicy.environments.local.policy.providers[0].enabled = true;
			makePolicyBranch(
				"local-provider-policy",
				JSON.stringify(localProviderPolicy),
			);
			const manyPolicy = JSON.parse(originalPolicy);
			const manyProviders = (count: number) =>
				Array.from({ length: count }, (_, index) => ({
					id: `provider-${index}`,
					kind: "blacksmith",
					connectionRef: `connection-${index}`,
					runsOn: `runner-${index}`,
					enabled: true,
				}));
			manyPolicy.environments.ci.policy.providers = manyProviders(100);
			manyPolicy.environments.production.policy.providers = manyProviders(1);
			makePolicyBranch("many-policy", JSON.stringify(manyPolicy));
			const pinnedPolicy = JSON.parse(originalPolicy);
			pinnedPolicy.runnerRouting.pin = "github";
			makePolicyBranch("pinned-policy", JSON.stringify(pinnedPolicy));
			const malformedPolicy = JSON.parse(originalPolicy);
			malformedPolicy.environments.ci.policy.providers[3] = {
				$ref: "#/definitions/arc",
			};
			makePolicyBranch("malformed-policy", JSON.stringify(malformedPolicy));
			const at = (seconds: number) =>
				new Date(Date.now() - seconds * 1000).toISOString();
			const runs = join(root, "runs.json");
			const jobs = join(root, "jobs.json");
			const calls = join(root, "calls");
			writeFileSync(
				runs,
				JSON.stringify({
					workflow_runs: [
						{
							id: 123,
							status: "in_progress",
							path: ".github/workflows/hobo-ci.yml",
							created_at: at(500),
							updated_at: at(500),
						},
					],
				}),
			);
			writeFileSync(
				join(bin, "gh"),
				`#!/bin/sh
printf '%s\\n' "$*" >> "$HOBO_FLEET_CALLS"
if [ "$1" = repo ]; then
  case "$*" in
    *" -- "*)
      if [ "\${HOBO_FLEET_OTHER_REMOTE:-0}" = 1 ]; then
        echo '{"nameWithOwner":"other/app","url":"https://github.com/other/app"}'; exit 0
      fi ;;
  esac
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
if [ "$1" = api ] && [ "$2" = 'user/installations?per_page=100' ]; then
  [ -n "\${HOBO_STATUS_INSTALLATIONS:-}" ] || exit 1
  printf '%s\\n' "$HOBO_STATUS_INSTALLATIONS"; exit 0
fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  [ -n "\${HOBO_FLEET_QUEUE:-}" ] || exit 1
  cat "$HOBO_FLEET_QUEUE"; exit 0
fi
if [ "$1" = pr ]; then
  [ -n "\${HOBO_FLEET_PR_DIR:-}" ] || exit 1
  echo 17; exit 0
fi
if [ "$1" = api ] && [ "$2" = --hostname ]; then
  [ -n "\${HOBO_FLEET_PR_DIR:-}" ] || exit 1
  case "$4" in
    'repos/{owner}/{repo}/pulls/17')
      if [ "\${HOBO_FLEET_PR_CLOSED:-0}" = 1 ] || [ -f "\${0%/*}/pr-closed" ]; then cat "$HOBO_FLEET_PR_DIR/closed.json"
      elif [ -f "\${0%/*}/pr-changed" ]; then cat "$HOBO_FLEET_PR_DIR/changed-pull.json"
      else cat "$HOBO_FLEET_PR_DIR/pull.json"; fi ;;
    'repos/{owner}/{repo}/branches/main') cat "$HOBO_FLEET_PR_DIR/base-branch.json" ;;
    'repos/{owner}/{repo}') cat "$HOBO_FLEET_PR_DIR/base.json" ;;
    'repos/contributor/app')
      if [ -f "\${0%/*}/pr-changed" ]; then cat "$HOBO_FLEET_PR_DIR/changed-fork.json"; else cat "$HOBO_FLEET_PR_DIR/fork.json"; fi ;;
    'repos/contributor/app/branches/topic') cat "$HOBO_FLEET_PR_DIR/branch.json" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$2" in
  'repos/{owner}/{repo}/branches/main') git rev-parse refs/remotes/origin/main ;;
  */branches/gh-readonly-queue%2F*) printf '%s\\n' "$HOBO_FLEET_GROUP_HEAD" ;;
  'repos/{owner}/{repo}/branches/feature') git --git-dir="$HOBO_FLEET_REMOTE" rev-parse refs/heads/feature ;;
  */git/ref/hobo/routing-slip)
    [ -n "\${HOBO_FLEET_SLIP:-}" ] || exit 1
    echo '{"object":{"type":"commit","sha":"5555555555555555555555555555555555555555"}}' ;;
  */git/commits/*)
    [ -n "\${HOBO_FLEET_SLIP:-}" ] || exit 1
    cat "$HOBO_FLEET_SLIP" ;;
  */actions/runs\\?*) cat "$HOBO_FLEET_RUNS" ;;
  */actions/runs/124/jobs\\?*)
    [ -n "\${HOBO_FLEET_JOBS_LATER:-}" ] || exit 1
    cat "$HOBO_FLEET_JOBS_LATER" ;;
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
if [ "\${HOBO_FLEET_OLD_GIT:-0}" = 1 ] && [ "$1" = --no-lazy-fetch ]; then
  exit 129
fi
if [ "$1" = hobo-test-advance ]; then
  if [ -f "$tool_dir/change-queue-on-job" ]; then
    printf '%s\\n' '{"data":{"repository":{"pullRequest":null}}}' > "$HOBO_FLEET_QUEUE"
  fi
  if [ -f "$tool_dir/close-pr-on-job" ]; then
    touch "$tool_dir/pr-closed"
  fi
  if [ -f "$tool_dir/change-pr-on-job" ]; then
    touch "$tool_dir/pr-changed"
  fi
  if [ -f "$tool_dir/fail-job" ]; then
    echo failed > "$tool_dir/failed-command"
    exit 1
  fi
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
			const supportsNoLazyFetch =
				spawnSync(join(bin, "git"), ["--no-lazy-fetch", "--version"], {
					env: commandEnv,
					stdio: "ignore",
				}).status === 0;
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
			const observedBase = git(repo, ["rev-parse", "refs/remotes/origin/main"])
				.toString()
				.trim();
			const replacementBase = git(repo, [
				"rev-parse",
				"refs/remotes/origin/pinned-policy",
			])
				.toString()
				.trim();
			git(repo, ["replace", observedBase, replacementBase]);
			const replacedPolicy = command();
			assert.equal(replacedPolicy.status, 0, replacedPolicy.stderr);
			assert.match(replacedPolicy.stdout, /fleet runner hobo/u);
			git(repo, ["replace", "-d", observedBase]);
			for (const flags of [["--pr=0"], ["--pr=17", "--pr=18"], ["--pr"]]) {
				const invalidPr = command({}, flags);
				assert.notEqual(invalidPr.status, 0);
				assert.match(invalidPr.stderr, /--pr must be specified once/u);
			}
			const assertionWithRunner = command({}, [
				"--base=origin/opaque-policy",
				"--provider-unavailable=ci:vercel-sandbox",
				"--provider-unavailable=production:vercel-sandbox",
			]);
			assert.equal(assertionWithRunner.status, 0, assertionWithRunner.stderr);
			assert.match(assertionWithRunner.stdout, /fleet runner hobo/u);
			for (const flags of [
				["--provider-unavailable=ci:typo"],
				["--runner-unavailable=local"],
			]) {
				const result = command({}, flags);
				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stdout, /fleet runner hobo/u);
			}
			for (const mismatch of [
				{ GH_REPO: "other/app" },
				{ GH_HOST: "other.example" },
				{ HOBO_FLEET_OTHER_REMOTE: "1" },
			]) {
				const before = readFileSync(calls, "utf8").length;
				const result = command(mismatch);
				assert.notEqual(result.status, 0);
				assert.match(result.stdout, /waiting \(availability-unknown\)/u);
				const newCalls = readFileSync(calls, "utf8").slice(before);
				assert.doesNotMatch(newCalls, /actions\/runs|git\/ref|signoff/u);
			}
			const badRemote = "token1@token2@github.com:acme/app.git";
			git(repo, ["remote", "set-url", "origin", badRemote]);
			const beforeMalformedRemote = readFileSync(calls, "utf8").length;
			const malformedRemote = command();
			assert.notEqual(malformedRemote.status, 0);
			assert.match(malformedRemote.stdout, /waiting \(availability-unknown\)/u);
			assert.doesNotMatch(
				`${malformedRemote.stdout}\n${malformedRemote.stderr}\n${readFileSync(calls, "utf8").slice(beforeMalformedRemote)}`,
				/token1|token2/u,
			);
			git(repo, ["remote", "set-url", "origin", remote]);
			const pinnedSlip = join(root, "pinned-slip.json");
			const pin = { runner: "ubuntu-24.04", tier: "github", reason: "pinned" };
			const refreshPinnedSlip = () =>
				writeFileSync(
					pinnedSlip,
					JSON.stringify({
						sha: "5".repeat(40),
						message: JSON.stringify({
							version: 1,
							repository: "acme/app",
							issuedAt: at(60),
							expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
							classes: { pr: pin, fork: pin, trunk: pin },
							relay: { nodeId: "fixture", commit: "a".repeat(40) },
						}),
					}),
				);
			refreshPinnedSlip();
			const beforePin = readFileSync(calls, "utf8").length;
			const pinnedMalformed = command({ HOBO_FLEET_SLIP: pinnedSlip }, [
				"--base=origin/malformed-policy",
			]);
			assert.equal(pinnedMalformed.status, 0, pinnedMalformed.stderr);
			assert.match(pinnedMalformed.stdout, /github runner ubuntu-24\.04/u);
			assert.doesNotMatch(
				readFileSync(calls, "utf8").slice(beforePin),
				/actions\/runs|signoff/u,
			);
			const pinnedWithTypo = command({ HOBO_FLEET_SLIP: pinnedSlip }, [
				"--provider-unavailable=ci:typo",
			]);
			assert.equal(pinnedWithTypo.status, 0, pinnedWithTypo.stderr);
			assert.match(pinnedWithTypo.stdout, /github runner ubuntu-24\.04/u);
			const configuredPin = command({}, [
				"--base=origin/pinned-policy",
				"--runner-unavailable=fleet",
			]);
			assert.equal(configuredPin.status, 0, configuredPin.stderr);
			assert.match(configuredPin.stdout, /github runner ubuntu-24\.04/u);
			const malformedBeforePin = command({}, [
				"--base=origin/pinned-policy",
				"--runner-unavailable=typo",
			]);
			assert.notEqual(malformedBeforePin.status, 0);
			assert.match(
				malformedBeforePin.stderr,
				/--runner-unavailable requires fleet or local/u,
			);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: ["hobo", "ubuntu-24.04"].map((label) => ({
						run_id: 123,
						status: "queued",
						labels: [label],
						created_at: at(500),
						runner_name: null,
						started_at: null,
					})),
				}),
			);
			const opaqueFlags = [
				"--base=origin/opaque-policy",
				"--provider-unavailable=ci:vercel-sandbox",
				"--provider-unavailable=production:vercel-sandbox",
			];
			const observeOpaque = (
				providerUnavailable: string[],
				policyCurrent = true,
			) =>
				observeFleetVerification({
					cwd: repo,
					env: commandEnv,
					baseRef: "origin/opaque-policy",
					localSignoffEnabled: true,
					policyCurrent,
					providerUnavailable,
				});
			const allOpaque = ["ci:vercel-sandbox", "production:vercel-sandbox"];
			assert.deepEqual(await observeOpaque([allOpaque[0] ?? ""]), {
				kind: "wait",
				reason: "availability-unknown",
			});
			// ARC is enabled too; silence is still unknown despite both opaque assertions.
			assert.deepEqual(await observeOpaque(allOpaque), {
				kind: "wait",
				reason: "availability-unknown",
			});
			const queued = JSON.parse(readFileSync(jobs, "utf8"));
			queued.jobs.push({
				run_id: 123,
				status: "queued",
				labels: ["hobo-arc"],
				created_at: at(500),
				runner_name: null,
				started_at: null,
			});
			writeFileSync(jobs, JSON.stringify(queued));
			assert.deepEqual(
				await observeFleetVerification({
					cwd: repo,
					env: commandEnv,
					baseRef: "origin/malformed-policy",
					localSignoffEnabled: true,
					policyCurrent: true,
				}),
				{ kind: "wait", reason: "availability-unknown" },
			);
			assert.deepEqual(await observeOpaque(allOpaque, false), {
				kind: "wait",
				reason: "availability-unknown",
			});
			const unverifiedOpaque = command({}, opaqueFlags, false);
			assert.notEqual(unverifiedOpaque.status, 0);
			assert.match(
				unverifiedOpaque.stdout,
				/waiting \(availability-unknown\)/u,
			);
			assert.deepEqual(await observeOpaque(allOpaque), {
				kind: "local-signoff",
				baseSha: git(repo, ["rev-parse", "origin/opaque-policy"])
					.toString()
					.trim(),
			});
			// A live Actions pickup sharing an opaque label blocks its outage claim.
			const sharedLabel = {
				jobs: [
					...queued.jobs,
					{
						run_id: 123,
						status: "completed",
						labels: ["sandbox"],
						runner_name: "fixture",
						created_at: at(10),
						started_at: at(8),
					},
				],
			};
			writeFileSync(jobs, JSON.stringify(sharedLabel));
			assert.deepEqual(await observeOpaque(allOpaque), {
				kind: "wait",
				reason: "availability-unknown",
			});
			const multiShared = {
				jobs: [
					...queued.jobs,
					{
						run_id: 123,
						status: "completed",
						labels: ["self-hosted", "sandbox"],
						runner_name: "fixture",
						created_at: at(10),
						started_at: at(8),
					},
				],
			};
			writeFileSync(jobs, JSON.stringify(multiShared));
			assert.deepEqual(await observeOpaque(allOpaque), {
				kind: "wait",
				reason: "availability-unknown",
			});
			writeFileSync(jobs, JSON.stringify(queued));
			const inventoryAssertions = [
				"ci:hostinger-arc",
				"integration:blacksmith:blacksmith-2vcpu-ubuntu-2404",
				"external-pool:0:pool.ubuntu-1",
			];
			const observeInventory = () =>
				observeFleetVerification({
					cwd: repo,
					env: commandEnv,
					baseRef: "origin/inventory-policy",
					localSignoffEnabled: true,
					policyCurrent: true,
					providerUnavailable: inventoryAssertions,
				});
			assert.deepEqual(await observeInventory(), {
				kind: "local-signoff",
				baseSha: git(repo, ["rev-parse", "origin/inventory-policy"])
					.toString()
					.trim(),
			});
			const healthyArc = {
				jobs: [
					...queued.jobs.filter(
						(entry: { labels: string[] }) => !entry.labels.includes("hobo-arc"),
					),
					{
						run_id: 123,
						status: "completed",
						labels: ["hobo-arc"],
						runner_name: "fixture",
						created_at: at(10),
						started_at: at(8),
					},
				],
			};
			writeFileSync(jobs, JSON.stringify(healthyArc));
			assert.deepEqual(await observeInventory(), {
				kind: "runner",
				tier: "overflow",
				runner: "hobo-arc",
			});
			const multiArc = {
				jobs: [
					...healthyArc.jobs.slice(0, -1),
					{
						run_id: 123,
						status: "completed",
						labels: ["self-hosted", "hobo-arc"],
						runner_name: "fixture",
						created_at: at(10),
						started_at: at(8),
					},
				],
			};
			writeFileSync(jobs, JSON.stringify(multiArc));
			assert.deepEqual(await observeInventory(), {
				kind: "wait",
				reason: "availability-unknown",
			});
			writeFileSync(jobs, JSON.stringify(queued));
			writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
			const assertedInventory = command({}, [
				"--base=origin/inventory-policy",
				...inventoryAssertions.map((id) => `--provider-unavailable=${id}`),
			]);
			assert.match(
				assertedInventory.stdout,
				/preparing the local signoff fallback/u,
			);
			assert.match(assertedInventory.stderr, /working tree is not clean/u);
			rmSync(join(repo, "dirty.txt"));
			// A silent queue needs independently observed outages for both enabled tiers.
			writeFileSync(jobs, JSON.stringify({ jobs: [] }));
			const silent = (
				runnerUnavailable: string[],
				policyCurrent = true,
				baseRef = "origin/local-policy",
			) =>
				observeFleetVerification({
					cwd: repo,
					env: commandEnv,
					baseRef,
					localSignoffEnabled: true,
					githubUnavailable: true,
					policyCurrent,
					runnerUnavailable,
				});
			assert.deepEqual(await silent([]), {
				kind: "wait",
				reason: "availability-unknown",
			});
			assert.deepEqual(await silent(["fleet"]), {
				kind: "wait",
				reason: "availability-unknown",
			});
			assert.deepEqual(await silent(["fleet", "local"], false), {
				kind: "wait",
				reason: "availability-unknown",
			});
			assert.deepEqual(await silent(["fleet", "local"]), {
				kind: "local-signoff",
				baseSha: git(repo, ["rev-parse", "origin/local-policy"])
					.toString()
					.trim(),
			});
			assert.deepEqual(
				await silent(["fleet", "local"], true, "origin/local-provider-policy"),
				{
					kind: "local-signoff",
					baseSha: git(repo, ["rev-parse", "origin/local-provider-policy"])
						.toString()
						.trim(),
				},
			);
			assert.deepEqual(await silent(["local"], true, "origin/main"), {
				kind: "invalid-runner-assertion",
				runner: "local",
			});
			const disabledTier = command({}, [
				"--github-unavailable",
				"--runner-unavailable=local",
			]);
			assert.notEqual(disabledTier.status, 0);
			assert.match(
				disabledTier.stderr,
				/does not name an enabled runner tier/u,
			);
			for (const flags of [
				["--runner-unavailable=typo"],
				["--runner-unavailable=fleet", "--runner-unavailable=fleet"],
			]) {
				const invalid = command({}, flags);
				assert.notEqual(invalid.status, 0);
				assert.match(invalid.stderr, /--runner-unavailable/u);
			}
			writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
			const assertedRunners = command({}, [
				"--base=origin/local-policy",
				"--github-unavailable",
				"--runner-unavailable=fleet",
				"--runner-unavailable=local",
			]);
			assert.match(
				assertedRunners.stdout,
				/preparing the local signoff fallback/u,
			);
			assert.match(assertedRunners.stderr, /working tree is not clean/u);
			const manyFlags = [
				"--base=origin/many-policy",
				"--github-unavailable",
				"--runner-unavailable=fleet",
				...Array.from(
					{ length: 100 },
					(_, index) => `--provider-unavailable=ci:provider-${index}`,
				),
				"--provider-unavailable=production:provider-0",
			];
			const many = command({}, manyFlags);
			assert.match(many.stdout, /preparing the local signoff fallback/u);
			assert.match(many.stderr, /working tree is not clean/u);
			const tooMany = command(
				{},
				Array.from(
					{ length: 4097 },
					(_, index) => `--provider-unavailable=ci:p${index}`,
				),
			);
			assert.notEqual(tooMany.status, 0);
			assert.match(tooMany.stderr, /at most 4096 IDs/u);
			const runnerFlags = [
				"--base=origin/local-policy",
				"--github-unavailable",
				"--runner-unavailable=fleet",
				"--runner-unavailable=local",
			];
			const jobBase = {
				run_id: 123,
				status: "completed",
				labels: ["hobo"],
				created_at: at(10),
				runner_name: "fixture",
				started_at: at(8),
			};
			const subMillisecond = (timestamp: string, digits: string) =>
				timestamp.replace(/Z$/u, `${digits}Z`);
			const sharedTime = at(10);
			for (const invalid of [
				{ ...jobBase, labels: "hobo" },
				{ ...jobBase, labels: ["hobo", 42] },
				{ ...jobBase, labels: [] },
				{ ...jobBase, status: "queued", labels: [], runner_name: null },
				{ ...jobBase, status: "queued" },
				{ ...jobBase, runner_name: null, conclusion: "success" },
				{ ...jobBase, runner_name: "" },
				{ ...jobBase, run_id: "123" },
				{ ...jobBase, runner_name: 42 },
				{ ...jobBase, started_at: "bad-time" },
				{ ...jobBase, created_at: "0" },
				{ ...jobBase, started_at: "2026-02-29T12:00:00Z" },
				{ ...jobBase, created_at: at(-120), started_at: at(-115) },
				{ ...jobBase, created_at: at(1), started_at: at(2) },
				{
					...jobBase,
					created_at: subMillisecond(sharedTime, "9"),
					started_at: subMillisecond(sharedTime, "1"),
				},
				{
					...jobBase,
					started_at: subMillisecond(jobBase.started_at, "0000000"),
				},
				{
					...jobBase,
					status: "queued",
					runner_name: null,
					started_at: null,
					created_at: at(-120),
				},
			]) {
				writeFileSync(jobs, JSON.stringify({ jobs: [invalid] }));
				const result = command({}, runnerFlags);
				assert.notEqual(result.status, 0);
				assert.match(result.stdout, /waiting \(availability-unknown\)/u);
			}
			const futureQueue = ["hobo", "hobo-local-host", "ubuntu-24.04"].flatMap(
				(label) =>
					Array.from({ length: 4 }, () => ({
						...jobBase,
						status: "queued",
						labels: [label],
						runner_name: null,
						started_at: null,
						created_at: at(-120),
					})),
			);
			writeFileSync(jobs, JSON.stringify({ jobs: futureQueue }));
			const futureRefusal = command({}, runnerFlags);
			assert.notEqual(futureRefusal.status, 0);
			assert.match(futureRefusal.stdout, /waiting \(availability-unknown\)/u);
			refreshPinnedSlip();
			const pinnedWithFuture = command(
				{ HOBO_FLEET_SLIP: pinnedSlip },
				runnerFlags,
			);
			assert.equal(pinnedWithFuture.status, 0, pinnedWithFuture.stderr);
			assert.match(pinnedWithFuture.stdout, /github runner ubuntu-24\.04/u);
			writeFileSync(jobs, JSON.stringify({ jobs: [futureQueue[0], jobBase] }));
			const healthyWithFuture = command({}, runnerFlags);
			assert.equal(healthyWithFuture.status, 0, healthyWithFuture.stderr);
			assert.match(healthyWithFuture.stdout, /fleet runner hobo/u);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: [{ ...jobBase, created_at: at(-5), started_at: at(-10) }],
				}),
			);
			const healthyWithClockSkew = command({}, runnerFlags);
			assert.equal(healthyWithClockSkew.status, 0, healthyWithClockSkew.stderr);
			assert.match(healthyWithClockSkew.stdout, /fleet runner hobo/u);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: [
						{
							...jobBase,
							created_at: subMillisecond(sharedTime, "000001"),
							started_at: subMillisecond(sharedTime, "000009"),
						},
					],
				}),
			);
			const healthyWithNanoseconds = command({}, runnerFlags);
			assert.equal(
				healthyWithNanoseconds.status,
				0,
				healthyWithNanoseconds.stderr,
			);
			assert.match(healthyWithNanoseconds.stdout, /fleet runner hobo/u);
			writeFileSync(
				jobs,
				JSON.stringify({ jobs: [{ ...jobBase, labels: "hobo" }, jobBase] }),
			);
			const healthyWithMalformedJob = command({}, runnerFlags);
			assert.equal(
				healthyWithMalformedJob.status,
				0,
				healthyWithMalformedJob.stderr,
			);
			assert.match(healthyWithMalformedJob.stdout, /fleet runner hobo/u);
			for (const runnerName of [null, ""]) {
				const uncertain = {
					...jobBase,
					status: "in_progress",
					runner_name: runnerName,
				};
				writeFileSync(jobs, JSON.stringify({ jobs: [uncertain] }));
				const noCapacity = command({}, runnerFlags);
				assert.notEqual(noCapacity.status, 0);
				assert.match(noCapacity.stdout, /waiting \(availability-unknown\)/u);
				writeFileSync(jobs, JSON.stringify({ jobs: [uncertain, jobBase] }));
				const healthy = command({}, runnerFlags);
				assert.equal(healthy.status, 0, healthy.stderr);
				assert.match(healthy.stdout, /fleet runner hobo/u);
			}
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: [{ ...jobBase, labels: ["self-hosted", "hobo"] }],
				}),
			);
			const multiLabelFleet = command({}, runnerFlags);
			assert.notEqual(multiLabelFleet.status, 0);
			assert.match(multiLabelFleet.stdout, /waiting \(availability-unknown\)/u);
			const validRun = {
				id: 123,
				status: "in_progress",
				path: ".github/workflows/hobo-ci.yml",
				created_at: at(500),
				updated_at: at(500),
			};
			writeFileSync(jobs, JSON.stringify({ jobs: [] }));
			for (const invalid of [
				{ ...validRun, id: "123" },
				{ ...validRun, status: 42 },
				{ ...validRun, path: null },
				{ ...validRun, path: "" },
				{ ...validRun, path: "   " },
				{ ...validRun, created_at: "bad-time" },
				{ ...validRun, created_at: "0" },
				{ ...validRun, updated_at: "2026-02-29T12:00:00Z" },
				{ ...validRun, updated_at: null },
				{ ...validRun, created_at: at(-120), updated_at: at(-115) },
				{ ...validRun, created_at: at(2), updated_at: at(3) },
				{
					...validRun,
					created_at: subMillisecond(sharedTime, "9"),
					updated_at: subMillisecond(sharedTime, "1"),
				},
			]) {
				writeFileSync(runs, JSON.stringify({ workflow_runs: [invalid] }));
				const result = command({}, runnerFlags);
				assert.notEqual(result.status, 0);
				assert.match(result.stdout, /waiting \(availability-unknown\)/u);
			}
			writeFileSync(
				runs,
				JSON.stringify({
					workflow_runs: [{ ...validRun, id: "broken" }, validRun],
				}),
			);
			writeFileSync(jobs, JSON.stringify({ jobs: [jobBase] }));
			const healthyWithMalformedRun = command({}, runnerFlags);
			assert.equal(
				healthyWithMalformedRun.status,
				0,
				`${healthyWithMalformedRun.stderr}\n${healthyWithMalformedRun.stdout}`,
			);
			assert.match(healthyWithMalformedRun.stdout, /fleet runner hobo/u);
			writeFileSync(
				runs,
				JSON.stringify({
					workflow_runs: [
						{ ...validRun, id: 124, created_at: at(2), updated_at: at(3) },
						validRun,
					],
				}),
			);
			const healthyWithBackwardsRun = command({}, runnerFlags);
			assert.equal(
				healthyWithBackwardsRun.status,
				0,
				`${healthyWithBackwardsRun.stderr}\n${healthyWithBackwardsRun.stdout}`,
			);
			assert.match(healthyWithBackwardsRun.stdout, /fleet runner hobo/u);
			// Freeze the observer clock so one nanosecond either side of the
			// 30-second boundary remains deterministic across process scheduling.
			writeFileSync(runs, JSON.stringify({ workflow_runs: [validRun] }));
			const actualClock = Date.now;
			const frozenNow = actualClock();
			const boundary = new Date(frozenNow + FLEET_CLOCK_SKEW_MS).toISOString();
			const justBefore = subMillisecond(
				new Date(frozenNow + FLEET_CLOCK_SKEW_MS - 1).toISOString(),
				"999999",
			);
			const justAfter = subMillisecond(boundary, "000001");
			const queuedAt = (created_at: string) => ({
				...jobBase,
				status: "queued",
				runner_name: null,
				started_at: null,
				created_at,
			});
			try {
				Date.now = () => frozenNow;
				writeFileSync(jobs, JSON.stringify({ jobs: [queuedAt(justAfter)] }));
				assert.deepEqual(await silent(["fleet", "local"]), {
					kind: "wait",
					reason: "availability-unknown",
				});
				for (const valid of [justBefore, boundary]) {
					writeFileSync(jobs, JSON.stringify({ jobs: [queuedAt(valid)] }));
					const choice = await silent(["fleet", "local"]);
					assert.equal(choice.kind, "local-signoff");
				}
			} finally {
				Date.now = actualClock;
			}
			const laterJobs = join(root, "later-jobs.json");
			writeFileSync(
				runs,
				JSON.stringify({ workflow_runs: [validRun, { ...validRun, id: 124 }] }),
			);
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: ["hobo", "hobo-local-host", "ubuntu-24.04"].map((label) => ({
						run_id: 123,
						status: "queued",
						labels: [label],
						created_at: at(500),
						runner_name: null,
						started_at: null,
					})),
				}),
			);
			writeFileSync(
				laterJobs,
				JSON.stringify({
					jobs: [{ ...jobBase, run_id: 124, labels: ["self-hosted", "hobo"] }],
				}),
			);
			const beforeLater = readFileSync(calls, "utf8").length;
			const laterPickup = command(
				{ HOBO_FLEET_JOBS_LATER: laterJobs },
				runnerFlags,
			);
			assert.notEqual(laterPickup.status, 0);
			assert.match(laterPickup.stdout, /waiting \(availability-unknown\)/u);
			assert.match(
				readFileSync(calls, "utf8").slice(beforeLater),
				/actions\/runs\/124\/jobs/u,
			);
			writeFileSync(
				runs,
				JSON.stringify({ workflow_runs: [{ ...validRun, id: "broken" }] }),
			);
			refreshPinnedSlip();
			const pinWithMalformedQueue = command(
				{ HOBO_FLEET_SLIP: pinnedSlip },
				runnerFlags,
			);
			assert.equal(
				pinWithMalformedQueue.status,
				0,
				`${pinWithMalformedQueue.stderr}\n${pinWithMalformedQueue.stdout}`,
			);
			assert.match(
				pinWithMalformedQueue.stdout,
				/github runner ubuntu-24\.04/u,
			);
			writeFileSync(runs, JSON.stringify({ workflow_runs: [validRun] }));
			writeFileSync(
				jobs,
				JSON.stringify({
					jobs: [
						{
							...jobBase,
							status: "completed",
							labels: [],
							runner_name: null,
							started_at: null,
							conclusion: "skipped",
						},
						{
							...jobBase,
							status: "completed",
							labels: [],
							runner_name: "",
							started_at: at(10),
							conclusion: "cancelled",
						},
						{
							...jobBase,
							status: "pending",
							runner_name: null,
							started_at: at(10).replace(/\.\d{3}Z$/u, "Z"),
						},
						{
							...jobBase,
							status: "queued",
							runner_name: null,
							started_at: at(10),
						},
						{
							...jobBase,
							status: "queued",
							runner_name: "",
							started_at: at(10).replace(/\.\d{3}Z$/u, ".123456789Z"),
						},
					],
				}),
			);
			for (const status of ["completed", "in_progress", "pending", "queued"]) {
				writeFileSync(
					runs,
					JSON.stringify({
						workflow_runs: [
							{
								...validRun,
								status,
								created_at: validRun.created_at.replace(/\.\d{3}Z$/u, "Z"),
								updated_at: validRun.updated_at.replace(
									/\.\d{3}Z$/u,
									".123456789Z",
								),
							},
						],
					}),
				);
				const validNulls = command({}, runnerFlags);
				assert.match(
					validNulls.stdout,
					/preparing the local signoff fallback/u,
				);
				assert.match(validNulls.stderr, /working tree is not clean/u);
			}
			writeFileSync(runs, JSON.stringify({ workflow_runs: [validRun] }));
			rmSync(join(repo, "dirty.txt"));
			writeFileSync(jobs, JSON.stringify(queued));
			for (const bad of ["ci:typo", "ci:github-hosted", "local:local-github"]) {
				assert.deepEqual(await observeOpaque([bad]), {
					kind: "invalid-provider-assertion",
					provider: bad,
				});
				const result = command({}, [
					"--base=origin/opaque-policy",
					`--provider-unavailable=${bad}`,
				]);
				assert.notEqual(result.status, 0);
				assert.match(
					result.stderr,
					/does not name one enabled inventory member/u,
				);
			}
			assert.deepEqual(
				await observeOpaque([allOpaque[0] ?? "", allOpaque[0] ?? ""]),
				{
					kind: "invalid-provider-assertion",
					provider: allOpaque[0],
				},
			);
			const repeated = command({}, [
				"--base=origin/opaque-policy",
				"--provider-unavailable=ci:vercel-sandbox",
				"--provider-unavailable=ci:vercel-sandbox",
			]);
			assert.notEqual(repeated.status, 0);
			assert.match(repeated.stderr, /IDs must not be repeated/u);
			writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
			const asserted = command({}, opaqueFlags);
			assert.match(asserted.stdout, /preparing the local signoff fallback/u);
			assert.match(asserted.stderr, /working tree is not clean/u);
			rmSync(join(repo, "dirty.txt"));
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
			assert.match(fallback.stdout, /preparing the local signoff fallback/u);
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
			assert.match(
				validRefusal.stdout,
				/preparing the local signoff fallback/u,
			);
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
			git(remote, ["update-ref", "refs/heads/feature", baseA]);
			const unpublished = command({}, ["--fresh"]);
			assert.notEqual(unpublished.status, 0);
			assert.match(
				unpublished.stderr,
				supportsNoLazyFetch
					? /not verifiably on a branch of origin/u
					: /Git 2\.45 or newer/u,
			);
			const unpublishedOldGit = command({ HOBO_FLEET_OLD_GIT: "1" }, [
				"--fresh",
			]);
			assert.notEqual(unpublishedOldGit.status, 0);
			assert.match(unpublishedOldGit.stderr, /Git 2\.45 or newer/u);
			assert.equal(
				existsSync(join(repo, ".hobo/attestations-out", tree, "ci-guard.log")),
				false,
			);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			git(remote, ["update-ref", "refs/heads/feature", head]);
			// Advance A→B after observation and before the run fetches its base.
			const baseChangedBeforeRun = command(
				{ HOBO_FLEET_ADVANCE_AT_HELP: baseB },
				["--fresh"],
			);
			assert.notEqual(baseChangedBeforeRun.status, 0);
			assert.match(
				baseChangedBeforeRun.stderr,
				/base.*changed/u,
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
			const readOnly = command(
				{
					GH_TOKEN: "ghu_fixture",
					HOBO_STATUS_INSTALLATIONS: JSON.stringify({
						owner: "acme",
						statuses: "read",
					}),
				},
				["--fresh"],
			);
			assert.notEqual(readOnly.status, 0);
			assert.match(readOnly.stderr, /read-only commit statuses/u);
			assert.doesNotMatch(
				readOnly.stdout,
				/running the local signoff fallback/u,
			);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			// The trusted workflow actually executes and fails, so no status is posted.
			writeFileSync(join(bin, "fail-job"), "fail\n");
			const executedFailure = command({}, ["--fresh"]);
			assert.notEqual(executedFailure.status, 0);
			assert.equal(
				readFileSync(join(bin, "failed-command"), "utf8").trim(),
				"failed",
			);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /signoff create/u);
			rmSync(join(bin, "fail-job"));
			const success = command({}, ["--fresh"]);
			assert.equal(success.status, 0, success.stderr);
			assert.match(success.stdout, /running the local signoff fallback/u);
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

			const callsBeforeGroup = readFileSync(calls, "utf8");
			git(repo, ["switch", "--quiet", "--detach", baseA]);
			git(repo, ["cherry-pick", head]);
			const groupHead = git(repo, ["rev-parse", "HEAD"]).toString().trim();
			const groupRef = `gh-readonly-queue/main/pr-17-${baseA}`;
			git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${groupRef}`]);
			const queue = join(root, "merge-queue.json");
			const queueData = JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							state: "OPEN",
							baseRefName: "main",
							mergeQueueEntry: {
								state: "AWAITING_CHECKS",
								baseCommit: { oid: baseA },
								headCommit: { oid: groupHead },
							},
						},
					},
				},
			});
			writeFileSync(queue, queueData);
			const groupEnv = {
				HOBO_FLEET_QUEUE: queue,
				HOBO_FLEET_GROUP_HEAD: groupHead,
			};
			const groupFlags = ["--fresh", `--merge-group-ref=${groupRef}`];
			writeFileSync(join(bin, "change-queue-on-job"), "change\n");
			const movedGroup = command(groupEnv, groupFlags);
			assert.notEqual(movedGroup.status, 0);
			assert.match(
				movedGroup.stderr,
				/merge-group entry or its published ref changed/u,
			);
			assert.doesNotMatch(
				readFileSync(calls, "utf8"),
				/signoff create.*merge_group/u,
			);
			rmSync(join(bin, "change-queue-on-job"));
			writeFileSync(queue, queueData);
			const groupSuccess = command(groupEnv, groupFlags);
			assert.equal(groupSuccess.status, 0, groupSuccess.stderr);
			assert.ok(
				readFileSync(calls, "utf8").includes(
					`signoff create --commit ${groupHead} hobo-ci/local/merge_group/ci-guard`,
				),
			);
			writeFileSync(calls, callsBeforeGroup);
			git(repo, ["switch", "--quiet", "feature"]);

			const prDir = join(root, "pr-fixture");
			mkdirSync(prDir);
			const baseRepo = {
				id: 1,
				name: "app",
				full_name: "acme/app",
				owner: { login: "acme" },
			};
			const forkRepo = {
				id: 2,
				name: "app",
				full_name: "contributor/app",
				owner: { login: "contributor" },
			};
			const pull = {
				number: 17,
				state: "open",
				base: { ref: "main", sha: baseA, repo: baseRepo },
				head: { ref: "topic", sha: head, repo: forkRepo },
			};
			const replacementFork = { ...forkRepo, id: 3 };
			for (const [name, value] of Object.entries({
				"pull.json": pull,
				"closed.json": { ...pull, state: "closed" },
				"changed-pull.json": {
					...pull,
					head: { ...pull.head, repo: replacementFork },
				},
				"base.json": baseRepo,
				"base-branch.json": { name: "main", commit: { sha: baseA } },
				"fork.json": forkRepo,
				"changed-fork.json": replacementFork,
				"branch.json": { name: "topic", commit: { sha: head } },
			}))
				writeFileSync(join(prDir, name), JSON.stringify(value));
			git(remote, ["update-ref", "refs/heads/feature", baseA]);
			const forkSuccess = command({ HOBO_FLEET_PR_DIR: prDir }, [
				"--fresh",
				"--pr=17",
			]);
			assert.equal(forkSuccess.status, 0, forkSuccess.stderr);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				2,
			);
			const closedPr = command(
				{ HOBO_FLEET_PR_DIR: prDir, HOBO_FLEET_PR_CLOSED: "1" },
				["--fresh", "--pr=17"],
			);
			assert.notEqual(closedPr.status, 0);
			assert.doesNotMatch(
				closedPr.stdout,
				/running the local signoff fallback/u,
			);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				2,
			);
			writeFileSync(join(bin, "close-pr-on-job"), "close\n");
			const closedDuringJob = command({ HOBO_FLEET_PR_DIR: prDir }, [
				"--fresh",
				"--pr=17",
			]);
			assert.notEqual(closedDuringJob.status, 0);
			assert.match(
				closedDuringJob.stdout,
				/running the local signoff fallback/u,
			);
			assert.match(closedDuringJob.stderr, /pull request/u);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				2,
			);
			rmSync(join(bin, "close-pr-on-job"));
			rmSync(join(bin, "pr-closed"));
			writeFileSync(join(bin, "change-pr-on-job"), "change\n");
			const replacedDuringJob = command({ HOBO_FLEET_PR_DIR: prDir }, [
				"--fresh",
			]);
			assert.notEqual(replacedDuringJob.status, 0);
			assert.match(
				replacedDuringJob.stderr,
				/head proof changed since fleet preflight/u,
			);
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				2,
			);
			rmSync(join(bin, "change-pr-on-job"));
			rmSync(join(bin, "pr-changed"));
			git(remote, ["update-ref", "refs/heads/feature", head]);

			const descendant = git(repo, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit-tree",
				"HEAD^{tree}",
				"-p",
				head,
				"-m",
				"advanced remote",
			])
				.toString()
				.trim();
			git(repo, [
				"push",
				"--quiet",
				"origin",
				`${descendant}:refs/heads/feature`,
			]);
			git(repo, [
				"config",
				"--replace-all",
				"remote.origin.fetch",
				"+refs/heads/main:refs/remotes/origin/main",
			]);
			git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);
			git(repo, ["fetch", "--quiet", "origin", "feature"]);
			const advancedSuccess = command({}, ["--fresh"]);
			if (supportsNoLazyFetch)
				assert.equal(advancedSuccess.status, 0, advancedSuccess.stderr);
			else {
				assert.notEqual(advancedSuccess.status, 0);
				assert.match(advancedSuccess.stderr, /Git 2\.45 or newer/u);
			}
			const expectedSignoffs = supportsNoLazyFetch ? 3 : 2;
			assert.equal(
				readFileSync(calls, "utf8").match(/signoff create/g)?.length,
				expectedSignoffs,
			);
			git(remote, ["update-ref", "refs/heads/feature", head]);

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
				expectedSignoffs,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
