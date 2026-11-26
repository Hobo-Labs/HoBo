/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test fixtures brand ids minted by the fake journal, build partial generated records, and read controlled JSON fixtures at the test boundary. */
// Provider verification of the reconciler ↔ transport boundary against the
// consumer pact beside it. The in-process transport is verified here; the
// HTTP transport (./agent, WP11) verifies the same pact over the feed.
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import type { EventPosition } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import type { DesiredStateChange, ReconcilerLease } from "../../src/ports.js";
import {
	createInProcessTransport,
	RECONCILE_FAILURES,
} from "../../src/reconcile/index.js";
import {
	asCamp,
	asReconciler,
	createClock,
	createFakeDesired,
	createFakeStore,
	resolvedFor,
	setFor,
	statusEvents,
	TENANT,
} from "./fakes.js";

type Body = Record<string, unknown>;
type Interaction = {
	description: string;
	providerState: string;
	request: { method: string; body: Body };
	response: {
		body: Body;
		matchingRules?: Record<string, { match: string; regex: string }>;
	};
};

const pact: {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
} = JSON.parse(
	readFileSync(
		new URL("./reconciler-transport.pact.json", import.meta.url),
		"utf8",
	),
);

function find(description: string): Interaction {
	const found = pact.interactions.find((i) => i.description === description);
	if (!found) throw new Error(`no interaction: ${description}`);
	return found;
}

const CAMP = asCamp("prod-eu");

async function provider(withBlob = true) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const desired = createFakeDesired(store, ["tls.minVersion"]);
	const transport = createInProcessTransport({
		store,
		tenant: TENANT,
		now: clock.now,
		desired,
		feedTimeoutMs: 500,
	});
	const resolved = resolvedFor(CAMP, [{ name: "api" }]);
	await desired.publish(
		setFor(CAMP, resolved, 1, SetOrigin.PROMOTION),
		withBlob ? resolved : undefined,
	);
	return { clock, store, desired, transport };
}

async function claim(
	transport: Awaited<ReturnType<typeof provider>>["transport"],
	reconcilerId = "r-a",
	holderId = "host-a",
) {
	const out = await transport.claim({
		reconcilerId: asReconciler(reconcilerId),
		campId: CAMP,
		holderId,
		ttlMs: 30_000,
	});
	if (!out.ok) throw new Error(out.reasons[0]?.code);
	return out.value;
}

async function changes(
	transport: Awaited<ReturnType<typeof provider>>["transport"],
	lease: ReconcilerLease,
) {
	const out: DesiredStateChange[] = [];
	for await (const change of transport.feed({
		lease,
		signal: new AbortController().signal,
	}))
		out.push(change);
	return out;
}

function refusal(out: {
	ok: boolean;
	reasons?: readonly { code: string; remediation: string }[];
}) {
	return {
		ok: out.ok,
		code: out.reasons?.[0]?.code,
		hasRemediation: (out.reasons?.[0]?.remediation ?? "").length > 0,
	};
}

describe(`pact ${pact.consumer.name} → ${pact.provider.name}`, () => {
	it("every refusal code in the pact is a documented reconcile failure", () => {
		for (const i of pact.interactions) {
			const code = i.response.body.code;
			if (typeof code === "string")
				expect(Object.keys(RECONCILE_FAILURES)).toContain(code);
		}
	});

	it(
		find("a reconciler claims the Camp lease keyed by Camp").description,
		async () => {
			const i = find("a reconciler claims the Camp lease keyed by Camp");
			const p = await provider();
			const lease = await claim(p.transport);
			const expected = i.response.body.lease as Body;
			expect({
				reconcilerId: lease.reconcilerId,
				campId: lease.campId,
				holderId: lease.holderId,
			}).toEqual({
				reconcilerId: expected.reconcilerId,
				campId: expected.campId,
				holderId: expected.holderId,
			});
			expect(lease.fence.toString(10)).toMatch(
				new RegExp(
					i.response.matchingRules?.["$.body.lease.fence"]?.regex ?? "",
				),
			);
		},
	);

	it(
		find(
			"a second reconciler with a different id is refused while the lease is held",
		).description,
		async () => {
			const i = find(
				"a second reconciler with a different id is refused while the lease is held",
			);
			const p = await provider();
			await claim(p.transport);
			const out = await p.transport.claim({
				reconcilerId: asReconciler("r-b"),
				campId: CAMP,
				holderId: "host-b",
				ttlMs: 30_000,
			});
			expect(refusal(out)).toEqual(i.response.body);
		},
	);

	it(
		find(
			"the feed yields desired-state changes after the checkpoint with management and observe fields",
		).description,
		async () => {
			const i = find(
				"the feed yields desired-state changes after the checkpoint with management and observe fields",
			);
			const p = await provider();
			const lease = await claim(p.transport);
			const got = await changes(p.transport, lease);
			expect({
				changes: got.map((c) => ({
					management:
						c.management === 1
							? "CAMP_MANAGEMENT_MANAGED"
							: "CAMP_MANAGEMENT_OBSERVE_ONLY",
					observeFields: [...c.observeFields],
					setOrigin:
						SetOrigin[c.set.origin] === "PROMOTION"
							? "SET_ORIGIN_PROMOTION"
							: String(c.set.origin),
				})),
			}).toEqual(i.response.body);
		},
	);

	it(
		find("a missing resolved-set blob is a typed refusal").description,
		async () => {
			const i = find("a missing resolved-set blob is a typed refusal");
			const p = await provider(false);
			const lease = await claim(p.transport);
			const [change] = await changes(p.transport, lease);
			if (!change) throw new Error("no change");
			expect(refusal(await p.transport.resolved(lease, change.set))).toEqual(
				i.response.body,
			);
		},
	);

	it(
		find("a report lands on the Camp status stream, never the spec stream")
			.description,
		async () => {
			const i = find(
				"a report lands on the Camp status stream, never the spec stream",
			);
			const p = await provider();
			const lease = await claim(p.transport);
			const before = p.store.log.filter(
				(e) => e.event.streamId === CD_STREAMS.campSpec(CAMP),
			).length;
			const out = await p.transport.report(
				lease,
				create(ReconcileObservationRecordSchema, {
					campId: CAMP,
					reconcilerId: "r-a",
					fenceToken: lease.fence.toString(10),
					status: ReconcileStatus.CONVERGED,
					observedAt: "2026-11-12T00:00:00.000Z",
				}),
			);
			expect(out.ok).toBe(true);
			const events = statusEvents(p.store, CAMP);
			expect({
				ok: out.ok,
				stream: events[0]?.streamId,
				events: events.map((e) => e.type),
			}).toEqual(i.response.body);
			expect(
				p.store.log.filter(
					(e) => e.event.streamId === CD_STREAMS.campSpec(CAMP),
				).length,
			).toBe(before);
		},
	);

	it(
		find("a report or checkpoint with a stale fence is refused").description,
		async () => {
			const i = find("a report or checkpoint with a stale fence is refused");
			const p = await provider();
			const stale = await claim(p.transport);
			p.clock.advance(31_000);
			await claim(p.transport, "r-b", "host-b");
			const report = await p.transport.report(
				stale,
				create(ReconcileObservationRecordSchema, {
					campId: CAMP,
					reconcilerId: "r-a",
					fenceToken: stale.fence.toString(10),
					status: ReconcileStatus.CONVERGED,
				}),
			);
			expect(refusal(report)).toEqual(i.response.body);
			expect(
				refusal(await p.transport.checkpoint(stale, 1n as EventPosition)),
			).toEqual(i.response.body);
		},
	);

	it(find("a checkpoint is fenced and monotonic").description, async () => {
		const i = find("a checkpoint is fenced and monotonic");
		const p = await provider();
		const lease = await claim(p.transport);
		expect((await p.transport.checkpoint(lease, 5n as EventPosition)).ok).toBe(
			true,
		);
		expect(
			refusal(await p.transport.checkpoint(lease, 2n as EventPosition)),
		).toEqual(i.response.body);
	});
});
