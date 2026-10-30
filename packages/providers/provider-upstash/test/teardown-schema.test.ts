import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

const cue = fileURLToPath(
	new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/teardown.cue", import.meta.url),
);
function vet(record: JsonObject) {
	const directory = mkdtempSync(join(tmpdir(), "upstash-teardown-"));
	try {
		const path = join(directory, "record.json");
		writeFileSync(path, JSON.stringify(record));
		execFileSync(
			cue,
			["vet", "-c", "-d", "#UpstashDestroyOutcome", schema, path],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
describe("Redis teardown evidence CUE", () => {
	it("accepts unverified retention and positive absence plus final usage", () => {
		expect(() =>
			vet({ destroyed: false, reason: "retirement unverified" }),
		).not.toThrow();
		expect(() =>
			vet({
				destroyed: true,
				reason: "provider confirmed",
				retirementEvidenceRef: "provider://absence",
				usageEvidenceRef: "provider://usage",
			}),
		).not.toThrow();
	});
	it("rejects a destruction claim without both evidence references", () => {
		expect(() => vet({ destroyed: true, reason: "expired" })).toThrow();
		expect(() =>
			vet({
				destroyed: true,
				reason: "absent",
				retirementEvidenceRef: "provider://absence",
			}),
		).toThrow();
	});
});
