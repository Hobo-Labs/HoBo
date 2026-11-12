import { create, toJson } from "@bufbuild/protobuf";
import type { EventPosition } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	CampManagement,
	ChangeKind,
	type DeltaRecord,
	DeltaRecordSchema,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type ResourceChange,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import {
	CD_EVENTS,
	CD_STREAMS,
	DELTA_SCHEMA,
	RESOLVED_SET_MEDIA_TYPE,
	SET_SCHEMA,
} from "../../src/events.js";
import type { Outcome } from "../../src/ports.js";
import {
	createDesiredState,
	DesiredStateError,
	diffResolvedSets,
	verifyResolvedSet,
} from "../../src/sets/index.js";
import { member, toJsonValue } from "../../src/sets/json.js";
import {
	asDesiredStateError,
	camp,
	collect,
	createFakeArtifactStore,
	createFakeEventStore,
	createRecordingTelemetry,
	ctxAt,
	deltaId,
	OPERATOR,
	reasonOf,
	resolvedFor,
	SHOP_V1,
	SHOP_V2,
	setId,
	T0,
} from "./fakes.js";

const PROD = camp("prod-aws");

function setup() {
	const store = createFakeEventStore();
	const artifacts = createFakeArtifactStore();
	const telemetry = createRecordingTelemetry();
	const desired = createDesiredState({
		store,
		artifacts,
		telemetry,
		tenant: "acme",
		now: () => T0,
	});
	return { store, artifacts, telemetry, desired };
}

type DeltaFields = Partial<
	Pick<DeltaRecord, "baseSetId" | "intent" | "freightId" | "campId">
> & { changes?: ResourceChange[] };

function delta(id: string, fields: DeltaFields = {}): DeltaRecord {
	return create(DeltaRecordSchema, {
		deltaId: id,
		campId: "prod-aws",
		intent: "promote",
		freightId:
			"sha256:1111111111111111111111111111111111111111111111111111111111111111",
		...fields,
	});
}

function unwrap<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`refused: ${outcome.reasons.map((r) => r.code).join(",")}`);
	return outcome.value;
}

function codes<T>(outcome: Outcome<T>): string[] {
	return outcome.ok ? [] : outcome.reasons.map((reason) => reason.code);
}

/** Open + apply a Delta that takes the Camp from its current Set to `resources`. */
async function applyResources(
	desired: ReturnType<typeof setup>["desired"],
	id: string,
	resources: typeof SHOP_V1,
	at = T0,
	origin = SetOrigin.PROMOTION,
) {
	const current = await desired.current(PROD);
	const before =
		current === undefined ? undefined : await desired.resolved(current);
	const resolved = resolvedFor("prod-aws", resources);
	unwrap(
		await desired.open(
			delta(id, {
				baseSetId: current?.setId ?? "",
				changes: diffResolvedSets(before, resolved),
			}),
			ctxAt(at),
		),
	);
	return unwrap(
		await desired.apply(
			{
				deltaId: deltaId(id),
				gateDecisionId: `gate-${id}`,
				resolved,
				origin,
			},
			ctxAt(at + 1),
		),
	);
}

describe("Delta lifecycle", () => {
	it("open records delta.Opened on the Camp spec stream with defaults filled", async () => {
		const { desired, store } = setup();
		const opened = unwrap(
			await desired.open(
				delta("d1", {
					changes: diffResolvedSets(
						undefined,
						resolvedFor("prod-aws", SHOP_V1),
					),
				}),
				ctxAt(T0),
			),
		);
		expect(opened.schemaVersion).toBe(DELTA_SCHEMA);
		expect(opened.openedAt).toBe(new Date(T0).toISOString());
		expect(opened.openedBy).toBe(`${OPERATOR.kind}:${OPERATOR.id}`);
		expect(store.log.map((e) => [e.event.streamId, e.event.type])).toEqual([
			[CD_STREAMS.campSpec("prod-aws"), CD_EVENTS.DeltaOpened],
		]);
		expect((await desired.get(deltaId("d1")))?.deltaId).toBe("d1");
	});

	it("open is idempotent for an identical record and refuses an overlapping Delta", async () => {
		const { desired } = setup();
		const changes = diffResolvedSets(
			undefined,
			resolvedFor("prod-aws", SHOP_V1),
		);
		unwrap(await desired.open(delta("d1", { changes }), ctxAt(T0)));
		expect(
			(await desired.open(delta("d1", { changes }), ctxAt(T0 + 5))).ok,
		).toBe(true);
		expect(
			codes(await desired.open(delta("d2", { changes }), ctxAt(T0))),
		).toEqual(["delta-overlap"]);
	});

	it("refuses a Delta whose base is not the current Set", async () => {
		const { desired } = setup();
		await applyResources(desired, "d1", SHOP_V1);
		expect(
			codes(
				await desired.open(delta("d2", { baseSetId: "set_ghost" }), ctxAt(T0)),
			),
		).toEqual(["delta-stale-base"]);
	});

	it("refuses changes that update or remove a resource absent from the base Set", async () => {
		const { desired } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		const ghost = diffResolvedSets(
			resolvedFor("prod-aws", SHOP_V1),
			resolvedFor("prod-aws", SHOP_V2),
		).map((c) =>
			c.resource === "shop.cache" ? { ...c, resource: "shop.ghost" } : c,
		);
		expect(
			codes(
				await desired.open(
					delta("d2", { baseSetId: set.setId, changes: ghost }),
					ctxAt(T0),
				),
			),
		).toEqual(["delta-absent-resource"]);
	});

	it("refuses malformed Deltas with typed reasons and remediation", async () => {
		const { desired } = setup();
		const outcome = await desired.open(
			delta("", { intent: "yolo" }),
			ctxAt(T0),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reasons[0]?.code).toBe("delta-invalid");
		expect(outcome.reasons[0]?.remediation.length).toBeGreaterThan(0);
	});

	it("update replaces an open Delta; updating a closed Delta is refused", async () => {
		const { desired } = setup();
		const v1 = diffResolvedSets(undefined, resolvedFor("prod-aws", SHOP_V1));
		const v2 = diffResolvedSets(undefined, resolvedFor("prod-aws", SHOP_V2));
		unwrap(await desired.open(delta("d1", { changes: v1 }), ctxAt(T0)));
		const updated = unwrap(
			await desired.update(delta("d1", { changes: v2 }), ctxAt(T0 + 1)),
		);
		expect(updated.changes.map((c) => c.resource)).toEqual([
			"shop.api",
			"shop.db",
			"shop.worker",
		]);
		unwrap(
			await desired.apply(
				{
					deltaId: deltaId("d1"),
					gateDecisionId: "g",
					resolved: resolvedFor("prod-aws", SHOP_V2),
					origin: SetOrigin.UP,
				},
				ctxAt(T0 + 2),
			),
		);
		expect(
			codes(await desired.update(delta("d1", { changes: v1 }), ctxAt(T0 + 3))),
		).toEqual(["delta-not-open"]);
		expect(codes(await desired.update(delta("nope"), ctxAt(T0 + 3)))).toEqual([
			"delta-not-found",
		]);
	});

	it("reject closes the Delta with delta.Rejected and frees the Camp for a new Delta", async () => {
		const { desired, store, telemetry } = setup();
		unwrap(await desired.open(delta("d1"), ctxAt(T0)));
		await desired.reject(
			deltaId("d1"),
			[reasonOf("window-closed", "freeze", "wait", "prod-aws")],
			ctxAt(T0 + 1),
		);
		await desired.reject(deltaId("d1"), [], ctxAt(T0 + 2));
		expect(
			store.log.filter((e) => e.event.type === CD_EVENTS.DeltaRejected),
		).toHaveLength(1);
		expect(
			codes(
				await desired.apply(
					{
						deltaId: deltaId("d1"),
						gateDecisionId: "g",
						resolved: resolvedFor("prod-aws", SHOP_V1),
						origin: SetOrigin.PROMOTION,
					},
					ctxAt(T0),
				),
			),
		).toEqual(["delta-rejected"]);
		expect((await desired.open(delta("d2"), ctxAt(T0 + 3))).ok).toBe(true);
		expect(
			telemetry.points.some((p) => p.name === "hobo.cd.sets.deltas_rejected"),
		).toBe(true);
	});

	it("rejecting an applied Delta throws a typed error naming the remediation", async () => {
		const { desired } = setup();
		await applyResources(desired, "d1", SHOP_V1);
		await expect(
			desired.reject(deltaId("d1"), [], ctxAt(T0)),
		).rejects.toMatchObject({
			code: "delta-already-applied",
		});
		await expect(
			desired.reject(deltaId("missing"), [], ctxAt(T0)),
		).rejects.toBeInstanceOf(DesiredStateError);
	});
});

describe("apply", () => {
	it("stores the canonical secret-free Resolved Set as a PACKAGE blob and emits set.Created with digest and size", async () => {
		const { desired, artifacts, store, telemetry } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		expect(artifacts.puts).toHaveLength(1);
		const put = artifacts.puts[0];
		expect(put?.kind).toBe(ArtifactKind.PACKAGE);
		expect(put?.mediaType).toBe(RESOLVED_SET_MEDIA_TYPE);
		expect(set.resolvedSetDigest).toBe(put?.digest);
		expect(set.resolvedSetBytes).toBe(BigInt(put?.size ?? 0));
		expect(set.schemaVersion).toBe(SET_SCHEMA);
		expect(set.origin).toBe(SetOrigin.PROMOTION);
		expect(set.gateDecisionId).toBe("gate-d1");
		expect(set.predecessorSetId).toBe("");
		expect(set.contentHash).toBe(
			verifyResolvedSet(resolvedFor("prod-aws", SHOP_V1)).contentHash,
		);
		expect(set.createdAt).toBe(new Date(T0 + 1).toISOString());
		const types = store.log.map((e) => e.event.type);
		expect(types).toEqual([
			CD_EVENTS.DeltaOpened,
			CD_EVENTS.DeltaApplied,
			CD_EVENTS.SetCreated,
		]);
		const created = toJsonValue(store.log.at(-1)?.event.data);
		expect(member(created, "resolvedSetDigest")).toBe(set.resolvedSetDigest);
		expect(member(created, "resolvedSetBytes")).toBe(
			String(set.resolvedSetBytes),
		);
		expect(telemetry.points.map((p) => p.name)).toEqual(
			expect.arrayContaining([
				"hobo.cd.sets.deltas_applied",
				"hobo.cd.sets.resolved_set_bytes",
			]),
		);
	});

	it("chains predecessors and keeps history newest first", async () => {
		const { desired } = setup();
		const first = await applyResources(desired, "d1", SHOP_V1);
		const second = await applyResources(desired, "d2", SHOP_V2, T0 + 10);
		expect(second.predecessorSetId).toBe(first.setId);
		expect((await desired.current(PROD))?.setId).toBe(second.setId);
		expect((await desired.history(PROD)).map((s) => s.setId)).toEqual([
			second.setId,
			first.setId,
		]);
		expect((await desired.history(PROD, 1)).map((s) => s.setId)).toEqual([
			second.setId,
		]);
		expect((await desired.get(setId(first.setId)))?.setId).toBe(first.setId);
		expect(await desired.get(setId("set_missing"))).toBeUndefined();
	});

	it("is idempotent: re-applying an applied Delta returns the same Set (I12)", async () => {
		const { desired, store, artifacts } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		const again = unwrap(
			await desired.apply(
				{
					deltaId: deltaId("d1"),
					gateDecisionId: "gate-d1",
					resolved: resolvedFor("prod-aws", SHOP_V1),
					origin: SetOrigin.PROMOTION,
				},
				ctxAt(T0 + 99),
			),
		);
		expect(again).toEqual(set);
		expect(
			store.log.filter((e) => e.event.type === CD_EVENTS.SetCreated),
		).toHaveLength(1);
		expect(artifacts.puts).toHaveLength(1);
	});

	it("an empty Delta is an explicit no-op: delta.Applied without a new Set (delta-set-apply-reconcile)", async () => {
		const { desired, store } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		unwrap(
			await desired.open(
				delta("d2", { baseSetId: set.setId, intent: "config" }),
				ctxAt(T0 + 5),
			),
		);
		const same = unwrap(
			await desired.apply(
				{
					deltaId: deltaId("d2"),
					gateDecisionId: "gate-d2",
					resolved: resolvedFor("prod-aws", SHOP_V1),
					origin: SetOrigin.CONFIG,
				},
				ctxAt(T0 + 6),
			),
		);
		expect(same.setId).toBe(set.setId);
		expect(store.log.map((e) => e.event.type).slice(-2)).toEqual([
			CD_EVENTS.DeltaOpened,
			CD_EVENTS.DeltaApplied,
		]);
		expect((await desired.get(deltaId("d2")))?.deltaId).toBe("d2");
	});

	it("refuses an apply whose resolved set does not match the Delta's declared changes", async () => {
		const { desired } = setup();
		unwrap(
			await desired.open(
				delta("d1", {
					changes: diffResolvedSets(
						undefined,
						resolvedFor("prod-aws", SHOP_V1),
					),
				}),
				ctxAt(T0),
			),
		);
		const outcome = await desired.apply(
			{
				deltaId: deltaId("d1"),
				gateDecisionId: "g",
				resolved: resolvedFor("prod-aws", SHOP_V2),
				origin: SetOrigin.PROMOTION,
			},
			ctxAt(T0),
		);
		expect(codes(outcome)).toEqual(["delta-diff-mismatch"]);
	});

	it("refuses without a gate decision (I10), for another Camp, with an unusable origin or an unknown Delta", async () => {
		const { desired } = setup();
		unwrap(
			await desired.open(
				delta("d1", {
					changes: diffResolvedSets(
						undefined,
						resolvedFor("prod-aws", SHOP_V1),
					),
				}),
				ctxAt(T0),
			),
		);
		const resolved = resolvedFor("prod-aws", SHOP_V1);
		const input = {
			deltaId: deltaId("d1"),
			gateDecisionId: "g",
			resolved,
			origin: SetOrigin.PROMOTION,
		};
		expect(
			codes(await desired.apply({ ...input, gateDecisionId: "" }, ctxAt(T0))),
		).toEqual(["gate-decision-missing"]);
		expect(
			codes(
				await desired.apply(
					{ ...input, resolved: resolvedFor("prod-azure", SHOP_V1) },
					ctxAt(T0),
				),
			),
		).toEqual(["resolved-set-camp-mismatch"]);
		expect(
			codes(
				await desired.apply(
					{
						...input,
						resolved: resolvedFor("prod-aws", SHOP_V1, { tenant: "evil" }),
					},
					ctxAt(T0),
				),
			),
		).toEqual(["resolved-set-camp-mismatch"]);
		expect(
			codes(
				await desired.apply(
					{ ...input, origin: SetOrigin.UNSPECIFIED },
					ctxAt(T0),
				),
			),
		).toEqual(["set-origin-invalid"]);
		expect(
			codes(
				await desired.apply(
					{ ...input, origin: SetOrigin.LEGACY_FOLD },
					ctxAt(T0),
				),
			),
		).toEqual(["set-origin-invalid"]);
		expect(
			codes(
				await desired.apply({ ...input, deltaId: deltaId("nope") }, ctxAt(T0)),
			),
		).toEqual(["delta-not-found"]);
	});

	it("refuses secret material and forged content hashes before anything is stored", async () => {
		const { desired, artifacts } = setup();
		const leaky = resolvedFor("prod-aws", [
			{ name: "shop.api", image: "ghp_abcdefghijklmnopqrstuvwxyz0123" },
		]);
		unwrap(
			await desired.open(
				delta("d1", { changes: diffResolvedSets(undefined, leaky) }),
				ctxAt(T0),
			),
		);
		const input = {
			deltaId: deltaId("d1"),
			gateDecisionId: "g",
			resolved: leaky,
			origin: SetOrigin.PROMOTION,
		};
		expect(codes(await desired.apply(input, ctxAt(T0)))).toEqual([
			"secret-material",
		]);
		const forged = {
			...resolvedFor("prod-aws", SHOP_V1),
			environment: "staging",
		};
		expect(
			codes(await desired.apply({ ...input, resolved: forged }, ctxAt(T0))),
		).toEqual(["resolved-set-invalid"]);
		expect(artifacts.puts).toHaveLength(0);
	});

	it("refuses when the artifact store reports a different digest than the canonical bytes", async () => {
		const { desired, artifacts } = setup();
		artifacts.lieAboutDigest = `sha256:${"0".repeat(64)}`;
		unwrap(
			await desired.open(
				delta("d1", {
					changes: diffResolvedSets(
						undefined,
						resolvedFor("prod-aws", SHOP_V1),
					),
				}),
				ctxAt(T0),
			),
		);
		const outcome = await desired.apply(
			{
				deltaId: deltaId("d1"),
				gateDecisionId: "g",
				resolved: resolvedFor("prod-aws", SHOP_V1),
				origin: SetOrigin.PROMOTION,
			},
			ctxAt(T0),
		);
		expect(codes(outcome)).toEqual(["blob-digest-mismatch"]);
		expect(await desired.current(PROD)).toBeUndefined();
	});

	it("concurrent applies: exactly one wins, the loser is refused with a typed reason", async () => {
		const { desired, store, artifacts } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		// Two Deltas against the same base race to apply. The second open would
		// overlap, so the race is modelled the way it happens across processes:
		// both writers read the same head, then append.
		unwrap(
			await desired.open(
				delta("d2", {
					baseSetId: set.setId,
					changes: diffResolvedSets(
						resolvedFor("prod-aws", SHOP_V1),
						resolvedFor("prod-aws", SHOP_V2),
					),
				}),
				ctxAt(T0),
			),
		);
		const resolved = resolvedFor("prod-aws", SHOP_V2);
		const peer = createDesiredState({
			store,
			artifacts,
			tenant: "acme",
			now: () => T0,
		});
		let released: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			released = resolve;
		});
		let waiting = 0;
		store.beforeAppend = async () => {
			waiting += 1;
			if (waiting === 2) released();
			await gate;
		};
		const [a, b] = await Promise.all([
			desired.apply(
				{
					deltaId: deltaId("d2"),
					gateDecisionId: "g-a",
					resolved,
					origin: SetOrigin.PROMOTION,
				},
				ctxAt(T0 + 1),
			),
			peer.apply(
				{
					deltaId: deltaId("d2"),
					gateDecisionId: "g-b",
					resolved,
					origin: SetOrigin.PROMOTION,
				},
				ctxAt(T0 + 2),
			),
		]);
		store.beforeAppend = undefined;
		const winners = [a, b].filter((o) => o.ok);
		expect(winners).toHaveLength(2); // same Delta: the loser observes the winner's Set (idempotent)
		expect(
			store.log.filter((e) => e.event.type === CD_EVENTS.SetCreated),
		).toHaveLength(2);
		expect(a.ok && b.ok && a.value.setId === b.value.setId).toBe(true);
	});

	it("concurrent applies of competing Deltas: one wins, the other is refused concurrent-apply", async () => {
		const { desired, store } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		// A peer process opened a competing Delta on a stale read; simulate by
		// racing open+apply on two ledgers sharing the store.
		const peer = createDesiredState({
			store,
			artifacts: createFakeArtifactStore(),
			tenant: "acme",
			now: () => T0,
		});
		const changes = diffResolvedSets(
			resolvedFor("prod-aws", SHOP_V1),
			resolvedFor("prod-aws", SHOP_V2),
		);
		unwrap(
			await desired.open(
				delta("d2", { baseSetId: set.setId, changes }),
				ctxAt(T0),
			),
		);
		let released: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			released = resolve;
		});
		let waiting = 0;
		store.beforeAppend = async () => {
			waiting += 1;
			if (waiting === 2) released();
			await gate;
		};
		const resolved = resolvedFor("prod-aws", SHOP_V2);
		const [a, b] = await Promise.all([
			desired.apply(
				{
					deltaId: deltaId("d2"),
					gateDecisionId: "g-a",
					resolved,
					origin: SetOrigin.PROMOTION,
				},
				ctxAt(T0 + 1),
			),
			peer
				.reject(
					deltaId("d2"),
					[reasonOf("superseded", "newer", "", "")],
					ctxAt(T0 + 1),
				)
				.then(
					() => ({ ok: true }) as const,
					(error: Error) => ({ ok: false, error }) as const,
				),
		]);
		store.beforeAppend = undefined;
		// Exactly one of apply / reject landed.
		const applied = store.log.some(
			(e) =>
				e.event.type === CD_EVENTS.DeltaApplied &&
				member(e.event.data, "deltaId") === "d2",
		);
		const rejected = store.log.some(
			(e) => e.event.type === CD_EVENTS.DeltaRejected,
		);
		expect(applied !== rejected).toBe(true);
		if (applied) {
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(false);
		} else {
			expect(codes(a)).toEqual(["concurrent-apply"]);
		}
	});
});

describe("resolved()", () => {
	it("fetches and verifies the blob a Set references", async () => {
		const { desired } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		const resolved = await desired.resolved(set);
		expect(resolved.contentHash).toBe(set.contentHash);
		expect(resolved.campId).toBe("prod-aws");
	});

	it("refuses a blob whose digest no longer matches (corrupted at rest)", async () => {
		const { desired, artifacts, telemetry } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		artifacts.corrupt(set.resolvedSetDigest);
		await expect(desired.resolved(set)).rejects.toMatchObject({
			code: "resolved-set-digest-mismatch",
		});
		expect(
			telemetry.points.some(
				(p) => p.name === "hobo.cd.sets.resolved_set_verify_failures",
			),
		).toBe(true);
	});

	it("refuses a missing blob with a remediation naming the digest", async () => {
		const { desired, artifacts } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		artifacts.blobs.clear();
		const error = asDesiredStateError(
			await desired.resolved(set).then(
				() => undefined,
				(e: Error) => e,
			),
		);
		expect(error).toBeInstanceOf(DesiredStateError);
		expect(error.code).toBe("resolved-set-missing");
		expect(error.remediation).toContain(set.resolvedSetDigest);
	});

	it("refuses a Set record whose content hash disagrees with its blob", async () => {
		const { desired } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		await expect(
			desired.resolved({ ...set, contentHash: `sha256:${"a".repeat(64)}` }),
		).rejects.toMatchObject({
			code: "resolved-set-invalid",
		});
	});
});

describe("status() and the spec/status split", () => {
	function observation(
		setId: string,
		fence: string,
		status: ReconcileStatus,
		at: number,
	) {
		return toJson(
			ReconcileObservationRecordSchema,
			create(ReconcileObservationRecordSchema, {
				campId: "prod-aws",
				setId,
				reconcilerId: "rec-1",
				fenceToken: fence,
				status,
				observedAt: new Date(at).toISOString(),
			}),
		);
	}

	it("folds the status stream to the latest observation and ignores stale fences", async () => {
		const { desired, store } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		expect(await desired.status(PROD)).toBeUndefined();
		const stream = CD_STREAMS.campStatus("prod-aws");
		const actor = { kind: "agent" as const, id: "rec-1" };
		await store.append(
			stream,
			[
				{
					type: CD_EVENTS.ReconcileStarted,
					data: observation(set.setId, "2", ReconcileStatus.CONVERGING, T0),
				},
			],
			{ expectedSeq: 0, actor, tenant: "acme" },
		);
		await store.append(
			stream,
			[
				{
					type: CD_EVENTS.Converged,
					data: observation(set.setId, "2", ReconcileStatus.CONVERGED, T0 + 1),
				},
			],
			{ expectedSeq: 1, actor, tenant: "acme" },
		);
		await store.append(
			stream,
			[
				{
					type: CD_EVENTS.StatusObserved,
					data: observation(set.setId, "1", ReconcileStatus.DRIFTED, T0 + 2),
				},
			],
			{ expectedSeq: 2, actor, tenant: "acme" },
		);
		const status = await desired.status(PROD);
		expect(status?.status).toBe(ReconcileStatus.CONVERGED);
		expect(status?.fenceToken).toBe("2");
	});

	it("§10 observations under heavy apply load: no spec-stream conflicts", async () => {
		const { desired, store } = setup();
		await applyResources(desired, "d0", SHOP_V1);
		const statusStream = CD_STREAMS.campStatus("prod-aws");
		const actor = { kind: "agent" as const, id: "rec-1" };
		let statusSeq = 0;
		const observe = async (i: number) => {
			const current = await desired.current(PROD);
			await store.append(
				statusStream,
				[
					{
						type: CD_EVENTS.StatusObserved,
						data: observation(
							current?.setId ?? "",
							"1",
							ReconcileStatus.CONVERGING,
							T0 + i,
						),
					},
				],
				{ expectedSeq: statusSeq++, actor, tenant: "acme" },
			);
		};
		const conflictsBefore = store.conflicts;
		const work: Promise<void>[] = [];
		for (let i = 1; i <= 30; i++) {
			const resources = i % 2 === 0 ? SHOP_V1 : SHOP_V2;
			work.push(observe(i));
			await applyResources(desired, `d${i}`, resources, T0 + i * 10);
			work.push(observe(i + 1000));
		}
		await Promise.all(work);
		expect(store.conflicts).toBe(conflictsBefore);
		expect((await desired.history(PROD)).length).toBe(31);
		expect(
			store.log.filter((e) => e.event.streamId === statusStream),
		).toHaveLength(60);
		expect(
			store.log
				.filter((e) => e.event.streamId === CD_STREAMS.campSpec("prod-aws"))
				.every((e) => !e.event.type.startsWith("deployment.")),
		).toBe(true);
	});
});

describe("changes()", () => {
	it("streams Set changes by position for the requested Camps, then resumes after a cursor", async () => {
		const { desired } = setup();
		const s1 = await applyResources(desired, "d1", SHOP_V1);
		const s2 = await applyResources(desired, "d2", SHOP_V2, T0 + 10);
		const controller = new AbortController();
		const all = await collect(
			desired.changes({ campIds: [PROD], signal: controller.signal }),
			2,
		);
		expect(all.map((c) => c.set.setId)).toEqual([s1.setId, s2.setId]);
		expect(all[0]?.position).toBeLessThan(all[1]?.position ?? 0n);
		expect(
			all.every(
				(c) =>
					c.management === CampManagement.MANAGED &&
					c.observeFields.length === 0,
			),
		).toBe(true);
		const after = await collect(
			desired.changes({
				campIds: [PROD],
				after: cursorOf(all[0]),
				signal: controller.signal,
			}),
			1,
		);
		expect(after.map((c) => c.set.setId)).toEqual([s2.setId]);
		controller.abort();
	});

	it("tails live: a Set applied after subscription is delivered; abort ends the stream", async () => {
		const { desired } = setup();
		const controller = new AbortController();
		const iterator = desired
			.changes({ campIds: [PROD], signal: controller.signal })
			[Symbol.asyncIterator]();
		const next = iterator.next();
		const set = await applyResources(desired, "d1", SHOP_V1);
		const first = await next;
		expect(first.done).toBe(false);
		expect(first.value?.set.setId).toBe(set.setId);
		const pending = iterator.next();
		controller.abort();
		expect((await pending).done).toBe(true);
	});

	it("never yields another Camp's changes and carries the folded policy binding", async () => {
		const { desired, store } = setup();
		const set = await applyResources(desired, "d1", SHOP_V1);
		await store.append(
			CD_STREAMS.campSpec("prod-aws"),
			[
				{
					type: CD_EVENTS.PolicyBindingChanged,
					data: {
						campId: "prod-aws",
						enforcedRailDigest: `sha256:${"9".repeat(64)}`,
						boundAt: "2026-11-12T00:00:00.000Z",
					},
				},
			],
			{ expectedSeq: 3, actor: OPERATOR, tenant: "acme" },
		);
		await store.append(
			CD_STREAMS.campInventory("prod-aws"),
			[
				{
					type: CD_EVENTS.CampManagementChanged,
					data: {
						campId: "prod-aws",
						management: "CAMP_MANAGEMENT_OBSERVE_ONLY",
					},
				},
			],
			{ expectedSeq: 0, actor: OPERATOR, tenant: "acme" },
		);
		const other = createDesiredState({
			store,
			artifacts: createFakeArtifactStore(),
			tenant: "acme",
			now: () => T0,
		});
		unwrap(await other.open(delta("x1", { campId: "prod-azure" }), ctxAt(T0)));
		const controller = new AbortController();
		const changes = await collect(
			desired.changes({ campIds: [PROD], signal: controller.signal }),
			2,
		);
		controller.abort();
		expect(changes.map((c) => c.set.setId)).toEqual([set.setId, set.setId]);
		expect(changes[1]?.policy?.enforcedRailDigest).toBe(
			`sha256:${"9".repeat(64)}`,
		);
		expect(changes[1]?.management).toBe(CampManagement.OBSERVE_ONLY);
	});

	it("multi-Camp feeds yield in global position order and skip unrequested Camps", async () => {
		const { desired } = setup();
		const open = async (campId: string, id: string) => {
			const resolved = resolvedFor(campId, SHOP_V1);
			unwrap(
				await desired.open(
					delta(id, { campId, changes: diffResolvedSets(undefined, resolved) }),
					ctxAt(T0),
				),
			);
			return unwrap(
				await desired.apply(
					{
						deltaId: deltaId(id),
						gateDecisionId: `g-${id}`,
						resolved,
						origin: SetOrigin.UP,
					},
					ctxAt(T0),
				),
			);
		};
		const a = await open("camp-a", "a1");
		await open("camp-x", "x1");
		const b = await open("camp-b", "b1");
		const controller = new AbortController();
		const frames = await collect(
			desired.changes({
				campIds: [camp("camp-b"), camp("camp-a")],
				signal: controller.signal,
			}),
			2,
		);
		controller.abort();
		expect(frames.map((f) => f.set.setId)).toEqual([a.setId, b.setId]);
		expect((frames[0]?.position ?? 0n) < (frames[1]?.position ?? 0n)).toBe(
			true,
		);
	});

	it("passes posture observe_fields through when a posture reader is composed", async () => {
		const store = createFakeEventStore();
		const desired = createDesiredState({
			store,
			artifacts: createFakeArtifactStore(),
			tenant: "acme",
			now: () => T0,
			posture: { observeFields: async () => ["tls.minVersion"] },
		});
		await applyResources(desired, "d1", SHOP_V1);
		const controller = new AbortController();
		const [change] = await collect(
			desired.changes({ campIds: [PROD], signal: controller.signal }),
			1,
		);
		controller.abort();
		expect(change?.observeFields).toEqual(["tls.minVersion"]);
	});
});

describe("telemetry never breaks a mutation", () => {
	it("a throwing TelemetrySink does not fail apply", async () => {
		const store = createFakeEventStore();
		const desired = createDesiredState({
			store,
			artifacts: createFakeArtifactStore(),
			tenant: "acme",
			now: () => T0,
			telemetry: {
				spans: async () => {},
				metrics: async () => {
					throw new Error("collector down");
				},
			},
		});
		const set = await applyResources(desired, "d1", SHOP_V1);
		expect(set.setId).toMatch(/^set_[0-9a-f]{32}$/);
	});
});

it("Set ids are deterministic for the same tenant, Camp, Delta and content", async () => {
	const a = setup();
	const b = setup();
	const s1 = await applyResources(a.desired, "d1", SHOP_V1);
	const s2 = await applyResources(b.desired, "d1", SHOP_V1);
	expect(s1.setId).toBe(s2.setId);
	expect(s1.setId).toMatch(/^set_[0-9a-f]{32}$/);
	const changes = diffResolvedSets(undefined, resolvedFor("prod-aws", SHOP_V1));
	expect(changes.every((c) => c.kind === ChangeKind.ADD)).toBe(true);
});

function cursorOf(
	change: { position: EventPosition } | undefined,
): EventPosition {
	if (change === undefined) throw new Error("no change to resume after");
	return change.position;
}
