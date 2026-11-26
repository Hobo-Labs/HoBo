import { describe, expect, it } from "vitest";
import {
	assertExitCode,
	assertJsonEnvelopeShape,
	assertJsonFieldEquals,
	assertStdoutContains,
	runHoboCli,
	runHoboComposedCli,
} from "../steps/implementations.ts";
import { createWorld } from "../steps/world.ts";

describe("CLI help and doctor", () => {
	it("shows the doctor command in product help", () => {
		const world = createWorld("cli-help-and-doctor");
		runHoboCli(world, "--help");
		assertExitCode(world, 0);
		assertStdoutContains(world, "Canonical verbs:");
		assertStdoutContains(world, "doctor");
	});

	it("runs the composed doctor and returns an offline JSON report", () => {
		const world = createWorld("cli-help-and-doctor");
		runHoboComposedCli(world, "doctor --offline --json");
		assertExitCode(world, 0);
		assertJsonEnvelopeShape(world);
		assertJsonFieldEquals(world, "verb", "doctor");
		expect(world.lastJson).toMatchObject({ ok: true, data: { command: "doctor" } });
	});
});
