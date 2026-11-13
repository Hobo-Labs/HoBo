import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	DEFAULT_GITHUB_MACHINE_TYPE,
	LOCAL_HOST_RUNNER_LABEL,
} from "../../packages/ci/src/fleet-overflow.ts";
import {
	DEFAULT_CAPACITY_VOLATILITY_MB,
	DEFAULT_FLEET_MIN_FREE_RUNNERS,
	DEFAULT_ROUTING_STALL_MS,
	DEFAULT_RUNNER_ROUTING,
	DEFAULT_SELF_UPDATE_INTERVAL_HOURS,
	DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS,
} from "../../packages/ci-gh-actions/src/isolated-worker/box-routing-policy.ts";
import {
	FLEET_VERDICT_ENTER_MS,
	FLEET_VERDICT_EXIT_MS,
} from "../../packages/ci-gh-actions/src/isolated-worker/fleet-verdict-state.ts";
import { resolveWorkerSlotConfig } from "../../packages/ci-gh-actions/src/isolated-worker/worker-slots.ts";
import { resolveWorkerStorePlan } from "../../packages/ci-gh-actions/src/isolated-worker/worker-store.ts";
import { parseCiRunnerRouting } from "../../packages/ci-gh-actions/src/relay-routing.ts";
import { judgeRoutingSlip as judgeWithProtobuf } from "../../packages/ci-gh-actions/src/routing-slip.ts";
import { parseRunnerRouting as parseWithZod } from "../../packages/ci-gh-actions/src/runner-routing.ts";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	mainWorkspaceParallelCap,
} from "../ci/plan-main-workspace-shards.mts";
import {
	DEFAULT_LOCAL_RUNNER,
	DEFAULT_MAX_QUEUED,
	DEFAULT_MAX_WAIT_SECONDS,
	fleetLabelFor,
	parseRouteMode,
} from "../ci/route-runner.mts";
import {
	judgeRoutingSlip,
	parseRunnerRouting,
	type RoutingSlipRefusal,
	readRunnerRouting,
	routingLabels,
} from "../ci/runner-routing.mts";

const repoFile = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const FIXTURES = "packages/ci-gh-actions/data-models/fixtures";
const fixtureNames = (kind: "valid" | "invalid", prefix: string) =>
	readdirSync(new URL(`../../${FIXTURES}/${kind}`, import.meta.url))
		.filter((name) => name.startsWith(prefix))
		.sort();
const fixture = (kind: "valid" | "invalid", name: string) =>
	repoFile(`${FIXTURES}/${kind}/${name}`);

const committedText = repoFile(".hobo/ci.json");
const committed = readRunnerRouting(committedText);
const ISSUED = Date.parse("2026-11-13T16:00:00.000Z");
const LABELS = new Set([
	"hobo",
	"hobo-trunk",
	"hobo-local-host",
	"ubuntu-24.04",
]);
const context = {
	repository: "Hobo-Labs/HoBo",
	nowMs: ISSUED + 60_000,
	labels: LABELS,
};

describe("the dependency-free routing reader", () => {
	it("uses Node's built-ins only, so the route job's sparse checkout can run it", () => {
		const imports = [
			...repoFile("scripts/ci/runner-routing.mts").matchAll(
				/^import .* from "([^"]+)";$/gmu,
			),
		].map((match) => match[1]);
		assert.deepEqual(
			imports.filter((name) => !name?.startsWith("node:")),
			[],
		);
	});

	it("reads the committed runnerRouting, and its labels are the slip's allowlist", () => {
		assert.ok(committed);
		assert.deepEqual([...routingLabels(committed)].sort(), [
			"hobo",
			"hobo-local-host",
			"hobo-trunk",
			"ubuntu-24.04",
		]);
	});

	it("agrees with the zod parser on every policy fixture and the committed file", () => {
		for (const kind of ["valid", "invalid"] as const)
			for (const name of fixtureNames(kind, "runner-routing")) {
				const value = JSON.parse(fixture(kind, name));
				const mine = parseRunnerRouting(value);
				assert.deepEqual(mine, parseWithZod(value), name);
				assert.equal(mine !== undefined, kind === "valid", name);
			}
		assert.deepEqual(committed, parseCiRunnerRouting(committedText));
	});

	it("refuses a policy the zod parser refuses", () => {
		const base = JSON.parse(fixture("valid", "runner-routing.json"));
		const variants = [
			{ ...base, extra: true },
			{ ...base, localRunner: "false" },
			{ ...base, queue: { ...base.queue, maxQueued: 0 } },
			{ ...base, queue: { ...base.queue, maxWaitSeconds: 1.5 } },
			{ ...base, labels: { ...base.labels, github: "Ubuntu-24.04" } },
			{ ...base, box: { ...base.box, trunkLend: true } },
			{ ...base, box: { ...base.box, jobAdmission: "poll" } },
			{ ...base, mainWorkspaceParallelCap: 9 },
			{
				...base,
				externalPools: [{ labels: [], runnerNamePrefix: "a", maxRunners: 1 }],
			},
			{ ...base, verdict: { ...base.verdict, stallMs: 1000 } },
			null,
			[],
		];
		for (const variant of variants) {
			assert.equal(parseRunnerRouting(variant), undefined);
			assert.equal(parseWithZod(variant), undefined);
		}
		assert.equal(readRunnerRouting("{}"), undefined);
		assert.equal(readRunnerRouting("not json"), undefined);
		assert.equal(readRunnerRouting(undefined), undefined);
	});
});

describe("the routing slip, read without dependencies (M4)", () => {
	const judge = (text: string, at = context) => {
		const judgement = judgeRoutingSlip(text, at);
		return judgement.ok ? "used" : judgement.why;
	};

	it("is used from every valid fixture, as the protobuf parser reads it", () => {
		for (const name of fixtureNames("valid", "routing-slip")) {
			const text = fixture("valid", name);
			const mine = judgeRoutingSlip(text, context);
			assert.equal(mine.ok, true, name);
			assert.deepEqual(mine, judgeWithProtobuf(text, context), name);
		}
	});

	it("is never used from an invalid fixture, for the reason the protobuf parser gives", () => {
		const expected = new Map<string, RoutingSlipRefusal>(
			Object.entries({
				"routing-slip-expired.json": "expired",
				"routing-slip-figure-in-reason.json": "malformed",
				"routing-slip-free-slots.json": "malformed",
				"routing-slip-label-not-allowed.json": "label-not-allowed",
				"routing-slip-missing-class.json": "malformed",
				"routing-slip-tier-disagrees.json": "malformed",
				"routing-slip-unknown-class.json": "malformed",
				"routing-slip-version.json": "malformed",
				"routing-slip-wrong-repository.json": "wrong-repository",
			} satisfies Record<string, RoutingSlipRefusal>),
		);
		assert.deepEqual(
			fixtureNames("invalid", "routing-slip"),
			[...expected.keys()].sort(),
		);
		for (const name of fixtureNames("invalid", "routing-slip")) {
			const text = fixture("invalid", name);
			assert.equal(judge(text), expected.get(name), name);
			assert.deepEqual(
				judgeRoutingSlip(text, context),
				judgeWithProtobuf(text, context),
				name,
			);
		}
	});

	it("is not used once it has expired, by the reader's clock", () => {
		const text = fixture("valid", "routing-slip.json");
		assert.equal(
			judge(text, { ...context, nowMs: ISSUED + 600_000 - 1 }),
			"used",
		);
		assert.equal(
			judge(text, { ...context, nowMs: ISSUED + 600_000 }),
			"expired",
		);
	});

	it("is not used by another repository, or with a label the policy does not commit", () => {
		const text = fixture("valid", "routing-slip-refused.json");
		assert.equal(
			judge(text, { ...context, repository: "hobo-labs/fork" }),
			"wrong-repository",
		);
		assert.equal(
			judge(text, {
				...context,
				labels: new Set(["hobo", "hobo-trunk", "ubuntu-24.04"]),
			}),
			"label-not-allowed",
		);
	});

	it("agrees with the protobuf parser on text that is not the slip's canonical JSON", () => {
		const slip = JSON.parse(fixture("valid", "routing-slip.json"));
		const { issuedAt, ...withoutIssuedAt } = slip;
		const texts = [
			"",
			"null",
			"[]",
			"{",
			"1",
			JSON.stringify({ ...slip, version: "1" }),
			JSON.stringify({ ...slip, version: 1.5 }),
			JSON.stringify({ ...slip, relay: null }),
			JSON.stringify({ ...slip, relay: {} }),
			JSON.stringify({ ...withoutIssuedAt, issued_at: issuedAt }),
			JSON.stringify(withoutIssuedAt),
			JSON.stringify({ ...slip, issuedAt: "2026-11-13T16:00:00Z" }),
			JSON.stringify({ ...slip, issuedAt: "2026-02-30T16:00:00.000Z" }),
			JSON.stringify({ ...slip, expiresAt: "2026-11-13T16:10:00.001Z" }),
			JSON.stringify({ ...slip, classes: [] }),
			JSON.stringify({ ...slip, classes: { ...slip.classes, pr: null } }),
			JSON.stringify({
				...slip,
				classes: { ...slip.classes, pr: { ...slip.classes.pr, tier: "" } },
			}),
			JSON.stringify({
				...slip,
				relay: { ...slip.relay, commit: "C7EC8D449" },
			}),
			JSON.stringify({ ...slip, repository: "hobo-labs/hobo/extra" }),
		];
		for (const text of texts) {
			const contextFor = { ...context };
			assert.equal(judgeRoutingSlip(text, contextFor).ok, false, text);
			assert.deepEqual(
				judgeRoutingSlip(text, contextFor),
				judgeWithProtobuf(text, contextFor),
				text,
			);
		}
	});
});

describe("committed runnerRouting equals the code's defaults (M8)", () => {
	// The box daemon reads runnerRouting from its checkout (plan 0026, 3.4)
	// and falls back to DEFAULT_RUNNER_ROUTING when the block is absent.
	const daemon = repoFile(
		"packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts",
	);

	it("box: the daemon reads it from its checkout, and its fallback equals it", () => {
		assert.ok(committed);
		assert.match(daemon, /readBoxRoutingPolicy\(checkoutRoot\)/u);
		assert.deepEqual(committed, DEFAULT_RUNNER_ROUTING);
	});

	it("route: no pin, the queue limits and the four labels", () => {
		assert.ok(committed);
		assert.equal(committed.pin, parseRouteMode(undefined));
		assert.deepEqual(committed.queue, {
			maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
			maxQueued: DEFAULT_MAX_QUEUED,
		});
		assert.deepEqual(committed.labels, {
			fleet: fleetLabelFor("pull_request", undefined),
			trunk: fleetLabelFor("push", undefined),
			local: LOCAL_HOST_RUNNER_LABEL,
			github: DEFAULT_GITHUB_MACHINE_TYPE,
		});
		// The route job enrolls a local box only when the policy says so.
		assert.match(
			repoFile("scripts/ci/route-runner.mts"),
			/const localEnrolled = settings\.localRunner;/u,
		);
		assert.equal(committed.localRunner, DEFAULT_LOCAL_RUNNER);
		assert.equal(committed.localRunner, false);
	});

	it("main gate: the plan's parallel cap", () => {
		assert.ok(committed);
		assert.equal(
			committed.mainWorkspaceParallelCap,
			DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
		);
		assert.equal(
			committed.mainWorkspaceParallelCap,
			mainWorkspaceParallelCap(undefined),
		);
		// The plan reads the cap from the committed policy, not an environment variable.
		assert.equal(
			mainWorkspaceParallelCap(committed),
			committed.mainWorkspaceParallelCap,
		);
	});

	it("verdict: the reporter's free-runner floor, hysteresis and pools", () => {
		assert.ok(committed);
		assert.equal(
			committed.verdict.minFreeRunners,
			DEFAULT_FLEET_MIN_FREE_RUNNERS,
		);
		assert.equal(committed.verdict.enterMs, FLEET_VERDICT_ENTER_MS);
		assert.equal(committed.verdict.exitMs, FLEET_VERDICT_EXIT_MS);
		assert.deepEqual(committed.externalPools, []);
		assert.equal(committed.verdict.stallMs, DEFAULT_ROUTING_STALL_MS);
		// Plan 0026 (3.3) sets the stall limit at ten minutes.
		assert.equal(committed.verdict.stallMs, 10 * 60_000);
	});

	it("box: the slot split, admission and the daemon's own defaults", () => {
		assert.ok(committed);
		const slots = resolveWorkerSlotConfig({});
		assert.deepEqual(
			{
				slots: committed.box.slots,
				trunkSlots: committed.box.trunkSlots,
				mergeGroupLeases: committed.box.mergeGroupLeases,
				prCapWithTrunk: committed.box.prCapWithTrunk,
			},
			slots,
		);
		assert.equal(
			committed.box.jobAdmission,
			resolveWorkerStorePlan({}, "/home/box").admission,
		);
		assert.equal(
			committed.box.capacityVolatilityMb,
			DEFAULT_CAPACITY_VOLATILITY_MB,
		);
		assert.equal(committed.box.trunkLend, 0);
		assert.equal(
			committed.box.trunkHeadroomFleetDeferMs,
			DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS,
		);
	});

	it("retires the five routing variables and the three the relay published", () => {
		assert.ok(committed);
		assert.deepEqual([...committed.retiredVariables].sort(), [
			"HOBO_CI_FLEET_CAPACITY",
			"HOBO_CI_FLEET_ROUTES",
			"HOBO_CI_FLEET_STATE",
			"HOBO_CI_LOCAL_RUNNER",
			"HOBO_CI_ROUTE",
			"HOBO_CI_ROUTE_MAX_QUEUED",
			"HOBO_CI_ROUTE_MAX_WAIT_SECONDS",
			"HOBO_CI_TRUNK_RUNNER",
		]);
	});

	it("self-update: on, every three hours (plan 0026, 3.8)", () => {
		assert.ok(committed);
		assert.deepEqual(committed.selfUpdate, {
			enabled: true,
			intervalHours: DEFAULT_SELF_UPDATE_INTERVAL_HOURS,
		});
		assert.equal(DEFAULT_SELF_UPDATE_INTERVAL_HOURS, 3);
	});
});
