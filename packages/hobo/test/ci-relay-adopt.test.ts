// `hobo ci deploy --adopt`: the token-free relay mode. Offline: GitHub's
// Deployments API answers with recorded shapes from a fake transport, the
// probes are a fake transport (the production origin answers as the relay's
// entry does: `/healthz` names its build's commit, `/readyz` its state), the
// clock is injected and the journal is a temporary SQLite file.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CampId, CdContext, FreightId } from "@hobo/cd";
import { createHoboCli } from "@hobo/cli";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { afterAll, describe, expect, it } from "vitest";
import { loadDeliveryFile } from "../src/cd-delivery-module.js";
import { cdPrincipal } from "../src/cd-runtime.js";
import { createCiCommand } from "../src/ci-command.js";
import {
	RELAY_ADOPT_BUDGET,
	RELAY_ADOPT_CREDENTIAL_REF,
	RELAY_ADOPT_REFUSAL,
	relayAdoptDeadline,
	relayAdoptStages,
	runCiRelayAdopt,
} from "../src/ci-relay-adopt.js";
import {
	RELAY_DELIVERY_FILE,
	RELAY_DELIVERY_REFUSAL,
} from "../src/ci-relay-delivery.js";
import {
	adoptedDeploymentSuites,
	adoptedVerificationRecords,
	COMMIT_MISMATCH_STATUS,
	commitCheckingProbe,
	RELAY_ADOPT_VERIFICATION,
	RELAY_ADOPTED_DEPLOYMENT_SUITE,
	relayProductionOrigin,
} from "../src/ci-relay-verify.js";
import { isJsonObject, type JsonValue } from "../src/json.js";

const RELAY_DIR = resolve(import.meta.dirname, "../../ci-vercel");
const SHA = "c".repeat(40);
const OTHER = "d".repeat(40);
const TOKEN = "ghs_adopt-test-token";
const URL_OF_DEPLOYMENT = "https://hobo-ci-git-abc123.vercel.app";
// The Yard's productionOrigin (packages/ci-vercel/deploy/yard.ts).
const PRODUCTION = "https://hobo-ci.vercel.app";
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
	probe: (answer?: ProbeAnswer) => HttpTransport;
}>;

/** What the fake relay answers a probe: a status and a JSON body. */
type ProbeAnswer = (
	url: string,
) => Readonly<{ status: number; body?: JsonValue }>;

/** The relay at its production origin, serving `commit` and ready. */
const servingRelay =
	(commit: string = SHA): ProbeAnswer =>
	(url) => {
		// Every other origin is behind Deployment Protection.
		if (!url.startsWith(PRODUCTION)) return { status: 401 };
		if (url.endsWith("/healthz"))
			return { status: 200, body: { ok: true, commit } };
		return { status: 200, body: { ready: true } };
	};

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
			(answer = servingRelay()) =>
			async (request) => {
				probed.push(request.url);
				const { status, body } = answer(request.url);
				return {
					status,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body ?? {}),
				};
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
	it("adopts Vercel's Git deployment of the commit and promotes it preview -> production, verifying the production domain serves it", async () => {
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
		// The fail-closed probes, aimed at the production domain, never at the
		// protected per-deployment URL; preview is verified by its record.
		expect(h.probed).toContain(`${PRODUCTION}/healthz`);
		expect(h.probed).toContain(`${PRODUCTION}/readyz`);
		expect(h.probed.every((url) => url.startsWith(PRODUCTION))).toBe(true);
		expect(isJsonObject(result.data) && result.data.verifiedAt).toBe(
			PRODUCTION,
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
			probe: h.probe((url) =>
				url.endsWith("/readyz") ? { status: 503 } : servingRelay()(url),
			),
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

describe("hobo ci deploy --adopt verification without Deployment Protection", () => {
	it("probes HOBO_CI_RELAY_URL when it names an origin, else the Yard's productionOrigin", async () => {
		expect(
			relayProductionOrigin(
				{ HOBO_CI_RELAY_URL: "https://relay.example.test/" },
				PRODUCTION,
			),
		).toEqual({
			origin: "https://relay.example.test",
			from: "HOBO_CI_RELAY_URL",
		});
		expect(
			relayProductionOrigin(
				{ HOBO_CI_RELAY_URL: "http://plain.test" },
				PRODUCTION,
			)?.origin,
		).toBe(PRODUCTION);
		expect(
			relayProductionOrigin(
				{ HOBO_CI_RELAY_URL: "https://x.test/path" },
				undefined,
			),
		).toBeUndefined();
		expect(relayProductionOrigin({}, undefined)).toBeUndefined();

		const h = await harness();
		const other = "https://relay.example.test";
		const result = await adopt(h, {
			env: {
				HOBO_USER: "relay-adopt-test",
				GITHUB_TOKEN: TOKEN,
				HOBO_CI_RELAY_URL: other,
			},
			probe: h.probe((url) =>
				url.startsWith(other)
					? servingRelay()(url.replace(other, PRODUCTION))
					: { status: 401 },
			),
		});
		expect(result.ok, result.message).not.toBe(false);
		expect(h.probed.length).toBeGreaterThan(0);
		expect(h.probed.every((url) => url.startsWith(other))).toBe(true);
	}, 120_000);

	it("no longer consults the protected per-deployment URL: its 401 cannot fail or pass anything", async () => {
		const h = await harness();
		const result = await adopt(h, {
			probe: h.probe((url) =>
				url.startsWith(URL_OF_DEPLOYMENT)
					? { status: 401 }
					: servingRelay()(url),
			),
		});
		expect(result.ok, result.message).not.toBe(false);
		expect(h.probed.some((url) => url.startsWith(URL_OF_DEPLOYMENT))).toBe(
			false,
		);
	}, 120_000);

	it("fails production closed when the production domain serves another commit", async () => {
		const h = await harness();
		const result = await adopt(h, { probe: h.probe(servingRelay(OTHER)) });
		expect(result.ok).toBe(false);
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.commitMismatch);
		expect(result.message).toContain(OTHER);
		// SAFETY: runCiRelayAdopt returns this shape (see ci-relay-adopt.ts).
		const data = result.data as {
			delivery: Record<string, { state: string } | null>;
			verification: { code: string; remediation: string };
		};
		expect(data.delivery.preview?.state).toBe("PROMOTED");
		expect(["FAILED", "ROLLED_BACK"]).toContain(
			data.delivery.production?.state,
		);
		expect(data.verification.code).toBe(RELAY_ADOPT_REFUSAL.commitMismatch);
		expectReadOnly(h);
	}, 120_000);

	it("fails production closed when /healthz names no commit (a build from before it reported one)", async () => {
		const h = await harness();
		const result = await adopt(h, {
			probe: h.probe((url) =>
				url.endsWith("/healthz")
					? { status: 200, body: { ok: true } }
					: servingRelay()(url),
			),
		});
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.commitMismatch);
		expect(result.message).toContain("names no commit");
	}, 120_000);

	it("reports a relay whose /readyz says it is not configured as its own reason, with the remediation", async () => {
		const h = await harness();
		const result = await adopt(h, {
			probe: h.probe((url) =>
				url.endsWith("/readyz")
					? {
							status: 503,
							body: { ready: false, started: false, state: "not-configured" },
						}
					: servingRelay()(url),
			),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.relayNotConfigured);
		expect(result.message).toContain("deploy/secret-store.binding.json");
		expect(result.message).toContain("hobo ci app create --via-workflow");
	}, 120_000);

	it("reports a relay that started but is not ready by the parts that are not", async () => {
		const h = await harness();
		const result = await adopt(h, {
			probe: h.probe((url) =>
				url.endsWith("/readyz")
					? {
							status: 503,
							body: {
								ready: false,
								configService: true,
								configStale: false,
								cache: false,
								executionHost: true,
								workers: "starting",
							},
						}
					: servingRelay()(url),
			),
		});
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.relayNotReady);
		expect(result.message).toContain("not ready (cache)");
	}, 120_000);

	it("reads a /healthz for another commit as unhealthy, and passes every other request through", async () => {
		const seen: string[] = [];
		const { transport, findings } = commitCheckingProbe(
			async (request) => {
				seen.push(request.url);
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({ ok: true, commit: OTHER }),
				};
			},
			{ origin: PRODUCTION, commit: SHA },
		);
		const get = (url: string) =>
			transport({
				method: "GET",
				url,
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1000,
			});
		expect((await get(`${PRODUCTION}/healthz`)).status).toBe(
			COMMIT_MISMATCH_STATUS,
		);
		expect(findings().servedCommit).toBe(OTHER);
		expect((await get("https://elsewhere.test/healthz")).status).toBe(200);
		expect(seen).toHaveLength(2);
	});

	it("verifies preview by the deployment record: READY of the Freight's commit, nothing else", async () => {
		// SAFETY: test ids; the suite reads neither.
		const campId = "hobo-ci-relay/hobo-ci-relay/preview" as CampId;
		// SAFETY: as above.
		const freightId = "freight-1" as FreightId;
		const ctx: CdContext = {
			tenant: "t",
			principal: cdPrincipal({ HOBO_USER: "relay-adopt-test" }),
			now: () => 0,
		};
		const states = ["READY", "COMMIT_MISMATCH", "SUPERSEDED", "BUILDING"];
		const outcomes = [];
		for (const state of states) {
			const suites = adoptedDeploymentSuites({
				deploymentId: "701",
				commit: SHA,
				readyState: async () => state,
			});
			outcomes.push(
				await suites.run(
					{ suite: RELAY_ADOPTED_DEPLOYMENT_SUITE, campId, freightId },
					ctx,
				),
			);
		}
		expect(outcomes.map((outcome) => outcome.ok)).toEqual([
			true,
			false,
			false,
			false,
		]);
		const unknown = await adoptedDeploymentSuites({
			deploymentId: "701",
			commit: SHA,
			readyState: async () => "READY",
		}).run({ suite: "other", campId, freightId }, ctx);
		expect(unknown.ok).toBe(false);
	});
});

describe("hobo ci deploy --adopt within its time budget", () => {
	const MINUTE = 60_000;
	const BUILDING = [
		{ state: "in_progress", environment_url: URL_OF_DEPLOYMENT },
	];

	it("takes the earlier of --deadline and --budget, else the default, and refuses a malformed one", () => {
		const now = Date.UTC(2026, 10, 13, 12);
		const at = (deadline?: string, budget?: string) =>
			relayAdoptDeadline(now, { deadline, budget });
		expect(at()).toEqual({ ok: true, at: now + RELAY_ADOPT_BUDGET.defaultMs });
		expect(at(undefined, "9")).toEqual({ ok: true, at: now + 9 * MINUTE });
		expect(at("2026-11-13T12:17:00Z")).toEqual({
			ok: true,
			at: now + 17 * MINUTE,
		});
		expect(at("2026-11-13T12:17:00.000Z", "8")).toEqual({
			ok: true,
			at: now + 8 * MINUTE,
		});
		expect(at("2026-11-13T13:05:00+01:00")).toEqual({
			ok: true,
			at: now + 5 * MINUTE,
		});
		for (const deadline of ["tomorrow", "2026-11-13T12:17:00", "1700000000"])
			expect(at(deadline).ok).toBe(false);
		for (const budget of ["0", "-5", "1.5", "21", "ten"])
			expect(at(undefined, budget).ok).toBe(false);
		// No deadline lies past the ceiling, however far --deadline names.
		expect(at("2026-11-13T15:00:00Z")).toEqual({
			ok: true,
			at: now + RELAY_ADOPT_BUDGET.maxBudgetMinutes * MINUTE,
		});
	});

	it("splits the deadline across lookup, preview and production, and refuses one too short for all three", () => {
		const now = Date.UTC(2026, 10, 13, 12);
		expect(relayAdoptStages(now, now + 12 * MINUTE)).toEqual({
			lookupUntil: now + 7 * MINUTE,
			previewUntil: now + 9 * MINUTE,
			productionUntil: now + 12 * MINUTE,
		});
		const least =
			RELAY_ADOPT_BUDGET.lookupMinMs +
			RELAY_ADOPT_BUDGET.previewReserveMs +
			RELAY_ADOPT_BUDGET.productionReserveMs;
		expect(relayAdoptStages(now, now + least)).toBeDefined();
		expect(relayAdoptStages(now, now + least - 1)).toBeUndefined();
		// The reserves hold the adopted verification windows with room to spare.
		expect(RELAY_ADOPT_BUDGET.previewReserveMs).toBeGreaterThan(
			RELAY_ADOPT_VERIFICATION.progressDeadlineMs,
		);
		expect(RELAY_ADOPT_BUDGET.productionReserveMs).toBeGreaterThan(
			RELAY_ADOPT_VERIFICATION.progressDeadlineMs,
		);
		// A late build ends as the budget's refusal, never as a failed rollout.
		expect(RELAY_ADOPT_VERIFICATION.previewProgressDeadlineMs).toBeGreaterThan(
			RELAY_ADOPT_BUDGET.maxBudgetMinutes * MINUTE,
		);
	});

	it("gives each adopted node a short window that still requires every attempt to pass", async () => {
		const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
			cwd: RELAY_DIR,
		});
		if (!loaded.ok) throw new Error(loaded.message);
		const records = adoptedVerificationRecords(loaded.value, PRODUCTION);
		const nodes = records.pipelines.flatMap((pipeline) => pipeline.nodes);
		expect(nodes.map((node) => node.name).sort()).toEqual([
			"preview",
			"production",
		]);
		for (const node of nodes) {
			const spec = node.verification;
			expect(spec?.windowMs).toBe(BigInt(RELAY_ADOPT_VERIFICATION.windowMs));
			expect(spec?.progressDeadlineMs).toBe(
				BigInt(
					node.name === "production"
						? RELAY_ADOPT_VERIFICATION.progressDeadlineMs
						: RELAY_ADOPT_VERIFICATION.previewProgressDeadlineMs,
				),
			);
			expect(spec?.failOnNoData).toBe(true);
			for (const probe of spec?.probes ?? [])
				expect(probe.minSuccessRatio).toBe(1);
		}
	});

	it("refuses a deadline too close to hold every stage before reading anything", async () => {
		const h = await harness();
		const result = await adopt(h, {
			values: { adopt: true, sha: SHA, budget: "5" },
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.budgetExhausted);
		expect(h.github).toEqual([]);
		expect(existsSync(join(h.home, "cd"))).toBe(false);
	});

	it("looks for the deployment only for the lookup's share of the budget", async () => {
		const h = await harness({ listings: [[]] });
		const started = h.clock.now;
		const result = await adopt(h, {
			values: { adopt: true, sha: SHA, budget: "10" },
		});
		expect(result.code).toBe(RELAY_ADOPT_REFUSAL.notFound);
		expect(result.message).toContain("re-run");
		// 10 minutes less both reserves: the lookup gave up at 5 minutes.
		expect(h.clock.now - started).toBeLessThanOrEqual(5 * MINUTE);
		expect(h.clock.now - started).toBeGreaterThanOrEqual(5 * MINUTE - 10_000);
	});

	it("ends NOT_READY_IN_BUDGET by its deadline when the build is not READY in time, and a re-run adopts it", async () => {
		const h = await harness({ statuses: [BUILDING] });
		const started = h.clock.now;
		const result = await adopt(h, {
			values: { adopt: true, sha: SHA, budget: "8" },
		});
		expect(result.ok).toBe(false);
		expect(result.code, result.message).toBe(
			RELAY_ADOPT_REFUSAL.notReadyInBudget,
		);
		expect(result.message).toContain("BUILDING");
		expect(result.message).toContain("re-run");
		expect(result.message).toContain("Nothing was changed on Vercel");
		// Preview's share ended 3 minutes before the deadline; production never ran.
		expect(h.clock.now - started).toBeLessThanOrEqual(5 * MINUTE + 10_000);
		expect(h.probed).toEqual([]);
		expectReadOnly(h);

		// The next run of the same commit, once Vercel reports it READY.
		const rerun = await harness();
		const adopted = await adopt(rerun, { home: h.home });
		expect(adopted.ok, adopted.message).not.toBe(false);
		expect(adopted.code).toBe("HOBO_CI_ADOPTED");
	}, 120_000);

	it("ends BUDGET_EXHAUSTED when the build turns READY too late to verify within preview's share", async () => {
		const h = await harness();
		const started = h.clock.now;
		// budget 8: preview's share ends at 5 minutes; READY comes 15 s before.
		const readyAt = started + 5 * MINUTE - 15_000;
		const result = await adopt(h, {
			values: { adopt: true, sha: SHA, budget: "8" },
			github: async (request) => {
				const building =
					new URL(request.url).pathname.endsWith("/701/statuses") &&
					h.clock.now < readyAt;
				if (!building) return h.githubHttp(request);
				h.github.push(request);
				return {
					status: 200,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(BUILDING),
				};
			},
		});
		expect(result.ok).toBe(false);
		expect(result.code, result.message).toBe(
			RELAY_ADOPT_REFUSAL.budgetExhausted,
		);
		expect(result.message).toContain("preview");
		expect(result.message).toContain("re-run");
		// SAFETY: runCiRelayAdopt returns this shape (see ci-relay-adopt.ts).
		const data = result.data as { budget: { node: string } };
		expect(data.budget.node).toBe("preview");
		expect(h.clock.now - started).toBeLessThanOrEqual(5 * MINUTE + 10_000);
		expect(h.probed).toEqual([]);
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

	it("takes --deadline and --budget, and refuses a malformed one as usage", async () => {
		const result = await cli.run(
			["ci", "deploy", "--adopt", "--sha", SHA, "--budget", "soon", "--json"],
			{ cwd: RELAY_DIR },
		);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).message).toContain(
			"--budget takes whole minutes",
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
