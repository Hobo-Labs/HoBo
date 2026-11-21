import { readFileSync } from "node:fs";
import { toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { DesiredCiPolicySchema } from "../src/_generated/policy_pb.js";
import { parseConfiguration } from "../src/config.js";
import { parseCiPolicy } from "../src/policy.js";

function fixture(kind: "valid" | "invalid", name: string): string {
	return readFileSync(
		new URL(`../data-models/fixtures/${kind}/${name}.json`, import.meta.url),
		"utf8",
	);
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
		"desired-policy-agent37-non-us-default",
		"desired-policy-agent37-oversize",
		"desired-policy-agent37-network-limit",
	])("rejects invalid Agent37 fixture %s through the policy parser", (name) => {
		expect(() => parseCiPolicy(fixture("invalid", name))).toThrow(
			"invalid CI provider declaration",
		);
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
