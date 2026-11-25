/**
 * The Lakebed traffic adapter is two layers over one port: an in-process
 * weighted router, and an optional deploy-time driver-program binding. Its
 * interesting behaviour is entirely in what it refuses to claim.
 *
 * Lakebed has no public multi-load-balancer API, so most of the routing
 * vocabulary is genuinely unrealizable here. The adapter's job is to say so
 * precisely: `realized: "none"` when it cannot route the plan at all,
 * `"partial"` when it routes but drops declared features, `"full"` only when
 * nothing was lost. That verdict is what a caller uses to decide whether the
 * deployment honours its intent, so a shape that quietly reports `full` while
 * ignoring a header match is worse than one that refuses outright — the
 * operator believes their routing rule is in effect when it is not.
 *
 * The other half is the weighted selection. It must be deterministic (the same
 * routing key always reaches the same backend, or a session bounces between
 * replicas) and it must actually respect weights (or a 90/10 canary is a
 * coin flip). Both are properties no single example demonstrates.
 */
import { parseRoutingPlan, type RoutingPlan } from "@hobo/core";
import { describe, expect, test } from "vitest";

import {
	buildTrafficRouteProgram,
	createLakebedTrafficRouting,
	type LakebedTrafficDriverProgram,
} from "../src/traffic-routing/lakebed.js";

type Backend = {
	id: string;
	service: string;
	weight?: number;
	endpoint?: string;
	locationHints?: string[];
};

type RuleInput = {
	backends: Backend[];
	weightStrategy?: string;
	match?: { pathPrefix?: string; headers?: Record<string, string> };
};

function backend(overrides: Partial<Backend> = {}): Backend {
	return {
		id: "backend:1",
		service: "checkout-1",
		weight: 100,
		endpoint: "http://127.0.0.1:7071",
		...overrides,
	};
}

function plan(
	overrides: {
		planId?: string;
		rules?: RuleInput[];
		backends?: Backend[];
		availability?: Record<string, unknown>;
		resiliency?: Record<string, unknown>;
	} = {},
): RoutingPlan {
	const rules = overrides.rules ?? [{ backends: [backend()] }];
	const backends = overrides.backends ?? rules.flatMap((r) => r.backends);
	return parseRoutingPlan({
		planId: overrides.planId ?? "plan:lakebed:1",
		intent: {
			service: "checkout",
			tenantId: "tenant-a",
			rules,
			...(overrides.availability !== undefined
				? { availability: overrides.availability }
				: {}),
			...(overrides.resiliency !== undefined
				? { resiliency: overrides.resiliency }
				: {}),
		},
		backends,
		createdAt: "2026-08-03T15:00:00.000Z",
	} as never);
}

function routing(
	options: Parameters<typeof createLakebedTrafficRouting>[0] = {},
) {
	return createLakebedTrafficRouting(options);
}

describe("what Lakebed can and cannot realize", () => {
	test("a single static rule with endpoints realizes fully", () => {
		// The one shape this adapter genuinely supports end to end.
		return routing()
			.apply(plan())
			.then((result) => {
				expect(result.realized).toBe("full");
				expect(result.appliedRules).toBe(1);
				expect(result.capabilities).toContain("weighted-backends");
				expect(result.notes).toEqual([]);
			});
	});

	test("more than one rule cannot be realized at all", async () => {
		// There is no multi-rule dispatch here. Reporting anything but "none"
		// would tell the caller a second rule is live when nothing evaluates it.
		const result = await routing().apply(
			plan({
				rules: [
					{ backends: [backend()] },
					{ backends: [backend({ id: "b2" })] },
				],
			}),
		);
		expect(result.realized).toBe("none");
		expect(result.appliedRules).toBe(0);
		expect(result.unmet).toContain("multiple-rules");
	});

	test("a path-prefix match cannot be realized", async () => {
		// The in-process router selects on a routing key, not a URL path. A plan
		// that routes `/admin` somewhere specific is not being honoured.
		const result = await routing().apply(
			plan({
				rules: [{ backends: [backend()], match: { pathPrefix: "/admin" } }],
			}),
		);
		expect(result.realized).toBe("none");
		expect(result.unmet).toContain("rules[0].path-prefix");
	});

	test("a header match cannot be realized", async () => {
		const result = await routing().apply(
			plan({
				rules: [
					{ backends: [backend()], match: { headers: { "x-canary": "1" } } },
				],
			}),
		);
		expect(result.realized).toBe("none");
		expect(result.unmet).toContain("rules[0].header-match");
	});

	test("a backend without an endpoint cannot be realized", async () => {
		// The router forwards to a URL; a backend with none has nowhere to send
		// traffic, so the whole plan is unroutable rather than partly routable.
		const result = await routing().apply(
			plan({
				rules: [
					{
						backends: [backend(), { id: "b2", service: "checkout-2" }],
					},
				],
			}),
		);
		expect(result.realized).toBe("none");
		expect(result.unmet).toContain("rules[0].backends[1].endpoint");
	});

	test("a non-static weight strategy cannot be realized", async () => {
		// Dynamic strategies need health or locality feedback this adapter does
		// not have. The vocabulary is `static | prefer-healthy | locality` — the
		// port's own parse layer rejects anything else, so an unrealizable
		// strategy here is always one of the two real alternatives rather than a
		// typo.
		for (const weightStrategy of ["prefer-healthy", "locality"]) {
			const result = await routing().apply(
				plan({ rules: [{ backends: [backend()], weightStrategy }] }),
			);
			expect(result.realized).toBe("none");
			expect(result.unmet.join(" ")).toContain(
				`weightStrategy:${weightStrategy}`,
			);
		}
	});

	test("an unknown weight strategy never reaches the adapter", () => {
		// Worth pinning where the guarantee lives: the adapter does not need to
		// defend against a nonsense strategy because `parseRoutingPlan` refuses
		// to build a plan carrying one.
		expect(() =>
			plan({
				rules: [{ backends: [backend()], weightStrategy: "least-latency" }],
			}),
		).toThrow(/expected static \| prefer-healthy \| locality/);
	});

	test("availability constraints are reported as unmet", async () => {
		// This one is the important asymmetry: the plan *is* routable, so it
		// realizes partially rather than not at all — but the constraint is named
		// so nobody believes a minimum-healthy-backends guarantee is in force.
		const result = await routing().apply(
			plan({ availability: { minHealthyBackends: 2 } }),
		);
		expect(result.realized).toBe("partial");
		expect(result.unmet).toContain("availability-constraints");
		expect(result.appliedRules).toBe(1);
	});

	test("resiliency settings are reported as unmet but still route", async () => {
		const result = await routing().apply(plan({ resiliency: { retries: 3 } }));
		expect(result.realized).toBe("partial");
		expect(result.unmet).toContain("resiliency");
	});

	test("a partial realization explains itself in the notes", async () => {
		// The notes are what an operator reads; a partial verdict with no
		// explanation gives them nothing to act on.
		const result = await routing().apply(
			plan({ availability: { minHealthyBackends: 2 } }),
		);
		expect(result.notes.join(" ")).toContain("declared backend order");
	});

	test("an unrealizable plan explains that too", async () => {
		const result = await routing().apply(
			plan({ rules: [{ backends: [backend()], match: { pathPrefix: "/a" } }] }),
		);
		expect(result.notes.join(" ")).toContain("cannot realize");
	});

	test("unmet reasons are deduplicated", async () => {
		// Two rules each contributing "multiple-rules" would list it twice and
		// make the report look worse than it is.
		const result = await routing().apply(
			plan({
				rules: [
					{ backends: [backend()], match: { pathPrefix: "/a" } },
					{ backends: [backend({ id: "b2" })], match: { pathPrefix: "/b" } },
				],
			}),
		);
		expect(new Set(result.unmet).size).toBe(result.unmet.length);
	});

	test("a fully realized plan carries no unmet list", async () => {
		// An empty-but-present list and an absent one read differently to a
		// caller checking whether anything was dropped.
		const result = await routing().apply(plan());
		expect(result.unmet ?? []).toEqual([]);
	});
});

describe("weighted selection", () => {
	function applied(backends: Backend[]) {
		const router = routing();
		const p = plan({ planId: "plan:select", rules: [{ backends }] });
		return router.apply(p).then(() => ({ router, planId: p.planId }));
	}

	test("the same routing key always reaches the same backend", async () => {
		// Stickiness. Without it a user's session bounces between replicas on
		// every request, which breaks anything holding per-connection state.
		const { router, planId } = await applied([
			backend({ id: "a", weight: 50 }),
			backend({ id: "b", weight: 50, endpoint: "http://127.0.0.1:7072" }),
		]);
		const first = router.select(planId, "user-1")?.id;
		for (let i = 0; i < 20; i++) {
			expect(router.select(planId, "user-1")?.id).toBe(first);
		}
	});

	test("different keys spread across backends", async () => {
		// A hash that clustered would send every user to one replica while
		// reporting a 50/50 split.
		const { router, planId } = await applied([
			backend({ id: "a", weight: 50 }),
			backend({ id: "b", weight: 50, endpoint: "http://127.0.0.1:7072" }),
		]);
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const chosen = router.select(planId, `user-${i}`);
			if (chosen) seen.add(chosen.id);
		}
		expect(seen.size).toBe(2);
	});

	test("weights are actually honoured across a population", async () => {
		// A 90/10 canary that selected uniformly would put ten times the intended
		// traffic on the new version — the failure this whole mechanism exists to
		// avoid.
		const { router, planId } = await applied([
			backend({ id: "stable", weight: 90 }),
			backend({ id: "canary", weight: 10, endpoint: "http://127.0.0.1:7072" }),
		]);
		let canary = 0;
		const total = 2000;
		for (let i = 0; i < total; i++) {
			if (router.select(planId, `user-${i}`)?.id === "canary") canary += 1;
		}
		const share = canary / total;
		expect(share).toBeGreaterThan(0.05);
		expect(share).toBeLessThan(0.16);
	});

	test("a backend with no explicit weight counts as one", async () => {
		// The default has to be a real number or the total collapses and the
		// modulo divides by zero.
		const { router, planId } = await applied([
			{ id: "a", service: "s", endpoint: "http://127.0.0.1:7071" },
			{ id: "b", service: "s", endpoint: "http://127.0.0.1:7072" },
		]);
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const chosen = router.select(planId, `k-${i}`);
			if (chosen) seen.add(chosen.id);
		}
		expect(seen.size).toBe(2);
	});

	test("a zero weight is refused at the plan boundary, not drained at runtime", () => {
		// I expected weight 0 to be the drain-a-canary idiom. It is not: the port
		// requires a *positive integer*, so a zero-weight backend cannot exist in
		// a parsed plan at all.
		//
		// That is the stronger guarantee. Draining is expressed by removing the
		// backend from the rule rather than by weighting it to nothing, which
		// means `selectBackend`'s running total can never be zero and its modulo
		// can never divide by zero. Pinning it here so the invariant the selector
		// relies on is visible from the tests.
		expect(() =>
			plan({
				rules: [
					{
						backends: [
							backend({ id: "live", weight: 100 }),
							backend({
								id: "drained",
								weight: 0,
								endpoint: "http://127.0.0.1:7072",
							}),
						],
					},
				],
			}),
		).toThrow(/expected positive integer/);
	});

	test("a heavily outweighed backend is reached only rarely", async () => {
		// The nearest realizable version of the drain case: weight 1 against 99.
		// Weights are bounded to 1..100 by the port, so neither 0 nor 999 is
		// available. The residual backend still receives traffic — which is the
		// honest behaviour, and the reason draining means removing a backend
		// rather than weighting it down to nothing.
		const { router, planId } = await applied([
			backend({ id: "live", weight: 99 }),
			backend({ id: "residual", weight: 1, endpoint: "http://127.0.0.1:7072" }),
		]);
		let residual = 0;
		for (let i = 0; i < 500; i++) {
			if (router.select(planId, `user-${i}`)?.id === "residual") residual += 1;
		}
		expect(residual).toBeLessThan(25);
	});

	test("selection is stable across separate router instances", async () => {
		// The hash must be a pure function of the key, not of process state, or a
		// restart reshuffles every user onto a different backend.
		const backends = [
			backend({ id: "a", weight: 50 }),
			backend({ id: "b", weight: 50, endpoint: "http://127.0.0.1:7072" }),
		];
		const first = await applied(backends);
		const second = await applied(backends);
		for (const key of ["user-1", "user-2", "user-3"]) {
			expect(first.router.select(first.planId, key)?.id).toBe(
				second.router.select(second.planId, key)?.id,
			);
		}
	});

	test("selecting from an unknown plan yields null", async () => {
		const router = routing();
		expect(router.select("plan:never-applied" as never, "user-1")).toBeNull();
	});

	test("selecting from an unrealizable plan yields null", async () => {
		// The plan was recorded so `status` can report on it, but nothing routes
		// through it — returning a backend would be a promise the adapter cannot
		// keep.
		const router = routing();
		const p = plan({
			planId: "plan:unrealizable",
			rules: [{ backends: [backend()], match: { pathPrefix: "/a" } }],
		});
		await router.apply(p);
		expect(router.select(p.planId, "user-1")).toBeNull();
	});

	test("selecting from a revoked plan yields null", async () => {
		const router = routing();
		const p = plan({ planId: "plan:revoked" });
		await router.apply(p);
		await router.revoke(p.planId);
		expect(router.select(p.planId, "user-1")).toBeNull();
	});

	test("an out-of-range rule index yields null", async () => {
		const router = routing();
		const p = plan({ planId: "plan:index" });
		await router.apply(p);
		expect(router.select(p.planId, "user-1", 5)).toBeNull();
	});
});

describe("status and revoke", () => {
	test("an unknown plan has no status", async () => {
		expect(await routing().status("plan:never" as never)).toBeNull();
	});

	test("a realized plan reports active", async () => {
		const router = routing();
		const p = plan();
		await router.apply(p);
		const status = await router.status(p.planId);
		expect(status?.active).toBe(true);
		expect(status?.realized).toBe("full");
	});

	test("an unrealizable plan reports inactive but still has a status", async () => {
		// The distinction matters: "no such plan" and "that plan cannot run here"
		// are different answers, and only the second is actionable.
		const router = routing();
		const p = plan({
			planId: "plan:none",
			rules: [{ backends: [backend()], match: { pathPrefix: "/a" } }],
		});
		await router.apply(p);
		const status = await router.status(p.planId);
		expect(status).not.toBeNull();
		expect(status?.active).toBe(false);
		expect(status?.realized).toBe("none");
	});

	test("a revoked plan reports inactive with a reason", async () => {
		const router = routing();
		const p = plan();
		await router.apply(p);
		await router.revoke(p.planId);
		const status = await router.status(p.planId);
		expect(status?.active).toBe(false);
		expect(status?.notes.join(" ")).toContain("revoked");
	});

	test("revoking an unknown plan fails rather than silently succeeding", async () => {
		// A caller tearing down routing needs to know the revoke did not apply to
		// anything, or a stale plan keeps serving.
		const result = await routing().revoke("plan:never" as never);
		expect(result.ok).toBe(false);
		expect(result.notes.join(" ")).toContain("not found");
	});

	test("revoking twice is idempotent", async () => {
		const router = routing();
		const p = plan();
		await router.apply(p);
		expect((await router.revoke(p.planId)).ok).toBe(true);
		expect((await router.revoke(p.planId)).ok).toBe(true);
	});

	test("re-applying a plan id replaces the previous state", async () => {
		// A revoked plan that came back must not stay revoked.
		const router = routing();
		const p = plan({ planId: "plan:reapply" });
		await router.apply(p);
		await router.revoke(p.planId);
		await router.apply(p);
		expect((await router.status(p.planId))?.active).toBe(true);
	});
});

describe("the deploy-time driver program", () => {
	test("no program is built when deploy is not configured", () => {
		// The driver program binds a domain at deploy time; producing one nobody
		// asked for would be a side effect on the deployment.
		const router = routing();
		const p = plan();
		return router.apply(p).then(() => {
			expect(router.driverProgram(p.planId)).toBeNull();
		});
	});

	test("a program is built when deploy is configured", async () => {
		const router = routing({ deploy: {} });
		const p = plan();
		await router.apply(p);
		const program = router.driverProgram(p.planId);
		expect(program?.apiVersion).toBe("hobo.driver-program/v1");
		expect(program?.driver).toBe("lakebed-deploy");
	});

	test("a failing deploy binding degrades the result rather than throwing", async () => {
		// The in-process router still works; the deployment simply is not bound
		// to a domain. Throwing would fail an apply that partly succeeded.
		const router = routing({
			deploy: {
				applyDriverProgram: async () => ({
					ok: false,
					notes: ["domain already bound"],
				}),
			},
		});
		const result = await router.apply(plan());
		expect(result.realized).toBe("partial");
		expect(result.unmet).toContain("deploy-binding");
		expect(result.notes.join(" ")).toContain("domain already bound");
	});

	test("a deploy binding that throws is caught and reported", async () => {
		const router = routing({
			deploy: {
				applyDriverProgram: async () => {
					throw new Error("lakebed API unreachable");
				},
			},
		});
		const result = await router.apply(plan());
		expect(result.realized).toBe("partial");
		expect(result.notes.join(" ")).toContain("lakebed API unreachable");
	});

	test("a failing binding with no notes still explains itself", async () => {
		const router = routing({
			deploy: { applyDriverProgram: async () => ({ ok: false }) },
		});
		const result = await router.apply(plan());
		expect(result.notes.join(" ")).toContain("deploy binding failed");
	});

	test("a successful binding leaves the result full", async () => {
		const router = routing({
			deploy: { applyDriverProgram: async () => ({ ok: true }) },
		});
		const result = await router.apply(plan());
		expect(result.realized).toBe("full");
		expect(result.notes).toEqual([]);
	});

	test("no program is returned for a revoked plan", async () => {
		const router = routing({ deploy: {} });
		const p = plan();
		await router.apply(p);
		await router.revoke(p.planId);
		expect(router.driverProgram(p.planId)).toBeNull();
	});

	test("no program is returned for an unknown plan", () => {
		expect(
			routing({ deploy: {} }).driverProgram("plan:never" as never),
		).toBeNull();
	});
});

describe("buildTrafficRouteProgram", () => {
	test("the deployment id and capsule are derived from the plan", () => {
		const program = buildTrafficRouteProgram(plan());
		expect(program.deploymentId).toBe("plan-lakebed-1");
		expect(program.capsule).toBe("capsule/checkout");
	});

	test("explicit deploy options override the derived values", () => {
		const program = buildTrafficRouteProgram(plan(), {
			deploymentId: "deploy-42",
			capsule: "capsule/custom",
		});
		expect(program.deploymentId).toBe("deploy-42");
		expect(program.capsule).toBe("capsule/custom");
	});

	test("whitespace-only overrides fall back to the derived values", () => {
		// A blank field in config is an absent field, not an empty deployment id
		// — which would produce a driver program that binds nothing.
		const program = buildTrafficRouteProgram(plan(), {
			deploymentId: "   ",
			capsule: "  ",
		});
		expect(program.deploymentId).toBe("plan-lakebed-1");
		expect(program.capsule).toBe("capsule/checkout");
	});

	test("plan ids are sanitised into safe resource names", () => {
		// The id becomes part of a resource name in a declarative program;
		// unescaped punctuation would produce an invalid or ambiguous reference.
		const program = buildTrafficRouteProgram(
			plan({ planId: "plan:lakebed/weird id!" }),
		);
		expect(program.resources[0]?.name).toMatch(/^route-[A-Za-z0-9._-]+$/);
		expect(program.deploymentId).not.toContain("/");
		expect(program.deploymentId).not.toContain("!");
	});

	test("leading and trailing separators are trimmed from the sanitised id", () => {
		const program = buildTrafficRouteProgram(plan({ planId: "!!weird!!" }));
		expect(program.deploymentId).toBe("weird");
	});

	test("a plan id that sanitises to nothing falls back to a usable default", () => {
		// `!!!` becomes the empty string, and an empty deployment id would make
		// the program unusable rather than merely oddly named.
		const program = buildTrafficRouteProgram(plan({ planId: "!!!" }));
		expect(program.deploymentId).toBe("traffic");
	});

	test("optional backend fields are omitted rather than emitted as undefined", () => {
		// The program is serialised into a declarative document; an explicit
		// undefined is not the same as an absent key there.
		const program = buildTrafficRouteProgram(
			plan({
				rules: [{ backends: [{ id: "b1", service: "s" }] }],
			}),
		);
		const emitted = (
			program.resources[0]?.inputs.backends as Array<Record<string, unknown>>
		)[0];
		expect(emitted && "endpoint" in emitted).toBe(false);
		expect(emitted && "weight" in emitted).toBe(false);
		expect(emitted && "locationHints" in emitted).toBe(false);
	});

	test("present backend fields are carried through", () => {
		const program = buildTrafficRouteProgram(
			plan({
				rules: [
					{
						backends: [backend({ weight: 25, locationHints: ["eu-west"] })],
					},
				],
			}),
		);
		const emitted = (
			program.resources[0]?.inputs.backends as Array<Record<string, unknown>>
		)[0];
		expect(emitted?.weight).toBe(25);
		expect(emitted?.locationHints).toEqual(["eu-west"]);
		expect(emitted?.endpoint).toBe("http://127.0.0.1:7071");
	});

	test("rules reference backends by id, not by value", () => {
		// Duplicating the full backend record inside each rule would let the two
		// copies drift; the id is the single source.
		const program = buildTrafficRouteProgram(plan());
		const rules = program.resources[0]?.inputs.rules as Array<
			Record<string, unknown>
		>;
		expect(rules[0]?.backends).toEqual(["backend:1"]);
	});

	test("a rule match is emitted only when present", () => {
		const without = buildTrafficRouteProgram(plan());
		const withoutRules = without.resources[0]?.inputs.rules as Array<
			Record<string, unknown>
		>;
		expect(withoutRules[0] && "match" in withoutRules[0]).toBe(false);

		const withMatch = buildTrafficRouteProgram(
			plan({
				rules: [{ backends: [backend()], match: { pathPrefix: "/admin" } }],
			}),
		);
		const withRules = withMatch.resources[0]?.inputs.rules as Array<
			Record<string, unknown>
		>;
		expect(withRules[0]?.match).toEqual({ pathPrefix: "/admin" });
	});

	test("the outputs reference the resource by its generated name", () => {
		// A mismatch here would produce a program whose outputs resolve to
		// nothing at apply time.
		const program: LakebedTrafficDriverProgram = buildTrafficRouteProgram(
			plan(),
		);
		const name = program.resources[0]?.name;
		expect(program.outputs.routeId).toBe(
			`\${resources.${name}.outputs.routeId}`,
		);
		expect(program.outputs.binding).toBe(
			`\${resources.${name}.outputs.binding}`,
		);
	});

	test("the resource declares the outputs the references depend on", () => {
		const program = buildTrafficRouteProgram(plan());
		expect(program.resources[0]?.outputs).toEqual(["routeId", "binding"]);
	});
});

describe("metering", () => {
	function bus() {
		const emitted: Array<Record<string, unknown>> = [];
		return {
			bus: {
				async emit(event: Record<string, unknown>) {
					emitted.push(event);
				},
			},
			emitted,
		};
	}

	test("a full realization meters an apply", async () => {
		const { bus: metering, emitted } = bus();
		await routing({ metering: metering as never }).apply(plan());
		expect(emitted).toHaveLength(1);
		// The bus receives a UsageEvent, so the outcome is encoded in its
		// eventType rather than carried as its own field.
		expect((emitted[0] as { eventType?: string }).eventType).toBe(
			"routing.plan.apply",
		);
	});

	test("a partial realization meters as degraded", async () => {
		// The three outcomes are distinguishable on purpose — a degraded apply is
		// the one worth alerting on, and collapsing it into "apply" would hide it.
		const { bus: metering, emitted } = bus();
		await routing({ metering: metering as never }).apply(
			plan({ availability: { minHealthyBackends: 2 } }),
		);
		expect((emitted[0] as { eventType?: string }).eventType).toBe(
			"routing.plan.degraded",
		);
	});

	test("an unrealizable plan meters as a denial", async () => {
		const { bus: metering, emitted } = bus();
		await routing({ metering: metering as never }).apply(
			plan({ rules: [{ backends: [backend()], match: { pathPrefix: "/a" } }] }),
		);
		expect((emitted[0] as { eventType?: string }).eventType).toBe(
			"routing.plan.deny",
		);
	});

	test("the event is scoped to the plan's tenant", async () => {
		const { bus: metering, emitted } = bus();
		await routing({ metering: metering as never }).apply(plan());
		expect((emitted[0] as { tenantId?: string }).tenantId).toBe("tenant-a");
	});

	test("a metering failure does not fail the apply", async () => {
		// Applied state is authoritative. Losing an observation must not lose the
		// routing change that was actually made.
		const router = routing({
			metering: {
				async emit() {
					throw new Error("metering sink down");
				},
			} as never,
		});
		const result = await router.apply(plan());
		expect(result.realized).toBe("full");
	});

	test("apply works with no metering bus at all", async () => {
		await expect(routing().apply(plan())).resolves.toBeDefined();
	});
});
