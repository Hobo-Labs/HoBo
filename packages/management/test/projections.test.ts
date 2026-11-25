/**
 * Folding Station and Connection state into the Yard projection.
 *
 * `management.test.ts` drives the ops surface; this covers the read model the
 * game UI actually renders. Everything here is a *derivation*, which is the
 * awkward category to test: nothing throws when it is wrong, the UI simply
 * shows something plausible and false.
 *
 * Three properties earn most of the attention:
 *
 * - **The provenance badges.** `trafficRate` is synthesized from connection
 *   counts, not measured; `activity.status` is derived from the connection
 *   lifecycle, not agent telemetry. The badges are the only thing separating a
 *   number that means something from a number that looks like it does. A
 *   projection that dropped them would make the UI's honest "synthetic" label
 *   disappear, and the rate would read as real.
 * - **Nothing is invented outside the event-sourced services.** The module
 *   header says the projection never fabricates occupancy, rail, or connection
 *   state. The tests below hold it to that: with an empty station, the rails and
 *   connections are empty and the metering figures are zero rather than
 *   defaults someone thought looked better.
 * - **Hazards are exhaustive.** A hazard that fails to fire is a warning the
 *   operator never sees, so each one is asserted on its own and in combination.
 *
 * The context is a hand-built fake rather than a real store, because the point
 * is to control the *input state* precisely — a real store would make several
 * of these states difficult to reach and impossible to isolate.
 */
import { describe, expect, it } from "vitest";

import type { ManagementContext } from "../src/context.js";
import {
	brokerStatus,
	doctorSnapshot,
	projectYardSnapshot,
} from "../src/projections.js";

type Connection = {
	id: string;
	provider: string;
	status: string;
	stationId: string;
	flow: string;
	subject: string;
	grantedScopes: readonly string[];
	requestedScopes: readonly string[];
};

function connection(overrides: Partial<Connection> = {}): Connection {
	return {
		id: "conn-1",
		provider: "claude",
		status: "active",
		stationId: "station:local",
		flow: "oauth",
		subject: "user:local",
		grantedScopes: [],
		requestedScopes: [],
		...overrides,
	};
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
function occupancy(overrides: Record<string, unknown> = {}) {
	return {
		stationId: "station:local",
		seq: 7,
		status: "open",
		bootstrapActive: false,
		connectionCount: 0,
		activeRailHash: undefined,
		isolation: { tenant: "acme" },
		...overrides,
	};
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
function rail(overrides: Record<string, unknown> = {}) {
	return {
		hash: "rail-1",
		name: "main",
		bootstrap: false,
		billingPolicy: {
			quotaUsed: 10,
			quotaLimit: 100,
			spendCapUsd: 50,
			budgetUsd: 25,
		},
		...overrides,
	};
}

/** A context whose station and connection state the test states outright. */
function context(
	options: {
		readonly state?: unknown;
		readonly connections?: readonly Connection[];
		readonly tenant?: string;
		readonly occupyMode?: "idle" | "occupying";
		readonly stationId?: string | undefined;
	} = {},
): ManagementContext {
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
	return {
		hoboHome: "/nowhere",
		resolveActor: () => ({
			kind: "user",
			id: "user:local",
			tenant: options.tenant ?? "acme",
		}),
		loadStationState: () => options.state ?? null,
		loadConnectionService: () => ({
			list: () => options.connections ?? [],
		}),
		getOccupyMode: () => options.occupyMode ?? "idle",
	} as unknown as ManagementContext;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
function state(overrides: Record<string, unknown> = {}) {
	return {
		occupancy: occupancy(),
		rails: {},
		...overrides,
	};
}

describe("requiring a station", () => {
	it("refuses to project without one", () => {
		// The projection is entirely about one station's state. Guessing a station
		// would render another one's occupancy under this one's name.
		const result = projectYardSnapshot(context(), {});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("station-missing");
	});

	it("names the command that would create one", () => {
		// The remediation is what turns a dead end into a next step for somebody
		// who has not set the product up yet.
		const result = projectYardSnapshot(context(), {});
		expect(result.remediation).toEqual(["hobo station init"]);
	});

	it("refuses when the named station has no state", () => {
		// A station id that resolves to nothing is a stale profile or a deleted
		// station; both need the id echoed so the user can see which one.
		const result = projectYardSnapshot(context(), {
			stationId: "station:ghost",
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("station:ghost");
	});
});

describe("what the projection reports", () => {
	it("carries the station's own sequence number", () => {
		// The seq is how the UI knows whether it is looking at fresh state.
		// Recomputing it here would let the projection drift from the store.
		const result = projectYardSnapshot(context({ state: state() }), {
			stationId: "station:local",
		});
		expect(result.data?.seq).toBe(7);
	});

	it("names the station and its sequence in the message", () => {
		const result = projectYardSnapshot(context({ state: state() }), {
			stationId: "station:local",
		});
		expect(result.message).toBe("yard snapshot station:local seq=7");
	});

	it("reports empty rather than invented state for a bare station", () => {
		// The module's own contract: never invent occupancy, rail, or connection
		// state. A "sensible default" quota here would show an operator a limit
		// nobody configured.
		const result = projectYardSnapshot(context({ state: state() }), {
			stationId: "station:local",
		});
		expect(result.data?.rails).toEqual([]);
		expect(result.data?.connections).toEqual([]);
		expect(result.data?.metering.quotaLimit).toBe(0);
		expect(result.data?.metering.budgetUsd).toBe(0);
	});

	it("passes the occupy mode straight through", () => {
		const result = projectYardSnapshot(
			context({ state: state(), occupyMode: "occupying" }),
			{ stationId: "station:local" },
		);
		expect(result.data?.occupyMode).toBe("occupying");
	});

	it("keeps only connections belonging to this station", () => {
		// The connection store is per tenant, not per station. Without the filter,
		// one station's yard would render another's connectors.
		const result = projectYardSnapshot(
			context({
				state: state(),
				connections: [
					connection({ id: "mine" }),
					connection({ id: "theirs", stationId: "station:other" }),
				],
			}),
			{ stationId: "station:local" },
		);
		expect(result.data?.connections.map((c) => c.id)).toEqual(["mine"]);
	});
});

describe("choosing a tenant", () => {
	it("prefers an explicitly requested tenant", () => {
		let asked = "";
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const ctx = {
			...context({ state: state() }),
			loadConnectionService: (tenant: string) => {
				asked = tenant;
				return { list: () => [] };
			},
		} as unknown as ManagementContext;
		projectYardSnapshot(ctx, {
			stationId: "station:local",
			tenant: "explicit",
		});
		expect(asked).toBe("explicit");
	});

	it("falls back to the acting user's tenant", () => {
		// Connections are scoped by tenant, and reading the wrong one would show a
		// user somebody else's credentials.
		let asked = "";
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const ctx = {
			...context({ state: state(), tenant: "acme" }),
			loadConnectionService: (tenant: string) => {
				asked = tenant;
				return { list: () => [] };
			},
		} as unknown as ManagementContext;
		projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(asked).toBe("acme");
	});

	it("falls back to the station's isolation tenant when the actor has none", () => {
		// A machine actor can be tenantless. Defaulting to "local" instead would
		// silently read the wrong store on a multi-tenant station.
		let asked = "";
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const ctx = {
			...context({
				state: state({
					occupancy: occupancy({ isolation: { tenant: "station-tenant" } }),
				}),
			}),
			resolveActor: () => ({ kind: "user", id: "user:local" }),
			loadConnectionService: (tenant: string) => {
				asked = tenant;
				return { list: () => [] };
			},
		} as unknown as ManagementContext;
		projectYardSnapshot(ctx, { stationId: "station:local" });
		expect(asked).toBe("station-tenant");
	});
});

describe("metering", () => {
	function withActiveRail(connections: readonly Connection[] = []) {
		return projectYardSnapshot(
			context({
				state: state({
					occupancy: occupancy({ activeRailHash: "rail-1" }),
					rails: { "rail-1": rail() },
				}),
				connections,
			}),
			{ stationId: "station:local" },
		);
	}

	it("reads the billing policy off the active rail", () => {
		const metering = withActiveRail().data?.metering;
		expect(metering).toMatchObject({
			quotaUsed: 10,
			quotaLimit: 100,
			spendCapUsd: 50,
			budgetUsd: 25,
		});
	});

	it("zeroes the figures when no rail is active", () => {
		// There is no billing policy to read, and inventing one would show a spend
		// cap that nothing is actually enforcing.
		const metering = projectYardSnapshot(
			context({ state: state({ rails: { "rail-1": rail() } }) }),
			{ stationId: "station:local" },
		).data?.metering;
		expect(metering?.quotaLimit).toBe(0);
	});

	it("reports no traffic when nothing is authorized", () => {
		expect(withActiveRail().data?.metering.trafficRate).toBe(0);
	});

	it("counts only active connections as traffic", () => {
		// A pending or revoked connection is not carrying anything. Counting it
		// would animate the yard for a connector that has never worked.
		const rate = withActiveRail([
			connection({ id: "a", status: "pending" }),
			connection({ id: "b", status: "revoked" }),
		]).data?.metering.trafficRate;
		expect(rate).toBe(0);
	});

	it("rises with the number of active connections", () => {
		const one = withActiveRail([connection({ id: "a" })]).data?.metering
			.trafficRate;
		const two = withActiveRail([
			connection({ id: "a" }),
			connection({ id: "b" }),
		]).data?.metering.trafficRate;
		expect(one).toBeGreaterThan(0);
		expect(two).toBeGreaterThan(one ?? 0);
	});

	it("never exceeds one however many connections there are", () => {
		// The rate drives a particle density. Above 1 it would either clamp
		// somewhere downstream or render as a solid block.
		const many = Array.from({ length: 50 }, (_, i) =>
			connection({ id: `c-${i}` }),
		);
		expect(withActiveRail(many).data?.metering.trafficRate).toBe(1);
	});

	it("badges the rate as synthetic", () => {
		// This is the "kill or badge" rule. Without the badge the number reads as
		// measured traffic, and somebody will eventually make a capacity decision
		// on a figure derived from counting connections.
		expect(withActiveRail().data?.metering.trafficRateSource).toBe("synthetic");
	});
});

describe("connector activity", () => {
	function activityFor(overrides: Partial<Connection>) {
		return projectYardSnapshot(
			context({ state: state(), connections: [connection(overrides)] }),
			{ stationId: "station:local" },
		).data?.activity[0];
	}

	for (const [provider, kind] of [
		["claude", "swe-claude"],
		["grok", "swe-grok"],
		["codex", "swe-codex"],
		["cursor", "swe-cursor"],
		["gemini", "swe-gemini"],
		["copilot", "swe-copilot"],
	] as const) {
		it(`maps ${provider} onto ${kind}`, () => {
			expect(activityFor({ provider })?.connectorKind).toBe(kind);
		});
	}

	it("matches a provider name that merely contains the vendor", () => {
		// Providers arrive as things like "anthropic-claude-oauth". An exact match
		// would leave every real-world provider name unmapped.
		expect(
			activityFor({ provider: "anthropic-claude-oauth" })?.connectorKind,
		).toBe("swe-claude");
	});

	it("is case-insensitive about the provider", () => {
		expect(activityFor({ provider: "Claude" })?.connectorKind).toBe(
			"swe-claude",
		);
	});

	it("passes an unknown provider through rather than dropping it", () => {
		// An unmapped connector must still appear. Dropping it would make a
		// connection the user configured invisible in the yard.
		expect(activityFor({ provider: "something-new" })?.connectorKind).toBe(
			"something-new",
		);
	});

	for (const [status, activity] of [
		["active", "working"],
		["pending", "idle"],
		["needs-reauth", "idle"],
		["revoked", "error"],
		["expired", "error"],
	] as const) {
		it(`shows a ${status} connection as ${activity}`, () => {
			expect(activityFor({ status })?.status).toBe(activity);
		});
	}

	it("shows an unrecognised status as offline", () => {
		// Offline is the honest default for a state this build does not
		// understand — "working" would be a claim, and "error" would be an alarm.
		expect(activityFor({ status: "brand-new-state" })?.status).toBe("offline");
	});

	it("badges the status as statically derived", () => {
		// The counterpart to the traffic badge: this comes from the connection
		// lifecycle, not from asking the agent whether it is doing anything.
		expect(activityFor({})?.statusSource).toBe("derived-static");
	});

	it("carries the connection id so the UI can link back", () => {
		expect(activityFor({ id: "conn-42" })?.connectionId).toBe("conn-42");
	});
});

describe("hazards", () => {
	function hazardsFor(
		// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
		stateOverrides: Record<string, unknown>,
		connections: readonly Connection[] = [],
	) {
		return projectYardSnapshot(
			context({ state: state(stateOverrides), connections }),
			{ stationId: "station:local" },
		).data?.doctor;
	}

	it("reports none for a healthy station", () => {
		expect(hazardsFor({})?.hazards).toEqual([]);
	});

	it("flags an active bootstrap rail", () => {
		// A bootstrap rail is a temporary posture with weaker guarantees. Left
		// unflagged, a station quietly runs production traffic on it.
		expect(
			hazardsFor({ occupancy: occupancy({ bootstrapActive: true }) })?.hazards,
		).toContain("bootstrap-rail-active");
	});

	it("explains the bootstrap hazard rather than just naming it", () => {
		// The hint is what tells an operator what to do about it; the hazard code
		// alone is only actionable to someone who already knows.
		expect(
			hazardsFor({ occupancy: occupancy({ bootstrapActive: true }) })?.hint,
		).toContain("activate a non-bootstrap Rail");
	});

	it("adds no hint when there is nothing to explain", () => {
		// An always-present hint would train operators to ignore it.
		expect(hazardsFor({})?.hint).toBeUndefined();
	});

	it("flags a closed station", () => {
		expect(
			hazardsFor({ occupancy: occupancy({ status: "closed" }) })?.hazards,
		).toContain("station-closed");
	});

	it("names each revoked connection individually", () => {
		// A count would tell an operator something is wrong; the id tells them
		// which credential to go and re-authorize.
		const hazards = hazardsFor({}, [
			connection({ id: "dead-1", status: "revoked" }),
			connection({ id: "dead-2", status: "revoked" }),
		])?.hazards;
		expect(hazards).toEqual([
			"connection-revoked:dead-1",
			"connection-revoked:dead-2",
		]);
	});

	it("does not flag an expired connection as revoked", () => {
		// Expired renews itself; revoked needs a human. Conflating them sends the
		// operator to do work that was not required.
		expect(
			hazardsFor({}, [connection({ status: "expired" })])?.hazards,
		).toEqual([]);
	});

	it("reports every hazard at once rather than only the first", () => {
		// An operator fixing them one at a time, each revealed only after the
		// last, is the worst possible version of this screen.
		const hazards = hazardsFor(
			{ occupancy: occupancy({ bootstrapActive: true, status: "closed" }) },
			[connection({ id: "dead", status: "revoked" })],
		)?.hazards;
		expect(hazards).toEqual([
			"bootstrap-rail-active",
			"station-closed",
			"connection-revoked:dead",
		]);
	});
});

describe("the doctor summary", () => {
	it("reduces the projection to what a health check needs", () => {
		const result = doctorSnapshot(context({ state: state() }), {
			stationId: "station:local",
		});
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ stationId: "station:local", seq: 7 });
	});

	it("passes the projection's failure through unchanged", () => {
		// Re-wrapping it would lose the remediation the projection attached.
		const result = doctorSnapshot(context(), {});
		expect(result.ok).toBe(false);
		expect(result.remediation).toEqual(["hobo station init"]);
	});
});

describe("broker status", () => {
	it("reports not-ok rather than failing when there is no station", () => {
		// Status is polled. A hard failure here would make a monitor treat an
		// unconfigured machine as a broken one.
		const result = brokerStatus(context(), {});
		expect(result.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		expect((result.data as { ok: boolean }).ok).toBe(false);
	});

	it("suggests the init command when no station is configured", () => {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const data = brokerStatus(context(), {}).data as { message: string };
		expect(data.message).toContain("hobo station init");
	});

	it("echoes the station id when the station is missing", () => {
		// Distinguishing "no station configured" from "the configured station is
		// gone" is the difference between setting one up and repairing one.
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const data = brokerStatus(context(), { stationId: "station:ghost" })
			.data as { stationId: string };
		expect(data.stationId).toBe("station:ghost");
	});

	it("summarises a healthy station", () => {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const data = brokerStatus(
			context({
				state: state({
					occupancy: occupancy({
						activeRailHash: "rail-1",
						connectionCount: 3,
					}),
				}),
			}),
			{ stationId: "station:local" },
			// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
		).data as Record<string, unknown>;
		expect(data).toMatchObject({
			ok: true,
			stationId: "station:local",
			activeRailHash: "rail-1",
			connectionCount: 3,
			status: "open",
			message: "ok",
		});
	});
});
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- SAFETY: tests use controlled projection fixtures and narrow known result shapes. */
