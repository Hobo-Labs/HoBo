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
	new URL("../data-models/anonymous_deployment.cue", import.meta.url),
);
const observed = {
	projectName: "owned",
	deploymentId: "dpl_owned",
	stationUrl: "https://owned.vercel.app",
	claimUrl: "https://vercel.com/claim-deployment?code=fake",
	anonymous: true,
	expiresAt: "2026-10-30T01:00:00.000Z",
	expirySource: "provider-reported",
};
function vet(record: JsonObject) {
	const directory = mkdtempSync(join(tmpdir(), "vercel-anonymous-schema-"));
	try {
		const target = join(directory, "record.json");
		writeFileSync(target, JSON.stringify(record));
		execFileSync(
			cue,
			[
				"vet",
				"-c",
				"-d",
				"#VercelAnonymousDeploymentEvidenceRecord",
				schema,
				target,
			],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
describe("temporary deployment protobuf/CUE evidence", () => {
	it("accepts explicit provider-reported anonymous identity, claim and expiry", () => {
		expect(() => vet(observed)).not.toThrow();
	});
	it.each([
		{ anonymous: false },
		{ expirySource: "documented-window" },
		{ stationUrl: "https://owned.vercel.app.evil.example" },
		{ claimUrl: "https://vercel.com/project" },
		{ deploymentId: "" },
		{ expiresAt: "invented" },
	])("rejects fake anonymity, ownership or expiry %j", (override) => {
		expect(() => vet({ ...observed, ...override })).toThrow();
	});
});
