/**
 * Deterministic Yard matching.
 *
 * `yard-placement.test.ts` covers the outcomes; this goes after the hard-filter
 * predicates individually, because they are what decides where a workload can
 * legally run and each one fails silently if it inverts.
 *
 * Two design properties are asserted directly rather than inferred:
 *
 * **Registration order never decides anything.** The whole point of
 * lexicographic specificity plus a stable-id tiebreak is that two brokers with
 * the same inventory reach the same answer. A matcher that quietly depended on
 * insertion order would still pass any test that fed the yards in one order, so
 * the ordering tests feed them both ways.
 *
 * **A capability may be declared on the yard *or* in its layout.** Every
 * requirement check consults both, and the fallbacks differ per predicate —
 * regions use a `region:` prefix, component hosts a `host:` prefix, plain
 * requirements neither. Those prefixes are easy to get wrong and impossible to
 * notice, so each is pinned on its own.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import { matchYard } from "../src/yard-placement/matching.js";
import type {
	YardInstanceRegistration,
	YardLayout,
	YardPlacementRequest,
} from "../src/yard-placement/types.js";

function layout(overrides: Partial<YardLayout> = {}): YardLayout {
	return {
		regions: [],
		require: [],
		prefer: [],
		residency: [],
		isolation: [],
		network: [],
		componentHosts: [],
		labels: {},
		properties: {},
		camps: [],
		...overrides,
	};
}

function yard(
	overrides: Partial<YardInstanceRegistration> = {},
): YardInstanceRegistration {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId: "y1",
		ownerTenantId: "t1",
		providerId: "local",
		runtimeId: "wasm",
		layout: layout(),
		capabilities: [],
		status: "ready",
		health: { observedAt: "2026-01-01T00:00:00Z", generation: 1, signals: [] },
		capacity: { classes: { small: 4 }, reservations: {} },
		// SAFETY: assertion required at this I/O or test boundary.
		registryCatalogHash: "sha256:cat" as never,
		// SAFETY: assertion required at this I/O or test boundary.
		resolverCatalogHash: "sha256:res" as never,
		// SAFETY: assertion required at this I/O or test boundary.
		conformanceHash: "sha256:conf" as never,
		labels: {},
		registrationSeq: 1,
		...overrides,
	} as YardInstanceRegistration;
}

function request(
	overrides: Partial<YardPlacementRequest> = {},
): YardPlacementRequest {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		requestId: "req-1",
		selectionMode: "compatible",
		requestedLayout: layout(),
		// SAFETY: assertion required at this I/O or test boundary.
		bindleManifestHash: "sha256:m" as never,
		// SAFETY: assertion required at this I/O or test boundary.
		bindleRequirementsHash: "sha256:r" as never,
		allowGenerationRequested: false,
		...overrides,
	} as YardPlacementRequest;
}

const match = (
	req: YardPlacementRequest,
	yards: YardInstanceRegistration[],
	options: JsonObject = {},
) =>
	matchYard(
		req,
		// SAFETY: assertion required at this I/O or test boundary.
		{ yards, snapshotSeq: 1 } as never,
		// SAFETY: assertion required at this I/O or test boundary.
		{ ownerTenantId: "t1", ...options } as never,
	);

const failuresFor = (
	req: YardPlacementRequest,
	y: YardInstanceRegistration,
	options: JsonObject = {},
) => match(req, [y], options).candidates[0]?.hardFailures ?? [];

describe("the happy path", () => {
	it("selects a ready yard in the same tenant", () => {
		const decision = match(request(), [yard()]);
		expect(decision.outcome).toBe("existing-yard");
		expect(decision.winnerYardId).toBe("y1");
	});

	it("says which yard it chose and why", () => {
		expect(match(request(), [yard()]).rationale).toContain("y1");
	});
});

describe("tenancy and readiness", () => {
	it("rejects a yard owned by another tenant", () => {
		// Cross-tenant placement is the failure that must never be soft.
		expect(failuresFor(request(), yard({ ownerTenantId: "t2" }))).toContain(
			"owner-tenant-mismatch",
		);
	});

	it.each([
		"registering",
		"attesting",
		"degraded",
		"draining",
		"offline",
	])("rejects a yard whose status is %s", (status) => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(failuresFor(request(), yard({ status: status as never }))).toContain(
			`status-${status}`,
		);
	});

	it("reports no compatible yard when everything is unready", () => {
		const decision = match(request(), [yard({ status: "draining" })]);
		expect(decision.outcome).toBe("rejected");
	});
});

describe("provider and runtime filters", () => {
	it("rejects a provider mismatch", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ providerId: "aws" }) }),
				yard(),
			),
		).toContain("provider-mismatch");
	});

	it("ignores the provider when the request does not name one", () => {
		expect(failuresFor(request(), yard({ providerId: "aws" }))).toEqual([]);
	});

	it("rejects a runtime mismatch", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ runtimeId: "oci" }) }),
				yard(),
			),
		).toContain("runtime-mismatch");
	});
});

describe("region matching", () => {
	it("accepts a region the yard's layout declares", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ regions: ["eu-west-1"] }) }),
				yard({ layout: layout({ regions: ["eu-west-1"] }) }),
			),
		).toEqual([]);
	});

	it("accepts a region declared as a region: capability", () => {
		// The prefixed form is easy to get wrong and impossible to notice.
		expect(
			failuresFor(
				request({ requestedLayout: layout({ regions: ["eu-west-1"] }) }),
				yard({
					layout: layout({ regions: ["us-east-1"] }),
					capabilities: ["region:eu-west-1"],
				}),
			),
		).toEqual([]);
	});

	it("rejects a region the yard does not offer", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ regions: ["eu-west-1"] }) }),
				yard({ layout: layout({ regions: ["us-east-1"] }) }),
			),
		).toContain("region-missing:eu-west-1");
	});

	it("treats a yard declaring no regions as accepting any", () => {
		// An empty region list means unconstrained, not "serves nowhere".
		expect(
			failuresFor(
				request({ requestedLayout: layout({ regions: ["eu-west-1"] }) }),
				yard(),
			),
		).toEqual([]);
	});

	it("reports every missing region, not just the first", () => {
		const failures = failuresFor(
			request({ requestedLayout: layout({ regions: ["a", "b"] }) }),
			yard({ layout: layout({ regions: ["c"] }) }),
		);
		expect(failures).toEqual(
			expect.arrayContaining(["region-missing:a", "region-missing:b"]),
		);
	});
});

describe("capability, isolation and network requirements", () => {
	it("accepts a requirement met by a capability", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ require: ["gpu"] }) }),
				yard({ capabilities: ["gpu"] }),
			),
		).toEqual([]);
	});

	it("accepts a requirement met by the yard's own layout", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ require: ["gpu"] }) }),
				yard({ layout: layout({ require: ["gpu"] }) }),
			),
		).toEqual([]);
	});

	it("rejects an unmet requirement", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ require: ["gpu"] }) }),
				yard(),
			),
		).toContain("capability-missing:gpu");
	});

	it("accepts isolation from either layout or capabilities", () => {
		for (const y of [
			yard({ layout: layout({ isolation: ["vm"] }) }),
			yard({ capabilities: ["vm"] }),
		])
			expect(
				failuresFor(
					request({ requestedLayout: layout({ isolation: ["vm"] }) }),
					y,
				),
			).toEqual([]);
	});

	it("rejects unmet isolation", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ isolation: ["vm"] }) }),
				yard(),
			),
		).toContain("isolation-missing:vm");
	});

	it("accepts network from either layout or capabilities", () => {
		for (const y of [
			yard({ layout: layout({ network: ["private"] }) }),
			yard({ capabilities: ["private"] }),
		])
			expect(
				failuresFor(
					request({ requestedLayout: layout({ network: ["private"] }) }),
					y,
				),
			).toEqual([]);
	});

	it("rejects unmet network", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ network: ["private"] }) }),
				yard(),
			),
		).toContain("network-missing:private");
	});
});

describe("component hosts", () => {
	it("accepts a host the yard's layout declares", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ componentHosts: ["wasmtime"] }) }),
				yard({ layout: layout({ componentHosts: ["wasmtime"] }) }),
			),
		).toEqual([]);
	});

	it("accepts a host declared with the host: prefix", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ componentHosts: ["wasmtime"] }) }),
				yard({ capabilities: ["host:wasmtime"] }),
			),
		).toEqual([]);
	});

	it("rejects an unavailable host", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ componentHosts: ["wasmtime"] }) }),
				yard(),
			),
		).toContain("component-host-missing:wasmtime");
	});
});

describe("bindle runtimes are soft for an undeclared yard", () => {
	it("does not reject a yard that declares no component hosts", () => {
		// An empty local yard accepts anything; failing here would make `hobo
		// dev` unusable against a freshly-seeded Yard.
		expect(
			failuresFor(request(), yard(), { bindleRuntimes: ["wasmtime"] }),
		).toEqual([]);
	});

	it("rejects a yard that declares hosts but not this one", () => {
		// Once a yard has said what it runs, silence about a runtime is a no.
		expect(
			failuresFor(
				request(),
				yard({ layout: layout({ componentHosts: ["jvm"] }) }),
				{
					bindleRuntimes: ["wasmtime"],
				},
			),
		).toContain("bindle-runtime-missing:wasmtime");
	});

	it.each([
		"runtime:wasmtime",
		"wasmtime",
	])("accepts the runtime declared as the capability %s", (capability) => {
		expect(
			failuresFor(
				request(),
				yard({
					layout: layout({ componentHosts: ["jvm"] }),
					capabilities: [capability],
				}),
				{ bindleRuntimes: ["wasmtime"] },
			),
		).toEqual([]);
	});
});

describe("property matching", () => {
	it("accepts a matching property", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ properties: { tier: "gold" } }) }),
				yard({ layout: layout({ properties: { tier: "gold" } }) }),
			),
		).toEqual([]);
	});

	it("rejects a conflicting property", () => {
		expect(
			failuresFor(
				request({ requestedLayout: layout({ properties: { tier: "gold" } }) }),
				yard({ layout: layout({ properties: { tier: "bronze" } }) }),
			),
		).toContain("property-mismatch:tier");
	});

	it("ignores a property the yard does not declare", () => {
		// Absent means unconstrained, which is what lets a yard stay generic.
		expect(
			failuresFor(
				request({ requestedLayout: layout({ properties: { tier: "gold" } }) }),
				yard(),
			),
		).toEqual([]);
	});
});

describe("exact mode", () => {
	it("selects the named yard", () => {
		const decision = match(
			request({ selectionMode: "exact", requestedYardId: "y2" }),
			[yard(), yard({ yardId: "y2" })],
		);
		expect(decision.winnerYardId).toBe("y2");
	});

	it("rejects when no id was supplied", () => {
		const decision = match(request({ selectionMode: "exact" }), [yard()]);
		expect(decision.outcome).toBe("rejected");
		expect(decision.rationale).toMatch(/requires requestedYardId/u);
	});

	it("does not fall back to a different yard", () => {
		// The whole meaning of "exact": a near miss is still a miss.
		const decision = match(
			request({ selectionMode: "exact", requestedYardId: "missing" }),
			[yard()],
		);
		expect(decision.outcome).toBe("rejected");
	});

	it("asks for generation when the named yard is absent and it was requested", () => {
		const decision = match(
			request({
				selectionMode: "exact",
				requestedYardId: "missing",
				allowGenerationRequested: true,
			}),
			[yard()],
		);
		expect(decision.outcome).toBe("generation-required");
	});

	it("marks a non-matching id as a hard failure on the candidate", () => {
		expect(
			failuresFor(
				request({ selectionMode: "exact", requestedYardId: "y2" }),
				yard(),
			),
		).toContain("exact-id-mismatch");
	});
});

describe("generation", () => {
	it("is requested when nothing is compatible and the mode allows it", () => {
		const decision = match(
			request({
				selectionMode: "compatible-or-generate",
				allowGenerationRequested: true,
				requestedLayout: layout({ require: ["gpu"] }),
			}),
			[yard()],
		);
		expect(decision.outcome).toBe("generation-required");
	});

	it("is not requested when the request did not ask for it", () => {
		// The request only ever *asks*; the flag is not authorization, and a
		// missing flag must not be read as one.
		const decision = match(
			request({
				selectionMode: "compatible-or-generate",
				requestedLayout: layout({ require: ["gpu"] }),
			}),
			[yard()],
		);
		expect(decision.outcome).toBe("rejected");
	});

	it("is not requested in plain compatible mode even when asked", () => {
		const decision = match(
			request({
				allowGenerationRequested: true,
				requestedLayout: layout({ require: ["gpu"] }),
			}),
			[yard()],
		);
		expect(decision.outcome).toBe("rejected");
	});

	it("prefers an existing compatible yard over generating one", () => {
		const decision = match(
			request({
				selectionMode: "compatible-or-generate",
				allowGenerationRequested: true,
			}),
			[yard()],
		);
		expect(decision.outcome).toBe("existing-yard");
	});
});

describe("determinism", () => {
	it("does not depend on the order yards appear in the inventory", () => {
		// The property the whole ranking design exists for: two brokers with the
		// same inventory must reach the same answer.
		const a = yard({ yardId: "a", registrationSeq: 9 });
		const b = yard({ yardId: "b", registrationSeq: 1 });
		expect(match(request(), [a, b]).winnerYardId).toBe(
			match(request(), [b, a]).winnerYardId,
		);
	});

	it("prefers the more specific yard regardless of order", () => {
		const generic = yard({ yardId: "generic" });
		const specific = yard({
			yardId: "specific",
			capabilities: ["gpu"],
			layout: layout({ require: ["gpu"] }),
		});
		const req = request({ requestedLayout: layout({ require: ["gpu"] }) });
		expect(match(req, [generic, specific]).winnerYardId).toBe("specific");
		expect(match(req, [specific, generic]).winnerYardId).toBe("specific");
	});

	it("produces the same decision for the same inputs", () => {
		expect(match(request(), [yard()])).toEqual(match(request(), [yard()]));
	});

	it("reports every candidate, not only the winner", () => {
		// A decision nobody can audit is a decision nobody can appeal.
		const decision = match(request(), [yard(), yard({ yardId: "y2" })]);
		expect(decision.candidates).toHaveLength(2);
	});

	it("freezes each candidate so a decision cannot be edited after the fact", () => {
		const decision = match(request(), [yard()]);
		expect(Object.isFrozen(decision.candidates[0])).toBe(true);
	});
});

describe("an empty inventory", () => {
	it("is rejected rather than crashing", () => {
		expect(match(request(), []).outcome).toBe("rejected");
	});

	it("still asks for generation when that was requested", () => {
		expect(
			match(
				request({
					selectionMode: "compatible-or-generate",
					allowGenerationRequested: true,
				}),
				[],
			).outcome,
		).toBe("generation-required");
	});
});
