import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { resolveBrokerTarget } from "../src/broker-target.js";
import { createBrokerAwareUpCommand } from "../src/broker-up-command.js";

describe("self-hosted broker without hosted services", () => {
	it.each([
		{ flags: [] },
		{ flags: ["--anonymous"] },
		{ flags: ["--temporary"] },
	])("places and probes locally with flags $flags and remote services unavailable", async ({
		flags,
	}) => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-self-hosted-"));
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			let remoteCalls = 0;
			const cli = createHoboCli({
				commands: {
					up: createBrokerAwareUpCommand({
						env: {},
						createRemoteClient: () => {
							remoteCalls += 1;
							throw new Error("Hosted broker unavailable");
						},
						discovery: {
							async discover() {
								remoteCalls += 1;
								throw new Error("Hosted discovery unavailable");
							},
						},
					}),
				},
			});
			const result = await cli.run(
				["up", ...flags, "--home", hoboHome, "--json"],
				{
					cwd: fileURLToPath(
						new URL("../../../examples/hello-bindle", import.meta.url),
					),
				},
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: true,
				data: {
					mode: "local",
					brokerId: expect.stringMatching(/^broker:local\//),
					probe: { status: 200 },
				},
			});
			expect(remoteCalls).toBe(0);
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	});

	// The persistent lane (the product's `up`) gives an anonymous or temporary
	// deployment the configured TTL, and an ordinary one none. The worker start
	// is stood in for, so this checks what it is asked for without serving.
	it.each([
		{ flags: [], ttlSeconds: 0 },
		{ flags: ["--anonymous"], ttlSeconds: 7 },
		{ flags: ["--temporary"], ttlSeconds: 7 },
	])("asks the persistent lane for ttlSeconds $ttlSeconds with flags $flags", async ({
		flags,
		ttlSeconds,
	}) => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-self-hosted-ttl-"));
		try {
			initBareMetalYard({ hoboHome, componentHost: "local" });
			const asked: number[] = [];
			const cli = createHoboCli({
				commands: {
					up: createBrokerAwareUpCommand({
						env: { HOBO_LOCAL_DEPLOYMENT_TTL_SECONDS: "7" },
						persistentLocal: true,
						startLocalDeployment: async (options) => {
							asked.push(options.ttlSeconds);
							throw new Error("not started in this test");
						},
					}),
				},
			});
			await cli.run(["up", ...flags, "--home", hoboHome, "--json"], {
				cwd: fileURLToPath(
					new URL("../../../examples/hello-bindle", import.meta.url),
				),
			});
			expect(asked).toEqual([ttlSeconds]);
		} finally {
			await rm(hoboHome, { recursive: true, force: true });
		}
	});

	it("accepts an explicitly selected self-hosted network broker", () => {
		expect(
			resolveBrokerTarget({
				flags: { broker: "http://127.0.0.1:8790", temporary: true },
				env: {},
				hoboHome: "/tmp/unused-self-hosted-profile",
			}),
		).toEqual({
			kind: "remote",
			uri: "http://127.0.0.1:8790",
			mode: "anonymous",
			source: "flag",
		});
	});
});
