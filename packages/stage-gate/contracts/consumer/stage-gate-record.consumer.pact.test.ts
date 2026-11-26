import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	parseStageGateRecord,
	serializeStageGateRecord,
} from "../../src/parse.js";
import type { StageGateRecord } from "../../src/types.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../pacts/stage-gate-record.consumer.pact.json",
);

function samplePassedRecord(): StageGateRecord {
	return {
		gateId: "s0",
		status: "passed",
		repoCommit: "abc123",
		ciRunUrl: "https://github.com/example/hobo/actions/runs/1",
		startedAt: "2024-01-01T00:00:00.000Z",
		finishedAt: "2024-01-01T00:01:00.000Z",
		checks: [
			{
				checkId: "boundary-lint",
				command: ["pnpm", "run", "lint:boundaries"],
				exitCode: 0,
				status: "passed",
				evidence: {},
			},
		],
		artifact: {
			digestSha256:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			byteLength: 128,
			mediaType: "application/vnd.wasm.component.v1+wasm",
		},
		signature: {
			verified: true,
			signerIdentity: "https://hobo.dev/stage-gate/s0",
			provenanceTier: "sandboxed-builder",
			conformanceReportDigest: `sha256:${"b".repeat(64)}`,
		},
	};
}

describe("stage-gate record consumer pact", () => {
	const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
		interactions: Array<{
			description: string;
			response: { status: number; body: Record<string, unknown> };
		}>;
	};

	it("matches the passed-record interaction envelope", () => {
		const passedInteraction = pact.interactions.find((interaction) =>
			interaction.description.includes("passed S0"),
		);
		expect(passedInteraction).toBeDefined();
		const record = parseStageGateRecord(
			serializeStageGateRecord(samplePassedRecord()),
		);
		expect(record.gateId).toBe(passedInteraction?.response.body.gate_id);
		expect(record.status).toBe(passedInteraction?.response.body.status);
		expect(record.signature.verified).toBe(
			(
				passedInteraction?.response.body.signature as {
					verified: boolean;
				}
			).verified,
		);
	});

	it("surfaces a structured error envelope for failed validation", () => {
		const failedInteraction = pact.interactions.find((interaction) =>
			interaction.description.includes("failed gate"),
		);
		expect(failedInteraction?.response.status).toBe(400);
		const error = failedInteraction?.response.body.error as {
			code: string;
			message: string;
		};
		expect(error.code).toBe("STAGE_GATE_RECORD_INVALID");
		expect(() =>
			parseStageGateRecord({
				gate_id: "s0",
				status: "passed",
				repo_commit: "abc",
				started_at: "2024-01-01T00:00:00.000Z",
				finished_at: "2024-01-01T00:00:01.000Z",
				checks: [
					{
						check_id: "broken",
						command: ["false"],
						exit_code: 1,
						status: "failed",
					},
				],
				artifact: {
					digest_sha256: `sha256:${"c".repeat(64)}`,
					byte_length: 1,
					media_type: "application/octet-stream",
				},
				signature: {
					verified: true,
					signer_identity: "https://hobo.dev/stage-gate/s0",
					provenance_tier: "sandboxed-builder",
					conformance_report_digest: `sha256:${"d".repeat(64)}`,
				},
			}),
		).toThrow(/passed record requires every check passed/);
	});
});
