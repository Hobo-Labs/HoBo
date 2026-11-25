/**
 * The Kubernetes event-store fold, read through the payloads a cluster sends:
 * which spelling of a field it accepts, what it defaults when a field is
 * absent, and that it keeps the cluster's observation time. The fold's shared
 * event contract is pinned in `yard-event-fold.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../src/json.js";
import {
	KUBERNETES_EVENT_STORE_RESOLVER_ID,
	type KubernetesProviderNativeSignal,
	kubernetesEventStoreFoldDescriptor,
	normalizeKubernetesYardSignal,
} from "../src/yard-event-fold.js";

describe("event-store fold", () => {
	function signal(
		kind: string,
		payload: JsonObject = {},
	): KubernetesProviderNativeSignal {
		return {
			providerId: "kubernetes",
			kind,
			payload,
			observedAt: "2026-01-01T00:00:00.000Z",
		};
	}

	it("publishes the resolver id stored events are written under", () => {
		// A rename orphans every fact already written under the old id, so this
		// string is a migration rather than a label.
		expect(KUBERNETES_EVENT_STORE_RESOLVER_ID).toBe(
			"kubernetes.yard.event-store/v1",
		);
		expect(kubernetesEventStoreFoldDescriptor().implementationRef).toContain(
			"kubernetes",
		);
	});

	it("folds a created namespace into generation-started", () => {
		const [event] = normalizeKubernetesYardSignal(
			signal("namespace.created", { namespace: "hobo-1", attemptId: "a-1" }),
		);
		expect(event?.type).toBe("yard.GenerationProgressed");
		expect(event?.data.status).toBe("started");
		expect(event?.data.externalRefs).toMatchObject({ namespace: "hobo-1" });
	});

	it("accepts the object's bare name when no namespace field is spelled out", () => {
		// `p.namespace ?? p.name`. A watch event and a create response spell it
		// differently, and a fold that knew only one would record an empty
		// external reference — a fact nothing can join back to the object.
		const [event] = normalizeKubernetesYardSignal(
			signal("namespace.created", { name: "hobo-2" }),
		);
		expect(event?.data.externalRefs).toMatchObject({ namespace: "hobo-2" });
	});

	it("folds a created deployment into generation-provisioned", () => {
		const [event] = normalizeKubernetesYardSignal(
			signal("deployment.created", { uid: "u-1", namespace: "hobo-1" }),
		);
		expect(event?.type).toBe("yard.GenerationProvisioned");
		expect(event?.data.yardId).toBe("u-1");
	});

	it("folds an available deployment into the whole registration sequence", () => {
		// Four events in order. A consumer replaying these rebuilds the yard's
		// lifecycle; emitting only `Ready` would produce a yard that exists with
		// no record of being attested.
		const events = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1", attemptId: "a-1" }),
		);
		expect(events.map((event) => event.type)).toEqual([
			"yard.Registered",
			"yard.AttestationStarted",
			"yard.Attested",
			"yard.Ready",
		]);
	});

	it("registers the yard with kubernetes's substrate requirements", () => {
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1", regions: ["eu-west"] }),
		);
		expect(registered?.data.yard).toMatchObject({
			providerId: "kubernetes",
			layout: {
				require: expect.arrayContaining(["managed-container-substrate"]),
				regions: ["eu-west"],
			},
		});
	});

	it("defaults the region to in-cluster rather than registering none", () => {
		// A yard with no region cannot be placed against, so it would be
		// registered and then never selected — present and useless. `in-cluster`
		// is also the honest answer: a cluster's location is the operator's fact,
		// not something this provider can discover.
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1" }),
		);
		expect(registered?.data.yard).toMatchObject({
			layout: { regions: ["in-cluster"] },
		});
	});

	it("omits optional apiserver and namespace properties when absent", () => {
		// Conditional spread: an empty-string `kubernetes.apiServerUrl` would look
		// like a real address to whatever joined on it.
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1" }),
		);
		// Exact, not a subset: `properties: {}` inside toMatchObject would match
		// any object, including the empty-string key this test exists to catch.
		expect(registered?.data.yard).toEqual(
			expect.objectContaining({
				layout: expect.objectContaining({ properties: {} }),
			}),
		);
	});

	it("carries the apiserver and namespace through when present", () => {
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", {
				uid: "u-1",
				apiServerUrl: "https://apiserver.internal",
				namespace: "hobo-1",
			}),
		);
		expect(registered?.data.yard).toEqual(
			expect.objectContaining({
				layout: expect.objectContaining({
					properties: {
						"kubernetes.apiServerUrl": "https://apiserver.internal",
						"kubernetes.namespace": "hobo-1",
					},
				}),
			}),
		);
	});

	it("folds a failure into a typed failure fact", () => {
		const [event] = normalizeKubernetesYardSignal(
			signal("generation.failed", {
				code: "insufficient-nodes",
				message: "no schedulable node",
				retryable: true,
			}),
		);
		expect(event?.type).toBe("yard.GenerationFailed");
		expect(event?.data.failure).toMatchObject({
			code: "insufficient-nodes",
			retryable: true,
		});
	});

	it("defaults a failure that named no code or message", () => {
		// A fact with an empty code cannot be dispatched on, and a retry policy
		// reading one would treat every failure identically.
		const [event] = normalizeKubernetesYardSignal(signal("generation.failed"));
		expect(event?.data.failure).toMatchObject({
			code: expect.stringMatching(/./u),
			message: expect.stringMatching(/./u),
			retryable: false,
		});
	});

	it("treats anything but a literal true as not retryable", () => {
		// `=== true`. A truthy `"false"` string from a JSON payload would
		// otherwise put a permanently-failing generation into a retry loop.
		const truthy: JsonValue[] = ["true", 1, {}, "false"];
		for (const retryable of truthy) {
			const [event] = normalizeKubernetesYardSignal(
				signal("generation.failed", { retryable }),
			);
			expect(event?.data.failure).toMatchObject({ retryable: false });
		}
	});

	it("normalizes an unrecognised signal rather than dropping it", () => {
		// A dropped signal is a fact that silently never happened. A normalized
		// one is at least in the store for whoever adds the case later.
		const [event] = normalizeKubernetesYardSignal(
			signal("pod.evicted", { podName: "api-abc" }),
		);
		expect(event?.type).toBe("yard.ProviderSignalNormalized");
		expect(event?.data.kind).toBe("pod.evicted");
		expect(event?.data.payload).toEqual({ podName: "api-abc" });
	});

	it("stamps every event with the observation time it was given", () => {
		// The cluster's clock, not ours. Restamping with local time would make a
		// replayed backlog look like it all happened at import.
		for (const kind of [
			"namespace.created",
			"deployment.created",
			"deployment.available",
			"generation.failed",
			"unknown.kind",
		]) {
			for (const event of normalizeKubernetesYardSignal(signal(kind))) {
				expect(event.occurredAt).toBe("2026-01-01T00:00:00.000Z");
			}
		}
	});

	it("falls back to now when the signal carried no observation time", () => {
		// So an event is never written without a time — an undefined `occurredAt`
		// would sort unpredictably against everything else in the stream.
		const before = Date.now();
		const [event] = normalizeKubernetesYardSignal({
			providerId: "kubernetes",
			kind: "deployment.created",
			payload: {},
		});
		expect(Date.parse(String(event?.occurredAt))).toBeGreaterThanOrEqual(
			before - 1000,
		);
	});
});
