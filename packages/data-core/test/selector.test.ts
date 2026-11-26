// Pattern selection: deterministic, gated, lexicographic, and never silently
// downgraded. Every assertion here is about the decision record — no data moves.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type ConformanceEvidence,
	CUSTODY_ROLES,
	type CustodyRole,
	createReferenceEngine,
	type DatasetSchema,
	type EngineDeclaration,
	engineDeclarationToJson,
	evaluateCustodyPath,
	type JsonObject,
	MIGRATION_PATTERNS,
	type MigrationCandidate,
	type MigrationDecision,
	type MigrationPatternId,
	parseCustodyPath,
	parseDatasetSchema,
	parseEngineDeclaration,
	patternCatalogDigest,
	type SelectionRequest,
	type SpiPortName,
	selectMigrationPattern,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";
const LATER = "2026-11-17T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

const SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "placed_at", type: "timestamp", nullable: false },
	],
});

const PERMANENT: readonly CustodyRole[] = ["source", "target", "event-log"];

/** One custody point per role; a bounded copy gets a deadline. */
function points(
	roles: readonly CustodyRole[],
	regions: Partial<Record<CustodyRole, string>> = {},
): JsonObject[] {
	return roles.map((role) => ({
		id: role,
		role,
		region: regions[role] ?? "eu-west-1",
		protections: [],
		...(PERMANENT.includes(role) ? undefined : { retainUntil: LATER }),
	}));
}

/** A verdict over a path that names the given roles and nothing else. */
function verdictOver(roles: readonly CustodyRole[]) {
	return evaluateCustodyPath({
		path: parseCustodyPath({ points: points(roles) }),
		policy: { classification: "public" },
		now: NOW,
	});
}

// Every place any pattern puts data, so the custody gate is not what decides
// the cases that are about something else.
const OK = verdictOver(CUSTODY_ROLES);

const DENIED = evaluateCustodyPath({
	path: parseCustodyPath({
		points: points(CUSTODY_ROLES, { target: "us-east-1" }),
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

type Omissible = "source" | "target" | "schema";

/**
 * A request that selects `snapshot-and-tail`, with overrides. `without` names
 * members to leave out: under `exactOptionalPropertyTypes` an absent member
 * is not the same as one set to `undefined`, and the selector is given the
 * former.
 */
function request(
	overrides: Partial<SelectionRequest> = {},
	without: readonly Omissible[] = [],
): SelectionRequest {
	const { source, target, schema, ...rest } = {
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
	} satisfies SelectionRequest;
	return {
		...rest,
		...(without.includes("source") ? undefined : { source }),
		...(without.includes("target") ? undefined : { target }),
		...(without.includes("schema") ? undefined : { schema }),
	};
}

function candidate(
	decision: MigrationDecision,
	pattern: MigrationPatternId,
	realization: MigrationCandidate["realization"] = "hub",
): MigrationCandidate | undefined {
	return decision.candidates.find(
		(entry) => entry.pattern === pattern && entry.realization === realization,
	);
}

function codes(
	decision: MigrationDecision,
	pattern: MigrationPatternId = "snapshot-and-tail",
): string[] | undefined {
	return candidate(decision, pattern)?.reasons.map((reason) => reason.code);
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
			request(
				{
					authority: "projected",
					change: "paradigm",
					constraints: { maxWriteFreezeMs: 0, requiredRollback: "lossless" },
					evidence: fresh("beta"),
				},
				["source"],
			),
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
		const decision = selectMigrationPattern(request({}, ["schema"]));
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

	test("a native candidate still needs the ports the executor drives itself", () => {
		const withNative = (omit: readonly SpiPortName[]) =>
			parseEngineDeclaration({
				...engineDeclarationToJson(engine("alpha", { omit: [...omit] })),
				engine: "alpha",
				nativeProfiles: [
					{
						profile: "migration.alpha.replicate/v1",
						pattern: "snapshot-and-tail",
					},
				],
			});
		const native = (
			source: readonly SpiPortName[],
			target: readonly SpiPortName[],
		) =>
			selectMigrationPattern(
				request({
					change: "placement",
					source: withNative(source),
					target: withNative(target),
					evidence: fresh("alpha"),
				}),
			).candidates.find(
				(candidate) =>
					candidate.pattern === "snapshot-and-tail" &&
					candidate.realization === "native",
			);
		// The transport ports are the engine's business: not needed natively.
		const transportFree = native(["snapshot", "capture"], ["apply", "capture"]);
		assert.equal(transportFree?.eligible, true);
		assert.equal(transportFree?.reverseTail, false);
		assert.equal(transportFree?.rollbackInSoak, "to-snapshot");
		// The fence and the digest are not: whoever carries the records, the
		// cutover is still fenced and verified by the executor.
		const unfenced = native(["fence"], []);
		assert.equal(unfenced?.eligible, false);
		assert.deepEqual(
			unfenced?.reasons.map((reason) => `${reason.code}: ${reason.detail}`),
			["PORT_MISSING: source alpha lacks fence"],
		);
		const unverified = native([], ["verify"]);
		assert.deepEqual(
			unverified?.reasons.map((reason) => `${reason.code}: ${reason.detail}`),
			["PORT_MISSING: target alpha lacks verify"],
		);
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
			request({ authority: "journal", change: "placement", evidence: [] }, [
				"source",
				"target",
			]),
		);
		assert.equal(decision.selected?.pattern, "stream-handoff");
	});

	// ── gates that used to fail open on malformed input ──────────────────────

	test("evidence is judged by its most recent entry, and the worst at that instant — never by the first match", () => {
		const entry = (
			outcome: ConformanceEvidence["outcome"],
			checkedAt = NOW,
		): ConformanceEvidence => ({ engine: "alpha", outcome, checkedAt });
		const decide = (...alpha: ConformanceEvidence[]) =>
			selectMigrationPattern(
				request({ evidence: [...alpha, ...fresh("beta")] }),
			);
		// The same two runs at the same instant, in either order.
		for (const evidence of [
			[entry("pass"), entry("fail")],
			[entry("fail"), entry("pass")],
			[entry("pass"), entry("unknown")],
		]) {
			const decision = decide(...evidence);
			assert.equal(decision.selected, undefined);
			assert.deepEqual(codes(decision), ["EVIDENCE_FAILED"]);
		}
		const yesterday = "2026-11-09T00:00:00.000Z";
		// A later failure outvotes an earlier pass, wherever it sits in the list.
		assert.deepEqual(codes(decide(entry("fail"), entry("pass", yesterday))), [
			"EVIDENCE_FAILED",
		]);
		assert.deepEqual(codes(decide(entry("pass", yesterday), entry("fail"))), [
			"EVIDENCE_FAILED",
		]);
		// A later pass is the engine fixed and re-run.
		assert.equal(
			decide(entry("fail", yesterday), entry("pass")).selected?.pattern,
			"snapshot-and-tail",
		);
		assert.equal(
			decide(entry("pass"), entry("fail", yesterday)).selected?.pattern,
			"snapshot-and-tail",
		);
		// The most recent run decides freshness too: an old pass beside it
		// neither helps nor hurts.
		assert.deepEqual(
			codes(
				decide(
					entry("pass", "2026-01-01T00:00:00.000Z"),
					entry("pass", "2026-02-01T00:00:00.000Z"),
				),
			),
			["EVIDENCE_STALE"],
		);
	});

	test("evidence dated after now is refused, not counted as fresh", () => {
		const future = selectMigrationPattern(
			request({
				evidence: [
					{
						engine: "alpha",
						outcome: "pass",
						checkedAt: "2099-01-01T00:00:00Z",
					},
					{
						engine: "beta",
						outcome: "pass",
						checkedAt: "2099-01-01T00:00:00Z",
					},
				],
			}),
		);
		assert.equal(future.selected, undefined);
		assert.deepEqual(codes(future), [
			"EVIDENCE_POSTDATED",
			"EVIDENCE_POSTDATED",
		]);
		// One microsecond is after now; a real pass beside it does not rescue it.
		const beside = selectMigrationPattern(
			request({
				evidence: [
					...fresh("alpha", "beta"),
					{
						engine: "alpha",
						outcome: "pass",
						checkedAt: "2026-11-10T00:00:00.000001Z",
					},
				],
			}),
		);
		assert.equal(beside.selected, undefined);
		assert.deepEqual(codes(beside), ["EVIDENCE_POSTDATED"]);
	});

	test("evidence whose checkedAt is not a strict RFC 3339 instant cannot be shown fresh", () => {
		for (const checkedAt of [
			"2026-11-10T00:00:00", // no offset: local time to Date.parse
			"2026-11-09",
			"Mon, 09 Nov 2026 00:00:00 GMT",
			"2026-11-09T00:00:00+99:99",
			"",
		]) {
			const decision = selectMigrationPattern(
				request({
					evidence: [
						{ engine: "alpha", outcome: "pass", checkedAt },
						...fresh("beta"),
					],
				}),
			);
			assert.equal(decision.selected, undefined, checkedAt);
			assert.deepEqual(codes(decision), ["EVIDENCE_STALE"], checkedAt);
		}
	});

	test("an estimate that is not a finite number of zero or more fails the freeze gate, even against a zero budget", () => {
		for (const bad of [
			Number.NaN,
			-1,
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
		]) {
			for (const maxWriteFreezeMs of [0, 5_000]) {
				const decision = selectMigrationPattern(
					request({
						constraints: { maxWriteFreezeMs, requiredRollback: "none" },
						estimates: { flipMs: bad, copyMs: bad },
					}),
				);
				assert.equal(decision.selected, undefined, String(bad));
				assert.deepEqual(codes(decision), ["FREEZE_UNESTIMATED"], String(bad));
				assert.deepEqual(
					codes(decision, "offline-copy"),
					["FREEZE_UNESTIMATED"],
					String(bad),
				);
			}
		}
		// Zero is an estimate, and it fits a zero budget.
		assert.equal(
			selectMigrationPattern(
				request({
					constraints: { maxWriteFreezeMs: 0, requiredRollback: "none" },
					estimates: { flipMs: 0, copyMs: 600_000 },
				}),
			).selected?.pattern,
			"snapshot-and-tail",
		);
	});

	test("a budget or an evidence age that is not finite and zero or more is refused", () => {
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			assert.throws(
				() =>
					selectMigrationPattern(
						request({
							constraints: { maxWriteFreezeMs: bad, requiredRollback: "none" },
						}),
					),
				/maxWriteFreezeMs must be a finite number, zero or more/u,
			);
			assert.throws(
				() => selectMigrationPattern(request({ evidenceMaxAgeMs: bad })),
				/evidenceMaxAgeMs must be a finite number, zero or more/u,
			);
		}
	});

	test("now must be a strict RFC 3339 instant", () => {
		for (const now of ["2026-11-10T00:00:00", "2026-11-10", "today"]) {
			assert.throws(
				() => selectMigrationPattern(request({ now })),
				/now must be an RFC 3339 instant with an explicit offset/u,
			);
		}
		// One instant in another spelling is the same decision.
		assert.equal(
			selectMigrationPattern(request({ now: "2026-11-10T09:00:00+09:00" }))
				.digest,
			selectMigrationPattern(request()).digest,
		);
	});

	// ── the verdict must cover what the pattern creates ──────────────────────

	test("a verdict over only source and target selects nothing: every pattern creates a copy it did not judge", () => {
		const twoEnds = verdictOver(["source", "target"]);
		assert.equal(twoEnds.ok, true);
		const decision = selectMigrationPattern(request({ verdict: twoEnds }));
		assert.equal(decision.selected, undefined);
		assert.deepEqual(
			candidate(decision, "snapshot-and-tail")?.reasons.map(
				(reason) => `${reason.code}: ${reason.detail}`,
			),
			[
				"CUSTODY_INCOMPLETE: snapshot-and-tail (hub) creates relay, capture-log, retiring-source; the custody path behind the verdict names no such point",
			],
		);
		// Every authority and change: nothing is selectable on two ends alone.
		for (const [authority, change, without] of [
			["authoritative", "placement", []],
			["authoritative", "paradigm", []],
			["authoritative", "shape", []],
			["projected", "engine", ["source"]],
			["journal", "placement", ["source", "target"]],
		] as const) {
			const cell = selectMigrationPattern(
				request(
					{
						authority,
						change,
						verdict: twoEnds,
						constraints: {
							maxWriteFreezeMs: 3_600_000,
							requiredRollback: "none",
						},
					},
					without,
				),
			);
			assert.equal(cell.selected, undefined, `${authority}/${change}`);
			const legal = cell.candidates.filter(
				(entry) =>
					!entry.reasons.some(
						(reason) => reason.code === "PATTERN_ILLEGAL_FOR_CELL",
					),
			);
			assert.ok(legal.length > 0, `${authority}/${change}`);
			assert.ok(
				legal.every((entry) =>
					entry.reasons.some((reason) => reason.code === "CUSTODY_INCOMPLETE"),
				),
				`${authority}/${change}`,
			);
		}
	});

	test("one missing intermediate role rejects exactly the patterns that create it", () => {
		const without = (role: CustodyRole) =>
			selectMigrationPattern(
				request({
					verdict: verdictOver(CUSTODY_ROLES.filter((entry) => entry !== role)),
					constraints: {
						maxWriteFreezeMs: 3_600_000,
						requiredRollback: "none",
					},
				}),
			);
		// No capture log named: nothing that tails can be chosen. offline-copy
		// has a reverse tail here, so it retains the target's log too.
		const noLog = without("capture-log");
		assert.equal(noLog.selected, undefined);
		assert.deepEqual(codes(noLog), ["CUSTODY_INCOMPLETE"]);
		assert.deepEqual(codes(noLog, "log-pivot"), ["CUSTODY_INCOMPLETE"]);
		assert.deepEqual(codes(noLog, "offline-copy"), ["CUSTODY_INCOMPLETE"]);
		// No retiring source named: log-pivot keeps its source, so it survives.
		const noRetiring = without("retiring-source");
		assert.deepEqual(codes(noRetiring), ["CUSTODY_INCOMPLETE"]);
		assert.deepEqual(codes(noRetiring, "offline-copy"), ["CUSTODY_INCOMPLETE"]);
		assert.equal(noRetiring.selected?.pattern, "log-pivot");
		// No relay named: the hub carries every record through the runner.
		const noRelay = without("relay");
		assert.equal(noRelay.selected, undefined);
		// A staging artifact is never implied.
		assert.equal(
			without("staging-artifact").selected?.pattern,
			"snapshot-and-tail",
		);
	});

	test("the custody gate follows the realization and the reverse tail the candidate actually has", () => {
		const withNative = (name: string, omit: readonly SpiPortName[] = []) =>
			parseEngineDeclaration({
				...engineDeclarationToJson(engine(name, { omit: [...omit] })),
				engine: "alpha",
				nativeProfiles: [
					{
						profile: "migration.alpha.replicate/v1",
						pattern: "snapshot-and-tail",
					},
				],
			});
		// No relay on the path. The native transfer carries no record through
		// the runner, so it alone is covered.
		const noRelay = selectMigrationPattern(
			request({
				change: "placement",
				source: withNative("alpha"),
				target: withNative("alpha"),
				evidence: fresh("alpha"),
				verdict: verdictOver(CUSTODY_ROLES.filter((role) => role !== "relay")),
			}),
		);
		assert.equal(noRelay.selected?.realization, "native");
		assert.deepEqual(
			candidate(noRelay, "snapshot-and-tail", "hub")?.reasons.map(
				(reason) => reason.code,
			),
			["CUSTODY_INCOMPLETE"],
		);
		// offline-copy without a reverse tail retains no change log at all.
		const noReverse = selectMigrationPattern(
			request({
				target: engine("beta", { omit: ["capture"] }),
				constraints: { maxWriteFreezeMs: 3_600_000, requiredRollback: "none" },
				verdict: verdictOver(
					CUSTODY_ROLES.filter((role) => role !== "capture-log"),
				),
			}),
		);
		assert.equal(candidate(noReverse, "offline-copy")?.reverseTail, false);
		assert.equal(noReverse.selected?.pattern, "offline-copy");
		assert.deepEqual(codes(noReverse), ["CUSTODY_INCOMPLETE"]);
	});

	test("a verdict that names no roles at all — evidence from before the field existed — covers nothing", () => {
		const { roles: _roles, ...legacy } = OK;
		const decision = selectMigrationPattern(
			// SAFETY: a verdict deserialised from older evidence has no `roles`; the gate must not trust the static type.
			request({ verdict: legacy as SelectionRequest["verdict"] }),
		);
		assert.equal(decision.selected, undefined);
		assert.deepEqual(codes(decision), ["CUSTODY_INCOMPLETE"]);
	});
});
