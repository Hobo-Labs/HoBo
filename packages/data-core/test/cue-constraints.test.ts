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
	createReferenceEngine,
	engineDeclarationToJson,
	evaluateCustodyPath,
	type JsonObject,
	parseCustodyPath,
	policyVerdictToJson,
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
