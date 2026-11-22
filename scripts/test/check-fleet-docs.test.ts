import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkFleetDocs, RUNBOOK_FILES } from "../check-fleet-docs.mts";

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
			"packages/fleet/README.md":
				"# Fleet\n\nEvents: `fleet.TokenIssued`, `fleet.TokenRevoked`.\n",
		}),
	);
	for (const runbook of RUNBOOK_FILES)
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

	it("refuses an event missing from the fleet README", () => {
		const tree = complete();
		tree.set(
			"packages/fleet/README.md",
			"# Fleet\n\nEvents: `fleet.TokenIssued`, `fleet.TokenRevokedLater`.\n",
		);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "event",
				subject: "fleet.TokenRevoked",
				detail: "fleet.TokenRevoked is not in packages/fleet/README.md",
			},
		]);
	});

	it("refuses a missing runbook", () => {
		const tree = complete();
		const [first] = RUNBOOK_FILES;
		tree.delete(`docs/maintenance/fleet/${first}`);
		expect(checkFleetDocs(write(tree))).toEqual([
			{
				kind: "runbook",
				subject: `docs/maintenance/fleet/${first}`,
				detail: `runbook docs/maintenance/fleet/${first} does not exist`,
			},
		]);
	});

	it("refuses a missing fleet README as a gap, not a crash", () => {
		const tree = complete();
		tree.delete("packages/fleet/README.md");
		const kinds = checkFleetDocs(write(tree)).map((gap) => gap.kind);
		expect(kinds).toContain("document");
		expect(kinds).toContain("event");
	});

	it("names one runbook per runbook of the operations section", () => {
		expect(RUNBOOK_FILES).toHaveLength(11);
		for (const runbook of RUNBOOK_FILES)
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
