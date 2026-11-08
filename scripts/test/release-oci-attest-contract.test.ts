import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function parseReleaseJobBlock(workflowText: string, jobId: string): string {
	const jobRe = new RegExp(`^  ${jobId}:`, "m");
	const match = jobRe.exec(workflowText);
	if (!match) {
		throw new Error(`workflow missing job ${jobId}`);
	}
	const start = match.index;
	const rest = workflowText.slice(start + 1);
	const nextJob = rest.search(/^  [a-z][a-z0-9-]+:/m);
	return nextJob === -1
		? workflowText.slice(start)
		: workflowText.slice(start, start + 1 + nextJob);
}

/** Mirrors release-oci-attest composite digest grep (grep -F "/${imageId}@"). */
export function selectDigestRefFromList(
	listText: string,
	imageId: string,
): string | undefined {
	const needle = `/${imageId}@`;
	for (const line of listText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.includes(needle)) return trimmed;
	}
	return undefined;
}

describe("release-oci-attest composite action", () => {
	const actionYml = readFileSync(
		join(root, ".github/actions/release-oci-attest/action.yml"),
		"utf8",
	);

	it("logs into GHCR before attest-build-provenance (self-hosted needs config.json)", () => {
		const loginIdx = actionYml.indexOf("docker login ghcr.io");
		const attestIdx = actionYml.indexOf("attest-build-provenance");
		expect(loginIdx).toBeGreaterThan(0);
		expect(attestIdx).toBeGreaterThan(loginIdx);
		expect(actionYml).toMatch(/mkdir -p "\$\{HOME\}\/\.docker"/u);
	});

	it("requires ghcr-token and ghcr-username inputs for login", () => {
		expect(actionYml).toMatch(/ghcr-token:/u);
		expect(actionYml).toMatch(/ghcr-username:/u);
	});

	it("fails fast when digest list file is missing", () => {
		expect(actionYml).toMatch(/digest list not found/u);
	});
});

describe("release attest workflow jobs", () => {
	const hoboWorkflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);

	it("release-attest grants packages:write for push-to-registry attestations", () => {
		const block = parseReleaseJobBlock(hoboWorkflow, "release-attest");
		expect(block).toMatch(/packages:\s*write/u);
		expect(block).toMatch(
			/ghcr-token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/u,
		);
	});
});

describe("digest list selection for attestation", () => {
	const sample = [
		"ghcr.io/hobo-labs/hobo/hobo-sdk@sha256:111",
		"ghcr.io/hobo-labs/hobo/hobo-codegen@sha256:222",
		"ghcr.io/hobo-labs/hobo/hobo-cli@sha256:333",
	].join("\n");

	for (const imageId of ["hobo-sdk", "hobo-codegen", "hobo-cli"] as const) {
		it(`resolves ${imageId} from push digest artifact lines`, () => {
			expect(selectDigestRefFromList(sample, imageId)).toMatch(
				new RegExp(`/${imageId}@sha256:`),
			);
		});
	}

	it("returns undefined when image id absent", () => {
		expect(selectDigestRefFromList(sample, "hobo-missing")).toBeUndefined();
	});
});
