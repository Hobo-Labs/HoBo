/**
 * Deriving the yard's visual state from a projection snapshot.
 *
 * This is where the projection becomes pixels: which zone Bo stands in, what
 * each rail and connection looks like, how full the cost meter is. The module
 * header states the rule it exists to keep — the UI never invents occupancy,
 * rail, or connection state — and these tests hold it to that.
 *
 * Two shapes here need tests rather than a careful read:
 *
 * - **`pickBoZone` and `pickBoState` are priority ladders.** Both are chains of
 *   early returns, so every case is defined by what it *outranks*. Reordering
 *   two rungs is invisible in review and changes what the yard shows at exactly
 *   the moments that matter — an operator watching for trouble sees Bo resting
 *   at the platform instead of standing in the error bunker. Each rung is
 *   therefore tested against the one below it, not in isolation.
 * - **The meters divide.** `fill` divides by a quota limit that is routinely
 *   zero on an unconfigured station, and `heat` divides by a spend cap that is
 *   zero just as often. A NaN reaching a rendering multiplier does not throw;
 *   it silently produces an invisible or mispositioned sprite.
 *
 * `stepToward` gets its own attention because a walk that overshoots its anchor
 * never arrives: it oscillates around the target forever, which reads as an
 * animation glitch rather than a maths error.
 */
import { describe, expect, it } from "vitest";

import { deriveYardVisualState, stepToward } from "../src/entity-state.js";

function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		occupancy: {
			stationId: "station:local",
			seq: 3,
			bootstrapActive: false,
			activeRailHash: undefined,
		},
		rails: [],
		connections: [],
		activity: [],
		metering: {
			quotaUsed: 0,
			quotaLimit: 0,
			spendCapUsd: 0,
			budgetUsd: 0,
			trafficRate: 0,
		},
		doctor: { hazards: [], bootstrapActive: false },
		seq: 3,
		occupyMode: "idle",
		...overrides,
	} as never;
}

function derive(
	overrides: Record<string, unknown> = {},
	selectedZone?: string,
) {
	return deriveYardVisualState(
		snapshot(overrides),
		selectedZone ? ({ selectedZone } as never) : undefined,
	);
}

describe("where Bo stands", () => {
	it("rests on the platform when nothing is happening", () => {
		expect(derive().bo.zone).toBe("platformRest");
	});

	it("obeys an explicitly selected zone", () => {
		// The user clicking a zone must win over every derivation, or the UI
		// argues with them about what they are looking at.
		expect(
			derive({ occupancy: { bootstrapActive: true } }, "costBooth").bo.zone,
		).toBe("costBooth");
	});

	it("goes to the error bunker when hazards pile up", () => {
		// Three is the threshold: one or two hazards are ordinary operational
		// noise, a pile is a situation.
		expect(derive({ doctor: { hazards: ["a", "b", "c"] } }).bo.zone).toBe(
			"errorBunker",
		);
	});

	it("does not go to the bunker for two hazards", () => {
		expect(derive({ doctor: { hazards: ["a", "b"] } }).bo.zone).not.toBe(
			"errorBunker",
		);
	});

	it("puts a hazard pile above a bootstrap desk", () => {
		// Both are true at once on a station in trouble. Showing the desk instead
		// would tell an operator about a posture problem while hiding the outage.
		const state = derive({
			doctor: { hazards: ["a", "b", "c"] },
			occupancy: { bootstrapActive: true },
		});
		expect(state.bo.zone).toBe("errorBunker");
	});

	it("goes to the bootstrap desk when a bootstrap rail is active", () => {
		expect(derive({ occupancy: { bootstrapActive: true } }).bo.zone).toBe(
			"bootstrapDesk",
		);
	});

	it("puts the bootstrap desk above an occupying rail", () => {
		// Bootstrap is a posture warning; occupying is routine. The warning wins.
		const state = derive({
			occupancy: { bootstrapActive: true, activeRailHash: "rail-1" },
			occupyMode: "occupying",
		});
		expect(state.bo.zone).toBe("bootstrapDesk");
	});

	it("walks the active rail track while occupying", () => {
		expect(
			derive({
				occupancy: { activeRailHash: "rail-1" },
				occupyMode: "occupying",
			}).bo.zone,
		).toBe("activeRailTrack");
	});

	it("does not walk the track while occupying with no active rail", () => {
		// Occupying without a rail is a transitional state. Standing on a track
		// that has no rail on it would show traffic flowing over nothing.
		expect(derive({ occupyMode: "occupying" }).bo.zone).not.toBe(
			"activeRailTrack",
		);
	});

	it("goes to the connection bay for a pending connection", () => {
		expect(
			derive({ connections: [{ id: "c", status: "pending" }] }).bo.zone,
		).toBe("connectionBay");
	});

	it("puts an occupying rail above a pending connection", () => {
		const state = derive({
			occupancy: { activeRailHash: "rail-1" },
			occupyMode: "occupying",
			connections: [{ id: "c", status: "pending" }],
		});
		expect(state.bo.zone).toBe("activeRailTrack");
	});

	it("ignores connections that are not pending", () => {
		expect(
			derive({ connections: [{ id: "c", status: "active" }] }).bo.zone,
		).toBe("platformRest");
	});
});

describe("what Bo is doing", () => {
	it("idles by default", () => {
		expect(derive().bo.state).toBe("idle");
	});

	it("shows error for a revoked connection above everything else", () => {
		// A revoked credential needs a human. It outranks even the walk animation,
		// because an operator scanning the yard should see the problem, not the
		// routine motion happening beside it.
		const state = derive({
			doctor: { hazards: ["connection-revoked:c1"] },
			occupancy: { activeRailHash: "rail-1" },
			occupyMode: "occupying",
		});
		expect(state.bo.state).toBe("error");
	});

	it("does not show error for an unrelated hazard", () => {
		// Only revoked connections raise the error posture; a closed station is
		// shown by the bunker, not by Bo's animation.
		expect(
			derive({ doctor: { hazards: ["station-closed"] } }).bo.state,
		).not.toBe("error");
	});

	it("walks when occupying on the rail track", () => {
		expect(
			derive({
				occupancy: { activeRailHash: "rail-1" },
				occupyMode: "occupying",
			}).bo.state,
		).toBe("walking");
	});

	it("shows occupying when occupying somewhere other than the track", () => {
		// The state still has to read as busy even when Bo is standing at the
		// bootstrap desk rather than walking the rail.
		expect(
			derive({
				occupancy: { bootstrapActive: true },
				occupyMode: "occupying",
			}).bo.state,
		).toBe("occupying");
	});

	it("resolves in the connection bay", () => {
		expect(
			derive({ connections: [{ id: "c", status: "pending" }] }).bo.state,
		).toBe("resolving");
	});
});

describe("which way Bo faces and what plays", () => {
	it("faces east toward the bay and the booth", () => {
		expect(derive({}, "connectionBay").bo.facing).toBe("east");
		expect(derive({}, "costBooth").bo.facing).toBe("east");
	});

	it("faces west everywhere else", () => {
		expect(derive({}, "errorBunker").bo.facing).toBe("west");
	});

	it("plays a directional walk clip while walking", () => {
		// Playing an east clip while moving west is the classic moonwalk bug.
		const state = derive({
			occupancy: { activeRailHash: "rail-1" },
			occupyMode: "occupying",
		});
		expect(state.bo.state).toBe("walking");
		expect(state.bo.animationId).toBe("bo.walk.west");
	});

	it("plays idle art for every non-walking state", () => {
		// The site sheets only carry idle and walk. Naming a clip that does not
		// exist would leave the sprite blank rather than falling back.
		expect(
			derive({ doctor: { hazards: ["connection-revoked:c"] } }).bo.animationId,
		).toBe("bo.idle");
	});

	it("names a stable animation id rather than a clip filename", () => {
		// The whole point of the id: renaming an asset must not have to touch the
		// state machine.
		expect(derive().bo.animationId).toBe("bo.idle");
	});
});

describe("rails and connections", () => {
	it("takes the rail's own activation status as its visual", () => {
		// The UI must not decide a rail looks active; the projection says so.
		const state = derive({
			rails: [{ id: "r1", contentHash: "h1", activationStatus: "active" }],
		});
		expect(state.rails[0]).toMatchObject({
			id: "r1",
			contentHash: "h1",
			visual: "active",
		});
	});

	for (const [status, visual] of [
		["pending", "pending"],
		["needs-reauth", "pending"],
		["active", "authorized"],
		["revoked", "revoked"],
		["expired", "revoked"],
	] as const) {
		it(`draws a ${status} connection as ${visual}`, () => {
			const state = derive({
				connections: [{ id: "c", provider: "claude", status }],
			});
			expect(state.connections[0]?.visual).toBe(visual);
		});
	}

	it("draws an unrecognised status as closed", () => {
		// Closed is the honest default for a state this build does not know.
		// Authorized would be a claim about access that may not exist.
		const state = derive({
			connections: [{ id: "c", provider: "x", status: "brand-new" }],
		});
		expect(state.connections[0]?.visual).toBe("closed");
	});

	it("keeps an alias when there is one and omits it when there is not", () => {
		// An `alias: undefined` key renders as an empty label rather than falling
		// back to the id.
		const withAlias = derive({
			connections: [
				{ id: "c", provider: "x", status: "active", alias: "work" },
			],
		});
		const without = derive({
			connections: [{ id: "c", provider: "x", status: "active" }],
		});
		expect(withAlias.connections[0]?.alias).toBe("work");
		expect(without.connections[0]).not.toHaveProperty("alias");
	});
});

describe("guests", () => {
	for (const [status, anim] of [
		["idle", "guest.swe-claude.idle"],
		["working", "guest.swe-claude.work"],
		["error", "guest.swe-claude.error"],
		["offline", "guest.swe-claude.idle"],
	] as const) {
		it(`plays ${anim} for a ${status} guest`, () => {
			const state = derive({
				activity: [{ connectorKind: "swe-claude", status }],
			});
			expect(state.guests[0]?.animationId).toBe(anim);
		});
	}

	it("falls back to idle art for a status with no clip", () => {
		// A missing clip name leaves a blank sprite; idle art at least shows a
		// guest is there.
		const state = derive({
			activity: [{ connectorKind: "swe-claude", status: "unheard-of" }],
		});
		expect(state.guests[0]?.animationId).toBe("guest.swe-claude.idle");
	});

	it("carries the connection id so a guest can be traced back", () => {
		const state = derive({
			activity: [
				{ connectorKind: "swe-claude", status: "idle", connectionId: "c-9" },
			],
		});
		expect(state.guests[0]?.connectionId).toBe("c-9");
	});
});

describe("the cost meter", () => {
	it("fills proportionally to the quota", () => {
		const state = derive({
			metering: {
				quotaUsed: 25,
				quotaLimit: 100,
				spendCapUsd: 0,
				budgetUsd: 0,
				trafficRate: 0,
			},
		});
		expect(state.costMeter.fill).toBe(0.25);
	});

	it("reads zero rather than NaN when no quota is configured", () => {
		// Division by an unset limit is the ordinary state of a fresh station. A
		// NaN reaching a rendering multiplier does not throw — the sprite just
		// vanishes or lands somewhere impossible.
		expect(derive().costMeter.fill).toBe(0);
	});

	it("clamps a quota overrun to full", () => {
		// Over quota is a real state. Above 1 the bar would draw past its frame.
		const state = derive({
			metering: {
				quotaUsed: 500,
				quotaLimit: 100,
				spendCapUsd: 0,
				budgetUsd: 0,
				trafficRate: 0,
			},
		});
		expect(state.costMeter.fill).toBe(1);
	});

	it("heats proportionally to the spend cap", () => {
		const state = derive({
			metering: {
				quotaUsed: 0,
				quotaLimit: 100,
				spendCapUsd: 200,
				budgetUsd: 50,
				trafficRate: 0,
			},
		});
		expect(state.costMeter.heat).toBe(0.25);
	});

	it("falls back to the quota fill when no spend cap is set", () => {
		// Without a cap there is nothing to be a fraction of, and a cold meter
		// beside a full quota bar would read as "spend is fine" on a station
		// that is out of quota.
		const state = derive({
			metering: {
				quotaUsed: 80,
				quotaLimit: 100,
				spendCapUsd: 0,
				budgetUsd: 999,
				trafficRate: 0,
			},
		});
		expect(state.costMeter.heat).toBe(0.8);
	});

	it("clamps heat over the cap to full", () => {
		const state = derive({
			metering: {
				quotaUsed: 0,
				quotaLimit: 1,
				spendCapUsd: 10,
				budgetUsd: 999,
				trafficRate: 0,
			},
		});
		expect(state.costMeter.heat).toBe(1);
	});

	it("reports the raw figures alongside the normalised ones", () => {
		// The bar shows proportion; the operator needs the actual numbers to know
		// whether 80% is eight dollars or eight thousand.
		const state = derive({
			metering: {
				quotaUsed: 8,
				quotaLimit: 10,
				spendCapUsd: 5,
				budgetUsd: 1,
				trafficRate: 0,
			},
		});
		expect(state.costMeter).toMatchObject({
			quotaUsed: 8,
			quotaLimit: 10,
			spendCapUsd: 5,
		});
	});
});

describe("traffic", () => {
	function traffic(overrides: Record<string, unknown>) {
		return derive(overrides).traffic;
	}

	it("is inactive with no rate", () => {
		expect(traffic({}).active).toBe(false);
	});

	it("needs a rate, an active rail, and an occupying station all at once", () => {
		// Any one alone would animate flow through a yard that is not carrying
		// any — the visual equivalent of a fake progress bar.
		const base = {
			metering: {
				quotaUsed: 0,
				quotaLimit: 1,
				spendCapUsd: 0,
				budgetUsd: 0,
				trafficRate: 0.5,
			},
			occupancy: { activeRailHash: "rail-1" },
			occupyMode: "occupying",
		};
		expect(traffic(base).active).toBe(true);
		expect(traffic({ ...base, occupyMode: "idle" }).active).toBe(false);
		expect(traffic({ ...base, occupancy: {} }).active).toBe(false);
		expect(
			traffic({
				...base,
				metering: {
					quotaUsed: 0,
					quotaLimit: 1,
					spendCapUsd: 0,
					budgetUsd: 0,
					trafficRate: 0,
				},
			}).active,
		).toBe(false);
	});

	it("reports the rate even while inactive", () => {
		// The number is still the truth; `active` only decides whether it is
		// animated.
		expect(
			traffic({
				metering: {
					quotaUsed: 0,
					quotaLimit: 1,
					spendCapUsd: 0,
					budgetUsd: 0,
					trafficRate: 0.4,
				},
			}).rate,
		).toBe(0.4);
	});
});

describe("the bunker and the desk", () => {
	it("opens the bunker for any hazard at all", () => {
		// The bunker is the indicator; the three-hazard threshold only decides
		// whether Bo walks over to it.
		expect(derive({ doctor: { hazards: ["one"] } }).errorBunker.active).toBe(
			true,
		);
	});

	it("keeps the bunker shut when there are none", () => {
		expect(derive().errorBunker.active).toBe(false);
	});

	it("passes the hazards through for display", () => {
		expect(
			derive({ doctor: { hazards: ["a", "b"] } }).errorBunker.hazards,
		).toEqual(["a", "b"]);
	});

	it("lights the desk exactly when bootstrap is active", () => {
		expect(
			derive({ occupancy: { bootstrapActive: true } }).bootstrapDesk.active,
		).toBe(true);
		expect(derive().bootstrapDesk.active).toBe(false);
	});

	it("carries the projection's seq and occupy mode through unchanged", () => {
		// The seq is how the renderer knows the frame is current. Recomputing it
		// would let the visual state claim freshness it does not have.
		const state = derive({ seq: 42, occupyMode: "occupying" });
		expect(state.seq).toBe(42);
		expect(state.occupyMode).toBe("occupying");
	});
});

describe("walking toward an anchor", () => {
	it("moves part of the way in one step", () => {
		const step = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 1);
		expect(step).toEqual({ x: 50, y: 0, arrived: false });
	});

	it("snaps to the target rather than overshooting it", () => {
		// An overshoot never arrives: the next step corrects back past the anchor
		// and it oscillates forever. On screen that reads as a stuttering sprite
		// rather than a maths error, so nobody looks for it here.
		const step = stepToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 1000, 1);
		expect(step).toEqual({ x: 10, y: 0, arrived: true });
	});

	it("arrives when it is already there", () => {
		// Zero distance would divide by zero and produce NaN coordinates, which
		// removes the sprite from the scene entirely.
		expect(stepToward({ x: 5, y: 5 }, { x: 5, y: 5 }, 100, 1)).toEqual({
			x: 5,
			y: 5,
			arrived: true,
		});
	});

	it("moves diagonally along the straight line to the target", () => {
		// Stepping the axes independently would trace an L rather than a walk.
		const step = stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 5, 0.5);
		expect(step.x).toBeCloseTo(1.5);
		expect(step.y).toBeCloseTo(2);
	});

	it("scales with the frame time rather than the frame count", () => {
		// Frame-rate independence: two half-steps must land where one full step
		// does, or the yard walks at different speeds on different machines.
		const once = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 1);
		const half = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 0.5);
		const twice = stepToward(half, { x: 100, y: 0 }, 50, 0.5);
		expect(twice.x).toBeCloseTo(once.x);
	});

	it("does not move on a zero-length frame", () => {
		const step = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 0);
		expect(step).toEqual({ x: 0, y: 0, arrived: false });
	});
});
