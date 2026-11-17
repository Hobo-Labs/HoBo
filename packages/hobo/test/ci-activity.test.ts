import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	DesiredCiPolicySchema,
	defineCiPolicy,
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
	RunnerRouteRequestSchema,
} from "@hobo/ci";
import { SqliteRouteJournal } from "@hobo/ci/runner-order/journal-sqlite";
import { InMemoryRouteJournal } from "@hobo/ci/runner-order/testing";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import {
	CI_ACTIVITY_COMMAND,
	decodeActivityCursor,
	encodeActivityCursor,
	parseSince,
} from "../src/ci-activity.js";
import { createCiCommand } from "../src/ci-command.js";
import { CI_COMMANDS } from "../src/ci-commands.js";
import {
	FAKE_RELAY_ORIGIN,
	FAKE_RELAY_TOKEN,
	type FakeReadApi,
	fakeReadApiFetch,
} from "./support/ci-read-api-fake.js";

const DAY = 86_400_000;
const NOW = 1_763_337_600_000;
const ACCOUNT = "acct-1";

type Decided = Readonly<{
	atMs: number;
	jobId: string;
	repository?: string;
	runId?: number;
	outcome?: string;
	runner?: string;
	step?: string;
	machineId?: string;
	reason?: string;
	skipped?: readonly Readonly<{
		key: string;
		reason: string;
		detail?: string;
	}>[];
}>;

function request(repository: string, runId: number) {
	return create(RunnerRouteRequestSchema, {
		repository,
		private: true,
		event: "push",
		runId,
		runAttempt: 1,
		job: "route",
		inputs: [{ key: "github", labels: ["ubuntu-24.04"] }],
	});
}

function decided(init: Decided): RunnerRouteEvent {
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Decided",
		accountId: ACCOUNT,
		atMs: init.atMs,
		request: request(init.repository ?? "octo/app", init.runId ?? 1),
		decision: {
			outcome: init.outcome ?? "routed",
			runner: init.runner ?? "ubuntu-24.04",
			step: init.step ?? "github",
			machineId: init.machineId ?? "",
			reason: init.reason ?? "",
			skipped: (init.skipped ?? []).map((skip) => ({
				key: skip.key,
				reason: skip.reason,
				detail: skip.detail ?? "",
			})),
		},
		mode: "relay",
		node: "node-1",
		jobId: init.jobId,
	});
}

function requested(atMs: number, jobId: string, runId = 1): RunnerRouteEvent {
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Requested",
		accountId: ACCOUNT,
		atMs,
		request: request("octo/app", runId),
		mode: "relay",
		node: "node-1",
		jobId,
	});
}

function api(init: Partial<FakeReadApi> = {}): FakeReadApi {
	return {
		accountId: ACCOUNT,
		repositories: [{ name: "octo/app", public: false }],
		journal: new InMemoryRouteJournal(),
		insights: undefined,
		minutes: undefined,
		nowMs: () => NOW,
		asked: [],
		...init,
	};
}

const RELAY_ENV = {
	HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN,
	HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN,
};

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	directories.push(path);
	return path;
}

/** A hobo home with no saved links, so a developer's own links never leak in. */
const EMPTY_HOBO_HOME = join(tmpdir(), "hobo-ci-activity-no-home");

async function run(
	readApi: FakeReadApi,
	args: readonly string[],
	env: NodeJS.ProcessEnv = RELAY_ENV,
	cwd: string = tmpdir(),
) {
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: EMPTY_HOBO_HOME, ...env },
				now: () => NOW,
				fetch: fakeReadApiFetch(readApi),
				commands: [CI_ACTIVITY_COMMAND],
			}),
		},
	});
	const result = await cli.run(["ci", "activity", ...args], { cwd });
	return { ...result, output: result.stdout + result.stderr };
}

/** A git checkout whose `.hobo/ci.json` names `relayOrigin`, with a subdirectory. */
async function configuredCheckout(relayOrigin: string) {
	const root = await temporaryDirectory("hobo-ci-activity-checkout-");
	execFileSync("git", ["init", "-q", root]);
	const policy = JSON.parse(
		toJsonString(
			DesiredCiPolicySchema,
			defineCiPolicy({
				accountId: ACCOUNT,
				tenantId: ACCOUNT,
				pool: { label: "hobo", os: "linux", architecture: "x64" },
				providers: [
					{
						id: "gh",
						kind: "github",
						connectionRef: "gh",
						runsOn: "ubuntu-24.04",
					},
				],
				budget: {
					scope: "ci-account",
					currency: "USD",
					period: "manual",
					timeZone: "UTC",
					limitMicros: 1,
				},
				routing: {
					strategy: "lowest-total-incremental-cost",
					noEligibleProvider: "queue",
					unknownAllocation: "zero",
				},
				thresholds: [],
			}),
		),
	);
	await mkdir(join(root, ".hobo"), { recursive: true });
	await writeFile(
		join(root, ".hobo", "ci.json"),
		JSON.stringify({
			defaultEnvironment: "production",
			environments: {
				production: {
					relayOrigin,
					jobAdmission: "push",
					engines: ["gh-actions"],
					policy,
				},
			},
		}),
	);
	const subdirectory = join(root, "packages", "app");
	await mkdir(subdirectory, { recursive: true });
	return { root, subdirectory };
}

async function runJson(readApi: FakeReadApi, args: readonly string[]) {
	const result = await run(readApi, [...args, "--json"]);
	return { ...result, envelope: JSON.parse(result.stdout) };
}

async function journalOf(events: readonly RunnerRouteEvent[]) {
	const journal = new InMemoryRouteJournal();
	for (const event of events) await journal.record(event);
	return journal;
}

describe("hobo ci activity", () => {
	it("is wired into the hobo ci command table", () => {
		expect(CI_COMMANDS.map((command) => command.name)).toContain("activity");
	});

	it("lists each relay job newest first with where it ran, why, and every step passed over", async () => {
		const journal = await journalOf([
			requested(NOW - 2 * DAY - 1000, "job-1"),
			decided({
				atMs: NOW - 2 * DAY,
				jobId: "job-1",
				runner: "depot-ubuntu-24.04",
				step: "depot",
				skipped: [
					{ key: "machine", reason: "machine_paused" },
					{ key: "fleet", reason: "fleet_full", detail: "8 of 8 busy" },
				],
			}),
			decided({ atMs: NOW - DAY, jobId: "job-2", runId: 2 }),
		]);
		const result = await run(api({ journal }), []);
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.split("\n");
		const second = lines.findIndex((line) => line.includes("run 2/1"));
		const first = lines.findIndex((line) => line.includes("run 1/1"));
		expect(second).toBeGreaterThan(0);
		expect(first).toBeGreaterThan(second);
		expect(result.stdout).toContain("ran on depot-ubuntu-24.04 (depot)");
		expect(result.stdout).toContain("Routed to depot-ubuntu-24.04 (depot).");
		expect(result.stdout).toContain("passed over machine:");
		expect(result.stdout).toContain("passed over fleet:");
		expect(result.stdout).toContain("8 of 8 busy");
	});

	it("filters by the step that took the job, outcome, machine and repository", async () => {
		const journal = await journalOf([
			decided({
				atMs: NOW - 3 * DAY,
				jobId: "a",
				runner: "depot-ubuntu-24.04",
				step: "depot",
			}),
			decided({ atMs: NOW - 2 * DAY, jobId: "b", runId: 2 }),
			decided({
				atMs: NOW - DAY,
				jobId: "c",
				runId: 3,
				outcome: "none",
				runner: "",
				step: "",
				reason: "No runner available. depot: over the spend limit.",
			}),
			decided({
				atMs: NOW - DAY,
				jobId: "d",
				runId: 4,
				runner: "hobo-machine-studio",
				step: "machine",
				machineId: "studio",
			}),
		]);
		const readApi = api({ journal });
		const depot = await runJson(readApi, ["--runner", "depot"]);
		expect(
			depot.envelope.data.entries.map(
				(entry: { jobId: string }) => entry.jobId,
			),
		).toEqual(["a"]);
		const none = await runJson(readApi, ["--outcome", "none"]);
		expect(none.envelope.data.entries).toHaveLength(1);
		expect(none.envelope.data.entries[0].why).toContain("spend limit");
		const machine = await runJson(readApi, ["--machine", "studio"]);
		expect(
			machine.envelope.data.entries.map(
				(entry: { jobId: string }) => entry.jobId,
			),
		).toEqual(["d"]);
		await runJson(readApi, ["--repo", "octo/app"]);
		expect(readApi.asked.at(-1)).toContain("repository=octo%2Fapp");
	});

	it("shows nothing older than the journal keeps (90 days)", async () => {
		const db = new DatabaseSync(":memory:");
		let clock = NOW - 100 * DAY;
		const journal = new SqliteRouteJournal(db, { nowMs: () => clock });
		for (let day = 100; day >= 1; day -= 1) {
			clock = NOW - day * DAY;
			await journal.record(
				decided({
					atMs: clock,
					jobId: `job-${day}`,
					runId: day,
					runner: "depot-ubuntu-24.04",
					step: "depot",
				}),
			);
		}
		clock = NOW;
		journal.prune();
		const result = await runJson(api({ journal }), [
			"--since",
			"90d",
			"--runner",
			"depot",
			"--limit",
			"500",
		]);
		const entries: { atMs: number }[] = result.envelope.data.entries;
		expect(entries).toHaveLength(90);
		expect(entries.every((entry) => entry.atMs >= NOW - 90 * DAY)).toBe(true);
	});

	it("stops at the read API's depth and says the read was cut short", async () => {
		const events: RunnerRouteEvent[] = [];
		for (let index = 0; index < 1100; index += 1)
			events.push(
				decided({
					atMs: NOW - index * 60_000,
					jobId: `j${index}`,
					runId: index,
				}),
			);
		const readApi = api({ journal: await journalOf(events) });
		const result = await runJson(readApi, ["--limit", "500"]);
		expect(result.envelope.data.truncated).toBe(true);
		expect(
			readApi.asked.filter((path) =>
				path.startsWith("/v1/accounts/self/routes"),
			),
		).toHaveLength(5);
		const text = await run(readApi, ["--limit", "1"]);
		expect(text.stdout).toContain("Only the newest 1000 journal entries");
	});

	it("finds the relay in .hobo/ci.json from a subdirectory of the checkout", async () => {
		const { subdirectory } = await configuredCheckout(FAKE_RELAY_ORIGIN);
		const result = await run(
			api({ journal: await journalOf([decided({ atMs: NOW, jobId: "j1" })]) }),
			["--json"],
			{ HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN },
			subdirectory,
		);
		expect(result.exitCode, result.output).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.relay).toBe(FAKE_RELAY_ORIGIN);
		expect(envelope.data.entries).toHaveLength(1);
	});

	it("prefers .hobo/ci.json to HOBO_CI_RELAY_URL, as hobo ci status does", async () => {
		const { subdirectory } = await configuredCheckout(FAKE_RELAY_ORIGIN);
		const result = await run(
			api(),
			["--json"],
			{
				HOBO_CI_RELAY_URL: "https://elsewhere.example.test",
				HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN,
			},
			subdirectory,
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(result.stdout).data.relay).toBe(FAKE_RELAY_ORIGIN);
	});

	it("falls back to the link hobo ci setup saved for the checkout", async () => {
		const root = await temporaryDirectory("hobo-ci-activity-linked-");
		execFileSync("git", ["init", "-q", root]);
		const home = await temporaryDirectory("hobo-ci-activity-home-");
		await mkdir(join(home, "ci", "links"), { recursive: true });
		await writeFile(
			join(
				home,
				"ci",
				"links",
				`${createHash("sha256").update(root).digest("hex")}.json`,
			),
			JSON.stringify({
				relayOrigin: FAKE_RELAY_ORIGIN,
				accountId: ACCOUNT,
				repository: "octo/app",
			}),
		);
		const env = { HOBO_HOME: home, HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN };
		const linked = await run(
			api(),
			["--repo", "octo/app", "--json"],
			env,
			root,
		);
		expect(linked.exitCode, linked.output).toBe(0);
		expect(JSON.parse(linked.stdout).data.relay).toBe(FAKE_RELAY_ORIGIN);
		const other = await run(api(), ["--repo", "octo/other"], env, root);
		expect(other.exitCode).not.toBe(0);
		expect(other.output).toContain("--relay");
	});

	it("reports a token file it cannot read as a missing credential", async () => {
		const result = await run(api(), ["--json"], {
			HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN,
			HOBO_CI_ACCOUNT_TOKEN_FILE: join(tmpdir(), "hobo-ci-no-such-token"),
		});
		expect(result.exitCode).not.toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.code).toBe("HOBO_CI_AUTH_REQUIRED");
		expect(envelope.message).toContain("hobo-ci-no-such-token");
	});

	it("pages newest first and resumes from the printed cursor", async () => {
		const journal = await journalOf([
			decided({ atMs: NOW - 3 * DAY, jobId: "a", runId: 1 }),
			decided({ atMs: NOW - 2 * DAY, jobId: "b", runId: 2 }),
			decided({ atMs: NOW - DAY, jobId: "c", runId: 3 }),
		]);
		const readApi = api({ journal });
		const first = await runJson(readApi, ["--limit", "2"]);
		expect(
			first.envelope.data.entries.map(
				(entry: { jobId: string }) => entry.jobId,
			),
		).toEqual(["c", "b"]);
		const next: string = first.envelope.data.next;
		expect(next).toBeTruthy();
		const second = await runJson(readApi, ["--limit", "2", "--cursor", next]);
		expect(
			second.envelope.data.entries.map(
				(entry: { jobId: string }) => entry.jobId,
			),
		).toEqual(["a"]);
		expect(second.envelope.data.next).toBeNull();
		const text = await run(readApi, ["--limit", "2"]);
		expect(text.stdout).toContain(`--cursor ${next}`);
	});

	it("reads the journal page by page", async () => {
		const events: RunnerRouteEvent[] = [];
		for (let index = 0; index < 450; index += 1)
			events.push(
				decided({
					atMs: NOW - index * 60_000,
					jobId: `j${index}`,
					runId: index,
				}),
			);
		const readApi = api({ journal: await journalOf(events) });
		const result = await runJson(readApi, ["--limit", "500"]);
		expect(result.envelope.data.entries).toHaveLength(450);
		expect(result.envelope.data.truncated).toBe(false);
		expect(
			readApi.asked.filter((path) =>
				path.startsWith("/v1/accounts/self/routes"),
			),
		).toHaveLength(3);
	});

	it("says a job asked and not yet answered is pending", async () => {
		const journal = await journalOf([requested(NOW - 60_000, "job-9")]);
		const result = await runJson(api({ journal }), []);
		expect(result.envelope.data.entries[0].outcome).toBe("pending");
	});

	it("says so when the relay keeps no journal, and never guesses from GitHub", async () => {
		const result = await runJson(api({ journal: undefined }), []);
		expect(result.exitCode).not.toBe(0);
		expect(result.envelope.code).toBe("HOBO_CI_NOT_STORED_HERE");
		expect(result.envelope.message).toContain("no route journal");
	});

	it("needs a relay and a credential, and reports a refused credential", async () => {
		const readApi = api();
		const noRelay = await run(readApi, [], {});
		expect(noRelay.exitCode).not.toBe(0);
		expect(noRelay.output).toContain("--relay");
		const noToken = await run(readApi, [], {
			HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN,
		});
		expect(noToken.output).toContain("HOBO_CI_ACCOUNT_TOKEN");
		const refused = await run(readApi, ["--json"], {
			HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN,
			HOBO_CI_ACCOUNT_TOKEN: "wrong",
		});
		expect(JSON.parse(refused.stdout).code).toBe("HOBO_CI_AUTH_REQUIRED");
		const unreachable = await run(readApi, ["--json"], {
			HOBO_CI_RELAY_URL: "https://elsewhere.example.test",
			HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN,
		});
		expect(JSON.parse(unreachable.stdout).code).toBe("HOBO_CI_RELAY_ERROR");
		const plain = await run(readApi, [], {
			HOBO_CI_RELAY_URL: "http://relay.example.test",
			HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN,
		});
		expect(plain.output).toContain("HTTPS relay origin");
	});

	it("rejects options it does not take", async () => {
		const readApi = api();
		for (const args of [
			["--outcome", "lost"],
			["--since", "yesterday"],
			["--limit", "0"],
			["--cursor", "nope"],
			["--bogus"],
		]) {
			const result = await run(readApi, args);
			expect(result.exitCode, args.join(" ")).not.toBe(0);
		}
		expect(readApi.asked).toEqual([]);
	});
});

describe("activity helpers", () => {
	it("reads relative and absolute start times", () => {
		expect(parseSince("90d", NOW)).toBe(NOW - 90 * DAY);
		expect(parseSince("12h", NOW)).toBe(NOW - 12 * 3_600_000);
		expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000);
		expect(parseSince("2025-11-01", NOW)).toBe(Date.parse("2025-11-01"));
		expect(parseSince("soon", NOW)).toBeUndefined();
	});

	it("round-trips a page cursor", () => {
		const cursor = { atMs: NOW, key: "octo/app#1#1#route" };
		expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
		expect(decodeActivityCursor("nope")).toBeUndefined();
	});
});
