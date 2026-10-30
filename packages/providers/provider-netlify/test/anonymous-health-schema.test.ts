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
	new URL("../data-models/anonymous_health.cue", import.meta.url),
);
function vet(record: JsonObject) {
	const directory = mkdtempSync(join(tmpdir(), "netlify-health-schema-"));
	try {
		const target = join(directory, "record.json");
		writeFileSync(target, JSON.stringify(record));
		execFileSync(
			cue,
			[
				"vet",
				"-c",
				"-d",
				"#NetlifyAnonymousHealthObservationRecord",
				schema,
				target,
			],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
describe("anonymous health protobuf/CUE projection", () => {
	it("accepts actual marker evidence and honest password gating", () => {
		expect(() =>
			vet({
				httpStatus: 200,
				markerObserved: true,
				passwordGateObserved: true,
			}),
		).not.toThrow();
		expect(() =>
			vet({
				httpStatus: 401,
				markerObserved: false,
				passwordGateObserved: true,
			}),
		).not.toThrow();
	});
	it.each([
		{ httpStatus: 401, markerObserved: true, passwordGateObserved: true },
		{ httpStatus: 0, markerObserved: false, passwordGateObserved: false },
		{ httpStatus: 200.5, markerObserved: false, passwordGateObserved: false },
		{
			httpStatus: 200,
			markerObserved: true,
			passwordGateObserved: true,
			cookie: "credential",
		},
	])("refuses invalid or credential-bearing observation %j", (record) => {
		expect(() => vet(record)).toThrow();
	});
});
