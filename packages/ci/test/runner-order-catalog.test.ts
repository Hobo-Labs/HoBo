import { readdirSync, readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	RunnerOrderSchema,
	RunnerOrderStepSchema,
} from "../src/_generated/runner_route_pb.js";
import {
	DEFAULT_RUNNER_ORDER,
	defineRunnerOrder,
	HOSTED_RUNNER_PROVIDERS,
	isGithubHostedLabel,
	isProviderLabel,
	MAX_RUNNER_ORDER_STEPS,
	orderAutoSize,
	orderRetryPolicy,
	parseRunnerOrder,
	preferFirst,
	RUNNER_PROVIDER_CATALOG,
	RUNNER_SKIP_REASONS,
	RUNNER_STEP_KEYS,
	relayInputLabels,
	relayInputs,
	resolveAutoInputs,
	retryOrder,
	runnerAutoSize,
	runnerLabelForSize,
	runnerOrderOrDefault,
	runnerProviderOfLabel,
	runnerStepKey,
	skipsUnhealthy,
	stepKey,
} from "../src/runner-order/index.js";

const fixtures = new URL(
	"../data-models/fixtures/runner_route/",
	import.meta.url,
);
const fixture = (path: string): string =>
	readFileSync(new URL(path, fixtures), "utf8");
const keys = (order: { steps: readonly { key: string }[] }): string[] =>
	order.steps.map((step) => step.key);

describe("runner provider catalog", () => {
	it("has an entry, a source and a reading date for every hosted provider", () => {
		for (const provider of HOSTED_RUNNER_PROVIDERS) {
			const entry = RUNNER_PROVIDER_CATALOG.get(provider);
			expect(entry?.source).toMatch(/^https:\/\//u);
			expect(entry?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(entry?.sizes.length).toBeGreaterThan(0);
		}
		expect(RUNNER_PROVIDER_CATALOG.size).toBe(HOSTED_RUNNER_PROVIDERS.length);
	});

	it("recognises every size label as its own provider's", () => {
		for (const [provider, entry] of RUNNER_PROVIDER_CATALOG)
			for (const size of entry.sizes) {
				const label = size.label.replace("{run}", "77");
				expect(isProviderLabel(provider, label)).toBe(true);
				expect(runnerProviderOfLabel(label)).toBe(provider);
			}
	});

	it("matches a bare provider name for a dash prefix, in any case", () => {
		expect(isProviderLabel("depot", "depot")).toBe(true);
		expect(isProviderLabel("depot", "Depot-Ubuntu-24.04")).toBe(true);
		expect(isProviderLabel("depot", "depots")).toBe(false);
		expect(isProviderLabel("runs-on", "runs-on")).toBe(false);
		expect(isProviderLabel("namespace", "namespace-profile-big")).toBe(true);
	});

	it("tells GitHub-hosted labels from unknown ones", () => {
		expect(runnerProviderOfLabel("ubuntu-24.04")).toBe("github");
		expect(isGithubHostedLabel("macos-15")).toBe(true);
		expect(isGithubHostedLabel("windows-2025")).toBe(true);
		expect(runnerProviderOfLabel("self-hosted")).toBeUndefined();
		expect(runnerProviderOfLabel("hobo")).toBeUndefined();
	});

	it("gives the smallest size at or above the request", () => {
		expect(runnerLabelForSize("blacksmith", 2, 1)).toBe(
			"blacksmith-2vcpu-ubuntu-2404",
		);
		expect(runnerLabelForSize("depot", 2, 1)).toBe("depot-ubuntu-24.04");
		expect(runnerLabelForSize("depot", 4, 1)).toBe("depot-ubuntu-24.04-4");
		expect(runnerLabelForSize("namespace", 8, 1)).toBe(
			"nscloud-ubuntu-24.04-amd64-8x16",
		);
		expect(runnerLabelForSize("warpbuild", 16, 1)).toBe(
			"warp-ubuntu-2404-x64-16x",
		);

		expect(runnerLabelForSize("ubicloud", 16, 1)).toBe("ubicloud-standard-16");
		expect(runnerLabelForSize("ubicloud", 32, 1)).toBeUndefined();

		expect(runnerLabelForSize("boat", 2, 1)).toBe("boat");
		expect(runnerLabelForSize("boat", 8, 1)).toBeUndefined();
		expect(runnerLabelForSize("runs-on", 4, 9001)).toBe(
			"runs-on=9001/runner=4cpu-linux-x64",
		);
		expect(runnerLabelForSize("github", 2, 1)).toBe("ubuntu-24.04");
		expect(runnerLabelForSize("github", 4, 1)).toBeUndefined();
		expect(runnerLabelForSize("fleet", 2, 1)).toBeUndefined();
		expect(runnerLabelForSize("machine", 2, 1)).toBeUndefined();
	});

	it("never offers ubuntu-latest", () => {
		for (const key of RUNNER_STEP_KEYS)
			for (const vcpus of [2, 4, 8, 16, 32])
				expect(runnerLabelForSize(key, vcpus, 1) ?? "").not.toMatch(
					/ubuntu-latest/u,
				);
	});

	it("parses step keys and auto sizes", () => {
		expect(runnerStepKey("runs-on")).toBe("runs-on");
		expect(runnerStepKey("buildjet")).toBeUndefined();
		expect(
			stepKey(create(RunnerOrderStepSchema, { key: "buildjet" })),
		).toBeUndefined();
		expect(runnerAutoSize(8)).toBe(8);
		expect(runnerAutoSize(3)).toBeUndefined();
	});
});

describe("runner order", () => {
	it("defaults to the fleet, then machines, then GitHub-hosted", () => {
		expect(keys(DEFAULT_RUNNER_ORDER)).toEqual(["fleet", "machine", "github"]);
		expect(skipsUnhealthy(DEFAULT_RUNNER_ORDER)).toBe(true);
		expect(orderAutoSize(DEFAULT_RUNNER_ORDER)).toBe(2);
		expect(orderRetryPolicy(DEFAULT_RUNNER_ORDER)).toMatchObject({
			enabled: false,
			runner: "any",
			max: 1,
		});
		expect(Object.isFrozen(DEFAULT_RUNNER_ORDER)).toBe(true);
	});

	it("parses every valid order fixture and reads its settings", () => {
		const order = parseRunnerOrder(fixture("valid/order-limits.json"));
		expect(keys(order)).toEqual([
			"github",
			"machine",
			"blacksmith",
			"runs-on",
			"github",
		]);
		expect(order.steps[0]?.minutesLimitPercent).toBe(80);
		expect(order.steps[2]?.spendLimitUsd).toBe(100);
		expect(skipsUnhealthy(order)).toBe(false);
		expect(orderAutoSize(order)).toBe(4);
		expect(orderRetryPolicy(order)).toMatchObject({
			enabled: true,
			runner: "other",
			max: 2,
		});
		expect(keys(parseRunnerOrder(fixture("valid/order-default.json")))).toEqual(
			keys(DEFAULT_RUNNER_ORDER),
		);
	});

	it("rejects every invalid order fixture the schema rejects", () => {
		const invalid = readdirSync(new URL("invalid/", fixtures)).filter((name) =>
			name.startsWith("order-"),
		);
		expect(invalid.length).toBeGreaterThanOrEqual(7);
		for (const name of invalid)
			expect(() => parseRunnerOrder(fixture(`invalid/${name}`))).toThrow();
	});

	it("enforces the cross-step rules the schema cannot", () => {
		const order = (steps: readonly object[]) =>
			parseRunnerOrder(JSON.stringify({ steps }));
		expect(() => order([{ key: "machine" }, { key: "machine" }])).toThrow(
			/machine step appears more than once/u,
		);
		expect(() => order([{ key: "github" }, { key: "github" }])).toThrow(
			/one limited and one unlimited/u,
		);
		expect(() =>
			order([
				{ key: "github", minutesLimitPercent: 50 },
				{ key: "github", minutesLimitPercent: 80 },
			]),
		).toThrow(/one limited and one unlimited/u);
		expect(
			keys(
				order([{ key: "github", minutesLimitPercent: 50 }, { key: "github" }]),
			),
		).toEqual(["github", "github"]);
		expect(() =>
			order(
				Array.from({ length: MAX_RUNNER_ORDER_STEPS + 1 }, () => ({
					key: "fleet",
				})),
			),
		).toThrow(/at most 16 steps/u);
		expect(() =>
			parseRunnerOrder('{"steps":[{"key":"fleet"}],"x":1}'),
		).toThrow();
	});

	it("names what is wrong with a limit", () => {
		const define = (step: {
			key: string;
			minutesLimitPercent?: number;
			spendLimitUsd?: number;
		}) => defineRunnerOrder(create(RunnerOrderSchema, { steps: [step] }));
		expect(() => define({ key: "fleet", minutesLimitPercent: 10 })).toThrow(
			/belongs to the github step, not fleet/u,
		);
		expect(() => define({ key: "machine", spendLimitUsd: 10 })).toThrow(
			/belongs to a hosted provider step, not machine/u,
		);
		expect(() => define({ key: "depot", spendLimitUsd: 100_001 })).toThrow(
			/at most 100000/u,
		);
		expect(keys(define({ key: "depot", spendLimitUsd: 100_000 }))).toEqual([
			"depot",
		]);
		expect(() =>
			defineRunnerOrder(create(RunnerOrderSchema, { steps: [] })),
		).toThrow(/at least one step/u);
	});

	it("defaults only a missing or blank stored order", () => {
		expect(runnerOrderOrDefault(undefined)).toBe(DEFAULT_RUNNER_ORDER);
		expect(runnerOrderOrDefault("  ")).toBe(DEFAULT_RUNNER_ORDER);
		expect(() => runnerOrderOrDefault("{not json")).toThrow();
		expect(() => runnerOrderOrDefault('{"steps":[]}')).toThrow();
		expect(keys(runnerOrderOrDefault('{"steps":[{"key":"depot"}]}'))).toEqual([
			"depot",
		]);
	});

	it("moves a preferred step to the top and keeps the rest in order", () => {
		const order = parseRunnerOrder(fixture("valid/order-limits.json"));
		const first = preferFirst(order, "github");
		expect(keys(first)).toEqual([
			"github",
			"github",
			"machine",
			"blacksmith",
			"runs-on",
		]);
		expect(first.steps[0]?.minutesLimitPercent).toBe(80);
		expect(orderAutoSize(first)).toBe(4);
		expect(Object.isFrozen(first)).toBe(true);
		expect(preferFirst(order, "depot")).toBe(order);
		expect(preferFirst(order, undefined)).toBe(order);
	});

	it("orders a retry by its target", () => {
		const order = parseRunnerOrder(
			'{"steps":[{"key":"machine"},{"key":"depot"},{"key":"github"}]}',
		);
		expect(keys(retryOrder(order, "depot", "same"))).toEqual([
			"depot",
			"machine",
			"github",
		]);
		expect(keys(retryOrder(order, "machine", "other"))).toEqual([
			"depot",
			"github",
			"machine",
		]);
		expect(retryOrder(order, "machine", "any")).toBe(order);
		expect(retryOrder(order, undefined, "other")).toBe(order);
		expect(retryOrder(order, "boat", "other")).toBe(order);
		expect(order.steps.map(stepKey)).toEqual(["machine", "depot", "github"]);
	});
});

describe("relay inputs", () => {
	it("splits a comma-separated input and drops blanks", () => {
		expect(relayInputLabels(" self-hosted , macOS,, ")).toEqual([
			"self-hosted",
			"macOS",
		]);
		expect(relayInputLabels("")).toEqual([]);
	});

	it("keeps known keys with labels, first entry wins", () => {
		const inputs = relayInputs([
			{
				$typeName: "hobo.ci.v1.RunnerRelayInput",
				key: "github",
				labels: ["a"],
			},
			{
				$typeName: "hobo.ci.v1.RunnerRelayInput",
				key: "github",
				labels: ["b"],
			},
			{ $typeName: "hobo.ci.v1.RunnerRelayInput", key: "bogus", labels: ["c"] },
			{ $typeName: "hobo.ci.v1.RunnerRelayInput", key: "depot", labels: [] },
			{
				$typeName: "hobo.ci.v1.RunnerRelayInput",
				key: "machine",
				labels: ["self-hosted, Linux"],
			},
		]);
		expect([...inputs]).toEqual([
			["github", ["a"]],
			["machine", ["self-hosted", "Linux"]],
		]);
	});

	it("turns auto into the label for the size and omits unsupported sizes", () => {
		const resolved = resolveAutoInputs(
			new Map([
				["machine", ["auto"]],
				["fleet", ["AUTO"]],
				["github", ["auto"]],
				["depot", ["auto"]],
				["ubicloud", ["ubicloud-standard-8"]],
			]),
			4,
			55,
		);
		expect([...resolved]).toEqual([
			["machine", ["self-hosted"]],
			["fleet", ["hobo"]],
			["depot", ["depot-ubuntu-24.04-4"]],
			["ubicloud", ["ubicloud-standard-8"]],
		]);
		expect(resolved.has("github")).toBe(false);
	});

	it("resolves an empty input map to an empty map", () => {
		expect(resolveAutoInputs(new Map(), 2, 55).size).toBe(0);
	});
});

describe("schema agreement", () => {
	const cue = readFileSync(
		new URL("../data-models/runner_route.cue", import.meta.url),
		"utf8",
	);
	const quoted = (definition: string): string[] => {
		const line = cue
			.split("\n")
			.find((candidate) => candidate.startsWith(`${definition}:`));
		return [...(line ?? "").matchAll(/"([a-z_-]+)"/gu)].flatMap(
			(match) => match[1] ?? [],
		);
	};

	it("lists the same skip reasons in CUE and in code", () => {
		expect(quoted("#RunnerSkipReason")).toEqual([...RUNNER_SKIP_REASONS]);
	});

	it("lists the same hosted providers in CUE and in code", () => {
		expect(quoted("#HostedRunnerProvider")).toEqual([
			...HOSTED_RUNNER_PROVIDERS,
		]);
	});
});
