import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createHoboCli } from "@hobo/cli";
import {
	Availability,
	FleetViewSchema,
	Health,
	MemberState,
	SandboxTier,
} from "@hobo/fleet";
import { afterEach, describe, expect, it } from "vitest";
import pact from "../contracts/ci-cli.pact.json";
import {
	type CiFleetStatus,
	ciRepositoryFromRemote,
	createCiCommand,
} from "../src/ci-command.js";

/** What `hobo fleet status` shows under `hobo ci status`: one fleet, one live member. */
const FLEET_VIEWS: CiFleetStatus = async () => ({
	ok: true,
	value: [
		{
			fleet: "builds",
			view: create(FleetViewSchema, {
				fleet: "builds",
				asOf: "2026-11-13T00:00:00.000Z",
				members: [
					{
						name: "box-a",
						state: MemberState.ACTIVE,
						availability: Availability.LIVE,
						health: Health.REACHABLE,
						capacity: { freeSlots: 2, totalSlots: 4 },
						sandboxTiers: [SandboxTier.S1_CONTAINER],
					},
				],
				capacity: { live: 1, healthy: 1, totalSlots: 4, freeSlots: 2 },
			}),
		},
	],
});

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture(
	options: {
		remotes?: string;
		interactive?: boolean;
		prompt?: (question: string) => Promise<string>;
		env?: NodeJS.ProcessEnv;
		fetch?: typeof fetch;
		fleetStatus?: CiFleetStatus;
	} = {},
) {
	const home = await mkdtemp(join(tmpdir(), "hobo-ci-command-"));
	directories.push(home);
	const requests: string[] = [];
	let connected = false;
	const send: typeof fetch =
		options.fetch ??
		(async (url, init) => {
			const path = new URL(String(url)).pathname;
			requests.push(`${init?.method} ${path}`);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer cli-test-token",
			);
			expect(init?.redirect).toBe("error");
			if (path.endsWith("/policy"))
				return Response.json({
					revision: 7,
					account: { id: "account-test" },
					connections: connected
						? [
								{
									repository: "example/project",
									installationId: 42,
									isolatedOnly: true,
									acceptAllMatchingRepositoryJobs: true,
								},
							]
						: [],
				});
			if (path.endsWith("/installations"))
				return Response.json({
					accountId: "account-test",
					installationIds: [42],
				});
			if (path.endsWith("/isolated-connect")) {
				connected = true;
				return Response.json({
					repository: "example/project",
					accountId: "account-test",
					installationId: 42,
					isolatedOnly: true,
					acceptAllMatchingRepositoryJobs: true,
				});
			}
			throw new Error("Unexpected request");
		});
	const deps: Parameters<typeof createCiCommand>[0] = {
		env: {
			HOBO_HOME: home,
			HOBO_CI_ACCOUNT_TOKEN: "cli-test-token",
			...options.env,
		},
		interactive: options.interactive ?? false,
		fetch: send,
		git: async (args) => {
			if (args[0] === "rev-parse") return home;
			if (args.length === 1) return options.remotes ?? "origin";
			return "git@github.com:example/project.git";
		},
	};
	if (options.prompt) deps.prompt = options.prompt;
	if (options.fleetStatus) deps.fleetStatus = options.fleetStatus;
	const cli = createHoboCli({ commands: { ci: createCiCommand(deps) } });
	return { cli, home, requests };
}

const consent = ["--yes", "--accept-all-matching-jobs"];

describe("hobo ci setup", () => {
	it("shows help without Git, credentials or a Bindle", async () => {
		const { cli, requests, home } = await fixture();
		const result = await cli.run(["ci"], { cwd: home });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hobo ci connect");
		expect(requests).toEqual([]);
	});
	it.each([
		"git@github.com:example/project.git",
		"https://github.com/example/project",
		"ssh://git@github.com/example/project.git",
	])("detects GitHub repository from %s", (remote) => {
		expect(ciRepositoryFromRemote(remote)).toBe("example/project");
	});
	it.each([
		"https://github.com.evil.test/example/project",
		"https://token@github.com/example/project",
		"-example/project",
		"https://gitlab.com/example/project",
		"https://github.com/example/project?token=secret",
	])("refuses unsupported remote %s", (remote) => {
		expect(() => ciRepositoryFromRemote(remote)).toThrow();
	});
	it("connects, saves no credential, and revalidates its user-owned link", async () => {
		const { cli, requests, home } = await fixture();
		const first = await cli.run(
			[
				"ci",
				"connect",
				"--relay",
				"https://relay.example",
				...consent,
				"--json",
			],
			{ cwd: home },
		);
		expect(first.exitCode).toBe(0);
		expect(JSON.parse(first.stdout).data.unchanged).toBe(false);
		const files = await readdir(join(home, "ci/links"));
		expect(files).toHaveLength(1);
		const saved = await readFile(
			join(home, "ci/links", files[0] ?? ""),
			"utf8",
		);
		expect(JSON.parse(saved)).toEqual({
			relayOrigin: "https://relay.example",
			accountId: "account-test",
			repository: "example/project",
		});
		expect(saved).not.toContain("cli-test-token");
		const second = await cli.run(["ci", "enable", "--json"], { cwd: home });
		expect(second.exitCode).toBe(0);
		expect(JSON.parse(second.stdout).data.unchanged).toBe(true);
		expect(
			requests.filter((path) => path.includes("isolated-connect")),
		).toHaveLength(2);
	});
	it("does not reuse a connection when live installation validation fails", async () => {
		let calls = 0;
		const { cli, home } = await fixture({
			fetch: async (url, init) => {
				calls++;
				if (String(url).endsWith("/policy"))
					return Response.json(pact.interactions[3]?.response.body);
				expect(String(url)).toBe(
					"https://relay.example/v1/accounts/self/repositories/isolated-connect",
				);
				expect(init?.method).toBe("POST");
				return new Response("removed installation", { status: 404 });
			},
		});
		const result = await cli.run(
			["ci", "enable", "--relay", "https://relay.example", "--json"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).data.status).toBe(404);
		expect(calls).toBe(2);
		await expect(readdir(join(home, "ci/links"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("refuses an explicit installation change when setup reuses an existing connection", async () => {
		const { cli, home, requests } = await fixture();
		expect(
			(
				await cli.run(
					["ci", "connect", "--relay", "https://relay.example", ...consent],
					{ cwd: home },
				)
			).exitCode,
		).toBe(0);
		const result = await cli.run(
			["ci", "enable", "--installation-id", "99", "--json"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).code).toBe(
			"HOBO_CI_INSTALLATION_MISMATCH",
		);
		expect(
			requests.filter((path) => path.includes("isolated-connect")),
		).toHaveLength(1);
		const same = await cli.run(
			["ci", "enable", "--installation-id", "42", "--json"],
			{ cwd: home },
		);
		expect(same.exitCode).toBe(0);
		expect(JSON.parse(same.stdout).data.unchanged).toBe(true);
	});
	it.each([
		"0",
		"-1",
		"abc",
		"9007199254740992",
	])("rejects malformed installation ID %s before authenticating", async (id) => {
		const { cli, home, requests } = await fixture();
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--relay",
				"https://relay.example",
				...consent,
				`--installation-id=${id}`,
				"--json",
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(2);
		expect(requests).toEqual([]);
	});
	it("executes the CLI-to-relay Pact without changing its headers or protobuf payload", async () => {
		let calls = 0;
		const send: typeof fetch = async (url, init) => {
			const interaction = pact.interactions[calls++];
			if (!interaction) throw new Error("Unexpected request");
			expect(String(url)).toBe(
				`https://relay.example${interaction.request.path}`,
			);
			expect(init?.method).toBe(interaction.request.method);
			expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
				Object.fromEntries(new Headers(interaction.request.headers)),
			);
			expect(init?.redirect).toBe("error");
			if ("body" in interaction.request)
				expect(JSON.parse(String(init?.body))).toEqual(
					interaction.request.body,
				);
			else expect(init?.body).toBeUndefined();
			return Response.json(interaction.response.body, {
				status: interaction.response.status,
			});
		};
		const { cli, home } = await fixture({ fetch: send });
		const result = await cli.run(
			["ci", "enable", "--relay", "https://relay.example", ...consent],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toBe(3);
	});
	it("reports connected status through its Pact interaction, with no fleet table when no authority is configured", async () => {
		const interactions = [pact.interactions[3]];
		let calls = 0;
		const { cli, home } = await fixture({
			fetch: async (url, init) => {
				const interaction = interactions[calls++];
				if (!interaction) throw new Error("Unexpected request");
				expect(String(url)).toBe(
					`https://relay.example${interaction.request.path}`,
				);
				expect(init?.method).toBe(interaction.request.method);
				expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
					Object.fromEntries(new Headers(interaction.request.headers)),
				);
				return Response.json(interaction.response.body, {
					status: interaction.response.status,
				});
			},
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example", "--json"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		const { data } = JSON.parse(result.stdout);
		expect(data).toMatchObject({
			connected: true,
			isolated: true,
			installationId: 42,
		});
		expect(data.fleet).toBeUndefined();
		expect(calls).toBe(1);
	});
	it("shows hobo fleet status under the connection status", async () => {
		const { cli, home } = await fixture({
			fetch: async () => Response.json(pact.interactions[3]?.response.body),
			fleetStatus: FLEET_VIEWS,
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.split("\n").map((line) => line.trimEnd());
		const start = lines.findIndex((line) => line.startsWith("CI connected"));
		expect(lines.slice(start, start + 3)).toEqual([
			"CI connected for example/project at https://relay.example.",
			"Fleet builds: 1 member(s) as of 2026-11-13T00:00:00.000Z",
			"MEMBER  STATE   AVAILABILITY  HEALTH     SLOTS  MEMORY  DISK  RELIABILITY  TIER",
		]);
		expect(result.stdout).toMatch(/^box-a\s+active\s+live\s+reachable\s+2\/4/m);
		const json = await cli.run(
			["ci", "status", "--relay", "https://relay.example", "--json"],
			{ cwd: home },
		);
		expect(JSON.parse(json.stdout).data.fleet).toEqual([
			{ fleet: "builds", members: 1, freeSlots: 2, totalSlots: 4 },
		]);
	});
	it("says why the fleet table is missing when the authority refuses", async () => {
		const { cli, home } = await fixture({
			fetch: async () => Response.json(pact.interactions[3]?.response.body),
			fleetStatus: async () => ({
				ok: false,
				error: { code: "unauthenticated", message: "not signed in" },
			}),
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Fleet status unavailable: not signed in");
	});
	it("answers status with the fleet status when no relay can be asked", async () => {
		// No relay selected at all.
		const unselected = await fixture({ fleetStatus: FLEET_VIEWS });
		const first = await unselected.cli.run(["ci", "status"], {
			cwd: unselected.home,
		});
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toContain("No CI relay is selected.");
		expect(first.stdout).toMatch(/^box-a\s+active/m);
		expect(unselected.requests).toEqual([]);
		// A relay, but no credential to ask it with.
		const noToken = await fixture({
			env: { HOBO_CI_ACCOUNT_TOKEN: undefined },
			fleetStatus: FLEET_VIEWS,
		});
		const second = await noToken.cli.run(
			["ci", "status", "--relay", "https://relay.example", "--json"],
			{ cwd: noToken.home },
		);
		expect(second.exitCode).toBe(0);
		expect(JSON.parse(second.stdout).data).toMatchObject({
			source: "fleet",
			fleet: [{ fleet: "builds", members: 1 }],
		});
		expect(noToken.requests).toEqual([]);
		// A relay that cannot be reached.
		const f = await fixture({
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			fleetStatus: FLEET_VIEWS,
		});
		const unreachable = await f.cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: f.home },
		);
		expect(unreachable.exitCode).toBe(0);
		expect(unreachable.stdout).toContain("The CI relay could not be reached.");
		expect(unreachable.stdout).toMatch(/^box-a\s+active/m);
	});
	it("answers as before when offline and no fleet authority is configured", async () => {
		const none = await fixture();
		const unselected = await none.cli.run(["ci", "status"], { cwd: none.home });
		expect(unselected.exitCode).toBe(2);
		expect(unselected.stdout).toContain("Select your CI relay");
		const noToken = await fixture({
			env: { HOBO_CI_ACCOUNT_TOKEN: undefined },
		});
		const unauthenticated = await noToken.cli.run(
			["ci", "status", "--relay", "https://relay.example", "--json"],
			{ cwd: noToken.home },
		);
		expect(unauthenticated.exitCode).not.toBe(0);
		expect(unauthenticated.stdout).toContain("HOBO_CI_AUTH_REQUIRED");
		// A fleet status never stands in for a command that changes something.
		const enabling = await fixture({ fleetStatus: FLEET_VIEWS });
		const enable = await enabling.cli.run(["ci", "enable", ...consent], {
			cwd: enabling.home,
		});
		expect(enable.exitCode).toBe(2);
		expect(enable.stdout).toContain("Select your CI relay");
	});
	it("requires an explicit remote choice when several exist without a terminal", async () => {
		const { cli, requests, home } = await fixture({
			remotes: "origin\nupstream",
		});
		const result = await cli.run(
			["ci", "enable", "--relay", "https://relay.example", ...consent],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("--remote");
		expect(requests).toEqual([]);
	});
	it("requires both unattended setup acknowledgments", async () => {
		const { cli, requests, home } = await fixture();
		for (const flags of [[], ["--yes"], ["--accept-all-matching-jobs"]]) {
			const result = await cli.run(
				["ci", "enable", "--relay", "https://relay.example", ...flags],
				{ cwd: home },
			);
			expect(result.exitCode).toBe(2);
		}
		expect(requests.every((path) => path.endsWith("/policy"))).toBe(true);
	});
	it("confirms repository/account/runner access interactively", async () => {
		const questions: string[] = [];
		const { cli, home } = await fixture({
			interactive: true,
			prompt: async (question) => {
				questions.push(question);
				return "yes";
			},
		});
		const result = await cli.run(
			["ci", "connect", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(questions.join()).toContain("example/project");
		expect(questions.join()).toContain("account-test");
		expect(questions.join()).toContain("fork pull requests");
	});
	it("does not mutate after a declined confirmation", async () => {
		const { cli, requests, home } = await fixture({
			interactive: true,
			prompt: async () => "no",
		});
		const result = await cli.run(
			["ci", "connect", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cancelled");
		expect(requests.some((path) => path.includes("isolated-connect"))).toBe(
			false,
		);
	});
	it("rejects a credential-bearing or insecure relay before reading credentials", async () => {
		const { cli, requests, home } = await fixture();
		for (const relay of [
			"http://relay.example",
			"https://secret@relay.example",
			"https://relay.example/path",
		])
			expect(
				(
					await cli.run(["ci", "enable", "--relay", relay, ...consent], {
						cwd: home,
					})
				).exitCode,
			).toBe(2);
		expect(requests).toEqual([]);
	});
	it("does not save success when the relay returns an incomplete connection", async () => {
		const { cli, home } = await fixture({
			fetch: async (url) =>
				Response.json(
					String(url).endsWith("/policy")
						? { revision: 7, account: { id: "account-test" } }
						: String(url).endsWith("/installations")
							? { accountId: "account-test", installationIds: [42] }
							: {},
				),
		});
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--relay",
				"https://relay.example",
				...consent,
				"--json",
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).code).toBe(
			"HOBO_CI_CONNECTION_UNCONFIRMED",
		);
		await expect(readdir(join(home, "ci/links"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("does not label a legacy bridge connection as isolated CI readiness", async () => {
		const { cli, home } = await fixture({
			fetch: async () =>
				Response.json({
					revision: 7,
					account: { id: "account-test" },
					connections: [{ repository: "example/project" }],
				}),
		});
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--relay",
				"https://relay.example",
				...consent,
				"--json",
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CI_CONNECTION_MODE");
	});
	it("keeps GitHub run validation independent of a damaged relay link", async () => {
		const { cli, home } = await fixture();
		expect(
			(
				await cli.run(
					["ci", "enable", "--relay", "https://relay.example", ...consent],
					{ cwd: home },
				)
			).exitCode,
		).toBe(0);
		const [file] = await readdir(join(home, "ci/links"));
		await writeFile(join(home, "ci/links", file ?? ""), "damaged link");
		const result = await cli.run(["ci", "list", "--limit", "101", "--json"], {
			cwd: home,
		});
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).message).toContain("--limit");
	});
	it("checks saved account continuity before any setup mutation", async () => {
		let account = "account-test";
		let mutations = 0;
		const { cli, home } = await fixture({
			fetch: async (url, init) => {
				if (String(url).endsWith("/policy"))
					return Response.json({ revision: 7, account: { id: account } });
				if (String(url).endsWith("/installations"))
					return Response.json({ accountId: account, installationIds: [42] });
				if (init?.method === "POST") {
					mutations++;
					return Response.json({
						repository: "example/project",
						accountId: account,
						installationId: 42,
						isolatedOnly: true,
						acceptAllMatchingRepositoryJobs: true,
					});
				}
				throw new Error("Unexpected request");
			},
		});
		expect(
			(
				await cli.run(
					["ci", "enable", "--relay", "https://relay.example", ...consent],
					{ cwd: home },
				)
			).exitCode,
		).toBe(0);
		account = "another-account";
		const result = await cli.run(["ci", "enable", ...consent, "--json"], {
			cwd: home,
		});
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CI_ACCOUNT_MISMATCH");
		const renamed = await cli.run(
			["ci", "enable", "--repo", "EXAMPLE/PROJECT", ...consent, "--json"],
			{ cwd: home },
		);
		expect(JSON.parse(renamed.stdout).code).toBe("HOBO_CI_ACCOUNT_MISMATCH");
		expect(mutations).toBe(1);
	});
	it("checks saved account continuity for an equivalent noncanonical relay origin", async () => {
		const { cli, home, requests } = await fixture();
		expect(
			(
				await cli.run(
					["ci", "enable", "--relay", "https://relay.example", ...consent],
					{ cwd: home },
				)
			).exitCode,
		).toBe(0);
		const [file] = await readdir(join(home, "ci/links"));
		await writeFile(
			join(home, "ci/links", file ?? ""),
			JSON.stringify({
				relayOrigin: "https://RELAY.example:443/",
				accountId: "previous-account",
				repository: "example/project",
			}),
		);
		const result = await cli.run(["ci", "enable", ...consent, "--json"], {
			cwd: home,
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CI_ACCOUNT_MISMATCH");
		expect(
			requests.filter((path) => path.includes("isolated-connect")),
		).toHaveLength(1);
	});
	it("prints the App installation page when the account has no installation", async () => {
		const { cli, home } = await fixture({
			fetch: async (url) =>
				Response.json(
					String(url).endsWith("/policy")
						? { revision: 7, account: { id: "account-test" } }
						: { accountId: "account-test", installationIds: [] },
				),
		});
		const result = await cli.run(
			["ci", "enable", "--relay", "https://relay.example", ...consent],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			"https://relay.example/v1/app-registration/setup",
		);
	});
	it("reads a bounded token file and keeps it out of JSON failures", async () => {
		const { cli, home } = await fixture({
			env: { HOBO_CI_ACCOUNT_TOKEN: undefined },
			fetch: async () =>
				new Response("sensitive response body", { status: 403 }),
		});
		const token = join(home, "token");
		await writeFile(token, "private-token\n");
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--relay",
				"https://relay.example",
				"--token-file",
				token,
				...consent,
				"--json",
				"--verbose",
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("403");
		expect(result.stdout + result.stderr).not.toContain("private-token");
		expect(result.stdout + result.stderr).not.toContain(
			"sensitive response body",
		);
	});
	it("pins a token file for one invocation even when the mounted credential rotates", async () => {
		let tokenFile = "";
		let calls = 0;
		const { cli, home } = await fixture({
			env: { HOBO_CI_ACCOUNT_TOKEN: undefined },
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer original-account-token",
				);
				const interaction = pact.interactions[calls++];
				if (!interaction) throw new Error("Unexpected request");
				if (calls === 1)
					await writeFile(tokenFile, "rotated-different-account-token");
				return Response.json(interaction.response.body);
			},
		});
		tokenFile = join(home, "token");
		await writeFile(tokenFile, "original-account-token");
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--relay",
				"https://relay.example",
				"--token-file",
				tokenFile,
				...consent,
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toBe(3);
		expect(await readFile(tokenFile, "utf8")).toBe(
			"rotated-different-account-token",
		);
	});
	it("reports a committed connection separately from failure to save its local link", async () => {
		const { cli, home, requests } = await fixture();
		const blocked = join(home, "not-a-directory");
		await writeFile(blocked, "fixture");
		const result = await cli.run(
			[
				"ci",
				"enable",
				"--repo",
				"example/project",
				"--relay",
				"https://relay.example",
				"--home",
				blocked,
				...consent,
				"--json",
			],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CI_LINK_SAVE_FAILED");
		expect(
			requests.filter((path) => path.includes("isolated-connect")),
		).toHaveLength(1);
	});
	it("rejects connection-only flags on run commands before reading credentials", async () => {
		const { cli, home, requests } = await fixture();
		const result = await cli.run(
			["ci", "logs", "123", "--relay", "https://relay.example", "--json"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(2);
		expect(requests).toEqual([]);
	});
});
