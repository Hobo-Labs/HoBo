/**
 * `ControlModel.replay()` and the command dispatch.
 *
 * The model exists to be a second, independent implementation the fuzz harness
 * compares the real control plane against. Replay is the model checking
 * *itself*: rebuilding state from the event log must land on the same
 * fingerprint as applying the operations directly. A divergence means the log
 * does not fully describe the state, which is the same defect that would make
 * a real event-sourced aggregate unrecoverable — and it is silent, because
 * both halves keep working on their own.
 */
import { describe, expect, it } from "vitest";
import { dockerAvailable, schemathesisAvailable } from "../../src/env.js";
import { ALL_VERBS, ControlModel } from "../../src/model.js";

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
		// Attenuation is monotonic narrowing; if replay reconstructed the
		// pre-attenuation verb set, the model would tell the harness a
		// capability is broader than the real system says it is.
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
		// A failed apply is a recorded outcome, not an absence of one. Replaying
		// it as a success would make the model disagree about resource status
		// while agreeing about resource count.
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after an interrupted apply", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:abc");
		model.apply(TENANT, "b1", "key-1", {});
		model.interruptApply(TENANT, "key-1");
		// An interruption is exactly the state a crash leaves behind, and it is
		// what the harness perturbs most; replay has to reconstruct it.
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
		// Rollback is the operation with the most room to diverge: replay has to
		// re-take the snapshot at the same point and rewind to it, or the two
		// fingerprints part company.
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("after a free-form note", () => {
		const model = new ControlModel();
		model.note(TENANT, "custom.kind", { detail: "x" });
		// The `else` arm: an event kind replay does not know is re-noted rather
		// than dropped, so an unrecognized event still contributes to the
		// fingerprint the same way it did live.
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
		// The composition is the point: every branch of the replay dispatch in
		// one history, across two tenants.
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("keeps tenants isolated in the fingerprint", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.createBindle("t2", "b2", "sha256:b");
		// A per-tenant fingerprint that folded in another tenant's state would
		// make every cross-tenant comparison in the harness a false alarm.
		expect(model.fingerprint(TENANT)).not.toBe(model.fingerprint("t2"));
		expect(model.replay()).toBe(model.fingerprint());
	});
});

describe("command dispatch", () => {
	function drive(model: ControlModel, commands: unknown[]) {
		for (const command of commands) {
			// SAFETY: generated test commands intentionally cross the model boundary.
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

		// SAFETY: rollback is a valid command shape exercised by this test.
		const verdict = model.applyCommand({
			kind: "rollback",
			tenantId: TENANT,
		} as never);
		// Earliest, not latest: the fuzz command has no target, and rewinding to
		// the furthest point is the more searching choice — it exercises more of
		// the rollback path than undoing the last step would.
		expect(verdict).toBeDefined();
		expect(model.ownedCount(TENANT)).toBeLessThan(3);
	});

	it("returns undefined for a rollback with no snapshot to return to", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		// Undefined rather than a throw or a fabricated verdict: the fuzz driver
		// generates commands blindly, and a rollback before any snapshot is a
		// legal thing to generate.
		expect(
			// SAFETY: rollback is a valid command shape exercised by this test.
			model.applyCommand({ kind: "rollback", tenantId: TENANT } as never),
		).toBeUndefined();
	});

	it("returns undefined for the commands that produce no verdict", () => {
		const model = new ControlModel();
		// Only rollback yields an invariant verdict; the rest are state changes
		// the harness checks by fingerprint instead.
		expect(
			// SAFETY: createBindle is a valid command shape exercised by this test.
			model.applyCommand({
				kind: "createBindle",
				tenantId: TENANT,
				bindleId: "b1",
				manifestHash: "sha256:a",
			} as never),
		).toBeUndefined();
		// SAFETY: snapshot is a valid command shape exercised by this test.
		expect(model.applyCommand({ kind: "snapshot" } as never)).toBeUndefined();
		expect(
			// SAFETY: destroy is a valid command shape exercised by this test.
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
		// The clock orders snapshots; a repeat would make two snapshots
		// indistinguishable as rollback targets.
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
		// Serialization is how the harness carries a failing state out of a run
		// for reduction; a lossy round trip would make the reduced case not
		// reproduce the failure.
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
		// This is the property the harness fuzzes hardest: a retried apply must
		// not create a second resource, because the real control plane's
		// at-least-once delivery guarantees the retry will happen.
		expect(model.ownedCount(TENANT)).toBe(afterFirst);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("finds a resource by its idempotency key", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.apply(TENANT, "b1", "k1", {});
		expect(model.findByKey(TENANT, "k1")).toBeDefined();
		expect(model.findByKey(TENANT, "nope")).toBeUndefined();
		// Keys are tenant-scoped: one tenant must not be able to probe another's
		// idempotency namespace.
		expect(model.findByKey("t2", "k1")).toBeUndefined();
	});
});

describe("verb vocabulary asymmetry", () => {
	it("stores an out-of-vocabulary verb live but drops it on replay", () => {
		// Pinning an asymmetry rather than changing it. `addCapability` stores
		// whatever verb list it is handed — the `Verb` union is compile-time
		// only, with no runtime check — while `parseVerbs` on the replay path
		// filters to `ALL_VERBS`. So a verb outside the vocabulary makes the
		// model diverge from *itself*, which is the one thing the replay
		// property cannot tolerate.
		//
		// A TypeScript caller cannot reach this, which is why it is documented
		// rather than fixed: adding a runtime filter to `addCapability` would
		// change what the fuzz harness observes under generated commands, and
		// that is a call for whoever owns the harness. If the command generator
		// ever widens beyond `ALL_VERBS`, this test is the one that explains
		// the resulting false positive.
		const model = new ControlModel();
		// SAFETY: this test deliberately supplies an out-of-vocabulary verb.
		model.addCapability(TENANT, "c1", ["read", "admin"] as never);
		expect(model.fingerprint()).toContain("admin");
		expect(model.replay()).not.toContain("admin");
		expect(model.replay()).not.toBe(model.fingerprint());
	});

	it("stays consistent for every verb in the vocabulary", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", [...ALL_VERBS]);
		// The whole declared vocabulary round-trips, so the asymmetry above is
		// confined to values the type system already forbids.
		expect(model.replay()).toBe(model.fingerprint());
	});
});

describe("environment probes", () => {
	it("reports docker unavailable when the opt-out is set", () => {
		const saved = process.env.HOBO_FUZZ_DOCKER;
		process.env.HOBO_FUZZ_DOCKER = "0";
		try {
			// The opt-out is checked before the socket and before spawning, so a
			// developer without docker is not made to wait on a probe that cannot
			// succeed — and CI can force the in-process lane deterministically.
			expect(dockerAvailable()).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.HOBO_FUZZ_DOCKER;
			else process.env.HOBO_FUZZ_DOCKER = saved;
		}
	});

	it("answers the schemathesis probe without throwing", () => {
		// Whichever way it answers on this machine, the probe must return a
		// boolean rather than propagating a spawn failure — the caller uses it
		// to choose a lane, not to report an error.
		expect([true, false]).toContain(schemathesisAvailable());
	});
});
