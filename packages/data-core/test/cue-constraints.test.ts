// The CUE constraints, exercised against real records. A schema that parses
// has only been shown to be well-formed; these cases show it accepts what the
// parsers accept and refuses what they refuse.
//
// Needs the pinned `cue` binary (on PATH, or the repo's .tools cache). Without
// it the cases are skipped rather than passed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, test } from "vitest";
import {
	CUSTODY_ROLES,
	createMemoryMigrationJournal,
	createReferenceEngine,
	createReferenceNativeLink,
	encodeRecordKey,
	engineDeclarationToJson,
	evaluateCustodyPath,
	isJsonObject,
	type JsonObject,
	MIGRATION_EVENTS,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	parseJsonText,
	policyVerdictToJson,
	REFERENCE_NATIVE_PROFILE,
	referenceEngineHarness,
	runEngineConformance,
	runSnapshotAndTail,
	scopeOf,
	upsertMutation,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = path.join(here, "..", "data-models", "data_core.cue");
const cached = path.join(
	here,
	"..",
	"..",
	"..",
	".tools",
	"cue",
	"v0.14.0",
	"cue",
);

function findCue(): string | undefined {
	if (existsSync(cached)) return cached;
	const probe = spawnSync("cue", ["version"], { encoding: "utf8" });
	return probe.status === 0 && probe.stdout.includes("0.14.0")
		? "cue"
		: undefined;
}

const cue = findCue();
const dir = mkdtempSync(path.join(tmpdir(), "hobo-data-core-cue-"));
let counter = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function vet(definition: string, record: JsonObject) {
	counter += 1;
	const file = path.join(dir, `record-${counter}.json`);
	writeFileSync(file, JSON.stringify(record));
	const result = spawnSync(
		cue ?? "cue",
		["vet", "-d", definition, schemaFile, file],
		{
			encoding: "utf8",
		},
	);
	return {
		ok: result.status === 0,
		output: `${result.stdout}${result.stderr}`,
	};
}

function accepts(definition: string, record: JsonObject): void {
	const result = vet(definition, record);
	assert.ok(
		result.ok,
		`${definition} should accept the record:\n${result.output}`,
	);
}

function rejects(definition: string, record: JsonObject): void {
	assert.ok(
		!vet(definition, record).ok,
		`${definition} should refuse the record`,
	);
}

const NOW = "2026-11-10T00:00:00.000Z";

/** A record as it would cross a wire: through JSON, and nothing else. */
function plain<T>(value: T): JsonObject {
	const parsed = parseJsonText(JSON.stringify(value));
	assert.ok(isJsonObject(parsed));
	return parsed;
}

describe.skipIf(cue === undefined)(
	"CUE constraints against real records",
	() => {
		test("an engine declaration produced by the parser is accepted", () => {
			accepts(
				"#EngineDeclaration",
				engineDeclarationToJson(createReferenceEngine().declaration),
			);
			accepts(
				"#EngineDeclaration",
				engineDeclarationToJson(
					createReferenceEngine({ omit: ["capture", "fence"] }).declaration,
				),
			);
		});

		test("a declaration whose capabilities disagree with its ports is refused", () => {
			const declaration = engineDeclarationToJson(
				createReferenceEngine({ omit: ["capture"] }).declaration,
			);
			rejects("#EngineDeclaration", {
				...declaration,
				captureOrdering: "global",
			});
			rejects("#EngineDeclaration", {
				...declaration,
				ports: ["records", "apply"],
			});
			rejects("#EngineDeclaration", {
				...declaration,
				engine: "Not A Valid Id",
			});
		});

		test("a policy verdict produced by the evaluator is accepted; ok with findings is refused", () => {
			const path = parseCustodyPath({
				points: [
					{ id: "s", role: "source", region: "eu-west-1", protections: [] },
					{ id: "t", role: "target", region: "moon-base-1", protections: [] },
				],
			});
			const verdict = policyVerdictToJson(
				evaluateCustodyPath({
					path,
					policy: {
						classification: "pii",
						residency: { classifications: [], allowedJurisdictions: ["eu"] },
					},
					now: NOW,
				}),
			);
			accepts("#PolicyVerdict", verdict);
			rejects("#PolicyVerdict", { ...verdict, ok: true });
		});

		test("an upsert must carry a record and a delete must not", () => {
			accepts("#RecordMutation", { tenant: "", key: '["a"]', op: "delete" });
			accepts("#RecordMutation", {
				tenant: "",
				key: '["a"]',
				op: "upsert",
				record: { id: "a" },
			});
			rejects("#RecordMutation", { tenant: "", key: '["a"]', op: "upsert" });
			rejects("#RecordMutation", {
				tenant: "",
				key: '["a"]',
				op: "delete",
				record: { id: "a" },
			});
		});

		test("a migration may be recorded as held only in a safe-hold phase", () => {
			const held = { migrationId: "m", reason: "policy", heldAt: NOW };
			accepts("#MigrationHeldEventData", { ...held, phase: "converge" });
			accepts("#MigrationHeldEventData", { ...held, phase: "soak" });
			rejects("#MigrationHeldEventData", { ...held, phase: "fence-and-flip" });
		});

		test("the write-ahead and ownership facts: an intent names an in-place phase, a raised fence carries a digest and never a token, and only a rollback to a stale source may leave the target unfenced", () => {
			const intent = {
				migrationId: "m",
				phase: "contract",
				statements: 1,
				intendedAt: NOW,
			};
			accepts("#MigrationPhaseIntendedEventData", intent);
			accepts("#MigrationPhaseIntendedEventData", { ...intent, retry: true });
			rejects("#MigrationPhaseIntendedEventData", { ...intent, phase: "soak" });
			const raised = {
				migrationId: "m",
				side: "target",
				phase: "soak",
				fenceTokenDigest: `sha256:${"a".repeat(64)}`,
				raisedAt: NOW,
			};
			accepts("#MigrationFenceRaisedEventData", raised);
			rejects("#MigrationFenceRaisedEventData", {
				...raised,
				fenceToken: "fence:orders::1",
			});
			rejects("#MigrationFenceRaisedEventData", {
				...raised,
				fenceTokenDigest: "fence:orders::1",
			});
			const decided = { migrationId: "m", decidedAt: NOW };
			accepts("#MigrationRollbackDecidedEventData", {
				...decided,
				lossless: false,
				targetFenced: false,
				erasuresFrom: NOW,
				policyFindings: ["CUSTODY_RESIDENCY_CONFLICT"],
			});
			accepts("#MigrationRollbackDecidedEventData", {
				...decided,
				lossless: true,
				targetFenced: true,
			});
			rejects("#MigrationRollbackDecidedEventData", {
				...decided,
				lossless: true,
				targetFenced: false,
			});
			// A checkpoint names its fence by digest.
			const applied = {
				migrationId: "m",
				phase: "fence-and-flip",
				appliedAt: NOW,
			};
			accepts("#MigrationPhaseAppliedEventData", {
				...applied,
				checkpoint: { fenceTokenDigest: `sha256:${"a".repeat(64)}` },
			});
			rejects("#MigrationPhaseAppliedEventData", {
				...applied,
				checkpoint: { fenceToken: "fence:orders::1" },
			});
			// What a router compares-and-sets on: an identity, never the token.
			const move = { migrationId: "m", head: 14, direction: "to-target" };
			accepts("#AuthorityMoveRef", move);
			rejects("#AuthorityMoveRef", { ...move, head: 0 });
			rejects("#AuthorityMoveRef", { ...move, fenceToken: "fence:orders::1" });
			// The destination log of a stream handoff is a role of its own.
			accepts("#CustodyPoint", {
				id: "log-us",
				role: "target-event-log",
				region: "us-east-1",
				protections: [],
			});
		});

		test("an eligible candidate has no reasons, and a rejected one has at least one", () => {
			const candidate = {
				pattern: "offline-copy",
				realization: "hub",
				writeFreeze: "window",
				rollbackInSoak: "to-snapshot",
				reverseTail: false,
			};
			accepts("#MigrationCandidate", {
				...candidate,
				eligible: true,
				reasons: [],
			});
			rejects("#MigrationCandidate", {
				...candidate,
				eligible: true,
				reasons: [{ code: "PORT_MISSING", detail: "source lacks capture" }],
			});
			rejects("#MigrationCandidate", {
				...candidate,
				eligible: false,
				reasons: [],
			});
		});

		test("the facts of a real native run are accepted; a token or a connection string in them is refused", async () => {
			const schema = parseDatasetSchema({
				name: "orders",
				keyFields: ["id"],
				fields: [{ name: "id", type: "string", nullable: false }],
			});
			const link = createReferenceNativeLink();
			const source = createReferenceEngine({ native: link });
			const target = createReferenceEngine({ native: link });
			await source.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "o-1" });
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			const result = await runSnapshotAndTail({
				runtime: {
					migrationId: "m1",
					journal: createMemoryMigrationJournal(),
					clock: () => NOW,
					policy: () =>
						evaluateCustodyPath({
							// One point per role: the run holds on a path that
							// leaves out a copy it creates.
							path: parseCustodyPath({
								points: CUSTODY_ROLES.map((role) => ({
									id: role,
									role,
									region: "eu-west-1",
									protections: [],
									...(role === "source" ||
									role === "target" ||
									role === "event-log"
										? undefined
										: { retainUntil: "2026-11-17T00:00:00.000Z" }),
								})),
							}),
							policy: { classification: "public" },
							now: NOW,
						}),
				},
				source,
				target,
				schema,
				scope: scopeOf("orders"),
				flipAuthority: () => {},
				realization: "native",
				profile: REFERENCE_NATIVE_PROFILE,
			});
			assert.equal(result.status, "completed");
			const dataOf = (type: string): JsonObject => {
				const fact = result.facts.find((entry) => entry.type === type);
				assert.ok(fact, type);
				return fact.data;
			};
			const planned = dataOf(MIGRATION_EVENTS.Planned);
			accepts("#MigrationPlannedEventData", planned);
			// A native plan names its profile; a hub plan has none to name.
			const { profile: _profile, ...unnamed } = planned;
			rejects("#MigrationPlannedEventData", unnamed);
			rejects("#MigrationPlannedEventData", { ...planned, realization: "hub" });
			accepts("#MigrationPlannedEventData", { ...unnamed, realization: "hub" });

			const cutOver = dataOf(MIGRATION_EVENTS.CutOver);
			accepts("#MigrationCutOverEventData", cutOver);
			rejects("#MigrationCutOverEventData", {
				...cutOver,
				fenceToken: "fence:orders::1",
			});

			const prepare = result.state.checkpoints.prepare;
			assert.ok(prepare);
			accepts("#NativeTransferCheckpoint", prepare);
			rejects("#NativeTransferCheckpoint", {
				...prepare,
				ticket: { connection: "postgres://user:pw@host/db" },
			});
			accepts("#NativeTransferRef", {
				profile: REFERENCE_NATIVE_PROFILE,
				transfer: String(prepare.transfer),
				dataset: "orders",
				tenant: "",
			});
		});

		test("a conformance report from the kit is accepted; a filtered run that claims to pass, or a status nobody defined, is refused", async () => {
			const whole = plain(
				await runEngineConformance({
					engine: referenceEngineHarness(),
					now: NOW,
				}),
			);
			accepts("#EngineConformanceReport", whole);
			const only = ["declaration.matches-binding"];
			const filtered = plain(
				await runEngineConformance({
					engine: referenceEngineHarness(),
					now: NOW,
					only,
				}),
			);
			assert.equal(filtered.outcome, "unknown");
			accepts("#EngineConformanceReport", filtered);
			// One case run on its own cannot be presented as conformance.
			rejects("#EngineConformanceReport", { ...filtered, outcome: "pass" });
			accepts("#EngineConformanceReport", {
				...whole,
				results: [
					{
						caseId: "capture.acknowledged-positions-are-final",
						status: "declared-limit",
						detail: "ENGINE_ACKNOWLEDGE_RELEASES_NOTHING: refused",
					},
				],
			});
			rejects("#EngineConformanceReport", {
				...whole,
				results: [{ caseId: "a", status: "waived", detail: "" }],
			});
		});

		test("a declaration may state a record bound, and it has to be a positive integer", () => {
			const declaration = engineDeclarationToJson(
				createReferenceEngine().declaration,
			);
			accepts("#EngineDeclaration", {
				...declaration,
				maxRecordBytes: 16777216,
			});
			rejects("#EngineDeclaration", { ...declaration, maxRecordBytes: 0 });
			rejects("#EngineDeclaration", { ...declaration, maxRecordBytes: 1.5 });
			rejects("#EngineDeclaration", { ...declaration, maxRecordBytes: "big" });
		});

		test("a dataset schema needs a key and portable names", () => {
			const schema = {
				contract: "hobo.dataset-schema/v1",
				name: "orders",
				version: 1,
				keyFields: ["id"],
				fields: [{ name: "id", type: "string", nullable: false }],
				open: false,
			};
			accepts("#DatasetSchema", schema);
			rejects("#DatasetSchema", { ...schema, keyFields: [] });
			rejects("#DatasetSchema", { ...schema, name: "Orders-Table" });
			rejects("#DatasetSchema", {
				...schema,
				fields: [{ name: "id", type: "varchar", nullable: false }],
			});
		});
	},
);
