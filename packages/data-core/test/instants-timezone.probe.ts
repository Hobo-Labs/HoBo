// Run by `instants-timezone.test.ts` in a child process, once per time zone:
// a worker thread cannot change its zone, a process started with `TZ` set can.
//
// It prints one JSON document — what the custody verdict and the selector say
// about a fixed set of instants — and the test asserts the document is the
// same in every zone.
import {
	CUSTODY_ROLES,
	createReferenceEngine,
	evaluateCustodyPath,
	type JsonObject,
	type JsonValue,
	parseCustodyPath,
	parseDatasetSchema,
	type SelectionRequest,
	selectMigrationPattern,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";
const LATER = "2026-11-17T00:00:00.000Z";

/** What a call answered, or that it refused and why. */
function attempt(run: () => JsonValue): JsonValue {
	try {
		return run();
	} catch (cause) {
		return `refused: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}

function pathWith(retainUntil: string): JsonObject {
	return {
		points: [
			{ id: "s", role: "source", region: "eu-west-1", protections: [] },
			{ id: "t", role: "target", region: "eu-west-1", protections: [] },
			{
				id: "runner",
				role: "relay",
				region: "eu-west-1",
				protections: [],
				retainUntil,
			},
		],
	};
}

function custody(retainUntil: string, now = NOW): JsonValue {
	return attempt(() =>
		evaluateCustodyPath({
			path: parseCustodyPath(pathWith(retainUntil)),
			policy: { classification: "public" },
			now,
		}).findings.map((finding) => finding.code),
	);
}

const SCHEMA = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [{ name: "id", type: "string", nullable: false }],
});

const VERDICT = evaluateCustodyPath({
	path: parseCustodyPath({
		points: CUSTODY_ROLES.map((role) => ({
			id: role,
			role,
			region: "eu-west-1",
			protections: [],
			...(role === "source" || role === "target" || role === "event-log"
				? undefined
				: { retainUntil: LATER }),
		})),
	}),
	policy: { classification: "public" },
	now: NOW,
});

function selection(checkedAt: string, now = NOW): JsonValue {
	const request: SelectionRequest = {
		authority: "authoritative",
		change: "engine",
		source: createReferenceEngine({ engine: "alpha" }).declaration,
		target: createReferenceEngine({ engine: "beta" }).declaration,
		schema: SCHEMA,
		constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "none" },
		estimates: { flipMs: 1_000, copyMs: 600_000 },
		verdict: VERDICT,
		evidence: [
			{ engine: "alpha", outcome: "pass", checkedAt },
			{ engine: "beta", outcome: "pass", checkedAt: NOW },
		],
		now,
		// Six hours: shorter than the gap between UTC and either other zone.
		evidenceMaxAgeMs: 6 * 60 * 60 * 1000,
	};
	return attempt(() => {
		const decision = selectMigrationPattern(request);
		return {
			selected: decision.selected?.pattern ?? null,
			reasons:
				decision.candidates
					.find(
						(candidate) =>
							candidate.pattern === "snapshot-and-tail" &&
							candidate.realization === "hub",
					)
					?.reasons.map((reason) => reason.code) ?? [],
		};
	});
}

// No offset: local time to `Date.parse`. In UTC these lie five hours after
// NOW and five hours before it; in Tokyo both lie before it, in Los Angeles
// both after.
const AFTER_IN_UTC = "2026-11-10T05:00:00";
const BEFORE_IN_UTC = "2026-11-09T19:00:00";

const report: JsonObject = {
	zone: process.env.TZ ?? null,
	// Local midnight on a fixed civil date: proof the zone took effect.
	localMidnight: new Date(2026, 10, 10).getTime(),
	answers: {
		custody: {
			noOffsetAfter: custody(AFTER_IN_UTC),
			noOffsetBefore: custody(BEFORE_IN_UTC),
			nowWithoutOffset: custody(LATER, "2026-11-10T00:00:00"),
			utc: custody("2026-11-10T05:00:00Z"),
			tokyo: custody("2026-11-10T14:00:00+09:00"),
			losAngeles: custody("2026-11-09T21:00:00-08:00"),
			expired: custody("2026-11-10T08:59:59+09:00"),
		},
		selector: {
			noOffsetAfter: selection(AFTER_IN_UTC),
			noOffsetBefore: selection(BEFORE_IN_UTC),
			nowWithoutOffset: selection(NOW, "2026-11-10T00:00:00"),
			fresh: selection("2026-11-10T04:00:00+09:00"),
			stale: selection("2026-11-09T09:59:59-08:00"),
			postdated: selection("2026-11-10T09:00:01+09:00"),
		},
	},
};

process.stdout.write(JSON.stringify(report));
