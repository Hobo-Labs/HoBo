import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMachineRegistry } from "@hobo/ci/runner-order/testing";
import type { MachineGithub } from "@hobo/ci-gh-actions/machine-worker";
import type { AppleContainerStatus } from "@hobo/ci-gh-actions/machine-worker/macos";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { createCiMachineCommand } from "../src/ci-machine.js";
import {
	createCiMachineConnectCommand,
	type MachineExecutorChoice,
} from "../src/ci-machine-connect.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

const github: MachineGithub = {
	async request(path) {
		if (path === "/user") return Response.json({ id: 42, login: "octocat" });
		if (path === "/repos/octo/app") return Response.json({ private: true });
		if (path.includes("/actions/runs?"))
			return Response.json({ workflow_runs: [] });
		return new Response(null, { status: 404 });
	},
};

async function mac(
	options: Readonly<{
		platform?: Readonly<{ platform: string; arch: string }>;
		appleContainer?: AppleContainerStatus;
	}> = {},
) {
	const home = await mkdtemp(join(tmpdir(), "hobo-connect-macos-"));
	directories.push(home);
	const registry = new InMemoryMachineRegistry();
	const choices: MachineExecutorChoice[] = [];
	let probes = 0;
	const opened = async () => ({ registry, where: "memory", close: () => {} });
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home, GH_TOKEN: "gho_owner" },
				now: () => 1_763_337_600_000,
				commands: [
					createCiMachineConnectCommand({
						githubToken: async () => "gho_owner",
						github: () => github,
						openRegistry: opened,
						executor: (choice) => {
							choices.push(choice);
							return {
								isolation: choice.host ? "host" : "container",
								run: async () => {
									throw new Error("no job is queued");
								},
							};
						},
						platform: options.platform ?? { platform: "darwin", arch: "arm64" },
						appleContainer: async () => {
							probes += 1;
							return options.appleContainer ?? { available: true };
						},
						hostname: () => "studio-mac",
						controls: (session) => {
							void (async () => {
								for (let turn = 0; turn < 50; turn++) await tick();
								session.stop();
							})();
							return () => {};
						},
						writeLine: () => {},
						wait: () => tick(),
						machine: createCiMachineCommand({ openRegistry: opened }),
					}),
				],
			}),
		},
	});
	return {
		run: async (args: readonly string[]) =>
			JSON.parse(
				(
					await cli.run(["ci", "machine", "connect", ...args, "--json"], {
						cwd: tmpdir(),
					})
				).stdout,
			),
		registry,
		choices,
		probes: () => probes,
	};
}

describe("hobo ci machine connect on a Mac", () => {
	it("asks for --host or --vm, because a Mac has no container default", async () => {
		const { run, choices, probes } = await mac();
		const result = await run(["--repo", "octo/app"]);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_UNSUPPORTED",
		});
		expect(result.message).toMatch(/--host/u);
		expect(choices).toEqual([]);
		expect(probes()).toBe(0);
	});

	it("M12: with --host runs jobs on the Mac and advertises macOS labels and host", async () => {
		const { run, registry, choices } = await mac();
		const result = await run(["--repo", "octo/app", "--host"]);
		expect(result.ok).not.toBe(false);
		expect(result.data).toMatchObject({ isolation: "host", mode: "host" });
		expect(choices).toMatchObject([
			{ host: true, mode: "host", os: "macos", arch: "arm64" },
		]);
		const [machine] = await registry.list("local");
		expect(machine).toMatchObject({
			os: "macos",
			arch: "arm64",
			isolation: "host",
			labels: ["self-hosted", "macOS", "ARM64"],
		});
	});

	it("with --host on an Intel Mac uses the x64 labels", async () => {
		const { run, registry } = await mac({
			platform: { platform: "darwin", arch: "x64" },
		});
		await run(["--repo", "octo/app", "--host"]);
		const [machine] = await registry.list("local");
		expect(machine?.labels).toEqual(["self-hosted", "macOS", "X64"]);
	});

	it("with --vm runs each job in a Linux VM and the advert says container", async () => {
		const { run, registry, choices, probes } = await mac();
		const result = await run(["--repo", "octo/app", "--vm"]);
		expect(result.data).toMatchObject({ isolation: "container", mode: "vm" });
		expect(choices).toMatchObject([
			{ host: false, mode: "vm", os: "linux", arch: "arm64" },
		]);
		expect(probes()).toBe(1);
		const [machine] = await registry.list("local");
		expect(machine).toMatchObject({
			isolation: "container",
			labels: ["self-hosted", "Linux", "ARM64"],
		});
	});

	it("refuses --vm when Apple's container tool cannot run, and never uses the host", async () => {
		const { run, registry, choices } = await mac({
			appleContainer: {
				available: false,
				reason: "Apple's container tool is not installed.",
			},
		});
		const result = await run(["--repo", "octo/app", "--vm"]);
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_UNSUPPORTED",
		});
		expect(result.message).toMatch(/not installed/u);
		expect(choices).toEqual([]);
		expect(await registry.list("local")).toEqual([]);
	});

	it("refuses --host with --vm, and --vm on Linux without asking Apple's tool", async () => {
		const both = await mac();
		expect(
			await both.run(["--repo", "octo/app", "--host", "--vm"]),
		).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_USAGE",
		});
		const linux = await mac({ platform: { platform: "linux", arch: "x64" } });
		expect(await linux.run(["--repo", "octo/app", "--vm"])).toMatchObject({
			ok: false,
			code: "HOBO_CI_MACHINE_UNSUPPORTED",
		});
		expect(linux.probes()).toBe(0);
	});
});
