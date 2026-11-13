/**
 * `fleet:moved-tests` (O15, O16, O17): a moved test differs from its base at
 * `fleet-wave-0` only as the moved-test rules allow. Both sides are parsed
 * with the TypeScript compiler API, so formatting and comments never count;
 * the rename and value maps rewrite the base side and the unwrapping rewrites
 * the new side. `exact` mode drops imports and the named helpers; `assertions`
 * mode compares only test titles and `expect` statements, in order.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	checkMovedTests,
	compareAssertions,
	compareExact,
	MOVED_TESTS,
	RENAME_MAP,
} from "../check-fleet-moved-tests.mts";

const repoRoot = join(import.meta.dirname, "..", "..");

const BASE = `import { describe, expect, it } from "vitest";
import { parseFleetAssignment, type FleetAssignment } from "@hobo/backend-fleet";
import { model } from "./fleet-model.js";

function entry(epoch: number, active: string): FleetAssignment {
	return parseFleetAssignment({ epoch, active, failure: "reachable" });
}

function writer(active: string) {
	return { active };
}

describe("assignment register", () => {
	it("decides one entry per epoch", () => {
		const decided = entry(1, "upstash");
		expect(decided.epoch).toBe(1);
		expect(writer("upstash").active).toBe("upstash");
	});
});
`;

/** BASE after the rename and value maps: what a faithful move writes. */
const MOVED = BASE.replaceAll("parseFleetAssignment", "parseAssignmentEntry")
	.replaceAll("@hobo/backend-fleet", "@hobo/backend-routing")
	.replaceAll("FleetAssignment", "AssignmentEntry")
	.replace('failure: "reachable"', "failure: Health.REACHABLE");

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("exact mode", () => {
	it("accepts an identical file, whatever its formatting and comments", () => {
		const reformatted = MOVED.replaceAll("\t", "    ")
			.replaceAll(";\n", "\n")
			.replaceAll('"upstash"', "'upstash'")
			.replace("describe(", "// a comment\ndescribe(");
		expect(compareExact(BASE, MOVED, [])).toEqual([]);
		expect(compareExact(BASE, reformatted, [])).toEqual([]);
		expect(compareExact(BASE, BASE, [])).not.toEqual([]);
	});

	it("accepts an import edit", () => {
		const next = BASE.replace(
			`import { model } from "./fleet-model.js";`,
			`import { model } from "../assignment/fleet-model.js";\nimport { other } from "@hobo/fleet";`,
		)
			.replaceAll("parseFleetAssignment", "parseAssignmentEntry")
			.replaceAll("FleetAssignment", "AssignmentEntry")
			.replace('failure: "reachable"', "failure: Health.REACHABLE");
		expect(compareExact(BASE, next, [])).toEqual([]);
	});

	it("accepts an edit to a named helper and refuses it to any other helper", () => {
		const next = BASE.replaceAll("parseFleetAssignment", "parseAssignmentEntry")
			.replaceAll("FleetAssignment", "AssignmentEntry")
			.replace('failure: "reachable"', "failure: Health.REACHABLE")
			.replace("return { active };", "return { active, members: [] };");
		expect(compareExact(BASE, next, ["writer"])).toEqual([]);
		expect(compareExact(BASE, next, ["entry"])).not.toEqual([]);
		const signature = next.replace(
			"function writer(active: string)",
			"function writer(active: string, epoch = 1)",
		);
		expect(compareExact(BASE, signature, ["writer"])).toEqual([]);
	});

	it.each(
		Object.entries(RENAME_MAP),
	)("accepts the rename %s -> %s", (from, to) => {
		const base = from.startsWith("@")
			? `import { x } from "${from}";\nexport const y = await import("${from}");\n`
			: `export function f(value: ${from}): ${from} { return ${from}(value); }\n`;
		const next = base.replaceAll(from, to);
		expect(compareExact(base, next, [])).toEqual([]);
		expect(compareExact(base, base.replaceAll(from, `${to}X`), [])).not.toEqual(
			[],
		);
	});

	it("lets a moved file change the leading segments of a module-relative URL", () => {
		const at = (path: string) =>
			`export const pact = new URL("${path}", import.meta.url);\n`;
		const base = at("../contracts/replica.pact.json");
		expect(
			compareExact(base, at("../../contracts/replica.pact.json"), []),
		).toEqual([]);
		expect(
			compareExact(base, at("../../contracts/other.pact.json"), []),
		).not.toEqual([]);
		expect(
			compareExact(base, at("../../fixtures/replica.pact.json"), []),
		).not.toEqual([]);
		expect(
			compareExact(
				`export const p = "../contracts/replica.pact.json";\n`,
				`export const p = "../../contracts/replica.pact.json";\n`,
				[],
			),
		).not.toEqual([]);
	});

	it("does not rename inside other identifiers or strings", () => {
		const base = `export const MyFleetAssignment = "FleetAssignment";\n`;
		expect(
			compareExact(
				base,
				`export const MyAssignmentEntry = "AssignmentEntry";\n`,
				[],
			),
		).not.toEqual([]);
	});

	it.each([
		["reachable", "REACHABLE"],
		["unreachable", "UNREACHABLE"],
		["quota-exhausted", "QUOTA_EXHAUSTED"],
		["auth", "AUTH"],
		["unknown", "UNKNOWN"],
	])("maps failure and health %s to Health.%s", (literal, member) => {
		for (const key of ["failure", "health"]) {
			const base = `export const o = { ${key}: "${literal}", other: "${literal}" };\n`;
			const next = `export const o = { ${key}: Health.${member}, other: "${literal}" };\n`;
			expect(compareExact(base, next, [])).toEqual([]);
		}
		const otherKey = `export const o = { status: "${literal}" };\n`;
		expect(
			compareExact(
				otherKey,
				`export const o = { status: Health.${member} };\n`,
				[],
			),
		).not.toEqual([]);
	});

	it("unwraps parseMemberName of a string literal on the new side", () => {
		const base = `export const name = "upstash";\nexport const n = parseFleetBackendId(other);\n`;
		const next = `export const name = parseMemberName("upstash");\nexport const n = parseMemberName(other);\n`;
		expect(compareExact(base, next, [])).toEqual([]);
		const notLiteral = `export const name = parseMemberName(upstash);\nexport const n = parseMemberName(other);\n`;
		expect(compareExact(base, notLiteral, [])).not.toEqual([]);
	});

	it("removes members: undefined only from objects passed to parseAssignmentEntry", () => {
		const base = `export const e = parseFleetAssignment({ epoch: 1, active: "a" });\n`;
		const next = `export const e = parseAssignmentEntry({ epoch: 1, members: undefined, active: "a" });\n`;
		expect(compareExact(base, next, [])).toEqual([]);
		const elsewhere = `export const e = parseFleetAssignment({ epoch: 1, active: "a" });\nexport const o = { members: undefined };\n`;
		expect(
			compareExact(
				`${base}export const o = {};\n`,
				elsewhere.replace("parseFleetAssignment", "parseAssignmentEntry"),
				[],
			),
		).not.toEqual([]);
		const filled = `export const e = parseAssignmentEntry({ epoch: 1, members: [], active: "a" });\n`;
		expect(compareExact(base, filled, [])).not.toEqual([]);
	});

	it("refuses any other edit and names the line", () => {
		const renamed = BASE.replaceAll(
			"parseFleetAssignment",
			"parseAssignmentEntry",
		)
			.replaceAll("FleetAssignment", "AssignmentEntry")
			.replace('failure: "reachable"', "failure: Health.REACHABLE");
		expect(compareExact(BASE, renamed, [])).toEqual([]);
		const changed = renamed.replace("toBe(1)", "toBe(2)");
		const differences = compareExact(BASE, changed, []);
		expect(differences).toHaveLength(1);
		expect(differences[0]).toMatch(/base line 16.*new line 16/u);
		const added = renamed.replace(
			"\t});\n});",
			'\t});\n\tit("new case", () => {});\n});',
		);
		expect(compareExact(BASE, added, [])).not.toEqual([]);
		const removed = renamed.replace(
			'\t\texpect(writer("upstash").active).toBe("upstash");\n',
			"",
		);
		expect(compareExact(BASE, removed, [])).not.toEqual([]);
	});
});

const ROUTING_BASE = `import { describe, expect, it } from "vitest";
import { decideFleet, type FleetRoutingObservation } from "@hobo/backend-fleet";

const seen = (id: string): FleetRoutingObservation => ({ id, health: "reachable" });

describe("decideFleet", () => {
	it("chooses the cheapest reachable backend", () => {
		const observations = [seen("a"), { ...seen("b"), usage: 3 }];
		expect(decideFleet(observations).active).toBe("a");
		expect(decideFleet(observations).reason).toEqual({ kind: "cheapest", health: "reachable" });
	});
	it("refuses when every backend is down", () => {
		expect(() => decideFleet([])).toThrow("no backend");
	});
});
`;

const ROUTING_MOVED = ROUTING_BASE.replaceAll(
	"@hobo/backend-fleet",
	"@hobo/backend-routing",
)
	.replaceAll("FleetRoutingObservation", "NamedObservation")
	.replace(
		'reason).toEqual({ kind: "cheapest", health: "reachable" })',
		'reason).toEqual({ kind: "cheapest", health: Health.REACHABLE })',
	);

describe("assertions mode", () => {
	const renamed = ROUTING_MOVED;

	it("accepts an unchanged file only after the maps", () => {
		expect(compareAssertions(ROUTING_BASE, renamed)).toEqual([]);
		expect(compareAssertions(ROUTING_BASE, ROUTING_BASE)).toHaveLength(1);
	});

	it("accepts changed setup, helpers and fixtures", () => {
		const next = renamed
			.replace(
				'const seen = (id: string): NamedObservation => ({ id, health: "reachable" });',
				"const seen = (name: string): NamedObservation => ({ name, observation: { health: Health.REACHABLE } });\nconst down = (name: string) => ({ name });",
			)
			.replace(
				'const observations = [seen("a"), { ...seen("b"), usage: 3 }];',
				'const observations = [seen("a"), withUsage(seen("b"), 3)];\n\t\tconst unused = down("c");',
			);
		expect(compareAssertions(ROUTING_BASE, next)).toEqual([]);
	});

	it("refuses a changed expect", () => {
		const next = renamed.replace('toThrow("no backend")', 'toThrow("none")');
		expect(compareAssertions(ROUTING_BASE, next)).toHaveLength(1);
	});

	it("refuses a removed expect", () => {
		const next = renamed.replace(
			'\t\texpect(decideFleet(observations).active).toBe("a");\n',
			"",
		);
		expect(compareAssertions(ROUTING_BASE, next)).not.toEqual([]);
	});

	it("refuses reordered expects", () => {
		const lines = renamed.split("\n");
		const first = lines.findIndex((line) => line.includes(".active).toBe"));
		[lines[first], lines[first + 1]] = [
			lines[first + 1] ?? "",
			lines[first] ?? "",
		];
		expect(compareAssertions(ROUTING_BASE, lines.join("\n"))).not.toEqual([]);
	});

	it("refuses a changed, removed or reordered test title", () => {
		expect(
			compareAssertions(
				ROUTING_BASE,
				renamed.replace("chooses the cheapest", "picks the cheapest"),
			),
		).not.toEqual([]);
		expect(
			compareAssertions(
				ROUTING_BASE,
				renamed.replace(
					/\tit\("refuses when every backend is down"[\s\S]*?\n\t\}\);\n/u,
					"",
				),
			),
		).not.toEqual([]);
		const swapped = renamed
			.replace("chooses the cheapest reachable backend", "@@1")
			.replace(
				"refuses when every backend is down",
				"chooses the cheapest reachable backend",
			)
			.replace("@@1", "refuses when every backend is down");
		expect(compareAssertions(ROUTING_BASE, swapped)).not.toEqual([]);
	});

	it("refuses a moved expect under another title", () => {
		const next = renamed
			.replace('\t\texpect(() => decideFleet([])).toThrow("no backend");\n', "")
			.replace(
				'\t\texpect(decideFleet(observations).active).toBe("a");\n',
				'\t\texpect(decideFleet(observations).active).toBe("a");\n\t\texpect(() => decideFleet([])).toThrow("no backend");\n',
			);
		expect(compareAssertions(ROUTING_BASE, next)).not.toEqual([]);
	});
});

describe("the moved-test table", () => {
	it("holds every row of the design with its mode, helpers and lane", () => {
		const rows = MOVED_TESTS.map(
			(row) =>
				`${row.outcome} ${row.lane} ${row.mode} ${row.base} -> ${row.next} [${row.helpers === "any" ? "any" : row.helpers.join(",")}]`,
		);
		expect(rows).toEqual([
			"O15 L05 exact packages/data-postgres/test/fleet-assignment.test.ts -> packages/fleet/test/assignment/register.test.ts [entry,writer]",
			"O15 L05 exact packages/data-postgres/test/fleet-model.ts -> packages/fleet/test/assignment/fleet-model.ts []",
			"O15 L05 exact packages/backend-routing/test/ephemeral-replica.test.ts -> packages/fleet/test/assignment/ephemeral-replica.test.ts []",
			"O15 L05 exact packages/backend-routing/test/fixtures.ts -> packages/fleet/test/assignment/fixtures.ts []",
			"O15 L05 exact packages/backend-routing/test/replica-pact.test.ts -> packages/fleet/test/assignment/replica-pact.test.ts []",
			"O15 L05 exact packages/backend-routing/test/replica-pact.ts -> packages/fleet/test/assignment/replica-pact.ts []",
			"O16 L17 exact packages/ci-vercel/test/cache-fleet.test.ts -> packages/ci-vercel/test/cache-fleet.test.ts [member,world]",
			"O16 L17 exact packages/ci-vercel/test/cache-backend.test.ts -> packages/ci-vercel/test/cache-backend.test.ts []",
			"O17 L21 assertions packages/data-postgres/test/fleet-policy.test.ts -> packages/data-postgres/test/fleet-policy.test.ts [any]",
			"O17 L21 assertions packages/backend-routing/test/routing.test.ts -> packages/backend-routing/test/routing.test.ts [any]",
		]);
	});
});

function tree(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-moved-tests-"));
	made.push(dir);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

describe("checkMovedTests", () => {
	const routing = "packages/backend-routing/test/routing.test.ts";
	const policy = "packages/data-postgres/test/fleet-policy.test.ts";
	const bases = new Map([
		[routing, ROUTING_BASE],
		[policy, ROUTING_BASE],
	]);
	const readBase = (path: string): string | undefined => bases.get(path);

	it("passes every row of an outcome whose files differ only as allowed", () => {
		const root = tree({ [routing]: ROUTING_MOVED, [policy]: ROUTING_MOVED });
		const results = checkMovedTests({ root, outcome: "O17", readBase });
		expect(results.map((result) => [result.next, result.differences])).toEqual([
			[policy, []],
			[routing, []],
		]);
	});

	it("fails a row whose new file does not exist", () => {
		const root = tree({ [routing]: ROUTING_MOVED });
		const results = checkMovedTests({ root, outcome: "O17", readBase });
		expect(results[0]?.differences).toEqual([`${policy} does not exist`]);
		expect(results[1]?.differences).toEqual([]);
	});

	it("fails a row whose base file is not at the base ref", () => {
		const root = tree({ [routing]: ROUTING_MOVED, [policy]: ROUTING_MOVED });
		const results = checkMovedTests({
			root,
			outcome: "O17",
			readBase: (path) => (path === routing ? ROUTING_BASE : undefined),
		});
		expect(results[0]?.differences).toEqual([
			`${policy} is not at the base ref`,
		]);
	});

	it("selects rows by lane and refuses an unknown outcome or lane", () => {
		const root = tree({});
		expect(
			checkMovedTests({ root, outcome: "O15", lane: "L05", readBase }),
		).toHaveLength(6);
		expect(() =>
			checkMovedTests({ root, outcome: "O15", lane: "L17", readBase }),
		).toThrow(/no moved-test row/u);
		expect(() => checkMovedTests({ root, outcome: "O99", readBase })).toThrow(
			/no moved-test row/u,
		);
	});
});

describe("the command", () => {
	function git(cwd: string, ...args: string[]): void {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	}

	function run(cwd: string, ...args: string[]) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(repoRoot, "scripts/check-fleet-moved-tests.mts"),
				`--root=${cwd}`,
				...args,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
	}

	it("compares against the base tag in git and exits by the result", () => {
		const routing = "packages/backend-routing/test/routing.test.ts";
		const policy = "packages/data-postgres/test/fleet-policy.test.ts";
		const root = tree({ [routing]: ROUTING_MOVED, [policy]: ROUTING_MOVED });
		git(root, "init", "-q");
		git(root, "add", "-A");
		git(
			root,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.invalid",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			"base",
		);
		git(root, "tag", "fleet-wave-0");
		writeFileSync(join(root, routing), ROUTING_MOVED);
		writeFileSync(join(root, policy), ROUTING_MOVED);

		const pass = run(root, "O17");
		expect(pass.status, pass.stderr).toBe(0);
		expect(pass.stdout).toContain(
			"fleet:moved-tests O17: 2 file(s) differ only as allowed",
		);

		writeFileSync(
			join(root, routing),
			ROUTING_MOVED.replace('toThrow("no backend")', 'toThrow("none")'),
		);
		const fail = run(root, "O17", "--lane", "L21");
		expect(fail.status).toBe(1);
		expect(fail.stderr).toContain(routing);

		const usage = run(root);
		expect(usage.status).toBe(2);
	});
});
