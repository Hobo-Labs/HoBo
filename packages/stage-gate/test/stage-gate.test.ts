import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import { defineStageGateS0 } from "../src/definition.js";
import {
	parseStageGateRecord,
	serializeStageGateRecord,
} from "../src/parse.js";
import {
	createCommandInvocation,
	resolveCommandExecutable,
	runStageGate,
	shouldUseCommandShell,
} from "../src/runner.js";
import { StageGateParseError } from "../src/types.js";

function validRecordPayload() {
	return {
		gate_id: "s0",
		status: "passed",
		repo_commit: "deadbeef",
		ci_run_url: "https://github.com/example/hobo/actions/runs/99",
		started_at: "2024-01-01T00:00:00.000Z",
		finished_at: "2024-01-01T00:05:00.000Z",
		checks: [
			{
				check_id: "boundary-lint",
				command: ["pnpm", "run", "lint:boundaries"],
				exit_code: 0,
				status: "passed",
				evidence: {},
			},
		],
		artifact: {
			digest_sha256: `sha256:${"a".repeat(64)}`,
			byte_length: 42,
			media_type: "application/vnd.wasm.component.v1+wasm",
		},
		signature: {
			verified: true,
			signer_identity: "https://hobo.dev/stage-gate/s0",
			provenance_tier: "sandboxed-builder",
			conformance_report_digest: `sha256:${"b".repeat(64)}`,
		},
	};
}

/** First check of a payload, asserted present. */
function firstCheck<T>(checks: readonly T[]): T {
	const [check] = checks;
	assert(check, "expected the payload to carry at least one check");
	return check;
}

describe("parseStageGateRecord", () => {
	it("accepts a valid passed record", () => {
		const record = parseStageGateRecord(validRecordPayload());
		expect(record.gateId).toBe("s0");
		expect(record.signature.verified).toBe(true);
	});

	it("rejects malformed digests", () => {
		const payload = validRecordPayload();
		payload.artifact.digest_sha256 = "sha256:short";
		expect(() => parseStageGateRecord(payload)).toThrow(StageGateParseError);
	});

	it("rejects passed records with failed checks", () => {
		const payload = validRecordPayload();
		payload.checks[0] = {
			...firstCheck(payload.checks),
			status: "failed",
			exit_code: 1,
		};
		expect(() => parseStageGateRecord(payload)).toThrow(
			/passed record requires every check passed/,
		);
	});

	it("rejects tampered artifact digest evidence on passed records", () => {
		const payload = validRecordPayload();
		payload.signature.verified = false;
		expect(() => parseStageGateRecord(payload)).toThrow(/signature.verified/);
	});

	it("round-trips through serialize", () => {
		const first = parseStageGateRecord(validRecordPayload());
		const second = parseStageGateRecord(serializeStageGateRecord(first));
		expect(second).toEqual(first);
	});
});

describe("runStageGate", () => {
	it("resolves pnpm through a non-local Windows executable", () => {
		expect(resolveCommandExecutable("pnpm", "win32", { Path: "" })).toBe(
			"corepack",
		);
		expect(resolveCommandExecutable("pnpm", "linux")).toBe("pnpm");
		expect(resolveCommandExecutable("node", "win32")).toBe("node");
		expect(shouldUseCommandShell("pnpm.cmd", "win32")).toBe(true);
		expect(shouldUseCommandShell("pnpm.cmd", "linux")).toBe(false);
		expect(shouldUseCommandShell("node.exe", "win32")).toBe(false);
		const invocation = createCommandInvocation(
			"pnpm",
			["run", "test:schema"],
			"win32",
			"cmd.exe",
			{ Path: "" },
		);
		expect(invocation).toEqual({
			executable: "corepack",
			args: ["pnpm", "run", "test:schema"],
		});
	});

	it("fails closed when a check exits non-zero", async () => {
		const definition = {
			gateId: "s0",
			checks: [
				{
					checkId: "always-fails",
					kind: "lint" as const,
					command: [process.execPath, "-e", "process.exit(2)"],
				},
			],
		};
		const result = await runStageGate(definition, { cwd: process.cwd() });
		expect(result.exitCode).toBe(1);
		expect(result.record.status).toBe("failed");
		expect(result.record.checks[0]?.status).toBe("failed");
		expect(result.record.checks[0]?.exitCode).toBe(2);
	});

	it("records spawn errors as check evidence", async () => {
		const definition = {
			gateId: "s0",
			checks: [
				{
					checkId: "missing-executable",
					kind: "lint" as const,
					command: ["hobo-stage-gate-missing-executable"],
				},
			],
		};
		const result = await runStageGate(definition, { cwd: process.cwd() });
		expect(result.exitCode).toBe(1);
		expect(result.record.status).toBe("failed");
		expect(result.record.checks[0]?.evidence.error).toContain(
			"hobo-stage-gate-missing-executable",
		);
	});

	it("defines the S0 toolchain check list in order", () => {
		const definition = defineStageGateS0();
		expect(definition.gateId).toBe("s0");
		expect(definition.checks.map((check) => check.checkId)).toEqual([
			"boundary-lint",
			"architecture-guard",
			"schema-drift",
			"contract-consumer",
			"contract-provider",
			"conformance-self-test",
			"hello-bindle-determinism",
			"hello-bindle-health",
			"sign-provenance-verify",
			"tampered-artifact-refused",
		]);
	});
});
