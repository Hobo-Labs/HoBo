/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof -- SAFETY: tests read the deps a recording fake factory captured; casts select the member under test. */
import { beforeEach, describe, expect, it } from "vitest";
import { ReconcilerMode } from "../../src/_generated/cd_pb.js";
import { ComposeError } from "../../src/compose/errors.js";
import {
	type CdComposeInput,
	COMPOSE_METRICS,
	conductorFor,
	defaultRetention,
	wireContinuousDelivery,
} from "../../src/compose/wire.js";
import { CD_DEFAULTS } from "../../src/events.js";
import type {
	CdFactories,
	ReconcilerId,
	ReconcilerTransport,
} from "../../src/ports.js";
import {
	asCamp,
	base,
	bindings,
	type CallLog,
	camp,
	DIGEST_A,
	type FactoryCall,
	fakeAdapters,
	fakeFactories,
	fakeTopology,
	MODULE_OF,
	recordingModule,
	recordingSink,
	staticCatalog,
} from "./fakes.js";

function input(
	log: CallLog,
	calls: FactoryCall[],
	over: Partial<CdComposeInput> = {},
): CdComposeInput {
	return {
		base: base(),
		factories: fakeFactories(log, calls),
		adapters: fakeAdapters(log),
		http: async () => {
			throw new Error("no network in compose tests");
		},
		credentials: { resolve: async () => ({}) },
		artifactStore: { backend: "memory" },
		trustPolicy: {},
		policyPack: {} as never,
		topology: fakeTopology([camp("c1")]),
		railCatalog: staticCatalog([]),
		telemetry: recordingSink(),
		...over,
	};
}

function argsOf(calls: readonly FactoryCall[], factory: keyof CdFactories) {
	const call = calls.find((c) => c.factory === factory);
	if (!call) throw new Error(`${factory} was not called`);
	return call.args[0] as Record<string, unknown>;
}

describe("wireContinuousDelivery", () => {
	let log: CallLog;
	let calls: FactoryCall[];
	beforeEach(() => {
		log = [];
		calls = [];
		bindings.clear();
	});

	it("binds every module factory exactly once (service and agent transport are host-side)", () => {
		wireContinuousDelivery(input(log, calls));
		const hostSide = new Set<keyof CdFactories>([
			"createCdService",
			"createHttpTransport",
			"createCampReconciler",
			"createInProcessTransport",
			// An explicit telemetry sink was supplied.
			"createTelemetrySink",
		]);
		for (const factory of Object.keys(MODULE_OF) as (keyof CdFactories)[]) {
			const n = calls.filter((c) => c.factory === factory).length;
			expect(`${factory}:${n}`).toBe(
				`${factory}:${hostSide.has(factory) ? 0 : 1}`,
			);
		}
	});

	it("exposes every ContinuousDelivery member on the facade", () => {
		const cd = wireContinuousDelivery(input(log, calls));
		for (const key of [
			"freight",
			"ingest",
			"publishers",
			"sources",
			"artifacts",
			"desired",
			"deltas",
			"pipelines",
			"windows",
			"promotions",
			"rollouts",
			"verification",
			"enrollment",
			"feed",
			"telemetry",
			"authorizer",
			"inventory",
			"placement",
			"fanout",
			"failover",
			"campPolicy",
			"posture",
		] as const) {
			expect(cd[key], key).toBeDefined();
		}
		expect(cd.deltas).toBe(cd.desired);
		expect(cd.postureSeries).toBe(cd.posture);
	});

	it("closes the pipelines ⇄ promotions and fan-out → promotions cycles with forwarding references", async () => {
		const cd = wireContinuousDelivery(input(log, calls));
		const viaPipelines = argsOf(calls, "createPipelineController")
			.promotions as typeof cd.promotions;
		const viaFanout = argsOf(calls, "createFanoutController")
			.promotions as typeof cd.promotions;
		const fanoutViaPipelines = argsOf(calls, "createPipelineController")
			.fanout as typeof cd.fanout;
		await viaPipelines.list();
		await viaFanout.tick({} as never);
		await fanoutViaPipelines.halt("f" as never, "r", {} as never);
		expect(log).toEqual(["promotions.list", "promotions.tick", "fanout.halt"]);
		expect(argsOf(calls, "createPromotionService").pipelines).toBe(
			cd.pipelines,
		);
	});

	it("hands each factory the composed modules it depends on", () => {
		const cd = wireContinuousDelivery(input(log, calls));
		const promotion = argsOf(calls, "createPromotionService");
		expect(promotion.freight).toBe(cd.freight);
		expect(promotion.desired).toBe(cd.desired);
		expect(promotion.campPolicy).toBe(cd.campPolicy);
		expect(promotion.authorizer).toBe(cd.authorizer);
		expect(argsOf(calls, "createFreightIngest").sources).toBe(cd.sources);
		expect(argsOf(calls, "createFreightSources").webhookSecrets).toBeDefined();
		expect(argsOf(calls, "createHealthSources").posture).toBe(cd.posture);
		expect(argsOf(calls, "createDeliveryFeedHandler").enrollment).toBe(
			cd.enrollment,
		);
		expect(argsOf(calls, "createFailoverController").fanout).toBe(cd.fanout);
		expect(argsOf(calls, "createCampInventory").rails).toBe(cd.rails);
		const verifier = argsOf(calls, "createFreightLedger").artifacts;
		expect(verifier).not.toBe(cd.artifacts);
	});

	it("passes the CI and Rail readers to the subscription drivers (CI bridge, C15)", () => {
		const readCiEvents = async function* () {};
		const readRailEvents = async function* () {};
		wireContinuousDelivery(input(log, calls, { readCiEvents, readRailEvents }));
		const drivers = argsOf(calls, "createSubscriptionDrivers");
		expect(drivers.readCiEvents).toBe(readCiEvents);
		expect(drivers.readRailEvents).toBe(readRailEvents);
		expect(drivers).not.toHaveProperty("readCiArtifact");
	});

	it("falls back to fail-closed traffic, runbooks, suites and notify when the host configures none", async () => {
		wireContinuousDelivery(input(log, calls));
		const rollouts = argsOf(calls, "createRolloutOrchestrator");
		const traffic = rollouts.traffic as {
			offerings(c: string): Promise<unknown[]>;
		};
		expect(await traffic.offerings("c1")).toEqual([]);
		const promotion = argsOf(calls, "createPromotionService");
		const runbooks = promotion.runbooks as {
			run(
				i: unknown,
				c: unknown,
			): Promise<{ ok: boolean; reasons: { code: string }[] }>;
		};
		const out = await runbooks.run({ path: "rb", args: {} }, { now: () => 1 });
		expect(out.ok).toBe(false);
		expect(out.reasons[0]?.code).toBe("compose-runbook-unconfigured");
	});

	it("uses the telemetry factory sink when no sink is supplied", () => {
		const { telemetry: _drop, ...rest } = input(log, calls);
		wireContinuousDelivery({
			...rest,
			telemetryEndpoint: "https://otel.example/v1",
		});
		expect(argsOf(calls, "createTelemetrySink").endpoint).toBe(
			"https://otel.example/v1",
		);
	});

	it("emits the composed module count through TelemetrySink", async () => {
		const sink = recordingSink();
		wireContinuousDelivery(input(log, calls, { telemetry: sink }));
		await Promise.resolve();
		const point = sink.points.find((p) => p.name === COMPOSE_METRICS.modules);
		expect(point?.value).toBeGreaterThan(15);
	});

	it("refuses an adapter that reads a module built after it (compose-scope-unbuilt)", () => {
		expect(() =>
			wireContinuousDelivery(
				input(log, calls, {
					adapters: fakeAdapters(log, {
						approvals: (s) => {
							void s.promotions;
							return recordingModule("approvals", log);
						},
					}),
				}),
			),
		).toThrowError(/compose-scope-unbuilt/);
	});

	describe("createReconciler", () => {
		it("builds a conductor over the in-process transport and the mode's realizer", () => {
			const cd = wireContinuousDelivery(input(log, calls));
			conductorFor(cd, { campIds: [asCamp("c1")], holderId: "h1" });
			const transport = argsOf(calls, "createInProcessTransport");
			expect(transport.desired).toBe(cd.desired);
			expect(transport.posture).toBe(cd.posture);
			const r = argsOf(calls, "createCampReconciler");
			expect(r.mode).toBe(ReconcilerMode.CONDUCTOR);
			expect(r.reconcilerId).toBe("conductor:h1");
			expect(r.campIds).toEqual(["c1"]);
		});

		it("uses an explicit transport (agent mode) instead of the in-process one", () => {
			const cd = wireContinuousDelivery(input(log, calls));
			const transport = recordingModule<ReconcilerTransport>("http", log);
			cd.createReconciler({
				mode: ReconcilerMode.AGENT,
				reconcilerId: "agent-1" as ReconcilerId,
				campIds: [asCamp("c1")],
				holderId: "h1",
				transport,
			});
			expect(calls.some((c) => c.factory === "createInProcessTransport")).toBe(
				false,
			);
			expect(argsOf(calls, "createCampReconciler").transport).toBe(transport);
		});

		it("refuses a mode with no realizer with a typed code, remediation and metric", async () => {
			const sink = recordingSink();
			const cd = wireContinuousDelivery(
				input(log, calls, {
					telemetry: sink,
					adapters: fakeAdapters(log, { realizer: () => undefined }),
				}),
			);
			let error: unknown;
			try {
				conductorFor(cd, { campIds: [asCamp("c1")], holderId: "h1" });
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(ComposeError);
			expect((error as ComposeError).code).toBe("compose-realizer-missing");
			expect((error as ComposeError).remediation).toMatch(/--simulate/);
			await Promise.resolve();
			expect(sink.points.some((p) => p.name === COMPOSE_METRICS.failures)).toBe(
				true,
			);
		});
	});

	it("resolves a Camp's Rail through its enforced binding first", async () => {
		bindings.set("c1", { enforcedRailDigest: DIGEST_A });
		const cd = wireContinuousDelivery(
			input(log, calls, {
				railCatalog: staticCatalog([
					{
						railId: "r1",
						railDigest: DIGEST_A,
						stationId: "st1",
						status: "approved",
						delivery: { campSets: ["prod"] },
					},
				]),
			}),
		);
		const record = await cd.rails.forCamp(asCamp("c1"));
		expect(record?.campSets).toEqual(["prod"]);
	});

	it("defaultRetention applies CD_DEFAULTS (D18)", () => {
		const r = defaultRetention("web");
		expect(r.bindle).toBe("web");
		expect(r.keepPerCamp).toBe(CD_DEFAULTS.retentionKeepPerCamp);
		expect(r.keepUnpromotedMs).toBe(
			BigInt(CD_DEFAULTS.retentionKeepUnpromotedMs),
		);
		expect(r.blobGraceMs).toBe(BigInt(CD_DEFAULTS.retentionBlobGraceMs));
	});
});
