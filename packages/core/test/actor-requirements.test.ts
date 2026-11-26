import { describe, expect, it } from "vitest";

import {
	CELLD_ACTOR_CAPABILITIES,
	evaluateActorResolver,
	NATIVE_ACTOR_CAPABILITIES,
	parseActorRequirements,
	RIVET_ACTOR_CAPABILITIES,
} from "../src/index.js";

const serialBeforeAck = {
	concurrency: "serial",
	commit: "before-ack",
	inbox: "durable-at-least-once-deduplicated",
	placement: { movableWithinFleet: false, regionPinned: false },
	websocketHibernation: "none",
	tenantIsolation: "trusted",
} as const;

describe("actor semantic requirements", () => {
	it("parses and accepts HoBo-journal Rivet for serial before-ack", () => {
		const req = parseActorRequirements(serialBeforeAck);
		expect(evaluateActorResolver(req, RIVET_ACTOR_CAPABILITIES).accepted).toBe(
			true,
		);
		expect(evaluateActorResolver(req, NATIVE_ACTOR_CAPABILITIES).accepted).toBe(
			true,
		);
	});

	it("rejects celld without experimental policy", () => {
		const req = parseActorRequirements({
			...serialBeforeAck,
			placement: { movableWithinFleet: true, regionPinned: false },
		});
		const denied = evaluateActorResolver(req, CELLD_ACTOR_CAPABILITIES);
		expect(denied.accepted).toBe(false);
		expect(denied.rejections).toContain("EXPERIMENTAL_DENIED");
		expect(
			evaluateActorResolver(req, CELLD_ACTOR_CAPABILITIES, {
				allowExperimental: true,
			}).accepted,
		).toBe(true);
	});

	it("rejects hostile isolation and Flux-shaped movable+regionless on Rivet", () => {
		const hostile = parseActorRequirements({
			...serialBeforeAck,
			tenantIsolation: "hostile",
		});
		expect(
			evaluateActorResolver(hostile, RIVET_ACTOR_CAPABILITIES).rejections,
		).toContain("ISOLATION");
		expect(
			evaluateActorResolver(hostile, CELLD_ACTOR_CAPABILITIES, {
				allowExperimental: true,
			}).rejections,
		).toContain("ISOLATION");
		const movable = parseActorRequirements({
			...serialBeforeAck,
			placement: { movableWithinFleet: true, regionPinned: false },
		});
		expect(
			evaluateActorResolver(movable, RIVET_ACTOR_CAPABILITIES).rejections,
		).toContain("PLACEMENT");
	});

	it("rejects product names and missing fields", () => {
		expect(() =>
			parseActorRequirements({
				concurrency: "rivet",
				placement: { movableWithinFleet: false, regionPinned: false },
			}),
		).toThrow(/concurrency/);
		expect(() => parseActorRequirements("flux")).toThrow(/object/);
	});
});
