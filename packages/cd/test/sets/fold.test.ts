import { readFileSync } from "node:fs";
import type { EventEnvelope, JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ReconcileStatus, SetOrigin } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import {
	DesiredStateError,
	foldCampSpec,
	foldCampStatus,
} from "../../src/sets/index.js";

type JournalFixture = {
	campId: string;
	events: { type: string; data: JsonObject }[];
	expected: {
		currentSetId: string;
		history: string[];
		deltas: Record<string, string>;
		openDeltaId: string | null;
		enforcedRailDigest: string;
		candidateRailDigest: string;
		resolvedSetBytes: string;
		origin: string;
	};
};

const golden: JournalFixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/golden-journal.json", import.meta.url),
		"utf8",
	),
);

function envelopes(
	campId: string,
	events: readonly { type: string; data: JsonObject }[],
): EventEnvelope[] {
	return events.map((event, index) => ({
		id: `evt-${index + 1}`,
		type: event.type,
		v: 1,
		streamId: `cd-camp-${campId}`,
		seq: index + 1,
		ts: "2026-11-12T00:00:00.000Z",
		actor: { kind: "user", id: "ops" },
		tenant: "acme",
		data: event.data,
	}));
}

const base = golden.events;
const setCreated = base[2] ?? { type: "missing", data: {} };

describe("sets fold (golden journal)", () => {
	it("folds the pinned golden journal into the expected Camp spec projection", () => {
		const state = foldCampSpec(
			golden.campId,
			envelopes(golden.campId, golden.events),
		);
		expect(state.current?.setId).toBe(golden.expected.currentSetId);
		expect(state.sets.map((set) => set.setId)).toEqual(golden.expected.history);
		expect(
			Object.fromEntries(
				[...state.deltas].map(([id, delta]) => [id, delta.status]),
			),
		).toEqual(golden.expected.deltas);
		expect(state.openDeltaId ?? null).toBe(golden.expected.openDeltaId);
		expect(state.policy?.enforcedRailDigest).toBe(
			golden.expected.enforcedRailDigest,
		);
		expect(state.policy?.candidateRailDigest).toBe(
			golden.expected.candidateRailDigest,
		);
		expect(state.current?.resolvedSetBytes.toString()).toBe(
			golden.expected.resolvedSetBytes,
		);
		expect(`SET_ORIGIN_${SetOrigin[state.current?.origin ?? 0]}`).toBe(
			golden.expected.origin,
		);
		expect(state.seq).toBe(golden.events.length);
	});

	it("is replay-deterministic: folding twice yields identical projections", () => {
		const first = foldCampSpec(
			golden.campId,
			envelopes(golden.campId, golden.events),
		);
		const second = foldCampSpec(
			golden.campId,
			envelopes(golden.campId, golden.events),
		);
		expect(second.current).toEqual(first.current);
		expect([...second.deltas]).toEqual([...first.deltas]);
	});

	it("ignores event types it does not own (forward compatible)", () => {
		const events = [
			...golden.events,
			{ type: "camp.Something", data: { anything: true } },
		];
		const state = foldCampSpec(golden.campId, envelopes(golden.campId, events));
		expect(state.current?.setId).toBe(golden.expected.currentSetId);
	});
});

describe("HOBO-50 projection rules (promoted from docs/design/proofs/hobo-50-deployment-set-delta)", () => {
	it("rejects overlapping open Deltas for the same Camp", () => {
		const opened = (id: string) => ({
			type: CD_EVENTS.DeltaOpened,
			data: {
				schemaVersion: "hobo.cd.delta/v1",
				deltaId: id,
				campId: "prod-aws",
				intent: "up",
			},
		});
		expect(() =>
			foldCampSpec(
				"prod-aws",
				envelopes("prod-aws", [opened("d1"), opened("d2")]),
			),
		).toThrow(/overlapping open delta/i);
	});

	it("rejects opening a Delta against a stale non-current Set", () => {
		const stale = {
			type: CD_EVENTS.DeltaOpened,
			data: {
				schemaVersion: "hobo.cd.delta/v1",
				deltaId: "d-stale",
				campId: "prod-aws",
				baseSetId: "set_old",
				intent: "promote",
			},
		};
		expect(() =>
			foldCampSpec(
				"prod-aws",
				envelopes("prod-aws", [...base.slice(0, 3), stale]),
			),
		).toThrow(/current Set/i);
	});

	it("rejects delta.Updated before delta.Opened (out-of-order)", () => {
		const updated = {
			type: CD_EVENTS.DeltaUpdated,
			data: {
				schemaVersion: "hobo.cd.delta/v1",
				deltaId: "d-x",
				campId: "prod-aws",
				intent: "promote",
			},
		};
		expect(() =>
			foldCampSpec("prod-aws", envelopes("prod-aws", [updated])),
		).toThrow(/before delta.Opened/i);
	});

	it("rejects a set.Created whose predecessor is not the current Set", () => {
		const orphan = {
			type: CD_EVENTS.SetCreated,
			data: { ...setCreated.data, predecessorSetId: "set_ghost" },
		};
		let caught: DesiredStateError | undefined;
		try {
			foldCampSpec("prod-aws", envelopes("prod-aws", [orphan]));
		} catch (error) {
			if (error instanceof DesiredStateError) caught = error;
		}
		expect(caught?.code).toBe("journal-invalid");
		expect(caught?.remediation).toMatch(/journal/);
	});

	it("rejects an event recorded for a different Camp", () => {
		expect(() =>
			foldCampSpec("prod-azure", envelopes("prod-aws", [setCreated])),
		).toThrow(/camp/i);
	});
});

type StatusFixture = {
	campId: string;
	events: { type: string; data: JsonObject }[];
	expected: {
		setId: string;
		fenceToken: string;
		status: string;
		observedAt: string;
	};
};

const goldenStatus: StatusFixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/golden-status.json", import.meta.url),
		"utf8",
	),
);

describe("sets status fold (golden status stream)", () => {
	it("folds the { schema, observation } envelope the reconcile transport writes", () => {
		const status = foldCampStatus(
			envelopes(goldenStatus.campId, goldenStatus.events),
		);
		expect(status?.setId).toBe(goldenStatus.expected.setId);
		expect(status?.fenceToken).toBe(goldenStatus.expected.fenceToken);
		expect(`RECONCILE_STATUS_${ReconcileStatus[status?.status ?? 0]}`).toBe(
			goldenStatus.expected.status,
		);
		expect(status?.observedAt).toBe(goldenStatus.expected.observedAt);
	});

	it("still reads the legacy bare observation body", () => {
		const legacy = goldenStatus.events.slice(0, 1);
		const status = foldCampStatus(envelopes(goldenStatus.campId, legacy));
		expect(status?.setId).toBe("set_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(status?.status).toBe(ReconcileStatus.CONVERGED);
	});

	it("ignores an envelope whose schema it does not know (fail-closed)", () => {
		const unknown = goldenStatus.events.slice(-1);
		expect(
			foldCampStatus(envelopes(goldenStatus.campId, unknown)),
		).toBeUndefined();
	});

	it("rejects an envelope whose observation is not an observation record", () => {
		expect(() =>
			foldCampStatus(
				envelopes(goldenStatus.campId, [
					{
						type: CD_EVENTS.StatusObserved,
						data: {
							schema: "hobo.cd.reconcile-status/v1",
							observation: { fenceToken: ["2"] },
						},
					},
				]),
			),
		).toThrow(DesiredStateError);
	});
});
