import { describe, expect, it } from "vitest";

import { parseArgv } from "../src/shell/parse.js";

describe("serve control flags", () => {
	it("parses --demo, --demo-seed, --port and --host for the serve verb", () => {
		const request = parseArgv([
			"serve",
			"control",
			"--demo",
			"--demo-seed",
			"7",
			"--port",
			"9999",
			"--host",
			"0.0.0.0",
		]);
		expect(request.verb).toBe("serve");
		expect(request.args).toEqual(["control"]);
		expect(request.flags.demo).toBe(true);
		expect(request.flags.demoSeed).toBe("7");
		expect(request.flags.port).toBe("9999");
		expect(request.flags.host).toBe("0.0.0.0");
	});

	it("accepts --home so serve can project from an explicit HOBO_HOME", () => {
		const request = parseArgv(["serve", "control", "--home", "/tmp/hobo-home"]);
		expect(request.flags.home).toBe("/tmp/hobo-home");
	});

	it("defaults demo off", () => {
		const request = parseArgv(["serve", "control"]);
		expect(request.flags.demo).toBe(false);
		expect(request.flags.demoSeed).toBeNull();
	});

	it("rejects --demo on other verbs so simulated data can never reach a deploy", () => {
		expect(() => parseArgv(["up", "--demo"])).toThrow(/Unknown option/);
		expect(() => parseArgv(["deploy", "--demo-seed", "1"])).toThrow(
			/Unknown option/,
		);
	});
});
