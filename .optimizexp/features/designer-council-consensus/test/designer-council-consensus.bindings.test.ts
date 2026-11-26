import { describe, expect, test } from "vitest";
import {
	advanceSpeakingTurns,
	approveOneHead,
	assertConsensus,
	changeHead,
	decideCouncil,
	fiveYays,
	noHardBlocker,
	oneBlockerNay,
	seedRelevantJony,
	sixYays,
	votesMatchCurrentSubject,
} from "../steps/implementations.ts";
import { createWorld } from "../steps/world.ts";

describe("designer council consensus acceptance bindings", () => {
	test("relevant preference investment decays exactly to zero", () => {
		const world = createWorld();
		seedRelevantJony(world);
		advanceSpeakingTurns(world);
		expect(world.mayReply).toBe(true);
		expect(world.investmentHistory.at(-1)).toBe(0);
		expect(world.preferencesYielded).toBe(true);
	});

	test("one hard-blocker nay appends rework and blocks merge", () => {
		const world = createWorld();
		fiveYays(world);
		oneBlockerNay(world);
		decideCouncil(world);
		expect(world.result).toBe("nay");
		expect(world.busStages).toContain("rework");
		expect(world.mergeEligible).toBe(false);
	});

	test("exact-six current-subject yay allows closeout", () => {
		const world = createWorld();
		sixYays(world);
		noHardBlocker(world);
		votesMatchCurrentSubject(world);
		assertConsensus(world);
		expect(world.assertExitCode).toBe(0);
		expect(world.closeoutAllowed).toBe(true);
	});

	test("changing head after approval requires reconvening", () => {
		const world = createWorld();
		approveOneHead(world);
		changeHead(world);
		expect(world.assertExitCode).not.toBe(0);
		expect(world.reconvene).toBe(true);
	});
});
