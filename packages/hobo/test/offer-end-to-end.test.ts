import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	digestOf,
	emitAnonymousTrustEvidence,
	PRODUCT_DEFINITION_DIGEST,
	REFERENCE_ANONYMOUS_PORTS,
	runAnonymousConformance,
} from "@hobo/conformance";
import { afterEach, describe, expect, it } from "vitest";

import { EVIDENCE_DIRECTORY, loadTrustEvidence } from "../src/recipe-plane.js";

// The whole pre-provision chain, with nothing hand-written in the middle: run
// the anonymous conformance suites against the reference adapter, emit the
// signed evidence artifact the live lane publishes, drop it where the CLI
// reads evidence, and confirm the CLI parses it back into the trust evidence
// selection consumes.
//
// The point is the seam. An offer that compiles against evidence nobody
// produced is theatre; an offer that fails closed when the evidence directory
// is empty — and stops failing once a real run lands — is the contract.

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

async function tempHome(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-offer-e2e-"));
	dirs.push(dir);
	await mkdir(path.join(dir, EVIDENCE_DIRECTORY), { recursive: true });
	return dir;
}

const TESTED_AT_MS = 1_700_000_000_000;

const SIGNER = {
	id: "integration-signer/v1",
	sign: (digest: string): string => `sig:${digestOf(digest).slice(7, 39)}`,
};

async function publishReferenceEvidence(home: string): Promise<void> {
	const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS, {
		subjectId: "reference.claimable-postgres",
	});
	const artifact = emitAnonymousTrustEvidence({
		providerId: "reference-cloud",
		productDefinitionId: "reference.claimable-postgres",
		productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
		adapterVersion: "1.4.2",
		providerClass: "verified-emerging",
		providerDocsCheckedAt: "2026-08-01",
		runTag: "hobo-cli-integration",
		testedAtMs: TESTED_AT_MS,
		reports,
		creatorAuthorityAfterClaim: "absent",
		claimActionCount: 1,
		sourceRefs: [
			{
				url: "https://docs.reference-cloud.example/anonymous-projects",
				checkedAt: "2026-08-01",
			},
		],
		signer: SIGNER,
	});
	await writeFile(
		path.join(home, EVIDENCE_DIRECTORY, "reference-cloud.json"),
		JSON.stringify(artifact, null, 2),
	);
}

describe("evidence published by a real conformance run", () => {
	it("is empty until a run publishes something", async () => {
		const home = await tempHome();
		expect(
			await loadTrustEvidence(path.join(home, EVIDENCE_DIRECTORY)),
		).toEqual([]);
	});

	it("is read back as the trust evidence selection consumes", async () => {
		const home = await tempHome();
		await publishReferenceEvidence(home);

		const evidence = await loadTrustEvidence(
			path.join(home, EVIDENCE_DIRECTORY),
		);
		expect(evidence).toHaveLength(1);
		const [first] = evidence;
		expect(first?.providerId).toBe("reference-cloud");
		expect(first?.productDefinitionId).toBe("reference.claimable-postgres");
		// The conformance run decided these; nothing here asserted them.
		expect(Object.keys(first?.checks ?? {}).length).toBeGreaterThan(0);
	});

	it("carries no credential material out of the harness onto disk", async () => {
		const home = await tempHome();
		await publishReferenceEvidence(home);
		const [evidence] = await loadTrustEvidence(
			path.join(home, EVIDENCE_DIRECTORY),
		);
		const serialized = JSON.stringify(evidence);
		expect(serialized).not.toMatch(/postgres:\/\//u);
		expect(serialized).not.toMatch(/Bearer\s+\S+/u);
		expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u);
	});

	it("refuses the whole directory when one artifact is corrupt", async () => {
		const home = await tempHome();
		await publishReferenceEvidence(home);
		await writeFile(
			path.join(home, EVIDENCE_DIRECTORY, "broken.json"),
			'{"evidence":{"schemaVersion":"nope"}}',
		);
		// Skipping the bad file would let a provider lose its evidence and keep
		// its ranking, so the load fails instead.
		await expect(
			loadTrustEvidence(path.join(home, EVIDENCE_DIRECTORY)),
		).rejects.toThrow(/evidence-invalid/u);
	});
});
