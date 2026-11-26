import { describe, expect, it } from "vitest";
import {
	ACTIVITY_LIMIT,
	ActivityLog,
	type AgentEvent,
	applyEvent,
	emptyWorld,
	type WorldState,
} from "../src/model.js";

function stateWithCharacter(): WorldState {
	const state = emptyWorld();
	state.stations.s1 = { id: "s1", name: "s1" };
	state.yards.y1 = { id: "y1", stationId: "s1", name: "y1" };
	state.camps.c1 = {
		id: "c1",
		yardId: "y1",
		name: "c1",
		rect: { x: 0, y: 0, w: 8, h: 6 },
	};
	state.characters["s1/svc"] = {
		id: "s1/svc",
		name: "svc",
		kind: "bindle",
		stationId: "s1",
		campId: "c1",
		desk: { x: 1, y: 1 },
		position: { x: 1, y: 1 },
		state: "idle",
		stateSince: 0,
		health: 1,
		bubble: undefined,
		bubbleSince: 0,
		path: [],
		activeSpans: {},
	};
	return state;
}

function spanStarted(
	overrides: Partial<Extract<AgentEvent, { type: "span-started" }>> = {},
): AgentEvent {
	return {
		type: "span-started",
		at: 100,
		traceId: "t1",
		spanId: "sp1",
		name: "op",
		spanKind: "server",
		attributes: {},
		stationId: "s1",
		yardId: "y1",
		campId: "c1",
		characterId: "s1/svc",
		junctionId: undefined,
		...overrides,
	};
}

describe("world reducer", () => {
	it("server span start flips idle → working", () => {
		const next = applyEvent(stateWithCharacter(), spanStarted());
		expect(next.characters["s1/svc"]?.state).toBe("working");
	});

	it("db span start flips idle → reading", () => {
		const next = applyEvent(
			stateWithCharacter(),
			spanStarted({
				spanKind: "client",
				attributes: { "db.system": "postgresql" },
			}),
		);
		expect(next.characters["s1/svc"]?.state).toBe("reading");
	});

	it("error span end → stuck with bubble", () => {
		let state = applyEvent(stateWithCharacter(), spanStarted());
		state = applyEvent(state, {
			type: "span-ended",
			at: 200,
			spanId: "sp1",
			characterId: "s1/svc",
			status: "error",
			durationMs: 100,
		});
		const ch = state.characters["s1/svc"];
		expect(ch?.state).toBe("stuck");
		expect(ch?.bubble).toContain("error");
	});

	it("long-blocking span end → stuck", () => {
		let state = applyEvent(stateWithCharacter(), spanStarted());
		state = applyEvent(state, {
			type: "span-ended",
			at: 9000,
			spanId: "sp1",
			characterId: "s1/svc",
			status: "ok",
			durationMs: 8900,
		});
		expect(state.characters["s1/svc"]?.state).toBe("stuck");
	});

	it("clean span end → idle and back at desk", () => {
		let state = applyEvent(stateWithCharacter(), spanStarted());
		state = applyEvent(state, {
			type: "span-ended",
			at: 300,
			spanId: "sp1",
			characterId: "s1/svc",
			status: "ok",
			durationMs: 200,
		});
		expect(state.characters["s1/svc"]?.state).toBe("idle");
	});

	it("overlapping spans keep working until the last one ends", () => {
		let state = applyEvent(stateWithCharacter(), spanStarted());
		state = applyEvent(state, spanStarted({ spanId: "sp2" }));
		state = applyEvent(state, {
			type: "span-ended",
			at: 300,
			spanId: "sp1",
			characterId: "s1/svc",
			status: "ok",
			durationMs: 100,
		});
		expect(state.characters["s1/svc"]?.state).toBe("working");
	});

	it("metric sample clamps health into 0..1", () => {
		const state = applyEvent(stateWithCharacter(), {
			type: "metric-sample",
			at: 100,
			characterId: "s1/svc",
			metric: "health",
			value: 1.7,
		});
		expect(state.characters["s1/svc"]?.health).toBe(1);
	});

	it("WARN log sets a bubble; tick clears it after TTL", () => {
		let state = applyEvent(stateWithCharacter(), {
			type: "log-record",
			at: 100,
			characterId: "s1/svc",
			severity: "WARN",
			message: "queue lag",
		});
		expect(state.characters["s1/svc"]?.bubble).toBe("queue lag");
		state = applyEvent(state, { type: "tick", at: 100_000 });
		expect(state.characters["s1/svc"]?.bubble).toBeUndefined();
	});

	it("tick walks one corridor tile", () => {
		const base = stateWithCharacter();
		const ch = base.characters["s1/svc"];
		if (ch === undefined) throw new Error("missing character");
		ch.path = [
			{ x: 2, y: 1 },
			{ x: 3, y: 1 },
		];
		const state = applyEvent(base, { type: "tick", at: 100 });
		expect(state.characters["s1/svc"]?.position).toEqual({ x: 2, y: 1 });
	});
});

function stateWithJunction(): WorldState {
	const state = stateWithCharacter();
	state.camps.c2 = {
		id: "c2",
		yardId: "y1",
		name: "c2",
		rect: { x: 10, y: 0, w: 8, h: 6 },
	};
	state.junctions.j1 = {
		id: "j1",
		name: "c1↔c2",
		fromCampId: "c1",
		toCampId: "c2",
		corridor: [
			{ x: 8, y: 3 },
			{ x: 9, y: 3 },
			{ x: 10, y: 3 },
		],
	};
	return state;
}

describe("junction packets", () => {
	it("packet-started walks the corridor one tile per tick", () => {
		let state = applyEvent(stateWithJunction(), {
			type: "packet-started",
			at: 100,
			traceId: "t1",
			spanId: "sp-p",
			junctionId: "j1",
			fromCampId: "c1",
			toCampId: "c2",
			durationMs: 10_000,
		});
		expect(state.packets["sp-p"]?.position).toEqual({ x: 8, y: 3 });
		state = applyEvent(state, { type: "tick", at: 600 });
		expect(state.packets["sp-p"]?.position).toEqual({ x: 9, y: 3 });
	});

	it("packet from the reverse direction walks the corridor backwards", () => {
		const state = applyEvent(stateWithJunction(), {
			type: "packet-started",
			at: 100,
			traceId: "t1",
			spanId: "sp-p",
			junctionId: "j1",
			fromCampId: "c2",
			toCampId: "c1",
			durationMs: 10_000,
		});
		expect(state.packets["sp-p"]?.position).toEqual({ x: 10, y: 3 });
	});

	it("packet disappears when the path is exhausted", () => {
		let state = applyEvent(stateWithJunction(), {
			type: "packet-started",
			at: 100,
			traceId: "t1",
			spanId: "sp-p",
			junctionId: "j1",
			fromCampId: "c1",
			toCampId: "c2",
			durationMs: 10_000,
		});
		state = applyEvent(state, { type: "tick", at: 200 });
		state = applyEvent(state, { type: "tick", at: 300 });
		expect(state.packets["sp-p"]).toBeUndefined();
	});

	it("packet disappears when its span ends", () => {
		let state = applyEvent(stateWithJunction(), {
			type: "packet-started",
			at: 100,
			traceId: "t1",
			spanId: "sp-p",
			junctionId: "j1",
			fromCampId: "c1",
			toCampId: "c2",
			durationMs: 10_000,
		});
		state = applyEvent(state, {
			type: "span-ended",
			at: 400,
			spanId: "sp-p",
			characterId: "s1/svc",
			status: "ok",
			durationMs: 300,
		});
		expect(state.packets["sp-p"]).toBeUndefined();
	});
});

describe("ActivityLog", () => {
	it("records spans and closes them on span-ended", () => {
		const log = new ActivityLog();
		log.record(spanStarted({ traceId: "t9", spanId: "sp9", name: "GET /x" }));
		log.record({
			type: "span-ended",
			at: 300,
			spanId: "sp9",
			characterId: "s1/svc",
			status: "ok",
			durationMs: 200,
		});
		const activity = log.for("s1/svc");
		expect(activity.spans).toHaveLength(1);
		expect(activity.spans[0]).toMatchObject({
			traceId: "t9",
			name: "GET /x",
			status: "ok",
			durationMs: 200,
		});
	});

	it("retains only the last ACTIVITY_LIMIT entries per list", () => {
		const log = new ActivityLog();
		for (let i = 0; i < ACTIVITY_LIMIT + 10; i += 1) {
			log.record(spanStarted({ spanId: `sp-${i}`, traceId: `t-${i}` }));
			log.record({
				type: "log-record",
				at: i,
				characterId: "s1/svc",
				severity: "INFO",
				message: `log ${i}`,
			});
		}
		const activity = log.for("s1/svc");
		expect(activity.spans).toHaveLength(ACTIVITY_LIMIT);
		expect(activity.logs).toHaveLength(ACTIVITY_LIMIT);
		// Newest first; oldest retained entry is the 10th ever recorded.
		expect(activity.spans[0]?.spanId).toBe(`sp-${ACTIVITY_LIMIT + 9}`);
		expect(activity.logs[activity.logs.length - 1]?.message).toBe("log 10");
	});

	it("unknown characters return empty activity", () => {
		expect(new ActivityLog().for("nobody")).toEqual({
			spans: [],
			logs: [],
			metrics: [],
		});
	});
});
