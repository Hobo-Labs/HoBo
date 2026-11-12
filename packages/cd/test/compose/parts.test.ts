import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	AssemblyRule,
	ReconcileStatus,
	SubscriptionKind,
} from "../../src/_generated/cd_pb.js";
import {
	HOBO_CI_COMPONENTS,
	hoboCiDogfoodSources,
	hoboCiSource,
} from "../../src/compose/ci-bridge.js";
import { COMPOSE_FAILURES, ComposeError } from "../../src/compose/errors.js";
import {
	FAIL_CLOSED_METRICS,
	unconfiguredSuites,
	unconfiguredTraffic,
	unroutedNotifications,
} from "../../src/compose/fail-closed.js";
import { lateBound } from "../../src/compose/late.js";
import {
	createSimulatedRealizer,
	isSimulatedObservation,
	SIMULATED_REASON,
} from "../../src/compose/simulate.js";
import { CD_DEFAULTS, SOURCE_SCHEMA } from "../../src/events.js";
import type { RealizeInput } from "../../src/ports.js";
import { asCamp, recordingSink } from "./fakes.js";

const ctx = { now: () => 1_000 } as never;

describe("lateBound", () => {
	it("forwards to the bound module, including references captured before binding", async () => {
		const late = lateBound<{ hello(): Promise<string>; n: number }>("m");
		const early = late.ref;
		late.bind({ hello: async () => "hi", n: 3 });
		expect(await early.hello()).toBe("hi");
		expect(early.n).toBe(3);
		expect(late.bound()).toBe(true);
	});

	it("throws compose-unbound with remediation when used before binding", () => {
		const late = lateBound<{ go(): void }>("promotions");
		try {
			late.ref.go();
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ComposeError);
			expect((e as ComposeError).code).toBe("compose-unbound");
			expect((e as ComposeError).remediation).toBe(
				COMPOSE_FAILURES["compose-unbound"],
			);
		}
	});

	it("refuses a second bind (compose-rebound)", () => {
		const late = lateBound<object>("m");
		late.bind({});
		expect(() => late.bind({})).toThrowError(/compose-rebound/);
	});

	it("is not mistaken for a thenable", async () => {
		const late = lateBound<object>("m");
		await expect(Promise.resolve(late.ref)).resolves.toBe(late.ref);
	});
});

describe("every compose failure code has a remediation", () => {
	it("is non-empty for all codes", () => {
		for (const [code, remediation] of Object.entries(COMPOSE_FAILURES)) {
			expect(remediation.length, code).toBeGreaterThan(20);
		}
	});
});

describe("simulated realizer (--simulate is the only fixture path)", () => {
	const input = {
		campId: asCamp("c1"),
		desired: { setId: "set-1" },
		reconcilerId: "r1",
		fence: 7n,
	} as unknown as RealizeInput;

	it("labels every observation as simulated", async () => {
		const realizer = createSimulatedRealizer();
		const converged = await realizer.converge(input, ctx);
		expect(converged.status).toBe(ReconcileStatus.CONVERGED);
		expect(converged.fenceToken).toBe("7");
		expect(converged.reasons[0]?.code).toBe(SIMULATED_REASON.code);
		expect(isSimulatedObservation(converged)).toBe(true);
		expect(isSimulatedObservation(await realizer.observe(input, ctx))).toBe(
			true,
		);
	});
});

describe("fail-closed adapters", () => {
	it("suites refuse with a typed reason and count the refusal", async () => {
		const sink = recordingSink();
		const out = await unconfiguredSuites({ telemetry: sink }).run(
			{ suite: "smoke", campId: asCamp("c1"), freightId: "f" as never },
			ctx,
		);
		expect(out.ok).toBe(false);
		if (!out.ok)
			expect(out.reasons[0]?.code).toBe("compose-suite-unconfigured");
		await Promise.resolve();
		expect(sink.points[0]?.name).toBe(FAIL_CLOSED_METRICS.refused);
	});

	it("traffic offers nothing and realizes nothing (I6: refused honestly downstream)", async () => {
		const traffic = unconfiguredTraffic();
		expect(await traffic.offerings(asCamp("c1"))).toEqual([]);
		const applied = await traffic.shift(
			{
				campId: asCamp("c1"),
				plan: { planId: "p1" } as never,
				signal: new AbortController().signal,
			},
			ctx,
		);
		expect(applied.realized).toBe("none");
		expect(applied.unmet?.[0]).toMatch(/compose-traffic-unconfigured/);
		expect(await traffic.status(asCamp("c1"), "p1" as never)).toBeNull();
	});

	it("unrouted NOTIFY is dropped and counted", async () => {
		const sink = recordingSink();
		await unroutedNotifications({ telemetry: sink }).notify(
			{ channel: "ops", subject: "s", body: {} },
			ctx,
		);
		await Promise.resolve();
		expect(sink.points[0]?.name).toBe(FAIL_CLOSED_METRICS.notifyDropped);
	});
});

describe("CI bridge and HoBo CI dogfooding seam", () => {
	it("builds a HOBO_CI pull source (C15): CI events trigger, verified reads decide", () => {
		const source = hoboCiSource({
			name: "web",
			bindle: "web",
			pipeline: "acme/web",
		});
		expect(source.schemaVersion).toBe(SOURCE_SCHEMA);
		expect(source.subscriptions).toHaveLength(1);
		expect(source.subscriptions[0]?.kind).toBe(SubscriptionKind.HOBO_CI);
		expect(source.subscriptions[0]?.locator).toBe("acme/web");
		expect(source.subscriptions[0]?.discoveryLimit).toBe(
			CD_DEFAULTS.sourceDiscoveryLimit,
		);
		expect(source.pollIntervalMs).toBe(
			BigInt(CD_DEFAULTS.sourcePollIntervalMs),
		);
		expect(source.assembly).toBe(AssemblyRule.INDEPENDENT);
	});

	it("assembles multi-output sources by commit", () => {
		const source = hoboCiSource({
			name: "x",
			bindle: "x",
			pipeline: "p",
			outputs: [
				{ path: "a", kind: ArtifactKind.OCI_IMAGE },
				{ path: "b", kind: ArtifactKind.STATIC_ASSETS },
			],
		});
		expect(source.assembly).toBe(AssemblyRule.SAME_COMMIT);
		expect(source.subscriptions.map((s) => s.artifactName)).toEqual(["a", "b"]);
	});

	it("delivers HoBo's own CI relay and runner fleet as ordinary Freight sources", () => {
		const sources = hoboCiDogfoodSources({
			ciPipeline: "hobo/hobo",
			branch: "main",
		});
		expect(sources.map((s) => s.bindle)).toEqual([
			HOBO_CI_COMPONENTS.relay.bindle,
			HOBO_CI_COMPONENTS.runnerFleet.bindle,
		]);
		for (const s of sources) {
			expect(s.subscriptions[0]?.kind).toBe(SubscriptionKind.HOBO_CI);
			expect(s.subscriptions[0]?.branch).toBe("main");
		}
	});
});
