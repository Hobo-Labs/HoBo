/**
 * `fleet:docs` (O27): the fleet's event names, ADR mentions and runbooks agree
 * with the documents. Each test builds a small tree that is complete except
 * for one gap and checks that exactly that gap is refused.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkFleetDocs, FLEET_RUNBOOKS } from "../check-fleet-docs.mts";

const repoRoot = join(import.meta.dirname, "..", "..");

const EVENTS = `export const FLEET_TOKEN_EVENTS = [
	"fleet.TokenIssued",
	"fleet.TokenRevoked",
] as const;
export const POLICY_DECIDED_EVENT = "policy.Decided";
export const FLEET_TRUST_STREAM = "fleet-trust";
`;

type Tree = Map<string, string>;

function complete(): Tree {
	const tree: Tree = new Map(
		Object.entries({
			"packages/fleet/src/events.ts": EVENTS,
			"docs/design/fleet.md":
				"# Fleet\n\nSee ADR-0182. Events: `fleet.TokenIssued`, `fleet.TokenRevoked`.\n",
			"docs/design/adr/fleet.md": "# ADR-0182 and ADR-0122\n",
			"docs/design/adr/index.md":
				"| # | Decision | File |\n|---|---|---|\n| 0122 | Old | x |\n| 0182 | Fleet | fleet |\n",
			"docs/design/event-families.md":
				"| Family | Events |\n|---|---|\n| `fleet.*` | `fleet.TokenIssued`, `fleet.TokenRevoked` — fleet |\n",
		}),
	);
	for (const runbook of FLEET_RUNBOOKS)
		tree.set(`docs/maintenance/fleet/${runbook}`, "# Runbook\n");
	return tree;
}

const made: string[] = [];

function write(tree: Tree): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-docs-"));
	made.push(dir);
	for (const [path, text] of tree) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("checkFleetDocs", () => {
	it("finds no gap in a complete tree", () => {
		expect(checkFleetDocs(write(complete()))).toEqual([]);
	});

	it("refuses an event missing from the design document", () => {
		const tree = complete();
		tree.set(
			"docs/design/fleet.md",
			"# Fleet\n\nSee ADR-0182. Events: `fleet.TokenIssued`, `fleet.TokenRevokedLater`.\n",
		);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "event",
				subject: "fleet.TokenRevoked",
				detail: "fleet.TokenRevoked is not in docs/design/fleet.md",
			},
		]);
	});

	it("refuses an event the fleet.* family row does not cover", () => {
		const tree = complete();
		tree.set(
			"docs/design/event-families.md",
			"| Family | Events |\n|---|---|\n| `fleet.*` | `fleet.TokenIssued` — fleet |\n| `other.*` | `fleet.TokenRevoked` |\n",
		);
		expect(checkFleetDocs(write(tree)).map((gap) => gap.kind)).toEqual([
			"event-family",
		]);
	});

	it("refuses a missing fleet.* family row", () => {
		const tree = complete();
		tree.set(
			"docs/design/event-families.md",
			"| Family | Events |\n|---|---|\n",
		);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "event-family",
				subject: "fleet.*",
				detail: "docs/design/event-families.md has no `fleet.*` row",
			},
		]);
	});

	it("refuses an ADR mention with no row in the ADR index", () => {
		const tree = complete();
		tree.set(
			"docs/design/adr/index.md",
			"| # | Decision | File |\n|---|---|---|\n| 0182 | Fleet | fleet |\n",
		);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "adr",
				subject: "ADR-0122",
				detail:
					"ADR-0122 (docs/design/adr/fleet.md) is not a row of docs/design/adr/index.md",
			},
		]);
	});

	it("refuses a missing runbook", () => {
		const tree = complete();
		const [first] = FLEET_RUNBOOKS;
		tree.delete(`docs/maintenance/fleet/${first}`);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "runbook",
				subject: `docs/maintenance/fleet/${first}`,
				detail: `runbook docs/maintenance/fleet/${first} does not exist`,
			},
		]);
	});

	it("refuses a missing design document as a gap, not a crash", () => {
		const tree = complete();
		tree.delete("docs/design/fleet.md");
		const kinds = checkFleetDocs(write(tree)).map((gap) => gap.kind);
		expect(kinds).toContain("document");
		expect(kinds).toContain("event");
	});

	it("names one runbook per runbook of the operations section", () => {
		expect(FLEET_RUNBOOKS).toHaveLength(11);
		for (const runbook of FLEET_RUNBOOKS)
			expect(runbook).toMatch(/^[a-z0-9-]+\.md$/u);
	});
});

describe("fleet:docs command", () => {
	function cli(root: string) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(repoRoot, "scripts/check-fleet-docs.mts"),
				`--root=${root}`,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
	}

	it("exits 0 on a complete tree and 1 with each gap on stderr otherwise", () => {
		expect(cli(write(complete())).status).toBe(0);
		const tree = complete();
		tree.delete("docs/maintenance/fleet/clone-alarm.md");
		const result = cli(write(tree));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("docs/maintenance/fleet/clone-alarm.md");
	});
});
