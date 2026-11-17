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
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1" }),
		);
		expect(registered?.data.yard).toMatchObject({
			layout: { regions: ["in-cluster"] },
		});
	});

	it("omits optional apiserver and namespace properties when absent", () => {
		const [registered] = normalizeKubernetesYardSignal(
			signal("deployment.available", { uid: "u-1" }),
		);
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
		const [event] = normalizeKubernetesYardSignal(signal("generation.failed"));
		expect(event?.data.failure).toMatchObject({
			code: expect.stringMatching(/./u),
			message: expect.stringMatching(/./u),
			retryable: false,
		});
	});

	it("treats anything but a literal true as not retryable", () => {
		const truthy: JsonValue[] = ["true", 1, {}, "false"];
		for (const retryable of truthy) {
			const [event] = normalizeKubernetesYardSignal(
				signal("generation.failed", { retryable }),
			);
			expect(event?.data.failure).toMatchObject({ retryable: false });
		}
	});

	it("normalizes an unrecognised signal rather than dropping it", () => {
		const [event] = normalizeKubernetesYardSignal(
			signal("pod.evicted", { podName: "api-abc" }),
		);
		expect(event?.type).toBe("yard.ProviderSignalNormalized");
		expect(event?.data.kind).toBe("pod.evicted");
		expect(event?.data.payload).toEqual({ podName: "api-abc" });
	});

	it("stamps every event with the observation time it was given", () => {
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
