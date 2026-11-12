import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { meshIdentityFromPem } from "@hobo/ci/mesh";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
	createMemoryFleetVerdicts,
	type FleetVerdictSettings,
	parseFleetReporters,
	parseFleetVerdictReport,
} from "../src/fleet-verdict.js";
import {
	FLEET_VERDICT_HEADERS,
	verifyFleetVerdictReport,
} from "../src/fleet-verdict-auth.js";
import { HostedRelay } from "../src/hosted-relay.js";
import type { FleetVerdictEvaluation } from "../src/isolated-worker/fleet-verdict-evaluator.js";
import {
	createFleetVerdictReporter,
	type FleetVerdictReporterOptions,
	parseFleetVerdictReporterSettings,
} from "../src/isolated-worker/fleet-verdict-reporter.js";
import { createFleetVerdictSequence } from "../src/isolated-worker/fleet-verdict-state.js";
import { LeaseStore } from "../src/store.js";
import { controlHttp, strictGithub } from "./fixtures/control-api-github.js";
import {
	BOX_1_KEY_PEM,
	BOX_1_PUBLIC_KEY,
} from "./fixtures/fleet-reporter-keys.js";

/** The fleet verdict reporter (plan 0025, 6.2 and 6.3). */
const T0 = Date.parse("2026-11-12T11:14:00.000Z");
const ORIGIN = "https://ci.hobo.test";
const identity = meshIdentityFromPem(BOX_1_KEY_PEM);

function evaluation(blocked: readonly string[]): FleetVerdictEvaluation {
	return {
		refused: blocked.length > 0,
		labels: new Map(
			["hobo", "hobo-trunk"].map((label) => [
				label,
				blocked.includes(label)
					? { blocked: true, reasons: ["memory"] as const }
					: { blocked: false, reasons: ["admits"] as const },
			]),
		),
		blocked: new Map(blocked.map((label) => [label, "no-capacity"] as const)),
		unaccounted: [],
	};
}

function stateFile() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-fleet-reporter-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	return join(directory, "fleet-verdict-state.json");
}

/** What the box's evaluation says is blocked; the test changes it. */
type BoxState = { blocked: readonly string[] };

type Sent = {
	url: string;
	headers: Record<string, string>;
	body: string;
};

/** A reporter on an injected clock whose `fetch` records and answers as told. */
function harness(
	overrides: Partial<FleetVerdictReporterOptions> = {},
	answer: (request: Sent) => Promise<Response> = async () =>
		new Response("{}", { status: 200 }),
) {
	const clock = { now: T0 };
	const box: BoxState = { blocked: [] };
	const sent: Sent[] = [];
	const logs: Readonly<Record<string, string | number | boolean>>[] = [];
	const reporter = createFleetVerdictReporter({
		mode: "report",
		reporterId: "box-1",
		origin: ORIGIN,
		identity,
		labels: ["hobo", "hobo-trunk"],
		evaluate: () => evaluation(box.blocked),
		repositories: async () => ["Hobo-Labs/HoBo"],
		sequence: createFleetVerdictSequence(stateFile()),
		now: () => clock.now,
		log: (event, fields) => logs.push({ event, ...fields }),
		fetch: async (url, init) => {
			const request: Sent = {
				url: String(url),
				headers: z.record(z.string(), z.string()).parse(init?.headers),
				body: z.string().parse(init?.body),
			};
			sent.push(request);
			return answer(request);
		},
		...overrides,
	});
	/** One sample per 10 s for `seconds`. */
	const run = async (seconds: number) => {
		for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
			await reporter.sample();
			clock.now += 10_000;
		}
	};
	return { clock, box, sent, logs, reporter, run };
}

const blockedIn = (request: Sent | undefined) =>
	request === undefined
		? undefined
		: [...(parseFleetVerdictReport(request.body)?.blocked.keys() ?? [])];

describe("the fleet verdict reporter", () => {
	it("signs one report per connected repository with the relay's origin and its own key", async () => {
		const h = harness({
			repositories: async () => ["Hobo-Labs/HoBo", "acme/app"],
		});
		await h.reporter.sample();
		expect(h.sent.map((request) => request.url)).toEqual([
			"https://ci.hobo.test/v1/fleet/verdicts/hobo-labs/hobo",
			"https://ci.hobo.test/v1/fleet/verdicts/acme/app",
		]);
		for (const request of h.sent) {
			const path = new URL(request.url).pathname;
			expect(
				verifyFleetVerdictReport(
					BOX_1_PUBLIC_KEY,
					{
						origin: ORIGIN,
						path,
						body: request.body,
						issuedAt: request.headers[FLEET_VERDICT_HEADERS.issuedAt] ?? "",
						sequence: request.headers[FLEET_VERDICT_HEADERS.sequence] ?? "",
					},
					request.headers[FLEET_VERDICT_HEADERS.signature] ?? "",
				),
			).toBe(true);
			expect(request.headers[FLEET_VERDICT_HEADERS.reporter]).toBe("box-1");
			expect(JSON.parse(request.body)).toEqual({
				ttlSeconds: 180,
				mode: "report",
			});
		}
		// Sequences only rise, across repositories too.
		const sequences = h.sent.map((request) =>
			BigInt(request.headers[FLEET_VERDICT_HEADERS.sequence] ?? "0"),
		);
		expect(sequences[1]).toBeGreaterThan(sequences[0] ?? 0n);
	});

	it("reports what it holds, not what one sample says, and sends at once on a change", async () => {
		const h = harness({ resendMs: 600_000 });
		await h.run(30);
		expect(h.sent).toHaveLength(1);
		h.box.blocked = ["hobo"];
		await h.run(60);
		// Six blocked samples are not yet a minute: nothing changes, nothing sent.
		expect(h.sent).toHaveLength(1);
		await h.run(10);
		expect(h.sent).toHaveLength(2);
		expect(blockedIn(h.sent.at(-1))).toEqual(["hobo"]);
		expect(h.logs.at(-1)).toMatchObject({
			event: "hobo_ci_fleet_verdict_state",
			changed: true,
			blocked: "hobo",
			sent: "sent",
		});
	});

	it("reports every 60 s when nothing changes, nothing blocked included", async () => {
		const h = harness();
		await h.run(180);
		expect(h.sent.map(blockedIn)).toEqual([[], [], []]);
	});

	it("tries again at the next sample", async () => {
		let failing = false;
		const h = harness({}, async () =>
			failing
				? new Response("{}", { status: 503 })
				: new Response("{}", { status: 200 }),
		);
		await h.run(10);
		h.box.blocked = ["hobo"];
		failing = true;
		// Held blocked at 70 s; that send fails, and so does the next sample's.
		await h.run(80);
		const changeAttempts = h.sent.filter(
			(request) => blockedIn(request)?.join() === "hobo",
		).length;
		expect(changeAttempts).toBe(2);
		failing = false;
		await h.run(10);
		expect(blockedIn(h.sent.at(-1))).toEqual(["hobo"]);
		const sentBefore = h.sent.length;
		// Sent: the next routine report waits for the 60 s mark.
		await h.run(50);
		expect(h.sent).toHaveLength(sentBefore);
	});

	it("tries again at the next 60 s mark after a routine report fails, and a thrown fetch is a failure", async () => {
		const h = harness({}, async () => {
			throw new TypeError("fetch failed");
		});
		await h.run(10);
		expect(h.sent).toHaveLength(1);
		await h.run(50);
		expect(h.sent).toHaveLength(1);
		await h.run(10);
		expect(h.sent).toHaveLength(2);
		expect(h.logs.at(-1)).toMatchObject({ sent: "failed" });
	});

	it("logs its state on every change and at most once per 5 minutes otherwise, failed sends included", async () => {
		const h = harness({}, async () => new Response("{}", { status: 503 }));
		// Samples from 0 to 290 s: one line, at the start.
		await h.run(300);
		const states = () =>
			h.logs.filter((entry) => entry.event === "hobo_ci_fleet_verdict_state");
		expect(states()).toHaveLength(1);
		await h.run(10);
		expect(states()).toHaveLength(2);
		h.box.blocked = ["hobo"];
		await h.run(70);
		expect(states().at(-1)).toMatchObject({ changed: true, blocked: "hobo" });
		expect(states()).toHaveLength(3);
	});

	it("reports in shadow mode what it would block, marked shadow", async () => {
		const h = harness({ mode: "shadow" });
		h.box.blocked = ["hobo-trunk"];
		await h.run(70);
		expect(JSON.parse(h.sent.at(-1)?.body ?? "{}")).toEqual({
			blocked: { "hobo-trunk": { reason: "no-capacity" } },
			ttlSeconds: 180,
			mode: "shadow",
		});
	});

	it("clears on drain", async () => {
		const h = harness();
		h.box.blocked = ["hobo", "hobo-trunk"];
		await h.run(70);
		expect(blockedIn(h.sent.at(-1))).toEqual(["hobo", "hobo-trunk"]);
		await h.reporter.clear();
		expect(blockedIn(h.sent.at(-1))).toEqual([]);
		// Stopped: no sample reports again.
		const count = h.sent.length;
		await h.reporter.sample();
		expect(h.sent).toHaveLength(count);
		expect(h.logs.at(-1)).toMatchObject({ status: "cleared", sent: "sent" });
	});

	it("never reuses a sequence, even if the clock steps back", async () => {
		const file = stateFile();
		const sequences: bigint[] = [];
		const make = (nowMs: number) => {
			const h = harness({ sequence: createFleetVerdictSequence(file) });
			h.clock.now = nowMs;
			return h;
		};
		const first = make(T0);
		await first.run(120);
		await first.reporter.clear();
		// Restarted with its clock ten minutes behind.
		const second = make(T0 - 600_000);
		await second.run(120);
		for (const request of [...first.sent, ...second.sent])
			sequences.push(
				BigInt(request.headers[FLEET_VERDICT_HEADERS.sequence] ?? "0"),
			);
		for (let index = 1; index < sequences.length; index++)
			expect(sequences[index]).toBeGreaterThan(sequences[index - 1] ?? 0n);
		expect(BigInt(JSON.parse(readFileSync(file, "utf8")).lastSequence)).toBe(
			sequences.at(-1),
		);
	});

	it("sends nothing when the evaluator throws, and logs it", async () => {
		const h = harness({
			evaluate: () => {
				throw new Error("sample unreadable");
			},
		});
		await h.run(30);
		expect(h.sent).toEqual([]);
		expect(h.logs.at(-1)).toMatchObject({
			status: "evaluation-failed",
			message: "sample unreadable",
		});
	});

	it("logs an unaccounted runner once per prefix per hour", async () => {
		const runners = [
			"hobo-runner-set-x-runner-a",
			"hobo-runner-set-x-runner-b",
		];
		const h = harness({
			evaluate: () => ({ ...evaluation([]), unaccounted: runners }),
		});
		await h.run(60);
		h.clock.now += 3_600_000;
		await h.run(10);
		expect(
			h.logs.filter(
				(entry) => entry.event === "hobo_ci_fleet_verdict_unaccounted_runner",
			),
		).toEqual([
			{
				event: "hobo_ci_fleet_verdict_unaccounted_runner",
				prefix: "hobo-runner-set-x-runner-",
				runner: "hobo-runner-set-x-runner-a",
			},
			{
				event: "hobo_ci_fleet_verdict_unaccounted_runner",
				prefix: "hobo-runner-set-x-runner-",
				runner: "hobo-runner-set-x-runner-a",
			},
		]);
	});

	it("a hanging send does not delay a dispatch tick", async () => {
		const hung: Promise<Response>[] = [];
		const reporter = createFleetVerdictReporter({
			mode: "report",
			reporterId: "box-1",
			origin: ORIGIN,
			identity,
			labels: ["hobo"],
			evaluate: () => evaluation(["hobo"]),
			repositories: async () => ["Hobo-Labs/HoBo", "acme/app"],
			sequence: createFleetVerdictSequence(stateFile()),
			// Never answers, and ignores the abort.
			fetch: () => {
				const never = new Promise<Response>(() => undefined);
				hung.push(never);
				return never;
			},
			sampleMs: 20,
			sendTimeoutMs: 1_000,
		});
		// A dispatch loop on its own timer, as the daemon's tick is.
		const intervalMs = 10;
		let last = performance.now();
		let worstLateMs = 0;
		let ticks = 0;
		const dispatch = setInterval(() => {
			const at = performance.now();
			worstLateMs = Math.max(worstLateMs, at - last - intervalMs);
			last = at;
			ticks++;
		}, intervalMs);
		reporter.start();
		await new Promise((resolve) => setTimeout(resolve, 400));
		clearInterval(dispatch);
		await reporter.clear().catch(() => undefined);
		expect(hung.length).toBeGreaterThanOrEqual(1);
		// One sample is in flight; the others were skipped, not queued.
		expect(hung.length).toBeLessThanOrEqual(4);
		expect(ticks).toBeGreaterThan(10);
		// B3: no dispatch tick delayed by more than 50 ms.
		expect(worstLateMs).toBeLessThan(50);
		console.info(
			JSON.stringify({ outcome: "B3", worstDispatchLateMs: worstLateMs }),
		);
	}, 10_000);
});

describe("the reporter against the hosted relay's handler (B1, B2)", () => {
	it("serves a block within 75 s of the first blocked sample and a clear within 45 s of the first clear one", async () => {
		const pact = z
			.object({
				metadata: z.object({
					consumerFixtures: z.object({
						publicOrigin: z.string(),
						reporters: z.json(),
						configuration: z.json(),
					}),
				}),
			})
			.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../contracts/fleet-verdict-boundary.pact.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			).metadata.consumerFixtures;
		expect(pact.publicOrigin).toBe(ORIGIN);
		const reporters = parseFleetReporters(JSON.stringify(pact.reporters));
		if (!reporters) throw new Error("the Pact's enrollment is not one");
		// box-1 alone serves hobo-trunk, so its reports alone decide it.
		const settings: FleetVerdictSettings = {
			reporters,
			serving: true,
			dailyBlockMinutes: 240,
		};
		const configuration = fromJsonString(
			ConfigurationSchema,
			JSON.stringify(pact.configuration),
		);
		// One clock for the box and the relay: the relay checks issued-at
		// against its own, and expires entries by it.
		const clock = { now: T0 };
		const directory = mkdtempSync(join(tmpdir(), "hobo-fleet-b1-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const file = join(directory, "relay.sqlite");
		const ledger = new SqliteCiStore(file);
		const store = new LeaseStore(file);
		const relay = new HostedRelay({
			config: configuration,
			store: ledger,
			github: strictGithub([]).github,
			identity: {
				verify: async () => {
					throw new Error("unexpected runner identity request");
				},
			},
			webhookSecret: "fleet-b1-webhook-secret-at-least-32-characters",
			now: () => new Date(clock.now).toISOString(),
		});
		const h = await controlHttp({
			github: strictGithub([]).github,
			configuration,
			relay: { relay, ledger, store },
			fleetVerdicts: {
				store: createMemoryFleetVerdicts(() => clock.now),
				settings: () => settings,
			},
		});
		onTestFinished(() => h.stop());
		const box: BoxState = { blocked: [] };
		let sendWallMs = 0;
		const reporter = createFleetVerdictReporter({
			mode: "report",
			reporterId: "box-1",
			origin: ORIGIN,
			identity,
			labels: ["hobo", "hobo-trunk"],
			evaluate: () => evaluation(box.blocked),
			repositories: async () => ["Hobo-Labs/HoBo"],
			sequence: createFleetVerdictSequence(join(directory, "state.json")),
			now: () => clock.now,
			// The relay is served on loopback; the report is signed for its public origin.
			fetch: async (url, init) => {
				const started = performance.now();
				const response = await fetch(String(url).replace(ORIGIN, h.base), init);
				sendWallMs = Math.max(sendWallMs, performance.now() - started);
				return response;
			},
		});
		const served = async () =>
			Object.keys(
				z
					.object({ blocked: z.record(z.string(), z.unknown()) })
					.parse(
						await (
							await fetch(`${h.base}/v1/fleet/verdicts/hobo-labs/hobo`)
						).json(),
					).blocked,
			);
		/** Samples every 10 s until `until` holds of what is served; the time it took. */
		const sampleUntil = async (until: (labels: string[]) => boolean) => {
			const from = clock.now;
			for (let step = 0; step < 30; step++) {
				await reporter.sample();
				if (until(await served())) return clock.now - from;
				clock.now += 10_000;
			}
			throw new Error("never served");
		};
		// A clear box reports, and nothing is served.
		await sampleUntil(() => true);
		clock.now += 10_000;
		expect(await served()).toEqual([]);
		// B1: the first blocked sample to a served block.
		box.blocked = ["hobo-trunk"];
		const blockMs = await sampleUntil((labels) =>
			labels.includes("hobo-trunk"),
		);
		expect(blockMs + sendWallMs).toBeLessThanOrEqual(75_000);
		expect(blockMs).toBe(60_000);
		clock.now += 10_000;
		// B2: the first clear sample to a served clear.
		box.blocked = [];
		const clearMs = await sampleUntil((labels) => labels.length === 0);
		expect(clearMs + sendWallMs).toBeLessThanOrEqual(45_000);
		expect(clearMs).toBe(30_000);
		console.info(
			JSON.stringify({
				outcome: "B1,B2",
				blockServedAfterMs: blockMs,
				clearServedAfterMs: clearMs,
				slowestSendWallMs: Math.round(sendWallMs),
			}),
		);
	}, 30_000);
});

describe("the reporter's box settings", () => {
	const valid = {
		HOBO_CI_FLEET_VERDICT_MODE: "shadow",
		HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: "https://hobo-ci.vercel.app",
		HOBO_CI_FLEET_REPORTER_ID: "box-1",
	};

	it("is off by default and needs nothing else then", () => {
		expect(parseFleetVerdictReporterSettings({}, undefined)).toEqual({
			mode: "off",
		});
	});

	it("reads every setting, with the defaults of 6.3", () => {
		expect(parseFleetVerdictReporterSettings(valid, undefined)).toEqual({
			mode: "shadow",
			origin: "https://hobo-ci.vercel.app",
			reporterId: "box-1",
			pools: [],
			minFreeRunners: 1,
			enterMs: 60_000,
			exitMs: 30_000,
		});
		expect(
			parseFleetVerdictReporterSettings(
				{
					HOBO_CI_FLEET_VERDICT_MODE: "report",
					HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: "https://hobo-ci.vercel.app/",
					HOBO_CI_FLEET_EXTERNAL_POOLS_JSON:
						'[{"labels":["hobo","hobo-trunk"],"runnerNamePrefix":"hobo-runner-","maxRunners":1}]',
					HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS: "2",
					HOBO_CI_FLEET_VERDICT_ENTER_MS: "90000",
					HOBO_CI_FLEET_VERDICT_EXIT_MS: "20000",
				},
				"mesh-node-7",
			),
		).toEqual({
			mode: "report",
			origin: "https://hobo-ci.vercel.app",
			reporterId: "mesh-node-7",
			pools: [
				{
					labels: ["hobo", "hobo-trunk"],
					runnerNamePrefix: "hobo-runner-",
					maxRunners: 1,
				},
			],
			minFreeRunners: 2,
			enterMs: 90_000,
			exitMs: 20_000,
		});
	});

	it.each([
		[{ HOBO_CI_FLEET_VERDICT_MODE: "on" }, /HOBO_CI_FLEET_VERDICT_MODE/u],
		[{ HOBO_CI_FLEET_REPORTER_ID: "" }, /missing HOBO_CI_FLEET_REPORTER_ID/u],
		[
			{ HOBO_CI_FLEET_REPORTER_ID: "box 1" },
			/invalid HOBO_CI_FLEET_REPORTER_ID/u,
		],
		[
			{ HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: "http://hobo-ci.vercel.app" },
			/RELAY_ORIGIN/u,
		],
		[
			{ HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: "https://hobo-ci.vercel.app/v1" },
			/RELAY_ORIGIN/u,
		],
		[{ HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: undefined }, /RELAY_ORIGIN/u],
		[{ HOBO_CI_FLEET_EXTERNAL_POOLS_JSON: "{}" }, /EXTERNAL_POOLS_JSON/u],
		[
			{
				HOBO_CI_FLEET_EXTERNAL_POOLS_JSON:
					'[{"labels":["hobo"],"runnerNamePrefix":"a","maxRunners":-1}]',
			},
			/EXTERNAL_POOLS_JSON/u,
		],
		[{ HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS: "0" }, /MIN_FREE_RUNNERS/u],
		[{ HOBO_CI_FLEET_VERDICT_ENTER_MS: "5000" }, /ENTER_MS/u],
		[{ HOBO_CI_FLEET_VERDICT_EXIT_MS: "soon" }, /EXIT_MS/u],
	])("refuses to start on %j", (change, message) => {
		expect(() =>
			parseFleetVerdictReporterSettings({ ...valid, ...change }, undefined),
		).toThrow(message);
	});
});
