import { describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "../src/process-runner.js";

describe("real process runner", () => {
	it("passes argv literally, supplies only the requested environment, and supports stdin", async () => {
		const marker = "literal; $(echo injected)";
		const result = await createNodeProcessRunner().run(
			[
				process.execPath,
				"-e",
				"process.stdin.on('data', d => process.stdout.write(JSON.stringify({argument:process.argv[1],environment:process.env,stdin:String(d)})))",
				marker,
			],
			{ env: { HOBO_FIXTURE_VALUE: "bound" }, stdin: "input", timeoutMs: 5000 },
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			argument: marker,
			environment: { HOBO_FIXTURE_VALUE: "bound" },
			stdin: "input",
		});
	});
	it("bounds output while the child is producing it", async () => {
		await expect(
			createNodeProcessRunner({ maxOutputBytes: 128 }).run(
				[process.execPath, "-e", "process.stdout.write('x'.repeat(2048))"],
				{ env: {}, timeoutMs: 5000 },
			),
		).rejects.toThrow(/byte limit/u);
	});
	it("kills a hung process at its deadline and reports an uncertain outcome", async () => {
		await expect(
			createNodeProcessRunner().run(
				[process.execPath, "-e", "setInterval(() => {}, 1000)"],
				{ env: {}, timeoutMs: 100 },
			),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
	});
});
