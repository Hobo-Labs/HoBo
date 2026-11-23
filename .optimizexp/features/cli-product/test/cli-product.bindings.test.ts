import { describe, expect, it } from "vitest";
import {
	assertExitCode,
	assertJsonFieldEquals,
	runHoboCli,
} from "../steps/implementations.ts";
import { createWorld } from "../steps/world.ts";

describe("product CLI", () => {
	it("lists canonical commands in help", () => {
		const world = createWorld("cli-product");
		runHoboCli(world, "--help");
		assertExitCode(world, 0);
		expect(world.lastStdout).toContain("Canonical verbs:");
		expect(world.lastStdout).toContain("doctor");
	});

	it("returns a nonzero status and a structured error for an unwired command", () => {
		const world = createWorld("cli-product");
		runHoboCli(world, "deploy --json");
		assertExitCode(world, 1);
		assertJsonFieldEquals(world, "status", "not_implemented");
		assertJsonFieldEquals(world, "code", "HOBO_CLI_STUB");
	});
});
