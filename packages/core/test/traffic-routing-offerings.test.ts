import assert from "node:assert/strict";
import { test } from "vitest";

import {
	matchTrafficRoutingOfferings,
	offering,
	parseTrafficRoutingProviderProfile,
	resolveTrafficRouting,
	type TrafficRoutingProviderProfile,
} from "../src/ports/traffic-routing-offerings.js";

function cloudflareProfile(): TrafficRoutingProviderProfile {
	return parseTrafficRoutingProviderProfile({
		provider: "cloudflare",
		offerings: [
			{
				id: "lb.lifecycle",
				stability: "stable",
				fidelity: "real",
				features: [],
			},
			{
				id: "lb.weighted",
				stability: "stable",
				fidelity: "real",
				features: [],
			},
		],
		fallbacks: ["inprocess.weighted"],
	});
}

test("match prefer falls back when native offering missing", () => {
	const match = matchTrafficRoutingOfferings(cloudflareProfile(), {
		features: ["lb.weighted", "inprocess.weighted"],
		negotiation: "prefer",
	});
	assert.equal(match.kind, "partial");
	if (match.kind !== "partial") return;
	assert.deepEqual(match.offerings, ["lb.weighted", "inprocess.weighted"]);
	assert.deepEqual(match.fallbacks, ["inprocess.weighted"]);
});

test("match require fails closed on missing offering", () => {
	const match = matchTrafficRoutingOfferings(cloudflareProfile(), {
		features: ["mesh.optional"],
		negotiation: "require",
	});
	assert.equal(match.kind, "none");
});

test("resolve picks first non-none profile", () => {
	const simple: TrafficRoutingProviderProfile = {
		provider: "simple",
		offerings: [offering("inprocess.weighted")],
		fallbacks: [],
	};
	const resolved = resolveTrafficRouting([cloudflareProfile(), simple], {
		features: ["inprocess.weighted"],
		negotiation: "prefer",
	});
	assert.equal(resolved.kind, "resolved");
	if (resolved.kind !== "resolved") return;
	assert.equal(resolved.provider, "cloudflare");
	assert.ok(resolved.strategy.includes("inprocess.weighted"));
});

test("require mesh.optional never auto-selects when only native LB profiles exist", () => {
	const resolved = resolveTrafficRouting([cloudflareProfile()], {
		features: ["mesh.optional"],
		negotiation: "require",
	});
	assert.equal(resolved.kind, "unresolved");
	if (resolved.kind !== "unresolved") return;
	assert.deepEqual(resolved.missing, ["mesh.optional"]);
	assert.match(resolved.remediation, /mesh\.optional|lacks required/i);
});

test("prefer lb.lifecycle resolves cloudflare native strategy without mesh", () => {
	const resolved = resolveTrafficRouting([cloudflareProfile()], {
		features: ["lb.lifecycle", "lb.weighted"],
		negotiation: "prefer",
	});
	assert.equal(resolved.kind, "resolved");
	if (resolved.kind !== "resolved") return;
	assert.equal(resolved.provider, "cloudflare");
	assert.deepEqual(resolved.strategy, ["lb.lifecycle", "lb.weighted"]);
	assert.equal(resolved.match.kind, "full");
});

test("empty profiles unresolved with remediation", () => {
	const resolved = resolveTrafficRouting([], {
		features: ["inprocess.weighted"],
	});
	assert.equal(resolved.kind, "unresolved");
	if (resolved.kind !== "unresolved") return;
	assert.match(resolved.remediation, /no traffic-routing provider/i);
});
