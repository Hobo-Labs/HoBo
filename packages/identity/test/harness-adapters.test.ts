/**
 * These are the mediation-ladder adapters (ADR-0027): application code never
 * holds a vendor SDK, so every optional backend reaches the outside world
 * through one of the functions in this file. That makes their *failure*
 * behaviour the contract that matters. A residual flag backend must fail closed
 * to the caller's default when the network is gone; a residual CD adapter must
 * fail soft, because the local engine is the source of truth and a webhook
 * outage is not a deploy failure. Those two are opposite policies, and nothing
 * in the type system distinguishes them.
 *
 * So each adapter here is driven with a `fetchImpl` that rejects, that returns a
 * non-ok status, and that returns a malformed body — and the test asserts which
 * of the two policies applies. The built-in analysis path is covered separately
 * because its verdict rule (majority, with ties inconclusive) is the thing a
 * rollout decision reads.
 */
import { describe, expect, test } from "vitest";
import { FeatureFlagStore } from "../src/feature-flag-store.js";
import {
	analyzeExperimentFromEngine,
	createBuiltinDeliveryAdapter,
	createBuiltinExperimentAnalysis,
	createCdResidualDeliveryAdapter,
	createMediatedFlagEvaluator,
	createOfrepResidualBackend,
	createResidualExperimentAnalysis,
	DELIVERY_ADAPTER_SCHEMA,
	EXPERIMENT_ANALYSIS_SCHEMA,
	type FetchLike,
	OFREP_RESIDUAL_SCHEMA,
	selectDeliveryAdapter,
} from "../src/harness-adapters.js";
import type { RolloutPolicy, RolloutState } from "../src/harness-delivery.js";
import type { ExperimentDefinition } from "../src/harness-experiment.js";
import { OpenExperimentEngine } from "../src/harness-experiment.js";
import type { JsonValue } from "../src/json.js";

type FetchCall = {
	url: string;
	init?: Parameters<FetchLike>[1];
};

/** A fetch stub that records its calls and answers with a fixed response. */
function stubFetch(response: {
	ok?: boolean;
	status?: number;
	json?: () => Promise<JsonValue>;
	text?: () => Promise<string>;
}): FetchLike & { calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	// SAFETY: the stub implementation satisfies the package's FetchLike boundary.
	const impl = (async (url: string, init?: Parameters<FetchLike>[1]) => {
		const call: FetchCall = { url };
		if (init !== undefined) call.init = init;
		calls.push(call);
		return {
			ok: response.ok ?? true,
			status: response.status ?? 200,
			json: response.json ?? (async () => ({})),
			text: response.text ?? (async () => ""),
		};
	}) as FetchLike & { calls: FetchCall[] };
	impl.calls = calls;
	return impl;
}

/** A fetch stub whose promise rejects — the offline / DNS-failure case. */
function rejectingFetch(message = "ECONNREFUSED"): FetchLike {
	return async () => {
		throw new Error(message);
	};
}

const CTX = { targetingKey: "user-1", tenant: "t1" } as const;

describe("the OFREP residual flag backend", () => {
	test("its id reflects whether the endpoint is the internal OFREP service", () => {
		// The id becomes a ranked backend identity, and `external` sits below
		// `ofrep-internal` on the ladder. Mislabelling an external endpoint as
		// internal would promote a third party above a first-party service.
		expect(
			createOfrepResidualBackend({ baseUrl: "https://ofrep.internal" }).id,
		).toBe("ofrep-internal");
		expect(
			createOfrepResidualBackend({ baseUrl: "https://flags.vendor.example" })
				.id,
		).toBe("external");
	});

	test("it carries the pinned residual schema version", () => {
		expect(
			createOfrepResidualBackend({ baseUrl: "https://ofrep.internal" })
				.schemaVersion,
		).toBe(OFREP_RESIDUAL_SCHEMA);
	});

	test("it posts to the OFREP evaluate path with the flag key escaped", () => {
		// A flag key with a slash would otherwise change which endpoint is hit —
		// a path-traversal shape in a URL the app never sees.
		const fetchImpl = stubFetch({ json: async () => ({ value: true }) });
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl,
		});
		return backend
			.evaluate({ flagKey: "a/b", context: CTX, defaultValue: false })
			.then(() => {
				expect(fetchImpl.calls[0]?.url).toBe(
					"https://ofrep.internal/ofrep/v1/evaluate/a%2Fb",
				);
			});
	});

	test("a trailing slash on the base url does not double up", () => {
		const fetchImpl = stubFetch({ json: async () => ({ value: true }) });
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal/",
			fetchImpl,
		});
		return backend
			.evaluate({ flagKey: "f", context: CTX, defaultValue: false })
			.then(() => {
				expect(fetchImpl.calls[0]?.url).toBe(
					"https://ofrep.internal/ofrep/v1/evaluate/f",
				);
			});
	});

	test("configured headers are merged with the content type", () => {
		// This is where the mediated credential rides. Dropping it would turn
		// every evaluation into an unauthenticated request that fails closed.
		const fetchImpl = stubFetch({ json: async () => ({ value: true }) });
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl,
			headers: { authorization: "Bearer mediated" },
		});
		return backend
			.evaluate({ flagKey: "f", context: CTX, defaultValue: false })
			.then(() => {
				expect(fetchImpl.calls[0]?.init?.headers).toEqual({
					"content-type": "application/json",
					authorization: "Bearer mediated",
				});
			});
	});

	test("the request body carries only the evaluation context", () => {
		// The default value stays local — sending it would let the remote decide
		// to echo it back and make a fail-closed default indistinguishable from a
		// real answer.
		const fetchImpl = stubFetch({ json: async () => ({ value: true }) });
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl,
		});
		return backend
			.evaluate({
				flagKey: "f",
				context: {
					targetingKey: "u",
					tenant: "t1",
					attributes: { env: "dev" },
				},
				defaultValue: "SECRET-DEFAULT",
			})
			.then(() => {
				const body = JSON.parse(String(fetchImpl.calls[0]?.init?.body));
				expect(body).toEqual({
					context: {
						targetingKey: "u",
						tenant: "t1",
						attributes: { env: "dev" },
					},
				});
				expect(String(fetchImpl.calls[0]?.init?.body)).not.toContain(
					"SECRET-DEFAULT",
				);
			});
	});

	test("a successful response is mapped through, with remote defaults", async () => {
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({ json: async () => ({ value: "V" }) }),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.value).toBe("V");
		// A response that omits variant/reason still has to produce a well-formed
		// evaluation, because callers read both unconditionally.
		expect(result.variant).toBe("remote");
		expect(result.reason).toBe("targeting-match");
	});

	test("an explicit variant and reason from the remote are preserved", async () => {
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({
				json: async () => ({ value: true, variant: "beta", reason: "split" }),
			}),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.variant).toBe("beta");
		expect(result.reason).toBe("split");
	});

	test("a response with a null value falls back to the caller's default", async () => {
		// `null` is what a remote returns for a flag it does not know. Passing it
		// through would hand the caller a null where a boolean was promised.
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({ json: async () => ({ value: null }) }),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: "fallback",
		});
		expect(result.value).toBe("fallback");
	});

	test("a false value from the remote is kept, not treated as absent", async () => {
		// `??` rather than `||` is what makes this work; the distinction is the
		// difference between "the remote said off" and "the remote said nothing".
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({ json: async () => ({ value: false }) }),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: true,
		});
		expect(result.value).toBe(false);
	});

	test("a non-ok status fails closed to the caller's default", async () => {
		// Fail *closed* is the flag policy: a 500 from the flag service must never
		// turn a feature on.
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({ ok: false, status: 503 }),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.reason).toBe("fail-safe-default");
		expect(result.value).toBe(false);
		expect(result.variant).toBe("default");
	});

	test("a transport rejection fails closed rather than propagating", async () => {
		// If this threw, an offline laptop would crash on every flag read.
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: rejectingFetch(),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.reason).toBe("fail-safe-default");
	});

	test("a body that is not valid JSON fails closed", async () => {
		// The `json()` rejection lands in the same catch as a transport failure.
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: stubFetch({
				json: async () => {
					throw new SyntaxError("unexpected token");
				},
			}),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.reason).toBe("fail-safe-default");
	});

	test("the fail-closed evaluation still carries a context digest", async () => {
		// Callers log the digest to correlate a denial with a request; an empty
		// one on the failure path would make exactly the interesting case
		// untraceable.
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: rejectingFetch(),
		});
		const result = await backend.evaluate({
			flagKey: "f",
			context: CTX,
			defaultValue: false,
		});
		expect(result.contextDigest).toMatch(/^sha256:[0-9a-f]{16}$/);
	});

	test("the digest distinguishes tenants for the same targeting key", async () => {
		const backend = createOfrepResidualBackend({
			baseUrl: "https://ofrep.internal",
			fetchImpl: rejectingFetch(),
		});
		const a = await backend.evaluate({
			flagKey: "f",
			context: { targetingKey: "u", tenant: "t1" },
			defaultValue: false,
		});
		const b = await backend.evaluate({
			flagKey: "f",
			context: { targetingKey: "u", tenant: "t2" },
			defaultValue: false,
		});
		expect(a.contextDigest).not.toBe(b.contextDigest);
	});
});

describe("delivery adapters", () => {
	const POLICY: RolloutPolicy = Object.freeze({
		name: "canary",
		flag: "feature.x",
		stages: [],
		traffic: "flag-only",
		autoRollback: true,
	});

	// SAFETY: this fixture intentionally supplies the minimum state needed by the adapter.
	const STATE = {
		id: "roll-1",
		policy: POLICY,
		percent: 25,
		status: "running",
		stageIndex: 0,
		gatewayWeightPercent: 25,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	} satisfies RolloutState;

	test("the builtin adapter accepts offline and needs no transport", async () => {
		// This is the default path, and it has to work with no network at all.
		const adapter = createBuiltinDeliveryAdapter();
		expect(adapter.kind).toBe("builtin");
		expect(adapter.schemaVersion).toBe(DELIVERY_ADAPTER_SCHEMA);
		const started = await adapter.startRemote(POLICY);
		expect(started.accepted).toBe(true);
		expect(started.remoteId).toBe("local:canary");
		expect(await adapter.mirrorStep(STATE)).toEqual({ mirrored: true });
	});

	test("the CD residual posts an Argo-shaped payload", async () => {
		const fetchImpl = stubFetch({});
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl,
		});
		await adapter.startRemote(POLICY);
		const body = JSON.parse(String(fetchImpl.calls[0]?.init?.body));
		expect(body.type).toBe("io.argoproj.rollouts.step");
		expect(body.spec).toEqual({
			flag: "feature.x",
			name: "canary",
			stages: [],
			traffic: "flag-only",
		});
	});

	test("an accepted remote start reports a remote id", async () => {
		const adapter = createCdResidualDeliveryAdapter({
			kind: "flagger-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({}),
		});
		const result = await adapter.startRemote(POLICY);
		expect(result.accepted).toBe(true);
		expect(result.remoteId).toBe("remote:canary");
		expect(result.note).toContain("flagger-shaped");
	});

	test("a rejected remote start reports the status and no remote id", async () => {
		// Reporting a remoteId for a rejected start would leave the local engine
		// believing a remote representation exists to reconcile against.
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({ ok: false, status: 422 }),
		});
		const result = await adapter.startRemote(POLICY);
		expect(result.accepted).toBe(false);
		expect(result.remoteId).toBeUndefined();
		expect(result.note).toContain("422");
	});

	test("a transport failure on start fails soft, carrying the cause", async () => {
		// Fail *soft* is the delivery policy — the opposite of the flag backend's.
		// The local rollout engine is the source of truth, so a webhook outage
		// must not abort a deploy; but the reason has to reach the note or an
		// operator sees an unexplained `accepted: false`.
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: rejectingFetch("ENOTFOUND cd.internal"),
		});
		const result = await adapter.startRemote(POLICY);
		expect(result.accepted).toBe(false);
		expect(result.note).toContain("ENOTFOUND cd.internal");
	});

	test("a non-Error rejection still produces a readable note", async () => {
		// Rejections from a raw fetch polyfill are not always Errors.
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: async () => {
				throw "string failure";
			},
		});
		const result = await adapter.startRemote(POLICY);
		expect(result.note).toContain("string failure");
	});

	test("mirrorStep reports the transport result and never throws", async () => {
		const ok = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({}),
		});
		expect(await ok.mirrorStep(STATE)).toEqual({ mirrored: true });

		const rejected = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({ ok: false, status: 500 }),
		});
		expect(await rejected.mirrorStep(STATE)).toEqual({ mirrored: false });

		const offline = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: rejectingFetch(),
		});
		expect(await offline.mirrorStep(STATE)).toEqual({ mirrored: false });
	});

	test("mirrorStep sends the rollout position, not the whole policy", async () => {
		const fetchImpl = stubFetch({});
		const adapter = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl,
		});
		await adapter.mirrorStep(STATE);
		const body = JSON.parse(String(fetchImpl.calls[0]?.init?.body));
		expect(body).toEqual({
			type: "io.hobo.rollout.step",
			spec: { id: "roll-1", percent: 25, status: "running" },
		});
	});

	test("selection prefers the builtin adapter over any residual", async () => {
		// The offline-capable adapter wins so a deploy never depends on a remote
		// operator being reachable.
		const residual = createCdResidualDeliveryAdapter({
			kind: "argo-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({}),
		});
		const builtin = createBuiltinDeliveryAdapter();
		expect(selectDeliveryAdapter([residual, builtin]).kind).toBe("builtin");
	});

	test("selection falls back to the first candidate when no builtin is offered", () => {
		const residual = createCdResidualDeliveryAdapter({
			kind: "flagger-shaped",
			webhookUrl: "https://cd.internal/hook",
			fetchImpl: stubFetch({}),
		});
		expect(selectDeliveryAdapter([residual]).kind).toBe("flagger-shaped");
	});

	test("selection with no candidates synthesises a builtin", () => {
		// Returning undefined here would make every caller null-check a value
		// that has a perfectly good offline default.
		expect(selectDeliveryAdapter([]).kind).toBe("builtin");
	});
});

describe("built-in experiment analysis", () => {
	const analysis = createBuiltinExperimentAnalysis();

	function def(
		variants: readonly string[],
		extra: Partial<ExperimentDefinition> = {},
	): ExperimentDefinition {
		return { name: "exp-1", flag: "feature.x", variants, ...extra };
	}

	function assignments(variants: readonly string[]) {
		return variants.map((variant, i) => ({
			experiment: "exp-1",
			flag: "feature.x",
			variant,
			subjectKey: `s-${i}`,
			assignedAt: "2026-01-01T00:00:00.000Z",
		}));
	}

	test("a clear treatment majority ships", () => {
		const result = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment", "treatment", "control"]),
			3,
		);
		expect(result.verdict).toBe("ship");
		expect(result.winningVariant).toBe("treatment");
	});

	test("a clear control majority does not ship", () => {
		const result = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["control", "control", "treatment"]),
			3,
		);
		expect(result.verdict).toBe("do-not-ship");
	});

	test("the on/off variant naming maps to the same verdicts", () => {
		expect(
			analysis.analyze(def(["off", "on"]), assignments(["on", "on", "off"]), 3)
				.verdict,
		).toBe("ship");
		expect(
			analysis.analyze(def(["off", "on"]), assignments(["off", "off", "on"]), 3)
				.verdict,
		).toBe("do-not-ship");
	});

	test("an exact tie is inconclusive and names no winner", () => {
		// Shipping on a coin flip is the failure this guards. The winner is
		// suppressed too, so a caller cannot read a decision out of a tie.
		const result = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["control", "treatment"]),
			2,
		);
		expect(result.verdict).toBe("inconclusive");
		expect(result.winningVariant).toBeUndefined();
	});

	test("no assignments at all is inconclusive", () => {
		const result = analysis.analyze(def(["control", "treatment"]), [], 0);
		expect(result.verdict).toBe("inconclusive");
		expect(result.totalAssigned).toBe(0);
	});

	test("a winner that is neither arm name is inconclusive", () => {
		// A multi-arm experiment has no ship/do-not-ship meaning; guessing one
		// would turn an unlabelled arm into a release decision.
		const result = analysis.analyze(
			def(["alpha", "beta"]),
			assignments(["alpha", "alpha", "beta"]),
			3,
		);
		expect(result.verdict).toBe("inconclusive");
		expect(result.winningVariant).toBe("alpha");
	});

	test("declared variants with no assignments are still counted at zero", () => {
		// A missing key would make a downstream chart drop the arm entirely,
		// which reads as "not run" rather than "nobody landed there".
		const result = analysis.analyze(
			def(["control", "treatment", "holdout"]),
			assignments(["treatment", "treatment"]),
			2,
		);
		expect(result.variantCounts).toEqual({
			control: 0,
			treatment: 2,
			holdout: 0,
		});
	});

	test("an assignment to an undeclared variant is still counted", () => {
		// Dropping it would make totalAssigned and the counts disagree, and the
		// discrepancy is exactly the signal that a definition changed mid-flight.
		const result = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment", "rogue"]),
			2,
		);
		expect(result.variantCounts.rogue).toBe(1);
		expect(result.totalAssigned).toBe(2);
	});

	test("the exposed count is carried through independently of assignments", () => {
		// Assignment and exposure differ — a subject can be bucketed and never
		// shown the feature — and conflating them inflates the denominator.
		const result = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment"]),
			17,
		);
		expect(result.totalAssigned).toBe(1);
		expect(result.totalExposed).toBe(17);
	});

	test("the export hash is stable for identical input and changes with it", () => {
		// The hash is the export's identity; a hash that ignored the counts would
		// let two different results dedupe into one.
		const a = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment", "treatment"]),
			2,
		);
		const b = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment", "treatment"]),
			2,
		);
		const c = analysis.analyze(
			def(["control", "treatment"]),
			assignments(["treatment", "control"]),
			2,
		);
		expect(a.exportPayload.contentHash).toBe(b.exportPayload.contentHash);
		expect(a.exportPayload.contentHash).not.toBe(c.exportPayload.contentHash);
		expect(a.exportPayload.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("metrics default to an empty list rather than being omitted", () => {
		const result = analysis.analyze(def(["control", "treatment"]), [], 0);
		expect(result.exportPayload.body.metrics).toEqual([]);
	});

	test("declared metrics reach the export body", () => {
		const result = analysis.analyze(
			def(["control", "treatment"], { metrics: ["signup-rate"] }),
			[],
			0,
		);
		expect(result.exportPayload.body.metrics).toEqual(["signup-rate"]);
	});

	test("the result carries the pinned analysis schema version", () => {
		expect(
			analysis.analyze(def(["control", "treatment"]), [], 0).schemaVersion,
		).toBe(EXPERIMENT_ANALYSIS_SCHEMA);
	});

	test("an experiment declaring no variants is inconclusive", () => {
		expect(analysis.analyze(def([]), [], 0).verdict).toBe("inconclusive");
	});
});

describe("the residual analysis adapter", () => {
	function definition(): ExperimentDefinition {
		return {
			name: "exp-1",
			flag: "feature.x",
			variants: ["control", "treatment"],
		};
	}

	test("it returns the baseline result synchronously", () => {
		// The residual is an enrichment, not a dependency; blocking a conclude on
		// a remote round trip would make an offline conclude impossible.
		const port = createResidualExperimentAnalysis({
			endpointUrl: "https://stats.internal/ingest",
			fetchImpl: stubFetch({}),
		});
		const result = port.analyze(definition(), [], 0);
		expect(result.schemaVersion).toBe(EXPERIMENT_ANALYSIS_SCHEMA);
		expect(result.verdict).toBe("inconclusive");
	});

	test("it posts the baseline export body to the endpoint", () => {
		const fetchImpl = stubFetch({});
		const port = createResidualExperimentAnalysis({
			endpointUrl: "https://stats.internal/ingest",
			fetchImpl,
		});
		const result = port.analyze(definition(), [], 0);
		expect(fetchImpl.calls[0]?.url).toBe("https://stats.internal/ingest");
		expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toEqual(
			result.exportPayload.body,
		);
	});

	test("a rejecting endpoint does not surface as an error", async () => {
		// The post is fire-and-forget with a `.catch`. Without it, the rejection
		// would become an unhandled promise rejection and could take the process
		// down on a conclude that otherwise succeeded.
		const port = createResidualExperimentAnalysis({
			endpointUrl: "https://stats.internal/ingest",
			fetchImpl: rejectingFetch(),
		});
		expect(() => port.analyze(definition(), [], 0)).not.toThrow();
		// Give the rejected promise a turn to settle so an unhandled rejection
		// would have been raised by the time this test finishes.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	test("a supplied fallback port is used for the baseline", () => {
		// The fallback is the seam a real stats engine plugs into; ignoring it
		// would silently keep the built-in baseline in production.
		let called = 0;
		const port = createResidualExperimentAnalysis({
			endpointUrl: "https://stats.internal/ingest",
			fetchImpl: stubFetch({}),
			fallback: {
				analyze: (...args) => {
					called += 1;
					return createBuiltinExperimentAnalysis().analyze(...args);
				},
			},
		});
		port.analyze(definition(), [], 0);
		expect(called).toBe(1);
	});
});

describe("analyzeExperimentFromEngine", () => {
	function engineWith(name: string) {
		const store = new FeatureFlagStore({ sampleRate: 1 });
		const engine = new OpenExperimentEngine({
			store,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		engine.define({
			name,
			flag: "feature.x",
			variants: ["control", "treatment"],
		});
		return engine;
	}

	test("an unknown experiment yields null rather than an empty result", () => {
		// An empty analysis would read as "ran, found nothing", which is a very
		// different thing from "that experiment does not exist".
		expect(
			analyzeExperimentFromEngine(engineWith("exp-1"), "other"),
		).toBeNull();
	});

	test("assignments recorded by the engine are counted", () => {
		const engine = engineWith("exp-1");
		for (let i = 0; i < 10; i++) {
			engine.assign("exp-1", { targetingKey: `subject-${i}` });
		}
		const result = analyzeExperimentFromEngine(engine, "exp-1");
		expect(result?.totalAssigned).toBe(10);
		const counted = Object.values(result?.variantCounts ?? {}).reduce(
			(sum, n) => sum + n,
			0,
		);
		expect(counted).toBe(10);
	});

	test("exposures are counted separately from assignments", () => {
		const engine = engineWith("exp-1");
		engine.assign("exp-1", { targetingKey: "s-1" });
		engine.expose("exp-1", { targetingKey: "s-1" });
		engine.expose("exp-1", { targetingKey: "s-1" });
		const result = analyzeExperimentFromEngine(engine, "exp-1");
		expect(result?.totalAssigned).toBe(1);
		expect(result?.totalExposed).toBe(2);
	});

	test("events from another experiment are not counted", () => {
		// The engine log is shared, so filtering by name is the only thing
		// keeping two concurrent experiments from contaminating each other.
		const engine = engineWith("exp-1");
		engine.define({
			name: "exp-2",
			flag: "feature.y",
			variants: ["control", "treatment"],
		});
		engine.assign("exp-1", { targetingKey: "s-1" });
		engine.assign("exp-2", { targetingKey: "s-2" });
		engine.assign("exp-2", { targetingKey: "s-3" });
		expect(analyzeExperimentFromEngine(engine, "exp-1")?.totalAssigned).toBe(1);
		expect(analyzeExperimentFromEngine(engine, "exp-2")?.totalAssigned).toBe(2);
	});

	test("a supplied analysis port receives the engine's data", () => {
		let seen: { assigned: number; exposed: number } | undefined;
		const engine = engineWith("exp-1");
		engine.assign("exp-1", { targetingKey: "s-1" });
		engine.expose("exp-1", { targetingKey: "s-1" });
		analyzeExperimentFromEngine(engine, "exp-1", {
			analyze: (definition, assignments, exposed) => {
				seen = { assigned: assignments.length, exposed };
				return createBuiltinExperimentAnalysis().analyze(
					definition,
					assignments,
					exposed,
				);
			},
		});
		expect(seen).toEqual({ assigned: 1, exposed: 1 });
	});

	test("an experiment with no events analyses as inconclusive, not null", () => {
		// Defined-but-unrun is a real state, and it has to be distinguishable
		// from undefined.
		const result = analyzeExperimentFromEngine(engineWith("exp-1"), "exp-1");
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe("inconclusive");
	});
});

describe("the mediated flag evaluator", () => {
	function store() {
		const s = new FeatureFlagStore({ sampleRate: 1 });
		s.define({ key: "f", percentage: 100 });
		return s;
	}

	test("with no residual it selects the built-in backend", () => {
		const evaluator = createMediatedFlagEvaluator({ store: store() });
		expect(evaluator.backend).toBe("local-builtin");
	});

	test("the built-in backend wins even when a residual is available", () => {
		// Rank order puts local-builtin first, which is what makes evaluation
		// work offline and keeps a remote outage from changing behaviour.
		const evaluator = createMediatedFlagEvaluator({
			store: store(),
			residual: createOfrepResidualBackend({
				baseUrl: "https://ofrep.internal",
				fetchImpl: stubFetch({}),
			}),
			residualAvailable: true,
		});
		expect(evaluator.backend).toBe("local-builtin");
		expect(evaluator.evaluate("f", CTX)).toMatchObject({ value: true });
	});

	test("a residual that is not marked available is not registered", () => {
		const evaluator = createMediatedFlagEvaluator({
			store: store(),
			residual: createOfrepResidualBackend({
				baseUrl: "https://ofrep.internal",
				fetchImpl: stubFetch({}),
			}),
			residualAvailable: false,
		});
		expect(evaluator.backend).toBe("local-builtin");
	});

	test("evaluation goes to the local store and is synchronous", () => {
		// A caller that got a promise where it expected a value would silently
		// treat the pending promise as truthy.
		const evaluator = createMediatedFlagEvaluator({ store: store() });
		const result = evaluator.evaluate("f", CTX);
		expect(result).not.toBeInstanceOf(Promise);
		// SAFETY: synchronous evaluation returns a detail object with a value field.
		expect((result as { value: unknown }).value).toBe(true);
	});

	test("the caller's default reaches the store for an unknown flag", () => {
		const evaluator = createMediatedFlagEvaluator({ store: store() });
		// SAFETY: the evaluator returns a synchronous detail object for this local store.
		const result = evaluator.evaluate("ghost", CTX, "fallback") as {
			value: unknown;
			reason: string;
		};
		expect(result.value).toBe("fallback");
		expect(result.reason).toBe("fail-safe-default");
	});

	test("the default value defaults to false when omitted", () => {
		const evaluator = createMediatedFlagEvaluator({ store: store() });
		// SAFETY: the evaluator returns a synchronous detail object for this local store.
		const result = evaluator.evaluate("ghost", CTX) as { value: unknown };
		expect(result.value).toBe(false);
	});
});
