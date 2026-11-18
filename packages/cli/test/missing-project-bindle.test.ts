import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCollectCommand,
	createDevCommand,
	createDownCommand,
	createHoboCli,
	createPlanCommand,
	createUpCommand,
	type DevRuntime,
	type YardRuntime,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("commands with an unavailable project Bindle", () => {
	it.each([
		["plan", []],
		["up", []],
		["up", ["--what-if"]],
		["down", []],
		["down", ["--what-if"]],
		["dev", []],
		["collect", []],
	] as const)("reports the project for %s %s", async (verb, flags) => {
		const cwd = await mkdtemp(path.join(tmpdir(), "hobo-missing-bindle-"));
		directories.push(cwd);
		await writeFile(path.join(cwd, "hobo.bindle.json"), "{}\n");
		vi.stubEnv("HOBO_STUB_OK", "1");
		const runtime = {} as YardRuntime;
		const cli = createHoboCli({
			commands: {
				plan: createPlanCommand({ runtime }),
				up: createUpCommand({ runtime }),
				down: createDownCommand({ runtime }),
				dev: createDevCommand({ runtime: {} as DevRuntime }),
				collect: createCollectCommand({ resolveTarget: async () => null }),
			},
		});

		const result = await cli.run([verb, ...flags, "--json"], { cwd });
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			status: string;
			code: string;
			message: string;
			remediation: string[];
			data: { command: string; projectDir: string };
		};
		expect(result.exitCode).toBe(1);
		expect(envelope.ok).toBe(false);
		expect(envelope.status).toBe("error");
		expect(envelope.code).toBe("HOBO_NO_BINDLE");
		expect(envelope.message).toContain(cwd);
		expect(envelope.remediation[0]).toContain("loadable Bindle");
		expect(envelope.data.command).toBe(verb);
		expect(envelope.data.projectDir).toBe(cwd);
	});
});
