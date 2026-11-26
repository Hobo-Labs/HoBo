import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	ALL_VERBS,
	attenuationOk,
	ControlModel,
	checkInvariants,
	hashManifest,
	type ModelCommand,
	sampleManifestRecord,
	tenantIsolationOk,
	type Verb,
} from "../../src/index.js";

const tenants = ["tenant-a", "tenant-b"] as const;
const bindles = ["bindle-1", "bindle-2", "bindle-3"] as const;
const keys = ["k1", "k2", "k3"] as const;
const caps = ["cap-1", "cap-2"] as const;

const tenantArb = fc.constantFrom(...tenants);
const bindleArb = fc.constantFrom(...bindles);
const keyArb = fc.constantFrom(...keys);
const capArb = fc.constantFrom(...caps);
const verbListArb = fc.uniqueArray(fc.constantFrom(...ALL_VERBS), {
	minLength: 1,
	maxLength: 4,
});

const commandArb: fc.Arbitrary<ModelCommand> = fc.oneof(
	fc.record({
		kind: fc.constant("createBindle" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
		manifestHash: fc.constant(hashManifest(sampleManifestRecord())),
	}),
	fc.record({
		kind: fc.constant("addCapability" as const),
		tenantId: tenantArb,
		capabilityId: capArb,
		verbs: verbListArb,
	}),
	fc.record({
		kind: fc.constant("attenuate" as const),
		tenantId: tenantArb,
		capabilityId: capArb,
		keep: verbListArb,
	}),
	fc.record({
		kind: fc.constant("resolveProvider" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
		provider: fc.constantFrom("lakebed", "memory"),
	}),
	fc.record({
		kind: fc.constant("plan" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
	}),
	fc.record({
		kind: fc.constant("apply" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
		idempotencyKey: keyArb,
		fail: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant("retryApply" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
		idempotencyKey: keyArb,
	}),
	fc.record({
		kind: fc.constant("interruptApply" as const),
		tenantId: tenantArb,
		idempotencyKey: keyArb,
	}),
	fc.record({
		kind: fc.constant("reconcile" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
	}),
	fc.record({
		kind: fc.constant("migrateProvider" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
		provider: fc.constantFrom("lakebed", "memory"),
	}),
	fc.record({
		kind: fc.constant("changeTenant" as const),
		bindleId: bindleArb,
		toTenantId: tenantArb,
	}),
	fc.record({
		kind: fc.constant("rotateSecretRef" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
	}),
	fc.constant({ kind: "snapshot" as const }),
	fc.record({
		kind: fc.constant("rollback" as const),
		tenantId: tenantArb,
		targetClock: fc.constantFrom(0),
	}),
	fc.record({
		kind: fc.constant("destroy" as const),
		tenantId: tenantArb,
		bindleId: bindleArb,
	}),
);

describe("control-plane reference model", () => {
	it("holds lifecycle oracles on random command traces", () => {
		fc.assert(
			fc.property(
				fc.array(commandArb, { minLength: 1, maxLength: 24 }),
				(cmds) => {
					const world = new ControlModel();
					world.snapshot();
					for (const command of cmds) {
						const before =
							command.kind === "attenuate"
								? world.capabilities.get(command.capabilityId)?.verbs
								: undefined;
						const rollback = world.applyCommand(command);
						if (rollback) expect(rollback.ok).toBe(true);
						if (command.kind === "attenuate" && before) {
							const after =
								world.capabilities.get(command.capabilityId)?.verbs ?? [];
							expect(attenuationOk(before, after).ok).toBe(true);
						}
					}
					for (const verdict of checkInvariants(world)) {
						expect(verdict.ok, verdict.message).toBe(true);
					}
				},
			),
			{ numRuns: 128 },
		);
	});

	it("apply(apply(x)) == apply(x) and retry never duplicates", () => {
		const world = new ControlModel();
		world.createBindle("tenant-a", "bindle-1", "h1");
		const first = world.apply("tenant-a", "bindle-1", "k1");
		const second = world.apply("tenant-a", "bindle-1", "k1");
		expect(second.id).toBe(first.id);
		expect(world.ownedCount("tenant-a")).toBe(1);
		world.apply("tenant-a", "bindle-1", "k1", { fail: true });
		world.apply("tenant-a", "bindle-1", "k1");
		expect(world.ownedCount("tenant-a")).toBe(1);
		expect(checkInvariants(world).every((row) => row.ok)).toBe(true);
	});

	it("destroy(create(x)) leaves no owned resources", () => {
		const world = new ControlModel();
		world.createBindle("tenant-a", "bindle-1", "h1");
		world.apply("tenant-a", "bindle-1", "k1");
		world.destroy("tenant-a", "bindle-1");
		expect(world.ownedCount("tenant-a")).toBe(0);
	});

	it("interrupt after destroy does not revive a resource", () => {
		const world = new ControlModel();
		world.createBindle("tenant-a", "bindle-1", "h1");
		world.apply("tenant-a", "bindle-1", "k1");
		world.destroy("tenant-a", "bindle-1");
		world.interruptApply("tenant-a", "k1");
		expect(world.ownedCount("tenant-a")).toBe(0);
		expect(checkInvariants(world).every((row) => row.ok)).toBe(true);
	});

	it("apply after destroy recreates instead of leaving a hole", () => {
		const world = new ControlModel();
		world.createBindle("tenant-a", "bindle-1", "h1");
		const first = world.apply("tenant-a", "bindle-1", "k1");
		world.destroy("tenant-a", "bindle-1");
		const again = world.apply("tenant-a", "bindle-1", "k1");
		expect(world.ownedCount("tenant-a")).toBe(1);
		expect(again.status).toBe("ready");
		expect(again.id).toBe(first.id);
		expect(checkInvariants(world).every((row) => row.ok)).toBe(true);
	});

	it("rollback restores the snapshot, not just the clock", () => {
		const world = new ControlModel();
		world.snapshot();
		const empty = world.fingerprint();
		world.createBindle("tenant-a", "bindle-1", "h1");
		world.apply("tenant-a", "bindle-1", "k1");
		expect(world.ownedCount("tenant-a")).toBe(1);
		const verdict = world.rollback("tenant-a", 0);
		expect(verdict.ok).toBe(true);
		expect(world.fingerprint()).toBe(empty);
		expect(world.ownedCount()).toBe(0);
		expect(world.replay()).toBe(world.fingerprint());
	});

	it("tenant A rollback cannot wipe tenant B", () => {
		const world = new ControlModel();
		world.snapshot();
		world.createBindle("tenant-b", "bindle-b", "hb");
		world.apply("tenant-b", "bindle-b", "kb");
		const beforeB = world.fingerprint("tenant-b");
		world.createBindle("tenant-a", "bindle-1", "h1");
		world.apply("tenant-a", "bindle-1", "k1");
		const verdict = world.rollback("tenant-a", 0);
		expect(verdict.ok).toBe(true);
		expect(world.fingerprint("tenant-b")).toBe(beforeB);
		expect(world.ownedCount("tenant-a")).toBe(0);
		expect(checkInvariants(world).every((row) => row.ok)).toBe(true);
	});

	it("tenant A operations never mutate tenant B state", () => {
		fc.assert(
			fc.property(
				fc.array(commandArb, { minLength: 2, maxLength: 20 }),
				(cmds) => {
					const world = new ControlModel();
					world.snapshot();
					world.createBindle("tenant-b", "bindle-b", "hb");
					world.apply("tenant-b", "bindle-b", "kb");
					const beforeB = world.fingerprint("tenant-b");
					for (const command of cmds) {
						if ("tenantId" in command && command.tenantId === "tenant-b") {
							continue;
						}
						if (
							command.kind === "changeTenant" &&
							command.toTenantId === "tenant-b"
						) {
							world.applyCommand(command);
							continue;
						}
						world.applyCommand(command);
					}
					expect(
						tenantIsolationOk(beforeB, world.fingerprint("tenant-b")).ok,
					).toBe(true);
				},
			),
			{ numRuns: 64 },
		);
	});

	it("apply without an owned bindle does not leak onto a later foreign create", () => {
		const world = new ControlModel();
		world.apply("tenant-a", "bindle-1", "k2", { fail: true });
		world.createBindle(
			"tenant-b",
			"bindle-1",
			hashManifest(sampleManifestRecord()),
		);
		world.apply("tenant-a", "bindle-2", "k2");
		expect(world.ownedCount("tenant-a")).toBe(0);
		expect(world.bindles.get("bindle-1")?.tenantId).toBe("tenant-b");
		expect(checkInvariants(world).every((row) => row.ok)).toBe(true);
	});

	it("replay(history(x)) == state(x)", () => {
		const world = new ControlModel();
		world.createBindle("tenant-a", "bindle-1", "h1");
		world.addCapability("tenant-a", "cap-1", ["get", "set"] satisfies Verb[]);
		world.attenuate("tenant-a", "cap-1", ["get"]);
		world.apply("tenant-a", "bindle-1", "k1", { fail: true });
		world.interruptApply("tenant-a", "k1");
		world.apply("tenant-a", "bindle-1", "k1");
		world.applyCommand({
			kind: "rotateSecretRef",
			tenantId: "tenant-a",
			bindleId: "bindle-1",
		});
		world.destroy("tenant-a", "bindle-1");
		world.apply("tenant-a", "bindle-1", "k1");
		expect(world.replay()).toBe(world.fingerprint());
	});
});
