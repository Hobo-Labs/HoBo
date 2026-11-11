import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import pact from "../contracts/ci-cli.pact.json";
import { ciRepositoryFromRemote, createCiCommand } from "../src/ci-command.js";

/** The contract fixture of what a relay answers `GET /v1/mesh/nodes` with. */
const MESH_REPORTS_FIXTURE = new URL(
	"../../ci-gh-actions/data-models/fixtures/valid/mesh-node-reports.json",
	import.meta.url,
);

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
	it("reports connected status and the relay's mesh through their Pact interactions", async () => {
		// The account's policy, then the relay's mesh nodes: two reads, in order.
		const interactions = [pact.interactions[3], pact.interactions[4]];
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
		expect(JSON.parse(result.stdout).data).toMatchObject({
			connected: true,
			isolated: true,
			installationId: 42,
			// A relay with no mesh says so; that is part of the status, not an error.
			mesh: { mesh: "not-configured", nodes: [] },
		});
		expect(calls).toBe(2);
	});
	it("lists the relay mesh's nodes as a table under the connection status", async () => {
		const reports = await readFile(MESH_REPORTS_FIXTURE, "utf8");
		const { cli, home } = await fixture({
			fetch: async (url) =>
				new URL(String(url)).pathname === "/v1/mesh/nodes"
					? new Response(reports, {
							headers: { "content-type": "application/json" },
						})
					: Response.json(pact.interactions[3]?.response.body),
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.split("\n").map((line) => line.trimEnd());
		const start = lines.findIndex((line) => line.startsWith("CI connected"));
		expect(lines.slice(start, start + 7)).toEqual([
			"CI connected for example/project at https://relay.example.",
			"Mesh: 2 node(s) as of 2026-11-10T02:40:05.000Z",
			"NODE        STATE  SLOTS  MEMORY   DISK    RELIABILITY              TRUST",
			"box-a       live   2/4    12.0 GB  200 GB  0.88 (10 ok, 2 dropped)  trusted",
			// A node that is gone offers nothing: its last figures are not shown.
			"relay-host  lost   -      -        -       -                        unverified",
			"Capacity: 2/4 slots free on 1 healthy node(s); 12.0 GB memory and 200 GB disk free.",
			"Trust: trusted = key in the mesh's trusted set; unverified = signed by an unlisted key, or unsigned; invalid = signature failed, never ranked.",
		]);
	});
	it("says when the relay listed only some of the mesh's nodes", async () => {
		const reports = JSON.parse(await readFile(MESH_REPORTS_FIXTURE, "utf8"));
		const { cli, home } = await fixture({
			fetch: async (url) =>
				new URL(String(url)).pathname === "/v1/mesh/nodes"
					? // A newer relay's field this CLI does not know is read past.
						Response.json({ ...reports, truncated: true, newerField: 1 })
					: Response.json(pact.interactions[3]?.response.body),
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"More nodes are known than are listed; 2 shown.",
		);
	});
	it("keeps the connection status when the relay is too old to list its mesh", async () => {
		const { cli, home } = await fixture({
			fetch: async (url) =>
				new URL(String(url)).pathname === "/v1/mesh/nodes"
					? Response.json({ error: "not found" }, { status: 404 })
					: Response.json(pact.interactions[3]?.response.body),
		});
		const result = await cli.run(
			["ci", "status", "--relay", "https://relay.example", "--json"],
			{ cwd: home },
		);
		expect(result.exitCode).toBe(0);
		const { data } = JSON.parse(result.stdout);
		expect(data).toMatchObject({ connected: true });
		expect(data.mesh).toBeUndefined();
	});
	it("answers status offline from this machine's own report when no relay can be asked", async () => {
		const reports = await readFile(MESH_REPORTS_FIXTURE, "utf8");
		const local = async (env: NodeJS.ProcessEnv, args: string[] = []) => {
			const f = await fixture({ env });
			// Where a local runner keeps its state: .hobo/ci-local in the repository.
			await mkdir(join(f.home, ".hobo", "ci-local"), { recursive: true });
			await writeFile(
				join(f.home, ".hobo", "ci-local", "mesh-node.json"),
				reports,
			);
			return {
				...f,
				result: await f.cli.run(["ci", "status", ...args], { cwd: f.home }),
			};
		};
		// No relay selected at all.
		const unselected = await local({});
		expect(unselected.result.exitCode).toBe(0);
		expect(unselected.result.stdout).toContain("No CI relay is selected.");
		expect(unselected.result.stdout).toMatch(/^box-a\s+live\s+2\/4/m);
		expect(unselected.requests).toEqual([]);
		// A relay, but no credential to ask it with.
		const unauthenticated = await local({ HOBO_CI_ACCOUNT_TOKEN: undefined }, [
			"--relay",
			"https://relay.example",
			"--json",
		]);
		expect(unauthenticated.result.exitCode).toBe(0);
		expect(JSON.parse(unauthenticated.result.stdout).data).toMatchObject({
			source: "local",
			mesh: {
				mesh: "configured",
				nodes: [{ id: "box-a" }, { id: "relay-host" }],
			},
		});
		expect(unauthenticated.requests).toEqual([]);
		// A relay that cannot be reached.
		const f = await fixture({
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		await mkdir(join(f.home, ".hobo", "ci-local"), { recursive: true });
		await writeFile(
			join(f.home, ".hobo", "ci-local", "mesh-node.json"),
			reports,
		);
		const unreachable = await f.cli.run(
			["ci", "status", "--relay", "https://relay.example"],
			{ cwd: f.home },
		);
		expect(unreachable.exitCode).toBe(0);
		expect(unreachable.stdout).toContain("The CI relay could not be reached.");
		expect(unreachable.stdout).toMatch(/^relay-host\s+lost/m);
	});
	it("answers as before when offline and this machine keeps no report", async () => {
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
		// A report that is not one is no report.
		await mkdir(join(none.home, ".hobo", "ci-local"), { recursive: true });
		await writeFile(
			join(none.home, ".hobo", "ci-local", "mesh-node.json"),
			'{"mesh":',
		);
		expect(
			(await none.cli.run(["ci", "status"], { cwd: none.home })).exitCode,
		).toBe(2);
		// And an offline report never stands in for a command that changes something.
		const enabling = await fixture();
		await mkdir(join(enabling.home, ".hobo", "ci-local"), { recursive: true });
		await writeFile(
			join(enabling.home, ".hobo", "ci-local", "mesh-node.json"),
			await readFile(MESH_REPORTS_FIXTURE, "utf8"),
		);
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
