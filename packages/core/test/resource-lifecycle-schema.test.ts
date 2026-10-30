import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cue = fileURLToPath(
	new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/resource_lifecycle.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-lifecycle-cue-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
const base = {
	tenantId: "tenant",
	providerId: "cloudflare",
	providerAccountId: "preview",
	productId: "cloudflare.workers/v1",
	resourceId: "api",
	operationId: "prepare-1",
	physicalId: "worker-1",
	status: "ready",
	observedAtMs: 1000,
	evidenceRef: "provider://observations/1",
	operationTerminal: true,
};
function check<T>(definition: string, document: T) {
	const path = join(directory, `${++sequence}.json`);
	writeFileSync(path, JSON.stringify(document));
	return spawnSync(cue, ["vet", "-c", "-d", definition, schema, path], {
		encoding: "utf8",
		timeout: 10_000,
	});
}
describe("actual provider lifecycle CUE contract", () => {
	it.each([
		base,
		{ ...base, status: "unknown", operationTerminal: false },
		{
			...base,
			status: "absent",
			billable: false,
			usageFinal: true,
			settledMicros: 0,
			usageEvidenceRef: "provider://invoice/1",
		},
	])("accepts complete scoped provider observations", (document) => {
		const result = check("#ResourceLifecycleObservationRecord", document);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
	it.each([
		{ ...base, observedAtMs: 1.5 },
		{ ...base, observedAtMs: 9007199254740992 },
		{ ...base, status: "absent", operationTerminal: false },
		{ ...base, healthy: true },
		{ ...base, usageFinal: true },
		{
			...base,
			usageFinal: true,
			usageEvidenceRef: "provider://invoice/1",
			settledMicros: -1,
		},
		{ ...base, artifactDigest: "copied-label" },
	])("rejects unsafe or incomplete evidence", (document) => {
		const result = check("#ResourceLifecycleObservationRecord", document);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
	it("requires a complete content-addressed resource envelope", () => {
		const envelope = {
			tenantId: "tenant",
			providerId: "neon",
			providerAccountId: "anonymous",
			scopeId: "deployment-1",
			recordKey: "db",
			recordJson: "{}",
			recordDigest: `sha256:${"a".repeat(64)}`,
		};
		expect(check("#ProviderResourceRecordEnvelope", envelope).status).toBe(0);
		expect(
			check("#ProviderResourceRecordEnvelope", { ...envelope, scopeId: "" })
				.status,
		).not.toBe(0);
		expect(
			check("#ProviderResourceRecordEnvelope", {
				...envelope,
				recordDigest: "unchecked",
			}).status,
		).not.toBe(0);
	});
});
