import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { parseAiBddRunReport } from "../src/acceptance.js";
import { parseJsonText } from "../src/json.js";
import { parseStageGateRecord } from "../src/parse.js";
import {
	fixtureBytes,
	nodeAt,
	type ReportDoc,
} from "./helpers/ai-bdd-report.js";
import { cueBinary } from "./helpers/cue-binary.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DATA_MODELS = join(HERE, "..", "data-models");
const RECORDS = join(HERE, "fixtures", "records");
const SCHEMAS = ["stage_gate_record.cue", "acceptance_evidence.cue"];
const DEFINITIONS = ["StageGateRecord", "AcceptanceEvidence"];

const CUE = cueBinary(process.env, REPO_ROOT);

const scratch = mkdtempSync(join(tmpdir(), "hobo-record-cue-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface Vet {
	readonly accepted: boolean;
	readonly output: string;
}

function vet(definition: string, dataFile: string): Vet {
	const result = spawnSync(
		CUE,
		["vet", "-c", "-d", `#${definition}`, ...SCHEMAS, dataFile],
		{ cwd: DATA_MODELS, encoding: "utf8" },
	);
	if (result.error !== undefined) throw result.error;
	return {
		accepted: result.status === 0,
		output: `${result.stdout}${result.stderr}`,
	};
}

function fixturesOf(definition: string, kind: "valid" | "invalid"): string[] {
	return readdirSync(join(RECORDS, definition, kind))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => join(definition, kind, name));
}

function docOf(fixture: string): ReportDoc {
	const text = readFileSync(join(RECORDS, fixture), "utf8");
	return JSON.parse(text) as ReportDoc;
}

function without(fixture: string, parent: string, key: string): string {
	const doc = docOf(fixture);
	delete nodeAt(doc, parent)[key];
	const file = join(
		scratch,
		`${parent}.${key}.${fixture.replaceAll("/", "_")}`,
	);
	writeFileSync(file, JSON.stringify(doc));
	return file;
}

function tsAccepts(file: string): boolean {
	try {
		parseStageGateRecord(parseJsonText(readFileSync(file, "utf8")) ?? null);
		return true;
	} catch {
		return false;
	}
}

describe("the record's CUE against its fixtures", () => {
	for (const definition of DEFINITIONS) {
		it.each(fixturesOf(definition, "valid"))("cue vet -c accepts %s", (f) => {
			const result = vet(definition, join(RECORDS, f));
			expect(result.output).toBe("");
			expect(result.accepted).toBe(true);
		});
		it.each(fixturesOf(definition, "invalid"))("cue vet -c refuses %s", (f) => {
			expect(vet(definition, join(RECORDS, f)).accepted).toBe(false);
		});
	}

	it.each(
		fixturesOf("StageGateRecord", "valid"),
	)("parseStageGateRecord accepts %s too", (f) => {
		expect(tsAccepts(join(RECORDS, f))).toBe(true);
	});
	it.each(
		fixturesOf("StageGateRecord", "invalid"),
	)("parseStageGateRecord refuses %s too", (f) => {
		expect(tsAccepts(join(RECORDS, f))).toBe(false);
	});

	it("the evidence fixture is what parseAiBddRunReport reads from the passed report", () => {
		const evidence = parseAiBddRunReport(fixtureBytes("report.v1.passed.json"));
		const snake = Object.fromEntries(
			Object.entries(evidence).map(([key, value]) => [
				key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`),
				value,
			]),
		);
		expect(snake).toEqual(docOf("AcceptanceEvidence/valid/passed.json"));
	});
});

const RELEASE = "StageGateRecord/valid/release-passed.json";
type FieldAt = readonly [parent: string, key: string];

function fieldsAt(parent: string, keys: readonly string[]): FieldAt[] {
	return keys.map((key): FieldAt => [parent, key]);
}

const REQUIRED_IN_RELEASE: readonly FieldAt[] = [
	...fieldsAt("", [
		"gate_id",
		"status",
		"repo_commit",
		"started_at",
		"finished_at",
		"checks",
		"artifact",
		"signature",
	]),
	...fieldsAt("checks.0", ["check_id", "command", "exit_code", "status"]),
	...fieldsAt("checks.1", ["check_id", "status", "evidence"]),
	...fieldsAt("checks.1.evidence", [
		"report_digest",
		"run_id",
		"model_calls",
		"frozen",
		"no_agent",
		"report_exit_code",
		"scenarios_total",
		"scenarios_passed",
		"scenarios_healed",
	]),
	...fieldsAt("checks.2", ["check_id", "status", "evidence"]),
	...fieldsAt("checks.2.evidence", ["report_digest", "run_id"]),
	...fieldsAt("artifact", ["digest_sha256", "byte_length", "media_type"]),
	...fieldsAt("signature", ["verified", "signer_identity", "provenance_tier"]),
];

describe("every field a passed release record needs is required", () => {
	it.each(
		REQUIRED_IN_RELEASE,
	)("a passed release record without %s.%s is refused by the CUE and the parser", (parent, key) => {
		const file = without(RELEASE, parent, key);
		const result = vet("StageGateRecord", file);
		expect(result.accepted).toBe(false);
		expect(tsAccepts(file)).toBe(false);
	});

	const EVIDENCE = "AcceptanceEvidence/valid/passed.json";
	it.each(
		Object.keys(docOf(EVIDENCE)),
	)("acceptance evidence without %s is refused", (key) => {
		expect(vet("AcceptanceEvidence", without(EVIDENCE, "", key)).accepted).toBe(
			false,
		);
	});
});
