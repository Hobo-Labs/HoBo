/**
 * The Vercel traffic-routing adapter's refusals and mode selection.
 *
 * Every dependency is injectable — `token`, `fetchImpl`, `metering` — so the
 * whole surface is reachable without a Vercel account.
 *
 * The interesting behaviour is all refusal. This adapter can realize a routing
 * plan two ways, and it declines rather than guessing when neither fits:
 *
 * **A plan id may not be reused for different content.** Re-applying the same
 * id with a different plan would silently replace live routing with something
 * the operator did not diff. It is refused with a named reason instead — and
 * the *same* content under the same id is fine, because a retry after a timeout
 * has to be safe.
 *
 * **Missing credentials deny before anything is sent.** A request that would
 * certainly 401 is not worth making, and the denial says which input is
 * missing rather than reporting an API error.
 *
 * **An unrealizable plan is declined, not approximated.** Vercel's Rolling
 * Releases need exactly two backends under one static rule; a plan that does
 * not fit either that or a rewrites shape gets `mode` as its reason. Half-
 * applying it would leave traffic split in a way nobody asked for.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import { createVercelTrafficRouting } from "../../src/traffic-routing/vercel.js";

function plan(overrides: JsonObject = {}) {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		planId: "p1",
		intent: {
			service: "web",
			tenantId: "t1",
			rules: [
				{
					weightStrategy: "static",
					backends: [
						{ id: "stable", service: "web", weight: 90 },
						{ id: "canary", service: "web", weight: 10 },
					],
				},
			],
		},
		backends: [
			{ id: "stable", service: "web", weight: 90 },
			{ id: "canary", service: "web", weight: 10 },
		],
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	} as never;
}

/** Rewrites need a backend endpoint; without one the plan is declined. */
const ENDPOINT_BACKEND = {
	id: "stable",
	service: "web",
	endpoint: "https://stable.example.com",
};

/** A fetch that records calls and replays one canned reply. */
function stubFetch(
	reply: { ok?: boolean; status?: number; body?: unknown } = {},
) {
	const calls: { url: string; init: RequestInit }[] = [];
	// SAFETY: assertion required at this I/O or test boundary.
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return {
			ok: reply.ok ?? true,
			status: reply.status ?? 200,
			json: async () => reply.body ?? {},
		};
	}) as typeof fetch;
	return { calls, impl };
}

const routing = (options: JsonObject = {}) =>
	// SAFETY: assertion required at this I/O or test boundary.
	createVercelTrafficRouting({
		token: "vt-token",
		projectIdOrName: "proj",
		fetchImpl: stubFetch().impl,
		...options,
	} as never);

describe("credential and project refusals", () => {
	it("denies with no token, before making a request", () => {
		// A request that would certainly 401 is not worth making, and the denial
		// names the missing input rather than reporting an API error.
		const { calls, impl } = stubFetch();
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			projectIdOrName: "proj",
			fetchImpl: impl,
		} as never);
		return port.apply(plan()).then((result) => {
			expect(result.realized).toBe("none");
			expect(calls).toHaveLength(0);
		});
	});

	it("names credentials as the reason", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			projectIdOrName: "proj",
		} as never);
		const result = await port.apply(plan());
		expect(result.unmet).toContain("credentials");
	});

	it("treats a whitespace-only token as absent", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "   ",
			projectIdOrName: "proj",
		} as never);
		expect((await port.apply(plan())).unmet).toContain("credentials");
	});

	it("denies with no project", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "",
		} as never);
		const result = await port.apply(plan());
		expect(result.unmet).toContain("project");
	});

	it("treats a whitespace-only project as absent", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "  ",
		} as never);
		expect((await port.apply(plan())).unmet).toContain("project");
	});

	it("explains what to supply", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			projectIdOrName: "proj",
		} as never);
		expect((await port.apply(plan())).notes.join(" ")).toMatch(
			/token is required/u,
		);
	});
});

describe("plan-id reuse", () => {
	it("refuses the same id with different content", async () => {
		// Silently replacing live routing with something nobody diffed is the
		// failure this guard exists for.
		const port = routing({
			deploymentIdsByBackend: { stable: "dep-a", canary: "dep-b" },
		});
		await port.apply(plan());
		const result = await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							weightStrategy: "static",
							backends: [
								{ id: "stable", service: "web", weight: 50 },
								{ id: "canary", service: "web", weight: 50 },
							],
						},
					],
				},
			}),
		);
		expect(result.unmet).toContain("plan-id-conflict");
	});

	it("permits re-applying identical content, so a retry is safe", async () => {
		// A timeout leaves the caller unsure whether the apply landed; retrying
		// the same plan must not be treated as a conflict.
		const port = routing({
			deploymentIdsByBackend: { stable: "dep-a", canary: "dep-b" },
		});
		await port.apply(plan());
		const second = await port.apply(plan());
		expect(second.unmet ?? []).not.toContain("plan-id-conflict");
	});

	it("says the id is already active in the note", async () => {
		const port = routing({
			deploymentIdsByBackend: { stable: "dep-a", canary: "dep-b" },
		});
		await port.apply(plan());
		const result = await port.apply(plan({ backends: [] }));
		expect(result.notes.join(" ")).toMatch(/already active/u);
	});
});

describe("mode selection", () => {
	it("declines a plan that fits neither realization", async () => {
		// Half-applying an unrealizable plan would leave traffic split in a way
		// nobody asked for.
		const result = await routing().apply(
			plan({
				intent: { service: "web", tenantId: "t1", rules: [] },
				backends: [],
			}),
		);
		expect(result.unmet).toContain("mode");
	});

	it("explains that the plan shape does not fit", async () => {
		const result = await routing().apply(
			plan({
				intent: { service: "web", tenantId: "t1", rules: [] },
				backends: [],
			}),
		);
		expect(result.notes.join(" ")).toMatch(/rolling-release or rewrites/u);
	});

	it("honours a forced rolling-release mode", async () => {
		// The forced mode skips detection entirely, which is what makes it
		// useful for a plan the detector would decline.
		const port = routing({
			mode: "rolling-release",
			deploymentIdsByBackend: { stable: "dep-a", canary: "dep-b" },
		});
		const result = await port.apply(plan());
		expect(result.unmet ?? []).not.toContain("mode");
	});

	it("honours a forced rewrites mode", async () => {
		const port = routing({ mode: "rewrites" });
		const result = await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							match: { pathPrefix: "/api" },
							weightStrategy: "static",
							backends: [ENDPOINT_BACKEND],
						},
					],
				},
				backends: [ENDPOINT_BACKEND],
			}),
		);
		expect(result.unmet ?? []).not.toContain("mode");
	});

	it("declines a rolling release with more than one rule", async () => {
		// Rolling Releases realize one canary split; two rules is two policies.
		const rule = {
			weightStrategy: "static",
			backends: [
				{ id: "stable", service: "web", weight: 90 },
				{ id: "canary", service: "web", weight: 10 },
			],
		};
		const result = await routing().apply(
			plan({
				intent: { service: "web", tenantId: "t1", rules: [rule, rule] },
			}),
		);
		expect(result.realized).toBe("none");
	});

	it("declines a non-static weight strategy", async () => {
		const result = await routing().apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							weightStrategy: "latency",
							backends: [
								{ id: "stable", service: "web", weight: 90 },
								{ id: "canary", service: "web", weight: 10 },
							],
						},
					],
				},
			}),
		);
		expect(result.realized).toBe("none");
	});
});

describe("status", () => {
	const rewritePlan = () =>
		plan({
			intent: {
				service: "web",
				tenantId: "t1",
				rules: [
					{
						match: { pathPrefix: "/api" },
						weightStrategy: "static",
						backends: [ENDPOINT_BACKEND],
					},
				],
			},
			backends: [ENDPOINT_BACKEND],
		});

	it("reports nothing for a plan it never applied", async () => {
		// Null rather than a fabricated inactive status: "we have no record" and
		// "it is inactive" are different facts.
		// SAFETY: assertion required at this I/O or test boundary.
		expect(await routing().status("never-applied" as never)).toBeNull();
	});

	it("does not record a plan the provider never confirmed", async () => {
		// The important one. An apply that came back without a version id did
		// not land, so tracking it as applied would make `status` report routing
		// that does not exist — and a later revoke would claim to undo it.
		const port = routing({ mode: "rewrites" });
		const result = await port.apply(rewritePlan());
		expect(result.realized).toBe("none");
		// SAFETY: assertion required at this I/O or test boundary.
		expect(await port.status("p1" as never)).toBeNull();
	});

	it("names the provider API as the unmet requirement", async () => {
		const port = routing({ mode: "rewrites" });
		expect((await port.apply(rewritePlan())).unmet).toContain("provider-api");
	});

	it("refuses to revoke a plan it never recorded", async () => {
		// Reporting success would tell an operator routing was removed when
		// nothing was ever installed.
		const port = routing({ mode: "rewrites" });
		await port.apply(rewritePlan());
		// SAFETY: assertion required at this I/O or test boundary.
		const revoked = await port.revoke("p1" as never);
		expect(revoked.ok).toBe(false);
		expect(revoked.notes.join(" ")).toMatch(/not found/u);
	});

	it("refuses to revoke an id it has never seen", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect((await routing().revoke("never" as never)).ok).toBe(false);
	});
});

describe("the request layer", () => {
	it("presents the token as a bearer credential", async () => {
		const { calls, impl } = stubFetch();
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt-secret",
			projectIdOrName: "proj",
			fetchImpl: impl,
			mode: "rewrites",
		} as never);
		await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							match: { pathPrefix: "/api" },
							weightStrategy: "static",
							backends: [ENDPOINT_BACKEND],
						},
					],
				},
				backends: [ENDPOINT_BACKEND],
			}),
		);
		// SAFETY: assertion required at this I/O or test boundary.
		const auth = (calls[0]?.init.headers as Record<string, string>)
			?.authorization;
		expect(auth).toBe("Bearer vt-secret");
	});

	it("adds the team id as a query parameter when configured", async () => {
		const { calls, impl } = stubFetch();
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "proj",
			teamId: "team-1",
			fetchImpl: impl,
			mode: "rewrites",
		} as never);
		await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							match: { pathPrefix: "/api" },
							weightStrategy: "static",
							backends: [ENDPOINT_BACKEND],
						},
					],
				},
				backends: [ENDPOINT_BACKEND],
			}),
		);
		expect(calls[0]?.url).toContain("teamId=team-1");
	});

	it("strips trailing slashes from a custom API base", async () => {
		const { calls, impl } = stubFetch();
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "proj",
			apiBase: "https://api.example.com//",
			fetchImpl: impl,
			mode: "rewrites",
		} as never);
		await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							match: { pathPrefix: "/api" },
							weightStrategy: "static",
							backends: [ENDPOINT_BACKEND],
						},
					],
				},
				backends: [ENDPOINT_BACKEND],
			}),
		);
		expect(calls[0]?.url).not.toContain("//v");
	});

	it("survives a transport that throws rather than propagating it", async () => {
		// A network error must become a denial the caller can read, not an
		// exception mid-apply that leaves routing in an unknown state.
		// SAFETY: assertion required at this I/O or test boundary.
		const impl = (async () => {
			throw new Error("socket hang up");
		}) as typeof fetch;
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "proj",
			fetchImpl: impl,
			mode: "rewrites",
		} as never);
		const result = await port.apply(
			plan({
				intent: {
					service: "web",
					tenantId: "t1",
					rules: [
						{
							match: { pathPrefix: "/api" },
							weightStrategy: "static",
							backends: [ENDPOINT_BACKEND],
						},
					],
				},
				backends: [ENDPOINT_BACKEND],
			}),
		);
		expect(result.realized).toBe("none");
	});

	it("survives a non-JSON response body", async () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const impl = (async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("not json");
			},
		})) as typeof fetch;
		// SAFETY: assertion required at this I/O or test boundary.
		const port = createVercelTrafficRouting({
			token: "vt",
			projectIdOrName: "proj",
			fetchImpl: impl,
			mode: "rewrites",
		} as never);
		await expect(
			port.apply(
				plan({
					intent: {
						service: "web",
						tenantId: "t1",
						rules: [
							{
								match: { pathPrefix: "/api" },
								weightStrategy: "static",
								backends: [ENDPOINT_BACKEND],
							},
						],
					},
					backends: [ENDPOINT_BACKEND],
				}),
			),
		).resolves.toBeTruthy();
	});
});

describe("the port's identity", () => {
	it("reports its provider", () => {
		expect(routing().provider).toBe("vercel");
	});

	it("exposes revoke, which the base port leaves optional", () => {
		expect(routing().revoke instanceof Function).toBe(true);
	});
});
