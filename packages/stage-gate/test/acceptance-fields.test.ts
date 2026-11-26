/**
 * HoBo reads ai-bdd's report across a process boundary and imports no ai-bdd
 * code, so the only statement of the contract on this side is the schema file
 * copied into test/fixtures/ai-bdd/. These tests hold the parser to it: every
 * field RunReport v1 requires is read (its removal is refused) or deliberately
 * ignored (its removal changes nothing), and the ledger in
 * src/acceptance-fields.ts names exactly those fields.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	AcceptanceReportError,
	parseAiBddRunReport,
} from "../src/acceptance.js";
import { RUN_REPORT_FIELDS } from "../src/acceptance-fields.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "../src/json.js";
import { RUN_REPORT_KEYS } from "../src/report-keys.js";
import {
	bytesOf,
	FIXTURE_DIR,
	fixtureBytes,
	fixtureDoc,
	nodeAt,
	perturbAt,
	removeAt,
} from "./helpers/ai-bdd-report.js";

function issuesOf(bytes: Uint8Array): readonly string[] {
	try {
		parseAiBddRunReport(bytes);
	} catch (error) {
		if (error instanceof AcceptanceReportError) return error.issues;
		throw error;
	}
	return [];
}

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** sha256 of each copied file; README.md beside them records the same values and where they came from. */
const COPIED = {
	"report.v1.passed.json":
		"39b3124e109795fcb285de613fb0eee1bf60322a017c0d1b6c54639e7bdebbb1",
	"report.v1.failed.json":
		"b8924cf22dd6ad3b5a7c235b24943e69b698f5b2d865e5db6020da5959f7b76f",
	// ai-bdd pins this digest too (V1_SHA256 in packages/sdk/test/report/schema.test.ts, main at 7f9456a): v1 is frozen once released.
	"run-report.v1.schema.json":
		"7e907a6232b9b8de41e14154243d11612be07d8bba4e831085cf828f4ca3d423",
} as const;

const LEDGER = Object.entries(RUN_REPORT_FIELDS);
const VERDICTS = new Map(LEDGER);
const READ = LEDGER.filter(([, verdict]) => verdict === "read").map(([p]) => p);
const IGNORED = LEDGER.filter(([, verdict]) => verdict !== "read").map(
	([p]) => p,
);

function schema(): JsonObject {
	const document = parseJsonText(
		fixtureBytes("run-report.v1.schema.json").toString("utf8"),
	);
	if (!isJsonObject(document)) throw new Error("schema is not an object");
	return document;
}

function objectAt(node: JsonValue | undefined, what: string): JsonObject {
	if (!isJsonObject(node)) throw new Error(`schema: ${what} is not an object`);
	return node;
}

/** Follow `#/$defs/<name>` references; the schema uses no other kind. */
function resolve(root: JsonObject, node: JsonObject): JsonObject {
	const ref = node.$ref;
	if (!isJsonString(ref)) return node;
	const name = ref.replace("#/$defs/", "");
	return resolve(root, objectAt(objectAt(root.$defs, "$defs")[name], ref));
}

/** The object schema a required field opens into, through an array's items. */
function openedObject(root: JsonObject, node: JsonObject): JsonObject | null {
	const resolved = resolve(root, node);
	if (resolved.type === "array") {
		return openedObject(root, objectAt(resolved.items, "items"));
	}
	return resolved.type === "object" ? resolved : null;
}

function segmentOf(root: JsonObject, node: JsonObject, key: string): string {
	return resolve(root, node).type === "array" ? `${key}[]` : key;
}

/**
 * Required field paths, in ledger notation, descending only into fields the
 * ledger marks `read`: nothing under an ignored field is looked at.
 */
function requiredPaths(root: JsonObject): string[] {
	const found: string[] = [];
	const visit = (node: JsonObject, prefix: string) => {
		const required = isJsonArray(node.required) ? node.required : [];
		const properties = objectAt(node.properties, `${prefix} properties`);
		for (const key of required) {
			if (!isJsonString(key)) continue;
			const child = objectAt(properties[key], `${prefix}${key}`);
			const path = `${prefix}${key}`;
			found.push(path);
			const verdict = VERDICTS.get(path);
			const opened = openedObject(root, child);
			if (verdict === "read" && opened !== null) {
				visit(opened, `${prefix}${segmentOf(root, child, key)}.`);
			}
		}
	};
	visit(root, "");
	return found;
}

describe("the copied ai-bdd files", () => {
	it.each(Object.entries(COPIED))("%s is the recorded bytes", (name, sha) => {
		const digest = createHash("sha256")
			.update(fixtureBytes(name))
			.digest("hex");
		expect(digest).toBe(sha);
		const readme = readFileSync(join(FIXTURE_DIR, "README.md"), "utf8");
		expect(readme).toContain(`${sha}  ${name}`);
	});
});

describe("RunReport v1 fields against the parser", () => {
	it("every required field of RunReport v1 is read or deliberately ignored, and nothing else is listed", () => {
		const required = requiredPaths(schema());
		expect(
			required.filter((path) => !Object.hasOwn(RUN_REPORT_FIELDS, path)),
		).toEqual([]);
		expect(
			LEDGER.map(([path]) => path).filter((p) => !required.includes(p)),
		).toEqual([]);
	});

	it("every ignored field says why", () => {
		for (const [, verdict] of LEDGER) {
			expect(verdict).toMatch(/^(read|ignored: .{10,})$/u);
		}
	});

	it.each(READ)("a report without %s is refused", (path) => {
		const bytes = bytesOf(removeAt(fixtureDoc("passed"), path));
		expect(() => parseAiBddRunReport(bytes)).toThrow();
	});

	it.each(
		IGNORED,
	)("a report without %s is refused for that missing field alone", (path) => {
		const issues = issuesOf(bytesOf(removeAt(fixtureDoc("passed"), path)));
		const field = new RegExp(
			`^${path.split("[]").map(escapeRe).join("\\[\\d+\\]")}: required by RunReport v1$`,
			"u",
		);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues.filter((issue) => !field.test(issue))).toEqual([]);
	});

	it.each(IGNORED)("another value for %s yields the same evidence", (path) => {
		const { reportDigest: whole, ...expected } = parseAiBddRunReport(
			fixtureBytes("report.v1.passed.json"),
		);
		const { reportDigest, ...evidence } = parseAiBddRunReport(
			bytesOf(perturbAt(fixtureDoc("passed"), path)),
		);
		expect(evidence).toEqual(expected);
		expect(reportDigest).not.toBe(whole);
	});
});

/** Where each closed key set the parser applies sits in the schema. */
function schemaObjects(root: JsonObject): ReadonlyMap<string, JsonObject> {
	const props = objectAt(root.properties, "properties");
	const usage = objectAt(props.usage, "usage");
	const defs = objectAt(root.$defs, "$defs");
	return new Map([
		["RunReport", root],
		["Options", objectAt(props.options, "options")],
		["RunUsage", usage],
		[
			"ByPurpose",
			objectAt(
				objectAt(usage.properties, "usage.properties").byPurpose,
				"byPurpose",
			),
		],
		["Usage", objectAt(defs.Usage, "Usage")],
		["ScenarioResult", objectAt(defs.ScenarioResult, "ScenarioResult")],
		["StepResult", objectAt(defs.StepResult, "StepResult")],
		["Totals", objectAt(props.totals, "totals")],
	]);
}

function stringsOf(node: JsonValue | undefined): string[] {
	return (isJsonArray(node) ? node : [])
		.filter((k) => isJsonString(k))
		.map(String)
		.sort();
}

describe("the objects the parser walks are closed", () => {
	it("each closed key set is the schema's own: every property allowed, the required ones required, nothing else", () => {
		const objects = schemaObjects(schema());
		expect([...objects.keys()].sort()).toEqual(
			Object.keys(RUN_REPORT_KEYS).sort(),
		);
		for (const [name, keys] of Object.entries(RUN_REPORT_KEYS)) {
			const node = objects.get(name);
			expect(node?.additionalProperties, name).toBe(false);
			expect([...keys.allowed].sort(), name).toEqual(
				Object.keys(objectAt(node?.properties, `${name} properties`)).sort(),
			);
			expect([...keys.required].sort(), name).toEqual(
				stringsOf(node?.required),
			);
		}
	});

	it.each([
		["", "unexpected"],
		["options", "options.unexpected"],
		["usage", "usage.unexpected"],
		["usage.byPurpose", "usage.byPurpose.unexpected"],
		["usage.byPurpose.judge", "usage.byPurpose.judge.unexpected"],
		["scenarios.0", "scenarios[0].unexpected"],
		["scenarios.0.usage", "scenarios[0].usage.unexpected"],
		["scenarios.0.steps.0", "scenarios[0].steps[0].unexpected"],
		["scenarios.0.steps.0.usage", "scenarios[0].steps[0].usage.unexpected"],
		["totals", "totals.unexpected"],
	])("an extra field in %j is refused", (where, issue) => {
		const doc = fixtureDoc("passed");
		nodeAt(doc, where).unexpected = 1;
		expect(issuesOf(bytesOf(doc))).toEqual([
			`${issue}: not a field of RunReport v1`,
		]);
	});
});
