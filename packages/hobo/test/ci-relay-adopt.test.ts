// `hobo ci deploy --adopt`: the token-free relay mode. Offline: GitHub's
// Deployments API answers with recorded shapes from a fake transport, the
// probes are a fake transport, the clock is injected and the journal is a
// temporary SQLite file.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHoboCli } from "@hobo/cli";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import {
	RELAY_ADOPT_CREDENTIAL_REF,
	RELAY_ADOPT_REFUSAL,
	runCiRelayAdopt,
} from "../src/ci-relay-adopt.js";
import { RELAY_DELIVERY_REFUSAL } from "../src/ci-relay-delivery.js";
import type { JsonValue } from "../src/json.js";

const RELAY_DIR = resolve(import.meta.dirname, "../../ci-vercel");
const SHA = "c".repeat(40);
const OTHER = "d".repeat(40);
const TOKEN = "ghs_adopt-test-token";
const URL_OF_DEPLOYMENT = "https://hobo-ci-git-abc123.vercel.app";
const DEPLOYMENTS = "https://api.github.com/repos/Hobo-Labs/HoBo/deployments";

const homes: string[] = [];
afterAll(async () => {
	await Promise.all(
		homes.map((home) => rm(home, { recursive: true, force: true })),
	);
});

type GitHubFake = Readonly<{
	/** Listings answered in turn; the last repeats. */
	listings?: readonly JsonValue[];
	/** Statuses answered in turn for deployment 701; the last repeats. */
	statuses?: readonly JsonValue[];
	/** The commit `GET /deployments/701` reports. */
	commit?: string;
}>;

type Harness = Readonly<{
	home: string;
	github: TransportRequest[];
	probed: string[];
	clock: { now: number };
	githubHttp: HttpTransport;
	probe: (status?: (url: string) => number) => HttpTransport;
}>;

const READY = [
	{
		state: "success",
		environment_url: URL_OF_DEPLOYMENT,
		target_url: "https://vercel.com/hobo-labs/hobo-ci/Fx9",
	},
	{ state: "pending", target_url: "https://vercel.com/hobo-labs/hobo-ci/Fx9" },
];

const LISTING = [
	{ id: 702, sha: SHA, environment: "Preview – hobo-ci" },
	{ id: 703, sha: SHA, environment: "Production – hobo-ci-relay" },
	{ id: 701, sha: SHA, environment: "Production – hobo-ci" },
];

async function harness(fake: GitHubFake = {}): Promise<Harness> {
	const home = await mkdtemp(join(tmpdir(), "relay-adopt-"));
	homes.push(home);
	const github: TransportRequest[] = [];
	const probed: string[] = [];
	const listings = fake.listings ?? [LISTING];
	const statuses = fake.statuses ?? [READY];
	let listed = 0;
	let observed = 0;
	const json = (value: JsonValue) => ({
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});
	return {
		home,
		github,
		probed,
		clock: { now: Date.UTC(2026, 10, 12, 12) },
		githubHttp: async (request) => {
			github.push(request);
			const url = new URL(request.url);
			if (url.pathname.endsWith("/deployments")) {
				const answer = listings[Math.min(listed, listings.length - 1)];
				listed += 1;
				return json(answer);
			}
			if (url.pathname.endsWith("/deployments/701/statuses")) {
				const answer = statuses[Math.min(observed, statuses.length - 1)];
				observed += 1;
				return json(answer);
			}
			if (url.pathname.endsWith("/deployments/701"))
				return json({
					id: 701,
					sha: fake.commit ?? SHA,
					environment: "Production – hobo-ci",
				});
			return { status: 404, headers: {}, body: "{}" };
		},
		probe:
			(status = () => 200) =>
			async (request) => {
				probed.push(request.url);
				return { status: status(request.url), headers: {}, body: "{}" };
			},
	};
}

function adopt(
	h: Harness,
	overrides: Partial<Parameters<typeof runCiRelayAdopt>[0]> = {},
) {
	return runCiRelayAdopt({
		cwd: RELAY_DIR,
		values: { adopt: true, sha: SHA },
		env: { HOBO_USER: "relay-adopt-test", GITHUB_TOKEN: TOKEN },
		github: h.githubHttp,
		probe: h.probe(),
		home: h.home,
		now: () => h.clock.now,
		sleep: async (ms) => {
			h.clock.now += ms;
		},
		emitProgress: () => {},
		...overrides,
	});
}

function expectReadOnly(h: Harness) {
	expect(h.github.length).toBeGreaterThan(0);
	for (const request of h.github) {
		expect(request.method).toBe("GET");
		expect(request.url.startsWith(DEPLOYMENTS)).toBe(true);
		expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	}
}

describe("hobo ci deploy --adopt", () => {
	it("adopts Vercel's Git deployment of the commit and promotes it preview -> production, verifying its own URL", async () => {
		const h = await harness();
		const result = await adopt(h);
		expect(result.ok, result.message).not.toBe(false);
		expect(result.code).toBe("HOBO_CI_ADOPTED");
		// SAFETY: runCiRelayAdopt returns this shape (see ci-relay-adopt.ts data()).
		const data = result.data as {
			adopted: Record<string, string>;
			delivery: Record<string, { state: string; freightId: string }>;
		};
		expect(data.adopted).toEqual({
			deploymentId: "701",
			commit: SHA,
			url: URL_OF_DEPLOYMENT,
			readyState: "READY",
			inspectorUrl: "https://vercel.com/hobo-labs/hobo-ci/Fx9",
		});
		expect(data.delivery.preview?.state).toBe("PROMOTED");
		expect(data.delivery.production?.state).toBe("PROMOTED");
		expect(data.delivery.production?.freightId).toBe(
			data.delivery.preview?.freightId,
		);
		// The fail-closed probes, aimed at the adopted deployment.
		expect(h.probed).toContain(`${URL_OF_DEPLOYMENT}/healthz`);
		expect(h.probed).toContain(`${URL_OF_DEPLOYMENT}/readyz`);
		expect(h.probed.every((url) => url.startsWith(URL_OF_DEPLOYMENT))).toBe(
			true,
		);
		// Observe-only: every request a GET of this repository's deployments.
		expectReadOnly(h);
		expect(existsSync(join(h.home, "cd", "journal.sqlite"))).toBe(true);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	}, 120_000);

	it("waits for Vercel to report the deployment, and converges only once it is READY", async () => {
		const h = await harness({
			listings: [[], LISTING],
			statuses: [
				[{ state: "in_progress" }],
				[{ state: "in_progress", environment_url: URL_OF_DEPLOYMENT }],
				[{ state: "in_progress", environment_url: URL_OF_DEPLOYMENT }],
				READY,
			],
		});
		const result = await adopt(h);
		expect(result.ok, result.message).not.toBe(false);
		// SAFETY: runCiRelayAdopt returns this shape (see ci-relay-adopt.ts data()).
		const data = result.data as { adopted: Record<string, string> };
		expect(data.adopted.readyState).toBe("BUILDING");
		expectReadOnly(h);
	}, 120_000);

	it("needs the GitHub token its credentialRef names, and reads no Vercel token", async () => {
		const h = await harness();
		const result = await adopt(h, {
			env: { HOBO_USER: "relay-adopt-test", VERCEL_TOKEN: "vercel-secret" },
		});
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.authRequired);
		expect(result.message).toContain(RELAY_ADOPT_CREDENTIAL_REF);
		expect(h.github).toEqual([]);
	});

	it("takes only a full commit sha", async () => {
		const h = await harness();
		const result = await adopt(h, { values: { adopt: true, sha: "main" } });
		expect(result.code).toBe("HOBO_CLI_USAGE");
		expect(h.github).toEqual([]);
	});

	it("records nothing when Vercel reports no deployment of the commit in time", async () => {
		const h = await harness({ listings: [[]] });
		const result = await adopt(h);
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.notFound);
		expect(existsSync(join(h.home, "cd"))).toBe(false);
		expectReadOnly(h);
	});

	it("blocks a deployment that ended in error: never converged, never promoted", async () => {
		const h = await harness({
			statuses: [[{ state: "failure", environment_url: URL_OF_DEPLOYMENT }]],
		});
		const result = await adopt(h);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CI_DEPLOY_NOT_READY");
		expect(h.probed).toEqual([]);
		expectReadOnly(h);
	}, 120_000);

	it("blocks a deployment that does not serve the Freight's commit", async () => {
		const h = await harness({ commit: OTHER });
		const result = await adopt(h);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CI_DEPLOY_NOT_READY");
		expect(result.message).toContain("COMMIT_MISMATCH");
		expect(h.probed).toEqual([]);
	}, 120_000);

	it("records a production verification failure as the promotion's end and changes nothing on Vercel", async () => {
		const h = await harness();
		const result = await adopt(h, {
			probe: h.probe((url) => (url.endsWith("/readyz") ? 503 : 200)),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe(RELAY_DELIVERY_REFUSAL.verificationFailed);
		// SAFETY: runCiRelayAdopt returns this shape (see ci-relay-adopt.ts data()).
		const data = result.data as {
			delivery: Record<string, { state: string } | null>;
		};
		expect(data.delivery.preview?.state).toBe("PROMOTED");
		expect(["FAILED", "ROLLED_BACK"]).toContain(
			data.delivery.production?.state,
		);
		expect(result.message).toContain(
			"nothing was rolled back or changed on Vercel",
		);
		expectReadOnly(h);
	}, 120_000);
});

describe("hobo ci deploy --adopt through the ci verb", () => {
	const cli = createHoboCli({
		commands: { ci: createCiCommand({ env: { GITHUB_TOKEN: TOKEN } }) },
	});

	it("refuses a deploy option that would configure a deployment", async () => {
		const result = await cli.run(
			["ci", "deploy", "--adopt", "--sha", SHA, "--set", "A=b", "--json"],
			{ cwd: RELAY_DIR },
		);
		expect(result.exitCode).toBe(2);
		const body = JSON.parse(result.stdout);
		expect(body.code).toBe("HOBO_CLI_USAGE");
		expect(body.message).toContain(
			"--set does not apply to hobo ci deploy --adopt",
		);
	});

	it("refuses --adopt on any other ci command", async () => {
		const result = await cli.run(["ci", "status", "--adopt", "--json"], {
			cwd: RELAY_DIR,
		});
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).message).toContain(
			"--adopt only applies to hobo ci deploy",
		);
	});
});
