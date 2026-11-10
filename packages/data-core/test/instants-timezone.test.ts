// A gate that reads an instant through `Date.parse` reads one with no offset
// as local time: the same custody path expired on a host in Tokyo and passed
// on one in Los Angeles, and the same evidence was fresh on one and stale on
// the other. These run the gates in real processes under three zones.
//
// A child process, because setting `process.env.TZ` inside a vitest worker
// thread changes the variable and not the zone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { isJsonObject, type JsonValue, parseJsonText } from "../src/index.js";

const PROBE = fileURLToPath(
	new URL("./instants-timezone.probe.ts", import.meta.url),
);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles"] as const;

function probe(zone: string): { [member: string]: JsonValue } {
	const env = { ...process.env };
	env.TZ = zone;
	const report = parseJsonText(
		execFileSync(process.execPath, ["--import", "tsx", PROBE], {
			cwd: PACKAGE_ROOT,
			env,
			encoding: "utf8",
		}),
	);
	assert.ok(isJsonObject(report));
	return report;
}

const REFUSED_RETAIN_UNTIL =
	"refused: points[2].retainUntil must be an RFC 3339 instant with an explicit offset";
const REFUSED_NOW =
	"refused: now must be an RFC 3339 instant with an explicit offset";
const SELECTED = { selected: "snapshot-and-tail", reasons: [] };

describe("selector and custody instants do not depend on the process time zone", () => {
	const reports = ZONES.map((zone) => probe(zone));

	test("each child process really ran in its own zone", () => {
		assert.deepEqual(
			reports.map((report) => report.zone),
			[...ZONES],
		);
		// Local midnight of one civil date is a different instant in each.
		assert.equal(
			new Set(reports.map((report) => report.localMidnight)).size,
			ZONES.length,
		);
	});

	test("every zone gives the same answers: an instant without an offset is refused, never read as local time", () => {
		for (const report of reports) {
			assert.deepEqual(
				report.answers,
				{
					custody: {
						noOffsetAfter: REFUSED_RETAIN_UNTIL,
						noOffsetBefore: REFUSED_RETAIN_UNTIL,
						nowWithoutOffset: REFUSED_NOW,
						utc: [],
						tokyo: [],
						losAngeles: [],
						expired: ["CUSTODY_RETENTION_EXPIRED"],
					},
					selector: {
						noOffsetAfter: { selected: null, reasons: ["EVIDENCE_STALE"] },
						noOffsetBefore: { selected: null, reasons: ["EVIDENCE_STALE"] },
						nowWithoutOffset: REFUSED_NOW,
						fresh: SELECTED,
						stale: { selected: null, reasons: ["EVIDENCE_STALE"] },
						postdated: { selected: null, reasons: ["EVIDENCE_POSTDATED"] },
					},
				},
				String(report.zone),
			);
		}
	});
});
