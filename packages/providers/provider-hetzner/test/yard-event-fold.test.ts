/**
 * Conformance of the hetzner Yard event-store fold.
 *
 * The module was 0% covered. Every provider in this workspace ships a fold with
 * the *same* external contract — a progress signal, a provisioned signal, a
 * ready signal that fans out to four events, a failure, and an
 * unrecognized-signal fallback — and that sameness is what lets the control
 * plane treat providers interchangeably. Nothing tested it, so a provider could
 * quietly emit a differently-shaped event and only be caught downstream.
 *
 * The assertions here are deliberately about the *contract*, not the payload
 * trivia: which event types are produced, in what order, and that `occurredAt`
 * is honoured rather than re-stamped.
 */
import { describe, expect, it } from "vitest";

import { isJsonObject, isJsonString, type JsonObject } from "../src/json.js";
import {
	HETZNER_EVENT_STORE_RESOLVER_ID,
	hetznerEventStoreFoldDescriptor,
	normalizeHetznerYardSignal,
} from "../src/yard-event-fold.js";

const AT = "2026-01-01T00:00:00.000Z";

const signal = (kind: string, payload: JsonObject = {}) => ({
	providerId: "hetzner" as const,
	kind,
	payload,
	observedAt: AT,
});

describe("hetzner generation progress", () => {
	it.each([
		"network.created",
	])("maps %s to a started GenerationProgressed", (kind) => {
		const [event, ...rest] = normalizeHetznerYardSignal(
			signal(kind, { attemptId: "a1", idempotencyKey: "k1" }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.GenerationProgressed");
		expect(event?.data).toMatchObject({
			attemptId: "a1",
			idempotencyKey: "k1",
			providerId: "hetzner",
			status: "started",
		});
		expect(event?.occurredAt).toBe(AT);
	});

	it.each(["server.created"])("maps %s to GenerationProvisioned", (kind) => {
		const [event, ...rest] = normalizeHetznerYardSignal(
			signal(kind, { attemptId: "a1", idempotencyKey: "k1" }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.GenerationProvisioned");
		expect(event?.data).toMatchObject({
			attemptId: "a1",
			providerId: "hetzner",
		});
	});

	it("defaults missing identifiers to empty strings rather than undefined", () => {
		const [event] = normalizeHetznerYardSignal(signal("network.created"));
		expect(event?.data).toMatchObject({ attemptId: "", idempotencyKey: "" });
	});
});

describe("hetzner readiness fan-out", () => {
	const ready = () =>
		normalizeHetznerYardSignal(
			signal("server.running", { yardId: "y1", attemptId: "a1" }),
		);

	it("emits registration, attestation and readiness in order", () => {
		expect(ready().map((e) => e.type)).toEqual([
			"yard.Registered",
			"yard.AttestationStarted",
			"yard.Attested",
			"yard.Ready",
		]);
	});

	it("threads the same yardId through every emitted event", () => {
		const [, started, attested, done] = ready();
		expect(started?.data).toMatchObject({ yardId: "y1" });
		expect(attested?.data).toMatchObject({ yardId: "y1" });
		expect(done?.data).toMatchObject({ yardId: "y1", attemptId: "a1" });
	});

	it("stamps every event with the observed time, not the wall clock", () => {
		for (const event of ready()) expect(event.occurredAt).toBe(AT);
	});

	it("registers a yard instance carrying this provider's id", () => {
		const [registered] = ready();
		if (registered === undefined) {
			throw new Error("expected a registered event");
		}
		const yard = registered.data.yard;
		if (!isJsonObject(yard)) {
			throw new Error("expected a yard instance");
		}
		expect(yard.providerId).toBe("hetzner");
		expect(yard.schemaVersion).toBe("hobo.yard-instance/v1");
		expect(yard.status).toBe("registering");
		expect(Array.isArray(yard.capabilities)).toBe(true);
	});
});

describe("hetzner failure", () => {
	it("carries the caller's code, message and retryable flag", () => {
		const [event] = normalizeHetznerYardSignal(
			signal("generation.failed", {
				attemptId: "a1",
				code: "quota",
				message: "out of quota",
				retryable: true,
			}),
		);
		expect(event?.type).toBe("yard.GenerationFailed");
		expect(event?.data).toMatchObject({
			providerId: "hetzner",
			failure: { code: "quota", message: "out of quota", retryable: true },
		});
	});

	it("falls back to a provider-specific code when none is supplied", () => {
		const [event] = normalizeHetznerYardSignal(signal("generation.failed"));
		if (event === undefined) {
			throw new Error("expected a failure event");
		}
		const failure = event.data.failure;
		if (!isJsonObject(failure) || !isJsonString(failure.code)) {
			throw new Error("expected a failure code");
		}
		expect(failure.code).toBe("hetzner-generation-failed");
	});

	it("treats retryable as strictly boolean true, not merely truthy", () => {
		for (const retryable of ["true", 1, { flagged: true }, null] as const) {
			const [event] = normalizeHetznerYardSignal(
				signal("generation.failed", { retryable }),
			);
			if (event === undefined) {
				throw new Error("expected a failure event");
			}
			const failure = event.data.failure;
			if (!isJsonObject(failure)) {
				throw new Error("expected a failure payload");
			}
			expect(failure.retryable).toBe(false);
		}
		const [missing] = normalizeHetznerYardSignal(signal("generation.failed"));
		if (missing === undefined) {
			throw new Error("expected a failure event");
		}
		const missingFailure = missing.data.failure;
		if (!isJsonObject(missingFailure)) {
			throw new Error("expected a failure payload");
		}
		expect(missingFailure.retryable).toBe(false);
	});
});

describe("hetzner unrecognized signals", () => {
	it("normalizes rather than dropping, preserving kind and payload", () => {
		const [event, ...rest] = normalizeHetznerYardSignal(
			signal("something.unheard.of", { a: 1 }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.ProviderSignalNormalized");
		expect(event?.data).toMatchObject({
			providerId: "hetzner",
			kind: "something.unheard.of",
			payload: { a: 1 },
		});
	});

	it("stamps a wall-clock time when the signal carries none", () => {
		const [event] = normalizeHetznerYardSignal({
			providerId: "hetzner",
			kind: "unknown",
			payload: {},
		});
		expect(() => new Date(event?.occurredAt ?? "").toISOString()).not.toThrow();
	});
});

describe("hetzner fold descriptor", () => {
	it("is frozen, so a caller cannot mutate the registry's view of it", () => {
		expect(Object.isFrozen(hetznerEventStoreFoldDescriptor())).toBe(true);
	});

	it("advertises the event-store slot under the pinned resolver id", () => {
		const descriptor = hetznerEventStoreFoldDescriptor();
		expect(descriptor.id).toBe(HETZNER_EVENT_STORE_RESOLVER_ID);
		expect(descriptor.providerId).toBe("hetzner");
		expect(descriptor.primitiveKind).toBe("yard");
		expect(descriptor.slot).toBe("event-store");
		expect(descriptor.requiresCapabilities).toContain("event-store");
		expect(descriptor.providesCapabilities).toContain("event-store");
	});

	it("keeps the resolver id stable, because stored events name it", () => {
		// A rename orphans every fact already written under the old id.
		expect(HETZNER_EVENT_STORE_RESOLVER_ID).toBe("hetzner.yard.event-store/v1");
	});
});
