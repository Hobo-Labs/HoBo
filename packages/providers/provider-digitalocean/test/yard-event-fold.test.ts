/**
 * Conformance of the digitalocean Yard event-store fold.
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
import { isJsonObject, type JsonObject } from "../src/json.js";

import {
	DIGITALOCEAN_EVENT_STORE_RESOLVER_ID,
	digitaloceanEventStoreFoldDescriptor,
	normalizeDigitalOceanYardSignal,
} from "../src/yard-event-fold.js";

const AT = "2026-01-01T00:00:00.000Z";

const signal = (kind: string, payload: JsonObject = {}) => ({
	providerId: "digitalocean" as const,
	kind,
	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	payload: payload as never,
	observedAt: AT,
});

describe("digitalocean generation progress", () => {
	it.each([
		"vpc.created",
	])("maps %s to a started GenerationProgressed", (kind) => {
		const [event, ...rest] = normalizeDigitalOceanYardSignal(
			signal(kind, { attemptId: "a1", idempotencyKey: "k1" }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.GenerationProgressed");
		expect(event?.data).toMatchObject({
			attemptId: "a1",
			idempotencyKey: "k1",
			providerId: "digitalocean",
			status: "started",
		});
		expect(event?.occurredAt).toBe(AT);
	});

	it.each(["app.created"])("maps %s to GenerationProvisioned", (kind) => {
		const [event, ...rest] = normalizeDigitalOceanYardSignal(
			signal(kind, { attemptId: "a1", idempotencyKey: "k1" }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.GenerationProvisioned");
		expect(event?.data).toMatchObject({
			attemptId: "a1",
			providerId: "digitalocean",
		});
	});

	it("defaults missing identifiers to empty strings rather than undefined", () => {
		const [event] = normalizeDigitalOceanYardSignal(signal("vpc.created"));
		expect(event?.data).toMatchObject({ attemptId: "", idempotencyKey: "" });
	});
});

describe("digitalocean readiness fan-out", () => {
	const ready = () =>
		normalizeDigitalOceanYardSignal(
			signal("app.active", { yardId: "y1", attemptId: "a1" }),
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
		if (registered === undefined) throw new Error("expected registered event");
		const yard = isJsonObject(registered.data.yard) ? registered.data.yard : {};
		expect(yard.providerId).toBe("digitalocean");
		expect(yard.schemaVersion).toBe("hobo.yard-instance/v1");
		expect(yard.status).toBe("registering");
		expect(Array.isArray(yard.capabilities)).toBe(true);
	});
});

describe("digitalocean failure", () => {
	it("carries the caller's code, message and retryable flag", () => {
		const [event] = normalizeDigitalOceanYardSignal(
			signal("generation.failed", {
				attemptId: "a1",
				code: "quota",
				message: "out of quota",
				retryable: true,
			}),
		);
		expect(event?.type).toBe("yard.GenerationFailed");
		expect(event?.data).toMatchObject({
			providerId: "digitalocean",
			failure: { code: "quota", message: "out of quota", retryable: true },
		});
	});

	it("falls back to a provider-specific code when none is supplied", () => {
		const [event] = normalizeDigitalOceanYardSignal(
			signal("generation.failed"),
		);
		if (event === undefined) throw new Error("expected failure event");
		const failure = isJsonObject(event.data.failure) ? event.data.failure : {};
		expect(failure.code).toBe("digitalocean-generation-failed");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats retryable as strictly boolean true, not merely truthy", () => {
		for (const retryable of ["true", 1, {}, null, undefined]) {
			const [event] = normalizeDigitalOceanYardSignal(
				// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
				signal("generation.failed", { retryable } as JsonObject),
			);
			if (event === undefined) throw new Error("expected failure event");
			const failure = isJsonObject(event.data.failure)
				? event.data.failure
				: {};
			expect(failure.retryable).toBe(false);
		}
	});
});

describe("digitalocean unrecognized signals", () => {
	it("normalizes rather than dropping, preserving kind and payload", () => {
		const [event, ...rest] = normalizeDigitalOceanYardSignal(
			signal("something.unheard.of", { a: 1 }),
		);
		expect(rest).toEqual([]);
		expect(event?.type).toBe("yard.ProviderSignalNormalized");
		expect(event?.data).toMatchObject({
			providerId: "digitalocean",
			kind: "something.unheard.of",
			payload: { a: 1 },
		});
	});

	it("stamps a wall-clock time when the signal carries none", () => {
		const [event] = normalizeDigitalOceanYardSignal({
			providerId: "digitalocean",
			kind: "unknown",
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			payload: {} as never,
		});
		expect(() => new Date(event?.occurredAt ?? "").toISOString()).not.toThrow();
	});
});

describe("digitalocean fold descriptor", () => {
	it("is frozen, so a caller cannot mutate the registry's view of it", () => {
		expect(Object.isFrozen(digitaloceanEventStoreFoldDescriptor())).toBe(true);
	});

	it("advertises the event-store slot under the pinned resolver id", () => {
		const descriptor = digitaloceanEventStoreFoldDescriptor();
		expect(descriptor.id).toBe(DIGITALOCEAN_EVENT_STORE_RESOLVER_ID);
		expect(descriptor.providerId).toBe("digitalocean");
		expect(descriptor.primitiveKind).toBe("yard");
		expect(descriptor.slot).toBe("event-store");
		expect(descriptor.requiresCapabilities).toContain("event-store");
		expect(descriptor.providesCapabilities).toContain("event-store");
	});

	it("keeps the resolver id stable, because stored events name it", () => {
		// A rename orphans every fact already written under the old id.
		expect(DIGITALOCEAN_EVENT_STORE_RESOLVER_ID).toBe(
			"digitalocean.yard.event-store/v1",
		);
	});
});
