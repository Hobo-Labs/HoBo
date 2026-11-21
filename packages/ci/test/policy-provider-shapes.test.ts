import { readFileSync } from "node:fs";
import { toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type CiPolicyAgent37Pool,
	DesiredCiPolicySchema,
} from "../src/_generated/policy_pb.js";
import { parseConfiguration } from "../src/config.js";
import { parseCiPolicy } from "../src/policy.js";

function fixture(kind: "valid" | "invalid", name: string): string {
	return readFileSync(
		new URL(`../data-models/fixtures/${kind}/${name}.json`, import.meta.url),
		"utf8",
	);
}

function agent37PolicyWithPoolPatch(
	poolPatch: Partial<CiPolicyAgent37Pool>,
): string {
	const input = JSON.parse(fixture("valid", "desired-policy-agent37"));
	Object.assign(input.providers[0].pool, poolPatch);
	return JSON.stringify(input);
}

describe("kind-specific CI policy provider shapes", () => {
	it("parses scale set, engine, disposable-pod and located vercel providers", () => {
		const policy = parseCiPolicy(
			fixture("valid", "desired-policy-kubernetes-shapes"),
		);
		const [arc, dagger, pods, vercel] = policy.providers;
		expect(arc?.capacity).toMatchObject({
			case: "scaleSet",
			value: {
				name: "hobo-arc",
				minRunners: 0,
				maxRunners: 4,
				namespace: "arc-runners",
			},
		});
		expect(Object.isFrozen(arc?.capacity.value)).toBe(true);
		expect(dagger?.capacity).toMatchObject({
			case: "engine",
			value: { name: "dagger-engine" },
		});
		expect(pods?.capacity.case).toBeUndefined();
		expect(vercel?.location).toBe("remote");
		expect(parseCiPolicy(toJsonString(DesiredCiPolicySchema, policy))).toEqual(
			policy,
		);
	});

	it("parses and round-trips an Agent37 pool", () => {
		const policy = parseCiPolicy(fixture("valid", "desired-policy-agent37"));
		expect(policy.providers[0]?.capacity).toMatchObject({
			case: "pool",
			value: {
				minBoxes: 0,
				maxBoxes: 4,
				type: "vm",
				region: "us",
				template: "agent37-ubuntu@1",
				size: { cpu: 2, memory: 4, disk: 20 },
				network: {
					allow: expect.arrayContaining(["*.actions.githubusercontent.com"]),
				},
			},
		});
		expect(Object.isFrozen(policy.providers[0]?.capacity.value)).toBe(true);
		expect(parseCiPolicy(toJsonString(DesiredCiPolicySchema, policy))).toEqual(
			policy,
		);
	});

	it.each([
		[2, 4],
		[4, 8],
		[4, 16],
		[4, 32],
		[8, 64],
	])("accepts the documented Agent37 VM shape %s vCPU / %s GB", (cpu, memory) => {
		const policy = parseCiPolicy(
			agent37PolicyWithPoolPatch({
				maxBoxes: 1,
				size: { cpu, memory, disk: 20 },
				allowAboveFreeTier: memory > 32,
			}),
		);
		expect(policy.providers[0]?.capacity.value).toMatchObject({
			size: { cpu, memory, disk: 20 },
		});
	});

	it("accepts a pool above the free-tier ceiling only with explicit opt-in", () => {
		expect(() =>
			parseCiPolicy(agent37PolicyWithPoolPatch({ maxBoxes: 9 })),
		).toThrow("invalid CI provider declaration");
		expect(
			parseCiPolicy(
				agent37PolicyWithPoolPatch({
					maxBoxes: 9,
					allowAboveFreeTier: true,
				}),
			).providers[0]?.capacity.value,
		).toMatchObject({ maxBoxes: 9, allowAboveFreeTier: true });
	});

	it.each([
		"agent37-ubuntu",
		"agent37-ubuntu@latest",
		"agent37-ubuntu@",
		"agent37-ubuntu@1.2",
		"agent37-ubuntu@0",
	])("rejects an unpinned or mutable Agent37 template: %s", (template) => {
		expect(() =>
			parseCiPolicy(agent37PolicyWithPoolPatch({ template })),
		).toThrow("invalid CI provider declaration");
	});

	it.each([
		"desired-policy-agent37-non-us-default",
		"desired-policy-agent37-oversize",
		"desired-policy-agent37-network-limit",
		"desired-policy-agent37-network-hostname",
		"desired-policy-agent37-network-empty",
		"desired-policy-agent37-network-duplicate",
		"desired-policy-agent37-network-loopback",
		"desired-policy-agent37-network-bare-wildcard",
		"desired-policy-agent37-memory-ceiling",
	])("rejects invalid Agent37 fixture %s through the policy parser", (name) => {
		expect(() => parseCiPolicy(fixture("invalid", name))).toThrow(
			"invalid CI provider declaration",
		);
	});

	it.each([
		["minBoxes above maxBoxes", { minBoxes: 5 }],
		["zero maxBoxes", { minBoxes: 0, maxBoxes: 0 }],
		["idle TTL below 60", { idleTtlSeconds: 59 }],
		["idle TTL above 3600", { idleTtlSeconds: 3601 }],
		["job timeout below one", { jobTimeoutSeconds: 0 }],
		["job timeout above 19800", { jobTimeoutSeconds: 19801 }],
		["disk below one GB", { size: { cpu: 2, memory: 4, disk: 0 } }],
		["disk above 1024 GB", { size: { cpu: 2, memory: 4, disk: 1025 } }],
		[
			"default 8 vCPU shape",
			{
				maxBoxes: 1,
				type: "default",
				size: { cpu: 8, memory: 64, disk: 20 },
				allowAboveFreeTier: true,
			},
		],
		["duplicate labels", { labels: ["hobo-agent37", "hobo-agent37"] }],
		["empty labels", { labels: [] }],
		["generic hobo label", { labels: ["hobo"] }],
		[
			"negative budget",
			{ budget: { limitMicros: -1, period: "month", maxCreatesPerHour: 60 } },
		],
		[
			"non-monthly budget",
			{
				budget: {
					limitMicros: 2000000,
					period: "manual",
					maxCreatesPerHour: 60,
				},
			},
		],
		[
			"zero creates per hour",
			{
				budget: { limitMicros: 2000000, period: "month", maxCreatesPerHour: 0 },
			},
		],
		[
			"too many creates per hour",
			{
				budget: {
					limitMicros: 2000000,
					period: "month",
					maxCreatesPerHour: 10001,
				},
			},
		],
	])("rejects an Agent37 pool with %s", (_label, patch) => {
		expect(() => parseCiPolicy(agent37PolicyWithPoolPatch(patch))).toThrow(
			"invalid CI provider declaration",
		);
	});

	it.each([
		"",
		"bad..example.com",
		"-bad.example.com",
		"bad-.example.com",
		"bad_name.example.com",
		"*. ",
		"*.*.example.com",
		"https://github.com",
	])("rejects invalid Agent37 network entry %j", (entry) => {
		expect(() =>
			parseCiPolicy(
				agent37PolicyWithPoolPatch({ network: { allow: [entry] } }),
			),
		).toThrow("invalid CI provider declaration");
	});

	it("accepts an Agent37 offer only with the GitHub Actions backend", () => {
		const configuration = JSON.parse(fixture("valid", "configuration"));
		const agent37 = JSON.parse(fixture("valid", "agent37-offer"));
		configuration.accounts[0].offers = [agent37];
		expect(
			parseConfiguration(JSON.stringify(configuration)).accounts[0]?.offers[0],
		).toMatchObject({ provider: "agent37", backend: "gh-actions" });
		agent37.backend = "sandbox";
		expect(() => parseConfiguration(JSON.stringify(configuration))).toThrow(
			"native provider requires its matching execution backend",
		);
	});

	it.each([
		"desired-policy-scale-set-wrong-kind",
		"desired-policy-scale-set-and-engine",
		"desired-policy-location-wrong-kind",
		"desired-policy-github-latest",
	])("rejects %s", (name) => {
		expect(() => parseCiPolicy(fixture("invalid", name))).toThrow();
	});

	it("keeps persisted vercel policies without a location readable", () => {
		const policy = parseCiPolicy(fixture("valid", "desired-policy-sandbox"));
		expect(policy.providers[0]?.location).toBe("");
	});

	it.each([
		["minRunners above maxRunners", { minRunners: 5, maxRunners: 4 }],
		["zero maxRunners", { maxRunners: 0 }],
		["uppercase name", { name: "Hobo-ARC" }],
		["namespace with dots", { namespace: "arc.runners" }],
	])("rejects a scale set with %s", (_label, patch) => {
		const input = JSON.parse(
			fixture("valid", "desired-policy-kubernetes-shapes"),
		);
		Object.assign(input.providers[0].scaleSet, patch);
		expect(() => parseCiPolicy(JSON.stringify(input))).toThrow(
			"invalid CI provider declaration",
		);
	});

	it("rejects an unknown vercel location", () => {
		const input = JSON.parse(
			fixture("valid", "desired-policy-kubernetes-shapes"),
		);
		input.providers[3].location = "edge";
		expect(() => parseCiPolicy(JSON.stringify(input))).toThrow(
			"invalid CI provider declaration",
		);
	});
});
