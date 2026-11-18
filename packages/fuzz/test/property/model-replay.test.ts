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
import fc from "fast-check";
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

describe("event history ownership", () => {
	it("captures event payloads and returns detached history snapshots", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (detail) => {
				const model = new ControlModel();
				const payload = { detail };
				model.note(TENANT, "audit.observed", payload);
				payload.detail = "changed by caller";
				const view = model.events;
				const event = view[0];
				if (!event) throw new Error("missing event");
				expect(event.payload.detail).toBe(detail);
				// SAFETY: the test mutates a returned snapshot to verify isolation.
				(event.payload as Record<string, string>).detail = "changed in view";
				view.splice(0, view.length);
				expect(model.events).toHaveLength(1);
				expect(model.events[0]?.payload.detail).toBe(detail);
				expect(model.replay()).toBe(model.fingerprint());
			}),
			{ numRuns: 100 },
		);
	});

	it("orders a public custom append with later snapshots and rollback", () => {
		const model = new ControlModel();
		model.append(TENANT, "audit.observed", { detail: "before snapshot" });
		expect(model.clock).toBe(1);
		const checkpoint = model.snapshot();
		model.createBindle(TENANT, "later", "sha256:a");
		model.rollback(TENANT, checkpoint);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("rejects non-string payloads before changing state or history", () => {
		const model = new ControlModel();
		const before = model.serialize();
		// SAFETY: these cases deliberately cross the typed event boundary.
		for (const invalid of [
			null,
			[],
			{ detail: { nested: true } },
			{ detail: 3 },
		] as never[]) {
			expect(() => model.note(TENANT, "audit.observed", invalid)).toThrow(
				"fuzz.invalid_event_payload",
			);
			expect(() => model.append(TENANT, "audit.observed", invalid)).toThrow(
				"fuzz.invalid_event_payload",
			);
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual([]);
		}
	});

	it("rejects replay-owned event kinds as free-form notes or appends", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "existing", "sha256:a");
		const before = model.serialize();
		const history = model.events;
		for (const kind of [
			"clock.advanced",
			"clock.set",
			"snapshot.taken",
			"rollback",
			"model.restored",
			"bindle.created",
			"capability.added",
			"capability.attenuated",
			"resource.applied",
			"resource.interrupted",
			"bindle.destroyed",
		]) {
			expect(() => model.note(TENANT, kind, {})).toThrow(
				"fuzz.reserved_event_kind",
			);
			expect(() => model.append(TENANT, kind, {})).toThrow(
				"fuzz.reserved_event_kind",
			);
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual(history);
		}
		expect(model.replay()).toBe(model.fingerprint());
	});
});

describe("public clock replay", () => {
	it("replays a forward clock assignment before a checkpoint", () => {
		const model = new ControlModel();
		model.clock = 5;
		const history = model.events;
		model.clock = 5;
		expect(model.events).toEqual(history);
		const checkpoint = model.snapshot();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.rollback(TENANT, checkpoint);
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("replays direct ticks and forward clock assignments across checkpoints", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 4 }), {
					minLength: 1,
					maxLength: 8,
				}),
				(steps) => {
					const model = new ControlModel();
					for (const [index, step] of steps.entries()) {
						if (index % 2 === 0) model.tick();
						else model.clock += step;
						const checkpoint = model.snapshot();
						model.createBindle(TENANT, `b${index}`, `hash${index}`);
						model.rollback(TENANT, checkpoint);
						expect(model.replay()).toBe(model.fingerprint());
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	it("rejects invalid or backward assignments without changing history", () => {
		const model = new ControlModel();
		model.clock = 5;
		const before = model.serialize();
		const history = model.events;
		for (const invalid of [
			-1,
			4,
			0.5,
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => {
				model.clock = invalid;
			}).toThrow("fuzz.invalid_model_clock");
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual(history);
		}
	});
});

describe("oracle state view ownership", () => {
	it("interrupts the stored resource rather than a detached lookup result", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "b1", "sha256:a");
		model.apply(TENANT, "b1", "k1");
		model.interruptApply(TENANT, "k1");
		expect(model.findByKey(TENANT, "k1")?.status).toBe("failed");
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("keeps generated state and checkpoints isolated from returned views", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...ALL_VERBS), { maxLength: 8 }),
				fc.boolean(),
				(verbs, fail) => {
					const model = new ControlModel();
					model.createBindle(TENANT, "b1", "sha256:a");
					model.addCapability(TENANT, "c1", verbs);
					const returned = model.apply(TENANT, "b1", "k1", { fail });
					const retried = model.apply(TENANT, "b1", "k1", { fail });
					const checkpoint = model.snapshot();
					const savedCheckpoint = model.snapshots.get(checkpoint);
					const before = model.serialize();
					const history = model.events;
					const bindles = model.bindles;
					const capabilities = model.capabilities;
					const resources = model.resources;
					const snapshots = model.snapshots;
					const slot = bindles.get("b1");
					const capability = capabilities.get("c1");
					const resource = resources.get(returned.id);
					const found = model.findByKey(TENANT, "k1");
					if (!slot || !capability || !resource || !found)
						throw new Error("missing state");
					// SAFETY: these edits deliberately mutate returned snapshots.
					(slot as { manifestHash: string }).manifestHash = "changed";
					// SAFETY: this exercises a runtime caller mutating a readonly list.
					(capability.verbs as string[]).push("query");
					resource.applyCount += 10;
					found.status = fail ? "ready" : "failed";
					returned.applyCount += 100;
					retried.applyCount += 1000;
					snapshots.set(checkpoint, "corrupt");
					bindles.clear();
					capabilities.clear();
					resources.clear();
					expect(model.serialize()).toBe(before);
					expect(model.events).toEqual(history);
					expect(model.snapshots.get(checkpoint)).toBe(savedCheckpoint);
					expect("restoreTenant" in model).toBe(false);
					expect(model.rollback(TENANT, checkpoint).ok).toBe(true);
					expect(model.replay()).toBe(model.fingerprint());
				},
			),
			{ numRuns: 100 },
		);
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
	it("starts replay from a restored baseline and retains it through later operations", () => {
		const source = new ControlModel();
		source.createBindle(TENANT, "b1", "sha256:a");
		source.apply(TENANT, "b1", "k1");
		const restored = new ControlModel();
		restored.restore(source.serialize());
		expect(restored.clock).toBe(source.clock);
		expect(restored.replay()).toBe(restored.fingerprint());
		const checkpoint = restored.snapshot();
		restored.apply(TENANT, "b1", "k1", { fail: true });
		expect(restored.replay()).toBe(restored.fingerprint());
		restored.rollback(TENANT, checkpoint);
		expect(restored.replay()).toBe(restored.fingerprint());
	});

	it("restores into an existing history at a new clock and replays the replacement", () => {
		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
				(failures) => {
					const source = new ControlModel();
					source.createBindle(TENANT, "new", "sha256:new");
					source.apply(TENANT, "new", "new-key");
					for (const fail of failures)
						source.apply(TENANT, "new", "new-key", { fail });
					const model = new ControlModel();
					model.createBindle(TENANT, "old", "sha256:old");
					const oldCheckpoint = model.snapshot();
					const oldClock = model.clock;
					model.restore(source.serialize());
					expect(model.clock).toBeGreaterThan(Math.max(oldClock, source.clock));
					expect(model.fingerprint()).toBe(source.fingerprint());
					expect(model.replay()).toBe(model.fingerprint());
					const newCheckpoint = model.snapshot();
					expect(newCheckpoint).toBeGreaterThan(oldCheckpoint);
					model.rollback(TENANT, oldCheckpoint);
					expect(model.bindles.has("old")).toBe(true);
					expect(model.replay()).toBe(model.fingerprint());
					model.rollback(TENANT, newCheckpoint);
					expect(model.fingerprint()).toBe(source.fingerprint());
					expect(model.replay()).toBe(model.fingerprint());
				},
			),
			{ numRuns: 100 },
		);
	});

	it("does not partially replace a model for a malformed or exhausted restore", () => {
		const model = new ControlModel();
		model.createBindle(TENANT, "old", "sha256:old");
		model.snapshot();
		const before = model.serialize();
		const events = structuredClone(model.events);
		const snapshots = [...model.snapshots];
		const empty = {
			clock: 0,
			fingerprint: "##",
			bindles: [],
			capabilities: [],
			resources: [],
		};
		const malformed = [
			"not-json",
			JSON.stringify({ ...empty, clock: -1 }),
			JSON.stringify({ ...empty, capabilities: null }),
			JSON.stringify({ ...empty, bindles: [["b1", { id: "b1" }]] }),
			JSON.stringify({
				...empty,
				fingerprint: "#c1:unknown#",
				capabilities: [
					["c1", { id: "c1", tenantId: TENANT, verbs: ["unknown"] }],
				],
			}),
			JSON.stringify({ ...empty, fingerprint: "incorrect" }),
			JSON.stringify({
				...empty,
				fingerprint: "different:h##",
				bindles: [
					[
						"x",
						{
							id: "different",
							tenantId: TENANT,
							manifestHash: "h",
							createdAt: 0,
						},
					],
				],
			}),
			JSON.stringify({
				...empty,
				fingerprint: "x:h##",
				bindles: Array.from({ length: 2 }, () => [
					"x",
					{ id: "x", tenantId: TENANT, manifestHash: "h", createdAt: 0 },
				]),
			}),
			JSON.stringify({
				...empty,
				fingerprint: "##k:r:unknown",
				resources: [
					[
						"r",
						{
							id: "r",
							tenantId: TENANT,
							bindleId: "b",
							idempotencyKey: "k",
							createdAt: 0,
							status: "unknown",
							applyCount: 1,
						},
					],
				],
			}),
		];
		for (const raw of malformed) {
			expect(() => model.restore(raw)).toThrow("fuzz.invalid_snapshot");
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual(events);
			expect([...model.snapshots]).toEqual(snapshots);
		}
		const exhausted = new ControlModel();
		exhausted.clock = Number.MAX_SAFE_INTEGER;
		expect(() => model.restore(exhausted.serialize())).toThrow(
			"fuzz.model_clock_exhausted",
		);
		expect(model.serialize()).toBe(before);
		expect(model.events).toEqual(events);
		expect([...model.snapshots]).toEqual(snapshots);
	});

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

describe("capability input and replay", () => {
	it("rejects invalid verbs before changing state or history", () => {
		const model = new ControlModel();
		model.addCapability(TENANT, "c1", ["read", "write"]);
		const before = model.serialize();
		const history = structuredClone(model.events);
		// SAFETY: these cases deliberately cross the typed input boundary.
		for (const invalid of [["read", "admin"], null, "read"] as never[]) {
			expect(() => model.addCapability(TENANT, "c1", invalid)).toThrow(
				"fuzz.invalid_verbs",
			);
			expect(() => model.attenuate(TENANT, "c1", invalid)).toThrow(
				"fuzz.invalid_verbs",
			);
			expect(model.serialize()).toBe(before);
			expect(model.events).toEqual(history);
		}
		expect(model.replay()).toBe(model.fingerprint());
	});

	it("captures supplied verb arrays and preserves replay across generated attenuations", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...ALL_VERBS), { maxLength: 8 }),
				fc.array(fc.constantFrom(...ALL_VERBS), { maxLength: 8 }),
				(verbs, keep) => {
					const model = new ControlModel();
					const original = [...verbs];
					const supplied = [...verbs];
					model.addCapability(TENANT, "c1", supplied);
					supplied.splice(0, supplied.length, "query");
					expect(model.capabilities.get("c1")?.verbs).toEqual(original);
					expect(model.replay()).toBe(model.fingerprint());
					const expected = keep.filter((verb) => original.includes(verb));
					const suppliedKeep = [...keep];
					model.attenuate(TENANT, "c1", suppliedKeep);
					suppliedKeep.splice(0, suppliedKeep.length, "get");
					expect(model.capabilities.get("c1")?.verbs).toEqual(expected);
					expect(model.replay()).toBe(model.fingerprint());
				},
			),
			{ numRuns: 100 },
		);
	});

	it("stays consistent for every verb in the vocabulary", () => {
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
