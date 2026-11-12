// A rollout end to end on a real SQLite journal (@hobo/storage-sqlite): the
// real Harness engine, the real desired state (@hobo/cd/sets) and the real
// in-process reconcile transport all share one durable store, so every event
// type the rollout appends must pass the journal's `family.PastTenseFact`
// check, and DesiredStateReader.status() must fold the `{ schema,
// observation }` body the reconcile transport writes. HoBo delivering its own
// CI relay found both broken (plan 0024); this is the regression.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeSqliteDriver,
	SqliteJournal,
} from "../../../storage-sqlite/src/index.js";
import {
	type DeltaRecord,
	DeltaRecordSchema,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	RolloutStrategy,
	SetOrigin,
	type SetRecord,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { createHarnessRolloutEngine } from "../../src/adapters/harness.js";
import { DELTA_SCHEMA } from "../../src/events.js";
import type {
	CampId,
	CdContext,
	DeltaId,
	ReconcilerId,
	RolloutId,
} from "../../src/ports.js";
import { createInProcessTransport } from "../../src/reconcile/transport.js";
import { ROLLOUT_LEDGER } from "../../src/rollout/journal.js";
import { createRolloutOrchestrator } from "../../src/rollout/orchestrator.js";
import { createDesiredState, diffResolvedSets } from "../../src/sets/index.js";
import {
	createFakeArtifactStore,
	resolvedFor,
	SHOP_V1,
	SHOP_V2,
} from "../sets/fakes.js";
import {
	clock,
	context,
	FakeApprovals,
	FakeTraffic,
	FakeVerification,
	FakeWindows,
	MINUTE,
	promotion,
	RecordingTelemetry,
	spec,
	TENANT,
} from "./fakes.js";

const CAMP = "prod-a";
const PREVIOUS =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";
const FREIGHT =
	"sha256:2222222222222222222222222222222222222222222222222222222222222222";
// The journal's own event-type rule (@hobo/core EVENT_TYPE_PATTERN).
const STORABLE = /^[a-z][a-z0-9]*\.[A-Z][A-Za-z0-9]*$/;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function campId(id: string): CampId {
	// SAFETY: test Camp ids are opaque strings.
	return id as CampId;
}

function openJournal(path: string, now: () => number): SqliteJournal {
	return new SqliteJournal(createNodeSqliteDriver({ path }), {
		clock: { now: () => new Date(now()).toISOString() },
	});
}

function world(journal: SqliteJournal, now: () => number) {
	const base = { store: journal, tenant: TENANT, now };
	const desired = createDesiredState({
		...base,
		artifacts: createFakeArtifactStore(),
	});
	const traffic = new FakeTraffic();
	const verification = new FakeVerification();
	const orchestrator = createRolloutOrchestrator({
		...base,
		engine: createHarnessRolloutEngine(base),
		traffic,
		verification,
		windows: new FakeWindows(),
		desired,
		approvals: new FakeApprovals(),
		telemetry: new RecordingTelemetry(),
	});
	const transport = createInProcessTransport({ ...base, desired });
	return { desired, traffic, verification, orchestrator, transport };
}

type World = ReturnType<typeof world>;

async function promote(
	w: World,
	id: string,
	freightId: string,
	resources: typeof SHOP_V1,
	ctx: CdContext,
): Promise<SetRecord> {
	const current = await w.desired.current(campId(CAMP));
	const before =
		current === undefined ? undefined : await w.desired.resolved(current);
	const resolved = resolvedFor(CAMP, resources);
	const delta: DeltaRecord = create(DeltaRecordSchema, {
		schemaVersion: DELTA_SCHEMA,
		deltaId: id,
		campId: CAMP,
		intent: "promote",
		freightId,
		baseSetId: current?.setId ?? "",
		changes: diffResolvedSets(before, resolved),
	});
	const opened = await w.desired.open(delta, ctx);
	if (!opened.ok) throw new Error(`open ${id} refused`);
	const applied = await w.desired.apply(
		{
			// SAFETY: the Delta id this test just opened.
			deltaId: id as DeltaId,
			gateDecisionId: `gate-${id}`,
			resolved,
			origin: SetOrigin.PROMOTION,
		},
		ctx,
	);
	if (!applied.ok) throw new Error(`apply ${id} refused`);
	return applied.value;
}

/** Report the Camp CONVERGED on `set` through the real reconcile transport. */
async function reportConverged(w: World, set: SetRecord, atMs: number) {
	const reconcilerId = "rec-1" as ReconcilerId;
	const claimed = await w.transport.claim({
		reconcilerId,
		campId: campId(CAMP),
		holderId: "holder-1",
		ttlMs: 10 * MINUTE,
	});
	if (!claimed.ok) throw new Error("claim refused");
	const lease = claimed.value;
	const reported = await w.transport.report(
		lease,
		create(ReconcileObservationRecordSchema, {
			campId: CAMP,
			setId: set.setId,
			reconcilerId,
			fenceToken: lease.fence.toString(10),
			status: ReconcileStatus.CONVERGED,
			observedAt: new Date(atMs).toISOString(),
		}),
	);
	if (!reported.ok) throw new Error("report refused");
	await w.transport.release(lease);
}

async function types(journal: SqliteJournal, streamId: string) {
	const out: string[] = [];
	for await (const event of journal.read(streamId)) out.push(event.type);
	return out;
}

describe("rollout on a durable SQLite journal", () => {
	it("DesiredStateReader.status() folds the observation the reconcile transport reports", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-cd-durable-"));
		dirs.push(dir);
		const time = clock();
		const journal = openJournal(join(dir, "journal.sqlite"), time.now);
		const w = world(journal, time.now);
		const ctx = context(time.now);
		const set = await promote(w, "d-promote", FREIGHT, SHOP_V1, ctx);
		expect(await w.desired.status(campId(CAMP))).toBeUndefined();
		await reportConverged(w, set, time.now());
		const status = await w.desired.status(campId(CAMP));
		expect(status?.status).toBe(ReconcileStatus.CONVERGED);
		expect(status?.setId).toBe(set.setId);
		expect(status?.reconcilerId).toBe("rec-1");
		journal.close();
	});

	it("plan → run → rollback runs end to end and replays from the reopened journal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-cd-durable-"));
		dirs.push(dir);
		const path = join(dir, "journal.sqlite");
		const time = clock();
		const journal = openJournal(path, time.now);
		const w = world(journal, time.now);
		const ctx = context(time.now);
		await promote(w, "d-previous", PREVIOUS, SHOP_V1, ctx);
		const promoted = await promote(w, "d-promote", FREIGHT, SHOP_V2, ctx);
		await reportConverged(w, promoted, time.now());
		// The first stage's verification fails: the rollout must roll back.
		w.verification.script = () => VerificationVerdict.FAIL;

		const planned = await w.orchestrator.plan(
			{
				promotion: promotion({
					targets: [CAMP],
					freight: FREIGHT,
					strategy: RolloutStrategy.CANARY,
				}),
				obligations: [],
				verification: spec(),
				stagePercents: [],
				windows: ["prod"],
			},
			ctx,
		);
		if (!planned.ok) throw new Error("plan refused");
		const ran = await w.orchestrator.run(planned.value, ctx);
		expect(ran.status).not.toBe("failed");
		const rolloutId = planned.value.rolloutId as RolloutId;
		for (let i = 0; i < 20; i += 1) {
			const snapshot = await w.orchestrator.get(rolloutId);
			if (snapshot?.status === "rolled-back" || snapshot?.status === "failed")
				break;
			time.advance(MINUTE);
			await w.orchestrator.tick(ctx);
		}

		const finished = await w.orchestrator.get(rolloutId);
		expect(finished?.status).toBe("rolled-back");
		// The Camp took canary traffic (the reconciler's CONVERGED report was
		// folded), then went back to zero.
		expect(w.traffic.percents(CAMP).at(0)).toBeGreaterThan(0);
		expect(w.traffic.percents(CAMP).at(-1)).toBe(0);
		// The rollback Delta to the predecessor Set is in the durable Delta ledger.
		const opened = finished?.reasons.find(
			(r) => r.code === "rollback-delta-opened",
		);
		expect(opened).toBeDefined();
		// SAFETY: the reason's subject is the rollback Delta id.
		const rollback = await w.desired.get((opened?.subject ?? "") as DeltaId);
		expect(rollback?.intent).toBe("rollback");
		expect(rollback?.freightId).toBe(PREVIOUS);
		expect(rollback?.baseSetId).toBe(promoted.setId);

		const ledger = await types(journal, ROLLOUT_LEDGER.stream(rolloutId));
		expect(ledger).toContain(ROLLOUT_LEDGER.rollbackStarted);
		expect(ledger.at(-1)).toBe(ROLLOUT_LEDGER.finished);
		for (const type of ledger) expect(type).toMatch(STORABLE);
		journal.close();

		// A fresh process over the reopened journal replays to the same outcome.
		const reopened = openJournal(path, time.now);
		const again = world(reopened, time.now);
		expect((await again.orchestrator.get(rolloutId))?.status).toBe(
			"rolled-back",
		);
		const status = await again.desired.status(campId(CAMP));
		expect(status?.setId).toBe(promoted.setId);
		expect(status?.status).toBe(ReconcileStatus.CONVERGED);
		reopened.close();
	});
});
