import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { runCiRoute } from "../src/ci-route.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function repository(
	files: Readonly<{ project?: string; facts?: string }> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-route-"));
	directories.push(root);
	await mkdir(join(root, ".hobo"));
	if (files.project !== undefined)
		await writeFile(join(root, ".hobo", "ci.json"), files.project);
	if (files.facts !== undefined)
		await writeFile(join(root, "facts.json"), files.facts);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				git: async (args) => {
					if (args[0] === "rev-parse") return root;
					return "git@github.com:acme/app.git";
				},
			}),
		},
	});
	const route = async (...args: readonly string[]) => {
		const result = await cli.run(["ci", "route", ...args, "--json"], {
			cwd: root,
		});
		return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) };
	};
	return { root, cli, route };
}

const order = (...steps: readonly string[]): string =>
	JSON.stringify({ runnerOrder: { steps: steps.map((key) => ({ key })) } });

describe("hobo ci route", () => {
	it("walks the default order when the repository has committed none", async () => {
		const { route } = await repository();
		const { exitCode, envelope } = await route(
			"--machine",
			"self-hosted",
			"--github",
			"ubuntu-24.04",
		);
		expect(exitCode).toBe(0);
		expect(envelope.data.source).toBe("default");
		expect(envelope.data.request.repository).toBe("acme/app");
		expect(envelope.data.decision).toEqual({
			outcome: "routed",
			runner: "ubuntu-24.04",
			step: "github",
			skipped: [
				{ key: "fleet", reason: "not_configured" },
				{ key: "machine", reason: "no_machine", detail: "self-hosted" },
			],
		});
		expect(envelope.message).toContain(
			"Runner order (default): fleet → machine → github",
		);
		expect(envelope.message).toContain("Routed to ubuntu-24.04 (github).");
		expect(envelope.message).toContain(
			"machine: no connected machine has those labels (self-hosted)",
		);
		expect(envelope.message).toContain("No --facts given");
	});

	it("walks the committed order and shows its limits", async () => {
		const { route } = await repository({
			project: JSON.stringify({
				runnerOrder: {
					steps: [
						{ key: "github", minutesLimitPercent: 80 },
						{ key: "depot", spendLimitUsd: 50 },
					],
				},
			}),
			facts: JSON.stringify({
				minutes: { usedMinutes: 1900, includedMinutes: 2000 },
				spendUsd: { depot: 12.5 },
			}),
		});
		const { exitCode, envelope } = await route(
			"--github",
			"ubuntu-24.04",
			"--depot",
			"auto",
			"--facts",
			"facts.json",
		);
		expect(exitCode).toBe(0);
		expect(envelope.data.source).toBe("committed");
		expect(envelope.data.decision).toMatchObject({
			outcome: "routed",
			runner: "depot-ubuntu-24.04",
			step: "depot",
			skipped: [{ key: "github", reason: "minutes_limit" }],
		});
		expect(envelope.message).toContain(
			"Runner order (.hobo/ci.json): github (under 80% of included minutes) → depot (under $50 a month)",
		);
		expect(envelope.message).not.toContain("No --facts given");
	});

	it("accepts an absolute facts path", async () => {
		const { root, route } = await repository({ facts: "{}" });
		const { exitCode, envelope } = await route(
			"--github",
			"ubuntu-24.04",
			"--facts",
			join(root, "facts.json"),
		);
		expect(exitCode).toBe(0);
		expect(envelope.data.decision).toMatchObject({
			outcome: "routed",
			step: "github",
		});
		expect(envelope.data.request.runId).toBe("1");
	});

	it("refuses boolean and array values where route text is required", async () => {
		const { root } = await repository();
		for (const options of [
			{ event: true },
			{ facts: ["facts.json"] },
			{ github: ["ubuntu-24.04"] },
		]) {
			const result = await runCiRoute({
				cwd: root,
				repository: "acme/app",
				options,
			});
			expect(result).toMatchObject({ ok: false, code: "HOBO_CLI_USAGE" });
			expect(result.message).toContain("takes a text value");
		}
	});

	it("uses machines, the fleet and a retry from the facts file", async () => {
		const machine = {
			id: "m1",
			name: "studio",
			runsOn: "hobo-local-host",
			labels: ["self-hosted", "macOS", "ARM64"],
			online: true,
			paused: false,
			slots: 1,
			busy: 0,
			sharing: "anyone",
			ownerId: "42",
			ownerCanRead: true,
			lastPickedAtMs: 0,
		};
		const { route } = await repository({
			project: order("fleet", "machine"),
			facts: JSON.stringify({
				fleet: { enabled: true, taking: true, isolated: true },
				machines: [machine],
				first: "machine",
			}),
		});
		const { exitCode, envelope } = await route(
			"--fleet",
			"hobo",
			"--machine",
			"self-hosted,macOS",
			"--facts",
			"facts.json",
		);
		expect(exitCode).toBe(0);
		expect(envelope.data.decision).toEqual({
			outcome: "routed",
			runner: "hobo-local-host",
			step: "machine",
			machineId: "m1",
		});
		expect(envelope.message).toContain("Routed to hobo-local-host (machine).");
	});

	it("fails with the reason when nothing can take the job", async () => {
		const { route } = await repository({ project: order("machine") });
		const { exitCode, envelope } = await route(
			"--machine",
			"self-hosted",
			"--depot",
			"depot-ubuntu-24.04",
			"--public",
		);
		expect(exitCode).not.toBe(0);
		expect(envelope.ok).toBe(false);
		expect(envelope.code).toBe("HOBO_CI_NO_RUNNER");
		expect(envelope.message).toContain(
			"No runner available. machine: the repository is public. Not in the runner order, so never tried: depot.",
		);
		expect(envelope.message).toContain(
			"Passed over:\n  machine: the repository is public",
		);
		expect(envelope.message).toContain(
			"Not in the runner order, so never tried: depot.\nNo --facts given:",
		);
		expect(envelope.data.decision.outcome).toBe("none");
		expect(envelope.data.request.private).toBeUndefined();
	});

	it("treats a relay with no inputs as any runner type", async () => {
		const { route } = await repository({ project: order("runs-on", "github") });
		const { envelope } = await route();
		expect(envelope.data.decision).toMatchObject({
			outcome: "routed",
			runner: "runs-on=1/runner=2cpu-linux-x64",
			step: "runs-on",
		});
		expect(envelope.message).toContain("Relay: no inputs");
	});

	it("refuses an existing project configuration that cannot be read", async () => {
		const { root, route } = await repository();
		await mkdir(join(root, ".hobo", "ci.json"));
		const { exitCode, envelope } = await route("--github", "ubuntu-24.04");
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_RUNNER_ORDER_INVALID");
		expect(envelope.message).toContain("cannot read .hobo/ci.json");
	});

	it("refuses a non-object project document instead of using the default order", async () => {
		const { route } = await repository({ project: "[]" });
		const { exitCode, envelope } = await route("--github", "ubuntu-24.04");
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_RUNNER_ORDER_INVALID");
		expect(envelope.message).toContain("the project file is not a JSON object");
	});

	it.skipIf(process.platform === "win32")(
		"refuses a dangling project configuration link",
		async () => {
			const { root, route } = await repository();
			await symlink("missing.json", join(root, ".hobo", "ci.json"));
			const { exitCode, envelope } = await route("--github", "ubuntu-24.04");
			expect(exitCode).not.toBe(0);
			expect(envelope.code).toBe("HOBO_CI_RUNNER_ORDER_INVALID");
		},
	);

	it("refuses to route on a committed order that is broken", async () => {
		const { route } = await repository({
			project: order("machine", "machine"),
		});
		const { exitCode, envelope } = await route("--github", "ubuntu-24.04");
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_RUNNER_ORDER_INVALID");
		expect(envelope.message).toContain(
			"the machine step appears more than once",
		);
		expect(envelope.data.decision).toBeUndefined();
	});

	it.each([
		[["--facts", "missing.json"], "cannot read missing.json"],
		[["--event", "Pull Request"], "--event takes a GitHub event name"],
		[["--github", " , "], "--github needs at least one runner label"],
		[["extra"], "takes no positional arguments"],
	])("reports a usage error for %j", async (args, message) => {
		const { route } = await repository();
		const { exitCode, envelope } = await route(...args);
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CLI_USAGE");
		expect(envelope.message).toContain(message);
	});

	it.each([
		["{not json", "is not JSON"],
		['{"fleet":{"enabled":true}}', "is not a facts document (fleet.taking"],
		['{"surprise":1}', "is not a facts document"],
	])("refuses a facts file holding %s", async (facts, message) => {
		const { route } = await repository({ facts });
		const { envelope } = await route("--facts", "facts.json");
		expect(envelope.code).toBe("HOBO_CLI_USAGE");
		expect(envelope.message).toContain(message);
	});

	it("lists the command in help", async () => {
		const { cli, root } = await repository();
		const help = await cli.run(["ci"], { cwd: root });
		expect(help.stdout).toContain("hobo ci route");
	});
});
