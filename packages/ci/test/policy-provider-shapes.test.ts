import { readFileSync } from "node:fs";
import { toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { DesiredCiPolicySchema } from "../src/_generated/policy_pb.js";
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
