/**
 * The yard event-store fold, read as a state machine rather than a projection.
 *
 * `yard-event-store-folds.test.ts` covers the happy path and the provider
 * resolvers that feed this fold. This covers what the fold does when the facts
 * are *not* well-formed or arrive out of the order anyone drew on a whiteboard —
 * which is the only order a real event stream guarantees.
 *
 * Three properties are worth stating up front, because most of what follows is
 * a consequence of one of them:
 *
 * **A fact that names nothing changes nothing but the sequence.** Every branch
 * that reads an id from `data` guards on it. A malformed fact that silently
 * created a row keyed on `""` would put a phantom yard in the inventory
 * snapshot, and the snapshot is content-hashed and pinned — so one bad event
 * would make two brokers that saw the same stream disagree on the hash.
 *
 * **The idempotency lease keeps the winner.** Two generation attempts racing on
 * one key is the normal case under retry, not an anomaly. The first attempt to
 * claim a key owns it until it *fails*, and only then may a successor take it.
 * If the loser could overwrite the winner, a retry would detach the caller from
 * the infrastructure their first attempt actually provisioned.
 *
 * **The snapshot round-trip is schema-guarded in one direction only.** Restore
 * refuses an unknown schema rather than best-efforting it, because a fold state
 * restored under the wrong layout is a broker confidently serving placements
 * from a projection it never built.
 */

import { describe, expect, it } from "vitest";
import {
	emptyYardEventStoreState,
	foldYardEventStore,
	foldYardEventStoreAll,
	inventorySnapshotFromFold,
	localYardInstance,
	restoreYardEventStore,
	snapshotYardEventStore,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const yardOf = (yardId: string) =>
	localYardInstance({ yardId, ownerTenantId: "t1", providerId: "local" });

const empty = () => emptyYardEventStoreState("broker:test");

const fold = (...events: Parameters<typeof yardEvent>[]) =>
	foldYardEventStoreAll(
		"broker:test",
		events.map((args) => yardEvent(...args)),
	);

describe("the empty state", () => {
	it("carries the broker id it was opened for", () => {
		expect(empty().brokerId).toBe("broker:test");
	});

	it("starts at sequence zero", () => {
		expect(empty().seq).toBe(0);
	});

	it("is frozen, so a caller cannot mutate the projection in place", () => {
		// The fold's whole claim is that state is rebuildable from facts. A
		// caller who could poke a yard into `state.yards` would produce a state
		// no replay reproduces.
		expect(Object.isFrozen(empty())).toBe(true);
		expect(Object.isFrozen(empty().yards)).toBe(true);
	});

	it("has no yards, attempts or placements", () => {
		const state = empty();
		expect(state.yards).toEqual({});
		expect(state.generationAttempts).toEqual({});
		expect(state.placements).toEqual({});
		expect(state.lastMatchByRequest).toEqual({});
	});
});

describe("sequencing", () => {
	it("takes the sequence an event declares", () => {
		const state = foldYardEventStore(
			empty(),
			yardEvent(YARD_EVENTS.Registered, { yard: yardOf("yard:a") }, { seq: 7 }),
		);
		expect(state.seq).toBe(7);
	});

	it("advances by one for an event that declares none", () => {
		expect(fold([YARD_EVENTS.Registered, { yard: yardOf("yard:a") }]).seq).toBe(
			1,
		);
	});

	it("never moves backwards for a late-arriving lower sequence", () => {
		// A replayed or out-of-order fact must not rewind the projection's
		// position; a consumer paging from `seq` would re-read what it already
		// handled and re-fire its side effects.
		const ahead = foldYardEventStore(
			empty(),
			yardEvent(YARD_EVENTS.Registered, { yard: yardOf("yard:a") }, { seq: 9 }),
		);
		const after = foldYardEventStore(
			ahead,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }, { seq: 3 }),
		);
		expect(after.seq).toBe(9);
	});

	it("advances the sequence even for a fact it ignores", () => {
		// The position is about the stream, not about whether this projection
		// cared: stalling on an unhandled fact would make the fold look stuck.
		const state = fold([YARD_EVENTS.ProviderSignalNormalized, {}]);
		expect(state.seq).toBe(1);
	});

	it("returns the same state object when a no-op does not move the sequence", () => {
		const before = foldYardEventStore(
			empty(),
			yardEvent(YARD_EVENTS.Registered, { yard: yardOf("yard:a") }, { seq: 5 }),
		);
		const after = foldYardEventStore(
			before,
			yardEvent(YARD_EVENTS.StatusChanged, { yardId: "" }, { seq: 5 }),
		);
		expect(after).toBe(before);
	});
});

describe("registration", () => {
	it("registers a yard under its id", () => {
		const state = fold([YARD_EVENTS.Registered, { yard: yardOf("yard:a") }]);
		expect(state.yards["yard:a"]?.yardId).toBe("yard:a");
	});

	it("ignores a registration with no yard payload", () => {
		expect(fold([YARD_EVENTS.Registered, {}]).yards).toEqual({});
	});

	it("ignores a registration whose yard has no id", () => {
		// A yard keyed on the empty string would show up in the inventory
		// snapshot, and the snapshot is content-hashed.
		expect(
			fold([YARD_EVENTS.Registered, { yard: { yardId: "" } }]).yards,
		).toEqual({});
	});

	it("admits a yard as registering rather than trusting a claimed status", () => {
		// Registration is an assertion by the yard about itself. Anything other
		// than an explicit `ready` starts as `registering` and has to earn its
		// way up through attestation.
		const state = fold([
			YARD_EVENTS.Registered,
			{ yard: { ...yardOf("yard:a"), status: "draining" } },
		]);
		expect(state.yards["yard:a"]?.status).toBe("registering");
	});

	it("admits a local yard as ready, since it attests itself", () => {
		// `localYardInstance` is the in-process yard: there is no remote
		// attestation step for it, so it registers ready and the fold honours it.
		expect(
			fold([YARD_EVENTS.Registered, { yard: yardOf("yard:a") }]).yards["yard:a"]
				?.status,
		).toBe("ready");
	});

	it("honours a yard that registers already ready", () => {
		const state = fold([
			YARD_EVENTS.Registered,
			{ yard: { ...yardOf("yard:a"), status: "ready" } },
		]);
		expect(state.yards["yard:a"]?.status).toBe("ready");
	});

	it("stamps the fold sequence as the registration order when the yard names none", () => {
		const state = foldYardEventStore(
			empty(),
			yardEvent(
				YARD_EVENTS.Registered,
				{ yard: { ...yardOf("yard:a"), registrationSeq: 0 } },
				{ seq: 4 },
			),
		);
		expect(state.yards["yard:a"]?.registrationSeq).toBe(4);
	});

	it("keeps a registration order the yard declared", () => {
		const state = fold([
			YARD_EVENTS.Registered,
			{ yard: { ...yardOf("yard:a"), registrationSeq: 42 } },
		]);
		expect(state.yards["yard:a"]?.registrationSeq).toBe(42);
	});
});

describe("status transitions", () => {
	// A local yard registers itself `ready`; these cases start from an
	// unattested one so a transition is observable rather than a no-op.
	const registered = (yardId = "yard:a") =>
		fold([
			YARD_EVENTS.Registered,
			{ yard: { ...yardOf(yardId), status: "registering" } },
		]);

	it("moves a yard to attesting when attestation starts", () => {
		const state = foldYardEventStore(
			registered(),
			yardEvent(YARD_EVENTS.AttestationStarted, { yardId: "yard:a" }),
		);
		expect(state.yards["yard:a"]?.status).toBe("attesting");
	});

	it("keeps a yard attesting once attested, since ready is a separate fact", () => {
		// Passing attestation is not the same as being able to take traffic;
		// only `Ready` says that.
		const state = foldYardEventStore(
			registered(),
			yardEvent(YARD_EVENTS.Attested, { yardId: "yard:a" }),
		);
		expect(state.yards["yard:a"]?.status).toBe("attesting");
	});

	it("moves a yard to ready", () => {
		const state = foldYardEventStore(
			registered(),
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
		);
		expect(state.yards["yard:a"]?.status).toBe("ready");
	});

	it("applies an arbitrary declared status", () => {
		const state = foldYardEventStore(
			registered(),
			yardEvent(YARD_EVENTS.StatusChanged, {
				yardId: "yard:a",
				status: "draining",
			}),
		);
		expect(state.yards["yard:a"]?.status).toBe("draining");
	});

	it("ignores a status change that names no status", () => {
		const before = registered();
		const after = foldYardEventStore(
			before,
			yardEvent(YARD_EVENTS.StatusChanged, { yardId: "yard:a" }),
		);
		expect(after.yards["yard:a"]?.status).toBe("registering");
	});

	it("ignores a status change for a yard it has never seen", () => {
		// Creating the yard here would invent inventory from a status ping, and
		// the broker would then place work on a yard nobody registered.
		const state = foldYardEventStore(
			registered(),
			yardEvent(YARD_EVENTS.StatusChanged, {
				yardId: "yard:ghost",
				status: "ready",
			}),
		);
		expect(state.yards["yard:ghost"]).toBeUndefined();
	});

	it("bumps the health generation on every transition", () => {
		// The generation is how a reader tells a fresh observation from a cached
		// one; a transition that left it alone would look like no news.
		const before = registered();
		const after = foldYardEventStore(
			before,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
		);
		const start = before.yards["yard:a"]?.health.generation ?? 0;
		expect(after.yards["yard:a"]?.health.generation).toBe(start + 1);
	});

	it("leaves other yards untouched", () => {
		const two = foldYardEventStore(
			registered("yard:a"),
			yardEvent(YARD_EVENTS.Registered, {
				yard: { ...yardOf("yard:b"), status: "registering" },
			}),
		);
		const after = foldYardEventStore(
			two,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
		);
		expect(after.yards["yard:b"]?.status).toBe("registering");
	});
});

describe("capacity updates", () => {
	const registered = fold([YARD_EVENTS.Registered, { yard: yardOf("yard:a") }]);
	const capacity = { maxDeployments: 12, currentDeployments: 3 };

	it("replaces the recorded capacity", () => {
		const state = foldYardEventStore(
			registered,
			yardEvent(YARD_EVENTS.CapacityUpdated, { yardId: "yard:a", capacity }),
		);
		expect(state.yards["yard:a"]?.capacity).toEqual(capacity);
	});

	it("ignores an update for an unregistered yard", () => {
		const state = foldYardEventStore(
			registered,
			yardEvent(YARD_EVENTS.CapacityUpdated, { yardId: "yard:x", capacity }),
		);
		expect(state.yards["yard:x"]).toBeUndefined();
	});

	it("ignores an update carrying no capacity", () => {
		// Absent is not the same as zero: treating a missing payload as empty
		// capacity would make the broker stop placing on a healthy yard.
		const before = registered.yards["yard:a"]?.capacity;
		const state = foldYardEventStore(
			registered,
			yardEvent(YARD_EVENTS.CapacityUpdated, { yardId: "yard:a" }),
		);
		expect(state.yards["yard:a"]?.capacity).toEqual(before);
	});

	it("does not disturb the yard's status", () => {
		const state = foldYardEventStore(
			foldYardEventStore(
				registered,
				yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
			),
			yardEvent(YARD_EVENTS.CapacityUpdated, { yardId: "yard:a", capacity }),
		);
		expect(state.yards["yard:a"]?.status).toBe("ready");
	});
});

describe("generation attempts", () => {
	const started = (data: JsonObject) =>
		fold([YARD_EVENTS.GenerationStarted, data]);

	it("records an attempt under its id", () => {
		const state = started({ attemptId: "gen-1", idempotencyKey: "k1" });
		expect(state.generationAttempts["gen-1"]?.attemptId).toBe("gen-1");
	});

	it("ignores a generation fact with no attempt id", () => {
		expect(started({ idempotencyKey: "k1" }).generationAttempts).toEqual({});
	});

	it.each([
		[YARD_EVENTS.GenerationRequested, "started"],
		[YARD_EVENTS.GenerationReserved, "reserved"],
		[YARD_EVENTS.GenerationApprovalRequired, "approval-required"],
		[YARD_EVENTS.GenerationStarted, "started"],
		[YARD_EVENTS.GenerationProvisioned, "provisioned"],
		[YARD_EVENTS.GenerationFailed, "failed"],
		[YARD_EVENTS.GenerationCompensated, "compensated"],
	])("maps %s to status %s", (type, status) => {
		const state = fold([type, { attemptId: "gen-1" }]);
		expect(state.generationAttempts["gen-1"]?.status).toBe(status);
	});

	it("treats a compensation request as failed, not yet compensated", () => {
		// Asking for compensation and having compensated are different states;
		// collapsing them would let an operator believe cloud resources were
		// released while the compensating call is still in flight.
		const state = fold([
			YARD_EVENTS.GenerationCompensationRequested,
			{ attemptId: "gen-1" },
		]);
		expect(state.generationAttempts["gen-1"]?.status).toBe("failed");
	});

	it("takes the status a progress fact declares", () => {
		const state = fold([
			YARD_EVENTS.GenerationProgressed,
			{ attemptId: "gen-1", status: "provisioned" },
		]);
		expect(state.generationAttempts["gen-1"]?.status).toBe("provisioned");
	});

	it("falls back to started for a progress fact with no status", () => {
		const state = fold([YARD_EVENTS.GenerationProgressed, { attemptId: "g" }]);
		expect(state.generationAttempts.g?.status).toBe("started");
	});

	it("keys an attempt on itself when no idempotency key is given", () => {
		// Every attempt needs a lease key; without one the attempt id is the
		// only value guaranteed unique to it.
		const state = started({ attemptId: "gen-1" });
		expect(state.generationAttempts["gen-1"]?.idempotencyKey).toBe("gen-1");
		expect(state.generationByIdempotency["gen-1"]).toBe("gen-1");
	});

	it("indexes the attempt by its idempotency key", () => {
		const state = started({ attemptId: "gen-1", idempotencyKey: "k1" });
		expect(state.generationByIdempotency.k1).toBe("gen-1");
	});

	it("merges external refs across facts rather than replacing them", () => {
		// Each provider step learns one more handle; a later fact that dropped
		// the earlier ones would leave resources unreferenced and unreleasable.
		const state = foldYardEventStore(
			started({ attemptId: "gen-1", externalRefs: { subscription: "s1" } }),
			yardEvent(YARD_EVENTS.GenerationProvisioned, {
				attemptId: "gen-1",
				externalRefs: { instance: "i1" },
			}),
		);
		expect(state.generationAttempts["gen-1"]?.externalRefs).toEqual({
			subscription: "s1",
			instance: "i1",
		});
	});

	it("lets a later fact correct an external ref it already carried", () => {
		const state = foldYardEventStore(
			started({ attemptId: "gen-1", externalRefs: { instance: "old" } }),
			yardEvent(YARD_EVENTS.GenerationProvisioned, {
				attemptId: "gen-1",
				externalRefs: { instance: "new" },
			}),
		);
		expect(state.generationAttempts["gen-1"]?.externalRefs.instance).toBe(
			"new",
		);
	});

	it("carries the provider and runtime forward when a later fact omits them", () => {
		const state = foldYardEventStore(
			started({ attemptId: "gen-1", providerId: "azure", runtimeId: "aca" }),
			yardEvent(YARD_EVENTS.GenerationProvisioned, { attemptId: "gen-1" }),
		);
		const row = state.generationAttempts["gen-1"];
		expect(row?.providerId).toBe("azure");
		expect(row?.runtimeId).toBe("aca");
	});

	it("reports an empty provider rather than undefined when none was ever given", () => {
		expect(
			started({ attemptId: "gen-1" }).generationAttempts["gen-1"]?.providerId,
		).toBe("");
	});

	it("keeps a failure recorded once, so the reason survives compensation", () => {
		// The failure is the only record of *why* the attempt is being unwound;
		// a compensation fact that cleared it would leave an unexplained one.
		const failure = { code: "quota", message: "out of quota", retryable: true };
		const state = foldYardEventStore(
			fold([YARD_EVENTS.GenerationFailed, { attemptId: "gen-1", failure }]),
			yardEvent(YARD_EVENTS.GenerationCompensated, { attemptId: "gen-1" }),
		);
		expect(state.generationAttempts["gen-1"]?.failure).toEqual(failure);
	});

	it("ignores a non-object failure payload", () => {
		const state = fold([
			YARD_EVENTS.GenerationFailed,
			{ attemptId: "gen-1", failure: "quota" },
		]);
		expect(state.generationAttempts["gen-1"]?.failure).toBeUndefined();
	});

	it("accumulates one contributing event per fact, as an audit trail", () => {
		const state = foldYardEventStore(
			started({ attemptId: "gen-1" }),
			yardEvent(YARD_EVENTS.GenerationProvisioned, { attemptId: "gen-1" }),
		);
		expect(state.generationAttempts["gen-1"]?.contributingEvents).toEqual([
			"started",
			"provisioned",
		]);
	});

	it("prefers an explicit event type in the audit trail", () => {
		const state = started({ attemptId: "gen-1", eventType: "yard.custom" });
		expect(state.generationAttempts["gen-1"]?.contributingEvents).toEqual([
			"yard.custom",
		]);
	});

	it("carries the yard id forward once a fact names it", () => {
		const state = foldYardEventStore(
			started({ attemptId: "gen-1", yardId: "yard:new" }),
			yardEvent(YARD_EVENTS.GenerationProvisioned, { attemptId: "gen-1" }),
		);
		expect(state.generationAttempts["gen-1"]?.yardId).toBe("yard:new");
	});
});

describe("the idempotency lease", () => {
	const first = fold([
		YARD_EVENTS.GenerationStarted,
		{ attemptId: "gen-1", idempotencyKey: "k1", providerId: "azure" },
	]);

	it("refuses a second attempt while the holder is still live", () => {
		// Two attempts on one key is the normal layout of a retry. If the loser
		// could take the key, the caller would end up tracking an attempt that
		// is not the one holding the provisioned infrastructure.
		const state = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: "gen-2",
				idempotencyKey: "k1",
			}),
		);
		expect(state.generationAttempts["gen-2"]).toBeUndefined();
		expect(state.generationByIdempotency.k1).toBe("gen-1");
	});

	it("still advances the sequence when it refuses", () => {
		const state = foldYardEventStore(
			first,
			yardEvent(
				YARD_EVENTS.GenerationStarted,
				{ attemptId: "gen-2", idempotencyKey: "k1" },
				{ seq: 12 },
			),
		);
		expect(state.seq).toBe(12);
	});

	it("releases the key once the holder has failed", () => {
		// A failed attempt is not holding anything, so the retry is entitled to
		// the key — otherwise one failure would poison that key forever.
		const failed = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationFailed, {
				attemptId: "gen-1",
				idempotencyKey: "k1",
			}),
		);
		const retried = foldYardEventStore(
			failed,
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: "gen-2",
				idempotencyKey: "k1",
			}),
		);
		expect(retried.generationByIdempotency.k1).toBe("gen-2");
		expect(retried.generationAttempts["gen-2"]?.status).toBe("started");
	});

	it("releases the key once the holder has been compensated", () => {
		const compensated = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationCompensated, {
				attemptId: "gen-1",
				idempotencyKey: "k1",
			}),
		);
		const retried = foldYardEventStore(
			compensated,
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: "gen-2",
				idempotencyKey: "k1",
			}),
		);
		expect(retried.generationByIdempotency.k1).toBe("gen-2");
	});

	it("keeps the failed attempt's own row after the key moves on", () => {
		// The loser's history is still the record of what was tried; dropping it
		// would hide a failure the operator needs to see.
		const failed = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationFailed, {
				attemptId: "gen-1",
				idempotencyKey: "k1",
			}),
		);
		const retried = foldYardEventStore(
			failed,
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: "gen-2",
				idempotencyKey: "k1",
			}),
		);
		expect(retried.generationAttempts["gen-1"]?.status).toBe("failed");
	});

	it("lets the holder keep updating its own row", () => {
		const state = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationProvisioned, {
				attemptId: "gen-1",
				idempotencyKey: "k1",
			}),
		);
		expect(state.generationAttempts["gen-1"]?.status).toBe("provisioned");
	});

	it("does not lease across distinct keys", () => {
		const state = foldYardEventStore(
			first,
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: "gen-2",
				idempotencyKey: "k2",
			}),
		);
		expect(state.generationAttempts["gen-2"]?.status).toBe("started");
	});
});

describe("linking a ready yard back to its generation attempt", () => {
	const generating = fold(
		[YARD_EVENTS.Registered, { yard: yardOf("yard:gen") }],
		[
			YARD_EVENTS.GenerationProvisioned,
			{ attemptId: "gen-1", idempotencyKey: "k1", providerId: "aws" },
		],
	);

	it("marks the attempt ready and records the yard it produced", () => {
		const state = foldYardEventStore(
			generating,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:gen", attemptId: "gen-1" }),
		);
		const row = state.generationAttempts["gen-1"];
		expect(row?.status).toBe("ready");
		expect(row?.yardId).toBe("yard:gen");
	});

	it("marks the yard ready at the same time", () => {
		const state = foldYardEventStore(
			generating,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:gen", attemptId: "gen-1" }),
		);
		expect(state.yards["yard:gen"]?.status).toBe("ready");
	});

	it("appends the link to the attempt's audit trail", () => {
		const state = foldYardEventStore(
			generating,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:gen", attemptId: "gen-1" }),
		);
		expect(state.generationAttempts["gen-1"]?.contributingEvents).toContain(
			YARD_EVENTS.Ready,
		);
	});

	it("preserves the attempt's provider and refs through the link", () => {
		const state = foldYardEventStore(
			generating,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:gen", attemptId: "gen-1" }),
		);
		expect(state.generationAttempts["gen-1"]?.providerId).toBe("aws");
	});

	it("ignores an attempt id it has never seen", () => {
		// The alternative — creating the attempt here — would fabricate a
		// generation saga out of a readiness ping.
		const state = foldYardEventStore(
			generating,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:gen", attemptId: "gen-x" }),
		);
		expect(state.generationAttempts["gen-x"]).toBeUndefined();
		expect(state.yards["yard:gen"]?.status).toBe("ready");
	});
});

describe("placement decisions", () => {
	const match = (
		outcome: "existing-yard" | "generation-required" | "rejected",
		winnerYardId?: string,
	) => ({
		selectionMode: "auto",
		requestedLayoutHash: "sha256:layout",
		inventoryHash: "sha256:inv",
		candidates: [],
		contributingPolicyIds: [],
		outcome,
		rationale: "test",
		...(winnerYardId ? { winnerYardId } : undefined),
	});

	it("opens a request as pending", () => {
		const state = fold([YARD_EVENTS.PlacementRequested, { requestId: "r1" }]);
		expect(state.placements.r1?.outcome).toBe("pending");
	});

	it("ignores a request with no id", () => {
		expect(fold([YARD_EVENTS.PlacementRequested, {}]).placements).toEqual({});
	});

	it("records the last match decision per request", () => {
		const state = fold([
			YARD_EVENTS.MatchDecided,
			{ requestId: "r1", match: match("existing-yard", "yard:a") },
		]);
		expect(state.lastMatchByRequest.r1?.outcome).toBe("existing-yard");
	});

	it("ignores a match decision carrying no match", () => {
		expect(
			fold([YARD_EVENTS.MatchDecided, { requestId: "r1" }]).lastMatchByRequest,
		).toEqual({});
	});

	it("provisionally selects the winning yard while still pending", () => {
		// The match names a winner before the placement resolves; surfacing it
		// early is what lets a caller watch a request converge.
		const state = fold(
			[YARD_EVENTS.PlacementRequested, { requestId: "r1" }],
			[
				YARD_EVENTS.MatchDecided,
				{ requestId: "r1", match: match("existing-yard", "yard:a") },
			],
		);
		expect(state.placements.r1?.selectedYardId).toBe("yard:a");
		expect(state.placements.r1?.outcome).toBe("pending");
	});

	it("records why a match was rejected", () => {
		const state = fold([
			YARD_EVENTS.MatchDecided,
			{ requestId: "r1", match: match("rejected") },
		]);
		expect(state.placements.r1?.reasonCodes).toEqual(["yard-match-rejected"]);
	});

	it("resolves a placement and clears the reason codes", () => {
		// A resolved placement with reasons attached reads as a partial failure;
		// once it resolved, the earlier objections no longer apply.
		const state = fold(
			[YARD_EVENTS.MatchDecided, { requestId: "r1", match: match("rejected") }],
			[YARD_EVENTS.PlacementResolved, { requestId: "r1" }],
		);
		expect(state.placements.r1?.outcome).toBe("resolved");
		expect(state.placements.r1?.reasonCodes).toEqual([]);
	});

	it("takes the selection from the event over the receipt", () => {
		const state = fold([
			YARD_EVENTS.PlacementResolved,
			{
				requestId: "r1",
				selectedYardId: "yard:event",
				receipt: { selectedYardId: "yard:receipt" },
			},
		]);
		expect(state.placements.r1?.selectedYardId).toBe("yard:event");
	});

	it("falls back to the receipt's selection", () => {
		const state = fold([
			YARD_EVENTS.PlacementResolved,
			{
				requestId: "r1",
				receipt: {
					selectedYardId: "yard:receipt",
					selectedProviderId: "gcp",
					selectedCampId: "camp:1",
				},
			},
		]);
		const row = state.placements.r1;
		expect(row?.selectedYardId).toBe("yard:receipt");
		expect(row?.selectedProviderId).toBe("gcp");
		expect(row?.selectedCampId).toBe("camp:1");
	});

	it("falls back to what the match already selected", () => {
		const state = fold(
			[
				YARD_EVENTS.MatchDecided,
				{ requestId: "r1", match: match("existing-yard", "yard:a") },
			],
			[YARD_EVENTS.PlacementResolved, { requestId: "r1" }],
		);
		expect(state.placements.r1?.selectedYardId).toBe("yard:a");
	});

	it("takes the receipt hash from the receipt when the event names none", () => {
		// The hash is what ties the decision to the artifact an auditor can
		// re-derive; losing it makes the placement unverifiable.
		const state = fold([
			YARD_EVENTS.PlacementResolved,
			{ requestId: "r1", receipt: { contentHash: "sha256:receipt" } },
		]);
		expect(state.placements.r1?.receiptHash).toBe("sha256:receipt");
	});

	it("assumes an existing yard when no match was recorded", () => {
		// A placement that resolved without a match decision took a yard that
		// was already there; the alternative would be an empty outcome field.
		const state = fold([YARD_EVENTS.PlacementResolved, { requestId: "r1" }]);
		expect(state.placements.r1?.matchOutcome).toBe("existing-yard");
	});

	it("keeps the recorded match outcome through resolution", () => {
		const state = fold(
			[
				YARD_EVENTS.MatchDecided,
				{ requestId: "r1", match: match("generation-required") },
			],
			[YARD_EVENTS.PlacementResolved, { requestId: "r1" }],
		);
		expect(state.placements.r1?.matchOutcome).toBe("generation-required");
	});

	it("ignores a resolution with no request id", () => {
		expect(fold([YARD_EVENTS.PlacementResolved, {}]).placements).toEqual({});
	});
});

describe("placement rejections", () => {
	it("records the declared reason codes", () => {
		const state = fold([
			YARD_EVENTS.PlacementRejected,
			{ requestId: "r1", reasonCodes: ["no-capacity", "residency"] },
		]);
		expect(state.placements.r1?.reasonCodes).toEqual([
			"no-capacity",
			"residency",
		]);
	});

	it("falls back to a single declared code", () => {
		const state = fold([
			YARD_EVENTS.PlacementRejected,
			{ requestId: "r1", code: "policy-denied" },
		]);
		expect(state.placements.r1?.reasonCodes).toEqual(["policy-denied"]);
	});

	it("never leaves a rejection unexplained", () => {
		// A rejection with no reason is the worst possible output: the caller
		// knows they were refused and cannot act on it.
		const state = fold([YARD_EVENTS.PlacementRejected, { requestId: "r1" }]);
		expect(state.placements.r1?.reasonCodes).toEqual(["placement-rejected"]);
	});

	it("drops empty strings from a reason list", () => {
		const state = fold([
			YARD_EVENTS.PlacementRejected,
			{ requestId: "r1", reasonCodes: ["", "no-capacity"] },
		]);
		expect(state.placements.r1?.reasonCodes).toEqual(["no-capacity"]);
	});

	it("keeps the yard the match had selected, so the refusal is attributable", () => {
		const state = fold(
			[
				YARD_EVENTS.MatchDecided,
				{
					requestId: "r1",
					match: {
						selectionMode: "auto",
						requestedLayoutHash: "sha256:s",
						inventoryHash: "sha256:i",
						candidates: [],
						contributingPolicyIds: [],
						outcome: "existing-yard",
						rationale: "t",
						winnerYardId: "yard:a",
					},
				},
			],
			[YARD_EVENTS.PlacementRejected, { requestId: "r1", code: "quota" }],
		);
		expect(state.placements.r1?.selectedYardId).toBe("yard:a");
	});

	it("ignores a rejection with no request id", () => {
		expect(fold([YARD_EVENTS.PlacementRejected, {}]).placements).toEqual({});
	});
});

describe("the inventory snapshot", () => {
	// The same two yard records, so the only difference between the folds below
	// is the order the facts arrived in — a fresh `localYardInstance` would also
	// differ by its observation timestamp.
	const a = yardOf("yard:a");
	const b = yardOf("yard:b");
	const twoYards = fold(
		[YARD_EVENTS.Registered, { yard: b }],
		[YARD_EVENTS.Registered, { yard: a }],
	);

	it("orders yards by id regardless of registration order", () => {
		// The snapshot is content-hashed, so two brokers that saw the same facts
		// in a different order must still hash identically.
		expect(
			inventorySnapshotFromFold(twoYards).yards.map((y) => y.yardId),
		).toEqual(["yard:a", "yard:b"]);
	});

	it("hashes the same for the same yards seen in either order", () => {
		const reversed = fold(
			[YARD_EVENTS.Registered, { yard: a }],
			[YARD_EVENTS.Registered, { yard: b }],
		);
		expect(inventorySnapshotFromFold(twoYards).contentHash).toBe(
			inventorySnapshotFromFold(reversed).contentHash,
		);
	});

	it("carries the broker id and sequence", () => {
		const snapshot = inventorySnapshotFromFold(twoYards);
		expect(snapshot.brokerId).toBe("broker:test");
		expect(snapshot.seq).toBe(2);
	});

	it("hashes an empty inventory rather than refusing one", () => {
		// A broker with no yards is a normal cold start, and its peers still
		// need a hash to compare against.
		expect(inventorySnapshotFromFold(empty()).contentHash).toMatch(/^sha256:/u);
	});

	it("changes hash when a yard's status changes", () => {
		const before = inventorySnapshotFromFold(twoYards).contentHash;
		const after = foldYardEventStore(
			twoYards,
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
		);
		expect(inventorySnapshotFromFold(after).contentHash).not.toBe(before);
	});

	it("freezes the snapshot and its yard list", () => {
		const snapshot = inventorySnapshotFromFold(twoYards);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.yards)).toBe(true);
	});
});

describe("the snapshot round trip", () => {
	const state = fold(
		[YARD_EVENTS.Registered, { yard: yardOf("yard:a") }],
		[YARD_EVENTS.Ready, { yardId: "yard:a" }],
		[
			YARD_EVENTS.GenerationStarted,
			{ attemptId: "gen-1", idempotencyKey: "k1" },
		],
		[YARD_EVENTS.PlacementRequested, { requestId: "r1" }],
	);

	it("restores every projection the fold built", () => {
		const restored = restoreYardEventStore(snapshotYardEventStore(state));
		expect(restored.yards["yard:a"]?.status).toBe("ready");
		expect(restored.generationAttempts["gen-1"]?.idempotencyKey).toBe("k1");
		expect(restored.generationByIdempotency.k1).toBe("gen-1");
		expect(restored.placements.r1?.outcome).toBe("pending");
	});

	it("restores the sequence, so a resumed fold does not re-read the stream", () => {
		expect(restoreYardEventStore(snapshotYardEventStore(state)).seq).toBe(
			state.seq,
		);
	});

	it("restores the broker id", () => {
		expect(restoreYardEventStore(snapshotYardEventStore(state)).brokerId).toBe(
			"broker:test",
		);
	});

	it("freezes what it restores", () => {
		// A restored state that could be mutated would drift from the stream it
		// was built from, silently.
		expect(
			Object.isFrozen(restoreYardEventStore(snapshotYardEventStore(state))),
		).toBe(true);
	});

	it("can be folded onward from the restored state", () => {
		const restored = restoreYardEventStore(snapshotYardEventStore(state));
		const next = foldYardEventStore(
			restored,
			yardEvent(YARD_EVENTS.StatusChanged, {
				yardId: "yard:a",
				status: "draining",
			}),
		);
		expect(next.yards["yard:a"]?.status).toBe("draining");
	});

	it("refuses an unknown schema rather than best-efforting it", () => {
		// A state restored under the wrong layout is a broker confidently serving
		// placements from a projection it never built.
		expect(() =>
			restoreYardEventStore(
				JSON.stringify({ schemaVersion: "hobo.yard-event-store/v2", state }),
			),
		).toThrow(/unsupported yard event-store snapshot/u);
	});

	it("names the offending schema in the refusal", () => {
		expect(() =>
			restoreYardEventStore(JSON.stringify({ schemaVersion: "nope", state })),
		).toThrow(/nope/u);
	});

	it("refuses a payload with no state", () => {
		expect(() =>
			restoreYardEventStore(
				JSON.stringify({ schemaVersion: "hobo.yard-event-store/v1" }),
			),
		).toThrow(/unsupported yard event-store snapshot/u);
	});

	it("refuses text that is not JSON at all", () => {
		expect(() => restoreYardEventStore("not json")).toThrow();
	});

	it("round-trips an empty state", () => {
		const restored = restoreYardEventStore(snapshotYardEventStore(empty()));
		expect(restored.seq).toBe(0);
		expect(restored.yards).toEqual({});
	});
});

describe("yardEvent", () => {
	it("freezes the event it builds", () => {
		expect(Object.isFrozen(yardEvent(YARD_EVENTS.Ready, { yardId: "y" }))).toBe(
			true,
		);
	});

	it("stamps an occurrence time when none is given", () => {
		expect(yardEvent(YARD_EVENTS.Ready, {}).occurredAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T/u,
		);
	});

	it("keeps a declared occurrence time", () => {
		// Replayed facts carry the time they happened, not the time they were
		// re-read; overwriting it would destroy the history.
		expect(
			yardEvent(
				YARD_EVENTS.Ready,
				{},
				{ occurredAt: "2020-01-01T00:00:00.000Z" },
			).occurredAt,
		).toBe("2020-01-01T00:00:00.000Z");
	});
});
