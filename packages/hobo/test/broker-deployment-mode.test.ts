import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { expect, it } from "vitest";
import { createBrokerAwareUpCommand } from "../src/broker-up-command.js";

async function project(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "hobo-broker-mode-"));
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src/bindle.mjs"), "export default {};\n");
	return cwd;
}

it("refuses an unsupported remote broker mode before contacting the broker", async () => {
	const cwd = await project();
	try {
		let contacted = false;
		const cli = createHoboCli({
			commands: {
				up: createBrokerAwareUpCommand({
					env: {},
					createRemoteClient: () => {
						contacted = true;
						throw new Error("unexpected remote call");
					},
				}),
			},
		});
		const result = await cli.run(
			[
				"up",
				"--broker",
				"https://public.example.com",
				"--mode",
				"complete",
				"--json",
			],
			{ cwd },
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
		});
		expect(contacted).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it("refuses an unsupported local broker mode before starting a deployment", async () => {
	const cwd = await project();
	try {
		let started = false;
		const cli = createHoboCli({
			commands: {
				up: createBrokerAwareUpCommand({
					env: {},
					startLocalDeployment: async () => {
						started = true;
						throw new Error("unexpected local start");
					},
				}),
			},
		});
		const result = await cli.run(["up", "--mode", "complete", "--json"], {
			cwd,
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
		});
		expect(started).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
