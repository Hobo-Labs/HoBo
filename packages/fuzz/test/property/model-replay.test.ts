import { describe, expect, it } from "vitest";
import { dockerAvailable, schemathesisAvailable } from "../../src/env.js";
import { ALL_VERBS, ControlModel, type Verb } from "../../src/model.js";

const TENANT = "t1";

describe("replay reproduces the live fingerprint", () => {
	it("for an empty model", () => {
		const model = new ControlModel();
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after creating a bindle", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after adding and attenuating a capability", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.addCapability(TENANT, "c1", ["read", "write"]);
		model.attenuate(TENANT, "c1", ["read"]);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after a successful apply", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.apply(TENANT, "b1", "key-1", {});
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after a failed apply", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.apply(TENANT, "b1", "key-1", { fail: true });
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after an interrupted apply", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.apply(TENANT, "b1", "key-1", {});
		model.interruptApply(TENANT, "key-1");
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after destroying a bindle", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.apply(TENANT, "b1", "key-1", {});
		model.destroy(TENANT, "b1");
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after a snapshot and a rollback", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		const clock = model.snapshot();
		model.createBindle(TENANT, "b2", "sha256:def");
		model.rollback(TENANT, clock);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after a free-form note", () => {
		const model = new ControlModel();
		model.note(TENANT, "custom.kind", { detail: "x" });
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("across a long mixed history", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.addCapability(TENANT, "c1", ["read", "write", "query"]);
		model.apply(TENANT, "b1", "k1", {});
		const clock = model.snapshot();
		model.attenuate(TENANT, "c1", ["read"]);
		model.createBindle("t2", "b2", "sha256:b");
		model.apply("t2", "b2", "k2", { fail: true });
		model.interruptApply(TENANT, "k1");
		model.note(TENANT, "audit.observed", { note: "n" });
		model.rollback(TENANT, clock);
		model.destroy("t2", "b2");
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("keeps tenants isolated in the fingerprint", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.createBindle("t2", "b2", "sha256:b");
		expect(model.fingerprint(TENANT)).not.toBe(model.fingerprint("t2"));
		expect(model.replay()).toBe(model.fingerprint());
	});
});

describe("command dispatch", () => {
	function drive(model: ControlModel, commands: unknown[]) {
		for (const command of commands) {
			model.applyCommand(command as never);
		}
	}

	it("rolls back to the earliest snapshot when none is named", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		drive(model, [{ kind: "snapshot" }]);
		model.createBindle(TENANT, "b2", "sha256:b");
		drive(model, [{ kind: "snapshot" }]);
		model.createBindle(TENANT, "b3", "sha256:c");

		const verdict = model.applyCommand({
			kind: "rollback",
			tenantId: TENANT,
		} as never);
		expect(verdict).toBeDefined();
		expect(model.ownedCount(TENANT)).toBeLessThan(3);
	});

	it("returns undefined for a rollback with no snapshot to return to", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		expect(
			model.applyCommand({ kind: "rollback", tenantId: TENANT } as never),
		).toBeUndefined();
	});

	it("returns undefined for the commands that produce no verdict", () => {
		const model = new ControlModel();
		expect(
			model.applyCommand({
				kind: "createBindle",
				tenantId: TENANT,
				bindleId: "b1",
				manifestHash: "sha256:a",
			} as never),
		).toBeUndefined();
		expect(model.applyCommand({ kind: "snapshot" } as never)).toBeUndefined();
		expect(
			model.applyCommand({
				kind: "destroy",
				tenantId: TENANT,
				bindleId: "b1",
			} as never),
		).toBeUndefined();
	});

	it("advances the clock monotonically", () => {
		const model = new ControlModel();
		const first = model.tick();
		const second = model.tick();
		expect(second).toBeGreaterThan(first);
	});
});

describe("serialize / restore", () => {
	it("round-trips to the same fingerprint", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.addCapability(TENANT, "c1", ["read"]);
		model.apply(TENANT, "b1", "k1", {});

		const restored = new ControlModel();
		restored.restore(model.serialize());
		expect(restored.fingerprint()).toBe(model.fingerprint());
	});

	it("survives a round trip through a snapshot and rollback", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		const clock = model.snapshot();
		model.createBindle(TENANT, "b2", "sha256:b");
		model.rollback(TENANT, clock);

		const restored = new ControlModel();
		restored.restore(model.serialize());
		expect(restored.fingerprint()).toBe(model.fingerprint());
	});
});

describe("apply idempotency", () => {
	it("treats a repeat of the same idempotency key as the same resource", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.apply(TENANT, "b1", "k1", {});
		const afterFirst = model.ownedCount(TENANT);
		model.apply(TENANT, "b1", "k1", {});
		expect(model.ownedCount(TENANT)).toBe(afterFirst);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("finds a resource by its idempotency key", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.apply(TENANT, "b1", "k1", {});
		expect(model.findByKey(TENANT, "k1")).toBeDefined();
		expect(model.findByKey(TENANT, "nope")).toBeUndefined();
		expect(model.findByKey("t2", "k1")).toBeUndefined();
	});
});

describe("capability vocabulary", () => {
	it("rejects invalid verbs without changing state or recording an event", () => {
		const model = new ControlModel();
		const invalid = JSON.parse('["read","admin"]');
		const before = model.serialize();
		expect(() => model.addCapability(TENANT, "c1", invalid)).toThrow(
			"invalid capability verb",
		);
		expect(model.serialize()).toBe(before);
		expect(model.events).toEqual([]);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("does not retain the caller's mutable verb array", () => {
		const model = new ControlModel();
		const verbs: Verb[] = ["read"];
		model.addCapability(TENANT, "c1", verbs);
		verbs.push("write");
		expect(model.capabilities.get("c1")?.verbs).toEqual(["read"]);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("rejects invalid verbs before a cross-tenant refusal changes history", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", ["read"]);
		const before = model.serialize();
		const events = structuredClone(model.events);
		expect(() =>
			model.addCapability("other", "c1", JSON.parse('["admin"]')),
		).toThrow("invalid capability verb");
		expect(model.serialize()).toBe(before);
		expect(model.events).toEqual(events);
	});

	it("rejects invalid attenuation without changing state or history", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", ["read", "write"]);
		const before = model.serialize();
		const events = structuredClone(model.events);
		for (const [tenant, capability] of [
			[TENANT, "c1"],
			["other", "c1"],
			[TENANT, "missing"],
		] as const) {
			expect(() =>
				model.attenuate(tenant, capability, JSON.parse('["read", "admin"]')),
			).toThrow("invalid capability verb");
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual(events);
		}
	});

	it("rejects sparse verb arrays without changing state or history", () => {
		const model = new ControlModel();
		const verbs: Verb[] = [];
		verbs.length = 2;
		verbs[1] = "read";
		const before = model.serialize();
		expect(() => model.addCapability(TENANT, "c1", verbs)).toThrow(
			"invalid capability verb",
		);
		expect(() => model.attenuate(TENANT, "missing", verbs)).toThrow(
			"invalid capability verb",
		);
		expect(model.serialize()).toBe(before);
		expect(model.events).toEqual([]);
	});

	it("rejects capability events that omit their verb list", () => {
		for (const kind of ["capability.added", "capability.attenuated"] as const) {
			const model = new ControlModel();
			model.addCapability(TENANT, "c1", ["read"]);
			if (kind === "capability.attenuated") model.attenuate(TENANT, "c1", []);
			const index = model.events.findIndex((event) => event.kind === kind);
			const event = model.events[index];
			if (!event) throw new Error("missing capability event");
			model.events[index] = { ...event, payload: { capabilityId: "c1" } };
			expect(() => model.replay()).toThrow("missing capability verbs");
		}
	});

	it("rejects invalid verbs in recorded history", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", ["read"]);
		const event = model.events[0];
		if (!event) throw new Error("missing capability event");
		model.events[0] = {
			...event,
			payload: { ...event.payload, verbs: "read,admin" },
		};
		expect(() => model.replay()).toThrow("invalid capability verb");
	});

	it("round-trips every valid verb", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", [...ALL_VERBS]);
		expect(model.replay()).toBe(model.fingerprint());
	});
});

describe("environment probes", () => {
	it("reports docker unavailable when the opt-out is set", () => {
		const saved = process.env.HOBO_FUZZ_DOCKER;
		process.env.HOBO_FUZZ_DOCKER = "0";
		try {
			expect(dockerAvailable()).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.HOBO_FUZZ_DOCKER;
			else process.env.HOBO_FUZZ_DOCKER = saved;
		}
	});

	it("answers the schemathesis probe without throwing", () => {
		expect([true, false]).toContain(schemathesisAvailable());
	});
});
