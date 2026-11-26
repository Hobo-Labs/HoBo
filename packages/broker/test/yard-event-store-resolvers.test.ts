/**
 * Tests for the provider-owned Yard event-store fold resolvers.
 *
 * The module sat at 29.6% branch coverage. It is the seam that keeps the core
 * fold provider-neutral: every provider lowers its own control-plane signals to
 * `yard.*` facts, and everything downstream folds those facts without knowing
 * which cloud produced them. If a provider's normalization drifts, the fold
 * still succeeds — it just builds the wrong picture — so this is exactly the
 * kind of code where an untested branch produces a confident wrong answer.
 *
 * `foldAll` is the interesting surface: it accepts a mixed stream of raw
 * provider signals and already-normalized events, and assigns sequence numbers.
 * Those two behaviours together are what make replay deterministic.
 */

import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "../src/json.js";

import {
	createAwsYardEventStoreFoldResolver,
	createAzureYardEventStoreFoldResolver,
	createDefaultEventStoreFoldResolvers,
	createEventStoreFoldResolverRegistry,
	createGcpYardEventStoreFoldResolver,
	createLocalYardEventStoreFoldResolver,
	createYardEventStoreFoldResolver,
	defaultNormalize,
	EVENT_STORE_SLOT,
	isProviderNativeSignal,
	type ProviderNativeSignal,
} from "../src/yard-placement/event-store-resolvers.js";
import { YARD_EVENTS } from "../src/yard-placement/events.js";

const AT = "2026-01-01T00:00:00.000Z";

const signal = (
	kind: string,
	payload: JsonObject = {},
	providerId = "local",
): ProviderNativeSignal =>
	// SAFETY: assertion required at this I/O or test boundary.
	({ providerId, kind, payload, observedAt: AT }) as ProviderNativeSignal;

describe("isProviderNativeSignal", () => {
	it("accepts a well-formed signal", () => {
		expect(isProviderNativeSignal(signal("yard.ready"))).toBe(true);
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["a string", "signal"],
		["a number", 7],
		["a missing providerId", { kind: "k", payload: {} }],
		["a missing kind", { providerId: "p", payload: {} }],
		["a non-string kind", { providerId: "p", kind: 1, payload: {} }],
		["a null payload", { providerId: "p", kind: "k", payload: null }],
		["a non-object payload", { providerId: "p", kind: "k", payload: "x" }],
		["a missing payload", { providerId: "p", kind: "k" }],
	])("rejects %s", (_label, value) => {
		expect(isProviderNativeSignal(value)).toBe(false);
	});

	it("accepts an array payload, since arrays are objects", () => {
		// Documented as current behaviour rather than endorsed: the guard checks
		// layout, and the normalizers only read named keys.
		expect(
			isProviderNativeSignal({ providerId: "p", kind: "k", payload: [] }),
		).toBe(true);
	});
});

describe("defaultNormalize", () => {
	it("maps registration signals under either spelling", () => {
		for (const kind of ["yard.registered", "controlPlane.registered"]) {
			const [event] = defaultNormalize(signal(kind, { yardId: "y1" }));
			expect(event?.type).toBe(YARD_EVENTS.Registered);
		}
	});

	it("maps readiness signals under either spelling", () => {
		for (const kind of ["yard.ready", "controlPlane.ready"]) {
			const [event] = defaultNormalize(signal(kind, { yardId: "y1" }));
			expect(event?.type).toBe(YARD_EVENTS.Ready);
			expect(event?.data).toMatchObject({ yardId: "y1" });
		}
	});

	it("falls back from yardId to id when naming a yard", () => {
		const [event] = defaultNormalize(signal("yard.ready", { id: "y2" }));
		expect(event?.data).toMatchObject({ yardId: "y2" });
	});

	it("includes attemptId only when the payload carries one", () => {
		const [with_] = defaultNormalize(
			signal("yard.ready", { yardId: "y1", attemptId: "a1" }),
		);
		expect(with_?.data).toMatchObject({ attemptId: "a1" });
		const [without] = defaultNormalize(signal("yard.ready", { yardId: "y1" }));
		expect(without?.data).not.toHaveProperty("attemptId");
	});

	it("maps the attestation pair to distinct events", () => {
		expect(defaultNormalize(signal("yard.attesting"))[0]?.type).toBe(
			YARD_EVENTS.AttestationStarted,
		);
		expect(defaultNormalize(signal("yard.attested"))[0]?.type).toBe(
			YARD_EVENTS.Attested,
		);
	});

	it("honours observedAt rather than stamping the wall clock", () => {
		const [event] = defaultNormalize(signal("yard.ready", { yardId: "y" }));
		expect(event?.occurredAt).toBe(AT);
	});

	it("stamps a wall-clock time when the signal carries none", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const [event] = defaultNormalize({
			providerId: "local",
			kind: "yard.ready",
			payload: { yardId: "y" },
		} as ProviderNativeSignal);
		expect(() => new Date(event?.occurredAt ?? "").toISOString()).not.toThrow();
	});
});

describe("resolver descriptor", () => {
	const resolver = createYardEventStoreFoldResolver({
		providerId: "acme",
		resolverId: "acme.yard.event-store/v1",
	});

	it("is frozen, along with the resolver itself", () => {
		expect(Object.isFrozen(resolver)).toBe(true);
		expect(Object.isFrozen(resolver.descriptor)).toBe(true);
	});

	it("claims the event-store slot for the yard primitive", () => {
		expect(resolver.descriptor.slot).toBe(EVENT_STORE_SLOT);
		expect(resolver.descriptor.primitiveKind).toBe("yard");
		expect(resolver.descriptor.providerId).toBe("acme");
	});

	it("defaults the version to 1 and honours an override", () => {
		expect(resolver.descriptor.version).toBe("1");
		expect(
			createYardEventStoreFoldResolver({
				providerId: "acme",
				resolverId: "acme.yard.event-store/v2",
				version: "2",
			}).descriptor.version,
		).toBe("2");
	});

	it("derives implementationRef and remediation from the provider", () => {
		expect(resolver.descriptor.implementationRef).toBe(
			"acme/resolvers/event-store-fold",
		);
		expect(resolver.descriptor.remediation).toContain("acme");
	});
});

describe("foldAll", () => {
	const resolver = createLocalYardEventStoreFoldResolver();

	it("starts from an empty state for the broker", () => {
		expect(resolver.foldAll("broker-1", [])).toEqual(
			resolver.initialState("broker-1"),
		);
	});

	it("normalizes raw signals and folds already-normalized events alike", () => {
		// A raw signal registers the yard; a pre-normalized event then folds on
		// top of it without going through normalize() at all.
		const mixed = resolver.foldAll("b", [
			signal("componentHost.ready", { yardId: "y1" }),
			// SAFETY: assertion required at this I/O or test boundary.
			{ type: YARD_EVENTS.Ready, data: { yardId: "y1" } } as never,
		]);
		expect(Object.keys(mixed.yards)).toContain("y1");
		expect(mixed.brokerId).toBe("b");
	});

	it("counts emitted events, not inputs, when assigning sequence numbers", () => {
		// componentHost.ready lowers to *two* events, so two inputs produce three.
		const state = resolver.foldAll("b", [
			signal("componentHost.ready", { yardId: "y1" }),
			signal("yard.attesting", { yardId: "y1" }),
		]);
		expect(state.seq).toBe(3);
	});

	it("preserves an explicit seq rather than overwriting it", () => {
		const state = resolver.foldAll("b", [
			// SAFETY: assertion required at this I/O or test boundary.
			{ type: YARD_EVENTS.Ready, data: { yardId: "y" }, seq: 99 } as never,
		]);
		expect(state.seq).toBe(99);
	});

	it("runs afterFold once per event when supplied", () => {
		let calls = 0;
		const counting = createYardEventStoreFoldResolver({
			providerId: "acme",
			resolverId: "acme.yard.event-store/v1",
			afterFold: (state) => {
				calls += 1;
				return state;
			},
		});
		counting.foldAll("b", [
			signal("yard.registered", { yardId: "y1" }, "acme"),
			signal("yard.ready", { yardId: "y1" }, "acme"),
		]);
		expect(calls).toBe(2);
	});

	it("uses the core fold unchanged when afterFold is absent", () => {
		const plain = createYardEventStoreFoldResolver({
			providerId: "acme",
			resolverId: "acme.yard.event-store/v1",
		});
		const state = plain.foldAll("b", [
			signal("yard.registered", { yardId: "y" }, "acme"),
		]);
		expect(state.seq).toBe(1);
		expect(Object.keys(state.yards)).toContain("y");
	});

	it("leaves the initial state untouched — folding returns a new state", () => {
		const initial = resolver.initialState("b");
		const folded = resolver.foldAll("b", [
			signal("componentHost.ready", { yardId: "y1" }),
		]);
		expect(initial.seq).toBe(0);
		expect(initial.yards).toEqual({});
		expect(folded.seq).toBeGreaterThan(0);
	});
});

describe("local resolver", () => {
	const resolver = createLocalYardEventStoreFoldResolver();

	it("lowers componentHost.ready to registration then readiness", () => {
		const events = resolver.normalize(
			signal("componentHost.ready", { yardId: "y1" }),
		);
		expect(events.map((e) => e.type)).toEqual([
			YARD_EVENTS.Registered,
			YARD_EVENTS.Ready,
		]);
	});

	it("defaults the yard id when the signal omits one", () => {
		const [, ready] = resolver.normalize(signal("componentHost.ready"));
		expect(ready?.data).toMatchObject({ yardId: "yard:local" });
	});

	it("defaults component hosts to local, wasm and oci", () => {
		const [registered] = resolver.normalize(signal("componentHost.ready"));
		if (!isJsonObject(registered?.data)) {
			throw new Error("expected registered yard data");
		}
		const yard = registered.data.yard;
		if (!isJsonObject(yard) || !isJsonObject(yard.layout)) {
			throw new Error("expected yard layout");
		}
		expect(yard.layout.componentHosts).toEqual(["local", "wasm", "oci"]);
	});

	it("keeps component hosts the signal declares", () => {
		const [registered] = resolver.normalize(
			signal("componentHost.ready", { componentHosts: ["wasm"] }),
		);
		if (!isJsonObject(registered?.data)) {
			throw new Error("expected registered yard data");
		}
		const yard = registered.data.yard;
		if (!isJsonObject(yard) || !isJsonObject(yard.layout)) {
			throw new Error("expected yard layout");
		}
		expect(yard.layout.componentHosts).toEqual(["wasm"]);
	});

	it("falls through to the default mapping for other signals", () => {
		expect(
			resolver.normalize(signal("yard.attested", { yardId: "y" }))[0]?.type,
		).toBe(YARD_EVENTS.Attested);
	});

	it("can be registered under an alternate provider id", () => {
		const aliased = createLocalYardEventStoreFoldResolver(
			"@hobo/provider-local-host",
		);
		expect(aliased.providerId).toBe("@hobo/provider-local-host");
		expect(aliased.descriptor.id).toBe(
			"@hobo/provider-local-host.yard.event-store/v1",
		);
	});
});

describe("cloud resolvers", () => {
	const cases = [
		{
			name: "azure",
			resolver: createAzureYardEventStoreFoldResolver(),
			started: [
				"resourceGroup.created",
				"Microsoft.Resources/resourceGroups/write",
			],
			provisioned: [
				"managedEnvironment.created",
				"Microsoft.App/managedEnvironments/write",
			],
		},
		{
			name: "aws",
			resolver: createAwsYardEventStoreFoldResolver(),
			started: ["vpc.created", "ec2:CreateVpc"],
			provisioned: ["ecs.cluster.created", "ecs:CreateCluster"],
		},
		{
			name: "gcp",
			resolver: createGcpYardEventStoreFoldResolver(),
			started: ["network.created", "compute.networks.create"],
			provisioned: ["cloudRun.service.created", "run.services.create"],
		},
	];

	it.each(cases)("$name advertises its own provider id", ({
		name,
		resolver,
	}) => {
		expect(resolver.providerId).toBe(name);
		expect(resolver.descriptor.id).toBe(`${name}.yard.event-store/v1`);
	});

	it.each(cases)("$name maps both spellings of its start signal", ({
		name,
		resolver,
		started,
	}) => {
		for (const kind of started) {
			const [event] = resolver.normalize(signal(kind, {}, name));
			expect(event?.type).toBe(YARD_EVENTS.GenerationProgressed);
			expect(event?.data).toMatchObject({
				providerId: name,
				status: "started",
			});
		}
	});

	it.each(cases)("$name maps both spellings of its provisioned signal", ({
		name,
		resolver,
		provisioned,
	}) => {
		for (const kind of provisioned) {
			const [event] = resolver.normalize(signal(kind, {}, name));
			expect(event?.type).toBe(YARD_EVENTS.GenerationProvisioned);
		}
	});

	it.each(
		cases,
	)("$name falls through to the default mapping for shared signals", ({
		name,
		resolver,
	}) => {
		const [event] = resolver.normalize(
			signal("yard.attested", { yardId: "y" }, name),
		);
		expect(event?.type).toBe(YARD_EVENTS.Attested);
	});
});

describe("registry", () => {
	it("looks a resolver up by provider id", () => {
		const registry = createEventStoreFoldResolverRegistry(
			createDefaultEventStoreFoldResolvers(),
		);
		expect(registry.get("aws")?.providerId).toBe("aws");
		expect(registry.get("nonesuch")).toBeUndefined();
	});

	it("lets a later registration win for the same provider", () => {
		const first = createYardEventStoreFoldResolver({
			providerId: "dup",
			resolverId: "dup.yard.event-store/v1",
		});
		const second = createYardEventStoreFoldResolver({
			providerId: "dup",
			resolverId: "dup.yard.event-store/v2",
			version: "2",
		});
		const registry = createEventStoreFoldResolverRegistry([first, second]);
		expect(registry.get("dup")?.descriptor.version).toBe("2");
		// `all` is de-duplicated by provider; `descriptors` reports what was given.
		expect(registry.all()).toHaveLength(1);
		expect(registry.descriptors()).toHaveLength(2);
	});

	it("returns frozen collections", () => {
		const registry = createEventStoreFoldResolverRegistry(
			createDefaultEventStoreFoldResolvers(),
		);
		expect(Object.isFrozen(registry.all())).toBe(true);
		expect(Object.isFrozen(registry.descriptors())).toBe(true);
	});

	it("ships local, its alias, azure, aws and gcp by default", () => {
		const defaults = createDefaultEventStoreFoldResolvers();
		expect(defaults.map((r) => r.providerId)).toEqual([
			"local",
			"@hobo/provider-local-host",
			"azure",
			"aws",
			"gcp",
		]);
		expect(Object.isFrozen(defaults)).toBe(true);
	});

	it("gives every default resolver a distinct descriptor id", () => {
		const ids = createDefaultEventStoreFoldResolvers().map(
			(r) => r.descriptor.id,
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
