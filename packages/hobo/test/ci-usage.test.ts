import { tmpdir } from "node:os";
import type { CredentialResolver } from "@hobo/cd";
import type { MinutesUsage } from "@hobo/ci";
import {
	InMemoryInsightStore,
	InMemoryMinutesReader,
} from "@hobo/ci/runner-order/testing";
import { createHoboCli } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { CI_COMMANDS } from "../src/ci-commands.js";
import { CI_USAGE_COMMAND, GITHUB_STANDARD_RATE } from "../src/ci-usage.js";
import {
	fakeGithub,
	HISTORY_REPOSITORY,
	twoWeeksOfRuns,
} from "./support/ci-insight-history.js";
import {
	FAKE_GITHUB_RATE,
	FAKE_RELAY_ORIGIN,
	type FakeReadApi,
	fakeOwnerCredentials,
	fakeReadApiFetch,
} from "./support/ci-read-api-fake.js";
import {
	FAKE_INSTALLATION_TOKEN,
	installationCredentials,
	refusingCredentials,
	routeGithub,
	withInstallation,
} from "./support/github-app-fake.js";

const NOW = 1_763_337_600_000;
const RELAY_ENV = { HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN };

async function readApi(init: Partial<FakeReadApi> = {}): Promise<FakeReadApi> {
	const insights = new InMemoryInsightStore();
	for (const run of twoWeeksOfRuns(NOW)) await insights.ingest(run);
	return {
		accountId: "acct-1",
		repositories: [{ name: HISTORY_REPOSITORY, public: false }],
		journal: undefined,
		insights,
		minutes: undefined,
		nowMs: () => NOW,
		asked: [],
		...init,
	};
}

async function run(
	args: readonly string[],
	options: Readonly<{
		api?: FakeReadApi;
		env?: NodeJS.ProcessEnv;
		github?: typeof fetch;
		installation?: CredentialResolver;
	}> = {},
) {
	const api = options.api ?? (await readApi());
	const relay = fakeReadApiFetch(api);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: options.env ?? RELAY_ENV,
				ownerCredentials: (cwd) =>
					withInstallation(
						fakeOwnerCredentials()(cwd),
						options.installation ?? installationCredentials(),
					),
				now: () => NOW,
				fetch:
					options.github === undefined
						? relay
						: routeGithub(options.github, relay),
				git: async () => tmpdir(),
				commands: [CI_USAGE_COMMAND],
			}),
		},
	});
	const result = await cli.run(["ci", "usage", ...args], { cwd: tmpdir() });
	return { ...result, output: result.stdout + result.stderr };
}

async function runJson(
	args: readonly string[],
	options: Parameters<typeof run>[1] = {},
) {
	const result = await run([...args, "--json"], options);
	return { ...result, envelope: JSON.parse(result.stdout) };
}

describe("hobo ci usage", () => {
	it("is wired into the hobo ci command table", () => {
		expect(CI_COMMANDS.map((command) => command.name)).toContain("usage");
	});

	it("prices kept minutes at the same GitHub rate a relay is given", () => {
		expect(GITHUB_STANDARD_RATE).toEqual(FAKE_GITHUB_RATE);
	});

	it("reads the relay's usage report: billed, short jobs, kept minutes and the included minutes left", async () => {
		const included: MinutesUsage = {
			usedMinutes: 1200,
			includedMinutes: 3000,
			burnPerHour: 6,
		};
		const api = await readApi({
			minutes: new InMemoryMinutesReader(new Map([["octo", included]])),
		});
		const result = await run([], { api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("from the relay");
		expect(result.stdout).toMatch(/billed\s+\d+ min on GitHub-hosted runners/u);
		expect(result.stdout).toContain("15 billed jobs under a minute");
		expect(result.stdout).toContain("ran on other runners");
		expect(result.stdout).toContain("1200 min of 3000 min used, 1800 min left");
		expect(result.stdout).toContain("depot-ubuntu-24.04  elsewhere");
		expect(result.stdout).toContain("ubuntu-latest  GitHub-hosted");
		expect(api.asked).toEqual([
			`/v1/accounts/self/usage?since=${NOW - 30 * 86_400_000}`,
		]);

		const json = await runJson(
			["--repo", HISTORY_REPOSITORY, "--since", "7d"],
			{
				api,
			},
		);
		expect(json.envelope.data.source).toBe("relay");
		expect(json.envelope.data.report.shortJobs).toBe(8);
		expect(json.envelope.data.report.included.remainingMinutes).toBe(1800);
		expect(api.asked.at(-1)).toBe(
			`/v1/accounts/self/usage?repository=octo%2Fapp&since=${NOW - 7 * 86_400_000}`,
		);
	});

	it("says the included minutes are not measured when the relay cannot read billing", async () => {
		const result = await run([]);
		expect(result.stdout).toContain("included   not measured");
	});

	it("points at --source github when the relay keeps no run history", async () => {
		const result = await runJson([], {
			api: await readApi({ insights: undefined }),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.envelope.code).toBe("HOBO_CI_NOT_STORED_HERE");
		expect(result.envelope.message).toContain("--source github");
	});

	it("computes the same report from GitHub's history as the relay does from its own", async () => {
		const github = fakeGithub(twoWeeksOfRuns(NOW));
		const fromGithub = await runJson(
			["--source", "github", "--repo", HISTORY_REPOSITORY],
			{ env: {}, github: github.fetch },
		);
		expect(fromGithub.exitCode).toBe(0);
		expect(fromGithub.envelope.data.source).toBe("github");
		const fromRelay = await runJson([]);
		expect(fromGithub.envelope.data.report).toEqual(
			fromRelay.envelope.data.report,
		);
		expect(github.paths()).toContain(
			"repos/octo/app/actions/runs/1005/attempts/1/jobs?per_page=100",
		);
		expect(fromGithub.stdout).not.toContain(FAKE_INSTALLATION_TOKEN);
	});

	it("reads the included minutes from GitHub's billing API with the App installation token", async () => {
		const installation = installationCredentials();
		const github = fakeGithub(twoWeeksOfRuns(NOW), {
			private: true,
			also: (request) => {
				if (request.path === "orgs/octo")
					return Response.json({ plan: { name: "team" } });
				if (
					request.path.startsWith("organizations/octo/settings/billing/usage")
				)
					return Response.json({
						usageItems: [
							{
								date: "2025-11-01T00:00:00Z",
								product: "actions",
								sku: "Actions Linux",
								quantity: 600,
								unitType: "Minutes",
								pricePerUnit: 0.006,
								grossAmount: 3.6,
								discountAmount: 0,
								netAmount: 3.6,
								repositoryName: "octo/app",
							},
						],
					});
				return undefined;
			},
		});
		const result = await runJson(
			["--source", "github", "--repo", HISTORY_REPOSITORY],
			{ env: {}, github: github.fetch, installation },
		);
		expect(result.exitCode).toBe(0);
		expect(installation.asked).toEqual(["github-app://octo/app"]);
		expect(result.envelope.data.report.included.includedMinutes).toBe(3000);
		expect(result.envelope.data.report.included.usedMinutes).toBe(600);
	});

	it("prices no kept minutes in a public repository", async () => {
		const github = fakeGithub(twoWeeksOfRuns(NOW), { private: false });
		const result = await runJson(
			["--source", "github", "--repo", HISTORY_REPOSITORY],
			{ env: {}, github: github.fetch },
		);
		expect(result.envelope.data.report.keptMinutes).toBeGreaterThan(0);
		expect(result.envelope.data.report.keptUsd).toBe(0);
	});

	it("refuses to read GitHub without HoBo's GitHub App installation token", async () => {
		const github = fakeGithub(twoWeeksOfRuns(NOW));
		const result = await runJson(
			["--source", "github", "--repo", HISTORY_REPOSITORY],
			{ env: {}, github: github.fetch, installation: refusingCredentials },
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.envelope.code).toBe("HOBO_CI_GITHUB_APP_NEEDED");
		expect(result.envelope.remediation.join(" ")).toContain(
			"choose_secret_store",
		);
		expect(result.envelope.remediation.join(" ")).toContain(
			"hobo ci app create",
		);
		expect(github.requests).toEqual([]);
	});

	it("needs a relay unless it reads GitHub, and rejects options it does not take", async () => {
		const noRelay = await run([], { env: {} });
		expect(noRelay.exitCode).not.toBe(0);
		expect(noRelay.output).toContain("--source github");
		for (const args of [
			["--source", "gitlab"],
			["--since", "later"],
			["--runs", "5"],
			["--source", "github", "--runs", "0"],
			["--outcome", "none"],
		]) {
			const result = await run(args, { env: {} });
			expect(result.exitCode, args.join(" ")).not.toBe(0);
			expect(result.output, args.join(" ")).toContain("hobo ci usage");
		}
	});
});
