/**
 * The Hostinger event-store fold, read through the payloads Hostinger sends:
 * which spelling of an id it accepts, what it defaults when a field is absent,
 * and that it keeps the provider's observation time. The fold's shared event
 * contract is pinned in `yard-event-fold.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../src/json.js";
import {
	HOSTINGER_EVENT_STORE_RESOLVER_ID,
	type HostingerProviderNativeSignal,
	hostingerEventStoreFoldDescriptor,
	normalizeHostingerYardSignal,
} from "../src/yard-event-fold.js";

describe("event-store fold", () => {
	function signal(
		kind: string,
		payload: JsonObject = {},
	): HostingerProviderNativeSignal {
		return {
			providerId: "hostinger",
			kind,
			payload,
			observedAt: "2026-01-01T00:00:00.000Z",
		};
	}

	it("publishes the resolver id stored events are written under", () => {
		// A rename orphans every fact already written under the old id, so this
		// string is a migration, not a label.
		expect(HOSTINGER_EVENT_STORE_RESOLVER_ID).toBe(
			"hostinger.yard.event-store/v1",
		);
		expect(hostingerEventStoreFoldDescriptor().implementationRef).toContain(
			"hostinger",
		);
	});

	it("folds a created DNS zone into generation-started", () => {
		const [event] = normalizeHostingerYardSignal(
			signal("dns.zone.created", { attemptId: "a-1", zoneId: "z-1" }),
		);
		expect(event?.type).toBe("yard.GenerationProgressed");
		expect(event?.data.status).toBe("started");
		expect(event?.data.externalRefs).toMatchObject({ zoneId: "z-1" });
	});

	it("accepts the provider's bare id when no zoneId is spelled out", () => {
		// `p.zoneId ?? p.id`. Hostinger's payloads use both spellings depending on
		// the endpoint, and a fold that knew only one would record an empty
		// external reference — a fact that cannot be joined back to the resource.
		const [event] = normalizeHostingerYardSignal(
			signal("dns.zone.created", { id: "z-9" }),
		);
		expect(event?.data.externalRefs).toMatchObject({ zoneId: "z-9" });
	});

	it("folds a created VPS into generation-provisioned", () => {
		const [event] = normalizeHostingerYardSignal(
			signal("vps.created", { virtualMachineId: "vm-1", attemptId: "a-1" }),
		);
		expect(event?.type).toBe("yard.GenerationProvisioned");
		expect(event?.data.yardId).toBe("vm-1");
	});

	it("folds a running VPS into the whole registration sequence", () => {
		// Four events in order: registered, attestation started, attested, ready.
		// A consumer replaying these rebuilds the yard's lifecycle; emitting only
		// `Ready` would produce a yard that exists with no record of being
		// attested.
		const events = normalizeHostingerYardSignal(
			signal("vps.running", { virtualMachineId: "vm-1", attemptId: "a-1" }),
		);
		expect(events.map((event) => event.type)).toEqual([
			"yard.Registered",
			"yard.AttestationStarted",
			"yard.Attested",
			"yard.Ready",
		]);
	});

	it("describes the registered yard with hostinger's substrate requirements", () => {
		const [registered] = normalizeHostingerYardSignal(
			signal("vps.running", { virtualMachineId: "vm-1", regions: ["ams"] }),
		);
		expect(registered?.data.yard).toMatchObject({
			providerId: "hostinger",
			layout: {
				regions: ["ams"],
				require: expect.arrayContaining(["managed-container-substrate"]),
			},
		});
	});

	it("defaults the region rather than registering a yard with none", () => {
		// A yard with no region cannot be placed against, so it would be
		// registered and then never selected — present and useless.
		const [registered] = normalizeHostingerYardSignal(
			signal("vps.running", { virtualMachineId: "vm-1" }),
		);
		expect(registered?.data.yard).toMatchObject({
			layout: { regions: ["phx"] },
		});
	});

	it("omits optional account and zone properties when the payload lacks them", () => {
		// Conditional spread again: an empty-string `hostinger.accountRef` would
		// look like a real reference to whatever joined on it.
		const [registered] = normalizeHostingerYardSignal(
			signal("vps.running", { virtualMachineId: "vm-1" }),
		);
		// Exact, not a subset: `properties: {}` inside toMatchObject would match
		// any object, including the empty-string key this test exists to catch.
		expect(registered?.data.yard).toEqual(
			expect.objectContaining({
				layout: expect.objectContaining({ properties: {} }),
			}),
		);
	});

	it("carries account and zone references through when present", () => {
		const [registered] = normalizeHostingerYardSignal(
			signal("vps.running", {
				virtualMachineId: "vm-1",
				accountRef: "acct-1",
				zoneId: "z-1",
			}),
		);
		expect(registered?.data.yard).toEqual(
			expect.objectContaining({
				layout: expect.objectContaining({
					properties: {
						"hostinger.accountRef": "acct-1",
						"hostinger.zoneId": "z-1",
					},
				}),
			}),
		);
	});

	it("folds a failure into a typed failure fact", () => {
		const [event] = normalizeHostingerYardSignal(
			signal("generation.failed", {
				code: "quota-exceeded",
				message: "no capacity in phx",
				retryable: true,
			}),
		);
		expect(event?.type).toBe("yard.GenerationFailed");
		expect(event?.data.failure).toEqual({
			code: "quota-exceeded",
			message: "no capacity in phx",
			retryable: true,
		});
	});

	it("defaults a failure that named no code or message", () => {
		// A fact with an empty code cannot be dispatched on, and a retry policy
		// reading one would treat every failure the same.
		const [event] = normalizeHostingerYardSignal(signal("generation.failed"));
		expect(event?.data.failure).toEqual({
			code: "hostinger-generation-failed",
			message: "Hostinger yard generation failed",
			retryable: false,
		});
	});

	it("treats anything but a literal true as not retryable", () => {
		// `=== true`. A truthy string like `"false"` from a JSON payload would
		// otherwise put a permanently-failing generation into a retry loop.
		const truthy: JsonValue[] = ["true", 1, {}, "false"];
		for (const retryable of truthy) {
			const [event] = normalizeHostingerYardSignal(
				signal("generation.failed", { retryable }),
			);
			expect(event?.data.failure).toMatchObject({ retryable: false });
		}
	});

	it("normalizes an unrecognised signal rather than dropping it", () => {
		// The default arm, and the reason it exists. A dropped signal is a fact
		// that silently never happened; a normalized one is at least in the store
		// for whoever adds the case later.
		const [event] = normalizeHostingerYardSignal(
			signal("vps.snapshot.created", { snapshotId: "s-1" }),
		);
		expect(event?.type).toBe("yard.ProviderSignalNormalized");
		expect(event?.data.kind).toBe("vps.snapshot.created");
		expect(event?.data.payload).toEqual({ snapshotId: "s-1" });
	});

	it("stamps every event with the observation time it was given", () => {
		// The provider's clock, not ours. Restamping with local time would make
		// a replayed backlog look like it all happened at import.
		for (const kind of [
			"dns.zone.created",
			"vps.created",
			"vps.running",
			"generation.failed",
			"unknown.kind",
		]) {
			for (const event of normalizeHostingerYardSignal(signal(kind))) {
				expect(event.occurredAt).toBe("2026-01-01T00:00:00.000Z");
			}
		}
	});

	it("falls back to now when the signal carried no observation time", () => {
		// So an event is never written without a time. An undefined `occurredAt`
		// would sort unpredictably against every other event in the stream.
		const before = Date.now();
		const [event] = normalizeHostingerYardSignal({
			providerId: "hostinger",
			kind: "vps.created",
			payload: {},
		});
		expect(Date.parse(String(event?.occurredAt))).toBeGreaterThanOrEqual(
			before - 1000,
		);
	});
});
