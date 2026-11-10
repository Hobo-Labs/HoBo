// Pattern selection: deterministic, gated, lexicographic, and never silently
// downgraded. Every assertion here is about the decision record — no data moves.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type ConformanceEvidence,
	createReferenceEngine,
	type DatasetSchema,
	type EngineDeclaration,
	engineDeclarationToJson,
	evaluateCustodyPath,
	MIGRATION_PATTERNS,
	parseCustodyPath,
	parseDatasetSchema,
	parseEngineDeclaration,
	patternCatalogDigest,
	type SelectionRequest,
	selectMigrationPattern,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

const SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "placed_at", type: "timestamp", nullable: false },
	],
});

const OK = evaluateCustodyPath({
	path: parseCustodyPath({
		points: [
			{ id: "s", role: "source", region: "eu-west-1", protections: [] },
			{ id: "t", role: "target", region: "eu-west-1", protections: [] },
		],
	}),
	policy: { classification: "public" },
	now: NOW,
});

const DENIED = evaluateCustodyPath({
	path: parseCustodyPath({
		points: [
			{ id: "s", role: "source", region: "eu-west-1", protections: [] },
			{ id: "t", role: "target", region: "us-east-1", protections: [] },
		],
	}),
	policy: {
		classification: "pii",
		residency: { classifications: [], allowedJurisdictions: ["eu"] },
	},
	now: NOW,
});

function engine(
	name: string,
	omit: Parameters<typeof createReferenceEngine>[0] = {},
): EngineDeclaration {
	return createReferenceEngine({ engine: name, ...omit }).declaration;
}

function fresh(...engines: string[]): ConformanceEvidence[] {
	return engines.map((name) => ({
		engine: name,
		outcome: "pass",
		checkedAt: NOW,
	}));
}

function request(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
	return {
		authority: "authoritative",
		change: "engine",
		source: engine("alpha"),
		target: engine("beta"),
		schema: SCHEMA,
		constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "none" },
		estimates: { flipMs: 1_000, copyMs: 600_000 },
		verdict: OK,
		evidence: fresh("alpha", "beta"),
		now: NOW,
		evidenceMaxAgeMs: 30 * DAY,
		...overrides,
	};
}

describe("selectMigrationPattern", () => {
	test("an online cross-engine move selects snapshot-and-tail with a lossless soak", () => {
		const decision = selectMigrationPattern(request());
		assert.equal(decision.selected?.pattern, "snapshot-and-tail");
		assert.equal(decision.selected?.realization, "hub");
		assert.equal(decision.selected?.rollbackInSoak, "lossless");
		assert.equal(decision.selected?.reverseTail, true);
		assert.equal(decision.catalogDigest, patternCatalogDigest());
	});

	test("every pattern in the catalog is a candidate, with a reason when rejected", () => {
		const decision = selectMigrationPattern(request());
		assert.deepEqual(
			[...new Set(decision.candidates.map((candidate) => candidate.pattern))],
			[...MIGRATION_PATTERNS],
		);
		for (const candidate of decision.candidates) {
			assert.equal(candidate.eligible, candidate.reasons.length === 0);
		}
		const offline = decision.candidates.find(
			(candidate) => candidate.pattern === "offline-copy",
		);
		assert.deepEqual(
			offline?.reasons.map((reason) => reason.code),
			["FREEZE_EXCEEDS_BUDGET"],
		);
	});

	test("identical inputs produce an identical digest; a changed input changes it", () => {
		const a = selectMigrationPattern(request());
		const b = selectMigrationPattern(request());
		assert.equal(a.digest, b.digest);
		const c = selectMigrationPattern(
			request({
				constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "lossless" },
			}),
		);
		assert.notEqual(a.digest, c.digest);
	});

	test("no silent downgrade: a zero freeze budget rejects every authoritative move, with reasons", () => {
		const decision = selectMigrationPattern(
			request({
				constraints: { maxWriteFreezeMs: 0, requiredRollback: "none" },
			}),
		);
		assert.equal(decision.selected, undefined);
		const online = decision.candidates.find(
			(candidate) => candidate.pattern === "snapshot-and-tail",
		);
		assert.deepEqual(
			online?.reasons.map((reason) => reason.code),
			["FREEZE_EXCEEDS_BUDGET"],
		);
		assert.ok(decision.candidates.every((candidate) => !candidate.eligible));
	});

	test("projected data moves by replay even with a zero freeze budget and across paradigms", () => {
		const decision = selectMigrationPattern(
			request({
				authority: "projected",
				change: "paradigm",
				source: undefined,
				constraints: { maxWriteFreezeMs: 0, requiredRollback: "lossless" },
				evidence: fresh("beta"),
			}),
		);
		assert.equal(decision.selected?.pattern, "rebuild-and-swap");
		assert.equal(decision.selected?.writeFreeze, "none");
		assert.equal(decision.selected?.rollbackInSoak, "lossless");
	});

	test("an authoritative cross-paradigm move is log-pivot, and it cannot promise a rollback", () => {
		const lenient = selectMigrationPattern(request({ change: "paradigm" }));
		assert.equal(lenient.selected?.pattern, "log-pivot");
		assert.equal(lenient.selected?.rollbackInSoak, "none");
		const strict = selectMigrationPattern(
			request({
				change: "paradigm",
				constraints: {
					maxWriteFreezeMs: 5_000,
					requiredRollback: "to-snapshot",
				},
			}),
		);
		assert.equal(strict.selected, undefined);
		assert.ok(
			strict.candidates
				.find((candidate) => candidate.pattern === "log-pivot")
				?.reasons.some((reason) => reason.code === "ROLLBACK_INSUFFICIENT"),
		);
	});

	test("a source without capture cannot tail; the selector names the missing port", () => {
		const decision = selectMigrationPattern(
			request({ source: engine("alpha", { omit: ["capture"] }) }),
		);
		const online = decision.candidates.find(
			(candidate) => candidate.pattern === "snapshot-and-tail",
		);
		assert.ok(
			online?.reasons.some(
				(reason) =>
					reason.code === "PORT_MISSING" && reason.detail.includes("capture"),
			),
		);
		// With a budget that covers the copy, offline-copy is what remains.
		const patient = selectMigrationPattern(
			request({
				source: engine("alpha", { omit: ["capture"] }),
				constraints: { maxWriteFreezeMs: 3_600_000, requiredRollback: "none" },
			}),
		);
		assert.equal(patient.selected?.pattern, "offline-copy");
	});

	test("a target without capture means no reverse tail, so a lossless soak is refused", () => {
		const decision = selectMigrationPattern(
			request({
				target: engine("beta", { omit: ["capture"] }),
				constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "lossless" },
			}),
		);
		assert.equal(decision.selected, undefined);
		const online = decision.candidates.find(
			(candidate) => candidate.pattern === "snapshot-and-tail",
		);
		assert.equal(online?.rollbackInSoak, "to-snapshot");
		assert.equal(online?.reverseTail, false);
	});

	test("stale, failed, and missing conformance evidence each fail closed", () => {
		const stale = selectMigrationPattern(
			request({
				evidence: [
					{
						engine: "alpha",
						outcome: "pass",
						checkedAt: "2026-01-01T00:00:00.000Z",
					},
					{ engine: "beta", outcome: "pass", checkedAt: NOW },
				],
			}),
		);
		const unknown = selectMigrationPattern(
			request({
				evidence: [{ engine: "alpha", outcome: "unknown", checkedAt: NOW }],
			}),
		);
		const codes = (decision: typeof stale) =>
			decision.candidates
				.find((candidate) => candidate.pattern === "snapshot-and-tail")
				?.reasons.map((reason) => reason.code);
		assert.deepEqual(codes(stale), ["EVIDENCE_STALE"]);
		assert.deepEqual(codes(unknown), ["EVIDENCE_FAILED", "EVIDENCE_MISSING"]);
		assert.equal(stale.selected, undefined);
		assert.equal(unknown.selected, undefined);
	});

	test("a negative policy verdict rejects every candidate that is otherwise legal", () => {
		const decision = selectMigrationPattern(request({ verdict: DENIED }));
		assert.equal(decision.selected, undefined);
		const legal = decision.candidates.filter(
			(candidate) =>
				!candidate.reasons.some(
					(reason) => reason.code === "PATTERN_ILLEGAL_FOR_CELL",
				),
		);
		assert.ok(legal.length > 0);
		assert.ok(
			legal.every((candidate) =>
				candidate.reasons.some((reason) => reason.code === "POLICY_DENIED"),
			),
		);
	});

	test("a lossy type mapping blocks the move until it is explicitly waived", () => {
		const lossyTarget = parseEngineDeclaration({
			...engineDeclarationToJson(engine("beta")),
			typeMapping: {
				engine: "beta",
				edges: [
					{
						canonical: "string",
						native: "text",
						write: "exact",
						read: "exact",
						note: "",
					},
					{
						canonical: "timestamp",
						native: "datetime(3)",
						write: "lossy",
						read: "exact",
						note: "sub-millisecond digits are truncated",
					},
				],
			},
		});
		const blocked = selectMigrationPattern(request({ target: lossyTarget }));
		assert.equal(blocked.selected, undefined);
		assert.deepEqual(
			blocked.mappingFindings.map((finding) => finding.code),
			["MAPPING_LOSSY"],
		);
		const waived = selectMigrationPattern(
			request({
				target: lossyTarget,
				waivers: ["MAPPING_LOSSY:orders.placed_at"],
			}),
		);
		assert.equal(waived.selected?.pattern, "snapshot-and-tail");
		assert.notEqual(blocked.digest, waived.digest);
	});

	test("a cross-engine move without a schema is unverified, not assumed exact", () => {
		const decision = selectMigrationPattern(request({ schema: undefined }));
		assert.equal(decision.selected, undefined);
		assert.ok(
			decision.candidates
				.find((candidate) => candidate.pattern === "snapshot-and-tail")
				?.reasons.some((reason) => reason.code === "MAPPING_UNVERIFIED"),
		);
	});

	test("a same-engine move prefers the engine's native profile over the hub", () => {
		const withNative = (name: string) =>
			parseEngineDeclaration({
				...engineDeclarationToJson(engine(name)),
				engine: "alpha",
				nativeProfiles: [
					{
						profile: "migration.alpha.replicate/v1",
						pattern: "snapshot-and-tail",
					},
				],
			});
		const decision = selectMigrationPattern(
			request({
				change: "placement",
				source: withNative("alpha"),
				target: withNative("alpha"),
				evidence: fresh("alpha"),
				// Require nothing the hub alone could offer, so realization decides.
				constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "none" },
			}),
		);
		const natives = decision.candidates.filter(
			(candidate) => candidate.realization === "native",
		);
		assert.equal(natives.length, 1);
		assert.equal(natives[0]?.profile, "migration.alpha.replicate/v1");
		// The hub still wins here because it brings a reverse tail: rollback
		// strength orders before realization.
		assert.equal(decision.selected?.realization, "hub");
		const noReverse = selectMigrationPattern(
			request({
				change: "placement",
				source: withNative("alpha"),
				target: parseEngineDeclaration({
					...engineDeclarationToJson(withNative("alpha")),
					ports: [...engine("alpha", { omit: ["capture"] }).ports],
					captureOrdering: "none",
				}),
				evidence: fresh("alpha"),
			}),
		);
		assert.equal(noReverse.selected?.realization, "native");
	});

	test("an unestimated freeze is never treated as zero", () => {
		const decision = selectMigrationPattern(request({ estimates: {} }));
		assert.equal(decision.selected, undefined);
		assert.ok(
			decision.candidates
				.find((candidate) => candidate.pattern === "snapshot-and-tail")
				?.reasons.some((reason) => reason.code === "FREEZE_UNESTIMATED"),
		);
	});

	test("the journal moves by stream-handoff", () => {
		const decision = selectMigrationPattern(
			request({
				authority: "journal",
				change: "placement",
				source: undefined,
				target: undefined,
				evidence: [],
			}),
		);
		assert.equal(decision.selected?.pattern, "stream-handoff");
	});
});
