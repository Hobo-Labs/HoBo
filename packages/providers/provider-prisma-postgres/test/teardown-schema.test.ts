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
	const directory = mkdtempSync(join(tmpdir(), "prisma-teardown-"));
	try {
		const path = join(directory, "record.json");
		writeFileSync(path, JSON.stringify(record));
		execFileSync(
			cue,
			["vet", "-c", "-d", "#PrismaDestroyOutcome", schema, path],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
describe("provider teardown evidence CUE", () => {
	it("accepts retained exposure and provider-confirmed release", () => {
		const pending = {
			released: false,
			reapMode: "already-expired",
			custodyRevoked: false,
			expiresAtIso: "2026-11-01T00:00:00.000Z",
			detail: "retirement unverified",
		};
		expect(() => vet(pending)).not.toThrow();
		expect(() =>
			vet({
				...pending,
				released: true,
				reapMode: "provider-confirmed",
				retirementEvidenceRef: "provider://absence",
				usageEvidenceRef: "provider://usage",
			}),
		).not.toThrow();
	});
	it("rejects elapsed-TTL release and release without final evidence", () => {
		const base = {
			released: true,
			custodyRevoked: false,
			expiresAtIso: "2026-11-01T00:00:00.000Z",
			detail: "cleanup",
		};
		expect(() => vet({ ...base, reapMode: "already-expired" })).toThrow();
		expect(() =>
			vet({
				...base,
				reapMode: "provider-confirmed",
				retirementEvidenceRef: "provider://absence",
			}),
		).toThrow();
	});
});
