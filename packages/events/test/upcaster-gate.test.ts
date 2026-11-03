// M4 GA handoff: the golden-replay corpus / upcaster-totality gate promoted
// from event-body-upcaster-gate. This test IS the can-deploy wiring — an
// event body that cannot be lifted to the current version fails this lane.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { at, first } from "@hobo/core/total-access";
import { test } from "vitest";
import {
	type CorpusBaseline,
	createCorpusBaseline,
	createCorpusEntry,
	type EventEvolutionContract,
	eventSchema,
	runCanDeployUpcasterGate,
	stringField,
	u32Field,
} from "../src/upcaster.js";
import {
	MIGRATION_EVENT_CONTRACTS,
	migrationCorpusBaseline,
} from "../src/upcaster-corpus.js";
/** The promoted three-version evolution fixture (summary→title→requesterRef). */
function ticketContract(): EventEvolutionContract {
	const type = "ticket.Opened";
	const schemas = [
		eventSchema(type, 1, [
			stringField("ticketId", 1),
			stringField("summary", 2),
			u32Field("priority", 3),
			stringField("requesterEmail", 4),
		]),
		eventSchema(type, 2, [
			stringField("ticketId", 1),
			stringField("title", 2),
			u32Field("priority", 3),
			stringField("requesterEmail", 4),
			stringField("source", 5, { required: false }),
		]),
		eventSchema(type, 3, [
			stringField("ticketId", 1),
			stringField("title", 2),
			u32Field("priority", 3),
			stringField("source", 5, { required: false }),
			stringField("requesterRef", 6),
		]),
	];
	return {
		type,
		currentVersion: 3,
		schemas,
		upcasters: [
			{
				type,
				from: 1,
				to: 2,
				reason: "summary was renamed to title",
				upcast: (body) => ({
					ticketId: body.ticketId,
					title: body.summary,
					priority: body.priority,
					requesterEmail: body.requesterEmail,
					source: "legacy-v1",
				}),
			},
			{
				type,
				from: 2,
				to: 3,
				reason: "requesterEmail became requesterRef (no raw PII retained)",
				upcast: (body) => ({
					ticketId: body.ticketId,
					title: body.title,
					priority: body.priority,
					requesterRef: `email:${String(body.requesterEmail)}`,
					source: body.source,
				}),
			},
		],
		goldenCorpus: [
			createCorpusEntry(first(schemas), "ticket-opened-v1", {
				ticketId: "ticket_123",
				summary: "checkout fails",
				priority: 3,
				requesterEmail: "user@example.test",
			}),
			createCorpusEntry(at(schemas, 1), "ticket-opened-v2", {
				ticketId: "ticket_456",
				title: "login fails",
				priority: 2,
				requesterEmail: "admin@example.test",
				source: "native-v2",
			}),
			createCorpusEntry(at(schemas, 2), "ticket-opened-v3", {
				ticketId: "ticket_789",
				title: "search slow",
				priority: 4,
				requesterRef: "principal:user_789",
				source: "native-v3",
			}),
		],
	};
}

test("promoted evolution fixture passes the gate: every pinned body lifts to v3", () => {
	const report = runCanDeployUpcasterGate(ticketContract());
	assert.deepEqual(report.errors, []);
	assert.equal(report.ok, true);
	assert.equal(report.replays.length, 3);
	for (const replay of report.replays) {
		assert.equal(replay.currentVersion, 3);
		// PII invariant carried by the v2→v3 upcaster: no requesterEmail at v3.
		assert.ok(!("requesterEmail" in replay.currentBody));
	}
});

test("a missing upcaster is a non-total chain and fails can-deploy", () => {
	const contract = ticketContract();
	const broken = {
		...contract,
		upcasters: [at(contract.upcasters, 1)],
	};
	const report = runCanDeployUpcasterGate(broken);
	assert.equal(report.ok, false);
	assert.ok(
		report.errors.some((error) => error.includes("non-total upcaster chain")),
	);
});

test("a version bump without a corpus entry fails coverage", () => {
	const contract = ticketContract();
	const uncovered = {
		...contract,
		goldenCorpus: contract.goldenCorpus.slice(1),
	};
	const report = runCanDeployUpcasterGate(uncovered);
	assert.equal(report.ok, false);
	assert.ok(
		report.errors.some((error) =>
			error.includes("missing golden corpus entry for ticket.Opened@v1"),
		),
	);
});

test("append-only baseline: deleting or editing a pinned entry is detected", () => {
	const contract = ticketContract();
	const baseline = createCorpusBaseline(contract.goldenCorpus);
	// Deletion.
	const withDeletion = {
		...contract,
		goldenCorpus: contract.goldenCorpus.slice(0, 2),
	};
	const deletionReport = runCanDeployUpcasterGate(withDeletion, {
		baselineCorpus: baseline,
	});
	assert.ok(
		deletionReport.errors.some((error) =>
			error.includes("append-only corpus deletion detected"),
		),
	);
	// Digest tamper.
	const tampered: CorpusBaseline = {
		...baseline,
		entries: baseline.entries.map((entry, index) =>
			index === 0 ? { ...entry, bodyDigest: "sha256:tampered" } : entry,
		),
	};
	const tamperReport = runCanDeployUpcasterGate(contract, {
		baselineCorpus: tampered,
	});
	assert.ok(
		tamperReport.errors.some((error) =>
			error.includes("append-only corpus digest changed"),
		),
	);
});

test("can-deploy: every migration.* contract replays clean against the pinned baseline file", () => {
	const baselinePath = path.join(
		import.meta.dirname,
		"..",
		"corpus",
		"golden-replay-baseline.json",
	);
	// SAFETY: the committed baseline file is validated by the gate as CorpusBaseline.
	const pinned = JSON.parse(
		readFileSync(baselinePath, "utf8"),
	) as CorpusBaseline;

	// The committed baseline must be exactly today's corpus (append-only pin).
	assert.deepEqual(migrationCorpusBaseline(), pinned);

	for (const contract of MIGRATION_EVENT_CONTRACTS) {
		const report = runCanDeployUpcasterGate(contract, {
			baselineCorpus: {
				...pinned,
				entries: pinned.entries.filter((entry) =>
					entry.key.startsWith(`${contract.type}@`),
				),
			},
		});
		assert.deepEqual(report.errors, [], `gate failed for ${contract.type}`);
	}
});
